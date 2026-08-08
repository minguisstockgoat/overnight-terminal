/* K200 야간선물 릴레이 — 항상 켜져 있는 Mac mini에서 야간장(18:00~06:00 KST) 내내 실행.
 *
 * KRX는 2025-06-09부터 코스피200 야간선물시장을 직접 운영한다. 그런데 KIS OpenAPI는
 * 야간 시세를 REST로 주지 않는다 — inquire-price가 FID_COND_MRKT_DIV_CODE=JF를 받아주긴 하지만
 * 응답이 비고, 분봉도 주간(~15:45)까지만 나온다. 실시간 웹소켓 H0MFCNT0만 야간 체결을 흘려준다.
 *
 * 그래서 이 스크립트가 웹소켓을 물고 있다가 최신 시세를 Cloudflare Worker로 밀어 넣고,
 * 대시보드(app.js)는 그 공개 엔드포인트를 폴링한다. KIS 키가 브라우저에 노출되지 않는다.
 *
 *   node scripts/k200_night_relay.mjs                 # 06:05 KST까지 상주
 *   node scripts/k200_night_relay.mjs --once          # 한 번 받아서 출력만 (점검용)
 *   node scripts/k200_night_relay.mjs --code A01609   # 근월물 수동 지정
 *
 * 환경변수: KIS_APP_KEY, KIS_APP_SECRET, RELAY_URL, RELAY_TOKEN
 *   RELAY_URL이 없으면 push 없이 콘솔에만 찍는다(로컬 점검).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

const KIS_BASE = "https://openapi.koreainvestment.com:9443";
const KIS_WS = "ws://ops.koreainvestment.com:21000";
const TR = "H0MFCNT0";                       // KRX야간선물 실시간종목체결

/* H0MFCNT0 체결 응답 컬럼(앞부분만 사용) */
const COLS = ["iscd", "hour", "vrss", "sign", "ctrt", "prpr", "oprc", "hgpr", "lwpr",
              "cnqn", "vol", "amt", "thpr", "basis"];

const SERIES_MAX = 720;                      // 1분 간격 × 12시간
const args = process.argv.slice(2);
const argOf = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ""; };
const ONCE = args.includes("--once");
const PUSH_SEC = Number(process.env.RELAY_PUSH_SEC || 60);   // KV 무료 한도(1000 writes/day) 고려

/* ── 설정 로드: 환경변수 우선, 없으면 통합 볼트에서 보충 ── */
function loadEnv() {
  const p = argOf("--env-file") || `${homedir()}/.config/secrets/keys.env`;
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

const KST = "Asia/Seoul";
const kstParts = (d = new Date()) => {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { y: +f.year, m: +f.month, d: +f.day, hh: +f.hour % 24, mm: +f.minute, ss: +f.second };
};
const kstIso = (d = new Date()) => {
  const p = kstParts(d);
  const z = n => String(n).padStart(2, "0");
  return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.hh)}:${z(p.mm)}:${z(p.ss)}+09:00`;
};

/* ── 근월물 종목코드 ─────────────────────────────────────────
 * 코스피200 선물 단축코드는 A01 + 연(1자리) + 월(2자리). 예: A01609 = 2026년 9월물.
 * 분기월물(3/6/9/12)만 상장되고 만기는 둘째 목요일 — 후보를 만들어 REST로 실물 확인한다. */
function secondThursday(y, m) {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (4 - first.getUTCDay() + 7) % 7;          // 0=일 … 4=목
  return new Date(Date.UTC(y, m - 1, 1 + offset + 7));
}
function frontMonthCandidates(now = new Date()) {
  const p = kstParts(now);
  const out = [];
  for (let k = 0; k < 8 && out.length < 3; k++) {
    const my = p.y + Math.floor((p.m - 1 + k) / 12);
    const mm = ((p.m - 1 + k) % 12) + 1;
    if (mm % 3 !== 0) continue;                             // 3·6·9·12월물만
    const expiry = secondThursday(my, mm);
    if (Date.UTC(p.y, p.m - 1, p.d) > expiry.getTime()) continue;   // 만기 지난 월물 제외
    out.push({ code: `A01${my % 10}${String(mm).padStart(2, "0")}`, ym: `${my}-${String(mm).padStart(2, "0")}` });
  }
  return out;
}

/* KIS는 접근토큰 발급을 분당 1회로 제한한다(초과 시 403). 토큰은 24시간 유효하므로 파일에 캐시. */
const TOKEN_CACHE = `${homedir()}/.cache/k200-night-relay/token.json`;

function readTokenCache(ak) {
  try {
    const c = JSON.parse(readFileSync(TOKEN_CACHE, "utf8"));
    if (c.appKey === ak && c.expiresAt > Date.now() + 60_000) return c.token;
  } catch { /* 캐시 없음/손상 — 새로 받는다 */ }
  return "";
}

async function kisToken(ak, sk) {
  const cached = readTokenCache(ak);
  if (cached) return cached;

  const r = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: ak, appsecret: sk }),
  });
  if (!r.ok) throw new Error(`token http ${r.status}` + (r.status === 403 ? " (발급 분당 1회 제한 — 잠시 후 재시도)" : ""));
  const j = await r.json();
  const ttl = Number(j.expires_in || 86400) * 1000;
  try {
    mkdirSync(dirname(TOKEN_CACHE), { recursive: true });
    writeFileSync(TOKEN_CACHE, JSON.stringify({ appKey: ak, token: j.access_token, expiresAt: Date.now() + ttl }));
  } catch { /* 캐시 못 써도 동작에는 지장 없음 */ }
  return j.access_token;
}

/* 주간 시세로 종목코드 유효성 + 기준가(주간 종가) 확인 */
async function dayQuote(code, ak, sk, tok) {
  const u = new URL(`${KIS_BASE}/uapi/domestic-futureoption/v1/quotations/inquire-price`);
  u.searchParams.set("FID_COND_MRKT_DIV_CODE", "F");
  u.searchParams.set("FID_INPUT_ISCD", code);
  const r = await fetch(u, {
    headers: { authorization: `Bearer ${tok}`, appkey: ak, appsecret: sk, tr_id: "FHMIF10000000", custtype: "P" },
  });
  if (!r.ok) return null;
  const o = (await r.json()).output1;
  return o && o.futs_prpr ? { name: (o.hts_kor_isnm || "").trim(), close: +o.futs_prpr } : null;
}

async function resolveContract(ak, sk) {
  const manual = argOf("--code");
  const tok = await kisToken(ak, sk);
  const cands = manual ? [{ code: manual, ym: "manual" }] : frontMonthCandidates();
  for (const c of cands) {
    const q = await dayQuote(c.code, ak, sk, tok);
    if (q) { console.log(`[relay] 근월물 ${c.code} (${q.name}) 주간종가 ${q.close}`); return { ...c, ...q }; }
    console.log(`[relay] ${c.code} 미상장/무응답 — 다음 월물 확인`);
  }
  throw new Error("근월물 종목코드를 찾지 못함");
}

async function approvalKey(ak, sk) {
  const r = await fetch(`${KIS_BASE}/oauth2/Approval`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: ak, secretkey: sk }),
  });
  if (!r.ok) throw new Error(`approval http ${r.status}`);
  return (await r.json()).approval_key;
}

/* ── 상태 ── */
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
let snap = null;                 // 최신 스냅샷
const series = [];               // [[hhmm, px], …] 1분 간격
let lastPushed = "";

function applyTick(row, contract) {
  const price = num(row.prpr);
  if (price == null) return;
  let change = num(row.vrss);
  // sign 4=하락, 5=하한 — 부호가 빠져 오는 경우 방어
  if (change != null && (row.sign === "4" || row.sign === "5") && change > 0) change = -change;

  snap = {
    code: contract.code,
    name: contract.name || row.iscd,
    price,
    change,
    changePct: num(row.ctrt),
    dayClose: change != null ? +(price - change).toFixed(2) : contract.close ?? null,
    open: num(row.oprc), high: num(row.hgpr), low: num(row.lwpr),
    volume: num(row.vol), basis: num(row.basis),
    tickHour: row.hour || "",
    ts: kstIso(),
    session: "open",
    source: "KIS H0MFCNT0 · KRX 야간선물",
  };

  /* 스파크라인용 1분봉. 대시보드 툴팁이 epoch 초를 기대하므로 분 경계 epoch 로 저장한다. */
  const bucket = Math.floor(Date.now() / 60_000) * 60;
  const last = series[series.length - 1];
  if (last && last[0] === bucket) last[1] = price;
  else { series.push([bucket, price]); if (series.length > SERIES_MAX) series.shift(); }
}

async function push() {
  if (!snap) return;
  const url = process.env.RELAY_URL;
  const body = JSON.stringify({ ...snap, series });
  if (!url) { console.log(`[relay] (push 생략) ${snap.price} ${snap.changePct}% @${snap.tickHour}`); return; }
  if (body === lastPushed) return;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-token": process.env.RELAY_TOKEN || "" },
      body,
    });
    if (!r.ok) { console.error(`[relay] push http ${r.status}`); return; }
    lastPushed = body;
    console.log(`[relay] push ${snap.price} (${snap.changePct}%) @${snap.tickHour} pts=${series.length}`);
  } catch (e) {
    console.error(`[relay] push 실패: ${e.message}`);
  }
}

/* 야간장 종료(06:05 KST)까지의 남은 시간 */
function msUntilClose() {
  const p = kstParts();
  const mins = p.hh * 60 + p.mm;
  const closeMin = 6 * 60 + 5;
  const remain = mins < closeMin ? closeMin - mins : (24 * 60 - mins) + closeMin;
  return remain * 60_000;
}

function connect(contract, key, onTick) {
  return new Promise(resolve => {
    const ws = new WebSocket(KIS_WS);
    let alive = true;
    const done = why => { if (alive) { alive = false; resolve(why); } };

    ws.onopen = () => {
      ws.send(JSON.stringify({
        header: { approval_key: key, custtype: "P", tr_type: "1", "content-type": "utf-8" },
        body: { input: { tr_id: TR, tr_key: contract.code } },
      }));
      console.log(`[relay] 구독 ${contract.code}`);
    };
    ws.onmessage = ev => {
      const msg = typeof ev.data === "string" ? ev.data : String(ev.data);
      if (msg[0] === "0" || msg[0] === "1") {
        const parts = msg.split("|");
        if (parts.length < 4 || parts[1] !== TR) return;
        // 한 프레임에 체결이 여러 건 붙어와도 마지막 것만 반영하면 된다
        const vals = parts[3].split("^");
        const row = Object.fromEntries(COLS.map((c, i) => [c, vals[i]]));
        onTick(row);
        return;
      }
      let d; try { d = JSON.parse(msg); } catch { return; }
      if (d?.header?.tr_id === "PINGPONG") { ws.send(msg); return; }   // 그대로 돌려줘야 유지
      console.log(`[relay] 제어 rt=${d?.body?.rt_cd} ${d?.body?.msg1 || ""}`);
    };
    ws.onerror = () => done("error");
    ws.onclose = () => done("close");
  });
}

/* ── 메인 ── */
loadEnv();
const AK = process.env.KIS_APP_KEY, SK = process.env.KIS_APP_SECRET;
if (!AK || !SK) { console.error("[relay] KIS_APP_KEY / KIS_APP_SECRET 누락"); process.exit(2); }

const contract = await resolveContract(AK, SK);
const key = await approvalKey(AK, SK);

if (ONCE) {
  const ws = connect(contract, key, row => applyTick(row, contract));
  await Promise.race([ws, new Promise(r => setTimeout(r, 30_000))]);
  if (!snap) {
    console.error("[relay] 30초간 체결 없음 — 야간장 미개장이거나 거래 한산");
    console.error("        KRX 야간선물 운영: 월~금 18:00 ~ 익일 06:00 KST (토·일 밤 없음)");
    process.exit(1);
  }
  console.log(JSON.stringify({ ...snap, seriesPoints: series.length }, null, 2));
  process.exit(0);
}

const stopAt = Date.now() + msUntilClose();
console.log(`[relay] ${new Date(stopAt).toLocaleString("ko-KR", { timeZone: KST })} 까지 상주 · push ${PUSH_SEC}s`);

const pusher = setInterval(push, PUSH_SEC * 1000);
let backoff = 1000;
while (Date.now() < stopAt) {
  const why = await connect(contract, key, row => applyTick(row, contract));
  if (Date.now() >= stopAt) break;
  console.error(`[relay] 연결 종료(${why}) — ${Math.round(backoff / 1000)}초 후 재접속`);
  await new Promise(r => setTimeout(r, backoff));
  backoff = Math.min(30_000, backoff * 2);
}
clearInterval(pusher);

/* 마감 스냅샷: 세션 종료를 명시해 대시보드가 '마감가'로 표시하게 한다 */
if (snap) { snap.session = "closed"; snap.ts = kstIso(); lastPushed = ""; await push(); }
console.log("[relay] 야간장 종료 — 종료");
