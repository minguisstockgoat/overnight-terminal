/* ICE Clear Credit의 무료 5년물 단일종목 CDS EOD 가격을 GitHub Pages용으로 저장한다.
 * ICE 공개 API는 가격을 제공하며, par CDS spread(bp)를 제공하지 않는다. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ENDPOINT = "https://status.ice.com/api/cds-settlement-prices/icc-single-names";
const SOURCE_URL = "https://status.ice.com/cds-settlement-prices/icc/single-name-instruments";
const TARGETS = [
  { ticker: "COREWEI", name: "CoreWeave", couponBp: 500 },
  { ticker: "ORCLE", name: "Oracle", couponBp: 100 },
];

const response = await fetch(ENDPOINT, {
  headers: { Accept: "application/json", "User-Agent": "overnight-terminal-cds-snapshot/1.0" },
});
if (!response.ok) throw new Error(`ICE API HTTP ${response.status}`);
const rows = await response.json();
if (!Array.isArray(rows)) throw new Error("ICE API returned an unexpected payload");

let previous = { items: [] };
try { previous = JSON.parse(readFileSync("data/ice_cds.json", "utf8")); } catch { /* first snapshot */ }
const oldByTicker = new Map((previous.items || []).map(item => [item.ticker, item]));

const items = TARGETS.map(target => {
  const instrument = row => row.instrumentName || row.instrument;
  const row = rows.find(item => instrument(item)?.startsWith(`${target.ticker}.`));
  if (!row || row.eodPrice == null) throw new Error(`Missing ICE CDS row for ${target.ticker}`);
  const old = oldByTicker.get(target.ticker);
  const eodPrice = Number(row.eodPrice);
  return {
    ...target,
    instrument: instrument(row),
    clearingDate: row.clearingDate,
    eodPrice,
    previousEodPrice: old?.clearingDate !== row.clearingDate ? old?.eodPrice ?? null : old?.previousEodPrice ?? null,
  };
});

mkdirSync("data", { recursive: true });
const snapshot = {
  source: "ICE Clear Credit",
  sourceUrl: SOURCE_URL,
  updatedAt: new Date().toISOString(),
  note: "ICE 공개값은 5Y CDS EOD Price이며 par CDS spread(bp)가 아닙니다. 가격 하락은 통상 신용 프리미엄 확대로 해석합니다.",
  items,
};
writeFileSync("data/ice_cds.json", JSON.stringify(snapshot, null, 1) + "\n");
console.log(`ICE CDS ${items.map(item => `${item.ticker}=${item.eodPrice}`).join(" ")}`);
