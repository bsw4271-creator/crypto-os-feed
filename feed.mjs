// Builds feed/feed.json and feed/feed.md from public Binance spot data (Gate.io as fallback). Read-only: no keys,
// no wallets, no orders. Usage: node feed.mjs [--out feed]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBars } from './lib/fetch.mjs';
import { selectUniverse } from './lib/universe.mjs';
import { marketSummary, symbolBrief, toMarkdown } from './lib/brief.mjs';
import { fetchHyperliquid, hyperliquidFor } from './lib/hyperliquid.mjs';
import { MAX_PREV_AGE_MS, addPerpChanges, fetchStablecoins } from './lib/flows.mjs';
import { fetchWhales } from './lib/whales.mjs';

const DAY = 86400000;
// Same lists as the paper-trading records in the private crypto-backtester repository.
export const FIXED = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'ZROUSDT'];
// paper-auto start (2026-10-18T13:00Z); the auto list is re-picked each day from daily candles closed before 00:00 UTC.
export const AUTO_START = Date.parse('2026-10-18T13:00:00Z');
const HISTORY_DAYS = 10; // 240 closed 1h bars: enough for warm-up and the 7d change

const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'feed';
const now = Date.now();
const strategies = readdirSync('strategies')
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join('strategies', f), 'utf8')));

let auto = [],
  autoAsOf = null,
  autoError = null;
try {
  autoAsOf = Math.floor(now / DAY) * DAY;
  const sel = await selectUniverse({ start: AUTO_START, now, asOf: autoAsOf });
  auto = sel.selected;
} catch (e) {
  autoError = e?.message ?? String(e);
}

const groups = new Map();
for (const s of FIXED) groups.set(s, 'fixed');
for (const s of auto) if (!groups.has(s)) groups.set(s, 'auto');

const hl = await fetchHyperliquid();
const symbols = [];
for (const [symbol, group] of groups) {
  try {
    const { bars, venue, fallbackReason } = await fetchBars({ symbol, days: HISTORY_DAYS, now });
    const brief = symbolBrief({ symbol, group, bars, venue, fallbackReason, strategies, now });
    if (brief.quality !== 'error') brief.hyperliquid = hyperliquidFor(symbol, brief.price, hl.spot, hl.perp);
    symbols.push(brief);
  } catch (e) {
    symbols.push({ symbol, group, quality: 'error', quality_reason: e?.message ?? String(e) });
  }
}

// The previous run's feed (committed in the repo) is the baseline for hourly changes.
let prevFeed = null;
try {
  const prevPath = join(outDir, 'feed.json');
  if (existsSync(prevPath)) prevFeed = JSON.parse(readFileSync(prevPath, 'utf8'));
} catch {
  prevFeed = null;
}
const perpChanges = addPerpChanges(symbols, prevFeed, now);
const stables = await fetchStablecoins();

// Large transfers of watched wallets since the previous run (first run or long gap: last 1 hour).
const prevAtMs = Date.parse(prevFeed?.generated_at ?? '');
const fromMs = Number.isFinite(prevAtMs) && now - prevAtMs > 0 && now - prevAtMs <= MAX_PREV_AGE_MS ? prevAtMs : now - 3600000;
const priceOf = (sym) => symbols.find((x) => x.symbol === sym && (x.quality === 'ok' || x.quality === 'fallback'))?.price ?? null;
const wallets = JSON.parse(readFileSync('config/wallets.json', 'utf8'));
const whales = await fetchWhales({
  wallets,
  prices: { ETHUSDT: priceOf('ETHUSDT'), BTCUSDT: priceOf('BTCUSDT') },
  fromSec: Math.floor(fromMs / 1000),
  toSec: Math.floor(now / 1000),
  key: process.env.ETHERSCAN_API_KEY,
});

const kst = new Date(now + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 16) + ' KST';
const feed = {
  schema_version: 1,
  generated_at: new Date(now).toISOString(),
  generated_at_kst: kst,
  // Runs hourly; GitHub can start late. Past this time, treat every symbol as stale.
  next_update_expected_by: new Date(now + 2 * 3600000).toISOString(),
  interval: '1h',
  source: 'Binance spot public market data (Gate.io fallback). Read-only. No account, wallet or order data.',
  disclaimer: '분석 참고용 데이터입니다. 매매 신호나 투자 권유가 아니며, 데이터가 늦거나 틀릴 수 있습니다.',
  quality_levels: {
    ok: 'Binance data, last closed bar within 150 minutes',
    fallback: 'Binance unavailable, another exchange used; prices can differ slightly',
    stale: 'last closed bar older than 150 minutes; do not act on it',
    error: 'no usable data',
  },
  universe: {
    fixed: FIXED,
    auto,
    auto_rule: 'Binance spot USDT pairs, no stablecoins or pegged assets, listed >= 365 days, top 10 by 30-day average daily quote volume (daily candles closed before 00:00 UTC today)',
    auto_selected_asof: autoAsOf ? new Date(autoAsOf).toISOString() : null,
    auto_error: autoError,
  },
  strategies,
  hyperliquid: {
    source: 'https://api.hyperliquid.xyz/info (public, read-only)',
    note: 'spot.coin / perp.name are the identifiers Hyperliquid orders use. Check spot.token_id against rules.md before trading. gap_vs_binance_pct = (Hyperliquid mid - Binance close) / Binance close.',
    errors: hl.errors,
  },
  flows: {
    note: '참고 신호입니다. 큰 자금 이동이 곧 매수·매도를 뜻하지는 않습니다.',
    stablecoins: { source: 'DefiLlama stablecoins (USD-pegged, all chains)', ...(stables.data ?? {}), error: stables.error },
    hyperliquid_perp_changes: perpChanges,
    whales,
  },
  market: marketSummary(symbols),
  symbols,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'feed.json'), JSON.stringify(feed, null, 1) + '\n');
writeFileSync(join(outDir, 'feed.md'), toMarkdown(feed));
const bad = symbols.filter((x) => x.quality !== 'ok').map((x) => `${x.symbol}:${x.quality}`);
console.log(`feed: ${symbols.length} symbols, regime ${feed.market.regime}${bad.length ? `, not ok: ${bad.join(' ')}` : ''}${autoError ? `, auto error: ${autoError}` : ''}`);
if (!symbols.some((x) => x.quality === 'ok' || x.quality === 'fallback')) process.exitCode = 1;
