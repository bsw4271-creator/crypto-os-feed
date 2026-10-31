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
      oracle: num(ctx?.oraclePx),
      funding_1h: num(ctx?.funding),
      open_interest: num(ctx?.openInterest),
      day_volume_usd: num(ctx?.dayNtlVlm),
      max_leverage: num(u.maxLeverage),
    });
  });
  return out;
}

/** The Hyperliquid block for one feed symbol. `price` is the Binance close used in the feed. */
export function hyperliquidFor(symbol, price, spot, perp, perpName = symbol.replace(/USDT$/, '')) {
  const baseName = SPOT_BASE[symbol] ?? null;
  const s = baseName && spot ? spot.get(baseName) ?? null : null;
  const p = perp ? perp.get(perpName) ?? null : null;
  return {
    spot: s ? { ...s, gap_vs_binance_pct: gap(s.mid ?? s.mark, price) } : null,
    perp: p ? { ...p, gap_vs_binance_pct: gap(p.mid ?? p.mark, price) } : null,
  };
}

/**
 * Auto list: the most traded Hyperliquid perps by 24h notional volume, skipping names already in the fixed list.
 * Re-picked every run. Delisted perps are already left out by parsePerp.
 */
export function autoPerps(perp, excludeNames = [], n = 10) {
  if (!perp) return [];
  const skip = new Set(excludeNames);
  return [...perp.values()]
    .filter((p) => !skip.has(p.name) && Number.isFinite(p.day_volume_usd) && p.day_volume_usd > 0)
    .sort((a, b) => b.day_volume_usd - a.day_volume_usd || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((p) => p.name);
}

/** HL 선물 이름 → 바이낸스 기준 자산 이름. kPEPE처럼 앞의 k는 1000배 단위 표시라 뗀다. */
export function binanceBase(name) {
  return /^k[A-Z0-9]/.test(name) ? name.slice(1) : name;
}

/**
 * Every tradable perp in one compact list, most traded first.
 * binance: 바이낸스에 상장된 기준 자산 이름 Set (없으면 확인 못 함 → binance_listed null)
 */
export function allPerps(perp, inFeed = new Set(), binance = null) {
  if (!perp) return [];
  return [...perp.values()]
    .map((p) => ({
      name: p.name,
      mark: p.mark,
      oracle_px: p.oracle ?? null,
      // 규칙서 §2-4: HL 가격(중간값, 없으면 마크)과 HL 오라클 가격 차이
      mark_vs_oracle_pct: gap(p.mid ?? p.mark, p.oracle),
      funding_1h: p.funding_1h,
      funding_annual_pct: Number.isFinite(p.funding_1h) ? Math.round(p.funding_1h * 24 * 365 * 10000) / 100 : null,
      binance_listed: binance ? binance.has(binanceBase(p.name)) : null,
      open_interest_usd: p.open_interest !== null && p.mark !== null ? Math.round(p.open_interest * p.mark) : null,
      day_volume_usd: p.day_volume_usd !== null ? Math.round(p.day_volume_usd) : null,
      max_leverage: p.max_leverage,
      in_feed_symbols: inFeed.has(p.name),
    }))
    .sort((a, b) => (b.day_volume_usd ?? 0) - (a.day_volume_usd ?? 0) || a.name.localeCompare(b.name));
}

/** Hyperliquid candleSnapshot rows -> Binance-style kline arrays (what parseKlines checks). */
export function candlesToKlines(raw) {
  if (!Array.isArray(raw)) throw new Error('unexpected candleSnapshot shape');
  return raw.map((c) => {
    if (!c || !Number.isFinite(Number(c.t))) throw new Error('unexpected candleSnapshot row');
    const t = Number(c.t);
    return [t, c.o, c.h, c.l, c.c, c.v, t + 3600000 - 1];
  });
}

export async function fetchCandles(coin, startTime, endTime, fetchImpl = globalThis.fetch) {
  return candlesToKlines(await post({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime, endTime } }, fetchImpl));
}

export async function post(body, fetchImpl) {
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
