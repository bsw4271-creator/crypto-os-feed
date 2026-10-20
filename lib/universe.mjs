// Automatic symbol selection by a fixed rule, done once BEFORE the paper-trading start so no later data can leak in.
// Rule (recorded with the result):
//   candidates  Binance spot, status TRADING, quote USDT
//   excluded    stablecoins and fiat (list), assets pegged to another asset (list), listed < minListingDays,
//               price nearly fixed (coefficient of variation of the last 30 daily closes < 1 %: catches unlisted stables)
//   ranked by   average daily quote volume (USDT) over the last 30 closed days before the start
//   picked      top N, ties by symbol name. Fixed for the whole run.
// The 24h ticker is used only to shortlist the most traded symbols before downloading their daily candles.
import { getJson } from './fetch.mjs';

const DAY = 86400000;
const API = 'https://data-api.binance.vision/api/v3';
export const STABLE = ['USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDE', 'PYUSD', 'USD1', 'RLUSD', 'BFUSD', 'USDS', 'FRAX', 'XUSD', 'EUR', 'EURI', 'AEUR', 'GBP', 'AUD', 'BRL', 'TRY', 'JPY'];
export const PEGGED = ['WBTC', 'WBETH', 'BETH', 'BNSOL', 'STETH', 'WSTETH', 'CBBTC', 'PAXG', 'XAUT'];
export const DEFAULT_RULE = { top: 10, lookbackDays: 30, minListingDays: 365, shortlist: 40, minCv: 0.01 };

export class UniverseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UniverseError';
  }
}

/**
 * Select symbols.
 * - Initial selection: `start` is the paper-trading start (ms); only daily candles that closed before both `start` and
 *   `now` are used, and it refuses to run at or after the start.
 * - Reselection: pass `asOf` (a past or present time); only daily candles that closed before `asOf` are used.
 *   (The 24h ticker that shortlists candidates is necessarily the current one; it only narrows the field.)
 * Returns { selectedAt, asOf, start, rule, selected: [symbols], table: [per candidate metrics and decision] }.
 */
export async function selectUniverse({ start, now, asOf = null, rule = {}, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const R = { ...DEFAULT_RULE, ...rule };
  if (asOf === null && !(now < start)) throw new UniverseError('selection must run before the start time (no data after the start may be used)');
  if (asOf !== null && !(asOf <= now)) throw new UniverseError('asOf is in the future');
  const opt = { fetchImpl, sleep };
  const cutoff = asOf ?? Math.min(now, start);
  const info = await getJson(`${API}/exchangeInfo?permissions=SPOT`, opt);
  if (!info || !Array.isArray(info.symbols)) throw new UniverseError('unexpected exchangeInfo response');
  const skip = new Set([...STABLE, ...PEGGED]);
  const table = [];
  const usdt = info.symbols.filter((s) => s && s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed !== false);
  for (const s of usdt) if (skip.has(s.baseAsset)) table.push({ symbol: s.symbol, decision: STABLE.includes(s.baseAsset) ? 'excluded: stablecoin/fiat' : 'excluded: pegged asset' });
  const eligible = new Set(usdt.filter((s) => !skip.has(s.baseAsset)).map((s) => s.symbol));
  const tickers = await getJson(`${API}/ticker/24hr`, opt);
  if (!Array.isArray(tickers)) throw new UniverseError('unexpected ticker response');
  const shortlist = tickers
    .filter((t) => eligible.has(t.symbol) && Number.isFinite(Number(t.quoteVolume)))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume) || a.symbol.localeCompare(b.symbol))
    .slice(0, R.shortlist)
    .map((t) => t.symbol);
  const ranked = [];
  for (const symbol of shortlist) {
    await sleep(200);
    const rows = await getJson(`${API}/klines?symbol=${symbol}&interval=1d&endTime=${cutoff - 1}&limit=${R.minListingDays + 35}`, opt);
    if (!Array.isArray(rows)) throw new UniverseError(`unexpected klines response for ${symbol}`);
    const days = rows.filter((r) => Array.isArray(r) && Number(r[6]) < cutoff);
    const row = { symbol, listedDays: days.length };
    if (days.length < R.minListingDays + 1) {
      table.push({ ...row, decision: `excluded: listed ${days.length} days (< ${R.minListingDays})` });
      continue;
    }
    const last = days.slice(-R.lookbackDays);
    const closes = last.map((r) => Number(r[4])),
      vols = last.map((r) => Number(r[7]));
    if (![...closes, ...vols].every(Number.isFinite)) throw new UniverseError(`malformed daily candles for ${symbol}`);
    const mean = closes.reduce((a, x) => a + x, 0) / closes.length;
    const cv = Math.sqrt(closes.reduce((a, x) => a + (x - mean) ** 2, 0) / closes.length) / mean;
    row.avgQuoteVolume = vols.reduce((a, x) => a + x, 0) / vols.length;
    row.cv = cv;
    if (cv < R.minCv) {
      table.push({ ...row, decision: `excluded: price nearly fixed (cv ${(cv * 100).toFixed(2)}%)` });
      continue;
    }
    ranked.push(row);
  }
  ranked.sort((a, b) => b.avgQuoteVolume - a.avgQuoteVolume || a.symbol.localeCompare(b.symbol));
  if (ranked.length < R.top) throw new UniverseError(`only ${ranked.length} symbols qualify (need ${R.top})`);
  ranked.forEach((r, i) => table.push({ ...r, rank: i + 1, decision: i < R.top ? 'selected' : 'not in top' }));
  return { selectedAt: now, asOf: cutoff, start, rule: { ...R, stable: STABLE, pegged: PEGGED }, selected: ranked.slice(0, R.top).map((r) => r.symbol), table };
}
