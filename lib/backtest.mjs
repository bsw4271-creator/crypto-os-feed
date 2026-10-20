// Generated from crypto-investment-os lib/backtest.ts (sha256 9938f75155a7cb02…, branch claude/backtest-engine-20261018 c2d66ce).
// Type annotations removed only; logic unchanged. Edit the source in Crypto OS first, then regenerate.
// Backtest engine, stage 1: simulation only. No orders, no exchange keys, no network, no DB.
// Execution model rebuilt from the documented behaviour of Freqtrade (signal shift, next-open entry, stop gap handling)
// and Jesse (gap-crossed orders, intrabar order sequence). No code was copied; see docs/backtest.md.
//
// Rules (all deterministic):
//  1. A signal is evaluated on a CLOSED bar i and executed at the OPEN of bar i+1. Bar i's own data never trades on bar i.
//  2. At each bar open, a pending exit or entry fills first. Then stop-loss / take-profit are checked against the bar's
//     low/high, including on the entry bar (the entry happened at its open).
//  3. Gaps: if the bar opens at or beyond the stop (or the target), the fill is the open price, not the level.
//  4. Stop and target inside the same bar: the order inside an hourly bar is unknown, so the stop is assumed first (worst case).
//  5. Costs: fee on every fill; slippage against us on market fills (entry, signal exit, stop). The take-profit is a resting
//     limit, so no slippage.
//  6. Spot, long only, no leverage, one position at a time. A position still open on the last bar is closed at the last
//     close (reason end_of_data) so the numbers are complete; it is flagged.
// Analysis reference only, not a trading signal.
import { bollinger, ema, macd, rsi, sma } from './indicators.mjs';
import { INDICATOR_SETTINGS } from './indicator-view.mjs';
export class BacktestInputError extends RangeError {
    constructor(message) {
        super(message);
        this.name = 'BacktestInputError';
    }
}
export const DEFAULT_PARAMS = {
    initialCapital: 10000,
    feeRate: 0.001,
    slippage: 0.0005,
    positionFraction: 1,
};
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
function checkParams(p) {
    if (!finite(p.initialCapital) || p.initialCapital <= 0)
        throw new BacktestInputError('initialCapital must be > 0');
    if (!finite(p.feeRate) || p.feeRate < 0 || p.feeRate >= 0.1)
        throw new BacktestInputError('feeRate must be in [0, 0.1)');
    if (!finite(p.slippage) || p.slippage < 0 || p.slippage >= 0.1)
        throw new BacktestInputError('slippage must be in [0, 0.1)');
    if (!finite(p.positionFraction) || p.positionFraction <= 0 || p.positionFraction > 1)
        throw new BacktestInputError('positionFraction must be in (0, 1]');
}
function checkBars(bars) {
    if (!Array.isArray(bars) || bars.length < 2)
        throw new BacktestInputError('need at least 2 bars');
    bars.forEach((b, i) => {
        if (![b.t, b.o, b.h, b.l, b.c, b.v].every(finite))
            throw new BacktestInputError(`bar ${i}: non-finite value`);
        if (b.o <= 0 || b.l <= 0 || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c))
            throw new BacktestInputError(`bar ${i}: inconsistent OHLC`);
        if (i > 0 && b.t <= bars[i - 1].t)
            throw new BacktestInputError(`bar ${i}: time not ascending`);
    });
}
function checkStrategy(s) {
    if (!s || !Array.isArray(s.entry) || !s.entry.length)
        throw new BacktestInputError('entry needs at least one condition');
    if (!Array.isArray(s.exit))
        throw new BacktestInputError('exit must be an array');
    if (s.stopLoss !== undefined && (!finite(s.stopLoss) || s.stopLoss <= 0 || s.stopLoss >= 1))
        throw new BacktestInputError('stopLoss must be in (0, 1)');
    if (s.takeProfit !== undefined && (!finite(s.takeProfit) || s.takeProfit <= 0))
        throw new BacktestInputError('takeProfit must be > 0');
    if (!s.exit.length && s.stopLoss === undefined && s.takeProfit === undefined)
        throw new BacktestInputError('set an exit condition, a stop-loss or a take-profit');
    for (const c of [...s.entry, ...s.exit]) {
        if (c.kind.startsWith('rsi_')) {
            const level = c.level;
            if (!finite(level) || level <= 0 || level >= 100)
                throw new BacktestInputError(`${c.kind}: level must be in (0, 100)`);
        }
        else if (![
            'macd_cross_up',
            'macd_cross_down',
            'close_below_bb_lower',
            'close_above_bb_upper',
            'ema_cross_sma_up',
            'ema_cross_sma_down',
        ].includes(c.kind))
            throw new BacktestInputError(`unknown condition: ${String(c.kind)}`);
    }
}
function lines(bars) {
    const close = bars.map((b) => b.c);
    const S = INDICATOR_SETTINGS;
    const m = macd(close, S.macd.fast, S.macd.slow, S.macd.signal);
    const bb = bollinger(close, S.bollinger.length, S.bollinger.mult);
    return {
        close,
        rsi: rsi(close, S.rsi),
        macd: m.macd,
        signal: m.signal,
        upper: bb.upper,
        lower: bb.lower,
        ema: ema(close, S.ema),
        sma: sma(close, S.sma),
    };
}
const crossUp = (a, b, i) => {
    const b0 = typeof b === 'number' ? b : b[i - 1], b1 = typeof b === 'number' ? b : b[i];
    const a0 = a[i - 1], a1 = a[i];
    return a0 !== null && a1 !== null && b0 !== null && b1 !== null && a0 <= b0 && a1 > b1;
};
const crossDown = (a, b, i) => {
    const b0 = typeof b === 'number' ? b : b[i - 1], b1 = typeof b === 'number' ? b : b[i];
    const a0 = a[i - 1], a1 = a[i];
    return a0 !== null && a1 !== null && b0 !== null && b1 !== null && a0 >= b0 && a1 < b1;
};
function holds(c, L, i) {
    if (i < 1)
        return false;
    switch (c.kind) {
        case 'rsi_below':
            return L.rsi[i] !== null && L.rsi[i] < c.level;
        case 'rsi_above':
            return L.rsi[i] !== null && L.rsi[i] > c.level;
        case 'rsi_cross_up':
            return crossUp(L.rsi, c.level, i);
        case 'rsi_cross_down':
            return crossDown(L.rsi, c.level, i);
        case 'macd_cross_up':
            return crossUp(L.macd, L.signal, i);
        case 'macd_cross_down':
            return crossDown(L.macd, L.signal, i);
        case 'close_below_bb_lower':
            return L.lower[i] !== null && L.close[i] < L.lower[i];
        case 'close_above_bb_upper':
            return L.upper[i] !== null && L.close[i] > L.upper[i];
        case 'ema_cross_sma_up':
            return crossUp(L.ema, L.sma, i);
        case 'ema_cross_sma_down':
            return crossDown(L.ema, L.sma, i);
    }
}
/** First bar index on which every indicator line (and its previous value, for crosses) exists. */
function firstReady(L) {
    const all = [L.rsi, L.macd, L.signal, L.upper, L.lower, L.ema, L.sma];
    for (let i = 1; i < L.close.length; i++)
        if (all.every((s) => s[i - 1] !== null && s[i] !== null))
            return i;
    return -1;
}
/** Entry/exit signals per closed bar, from strategy conditions. Signals before the warm-up are false. */
export function strategySignals(bars, s) {
    checkBars(bars);
    checkStrategy(s);
    const L = lines(bars);
    const start = firstReady(L);
    if (start < 0)
        throw new BacktestInputError('not enough bars for indicator warm-up');
    const entry = bars.map((_, i) => i >= start && s.entry.every((c) => holds(c, L, i)));
    const exit = bars.map((_, i) => i >= start && s.exit.length > 0 && s.exit.every((c) => holds(c, L, i)));
    return { start, entry, exit };
}
/**
 * Execution core. entry[i]/exit[i] are signals on CLOSED bar i; they fill at the open of bar i+1.
 * `start` is the first bar of the evaluated window (equity curve and buy-and-hold begin there).
 */
export function simulate(bars, entry, exit, risk = {}, params = DEFAULT_PARAMS, start = 0) {
    checkBars(bars);
    checkParams(params);
    if (entry.length !== bars.length || exit.length !== bars.length)
        throw new BacktestInputError('signal length must equal bar count');
    if (!Number.isSafeInteger(start) || start < 0 || start >= bars.length - 1)
        throw new BacktestInputError('start out of range');
    const { feeRate: fee, slippage: slip } = params;
    let cash = params.initialCapital;
    let pos = null;
    const trades = [];
    const equity = [];
    let inBars = 0, totalFees = 0;
    const close = (i, price, reason) => {
        const p = pos;
        const gross = p.qty * price, f = gross * fee, proceeds = gross - f;
        totalFees += f;
        cash += proceeds;
        const pnl = proceeds - p.cost;
        trades.push({
            entryTime: bars[p.i].t,
            entryPrice: p.entryPrice,
            exitTime: bars[i].t,
            exitPrice: price,
            reason,
            qty: p.qty,
            cost: p.cost,
            proceeds,
            fees: p.fees + f,
            pnl,
            returnPct: (pnl / p.cost) * 100,
            bars: i - p.i + 1,
        });
        pos = null;
    };
    for (let i = start; i < bars.length; i++) {
        const b = bars[i];
        // 1. Fills at the open, from the previous closed bar's signals.
        if (i > start) {
            if (pos && exit[i - 1])
                close(i, b.o * (1 - slip), 'signal');
            else if (!pos && entry[i - 1]) {
                const price = b.o * (1 + slip);
                const budget = cash * params.positionFraction;
                const qty = budget / (price * (1 + fee));
                const f = qty * price * fee;
                totalFees += f;
                cash -= budget;
                pos = {
                    qty,
                    entryPrice: price,
                    cost: budget,
                    fees: f,
                    i,
                    stop: risk.stopLoss === undefined ? null : price * (1 - risk.stopLoss),
                    target: risk.takeProfit === undefined ? null : price * (1 + risk.takeProfit),
                };
            }
        }
        // 2. Stop-loss / take-profit inside the bar. Stop first when both are reachable (worst case).
        if (pos) {
            const { stop, target } = pos;
            if (stop !== null && b.l <= stop)
                close(i, Math.min(b.o, stop) * (1 - slip), 'stop_loss');
            else if (target !== null && b.h >= target)
                close(i, Math.max(b.o, target), 'take_profit');
        }
        if (pos)
            inBars++;
        // 3. End of data: close what is still open at the last close.
        if (pos && i === bars.length - 1)
            close(i, b.c * (1 - slip), 'end_of_data');
        equity.push({ t: b.t, equity: cash + (pos ? pos.qty * b.c : 0) });
    }
    const endedOpen = trades.length > 0 && trades[trades.length - 1].reason === 'end_of_data';
    let peak = -Infinity, mdd = 0;
    for (const e of equity) {
        peak = Math.max(peak, e.equity);
        mdd = Math.max(mdd, (peak - e.equity) / peak);
    }
    const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
    const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
    // Buy and hold over the same window: market buy at the first possible entry open, market sell at the last close.
    const bhIn = bars[start + 1].o * (1 + slip), bhOut = bars[bars.length - 1].c * (1 - slip);
    const bh = ((bhOut * (1 - fee)) / (bhIn * (1 + fee)) - 1) * 100;
    const finalEquity = equity[equity.length - 1].equity;
    return {
        trades,
        equity,
        metrics: {
            startTime: bars[start].t,
            endTime: bars[bars.length - 1].t,
            bars: bars.length - start,
            trades: trades.length,
            wins: wins.length,
            losses: losses.length,
            winRate: trades.length ? (wins.length / trades.length) * 100 : null,
            totalReturnPct: (finalEquity / params.initialCapital - 1) * 100,
            buyAndHoldReturnPct: bh,
            maxDrawdownPct: mdd * 100,
            profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
            avgWinPct: mean(wins.map((t) => t.returnPct)),
            avgLossPct: mean(losses.map((t) => t.returnPct)),
            exposurePct: (inBars / (bars.length - start)) * 100,
            totalFees,
            finalEquity,
            endedOpen,
        },
    };
}
/** Run a strategy over closed bars. */
export function runBacktest(bars, s, params = DEFAULT_PARAMS) {
    const { start, entry, exit } = strategySignals(bars, s);
    if (start >= bars.length - 1)
        throw new BacktestInputError('not enough bars after indicator warm-up');
    return simulate(bars, entry, exit, { stopLoss: s.stopLoss, takeProfit: s.takeProfit }, params, start);
}
