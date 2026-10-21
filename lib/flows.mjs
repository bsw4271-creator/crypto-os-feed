// Money-flow signals for the feed, stage 1 (no keys):
//  - stablecoin supply (DefiLlama, public): fresh USDT/USDC issuance is often read as new buying power entering crypto
//  - Hyperliquid perp open interest and funding, compared with the previous hourly feed run
// Pure parsing/diffing is separate from fetching so it can be tested offline.

export const STABLES_URL = 'https://stablecoins.llama.fi/stablecoins?includePrices=false';
const TRACKED = ['USDT', 'USDC'];

const usd = (x) => {
  const n = Number(x?.peggedUSD);
  return Number.isFinite(n) ? n : null;
};
const pct = (now, before) => (now !== null && before !== null && before > 0 ? Number((((now - before) / before) * 100).toFixed(3)) : null);
const round = (n) => (n === null ? null : Math.round(n));

/** Totals of USD-pegged stablecoins now and 1 day / 7 days / 30 days ago, plus USDT and USDC on their own. */
export function parseStablecoins(raw) {
  if (!raw || !Array.isArray(raw.peggedAssets)) throw new Error('unexpected stablecoins response');
  const usdAssets = raw.peggedAssets.filter((a) => a && a.pegType === 'peggedUSD');
  if (!usdAssets.length) throw new Error('no USD stablecoins in response');
  const sum = (key) => {
    let total = 0,
      seen = 0;
    for (const a of usdAssets) {
      const v = usd(a[key]);
      if (v !== null) {
        total += v;
        seen++;
      }
    }
    return seen ? total : null;
  };
  const block = (get) => {
    const now = get('circulating'),
      d1 = get('circulatingPrevDay'),
      d7 = get('circulatingPrevWeek'),
      d30 = get('circulatingPrevMonth');
    return {
      supply_usd: round(now),
      change_1d_usd: now !== null && d1 !== null ? round(now - d1) : null,
      change_1d_pct: pct(now, d1),
      change_7d_usd: now !== null && d7 !== null ? round(now - d7) : null,
      change_7d_pct: pct(now, d7),
      change_30d_pct: pct(now, d30),
    };
  };
  const out = { total: block(sum) };
  for (const sym of TRACKED) {
    const a = usdAssets.find((x) => x.symbol === sym);
    out[sym] = a ? block((key) => usd(a[key])) : null;
  }
  return out;
}

export async function fetchStablecoins(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(STABLES_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from DefiLlama stablecoins`);
    return { data: parseStablecoins(await res.json()), error: null };
  } catch (e) {
    return { data: null, error: e?.message ?? String(e) };
  }
}

/** Longest gap to the previous run that still counts as "1h change"; GitHub schedules can run late. */
export const MAX_PREV_AGE_MS = 150 * 60000;

/**
 * Adds open-interest and funding changes to each symbol's Hyperliquid perp block, against the previous feed.
 * OI is compared in coins (not USD) so price moves do not look like new positions.
 */
export function addPerpChanges(symbols, prevFeed, nowMs) {
  const prevAt = Date.parse(prevFeed?.generated_at ?? '');
  const usable = Number.isFinite(prevAt) && nowMs - prevAt > 0 && nowMs - prevAt <= MAX_PREV_AGE_MS;
  const prevBySymbol = new Map((usable ? prevFeed.symbols ?? [] : []).map((s) => [s.symbol, s]));
  for (const s of symbols) {
    const perp = s.hyperliquid?.perp;
    if (!perp) continue;
    const prev = prevBySymbol.get(s.symbol)?.hyperliquid?.perp ?? null;
    perp.open_interest_usd = perp.open_interest !== null && perp.mark !== null ? round(perp.open_interest * perp.mark) : null;
    perp.oi_change_pct = prev ? pct(perp.open_interest, prev.open_interest ?? null) : null;
    perp.funding_1h_prev = prev ? (prev.funding_1h ?? null) : null;
  }
  return {
    compared_with: usable ? prevFeed.generated_at : null,
    note: usable
      ? 'oi_change_pct = change in open interest (coins) since compared_with'
      : 'no previous feed within 150 minutes; changes left empty',
  };
}
