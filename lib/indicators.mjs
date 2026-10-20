// Generated from crypto-investment-os lib/indicators.ts (sha256 529dd7b28c867b1f…, branch claude/backtest-engine-20261018 c2d66ce).
// Type annotations removed only; logic unchanged. Edit the source in Crypto OS first, then regenerate.
// TradingView-compatible indicator implementations, v2.1 (2026-10-15).
// v2.1 changes: roundTo rounds on decimal digits (no intermediate binary rounding, no non-finite
// result); rsi rejects non-finite intermediate values (price changes, gains/losses, RMA up/down);
// closes/volume reject holes in sparse candle arrays.
// Written from the public definitions of the built-in indicators, not from TradingView code.
//
// INPUT CONTRACT (v2):
//   - Every series passed in must be an array of finite numbers. null, undefined, NaN, Infinity,
//     strings etc. are REJECTED with IndicatorInputError. Nothing is silently replaced by 0 or
//     carried forward. (v1 accepted null/NaN and silently carried the previous value in EMA/RMA.)
//   - Periods must be safe integers >= 1. 0, negatives, fractions, NaN, Infinity are rejected.
//   - Bollinger multiplier must be a finite number > 0.
//   - roundTo decimals must be an integer in 0..12.
// OUTPUT CONTRACT:
//   - Output arrays have the same length as the input.
//   - `null` in an output means only "not enough history yet" (warm-up). It is NOT claimed to be
//     identical to Pine's `na` in every respect; see SPEC.md.
//   - An empty input returns an empty output. Input shorter than the warm-up returns all nulls.
//   - If a computed value is not finite (overflow from extreme inputs), IndicatorInputError is thrown.
// Status: v1 matched TradingView built-in values on BINANCE:BTCUSDT 1h, last 20 closed bars,
// 2026-10-14. v2 produces bit-identical results to v1 on that data (see SPEC.md).
export class IndicatorInputError extends RangeError {
    constructor(message) {
        super(message);
        this.name = "IndicatorInputError";
    }
}
export const MAX_ROUND_DECIMALS = 12;
const describe = (v) => typeof v === "number" ? String(v) : v === null ? "null" : v === undefined ? "undefined" : `${typeof v} ${JSON.stringify(v)}`;
/** Throws unless `length` is a safe integer >= 1. */
export function assertPeriod(fn, name, length) {
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1) {
        throw new IndicatorInputError(`${fn}: ${name} must be an integer >= 1, got ${describe(length)}`);
    }
}
/** Throws unless `src` is an array whose every element is a finite number. */
export function assertFiniteSeries(fn, src) {
    if (!Array.isArray(src))
        throw new IndicatorInputError(`${fn}: source must be an array, got ${describe(src)}`);
    for (let i = 0; i < src.length; i++) {
        const v = src[i];
        if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new IndicatorInputError(`${fn}: source[${i}] must be a finite number, got ${describe(v)}`);
        }
    }
}
function assertFiniteIntermediate(fn, what, values) {
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v !== null && !Number.isFinite(v)) {
            throw new IndicatorInputError(`${fn}: intermediate ${what}[${i}] is not finite (${v}); input values are too large`);
        }
    }
    return values;
}
function assertFiniteOutput(fn, out) {
    for (let i = 0; i < out.length; i++) {
        const v = out[i];
        if (v !== null && !Number.isFinite(v)) {
            throw new IndicatorInputError(`${fn}: result[${i}] is not finite (${v}); input values are too large`);
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Internal helpers. They accept a series whose nulls form a LEADING prefix only
// (the warm-up of an upstream calculation, e.g. the MACD line). A null after the
// first number is a programming error and throws.
// The arithmetic (operation order) is kept identical to v1 so results are bit-identical.
// ---------------------------------------------------------------------------
function assertLeadingNullsOnly(fn, src) {
    let seenNumber = false;
    for (let i = 0; i < src.length; i++) {
        if (src[i] === null) {
            if (seenNumber)
                throw new Error(`${fn}: internal series has a gap at ${i} (only leading nulls are allowed)`);
        }
        else
            seenNumber = true;
    }
}
function smaInternal(src, length) {
    const out = new Array(src.length).fill(null);
    for (let i = length - 1; i < src.length; i++) {
        let sum = 0;
        let ok = true;
        for (let j = i - length + 1; j <= i; j++) {
            const v = src[j];
            if (v === null) {
                ok = false;
                break;
            }
            sum += v;
        }
        out[i] = ok ? sum / length : null;
    }
    return out;
}
/** Exponential smoothing seeded with the SMA of the first `length` available values. */
function seededSmoothingInternal(src, length, alpha) {
    const out = new Array(src.length).fill(null);
    const seed = smaInternal(src, length);
    let prev = null;
    for (let i = 0; i < src.length; i++) {
        const v = src[i];
        if (prev === null) {
            if (seed[i] !== null)
                prev = seed[i];
        }
        else {
            prev = alpha * v + (1 - alpha) * prev; // v is non-null here: nulls are leading only
        }
        out[i] = prev;
    }
    return out;
}
const emaInternal = (src, length) => seededSmoothingInternal(src, length, 2 / (length + 1));
const rmaInternal = (src, length) => seededSmoothingInternal(src, length, 1 / length);
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/** Simple moving average. First value at index length-1. */
export function sma(src, length) {
    assertFiniteSeries("sma", src);
    assertPeriod("sma", "length", length);
    return assertFiniteOutput("sma", smaInternal(src, length));
}
/** EMA: alpha = 2/(length+1); first value = SMA of the first `length` values (index length-1).
 *  The SMA seed is this implementation's choice; TradingView's seed is NOT verified (SPEC.md). */
export function ema(src, length) {
    assertFiniteSeries("ema", src);
    assertPeriod("ema", "length", length);
    return assertFiniteOutput("ema", emaInternal(src, length));
}
/** Wilder's smoothing (RMA): alpha = 1/length, SMA seed. First value at index length-1. */
export function rma(src, length) {
    assertFiniteSeries("rma", src);
    assertPeriod("rma", "length", length);
    return assertFiniteOutput("rma", rmaInternal(src, length));
}
/**
 * RSI as in TradingView's built-in "Relative Strength Index" script:
 *   up = rma(max(change, 0)), down = rma(-min(change, 0))
 *   rsi = down == 0 ? 100 : up == 0 ? 0 : 100 - 100 / (1 + up / down)
 * change is undefined at index 0, so the first RSI value is at index `length`.
 * A completely flat window therefore gives 100 (down == 0), following that formula.
 */
export function rsi(src, length = 14) {
    assertFiniteSeries("rsi", src);
    assertPeriod("rsi", "length", length);
    // A price change can overflow even when both prices are finite (1e308 - (-1e308)). Math.max would
    // then hide it (max(-Infinity, 0) = 0) and the final ratio could still look finite, so every
    // intermediate is checked explicitly.
    for (let i = 1; i < src.length; i++) {
        const change = src[i] - src[i - 1];
        if (!Number.isFinite(change)) {
            throw new IndicatorInputError(`rsi: price change at [${i}] is not finite (${change}); input values are too large`);
        }
    }
    const gains = src.map((v, i) => (i > 0 ? Math.max(v - src[i - 1], 0) : null));
    const losses = src.map((v, i) => (i > 0 ? Math.max(src[i - 1] - v, 0) : null));
    const up = assertFiniteIntermediate("rsi", "up (RMA of gains)", rmaInternal(gains, length));
    const down = assertFiniteIntermediate("rsi", "down (RMA of losses)", rmaInternal(losses, length));
    const out = src.map((_, i) => {
        const u = up[i];
        const d = down[i];
        if (u === null || d === null)
            return null;
        if (d === 0)
            return 100;
        if (u === 0)
            return 0;
        // u and d are finite here. u / d may still overflow to Infinity when d is tiny; then
        // 100 - 100 / (1 + Infinity) = 100, which is the correctly rounded value of the exact result,
        // so that case is allowed on purpose.
        return 100 - 100 / (1 + u / d);
    });
    return assertFiniteOutput("rsi", out);
}
/** MACD: line = ema(fast) - ema(slow); signal = ema(line, signal); histogram = line - signal.
 *  First line value at index max(fast, slow) - 1; first signal at max(fast, slow) + signal - 2.
 *  fast >= slow is allowed (no ordering is imposed). */
export function macd(src, fast = 12, slow = 26, signalLength = 9) {
    assertFiniteSeries("macd", src);
    assertPeriod("macd", "fast", fast);
    assertPeriod("macd", "slow", slow);
    assertPeriod("macd", "signal", signalLength);
    const f = emaInternal(src, fast);
    const s = emaInternal(src, slow);
    const line = src.map((_, i) => (f[i] !== null && s[i] !== null ? f[i] - s[i] : null));
    assertLeadingNullsOnly("macd", line);
    const signal = emaInternal(line, signalLength);
    const histogram = line.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i] : null));
    return {
        macd: assertFiniteOutput("macd.macd", line),
        signal: assertFiniteOutput("macd.signal", signal),
        histogram: assertFiniteOutput("macd.histogram", histogram),
    };
}
/** Population standard deviation (divide by n), as Pine's ta.stdev default (biased = true). */
export function stdev(src, length) {
    assertFiniteSeries("stdev", src);
    assertPeriod("stdev", "length", length);
    const mean = smaInternal(src, length);
    const out = src.map((_, i) => {
        const m = mean[i];
        if (m === null)
            return null;
        let sq = 0;
        for (let j = i - length + 1; j <= i; j++) {
            const d = src[j] - m;
            sq += d * d;
        }
        return Math.sqrt(sq / length);
    });
    return assertFiniteOutput("stdev", out);
}
/** Bollinger Bands: basis = sma, bands = basis ± mult * stdev (population). mult: finite, > 0. */
export function bollinger(src, length = 20, mult = 2) {
    assertFiniteSeries("bollinger", src);
    assertPeriod("bollinger", "length", length);
    if (typeof mult !== "number" || !Number.isFinite(mult) || mult <= 0) {
        throw new IndicatorInputError(`bollinger: mult must be a finite number > 0, got ${describe(mult)}`);
    }
    const basis = smaInternal(src, length);
    const dev = stdev(src, length);
    const upper = basis.map((b, i) => (b !== null && dev[i] !== null ? b + mult * dev[i] : null));
    const lower = basis.map((b, i) => (b !== null && dev[i] !== null ? b - mult * dev[i] : null));
    return {
        basis: assertFiniteOutput("bollinger.basis", basis),
        upper: assertFiniteOutput("bollinger.upper", upper),
        lower: assertFiniteOutput("bollinger.lower", lower),
    };
}
function assertCandles(fn, candles, field) {
    if (!Array.isArray(candles))
        throw new IndicatorInputError(`${fn}: candles must be an array, got ${describe(candles)}`);
    // Index loop on purpose: Array.prototype.forEach/map skip holes (new Array(1)), which would let
    // an empty slot through unchecked.
    for (let i = 0; i < candles.length; i++) {
        if (!(i in candles))
            throw new IndicatorInputError(`${fn}: candles[${i}] is an empty slot (sparse array)`);
        const c = candles[i];
        const v = c === null || typeof c !== "object" ? undefined : c[field];
        if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new IndicatorInputError(`${fn}: candles[${i}].${field} must be a finite number, got ${describe(v)}`);
        }
    }
}
/** Volume as-is. Rejects non-finite volumes. */
export function volume(candles) {
    assertCandles("volume", candles, "volume");
    return candles.map((c) => c.volume);
}
/** Close prices. Rejects non-finite closes. */
export function closes(candles) {
    assertCandles("closes", candles, "close");
    return candles.map((c) => c.close);
}
/**
 * Round for display comparison.
 *  - Rule: round half AWAY FROM ZERO on the shortest decimal representation of the number
 *    (the digits JavaScript prints, e.g. "0.44999999999999996"). The rounding decision is made on
 *    those decimal DIGITS; the number is never shifted through an intermediate double, so
 *    0.44999999999999996 -> 0.4 (not 0.5), 1.005 -> 1.01, -1.005 -> -1.01, -2.5 -> -3 (0 decimals).
 *  - Numbers that already have no more than `decimals` fractional digits are returned unchanged
 *    (e.g. 1e308 at 12 decimals), so the result is always finite.
 *  - null passes through (warm-up values). Non-finite numbers and non-numbers throw.
 *  - decimals: integer 0..12. -0 is returned as 0.
 *  - Whether TradingView's on-screen rounding uses the same tie rule is NOT verified.
 */
export function roundTo(v, decimals) {
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ROUND_DECIMALS) {
        throw new IndicatorInputError(`roundTo: decimals must be an integer 0..${MAX_ROUND_DECIMALS}, got ${describe(decimals)}`);
    }
    if (v === null)
        return null;
    if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new IndicatorInputError(`roundTo: value must be a finite number or null, got ${describe(v)}`);
    }
    if (v === 0)
        return 0; // also normalises -0
    // Shortest round-trip decimal form: digits d0.d1d2... x 10^exp
    const [mant, expText] = Math.abs(v).toExponential().split("e");
    const digits = mant.replace(".", "");
    const exp = Number(expText);
    // number of digits (counted from the first significant digit) that stay after rounding
    const keep = exp + 1 + decimals;
    if (keep >= digits.length)
        return v; // already has <= `decimals` fractional digits: nothing to round
    let kept;
    if (keep < 0)
        kept = 0n; // value < 10^-(decimals+1): rounds to 0
    else {
        kept = keep === 0 ? 0n : BigInt(digits.slice(0, keep));
        if (digits.charCodeAt(keep) >= 53 /* '5' */)
            kept += 1n; // half (and above) away from zero
    }
    if (kept === 0n)
        return 0;
    const out = Number(`${v < 0 ? "-" : ""}${kept}e${-decimals}`); // one correctly rounded conversion
    if (!Number.isFinite(out))
        throw new IndicatorInputError(`roundTo: result is not finite for ${v}`);
    return out === 0 ? 0 : out;
}
