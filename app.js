/* ============================================================
 * OVERNIGHT TERMINAL — KR 오버나잇 마켓 모니터
 * 데이터: Yahoo Finance v8 spark/chart (Cloudflare Worker 프록시 경유)
 *        + Binance WebSocket (BTC/ETH 실시간 푸시)
 * 정적 GitHub Pages — 서버·빌드 불필요
 * ============================================================ */
"use strict";

/* ── 프록시 체인 (hynix-adr-dashboard와 공유하는 전용 워커 우선) ── */
const PROXIES = [
  { name: "worker",     wrap: u => "https://hynix-proxy.eogks879.workers.dev/?url=" + encodeURIComponent(u), parse: r => r.json() },
  { name: "allorigins", wrap: u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),            parse: r => r.json() },
  { name: "codetabs",   wrap: u => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),       parse: r => r.json() },
  { name: "allorigins2",wrap: u => "https://api.allorigins.win/get?url=" + encodeURIComponent(u),            parse: async r => JSON.parse((await r.json()).contents) },
];
let proxyIdx = 0;          // 마지막으로 성공한 프록시에 고정
let errCount = 0;

/* K200 야간선물 릴레이 엔드포인트 (worker/k200-night 배포 주소).
 * Mac mini가 KIS 웹소켓에서 받은 시세를 이 Worker에 밀어 넣고, 여기서는 읽기만 한다. */
const K200_NIGHT_URL = "https://k200-night.eogks879.workers.dev/";

/* ── 심볼 구성 ─────────────────────────────────────────────
 * mode "spark" = 배치 spark 폴링 / "stock" = 개별 chart(프리·애프터 포함)
 * yld=true → 금리: 등락을 bp로 표시  */
const PANELS = [
  { id: "kr", no: "01", title: "KOREA · OVERNIGHT", note: "K200 야간선물=KRX 실물(18~06시) · EWY·원/달러는 보조 지표" },
  { id: "eq", no: "02", title: "EQUITY FUTURES & VOL",    note: "CME 24h" },
  { id: "rt", no: "03", title: "RATES · 금리",             note: "현물수익률=미장 / 국채선물=24h" },
  { id: "fx", no: "04", title: "FX · 환율",                note: "24h" },
  { id: "cm", no: "05", title: "COMMODITIES · 원자재",     note: "NYMEX·COMEX 24h" },
  { id: "cr", no: "06", title: "CRYPTO",                   note: "Binance 실시간 · 24h 기준 등락" },
  { id: "us", no: "07", title: "US TECH · 개별주",         note: "프리·애프터 포함" },
];

const SYMBOLS = [
  /* KOREA */
  { sym: "K200N",    name: "코스피200 야간선물", panel: "kr", dec: 2, mode: "relay", badge: "KRX 야간" },
  { sym: "KRW=X",    name: "원/달러",           panel: "kr", dec: 2, mode: "spark" },
  { sym: "EWY",      name: "MSCI Korea (EWY)",  panel: "kr", dec: 2, mode: "stock", badge: "야간 보조" },
  { sym: "^KS200",   name: "KOSPI 200",         panel: "kr", dec: 2, mode: "spark", badge: "주간장" },
  { sym: "^KS11",    name: "KOSPI",             panel: "kr", dec: 2, mode: "spark", badge: "주간장" },
  /* EQUITY FUTURES & VOL */
  { sym: "ES=F",     name: "S&P500 선물",       panel: "eq", dec: 2, mode: "spark" },
  { sym: "NQ=F",     name: "나스닥100 선물",    panel: "eq", dec: 2, mode: "spark" },
  { sym: "YM=F",     name: "다우 선물",         panel: "eq", dec: 0, mode: "spark" },
  { sym: "RTY=F",    name: "러셀2000 선물",     panel: "eq", dec: 1, mode: "spark" },
  { sym: "NKD=F",    name: "니케이225 선물",    panel: "eq", dec: 0, mode: "spark" },
  { sym: "^SOX",     name: "필라델피아 반도체", panel: "eq", dec: 1, mode: "spark", badge: "미장" },
  { sym: "^VIX",     name: "VIX",               panel: "eq", dec: 2, mode: "spark" },
  /* RATES */
  { sym: "^TNX",     name: "미국채 10Y",        panel: "rt", dec: 3, mode: "spark", yld: true, badge: "미장" },
  { sym: "^FVX",     name: "미국채 5Y",         panel: "rt", dec: 3, mode: "spark", yld: true, badge: "미장" },
  { sym: "^TYX",     name: "미국채 30Y",        panel: "rt", dec: 3, mode: "spark", yld: true, badge: "미장" },
  { sym: "ZN=F",     name: "10Y 국채선물",      panel: "rt", dec: 2, mode: "spark", badge: "가격↑=금리↓" },
  { sym: "ZT=F",     name: "2Y 국채선물",       panel: "rt", dec: 3, mode: "spark", badge: "가격↑=금리↓" },
  /* FX */
  { sym: "DX-Y.NYB", name: "달러인덱스",        panel: "fx", dec: 2, mode: "spark" },
  { sym: "JPY=X",    name: "엔/달러",           panel: "fx", dec: 2, mode: "spark" },
  { sym: "EURUSD=X", name: "유로/달러",         panel: "fx", dec: 4, mode: "spark" },
  /* COMMODITIES */
  { sym: "CL=F",     name: "WTI 원유",          panel: "cm", dec: 2, mode: "spark" },
  { sym: "BZ=F",     name: "브렌트유",          panel: "cm", dec: 2, mode: "spark" },
  { sym: "NG=F",     name: "천연가스(헨리허브)", panel: "cm", dec: 3, mode: "spark" },
  { sym: "TTF=F",    name: "유럽 천연가스(TTF)", panel: "cm", dec: 2, mode: "spark" },
  { sym: "GC=F",     name: "금",                panel: "cm", dec: 1, mode: "spark" },
  { sym: "SI=F",     name: "은",                panel: "cm", dec: 2, mode: "spark" },
  { sym: "HG=F",     name: "구리",              panel: "cm", dec: 3, mode: "spark" },
  /* CRYPTO */
  { sym: "BTC-USD",  name: "비트코인",          panel: "cr", dec: 0, mode: "spark", ws: "btcusdt" },
  { sym: "ETH-USD",  name: "이더리움",          panel: "cr", dec: 1, mode: "spark", ws: "ethusdt" },
  /* US TECH */
  { sym: "NVDA",     name: "엔비디아",          panel: "us", dec: 2, mode: "stock" },
  { sym: "TSLA",     name: "테슬라",            panel: "us", dec: 2, mode: "stock" },
  { sym: "SKHY",     name: "SK하이닉스 ADR",    panel: "us", dec: 2, mode: "stock" },
  { sym: "MU",       name: "마이크론",          panel: "us", dec: 2, mode: "stock" },
];

/* 텔레그램 언급 분석 결과 (2026-06-29~07-29, limit 대비 히트 수) */
const TG_MENTIONS = [
  { label: "유가·WTI",      v: 100 }, { label: "미국채 금리",  v: 100 },
  { label: "환율·DXY",      v: 100 }, { label: "엔화",         v: 100 },
  { label: "야간선물",      v: 100 }, { label: "VIX",          v: 100 },
  { label: "나스닥 선물",   v: 100 }, { label: "비트코인",     v: 100 },
  { label: "엔비디아",      v: 100 }, { label: "SOX 반도체",   v: 90 },
  { label: "천연가스",      v: 80 },  { label: "구리",         v: 75 },
  { label: "금",            v: 60 },  { label: "닛케이",       v: 50 },
];

/* ── 상태 ── */
const state = {};  // sym → {last, prev, ts[], px[], updated, err, srcLive}
SYMBOLS.forEach(c => state[c.sym] = { last: null, prev: null, ts: [], px: [], updated: 0, err: false, srcLive: false });

const $ = id => document.getElementById(id);
const fmt = (v, dec) => v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });

/* ── DOM 구성 ── */
function buildGrid() {
  const grid = $("grid");
  for (const p of PANELS) {
    const sec = document.createElement("section");
    sec.className = "panel";
    sec.innerHTML = `<h2><span class="pno">${p.no}</span> ${p.title}<span class="pnote">${p.note || ""}</span></h2><div class="tiles" id="tiles-${p.id}"></div>`;
    grid.appendChild(sec);
  }
  for (const c of SYMBOLS) {
    const t = document.createElement("div");
    t.className = "tile"; t.id = "tile-" + cssId(c.sym);
    t.innerHTML = `
      <div class="t-head">
        <span class="t-name" title="${c.sym}">${c.name}</span>
        <span class="t-sym">${c.sym}</span>
        <span class="t-badge" id="badge-${cssId(c.sym)}">${c.badge || ""}</span>
      </div>
      <div class="t-main">
        <div class="t-left">
          <div class="t-px" id="px-${cssId(c.sym)}">—</div>
          <div class="t-chg flat" id="chg-${cssId(c.sym)}">—</div>
        </div>
        <div class="t-spark"><canvas id="spk-${cssId(c.sym)}" width="118" height="40"></canvas></div>
      </div>
      <div class="t-foot" id="foot-${cssId(c.sym)}"></div>`;
    document.getElementById("tiles-" + c.panel).appendChild(t);
    hookSpark(c);
  }
  const bars = $("tg-bars");
  for (const m of TG_MENTIONS) {
    const r = document.createElement("div");
    r.className = "tg-row";
    r.innerHTML = `<span class="tg-label">${m.label}</span><span class="tg-track"><span class="tg-fill" style="width:${m.v}%"></span></span><span class="tg-val">${m.v >= 100 ? "포화" : m.v + "%"}</span>`;
    bars.appendChild(r);
  }
}
function cssId(s) { return s.replace(/[^A-Za-z0-9]/g, "_"); }

/* ── 데이터 수신 ── */
async function proxyFetch(url, timeoutMs = 8000) {
  for (let i = 0; i < PROXIES.length; i++) {
    const p = PROXIES[(proxyIdx + i) % PROXIES.length];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(p.wrap(url), { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error("http " + res.status);
      const j = await p.parse(res);
      proxyIdx = (proxyIdx + i) % PROXIES.length;
      return { data: j, proxy: p.name };
    } catch (e) { /* 다음 프록시로 */ }
  }
  throw new Error("all proxies failed");
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function refreshSpark() {
  const sparkSyms = SYMBOLS.filter(c => c.mode === "spark").map(c => c.sym);
  const batches = chunk(sparkSyms, 15);   // Yahoo spark는 심볼 수 제한이 있어 15개씩
  let okAny = false;
  for (const b of batches) {
    const url = "https://query1.finance.yahoo.com/v8/finance/spark?symbols=" +
      encodeURIComponent(b.join(",")) + "&range=1d&interval=5m";
    try {
      const { data, proxy } = await proxyFetch(url);
      okAny = true;
      const map = normalizeSpark(data);
      for (const sym of b) applySeries(sym, map[sym], proxy);
    } catch (e) {
      errCount++;
      b.forEach(sym => { state[sym].err = true; renderTile(sym); });
    }
  }
  return okAny;
}

/* spark 응답 두 형태 모두 처리: {SYM:{...}} 또는 {spark:{result:[{symbol,response:[...]}]}} */
function normalizeSpark(j) {
  if (j && j.spark && Array.isArray(j.spark.result)) {
    const m = {};
    for (const r of j.spark.result) {
      const resp = r.response && r.response[0];
      if (!resp) continue;
      m[r.symbol] = {
        timestamp: resp.timestamp,
        close: resp.indicators && resp.indicators.quote[0].close,
        previousClose: resp.meta && (resp.meta.previousClose ?? resp.meta.chartPreviousClose),
      };
    }
    return m;
  }
  return j || {};
}

/* 미 개별주 등락 기준선.
   프리/애프터장에서 Yahoo meta.previousClose(=chartPreviousClose)는 "마지막 정규장의 전일" 종가라
   하루 밀려서(전전일 종가) 온다. 이때 기준선은 마지막 정규장 종가 = meta.regularMarketPrice.
   정규장 중에는 regularMarketPrice가 현재가이므로 chartPreviousClose를 그대로 쓴다. */
function stockBaseline(meta, timestamp) {
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  const lastTs = (timestamp && timestamp.length ? timestamp[timestamp.length - 1] : null)
    ?? Math.floor(Date.now() / 1000);
  if (!reg || meta.regularMarketPrice == null) return prev;
  const offHours = lastTs < reg.start || lastTs >= reg.end;
  return offHours ? meta.regularMarketPrice : prev;
}

async function refreshStocks() {
  const stocks = SYMBOLS.filter(c => c.mode === "stock");
  let okAny = false;
  for (const c of stocks) {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(c.sym) + "?range=1d&interval=5m&includePrePost=true";
    try {
      const { data, proxy } = await proxyFetch(url);
      const r = data.chart && data.chart.result && data.chart.result[0];
      if (!r) throw new Error("empty");
      okAny = true;
      applySeries(c.sym, {
        timestamp: r.timestamp,
        close: r.indicators.quote[0].close,
        previousClose: stockBaseline(r.meta, r.timestamp),
        rmp: r.meta.regularMarketPrice,
      }, proxy);
    } catch (e) {
      errCount++;
      state[c.sym].err = true; renderTile(c.sym);
    }
  }
  return okAny;
}

function applySeries(sym, d, proxy) {
  const s = state[sym];
  if (!d || !d.close) { s.err = true; renderTile(sym); return; }
  const ts = [], px = [];
  for (let i = 0; i < d.close.length; i++) {
    if (d.close[i] != null) { ts.push(d.timestamp[i]); px.push(d.close[i]); }
  }
  if (!px.length && d.rmp == null) { s.err = true; renderTile(sym); return; }
  const conf = SYMBOLS.find(c => c.sym === sym);
  const wsLive = conf.ws && s.srcLive;           // WS가 살아있으면 last는 WS가 관리
  const newLast = px.length ? px[px.length - 1] : d.rmp;
  const prevVal = d.previousClose ?? s.prev;
  const changed = !wsLive && s.last != null && newLast !== s.last;
  const dir = changed ? (newLast > s.last ? "up" : "dn") : null;
  if (!wsLive) s.last = newLast;
  s.prev = prevVal;
  s.ts = ts; s.px = px;
  s.updated = Date.now(); s.err = false; s.proxy = proxy;
  renderTile(sym, dir);
}

/* ── Binance WebSocket (BTC·ETH 실시간) ── */
let ws, wsRetry = 0;
function connectWS() {
  const streams = SYMBOLS.filter(c => c.ws).map(c => c.ws + "@miniTicker").join("/");
  if (!streams) return;
  try { ws = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams); }
  catch (e) { return; }
  ws.onmessage = ev => {
    try {
      const { data } = JSON.parse(ev.data);
      const conf = SYMBOLS.find(c => c.ws && data.s === c.ws.toUpperCase());
      if (!conf) return;
      const s = state[conf.sym];
      const c = parseFloat(data.c), o = parseFloat(data.o);
      const dir = s.last != null && c !== s.last ? (c > s.last ? "up" : "dn") : null;
      s.last = c; s.wsOpen24 = o; s.srcLive = true; s.updated = Date.now(); s.err = false;
      renderTile(conf.sym, dir);
    } catch (e) { /* ignore */ }
  };
  ws.onclose = () => {
    SYMBOLS.filter(c => c.ws).forEach(c => state[c.sym].srcLive = false);
    setTimeout(connectWS, Math.min(30000, 1000 * Math.pow(2, wsRetry++)));
  };
  ws.onopen = () => { wsRetry = 0; };
}

/* ── 렌더링 ── */
function renderTile(sym, flashDir) {
  const c = SYMBOLS.find(x => x.sym === sym);
  const s = state[sym];
  const id = cssId(sym);
  const tile = $("tile-" + id);
  if (!tile) return;

  tile.classList.toggle("err", !!s.err && s.last == null);
  const pxEl = $("px-" + id), chgEl = $("chg-" + id), footEl = $("foot-" + id), bdEl = $("badge-" + id);

  pxEl.innerHTML = s.last == null ? "—" : fmt(s.last, c.dec) + (c.yld ? '<span class="t-unit">%</span>' : "");

  /* 등락: 크립토 WS는 24h 기준, 금리는 bp, 그 외 전일 종가 대비 */
  let chgHtml = "—", cls = "flat";
  const base = (c.ws && s.srcLive) ? s.wsOpen24 : s.prev;
  if (s.last != null && base != null && base !== 0) {
    const diff = s.last - base, pct = diff / base * 100;
    cls = diff > 0 ? "up" : diff < 0 ? "dn" : "flat";
    const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "―";
    chgHtml = c.yld
      ? `${arrow} ${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(1)}bp`
      : `${arrow} ${diff >= 0 ? "+" : ""}${fmt(diff, c.dec)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
  }
  chgEl.className = "t-chg " + cls;
  chgEl.textContent = chgHtml;

  /* 하단: 전일/고저/갱신시각 */
  const parts = [];
  if (c.ws && s.srcLive && s.wsOpen24 != null) parts.push("24h시가 " + fmt(s.wsOpen24, c.dec));
  else if (s.prev != null) parts.push("전일 " + fmt(s.prev, c.dec));
  if (s.px.length > 1) {
    parts.push("저 " + fmt(Math.min(...s.px), c.dec));
    parts.push("고 " + fmt(Math.max(...s.px), c.dec));
  }
  if (s.updated) parts.push(new Date(s.updated).toLocaleTimeString("ko-KR", { hour12: false, timeZone: "Asia/Seoul" }));
  if (s.err && s.last == null) parts.push('<span class="t-err">수신 실패</span>');
  footEl.innerHTML = parts.join(" · ");

  /* 배지: WS 라이브 / 미국 개별주 세션 */
  if (c.ws) { bdEl.textContent = s.srcLive ? "LIVE·24h" : "polling"; bdEl.className = "t-badge" + (s.srcLive ? " live" : ""); }
  else if (c.mode === "stock" && c.panel === "us") { bdEl.textContent = usSessionLabel(); }

  drawSpark(c, s);
  if (flashDir) {
    tile.classList.remove("flash-up", "flash-dn");
    void tile.offsetWidth;                       // reflow로 애니메이션 재시작
    tile.classList.add(flashDir === "up" ? "flash-up" : "flash-dn");
    setTimeout(() => tile.classList.remove("flash-up", "flash-dn"), 600);
  }
}

/* ── 스파크라인 ── */
function sparkColor(up) {
  const st = getComputedStyle(document.documentElement);
  return (up ? st.getPropertyValue("--up") : st.getPropertyValue("--dn")).trim() || "#888";
}
function drawSpark(c, s) {
  const cv = $("spk-" + cssId(c.sym));
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = 118, H = 40;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"; }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (s.px.length < 2) return;
  const all = s.prev != null ? s.px.concat([s.prev]) : s.px;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) { hi += 1e-9; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const X = i => i / (s.px.length - 1) * (W - 2) + 1;
  const Y = v => H - 2 - (v - lo) / (hi - lo) * (H - 4);
  const up = s.prev != null ? s.px[s.px.length - 1] >= s.prev : s.px[s.px.length - 1] >= s.px[0];
  const col = sparkColor(up);
  /* 전일종가 기준선 */
  if (s.prev != null && s.prev >= lo && s.prev <= hi) {
    g.strokeStyle = "rgba(154,154,164,0.45)"; g.setLineDash([2, 3]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, Y(s.prev)); g.lineTo(W, Y(s.prev)); g.stroke(); g.setLineDash([]);
  }
  /* 면 채우기 */
  g.beginPath(); g.moveTo(X(0), Y(s.px[0]));
  for (let i = 1; i < s.px.length; i++) g.lineTo(X(i), Y(s.px[i]));
  g.lineTo(X(s.px.length - 1), H); g.lineTo(X(0), H); g.closePath();
  g.fillStyle = col + "22"; g.fill();
  /* 라인 */
  g.beginPath(); g.moveTo(X(0), Y(s.px[0]));
  for (let i = 1; i < s.px.length; i++) g.lineTo(X(i), Y(s.px[i]));
  g.strokeStyle = col; g.lineWidth = 1.4; g.stroke();
  /* 마지막 점 */
  g.beginPath(); g.arc(X(s.px.length - 1), Y(s.px[s.px.length - 1]), 1.8, 0, 7);
  g.fillStyle = col; g.fill();
}

/* 스파크라인 호버 툴팁 */
function hookSpark(c) {
  const cv = $("spk-" + cssId(c.sym));
  const tip = $("tooltip");
  cv.addEventListener("mousemove", ev => {
    const s = state[c.sym];
    if (s.px.length < 2) return;
    const rect = cv.getBoundingClientRect();
    const i = Math.max(0, Math.min(s.px.length - 1, Math.round((ev.clientX - rect.left) / rect.width * (s.px.length - 1))));
    const t = s.ts[i] ? new Date(s.ts[i] * 1000).toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" }) : "";
    tip.innerHTML = `<span class="tt-t">${t} KST</span>${fmt(s.px[i], c.dec)}`;
    tip.style.display = "block";
    tip.style.left = Math.min(window.innerWidth - 130, ev.clientX + 12) + "px";
    tip.style.top = (ev.clientY - 28) + "px";
  });
  cv.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

/* ── 티커 테이프 ── */
function renderTape() {
  const mk = c => {
    const s = state[c.sym];
    if (s.last == null) return "";
    const base = (c.ws && s.srcLive) ? s.wsOpen24 : s.prev;
    let chg = "";
    if (base) {
      const pct = (s.last - base) / base * 100;
      const cls = pct > 0 ? "up" : pct < 0 ? "dn" : "flat";
      chg = `<span class="t-chg ${cls}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
    }
    return `<span class="tape-item"><span class="tape-sym">${c.sym}</span><span class="tape-px">${fmt(s.last, c.dec)}</span>${chg}</span>`;
  };
  const row = SYMBOLS.map(mk).join("");
  if (row) $("tape").innerHTML = row + row;   // 이어붙여 무한 스크롤
}

/* ── 시계·세션 ── */
function tzParts(tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date());
  const o = {};
  p.forEach(x => o[x.type] = x.value);
  return { wd: o.weekday, h: +o.hour % 24, m: +o.minute, s: +o.second, str: `${o.hour}:${o.minute}:${o.second}` };
}
const WDN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/* KRX 야간파생 18:00~익일 06:00 KST (월 18시 ~ 토 06시) */
function krxNightOpen() {
  const sel = tzParts("Asia/Seoul");
  const d = WDN[sel.wd], min = sel.h * 60 + sel.m;
  return (min >= 1080 && d >= 1 && d <= 5) || (min < 360 && d >= 2 && d <= 6);
}

function tickClock() {
  const sel = tzParts("Asia/Seoul"), nyc = tzParts("America/New_York"), utc = tzParts("UTC");
  usSessionLabel();
  $("clock-sel").textContent = sel.str;
  $("clock-nyc").textContent = nyc.str;
  $("clock-utc").textContent = utc.str;

  const badges = [];
  const krxNight = krxNightOpen();
  badges.push(`<span class="badge ${krxNight ? "on" : ""}">KRX 야간 ${krxNight ? "OPEN" : "CLOSED"}</span>`);
  /* 미국 현물장 */
  badges.push(`<span class="badge ${usSess === "정규장" ? "on" : usSess === "CLOSED" ? "" : "pre"}">US ${usSess}</span>`);
  /* CME 선물: 일 18:00 ET 개장, 금 17:00 마감, 평일 17~18시 정비 */
  const nd = WDN[nyc.wd], nmin = nyc.h * 60 + nyc.m;
  let cme = false;
  if (nd >= 1 && nd <= 4) cme = !(nmin >= 1020 && nmin < 1080);
  else if (nd === 5) cme = nmin < 1020;
  else if (nd === 0) cme = nmin >= 1080;
  badges.push(`<span class="badge ${cme ? "on" : ""}">CME ${cme ? "OPEN" : "CLOSED"}</span>`);
  $("sessions").innerHTML = badges.join("");
}
let usSess = "CLOSED";
function usSessionLabel() {
  const nyc = tzParts("America/New_York");
  const d = WDN[nyc.wd], t = nyc.h * 60 + nyc.m;
  usSess = "CLOSED";
  if (d >= 1 && d <= 5) {
    if (t >= 240 && t < 570) usSess = "프리장";
    else if (t >= 570 && t < 960) usSess = "정규장";
    else if (t >= 960 && t < 1200) usSess = "애프터";
  }
  return usSess;
}

/* ── 상태바 ── */
function renderStatus(ok) {
  const dot = $("conn-dot");
  dot.className = "dot " + (ok ? "ok" : "bad");
  $("conn-text").textContent = ok ? ("LIVE via " + PROXIES[proxyIdx].name) : "RECONNECTING…";
  $("last-update").textContent = new Date().toLocaleTimeString("ko-KR", { hour12: false, timeZone: "Asia/Seoul" });
  $("err-count").textContent = "ERR " + errCount;
}

/* ── 등락색 토글 (블룸버그식 ↔ 한국식) ── */
function initConvToggle() {
  const apply = kr => {
    document.documentElement.classList.toggle("kr-conv", kr);
    $("conv-label").textContent = kr ? "RED=UP (한국식)" : "GREEN=UP";
    SYMBOLS.forEach(c => drawSpark(c, state[c.sym]));
  };
  let kr = localStorage.getItem("ot_conv") === "kr";
  apply(kr);
  $("conv-toggle").addEventListener("click", () => {
    kr = !kr;
    localStorage.setItem("ot_conv", kr ? "kr" : "us");
    apply(kr);
  });
}

/* ============================================================
 * FED WATCH — CME FedWatch 방식 자체산출 (30일 Fed Funds 선물 ZQ)
 * 확률 = 회의 전후 내재 EFFR 차이 / 25bp (scripts/fedwatch_snapshot.mjs와 KEEP IN SYNC)
 * ============================================================ */
const fed = { cfg: null, prices: {}, history: null };
const ZQ_MONTH_CODE = ["F","G","H","J","K","M","N","Q","U","V","X","Z"];
const zqSym = (y, m) => "ZQ" + ZQ_MONTH_CODE[m] + String(y % 100).padStart(2, "0") + ".CBT";
const ymAdd = (y, m, k) => [y + Math.floor((m + k) / 12), (m + k) % 12];
function nyToday() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p; // YYYY-MM-DD
}
function lastNonNull(arr) { if (!arr) return null; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; }

function buildCdsPanel() {
  const sec = document.createElement("section");
  sec.className = "panel"; sec.id = "panel-cds";
  sec.innerHTML = `
    <h2><span class="pno">08</span> AI CAPEX CREDIT · CDS<span class="pnote" id="cds-note">ICE Clear Credit · 5Y EOD</span></h2>
    <div class="tiles" id="cds-tiles"><div class="fed-loading">ICE CDS 스냅샷 불러오는 중…</div></div>`;
  $("grid").appendChild(sec);
}

function renderCds(snapshot) {
  const target = $("cds-tiles");
  if (!snapshot?.items?.length) throw new Error("empty CDS snapshot");
  const date = snapshot.items[0].clearingDate || "—";
  const model = snapshot.model;
  $("cds-note").textContent = `ICE Clear Credit · ${date} EOD · par spread 환산`
    + (model ? ` (R=${(model.recovery * 100).toFixed(0)}% · r=${(model.discountRate * 100).toFixed(2)}% · 잔차 ${model.residualBp ?? "—"}bp)` : "");

  /* 스프레드 넓은 순 = 크레딧 약한 순 */
  const items = [...snapshot.items].sort((a, b) => (b.spreadBp ?? -1) - (a.spreadBp ?? -1));
  target.innerHTML = items.map(item => {
    /* 등락은 스프레드 기준. 확대=신용악화라 하락색, 축소=개선이라 상승색으로 칠한다. */
    const change = item.spreadBp == null || item.previousSpreadBp == null ? null : item.spreadBp - item.previousSpreadBp;
    const direction = change == null || change === 0 ? "flat" : change > 0 ? "dn" : "up";
    const changeText = change == null
      ? "전일 비교 대기"
      : `${change > 0 ? "▲ +" : change < 0 ? "▼ " : "― "}${change.toFixed(1)}bp ${change > 0 ? "확대" : change < 0 ? "축소" : ""}`;
    const priceChange = item.previousEodPrice == null ? null : item.eodPrice - item.previousEodPrice;
    return `<article class="tile cds-tile">
      <div class="t-head"><span class="t-name">${item.name} 5Y CDS</span><span class="t-sym">${item.ticker}</span><span class="t-badge">${item.tag || "ICE EOD"}</span></div>
      <div class="t-main"><div class="t-left">
        <div class="t-px">${item.spreadBp == null ? "—" : fmt(item.spreadBp, 1)}<span class="t-unit">bp</span></div>
        <div class="t-chg ${direction}">${changeText}</div>
      </div></div>
      <div class="t-foot">
        <span>가격 ${fmt(item.eodPrice, 2)}${priceChange == null ? "" : ` (${priceChange > 0 ? "+" : ""}${priceChange.toFixed(2)})`}</span>
        <span>coupon ${item.couponBp}bp</span>
        <span>확대=신용악화</span>
      </div>
    </article>`;
  }).join("");
}

/* ── 크레딧 테이프 (FINRA TRACE 시장 집계) ── */
function buildCreditPanel() {
  const sec = document.createElement("section");
  sec.className = "panel"; sec.id = "panel-credit";
  sec.innerHTML = `
    <h2><span class="pno">09</span> CREDIT TAPE<span class="pnote" id="credit-note">FINRA TRACE · 시장 전체 집계</span></h2>
    <div class="tiles" id="credit-tiles"><div class="fed-loading">TRACE 스냅샷 불러오는 중…</div></div>`;
  $("grid").appendChild(sec);
}

/* TRACE 금액은 백만 달러 단위로 온다 */
const bn = v => v == null ? "—" : v >= 1000 ? `$${(v / 1000).toFixed(1)}bn` : `$${Math.round(v)}mn`;

function renderCredit(snapshot) {
  const target = $("credit-tiles");
  if (!snapshot?.segments?.length) throw new Error("empty credit snapshot");
  $("credit-note").textContent = `FINRA TRACE · ${snapshot.latestDate} · 개별 발행사 아님(시장 집계)`;

  target.innerHTML = snapshot.segments.map((seg, i) => {
    /* A/D = 상승종목수 ÷ 하락종목수. 1.0 위면 크레딧 강세 */
    const change = seg.prevAdRatio == null ? null : seg.adRatio - seg.prevAdRatio;
    const direction = change == null || change === 0 ? "flat" : change > 0 ? "up" : "dn";
    const changeText = change == null ? "전일 비교 대기"
      : `${change > 0 ? "▲ +" : "▼ "}${change.toFixed(2)} vs 전일 ${seg.prevAdRatio.toFixed(2)}`;
    const net = seg.netCustomerUsdMn;
    return `<article class="tile credit-tile">
      <div class="t-head"><span class="t-name">${seg.label} A/D</span><span class="t-sym">${seg.advances}↑ ${seg.declines}↓</span><span class="t-badge">${seg.market === "144a" ? "144A" : "TRACE"}</span></div>
      <div class="t-main">
        <div class="t-left">
          <div class="t-px">${fmt(seg.adRatio, 2)}<span class="t-unit">A/D</span></div>
          <div class="t-chg ${direction}">${changeText}</div>
        </div>
        <div class="t-spark"><canvas id="spk-CREDIT_${i}" width="118" height="40"></canvas></div>
      </div>
      <div class="t-foot">
        <span>신고 ${seg.high52} · 신저 ${seg.low52}</span>
        <span>거래 ${bn(seg.volumeUsdMn)}</span>
        <span>${net == null ? "고객수급 —" : `고객 순매수 ${net >= 0 ? "+" : "−"}${bn(Math.abs(net))}`}</span>
      </div>
    </article>`;
  }).join("");

  /* 스파크라인: 기준선 1.0(상승=하락) 위아래로 색이 갈린다 */
  snapshot.segments.forEach((seg, i) => {
    drawSpark({ sym: "CREDIT_" + i, dec: 2 }, { px: seg.history.map(h => h.adRatio), prev: 1, ts: [] });
  });
}

async function loadCredit() {
  try {
    const response = await fetch("data/finra_credit.json?v=" + Date.now());
    if (!response.ok) throw new Error("snapshot unavailable");
    renderCredit(await response.json());
  } catch (error) {
    $("credit-tiles").innerHTML = `<div class="fed-loading">TRACE 스냅샷을 불러오지 못했습니다.</div>`;
  }
}

async function loadCds() {
  try {
    const response = await fetch("data/ice_cds.json?v=" + Date.now());
    if (!response.ok) throw new Error("snapshot unavailable");
    renderCds(await response.json());
  } catch (error) {
    $("cds-tiles").innerHTML = `<div class="fed-loading">ICE CDS 스냅샷을 불러오지 못했습니다.</div>`;
  }
}

function buildFedPanel() {
  const sec = document.createElement("section");
  sec.className = "panel"; sec.id = "panel-fed";
  sec.innerHTML = `
    <h2><span class="pno">10</span> FED WATCH · FOMC 금리 경로
      <span class="pnote" id="fed-note">CME FedWatch 방식 자체산출(30일 FF선물)</span></h2>
    <div id="fed-body">
      <div id="fed-rows"><div class="fed-loading">Fed Funds 선물 수신 중…</div></div>
      <div id="fed-side">
        <div id="fed-anchor">—</div>
        <div id="fed-cume">—</div>
        <canvas id="fed-trend" width="252" height="72"></canvas>
        <div id="fed-trend-cap">연말 내재 변동폭(bp) 추이 · 매영업일 아침 기록</div>
      </div>
    </div>`;
  $("grid").appendChild(sec);
}

async function loadFedCfg() {
  try {
    fed.cfg = await (await fetch("fomc.json?v=" + Date.now())).json();
    $("fed-note").textContent = `CME FedWatch 방식 자체산출(30일 FF선물) · 현행 ${fed.cfg.targetRange}`;
  } catch (e) { fed.cfg = null; }
  try { fed.history = await (await fetch("data/fedwatch_history.json?v=" + Date.now())).json(); } catch (e) { fed.history = null; }
}

function fedContractSyms() {
  const now = new Date(), y = now.getUTCFullYear(), m = now.getUTCMonth();
  const syms = [];
  for (let k = 0; k <= 6; k++) { const [yy, mm] = ymAdd(y, m, k); syms.push(zqSym(yy, mm)); }
  return syms;
}

async function refreshFed() {
  if (!fed.cfg) return;
  const syms = fedContractSyms();
  const url = "https://query1.finance.yahoo.com/v8/finance/spark?symbols=" +
    encodeURIComponent(syms.join(",")) + "&range=1d&interval=5m";
  try {
    const { data } = await proxyFetch(url);
    const map = normalizeSpark(data);
    for (const s of syms) {
      const d = map[s];
      const px = d && (lastNonNull(d.close) ?? d.previousClose);
      if (px != null) fed.prices[s] = px;
    }
    renderFed();
  } catch (e) { errCount++; }
}

/* 내재 금리 경로 계산 — snapshot 스크립트와 동일 로직 */
function computeFedPath(cfg, prices, todayStr) {
  const implied = ym => { const p = prices[zqSym(ym[0], ym[1])]; return p != null ? 100 - p : null; };
  const meetings = cfg.meetings.map(x => ({ ...x, date: x.end }));
  const future = meetings.filter(x => x.date >= todayStr);
  const past = meetings.filter(x => x.date < todayStr);
  const parseYm = s => [+s.slice(0, 4), +s.slice(5, 7) - 1];
  const hasMeeting = ym => meetings.some(x => { const p = parseYm(x.date); return p[0] === ym[0] && p[1] === ym[1]; });

  /* 기준(현행) EFFR: 직전 회의~다음 회의 사이의 회의 없는 달 월물, 없으면 당월 월물 */
  const curYm = parseYm(todayStr);
  let base = null, baseSrc = "";
  const lastPast = past.length ? parseYm(past[past.length - 1].date) : null;
  const firstFut = future.length ? parseYm(future[0].date) : null;
  let scan = lastPast ? ymAdd(lastPast[0], lastPast[1], 1) : curYm;
  if (scan[0] * 12 + scan[1] < curYm[0] * 12 + curYm[1]) scan = curYm;
  const scanEnd = firstFut ? firstFut[0] * 12 + firstFut[1] : scan[0] * 12 + scan[1] + 2;
  for (let i = scan[0] * 12 + scan[1]; i < scanEnd; i++) {
    const ym = [Math.floor(i / 12), i % 12];
    if (!hasMeeting(ym) && implied(ym) != null) { base = implied(ym); baseSrc = zqSym(ym[0], ym[1]); break; }
  }
  if (base == null && implied(curYm) != null) { base = implied(curYm); baseSrc = zqSym(curYm[0], curYm[1]) + "(당월근사)"; }
  if (base == null) return null;

  /* 회의별 체인 */
  const rows = [];
  let pre = base;
  for (const mt of future) {
    const [y, m] = parseYm(mt.date);
    const day = +mt.date.slice(8, 10);
    const N = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let post = null;
    const next = ymAdd(y, m, 1);
    if (N - day < 7 && !hasMeeting(next) && implied(next) != null) post = implied(next);       // 월말 회의 → 익월 월물
    else if (implied([y, m]) != null) post = (implied([y, m]) * N - pre * day) / (N - day);     // 일수 가중 역산
    else if (implied(next) != null && !hasMeeting(next)) post = implied(next);
    if (post == null) continue;
    const diff = post - pre;
    const steps = Math.abs(diff) / 0.25, k = Math.floor(steps), frac = steps - k;
    const dir = diff >= 0 ? 1 : -1;
    const outcomes = [];   // {bp(부호 있는 이동폭), p}
    if (k === 0) { outcomes.push({ bp: 0, p: 1 - frac }); outcomes.push({ bp: dir * 25, p: frac }); }
    else { outcomes.push({ bp: dir * 25 * k, p: 1 - frac }); outcomes.push({ bp: dir * 25 * (k + 1), p: frac }); }
    rows.push({ label: mt.label, date: mt.date, pre, post, diffBp: diff * 100, outcomes: outcomes.filter(o => o.p > 0.001) });
    pre = post;
  }
  return { base, baseSrc, rows, endRate: pre, cumBp: (pre - base) * 100 };
}

function fedOutcomeName(bp) { return bp === 0 ? "동결" : (bp > 0 ? "+" + bp + "bp 인상" : bp + "bp 인하"); }
function fedOutcomeClass(bp) { return bp === 0 ? "hold" : bp > 0 ? "hike" : "cut"; }

function renderFed() {
  if (!fed.cfg) return;
  const path = computeFedPath(fed.cfg, fed.prices, nyToday());
  const rowsEl = $("fed-rows");
  if (!path) { rowsEl.innerHTML = '<div class="fed-loading">선물 시세 대기 중…</div>'; return; }

  if (!path.rows.length) {
    rowsEl.innerHTML = '<div class="fed-loading">남은 FOMC 일정 없음 — fomc.json에 차년도 일정을 추가하세요.</div>';
  } else {
    rowsEl.innerHTML = path.rows.map(r => {
      const segs = r.outcomes
        .sort((a, b) => Math.abs(a.bp) - Math.abs(b.bp))
        .map(o => {
          const pct = Math.round(o.p * 100);
          const lbl = `${fedOutcomeName(o.bp)} ${pct}%`;
          return `<span class="fed-seg ${fedOutcomeClass(o.bp)}" style="width:${(o.p * 100).toFixed(1)}%" title="${lbl}">${o.p >= 0.18 ? lbl : ""}</span>`;
        }).join("");
      const dcls = r.diffBp > 1 ? "hike-t" : r.diffBp < -1 ? "cut-t" : "";
      return `<div class="fed-row">
        <span class="fed-date">${r.label}</span>
        <span class="fed-bar">${segs}</span>
        <span class="fed-post">→ ${r.post.toFixed(2)}%</span>
        <span class="fed-diff ${dcls}">${r.diffBp >= 0 ? "+" : ""}${r.diffBp.toFixed(0)}bp</span>
      </div>`;
    }).join("");
  }

  const warn = Math.abs(path.base - fed.cfg.targetMidPct) > 0.15 ? ' <span class="fed-warn">⚠ fomc.json 목표금리 갱신 필요</span>' : "";
  $("fed-anchor").innerHTML = `현행 내재 EFFR <b>${path.base.toFixed(2)}%</b> <span class="fed-src">(${path.baseSrc})</span>${warn}`;
  $("fed-cume").innerHTML = `연내 잔여회의 누적 내재 <b class="${path.cumBp > 1 ? "hike-t" : path.cumBp < -1 ? "cut-t" : ""}">${path.cumBp >= 0 ? "+" : ""}${path.cumBp.toFixed(0)}bp</b> → 연말 ${path.endRate.toFixed(2)}%`;
  drawFedTrend(path);
}

function drawFedTrend(livePath) {
  const cv = $("fed-trend");
  if (!cv) return;
  const g = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1, W = 252, H = 72;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const pts = (fed.history && Array.isArray(fed.history.days) ? fed.history.days : [])
    .map(d => ({ x: d.date, y: d.cumBp })).filter(p => p.y != null);
  if (livePath) pts.push({ x: "live", y: livePath.cumBp });
  if (pts.length < 2) {
    g.fillStyle = "#5c5c66"; g.font = "10px monospace";
    g.fillText("이력 수집 중 (매영업일 기록)", 8, 40);
    return;
  }
  const ys = pts.map(p => p.y);
  let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  if (hi === lo) hi += 1;
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const X = i => i / (pts.length - 1) * (W - 8) + 4;
  const Y = v => H - 4 - (v - lo) / (hi - lo) * (H - 8);
  g.strokeStyle = "rgba(154,154,164,0.4)"; g.setLineDash([2, 3]); g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke(); g.setLineDash([]);
  g.beginPath(); g.moveTo(X(0), Y(pts[0].y));
  for (let i = 1; i < pts.length; i++) g.lineTo(X(i), Y(pts[i].y));
  g.strokeStyle = "#ff9e1b"; g.lineWidth = 1.5; g.stroke();
  const lp = pts[pts.length - 1];
  g.beginPath(); g.arc(X(pts.length - 1), Y(lp.y), 2, 0, 7); g.fillStyle = "#ff9e1b"; g.fill();
  g.fillStyle = "#9a9aa4"; g.font = "9px monospace";
  g.fillText(`${lp.y >= 0 ? "+" : ""}${lp.y.toFixed(0)}bp`, Math.min(W - 34, X(pts.length - 1) + 4), Y(lp.y) - 4);
}

let fedTimer;
/* ── K200 야간선물 ───────────────────────────────────────────
 * KIS는 야간 시세를 REST로 주지 않고 실시간 웹소켓으로만 흘려준다. 그래서 Mac mini의
 * scripts/k200_night_relay.mjs 가 웹소켓을 물고 있다가 Worker로 밀어 넣고, 여기서는 그걸 읽는다.
 * 엔드포인트가 죽어 있어도 나머지 타일은 그대로 돈다(이 타일만 '수신 실패'). */
async function refreshNight() {
  const s = state["K200N"];
  const bd = $("badge-K200N");
  try {
    const r = await fetch(K200_NIGHT_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("http " + r.status);
    const d = await r.json();
    if (typeof d.price !== "number") throw new Error("no price");

    const prevLast = s.last;
    s.last = d.price;
    s.prev = d.dayClose ?? s.prev;          // 야간 등락 기준 = 같은 종목의 주간 정규장 종가
    s.updated = Date.parse(d.ts) || Date.now();
    s.err = false;

    /* 스파크라인: 릴레이가 들고 있는 1분 시계열을 그대로 쓴다(페이지 새로 열어도 바로 그려짐) */
    if (Array.isArray(d.series) && d.series.length) {
      s.ts = d.series.map(p => p[0]);
      s.px = d.series.map(p => p[1]);
    } else if (s.px[s.px.length - 1] !== d.price) {
      s.px.push(d.price); s.ts.push(Math.floor(Date.now() / 1000));
    }

    if (bd) {
      const label = d.stale ? "STALE" : d.session === "closed" ? "마감" : "LIVE";
      bd.textContent = label;
      bd.className = "t-badge" + (label === "LIVE" ? " live" : "");
    }
    renderTile("K200N", prevLast == null || d.price === prevLast ? null : d.price > prevLast ? "up" : "dn");
  } catch {
    /* 야간장이 닫혀 있을 때(주간·주말) 값이 없는 건 정상이다 — 고장처럼 보이지 않게 CLOSED 로 둔다.
       장중인데 못 받아오면 그때는 진짜 이상이므로 OFF + '수신 실패'. */
    const open = krxNightOpen();
    s.err = open;
    if (bd) { bd.textContent = open ? "OFF" : "CLOSED"; bd.className = "t-badge"; }
    renderTile("K200N");
  }
}
let nightTimer;
async function loopNight() {
  await refreshNight();
  nightTimer = setTimeout(loopNight, document.hidden ? 120000 : 20000);
}

async function loopFed() {
  await refreshFed();
  fedTimer = setTimeout(loopFed, document.hidden ? 300000 : 60000);
}

/* ── 메인 루프 ── */
let sparkTimer, stockTimer;
async function loopSpark() {
  const ok = await refreshSpark();
  renderTape(); renderStatus(ok);
  sparkTimer = setTimeout(loopSpark, document.hidden ? 120000 : 20000);
}
async function loopStocks() {
  await refreshStocks();
  usSessionLabel();
  stockTimer = setTimeout(loopStocks, document.hidden ? 180000 : 30000);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    clearTimeout(sparkTimer); clearTimeout(stockTimer); clearTimeout(nightTimer);
    loopSpark(); loopStocks(); loopNight();
  }
});

buildGrid();
buildCdsPanel();
buildCreditPanel();
buildFedPanel();
initConvToggle();
usSessionLabel();
tickClock();
setInterval(tickClock, 1000);
connectWS();
loopSpark();
loopStocks();
loopNight();
loadFedCfg().then(loopFed);
loadCds();
loadCredit();
