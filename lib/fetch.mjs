// Public 1h candles for one USDT spot market. No API key, read-only.
// Binance public mirror first; on any failure, Gate.io once. Every row passes parseKlines (closed bars only, no gaps).
import { gateToKlines, parseKlines } from './indicator-view.mjs';

const H = 3600000;
export const MAX_DAYS = 365;
const BINANCE = 'https://data-api.binance.vision/api/v3/klines';
const GATE = 'https://api.gateio.ws/api/v4/spot/candlesticks';

export class FetchError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

export function checkSymbol(symbol) {
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,20}USDT$/.test(symbol))
    throw new FetchError(`symbol must look like BTCUSDT, got ${JSON.stringify(symbol)}`);
  return symbol;
}

export const gatePair = (symbol) => checkSymbol(symbol).replace(/USDT$/, '_USDT');

export async function getJson(url, { fetchImpl, sleep }) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
    } catch (e) {
      if (attempt < 2) {
        await sleep(2000);
        continue;
      }
      throw new FetchError(`network error: ${e?.message ?? e}`);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(res.status === 429 ? 10000 : 2000);
      continue;
    }
    throw new FetchError(`HTTP ${res.status} from ${new URL(url).host}`, res.status);
  }
}

async function binanceRows(symbol, start, now, opt) {
  const rows = [];
  for (let s = start; s <= now; ) {
    const page = await getJson(`${BINANCE}?symbol=${symbol}&interval=1h&startTime=${s}&limit=1000`, opt);
    if (!Array.isArray(page)) throw new FetchError('unexpected Binance response');
    if (!page.length) break;
    rows.push(...page);
    s = Number(page.at(-1)[0]) + H;
    if (page.length < 1000) break;
    await opt.sleep(250);
  }
  return rows;
}

async function gateRows(symbol, start, now, opt) {
  const rows = [];
  for (let s = start; s <= now; s += 1000 * H) {
    const to = Math.min(s + 999 * H, now);
    const page = await getJson(
      `${GATE}?currency_pair=${gatePair(symbol)}&interval=1h&from=${s / 1000}&to=${Math.floor(to / 1000)}`,
      opt,
    );
    rows.push(...gateToKlines(page));
    await opt.sleep(250);
  }
  return rows;
}

/**
 * Closed 1h bars for the last `days` days. Returns { bars, venue, fallbackReason, excludedInProgress }.
 * Rejects (throws) on malformed or gapped data instead of repairing it.
 */
export async function fetchBars({
  symbol,
  days,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  checkSymbol(symbol);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) throw new FetchError(`days must be 1..${MAX_DAYS}`);
  const start = Math.floor((now - days * 24 * H) / H) * H;
  const opt = { fetchImpl, sleep };
  let venue = 'Binance',
    fallbackReason = null,
    rows;
  try {
    rows = await binanceRows(symbol, start, now, opt);
    if (!rows.length) throw new FetchError('no Binance data for ' + symbol);
  } catch (e) {
    venue = 'Gate';
    fallbackReason = e.message;
    try {
      rows = await gateRows(symbol, start, now, opt);
    } catch (g) {
      throw new FetchError(`Binance: ${fallbackReason} / Gate: ${g.message}`, g.status ?? null);
    }
    if (!rows.length) throw new FetchError(`no data from Binance (${fallbackReason}) or Gate for ${symbol}`);
  }
  const { rows: bars, excludedInProgress } = parseKlines(rows, now);
  return { bars, venue, fallbackReason, excludedInProgress };
}
