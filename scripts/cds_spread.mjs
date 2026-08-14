/* ICE가 공개하는 표준화 CDS "가격"을 par CDS spread(bp)로 환산한다.
 *
 * 표준계약(SNRFOR·USD·XR14)은 고정쿠폰(100bp/500bp)에 선불(upfront)을 얹어 거래되므로
 * 가격만으로는 크레딧 수준을 비교할 수 없다(쿠폰이 다르면 가격도 다름).
 * upfront = (100 - price)/100 을 flat hazard 모형으로 풀어 λ를 구하고,
 * 그 λ가 만드는 par spread(= upfront 0으로 만드는 쿠폰)를 돌려준다.
 *
 * 근사: 플랫 해저드·플랫 할인율·표준 회수율 40%·분기 IMM 쿠폰.
 * ISDA 표준모형(실제 SOFR 커브·정확한 accrual)과는 수 bp 차이가 날 수 있다.
 *
 * 할인율은 고정하지 않고 매일 역산한다(calibrateDiscountRate): 일부 발행사는
 * 100bp·500bp 계약이 동시에 청산되는데, 같은 크레딧이므로 par spread가 같아야 한다.
 * 그 차이를 최소화하는 r을 찾으면 커브를 안 받아도 실제 금리 수준에 맞춰진다.
 * (2026-08-13 실측: r=4% 고정 시 두 계약 괴리 7.5bp → 역산 r≈3.2%에서 1bp 내) */

const RECOVERY = 0.4;      // NA 선순위 표준
const DEFAULT_DISCOUNT = 0.035;

/* 분기 IMM 쿠폰일(3/6/9/12월 20일) 스케줄 */
function schedule(valuation, maturity) {
  const out = [];
  const d = new Date(maturity);
  while (d > valuation) {
    out.unshift(new Date(d));
    d.setUTCMonth(d.getUTCMonth() - 3);
  }
  return out;
}

const yearsBetween = (a, b) => (b - a) / (365.25 * 24 * 3600 * 1000);

/* λ(플랫 해저드)에서 보장·프리미엄 레그 PV 계산 (노셔널 1 기준) */
function legs(lambda, valuation, dates, discount) {
  const DF = t => Math.exp(-discount * t);
  const Q = t => Math.exp(-lambda * t);
  let protection = 0, annuity = 0, prevT = 0;
  for (const date of dates) {
    const t = yearsBetween(valuation, date);
    if (t <= 0) continue;
    const dt = t - prevT;
    const df = DF((t + prevT) / 2);              // 구간 중점 할인
    const defaultProb = Q(prevT) - Q(t);
    protection += (1 - RECOVERY) * df * defaultProb;
    annuity += dt * DF(t) * Q(t) + dt / 2 * df * defaultProb;  // 뒤 항 = 부도 시 경과이자
    prevT = t;
  }
  return { protection, annuity };
}

/* upfront(노셔널 대비 소수) → par spread(bp).
 * upfront > 0 = 보장매수자가 선불 지급 = 스프레드가 쿠폰보다 넓다. */
export function parSpreadBp({ price, couponBp, maturity, valuation, discountRate = DEFAULT_DISCOUNT }) {
  const val = new Date(valuation), mat = new Date(maturity);
  const dates = schedule(val, mat);
  if (!dates.length) return null;
  const upfront = (100 - Number(price)) / 100;
  const coupon = couponBp / 10000;

  /* upfront는 λ에 대해 단조증가 → 이분법 */
  const netUpfront = lambda => {
    const { protection, annuity } = legs(lambda, val, dates, discountRate);
    return protection - coupon * annuity;
  };
  let lo = 1e-9, hi = 5;
  if (netUpfront(lo) > upfront || netUpfront(hi) < upfront) return null;  // 모형 범위 밖
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (netUpfront(mid) < upfront) lo = mid; else hi = mid;
  }
  const lambda = (lo + hi) / 2;
  const { protection, annuity } = legs(lambda, val, dates, discountRate);
  return annuity > 0 ? (protection / annuity) * 10000 : null;
}

/* 같은 발행사·같은 만기의 100bp/500bp 계약 쌍으로 할인율 역산.
 * pairs: [{ priceLow, couponLowBp, priceHigh, couponHighBp, maturity }]
 * 쌍이 없으면 기본값을 그대로 돌려준다. */
export function calibrateDiscountRate(pairs, valuation, { maxPairs = 60 } = {}) {
  const diffs = rate => pairs.map(p => {
    const a = parSpreadBp({ price: p.priceLow, couponBp: p.couponLowBp, maturity: p.maturity, valuation, discountRate: rate });
    const b = parSpreadBp({ price: p.priceHigh, couponBp: p.couponHighBp, maturity: p.maturity, valuation, discountRate: rate });
    return a == null || b == null ? null : { p, gap: a - b, level: a };
  });

  /* 기본 할인율에서 모형이 풀리고 스프레드가 상식 범위인 쌍만 사용
     (부실 발행사는 upfront가 모형 밖으로 나가 역산을 왜곡한다) */
  const usable = diffs(DEFAULT_DISCOUNT)
    .filter(d => d && Number.isFinite(d.gap) && d.level > 0 && d.level < 1000)
    .slice(0, maxPairs)
    .map(d => d.p);
  if (!usable.length) return { rate: DEFAULT_DISCOUNT, rmseBp: null, pairs: 0 };

  const stats = rate => {
    let sum = 0, sq = 0, n = 0;
    for (const p of usable) {
      const a = parSpreadBp({ price: p.priceLow, couponBp: p.couponLowBp, maturity: p.maturity, valuation, discountRate: rate });
      const b = parSpreadBp({ price: p.priceHigh, couponBp: p.couponHighBp, maturity: p.maturity, valuation, discountRate: rate });
      if (a == null || b == null) continue;
      sum += a - b; sq += (a - b) ** 2; n++;
    }
    return n ? { gap: sum / n, rmse: Math.sqrt(sq / n) } : null;
  };

  /* 괴리는 r에 대해 단조증가(r↑ → 저쿠폰 계약의 환산 스프레드가 상대적으로 커짐) → 이분법 */
  let lo = 0.001, hi = 0.12;
  const gapLo = stats(lo), gapHi = stats(hi);
  if (!gapLo || !gapHi || !(gapLo.gap < 0 && gapHi.gap > 0)) {
    const s = stats(DEFAULT_DISCOUNT);
    return { rate: DEFAULT_DISCOUNT, rmseBp: s ? s.rmse : null, pairs: usable.length };
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (stats(mid).gap < 0) lo = mid; else hi = mid;
  }
  const rate = (lo + hi) / 2;
  return { rate, rmseBp: stats(rate).rmse, pairs: usable.length };
}
