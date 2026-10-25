// 숏 전용 신호 (규칙서 3-0-2, 소유자 결정 2026-10-25). 순수 함수: 네트워크·시계 없음.
// bars: 닫힌 1h 봉 {t,o,h,l,c,v}, 오래된 것부터.
import { bollinger, ema, macd, rsi, sma } from './indicators.mjs';
import { INDICATOR_SETTINGS } from './indicator-view.mjs';

const H = 3600000;
const round = (x, d = 6) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(d)));
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const ok = (...xs) => xs.every((x) => x !== null && x !== undefined && Number.isFinite(x));

/** 숏 셋업이 보는 구간 */
export const SHORT_SETTINGS = {
  fade_window: 3, // 반등 고점을 찾는 최근 봉 수
  fade_touch_bb: 0.8, // 반등이 볼린저 위치 0.8 이상까지 닿음
  fade_touch_rsi: 60, // 또는 RSI 60 이상
  min_rsi: 35, // 이보다 낮으면 과매도 — 숏 피함(3-0-2)
  support_window: 24, // 지지선 = 직전 24봉 최저가
  stop_buffer: 0.001, // 손절은 기준 가격 0.1% 위
};

function lines(bars) {
  const close = bars.map((b) => b.c);
  const S = INDICATOR_SETTINGS;
  const m = macd(close, S.macd.fast, S.macd.slow, S.macd.signal);
  const bb = bollinger(close, S.bollinger.length, S.bollinger.mult);
  return {
    close,
    high: bars.map((b) => b.h),
    low: bars.map((b) => b.l),
    rsi: rsi(close, S.rsi),
    macd: m.macd,
    signal: m.signal,
    upper: bb.upper,
    lower: bb.lower,
    ema: ema(close, S.ema),
    sma: sma(close, S.sma),
  };
}
const crossDown = (a, b, i) => {
  const b0 = typeof b === 'number' ? b : b[i - 1],
    b1 = typeof b === 'number' ? b : b[i];
  return ok(a[i - 1], a[i], b0, b1) && a[i - 1] >= b0 && a[i] < b1;
};
const crossUp = (a, b, i) => {
  const b0 = typeof b === 'number' ? b : b[i - 1],
    b1 = typeof b === 'number' ? b : b[i];
  return ok(a[i - 1], a[i], b0, b1) && a[i - 1] <= b0 && a[i] > b1;
};

/**
 * 롱 전략(strategies/*.json)을 뒤집은 숏 전략. 롱 청산 신호를 빌려 쓰지 않는다.
 * bb: 볼린저 상단 위에 있던 종가가 상단 안으로 다시 들어옴(상단 돌파 실패). 청산: 하단 아래 종가.
 * ema: ema9가 sma9를 아래로 교차 + RSI 30 초과. 청산: 위로 교차.
 * macd: MACD가 시그널을 아래로 교차. 청산: 위로 교차.
 * rsi: RSI가 70을 아래로 교차. 청산: 30을 위로 교차.
 */
export const SHORT_STRATEGIES = {
  bb: {
    entry: (L, i) => ok(L.upper[i - 1], L.upper[i]) && L.close[i - 1] > L.upper[i - 1] && L.close[i] <= L.upper[i],
    exit: (L, i) => ok(L.lower[i]) && L.close[i] < L.lower[i],
  },
  ema: {
    entry: (L, i) => crossDown(L.ema, L.sma, i) && ok(L.rsi[i]) && L.rsi[i] > 30,
    exit: (L, i) => crossUp(L.ema, L.sma, i),
  },
  macd: { entry: (L, i) => crossDown(L.macd, L.signal, i), exit: (L, i) => crossUp(L.macd, L.signal, i) },
  rsi: { entry: (L, i) => crossDown(L.rsi, 70, i), exit: (L, i) => crossUp(L.rsi, 30, i) },
};

const bbPos = (L, k, price) =>
  ok(L.upper[k], L.lower[k], price) && L.upper[k] > L.lower[k] ? (price - L.lower[k]) / (L.upper[k] - L.lower[k]) : null;

/** 반등 실패 숏(bounce_fade): 최근 반등이 저항(볼린저 상단 근처·RSI 60+·ema9/sma9)에 닿고 꺾임 */
export function bounceFade(L, i, S = SHORT_SETTINGS) {
  const w = [];
  for (let k = Math.max(1, i - S.fade_window + 1); k <= i; k++) w.push(k);
  const peakPos = Math.max(...w.map((k) => bbPos(L, k, L.high[k]) ?? -Infinity));
  const peakRsi = Math.max(...w.map((k) => L.rsi[k] ?? -Infinity));
  const recentHigh = Math.max(...w.map((k) => L.high[k]));
  const ma = (k) => (ok(L.ema[k], L.sma[k]) ? Math.min(L.ema[k], L.sma[k]) : null);
  const touchedBand = peakPos >= S.fade_touch_bb;
  const touchedRsi = peakRsi >= S.fade_touch_rsi;
  const failedAtMa = w.some((k) => ok(ma(k)) && L.high[k] >= ma(k)) && ok(L.ema[i]) && L.close[i] < L.ema[i];
  const turning = ok(L.rsi[i], L.rsi[i - 1]) && L.close[i] < L.close[i - 1] && L.rsi[i] < L.rsi[i - 1];
  const pos = bbPos(L, i, L.close[i]);
  const notOversold = ok(L.rsi[i]) && L.rsi[i] >= S.min_rsi && pos !== null && pos > 0;
  const now = turning && (touchedBand || touchedRsi || failedAtMa) && notOversold;

  // 손절: 반등 고점과 볼린저 상단 중 현재가 위에서 가장 가까운 것 + 0.1%
  const above = [recentHigh, L.upper[i]].filter((x) => ok(x) && x > L.close[i]);
  const stop = above.length ? Math.min(...above) * (1 + S.stop_buffer) : null;
  // 목표: 볼린저 하단과 직전 저점 중 현재가 아래에서 가까운 것
  const priorLow = Math.min(...L.low.slice(Math.max(0, i - S.support_window), Math.max(0, i - S.fade_window + 1)));
  const below = [L.lower[i], priorLow].filter((x) => ok(x) && x < L.close[i]);
  const target = below.length ? Math.max(...below) : null;
  return {
    now,
    why: now ? [touchedBand && 'bb_upper 근처', touchedRsi && 'RSI 60+', failedAtMa && 'ema9/sma9 실패'].filter(Boolean).join(', ') : null,
    peak_bb_position: round(peakPos === -Infinity ? null : peakPos, 4),
    peak_rsi: round(peakRsi === -Infinity ? null : peakRsi, 4),
    stop: round(stop),
    target: round(target),
    reward_risk: stop && target ? round((L.close[i] - target) / (stop - L.close[i]), 3) : null,
  };
}

/** 지지선 이탈 숏(breakdown): 종가가 직전 24봉 최저가를 이번 봉에 처음 깸 */
export function breakdown(L, i, S = SHORT_SETTINGS) {
  const support = (j) => (j - S.support_window < 0 ? null : Math.min(...L.low.slice(j - S.support_window, j)));
  const sNow = support(i),
    sPrev = support(i - 1);
  const now = ok(sNow, sPrev) && L.close[i] < sNow && L.close[i - 1] >= sPrev;
  // 손절: 이탈 봉 고점(지지선보다 낮으면 지지선) + 0.1% — 이탈이 완전히 되돌려지면 틀린 것
  const stop = ok(sNow) ? Math.max(L.high[i], sNow) * (1 + S.stop_buffer) : null;
  const target = ok(L.lower[i]) && L.lower[i] < L.close[i] ? L.lower[i] : null;
  return {
    now,
    support: round(sNow),
    oversold: ok(L.rsi[i]) ? L.rsi[i] < S.min_rsi : null,
    stop: now ? round(stop) : null,
    target: now ? round(target) : null,
    reward_risk: now && stop && target ? round((L.close[i] - target) / (stop - L.close[i]), 3) : null,
  };
}

/** 한 종목의 숏 블록 */
export function shortBrief(bars, S = SHORT_SETTINGS) {
  const L = lines(bars);
  const i = bars.length - 1;
  if (i < S.support_window + 1) return null;
  const strategies = {};
  for (const [name, st] of Object.entries(SHORT_STRATEGIES)) {
    let lastEntry = -1,
      lastExit = -1;
    for (let k = 1; k <= i; k++) {
      if (st.entry(L, k)) lastEntry = k;
      if (st.exit(L, k)) lastExit = k;
    }
    strategies[name] = {
      entry_now: lastEntry === i,
      exit_now: lastExit === i,
      last_entry_signal_at: lastEntry >= 0 ? iso(bars[lastEntry].t + H) : null,
      last_exit_signal_at: lastExit >= 0 ? iso(bars[lastExit].t + H) : null,
      latest: lastEntry < 0 && lastExit < 0 ? 'none' : lastEntry > lastExit ? 'entry' : 'exit',
    };
  }
  const setups = { bounce_fade: bounceFade(L, i, S), breakdown: breakdown(L, i, S) };
  const pos = bbPos(L, i, L.close[i]);
  return {
    oversold: ok(L.rsi[i]) ? L.rsi[i] < S.min_rsi || (pos !== null && pos < 0) : null,
    entry_now: Object.values(strategies).some((x) => x.entry_now) || Object.values(setups).some((x) => x.now),
    strategies,
    setups,
  };
}
