// Hyperliquid market data for the feed: which spot pair and which perp match each Binance symbol, their prices and
// the gap to the Binance price. Public info API only (no account, no signing). Pure parsing is separate from fetching.

export const INFO_URL = 'https://api.hyperliquid.xyz/info';

/**
 * Binance symbol -> Hyperliquid spot base token name. Only assets with a known spot token on Hyperliquid:
 * HYPE is native; uBTC/uETH/uSOL are Unit's bridged tokens. Names alone are not trusted: the feed reports the
 * tokenId seen on Hyperliquid, and rules.md pins the expected tokenId once the owner has checked it.
 */
export const SPOT_BASE = { BTCUSDT: 'UBTC', ETHUSDT: 'UETH', SOLUSDT: 'USOL', HYPEUSDT: 'HYPE' };

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const gap = (a, b) => (a !== null && b !== null && b !== 0 ? Number((((a - b) / b) * 100).toFixed(3)) : null);

/** Index spot data: base token name -> { coin, pair, token, token_id, mid, mark, day_volume_usd }. */
export function parseSpot(raw) {
  if (!Array.isArray(raw) || raw.length !== 2 || !raw[0] || !Array.isArray(raw[0].tokens) || !Array.isArray(raw[0].universe) || !Array.isArray(raw[1]))
    throw new Error('unexpected spotMetaAndAssetCtxs shape');
  const [meta, ctxs] = raw;
  const tokenByIndex = new Map(meta.tokens.map((t) => [t.index, t]));
  const out = new Map();
  meta.universe.forEach((u, i) => {
    if (!Array.isArray(u.tokens) || u.tokens.length !== 2) return;
    const base = tokenByIndex.get(u.tokens[0]),
      quote = tokenByIndex.get(u.tokens[1]);
    if (!base || !quote || quote.name !== 'USDC') return;
    const ctx = ctxs.find((c) => c && c.coin === u.name) ?? ctxs[u.index ?? i] ?? null;
    const entry = {
      coin: u.name, // what an order uses, e.g. "@142" or "PURR/USDC"
      pair: `${base.name}/USDC`,
      token: base.name,
      token_id: base.tokenId ?? null,
      mid: num(ctx?.midPx),
      mark: num(ctx?.markPx),
      day_volume_usd: num(ctx?.dayNtlVlm),
    };
    // Several pairs can carry the same base name only if names repeat; keep the most traded one and say so.
    const prev = out.get(base.name);
    if (!prev || (entry.day_volume_usd ?? 0) > (prev.day_volume_usd ?? 0)) out.set(base.name, { ...entry, duplicates: prev ? (prev.duplicates ?? 0) + 1 : 0 });
    else prev.duplicates = (prev.duplicates ?? 0) + 1;
  });
  return out;
}

/** Index perp data: name -> { name, mark, mid, funding_1h, open_interest, day_volume_usd, max_leverage }. */
export function parsePerp(raw) {
  if (!Array.isArray(raw) || raw.length !== 2 || !raw[0] || !Array.isArray(raw[0].universe) || !Array.isArray(raw[1]))
    throw new Error('unexpected metaAndAssetCtxs shape');
  const [meta, ctxs] = raw;
  const out = new Map();
  meta.universe.forEach((u, i) => {
    if (!u || typeof u.name !== 'string' || u.isDelisted) return;
    const ctx = ctxs[i] ?? null;
    out.set(u.name, {
      name: u.name,
      mark: num(ctx?.markPx),
      mid: num(ctx?.midPx),
      funding_1h: num(ctx?.funding),
      open_interest: num(ctx?.openInterest),
      day_volume_usd: num(ctx?.dayNtlVlm),
      max_leverage: num(u.maxLeverage),
    });
  });
  return out;
}

/** The Hyperliquid block for one feed symbol. `price` is the Binance close used in the feed. */
export function hyperliquidFor(symbol, price, spot, perp) {
  const baseName = SPOT_BASE[symbol] ?? null;
  const s = baseName && spot ? spot.get(baseName) ?? null : null;
  const perpName = symbol.replace(/USDT$/, '');
  const p = perp ? perp.get(perpName) ?? null : null;
  return {
    spot: s ? { ...s, gap_vs_binance_pct: gap(s.mid ?? s.mark, price) } : null,
    perp: p ? { ...p, gap_vs_binance_pct: gap(p.mid ?? p.mark, price) } : null,
  };
}

async function post(body, fetchImpl) {
  const res = await fetchImpl(INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Hyperliquid`);
  return res.json();
}

/** Fetch both markets. Each half fails on its own; errors are reported, never thrown. */
export async function fetchHyperliquid(fetchImpl = globalThis.fetch) {
  const result = { spot: null, perp: null, errors: [] };
  try {
    result.spot = parseSpot(await post({ type: 'spotMetaAndAssetCtxs' }, fetchImpl));
  } catch (e) {
    result.errors.push(`spot: ${e?.message ?? e}`);
  }
  try {
    result.perp = parsePerp(await post({ type: 'metaAndAssetCtxs' }, fetchImpl));
  } catch (e) {
    result.errors.push(`perp: ${e?.message ?? e}`);
  }
  return result;
}
