/* FINRA TRACE 크레딧 테이프 스냅샷.
 *
 * Public 자격증명으로 받을 수 있는 건 **시장 전체 집계**뿐이다(개별 채권·CUSIP 없음).
 * breadth = 상승/하락 종목수·52주 신고저, sentiment = 고객 매수/매도·딜러간 거래량.
 * 등급별(투자등급·하이일드·컨버터블)과 144A 시장을 따로 뽑아
 * "크레딧 시장이 조이는가 풀리는가"를 CDS 패널 옆에 붙인다.
 *
 * 필요 secrets: FINRA_CLIENT_ID / FINRA_CLIENT_SECRET (Public credential) */
import { writeFileSync, mkdirSync } from "node:fs";

const TOKEN_URL = "https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials";
const DATA_URL = name => `https://api.finra.org/data/group/fixedIncomeMarket/name/${name}`;
const HISTORY_DAYS = 60;

/* tradeType(세그먼트) → 표시 이름. 144A는 별도 데이터셋에서 같은 세그먼트를 받는다. */
const SEGMENTS = [
  { key: "high yield",        label: "하이일드",      market: "corporate" },
  { key: "high yield",        label: "144A 하이일드", market: "144a" },
  { key: "investment grade",  label: "투자등급",      market: "corporate" },
  { key: "convertibles",      label: "컨버터블",      market: "corporate" },
];
/* breadth는 productCategory, sentiment는 tradeType에 세그먼트가 들어간다 */
const SENTIMENT_KEY = { "high yield": "high yield", "investment grade": "investment grade", convertibles: "convertible bonds" };

const id = process.env.FINRA_CLIENT_ID, secret = process.env.FINRA_CLIENT_SECRET;
if (!id || !secret) throw new Error("FINRA_CLIENT_ID / FINRA_CLIENT_SECRET 가 필요합니다");

const tokenRes = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
});
if (!tokenRes.ok) throw new Error(`FINRA token HTTP ${tokenRes.status}`);
const token = (await tokenRes.json()).access_token;

const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
async function query(dataset) {
  const res = await fetch(DATA_URL(dataset), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    /* 정렬은 파티션키 EQUAL 필터가 있어야만 허용되므로 기간만 걸고 받아서 직접 정렬한다 */
    body: JSON.stringify({ limit: 5000, compareFilters: [{ fieldName: "tradeReportDate", fieldValue: since, compareType: "GREATER" }] }),
  });
  if (!res.ok) throw new Error(`FINRA ${dataset} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const [breadth, breadth144a, sentiment] = await Promise.all([
  query("corporateMarketBreadth"),
  query("corporate144AMarketBreadth"),
  query("corporateMarketSentiment"),
]);

const dates = [...new Set(breadth.map(r => r.tradeReportDate))].sort();
const latestDate = dates[dates.length - 1], prevDate = dates[dates.length - 2] ?? null;
if (!latestDate) throw new Error("FINRA breadth 응답이 비어 있습니다");

const ratio = row => (row && row.declines ? row.advances / row.declines : null);

const segments = SEGMENTS.map(seg => {
  const source = seg.market === "144a" ? breadth144a : breadth;
  const pick = (date) => source.find(r => r.tradeReportDate === date && r.productCategory === seg.key);
  const latest = pick(latestDate);
  if (!latest) return null;

  /* 고객 순매수: 144A는 sentiment 데이터셋이 없어 회사채 전체값으로 대체하지 않고 비운다 */
  const sentimentRows = seg.market === "144a" ? [] :
    sentiment.filter(r => r.tradeReportDate === latestDate && r.tradeType === SENTIMENT_KEY[seg.key]);
  const side = name => sentimentRows.find(r => r.productCategory === name)?.totalVolume ?? null;
  const buy = side("customer buy"), sell = side("customer sell");

  const history = dates.map(date => {
    const row = pick(date);
    const value = ratio(row);
    return value == null ? null : { date, adRatio: Math.round(value * 1000) / 1000 };
  }).filter(Boolean);

  return {
    ...seg,
    advances: latest.advances,
    declines: latest.declines,
    unchanged: latest.unchanged,
    adRatio: Math.round(ratio(latest) * 1000) / 1000,
    prevAdRatio: prevDate ? (ratio(pick(prevDate)) == null ? null : Math.round(ratio(pick(prevDate)) * 1000) / 1000) : null,
    high52: latest.fiftyTwoWeekHigh,
    low52: latest.fiftyTwoWeekLow,
    volumeUsdMn: Math.round(latest.totalVolume),
    customerBuyUsdMn: buy == null ? null : Math.round(buy),
    customerSellUsdMn: sell == null ? null : Math.round(sell),
    netCustomerUsdMn: buy == null || sell == null ? null : Math.round(buy - sell),
    history,
  };
}).filter(Boolean);
if (!segments.length) throw new Error("세그먼트를 하나도 만들지 못했습니다");

mkdirSync("data", { recursive: true });
const snapshot = {
  source: "FINRA TRACE (Query API · public credential)",
  sourceUrl: "https://developer.finra.org/catalog",
  updatedAt: new Date().toISOString(),
  latestDate, prevDate,
  note: "공개 등급은 시장 전체 집계만 제공합니다(개별 발행사·CUSIP 없음). 금액 단위는 백만 달러.",
  segments,
};
writeFileSync("data/finra_credit.json", JSON.stringify(snapshot, null, 1) + "\n");
console.log(`FINRA credit ${latestDate} ` + segments.map(s => `${s.label}=${s.adRatio}`).join(" "));
