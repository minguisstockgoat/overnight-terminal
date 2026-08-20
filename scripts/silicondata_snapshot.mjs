/* Silicon Data(silicondata.com)의 무료 공개 임베드 차트에서 AI 컴퓨트·토큰 지수를 긁어
 * data/silicondata.json에 누적한다.
 *
 * 유료 API(api.silicondata.com/api/token-index/index 등)는 구독 없이는 34004로 막힌다.
 * 대신 마케팅 페이지가 iframe으로 물고 있는 portal.silicondata.com/*-chart 임베드 페이지가
 * Next.js RSC 페이로드 안에 데이터를 서버렌더로 박아 보내므로, 그 JSON만 뽑아 쓴다.
 * 단, 임베드는 7일 창으로 하드캡(starting_date를 넘겨도 무시)이라 과거치는 살 수 없다.
 * → 매일 7일치를 받아 기존 히스토리에 머지하는 방식으로 시계열을 쌓는다. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const UA = "overnight-terminal-silicondata-snapshot/1.0";
const BASE = "https://portal.silicondata.com";

/* 토큰 지수 3종 + GPU 렌탈 지수 + 메모리 지수.
 * gpu 임베드의 mainTab은 hyperscaler / neo-cloud 두 계열이고,
 * b200·h200·mi300x는 두 탭이 같은 계열(단일 시리즈)로 온다. */
const TOKEN_SERIES = [
  { key: "token_all",    token: "expenditure",        label: "LLM 토큰 종합",  badge: "SDLLMTK" },
  { key: "token_open",   token: "open_expenditure",   label: "오픈 LLM 토큰",  badge: "OPEN" },
  { key: "token_closed", token: "closed_expenditure", label: "폐쇄 LLM 토큰",  badge: "PROPRIETARY" },
];
const GPU_SERIES = [
  { key: "gpu_h100_neo", gpu: "h100",   tab: "neo-cloud",   label: "H100 네오클라우드", badge: "NEOCLOUD" },
  { key: "gpu_h100_hs",  gpu: "h100",   tab: "hyperscaler", label: "H100 하이퍼스케일러", badge: "HYPERSCALER" },
  { key: "gpu_b200",     gpu: "b200",   tab: "neo-cloud",   label: "B200",   badge: "RENTAL" },
  { key: "gpu_a100_neo", gpu: "a100",   tab: "neo-cloud",   label: "A100 네오클라우드", badge: "NEOCLOUD" },
  { key: "gpu_a100_hs",  gpu: "a100",   tab: "hyperscaler", label: "A100 하이퍼스케일러", badge: "HYPERSCALER" },
  { key: "gpu_h200",     gpu: "h200",   tab: "neo-cloud",   label: "H200",   badge: "RENTAL" },
  { key: "gpu_mi300x",   gpu: "mi300x", tab: "neo-cloud",   label: "MI300X", badge: "RENTAL" },
];
const FORWARD_GPUS = ["H100", "B200", "A100"];
/* 포워드 커브는 145개 만기라 전부 쌓으면 파일이 커진다 — 최신 커브 전체 + 대표 만기만 히스토리 */
const FORWARD_KEY_TENORS = [0, 3, 6, 12, 24, 36];

async function getHtml(path) {
  const res = await fetch(BASE + path, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  /* RSC 페이로드는 JSON 문자열 안에 또 들어있어 \" 로 이스케이프돼 있다 */
  return (await res.text()).replace(/\\"/g, '"');
}

/* 여는 중괄호 위치에서 짝 맞는 닫는 중괄호까지 잘라 JSON.parse */
function objectAt(html, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return JSON.parse(html.slice(openIdx, i + 1));
  }
  throw new Error("unbalanced payload");
}
function extractIndexes(html) {
  const at = html.indexOf('"indexes":{');
  if (at < 0) throw new Error("no indexes payload");
  const obj = objectAt(html, at + '"indexes":'.length);
  const out = {};
  for (const [date, raw] of Object.entries(obj)) {
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) out[date] = v;   // "-1" = 결측일
  }
  return out;
}

const previous = (() => {
  try { return JSON.parse(readFileSync("data/silicondata.json", "utf8")); }
  catch { return { series: {}, forwardHistory: {} }; }
})();

const series = {};
const errors = [];

async function collect(meta, path) {
  const old = previous.series?.[meta.key]?.history || {};
  try {
    const fresh = extractIndexes(await getHtml(path));
    const history = { ...old, ...fresh };            // 새 값이 이김(정정 반영)
    const dates = Object.keys(history).sort();
    series[meta.key] = {
      label: meta.label, badge: meta.badge, unit: meta.unit,
      history, latestDate: dates[dates.length - 1] || null,
    };
  } catch (e) {
    errors.push(`${meta.key}: ${e.message}`);
    if (Object.keys(old).length) series[meta.key] = previous.series[meta.key];   // 기존치 보존
  }
}

for (const s of TOKEN_SERIES) {
  await collect({ ...s, unit: "$/1M tok" }, `/token-indexes-chart?token=${s.token}`);
}
for (const s of GPU_SERIES) {
  await collect({ ...s, unit: "$/GPU·h" }, `/gpu-index-chart?standalone=true&gpu=${s.gpu}&mainTab=${s.tab}`);
}
await collect({ key: "ram_gddr6", label: "GDDR6 메모리", badge: "MEMORY", unit: "$/모듈" }, "/ram-index-chart");

/* 포워드 커브(0~36개월 term/forward rate) */
let forward = previous.forward || null;
const forwardHistory = previous.forwardHistory || {};
try {
  const html = await getHtml("/forward-curve-chart");
  const at = html.indexOf('"data":{"date"');
  const payload = objectAt(html, at + '"data":'.length);
  const curves = {};
  for (const gpu of FORWARD_GPUS) {
    const raw = payload[gpu];
    if (!raw) continue;
    curves[gpu] = Object.entries(raw)
      .map(([tenor, v]) => ({ m: Number(tenor), term: v.term_rate, fwd: v.forward_rate }))
      .filter(p => Number.isFinite(p.m))
      .sort((a, b) => a.m - b.m);
    const snap = {};
    for (const m of FORWARD_KEY_TENORS) {
      const hit = curves[gpu].find(p => p.m === m);
      if (hit) snap["m" + m] = hit.term;
    }
    forwardHistory[gpu] = { ...(forwardHistory[gpu] || {}), [payload.date]: snap };
  }
  forward = { date: payload.date, curves };
} catch (e) {
  errors.push(`forward: ${e.message}`);
}

const latestDate = Object.values(series)
  .map(s => s.latestDate).filter(Boolean).sort().pop() || null;

mkdirSync("data", { recursive: true });
writeFileSync("data/silicondata.json", JSON.stringify({
  updated: new Date().toISOString(),
  latestDate,
  source: "Silicon Data (silicondata.com) 공개 임베드 차트",
  note: "임베드는 7일 창만 제공 — 히스토리는 이 스냅샷이 매일 누적한 값",
  series, forward, forwardHistory,
  errors,
}, null, 2) + "\n");

console.log(`silicondata: ${Object.keys(series).length} series, latest ${latestDate}` +
  (errors.length ? `, errors: ${errors.join(" | ")}` : ""));
if (!Object.keys(series).length) process.exit(1);
