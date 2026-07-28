/* FedWatch 일별 스냅샷 — GitHub Actions에서 매영업일 실행.
 * 30일 Fed Funds 선물(ZQ)에서 회의별 내재 인상/인하 확률과 연말 누적 내재폭(bp)을 계산해
 * data/fedwatch_history.json 에 하루 1행 추가한다.
 * 계산 로직은 app.js computeFedPath()와 KEEP IN SYNC. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ZQ_MONTH_CODE = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
const zqSym = (y, m) => "ZQ" + ZQ_MONTH_CODE[m] + String(y % 100).padStart(2, "0") + ".CBT";
const ymAdd = (y, m, k) => [y + Math.floor((m + k) / 12), (m + k) % 12];

const cfg = JSON.parse(readFileSync("fomc.json", "utf8"));
const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const now = new Date();
const syms = [];
for (let k = 0; k <= 6; k++) { const [y, m] = ymAdd(now.getUTCFullYear(), now.getUTCMonth(), k); syms.push(zqSym(y, m)); }

const url = "https://query1.finance.yahoo.com/v8/finance/spark?symbols=" + encodeURIComponent(syms.join(",")) + "&range=1d&interval=15m";
const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
if (!res.ok) { console.error("yahoo http " + res.status); process.exit(1); }
const raw = await res.json();
const map = raw && raw.spark && Array.isArray(raw.spark.result)
  ? Object.fromEntries(raw.spark.result.map(r => {
      const q = r.response && r.response[0];
      return [r.symbol, q ? { close: q.indicators?.quote?.[0]?.close, previousClose: q.meta?.previousClose ?? q.meta?.chartPreviousClose } : {}];
    }))
  : raw;

const lastNonNull = a => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const prices = {};
for (const s of syms) {
  const d = map[s];
  const px = d && (lastNonNull(d.close) ?? d.previousClose);
  if (px != null) prices[s] = px;
}

/* ── computeFedPath (app.js와 동일) ── */
function computeFedPath(cfg, prices, todayStr) {
  const implied = ym => { const p = prices[zqSym(ym[0], ym[1])]; return p != null ? 100 - p : null; };
  const meetings = cfg.meetings.map(x => ({ ...x, date: x.end }));
  const future = meetings.filter(x => x.date >= todayStr);
  const past = meetings.filter(x => x.date < todayStr);
  const parseYm = s => [+s.slice(0, 4), +s.slice(5, 7) - 1];
  const hasMeeting = ym => meetings.some(x => { const p = parseYm(x.date); return p[0] === ym[0] && p[1] === ym[1]; });
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
  const rows = [];
  let pre = base;
  for (const mt of future) {
    const [y, m] = parseYm(mt.date);
    const day = +mt.date.slice(8, 10);
    const N = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let post = null;
    const next = ymAdd(y, m, 1);
    if (N - day < 7 && !hasMeeting(next) && implied(next) != null) post = implied(next);
    else if (implied([y, m]) != null) post = (implied([y, m]) * N - pre * day) / (N - day);
    else if (implied(next) != null && !hasMeeting(next)) post = implied(next);
    if (post == null) continue;
    rows.push({ label: mt.label, date: mt.date, post: +post.toFixed(4), diffBp: +((post - pre) * 100).toFixed(1) });
    pre = post;
  }
  return { base: +base.toFixed(4), baseSrc, rows, endRate: +pre.toFixed(4), cumBp: +((pre - base) * 100).toFixed(1) };
}

const path = computeFedPath(cfg, prices, todayStr);
if (!path) { console.error("compute failed — prices:", prices); process.exit(1); }

mkdirSync("data", { recursive: true });
let hist = { days: [] };
try { hist = JSON.parse(readFileSync("data/fedwatch_history.json", "utf8")); } catch (e) { /* first run */ }
hist.days = (hist.days || []).filter(d => d.date !== todayStr);
hist.days.push({ date: todayStr, base: path.base, cumBp: path.cumBp, endRate: path.endRate, meetings: path.rows });
hist.days.sort((a, b) => a.date.localeCompare(b.date));
if (hist.days.length > 750) hist.days = hist.days.slice(-750);
writeFileSync("data/fedwatch_history.json", JSON.stringify(hist, null, 1));
console.log(todayStr, "base=" + path.base, "cumBp=" + path.cumBp, "meetings=" + path.rows.map(r => `${r.label}:${r.diffBp}bp`).join(" "));
