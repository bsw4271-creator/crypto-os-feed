// Pure functions that turn closed 1h bars into the feed entries. No network, no clock: callers pass `now`.
import { bollinger, ema, macd, rsi, sma } from './indicators.mjs';
import { INDICATOR_SETTINGS } from './indicator-view.mjs';
import { strategySignals } from './backtest.mjs';

const H = 3600000;
/** A closed 1h bar older than this (from its close) marks the symbol stale. One missed hour is tolerated. */
export const STALE_AFTER_MIN = 150;
/** Bars needed so every indicator and every strategy has warmed up with room to spare. */
export const MIN_BARS = 100;

const round = (x, d = 6) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(d)));
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? round(((a - b) / b) * 100, 4) : null);
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

/**
 * One symbol's entry. `bars` are closed 1h bars {t,o,h,l,c,v} (t = open time), oldest first.
 * `strategies` is a list of strategy definitions (strategies/*.json).
 */
export function symbolBrief({ symbol, group, bars, venue, fallbackReason = null, strategies, now }) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) {
    return { symbol, group, quality: 'error', quality_reason: `closed 1h bars < ${MIN_BARS}` };
  }
  const last = bars.at(-1);
  const closedAt = last.t + H;
  const ageMin = Math.round((now - closedAt) / 60000);
  const quality = ageMin > STALE_AFTER_MIN ? 'stale' : venue === 'Binance' ? 'ok' : 'fallback';
  const qualityReason =
    quality === 'stale'
      ? `last closed bar is ${ageMin} min old`
      : quality === 'fallback'
        ? `Binance unavailable, using ${venue}${fallbackReason ? ` (${fallbackReason})` : ''}`
        : null;

  const close = bars.map((b) => b.c);
  const S = INDICATOR_SETTINGS;
  const m = macd(close, S.macd.fast, S.macd.slow, S.macd.signal);
  const bb = bollinger(close, S.bollinger.length, S.bollinger.mult);
  const r = rsi(close, S.rsi);
  const e = ema(close, S.ema);
  const s = sma(close, S.sma);
  const i = close.length - 1;
  const upper = bb.upper[i],
    lower = bb.lower[i];

  const signals = {};
  for (const st of strategies) {
    const sig = strategySignals(bars, st);
    let lastEntry = -1,
      lastExit = -1;
    for (let k = 0; k < bars.length; k++) {
      if (sig.entry[k]) lastEntry = k;
      if (sig.exit[k]) lastExit = k;
    }
    signals[st.name] = {
      entry_now: sig.entry[i],
      exit_now: sig.exit[i],
      last_entry_signal_at: lastEntry >= 0 ? iso(bars[lastEntry].t + H) : null,
      last_exit_signal_at: lastExit >= 0 ? iso(bars[lastExit].t + H) : null,
      // Which signal came last within the fetched window. A hint, not a position: stops are not modelled here.
      latest: lastEntry < 0 && lastExit < 0 ? 'none' : lastEntry > lastExit ? 'entry' : 'exit',
    };
  }

  return {
    symbol,
    group,
    venue,
    quality,
    quality_reason: qualityReason,
    last_closed_bar_at: iso(closedAt),
    age_min: ageMin,
    price: round(last.c),
    change_24h_pct: bars.length > 24 ? pct(last.c, bars[i - 24].c) : null,
    change_7d_pct: bars.length > 168 ? pct(last.c, bars[i - 168].c) : null,
    indicators_1h: {
      rsi14: round(r[i], 4),
      macd: round(m.macd[i]),
      macd_signal: round(m.signal[i]),
      macd_histogram: round(m.histogram[i]),
      bb_upper: round(upper),
      bb_lower: round(lower),
      // 0 = at the lower band, 1 = at the upper band; below 0 or above 1 = outside the bands.
      bb_position: upper !== null && lower !== null && upper > lower ? round((last.c - lower) / (upper - lower), 4) : null,
      ema9: round(e[i]),
      sma9: round(s[i]),
      ema_above_sma: e[i] !== null && s[i] !== null ? e[i] > s[i] : null,
    },
    signals,
  };
}

/**
 * A deliberately simple market label from BTC and breadth, documented in the feed itself.
 * risk_on: BTC 7d > 0 and at least 60 % of usable symbols up over 24h. risk_off: BTC 7d < 0 and at most 40 % up.
 */
export function marketSummary(entries) {
  const usable = entries.filter((x) => x.quality === 'ok' || x.quality === 'fallback');
  const btc = usable.find((x) => x.symbol === 'BTCUSDT') ?? null;
  const withChange = usable.filter((x) => Number.isFinite(x.change_24h_pct));
  const up = withChange.filter((x) => x.change_24h_pct > 0).length;
  const share = withChange.length ? up / withChange.length : null;
  const btc7 = btc?.change_7d_pct ?? null;
  let regime = 'unknown';
  if (btc7 !== null && share !== null) regime = btc7 > 0 && share >= 0.6 ? 'risk_on' : btc7 < 0 && share <= 0.4 ? 'risk_off' : 'neutral';
  return {
    regime,
    regime_rule: 'risk_on: BTC 7d > 0 and >= 60% of usable symbols up 24h; risk_off: BTC 7d < 0 and <= 40% up; else neutral; unknown if BTC data is missing',
    btc_change_24h_pct: btc?.change_24h_pct ?? null,
    btc_change_7d_pct: btc7,
    breadth_24h_up: withChange.length ? `${up}/${withChange.length}` : null,
    usable_symbols: usable.length,
    total_symbols: entries.length,
  };
}

/** Short Markdown version of the feed for readers that prefer text. */
export function toMarkdown(feed) {
  const L = [];
  L.push(`# Crypto OS 브리핑 피드`);
  L.push('');
  L.push(`- 생성: ${feed.generated_at_kst} (UTC ${feed.generated_at})`);
  L.push(`- 다음 갱신 예상: ${feed.next_update_expected_by} 까지. 이 시각이 지났으면 피드가 멈춘 것.`);
  L.push(`- 시장: **${feed.market.regime}** · BTC 24h ${fmt(feed.market.btc_change_24h_pct)}% · 7d ${fmt(feed.market.btc_change_7d_pct)}% · 24h 상승 ${feed.market.breadth_24h_up ?? '—'}`);
  const st = feed.flows?.stablecoins?.total;
  if (st) L.push(`- 스테이블코인 공급: ${(st.supply_usd / 1e9).toFixed(1)}B USD · 1일 ${fmt(st.change_1d_pct)}% · 7일 ${fmt(st.change_7d_pct)}%`);
  L.push(`- 분석 참고용 데이터입니다. 매매 신호나 투자 권유가 아닙니다.`);
  L.push('');
  L.push('| 종목 | 품질 | 가격 | 24h | 7d | RSI | BB위치 | 지금 진입 신호 | 지금 청산 신호 | HL 현물 | HL 선물 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of feed.symbols) {
    if (x.quality === 'error') {
      L.push(`| ${x.symbol} | error | — | — | — | — | — | — | — | — | — |`);
      continue;
    }
    const on = (k) => Object.entries(x.signals).filter(([, v]) => v[k]).map(([n]) => n).join(', ') || '—';
    const hs = x.hyperliquid?.spot,
      hp = x.hyperliquid?.perp;
    L.push(
      `| ${x.symbol} | ${x.quality} | ${x.price} | ${fmt(x.change_24h_pct)}% | ${fmt(x.change_7d_pct)}% | ${fmt(x.indicators_1h.rsi14)} | ${fmt(x.indicators_1h.bb_position)} | ${on('entry_now')} | ${on('exit_now')} | ${hs ? `${hs.pair} (${fmt(hs.gap_vs_binance_pct)}%)` : '—'} | ${hp ? `${hp.name} (${fmt(hp.gap_vs_binance_pct)}%${hp.oi_change_pct !== null && hp.oi_change_pct !== undefined ? `, OI ${fmt(hp.oi_change_pct)}%` : ''})` : '—'} |`,
    );
  }
  return L.join('\n') + '\n';
}
const fmt = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(2));
