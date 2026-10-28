// 손절 배치 가이드 (규칙서 3-0-3, rules-6.4). 하이퍼리퀴드 1h 봉 기준. 순수 함수.
// 손절 = 진입가 ± max(1.5 × ATR14, 직전 스윙까지 거리 + 0.1 × ATR)
// 스윙: 최근 24봉 안에서 좌우 2봉보다 낮은 저점(또는 높은 고점) 중 가장 최근 것. 없으면 24봉 최저가(최고가).

export const STOP_RULE = {
  atr_length: 14,
  atr_mult: 1.5,
  swing_window: 24,
  swing_side_bars: 2,
  swing_buffer_atr: 0.1,
  max_stop_atr: 2.0, // 이보다 멀면 진입하지 않음
  min_rr: 1.5,
};

const round = (x, d = 6) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(d)));

/** Wilder ATR. bars: {h,l,c} 오래된 것부터. 마지막 값 */
export function atr(bars, length = STOP_RULE.atr_length) {
  if (bars.length < length + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i],
      pc = bars[i - 1].c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let a = tr.slice(0, length).reduce((s, x) => s + x, 0) / length;
  for (let i = length; i < tr.length; i++) a = (a * (length - 1) + tr[i]) / length;
  return a;
}

/** 최근 window봉 안의 가장 최근 스윙 저점·고점 (좌우 k봉 기준). 오른쪽 k봉이 아직 없는 마지막 k봉은 후보에서 뺀다. */
export function swings(bars, window = STOP_RULE.swing_window, k = STOP_RULE.swing_side_bars) {
  const n = bars.length;
  const from = Math.max(k, n - window);
  let low = null,
    high = null;
  for (let i = n - 1 - k; i >= from; i--) {
    const side = [...bars.slice(i - k, i), ...bars.slice(i + 1, i + 1 + k)];
    if (low === null && side.every((b) => bars[i].l < b.l)) low = { price: bars[i].l, at: bars[i].t };
    if (high === null && side.every((b) => bars[i].h > b.h)) high = { price: bars[i].h, at: bars[i].t };
    if (low && high) break;
  }
  const recent = bars.slice(Math.max(0, n - window));
  return {
    swing_low: low,
    swing_high: high,
    low_24h: Math.min(...recent.map((b) => b.l)),
    high_24h: Math.max(...recent.map((b) => b.h)),
  };
}

/** 진입가 하나에 대한 손절 가이드. side: 'long' | 'short' */
export function stopFor(side, entry, a, sw, R = STOP_RULE) {
  if (!(a > 0) || !Number.isFinite(entry)) return null;
  let swing = side === 'long' ? sw.swing_low?.price : sw.swing_high?.price;
  let swingSource = 'pivot';
  // 스윙이 진입가의 반대쪽에 없으면(이미 깨짐) 24봉 극값을 쓴다
  if (swing === undefined || swing === null || (side === 'long' ? swing >= entry : swing <= entry)) {
    swing = side === 'long' ? sw.low_24h : sw.high_24h;
    swingSource = '24h_extreme';
  }
  const swingDist = Math.abs(entry - swing) + R.swing_buffer_atr * a;
  const dist = Math.max(R.atr_mult * a, swingDist);
  const stop = side === 'long' ? entry - dist : entry + dist;
  return {
    stop: round(stop),
    distance_atr: round(dist / a, 3),
    swing: round(swing),
    swing_source: swingSource,
    bound_by: R.atr_mult * a >= swingDist ? 'atr' : 'swing',
    too_wide: dist / a > R.max_stop_atr,
  };
}

/** 종목 하나: HL 1h 봉 → 피드 항목 */
export function stopGuide(bars, price, R = STOP_RULE) {
  if (!Array.isArray(bars) || bars.length < R.atr_length + 2) return null;
  const a = atr(bars, R.atr_length);
  const sw = swings(bars, R.swing_window, R.swing_side_bars);
  const entry = Number.isFinite(price) ? price : bars.at(-1).c;
  return {
    source: 'Hyperliquid perp 1h candles (closed)',
    atr14: round(a),
    atr14_pct: round((a / entry) * 100, 4),
    swing_low: sw.swing_low ? round(sw.swing_low.price) : null,
    swing_high: sw.swing_high ? round(sw.swing_high.price) : null,
    low_24h: round(sw.low_24h),
    high_24h: round(sw.high_24h),
    at_price: round(entry),
    long: stopFor('long', entry, a, sw, R),
    short: stopFor('short', entry, a, sw, R),
  };
}
