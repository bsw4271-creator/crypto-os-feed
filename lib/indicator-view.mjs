// Generated from crypto-investment-os lib/indicator-view.ts (sha256 45c8e1ab51d42a13…, branch claude/backtest-engine-20261018 c2d66ce).
// Type annotations removed only; logic unchanged. Edit the source in Crypto OS first, then regenerate.
// Pure, client-safe: Binance 1h klines -> validated closed candles -> indicator view.
// No network, no database. Indicator math is lib/indicators.ts (verified module, see docs/indicators.md).
import { rsi, macd, bollinger, ema, sma } from './indicators.mjs';
const H = 3600000;
/** Klines requested per symbol. The comparison with TradingView used 1000 bars of history (docs/indicators.md). */
export const INDICATOR_KLINE_LIMIT = 1000;
/** Closed bars returned to the chart. Computation always uses all validated history first. */
export const INDICATOR_DISPLAY_BARS = 300;
/** Below this many closed bars the response is refused: MACD signal needs 34 bars and the display needs 300. */
export const INDICATOR_MIN_CLOSED_BARS = INDICATOR_DISPLAY_BARS + 33;
export const INDICATOR_SETTINGS = { rsi: 14, macd: { fast: 12, slow: 26, signal: 9 }, bollinger: { length: 20, mult: 2 }, ema: 9, sma: 9 };
// Subset of FLOW_MARKETS in lib/flow.ts (kept separate so the client bundle never imports server code;
// tests/indicators.test.mjs asserts the two agree). Never inferred from a ticker. useless-3 (USELESSUSDT) is
// excluded: Binance SPOT answers "Invalid symbol" for it (checked 2026-10-17), so its candles cannot come from here.
export const INDICATOR_MARKETS = { bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT', hyperliquid: 'HYPEUSDT', layerzero: 'ZROUSDT' };
/** Gate.io spot pairs for the same assets: fallback venue when Binance refuses the request (e.g. HTTP 403 from the hosting region). */
export const INDICATOR_GATE_PAIRS = { bitcoin: 'BTC_USDT', ethereum: 'ETH_USDT', solana: 'SOL_USDT', hyperliquid: 'HYPE_USDT', layerzero: 'ZRO_USDT' };
const SOURCES = { Binance: 'Binance public spot (data-api.binance.vision)', Gate: 'Gate.io public spot (api.gateio.ws)' };
function num(x, code) {
    if (typeof x === 'number') {
        if (!Number.isFinite(x))
            throw Error(code);
        return x;
    }
    if (typeof x !== 'string' || !x.trim())
        throw Error(code);
    const n = Number(x);
    if (!Number.isFinite(n))
        throw Error(code);
    return n;
}
/**
 * Validate Binance /api/v3/klines rows and keep only CLOSED bars.
 * Rejects (throws) instead of repairing: wrong shape, non-finite or non-positive prices, high/low inconsistent
 * with open/close, negative volume, unsorted or duplicate open times, any gap, close time != open + 1h - 1.
 * A bar is closed only when its close time is strictly before `now`; such trailing bars are counted, not kept.
 */
export function parseKlines(raw, now) {
    if (!Array.isArray(raw))
        throw Error('MALFORMED_KLINES');
    if (!Number.isFinite(now))
        throw Error('INVALID_CLOCK');
    const rows = [];
    let excludedInProgress = 0, prev = null;
    for (let i = 0; i < raw.length; i++) {
        if (!(i in raw))
            throw Error('MALFORMED_KLINES');
        const r = raw[i];
        if (!Array.isArray(r) || r.length < 7)
            throw Error('MALFORMED_KLINES');
        const t = num(r[0], 'MALFORMED_KLINES'), closeTime = num(r[6], 'MALFORMED_KLINES');
        if (!Number.isSafeInteger(t) || t % H !== 0 || closeTime !== t + H - 1)
            throw Error('MALFORMED_KLINES');
        const o = num(r[1], 'MALFORMED_PRICE'), h = num(r[2], 'MALFORMED_PRICE'), l = num(r[3], 'MALFORMED_PRICE'), c = num(r[4], 'MALFORMED_PRICE'), v = num(r[5], 'MALFORMED_VOLUME');
        if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < Math.max(o, c, l) || l > Math.min(o, c, h))
            throw Error('MALFORMED_PRICE');
        if (v < 0)
            throw Error('MALFORMED_VOLUME');
        // Continuity is checked against the previous ROW, including a bar excluded as in progress.
        if (prev !== null && t !== prev + H)
            throw Error(t <= prev ? 'UNSORTED_KLINES' : 'GAPPED_KLINES');
        prev = t;
        if (closeTime >= now) {
            excludedInProgress++;
            continue;
        }
        if (excludedInProgress)
            throw Error('UNSORTED_KLINES'); // a closed bar after an in-progress bar is impossible
        rows.push({ t, o, h, l, c, v });
    }
    if (excludedInProgress > 1)
        throw Error('UNSORTED_KLINES');
    return { rows, excludedInProgress };
}
/**
 * Convert Gate.io /spot/candlesticks rows to the Binance kline shape so parseKlines applies the same checks.
 * Gate row: [open time (s), quote volume, close, high, low, open, base volume, window closed]. Times are seconds.
 * Unknown shapes are rejected, never guessed.
 */
export function gateToKlines(raw) {
    if (!Array.isArray(raw))
        throw Error('MALFORMED_KLINES');
    return raw.map((r, i) => {
        if (!(i in raw) || !Array.isArray(r) || r.length < 7)
            throw Error('MALFORMED_KLINES');
        const t = num(r[0], 'MALFORMED_KLINES') * 1000;
        return [t, r[5], r[3], r[4], r[2], r[6], t + H - 1];
    });
}
const last = (s) => s.at(-1) ?? null;
/** Build the chart view. Indicators are computed on ALL validated closed bars, then trimmed for display. */
export function buildIndicatorView(id, raw, now, venue = 'Binance', fallbackReason = null) {
    const symbol = INDICATOR_MARKETS[id];
    if (!symbol)
        throw Error('UNMAPPED_ASSET');
    const venueSymbol = venue === 'Gate' ? INDICATOR_GATE_PAIRS[id] : symbol;
    if (!venueSymbol)
        throw Error('UNMAPPED_ASSET');
    const { rows, excludedInProgress } = parseKlines(raw, now);
    if (rows.length < INDICATOR_MIN_CLOSED_BARS)
        throw Error('INSUFFICIENT_HISTORY');
    const close = rows.map(r => r.c), s = INDICATOR_SETTINGS;
    const m = macd(close, s.macd.fast, s.macd.slow, s.macd.signal), b = bollinger(close, s.bollinger.length, s.bollinger.mult);
    const full = { rsi: rsi(close, s.rsi), macd: m.macd, signal: m.signal, histogram: m.histogram, basis: b.basis, upper: b.upper, lower: b.lower, ema: ema(close, s.ema), sma: sma(close, s.sma) };
    const from = rows.length - INDICATOR_DISPLAY_BARS, cut = (x) => x.slice(from);
    const series = { rsi: cut(full.rsi), macd: cut(full.macd), signal: cut(full.signal), histogram: cut(full.histogram), basis: cut(full.basis), upper: cut(full.upper), lower: cut(full.lower), ema: cut(full.ema), sma: cut(full.sma) };
    // With >= 333 closed bars every displayed value is past its warm-up; a null here would be a bug.
    for (const [k, v] of Object.entries(series))
        if (v.some(x => x === null))
            throw Error('WARMUP_IN_DISPLAY:' + k);
    return { id, symbol, interval: '1h', venue, venueSymbol, source: SOURCES[venue], fallbackReason: venue === 'Binance' ? null : fallbackReason, settings: s, historyBars: rows.length, excludedInProgress, lastClosedAt: rows.at(-1).t,
        bars: rows.slice(from), series,
        latest: { close: close.at(-1), rsi: last(series.rsi), macd: last(series.macd), signal: last(series.signal), histogram: last(series.histogram), basis: last(series.basis), upper: last(series.upper), lower: last(series.lower), ema: last(series.ema), sma: last(series.sma) } };
}
/** Client-side shape check of an /api/indicators response. Never trusts lengths or numbers blindly. */
export function isIndicatorView(x, id) {
    if (!x || typeof x !== 'object')
        return false;
    const v = x;
    if (v.id !== id || v.symbol !== INDICATOR_MARKETS[id] || (v.venue !== 'Binance' && v.venue !== 'Gate') || v.venueSymbol !== (v.venue === 'Gate' ? INDICATOR_GATE_PAIRS[id] : INDICATOR_MARKETS[id]) || v.interval !== '1h' || !Array.isArray(v.bars) || v.bars.length !== INDICATOR_DISPLAY_BARS || !v.series || !v.latest)
        return false;
    if (!Number.isFinite(v.lastClosedAt) || !Number.isSafeInteger(v.historyBars) || (v.historyBars ?? 0) < INDICATOR_MIN_CLOSED_BARS)
        return false;
    const finite = (n) => typeof n === 'number' && Number.isFinite(n);
    if (!v.bars.every((b, i) => b && finite(b.t) && finite(b.c) && finite(b.o) && finite(b.h) && finite(b.l) && finite(b.v) && (i === 0 || b.t === v.bars[i - 1].t + H)))
        return false;
    if (v.bars.at(-1).t !== v.lastClosedAt)
        return false;
    for (const k of ['rsi', 'macd', 'signal', 'histogram', 'basis', 'upper', 'lower', 'ema', 'sma']) {
        const s = v.series[k];
        if (!Array.isArray(s) || s.length !== INDICATOR_DISPLAY_BARS || !s.every(finite))
            return false;
    }
    return true;
}
