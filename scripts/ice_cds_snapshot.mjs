/* ICE Clear Credit의 무료 5년물 단일종목 CDS EOD 가격을 GitHub Pages용으로 저장한다.
 * ICE 공개 API는 표준계약 "가격"만 주고 par CDS spread(bp)는 주지 않으므로,
 * scripts/cds_spread.mjs로 스프레드를 환산해 함께 기록한다. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parSpreadBp, calibrateDiscountRate } from "./cds_spread.mjs";

const ENDPOINT = "https://status.ice.com/api/cds-settlement-prices/icc-single-names";
const SOURCE_URL = "https://status.ice.com/cds-settlement-prices/icc/single-name-instruments";

/* AI 자본지출 크레딧 복합체. couponBp = 대표로 쓸 표준계약 쿠폰.
 * ICE에 100bp·500bp가 모두 있으면 저쿠폰(100)을 대표로 쓰고 나머지는 할인율 역산에 쓴다. */
const TARGETS = [
  { ticker: "COREWEI", name: "CoreWeave", couponBp: 500, tag: "neocloud" },
  { ticker: "ORCLE",   name: "Oracle",    couponBp: 100, tag: "neocloud" },
  { ticker: "EQIX",    name: "Equinix",   couponBp: 100, tag: "datacenter" },
  { ticker: "DELLN",   name: "Dell",      couponBp: 100, tag: "hardware" },
  { ticker: "METAPL",  name: "Meta",      couponBp: 100, tag: "hyperscaler" },
  { ticker: "AMZN",    name: "Amazon",    couponBp: 100, tag: "hyperscaler" },
  { ticker: "MSFT",    name: "Microsoft", couponBp: 100, tag: "hyperscaler" },
];

const response = await fetch(ENDPOINT, {
  headers: { Accept: "application/json", "User-Agent": "overnight-terminal-cds-snapshot/1.0" },
});
if (!response.ok) throw new Error(`ICE API HTTP ${response.status}`);
const rows = await response.json();
if (!Array.isArray(rows)) throw new Error("ICE API returned an unexpected payload");

const instrumentName = row => row.instrumentName || row.instrument || "";
/* COREWEI.SNRFOR.USD.XR14.500.2031-06-20 → {couponBp, maturity} */
const parse = row => {
  const parts = instrumentName(row).split(".");
  return { ticker: parts[0], couponBp: Number(parts[4]), maturity: parts[5] };
};
const findRow = (ticker, couponBp) => rows.find(row => {
  const p = parse(row);
  return p.ticker === ticker && p.couponBp === couponBp && row.eodPrice != null;
});

let previous = { items: [] };
try { previous = JSON.parse(readFileSync("data/ice_cds.json", "utf8")); } catch { /* first snapshot */ }
const oldByTicker = new Map((previous.items || []).map(item => [item.ticker, item]));

/* 할인율 역산: 표시 종목 중 100bp·500bp가 동시에 청산되는 발행사만 사용.
 * ICE 전체(197종)로 맞추면 잔차가 12bp까지 벌어진다 — 하이일드까지 섞이면
 * 회수율 40% 가정이 깨져 단일 r로 수렴하지 않기 때문. 표시 종목대로 맞추면 ~2bp. */
const clearingDate = rows.find(row => row.clearingDate)?.clearingDate;
if (!clearingDate) throw new Error("ICE payload has no clearingDate");
const pairs = TARGETS.map(t => t.ticker).map(ticker => {
  const low = findRow(ticker, 100), high = findRow(ticker, 500);
  if (!low || !high) return null;
  return {
    priceLow: Number(low.eodPrice), couponLowBp: 100,
    priceHigh: Number(high.eodPrice), couponHighBp: 500,
    maturity: parse(low).maturity,
  };
}).filter(Boolean);
const calibration = calibrateDiscountRate(pairs, clearingDate);

const missing = [];
const items = TARGETS.map(target => {
  const row = findRow(target.ticker, target.couponBp);
  if (!row) { missing.push(target.ticker); return null; }
  const { maturity } = parse(row);
  const eodPrice = Number(row.eodPrice);
  const spreadBp = parSpreadBp({ price: eodPrice, couponBp: target.couponBp, maturity, valuation: row.clearingDate, discountRate: calibration.rate });
  const old = oldByTicker.get(target.ticker);
  const isNewDate = old?.clearingDate !== row.clearingDate;
  const previousEodPrice = isNewDate ? old?.eodPrice ?? null : old?.previousEodPrice ?? null;
  /* 스프레드 기록 이전 스냅샷에는 가격만 있으므로 같은 모형으로 환산해 채운다 */
  const previousSpreadBp = (isNewDate ? old?.spreadBp : old?.previousSpreadBp)
    ?? (previousEodPrice == null ? null : parSpreadBp({ price: previousEodPrice, couponBp: target.couponBp, maturity, valuation: row.clearingDate, discountRate: calibration.rate }));
  return {
    ...target,
    instrument: instrumentName(row),
    clearingDate: row.clearingDate,
    maturity,
    eodPrice,
    spreadBp: spreadBp == null ? null : Math.round(spreadBp * 10) / 10,
    previousEodPrice,
    previousSpreadBp: previousSpreadBp == null ? null : Math.round(previousSpreadBp * 10) / 10,
  };
}).filter(Boolean);
if (!items.length) throw new Error("no ICE CDS rows matched the targets");
if (missing.length) console.warn(`WARN missing ICE rows: ${missing.join(", ")}`);

mkdirSync("data", { recursive: true });
const snapshot = {
  source: "ICE Clear Credit",
  sourceUrl: SOURCE_URL,
  updatedAt: new Date().toISOString(),
  note: "ICE 공개값은 5Y CDS EOD Price이며, spreadBp는 플랫 해저드 모형으로 환산한 근사 par spread입니다(회수율 40% 가정).",
  model: {
    recovery: 0.4,
    discountRate: Math.round(calibration.rate * 100000) / 100000,
    discountSource: calibration.pairs ? `100/500 듀얼쿠폰 ${calibration.pairs}종 역산` : "기본값",
    residualBp: calibration.rmseBp == null ? null : Math.round(calibration.rmseBp * 10) / 10,
  },
  missing,
  items,
};
writeFileSync("data/ice_cds.json", JSON.stringify(snapshot, null, 1) + "\n");
console.log(`ICE CDS r=${snapshot.model.discountRate} ${items.map(i => `${i.ticker}=${i.spreadBp}bp`).join(" ")}`);
