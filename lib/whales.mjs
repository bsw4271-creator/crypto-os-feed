// Money-flow signals, stage 2: large transfers of watched wallets on Ethereum mainnet (Etherscan API V2, free key).
// Counterparties in the exchange list are labelled, so "watched wallet sent X to an exchange" is visible.
// Only well-known token contracts are priced (by contract address, never by symbol, so look-alike tokens are ignored).

export const API = 'https://api.etherscan.io/v2/api';
export const TOKENS = {
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { asset: 'USDT', price: 'USD' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { asset: 'USDC', price: 'USD' },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { asset: 'WETH', price: 'ETHUSDT' },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { asset: 'WBTC', price: 'BTCUSDT' },
};
export const DEFAULT_THRESHOLD_USD = 1_000_000;

const lc = (x) => String(x ?? '').toLowerCase();
const units = (raw, decimals) => {
  const n = Number(raw) / 10 ** Number(decimals);
  return Number.isFinite(n) ? n : null;
};

/**
 * Turns Etherscan rows into large-transfer events for the watched wallets.
 * rows: [{ wallet, kind: 'eth' | 'token', items: [...] }], prices: { ETHUSDT, BTCUSDT } in USD.
 */
export function largeTransfers({ wallets, rows, prices, fromSec, toSec, threshold = DEFAULT_THRESHOLD_USD }) {
  const exchanges = new Map(wallets.exchanges.map((w) => [lc(w.address), w.label]));
  const watched = new Map(wallets.watch.map((w) => [lc(w.address), w.label]));
  const priceOf = (p) => (p === 'USD' ? 1 : Number.isFinite(prices?.[p]) ? prices[p] : null);
  const events = [];
  const seen = new Set();
  for (const { wallet, kind, items } of rows) {
    const self = lc(wallet);
    for (const t of items ?? []) {
      const at = Number(t.timeStamp);
      if (!Number.isFinite(at) || at < fromSec || at > toSec) continue;
      if (t.isError === '1') continue;
      let asset, amount, price;
      if (kind === 'eth') {
        asset = 'ETH';
        amount = units(t.value, 18);
        price = priceOf('ETHUSDT');
      } else {
        const tok = TOKENS[lc(t.contractAddress)];
        if (!tok) continue;
        asset = tok.asset;
        amount = units(t.value, t.tokenDecimal);
        price = priceOf(tok.price);
      }
      if (amount === null || amount <= 0 || price === null) continue;
      const usd = amount * price;
      if (usd < threshold) continue;
      const from = lc(t.from),
        to = lc(t.to);
      if (from !== self && to !== self) continue;
      const out = from === self;
      const other = out ? to : from;
      const key = `${t.hash}:${asset}:${from}:${to}:${t.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const otherExchange = exchanges.get(other) ?? null;
      events.push({
        wallet: watched.get(self) ?? self,
        direction: out ? 'out' : 'in',
        counterparty: other,
        counterparty_label: otherExchange ?? watched.get(other) ?? null,
        kind: otherExchange ? (out ? 'to_exchange' : 'from_exchange') : 'other',
        asset,
        amount: Number(amount.toPrecision(8)),
        usd: Math.round(usd),
        at: new Date(at * 1000).toISOString(),
        tx: t.hash,
      });
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  const sum = (k) => events.filter((e) => e.kind === k).reduce((s, e) => s + e.usd, 0);
  return { transfers: events, to_exchange_usd: sum('to_exchange'), from_exchange_usd: sum('from_exchange') };
}

async function call(params, key, fetchImpl) {
  const url = `${API}?${new URLSearchParams({ chainid: '1', ...params, apikey: key })}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Etherscan`);
  const body = await res.json();
  if (body.status === '1') return body.result;
  if (body.status === '0' && /no (transactions|records) found/i.test(String(body.message))) return [];
  // Never echo the URL (it carries the key); the message and result text are safe.
  throw new Error(`Etherscan: ${String(body.message ?? 'error')} ${typeof body.result === 'string' ? body.result.slice(0, 120) : ''}`.trim());
}

/** Fetch watched wallets' ETH and token transfers between fromSec and toSec. Errors are collected, not thrown. */
export async function fetchWhales({ wallets, prices, fromSec, toSec, key, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), threshold }) {
  const base = { source: 'Etherscan API V2, Ethereum mainnet', window_from: new Date(fromSec * 1000).toISOString(), window_to: new Date(toSec * 1000).toISOString(), threshold_usd: threshold ?? DEFAULT_THRESHOLD_USD, watched: wallets.watch.map((w) => ({ label: w.label, address: w.address })), exchanges_known: wallets.exchanges.length };
  if (!key) return { ...base, transfers: [], to_exchange_usd: 0, from_exchange_usd: 0, errors: ['ETHERSCAN_API_KEY not set'] };
  const errors = [];
  let startblock = '0';
  try {
    startblock = String(await call({ module: 'block', action: 'getblocknobytime', timestamp: String(fromSec), closest: 'before' }, key, fetchImpl));
  } catch (e) {
    errors.push(`block: ${e.message}`);
  }
  const rows = [];
  for (const w of wallets.watch) {
    for (const [kind, action] of [['eth', 'txlist'], ['token', 'tokentx']]) {
      await sleep(400); // stay well under the free plan's per-second limit
      try {
        const items = await call({ module: 'account', action, address: w.address, startblock, endblock: '99999999', sort: 'desc', page: '1', offset: '1000' }, key, fetchImpl);
        rows.push({ wallet: w.address, kind, items });
        if (items.length >= 1000) errors.push(`${w.label} ${kind}: 1000-row page full, older transfers in the window may be missing`);
      } catch (e) {
        errors.push(`${w.label} ${kind}: ${e.message}`);
      }
    }
  }
  return { ...base, ...largeTransfers({ wallets, rows, prices, fromSec, toSec, threshold }), errors };
}
