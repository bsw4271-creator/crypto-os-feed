// Builds feed/feed.json and feed/feed.md from public Binance spot data (Gate.io as fallback). Read-only: no keys,
// no wallets, no orders. Usage: node feed.mjs [--out feed]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBars } from './lib/fetch.mjs';
import { parseKlines } from './lib/indicator-view.mjs';
import { marketSummary, symbolBrief, toMarkdown } from './lib/brief.mjs';
import { allPerps, autoPerps, fetchCandles, fetchHyperliquid, hyperliquidFor, post as hlPost } from './lib/hyperliquid.mjs';
import { XYZ_DEX, INDEX_FOR_REGIME, parseXyz, equitySession, equityRegime, ownRegime } from './lib/equities.mjs';
import { MAX_PREV_AGE_MS, addPerpChanges, fetchStablecoins } from './lib/flows.mjs';
import { fetchWhales } from './lib/whales.mjs';
import { stopGuide, STOP_RULE, atr as atrOf } from './lib/stopguide.mjs';
import { evaluateCatalyst, CATALYST_RULE } from './lib/catalyst.mjs';
import { fetchBinanceBases } from './lib/binance-list.mjs';

// Same lists as the paper-trading records in the private crypto-backtester repository.
export const FIXED = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'HYPEUSDT', 'ZROUSDT'];
const HISTORY_DAYS = 10; // 240 closed 1h bars: enough for warm-up and the 7d change

const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'feed';
const now = Date.now();
// fetchBars falls back to Gate on any Binance failure; for auto symbols we want Binance or nothing.
const binanceOnly = (url, opt) => (String(url).includes('gateio') ? Promise.reject(new Error('Gate skipped for auto symbols')) : globalThis.fetch(url, opt));
const strategies = readdirSync('strategies')
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join('strategies', f), 'utf8')));

const hl = await fetchHyperliquid();
const fixedNames = FIXED.map((x) => x.replace(/USDT$/, ''));
let autoError = hl.perp ? null : 'Hyperliquid perp list unavailable';
const auto = autoPerps(hl.perp, fixedNames, 10);

// entries: [symbol, group, perpName]
const marketBars = new Map(); // 시장 중앙값 계산용(major_catalyst)
const entries = [...FIXED.map((s) => [s, 'fixed', s.replace(/USDT$/, '')]), ...auto.map((n) => [`${n}USDT`, 'auto', n])];
const symbols = [];
const H = 3600000;
for (const [symbol, group, perpName] of entries) {
  try {
    let got;
    if (group === 'fixed') got = await fetchBars({ symbol, days: HISTORY_DAYS, now });
    else {
      // Auto (Hyperliquid list): Binance spot if the same ticker trades there, otherwise Hyperliquid's own perp candles.
      // No Gate fallback here: a same-named token on another exchange may be a different coin.
      try {
        if (!/^[A-Z0-9]{2,20}$/.test(perpName)) throw new Error('not a Binance-style ticker');
        got = await fetchBars({ symbol, days: HISTORY_DAYS, now, fetchImpl: binanceOnly });
      } catch (e) {
        const start = Math.floor((now - HISTORY_DAYS * 24 * H) / H) * H;
        const { rows } = parseKlines(await fetchCandles(perpName, start, now), now);
        got = { bars: rows, venue: 'Hyperliquid', fallbackReason: null, binanceMiss: e.message };
      }
    }
    marketBars.set(perpName, got.bars);
    const brief = symbolBrief({ symbol, group, bars: got.bars, venue: got.venue, fallbackReason: got.fallbackReason, strategies, now });
    brief.perp_name = perpName;
    if (brief.quality !== 'error') brief.hyperliquid = hyperliquidFor(symbol, brief.price, hl.spot, hl.perp, perpName);
    // 손절 가이드(3-0-3): 거래 장소인 하이퍼리퀴드 1h 봉 기준. 피드 봉이 바이낸스여도 여기는 HL 봉을 쓴다.
    if (brief.quality !== 'error') {
      try {
        let hlBars = got.venue === 'Hyperliquid' ? got.bars : null;
        if (!hlBars) {
          const start = Math.floor((now - 3 * 24 * H) / H) * H;
          hlBars = parseKlines(await fetchCandles(perpName, start, now), now).rows;
        }
        const px = brief.hyperliquid?.perp?.mid ?? brief.hyperliquid?.perp?.mark ?? brief.price;
        brief.stop_guide = stopGuide(hlBars.slice(-72), px);
      } catch (e) {
        brief.stop_guide = { error: e?.message ?? String(e) };
      }
    }
    symbols.push(brief);
  } catch (e) {
    symbols.push({ symbol, group, perp_name: perpName, quality: 'error', quality_reason: e?.message ?? String(e) });
  }
}

// 대형 공식 호재(규칙서 3-0-4): config/catalysts.json의 CONFIRMED 항목 중 발표 후 7일 안의 것만 계산해 싣는다.
const majorCatalyst = [];
let catalystConfigError = null;
let catalystList = [];
try {
  if (existsSync('config/catalysts.json')) catalystList = JSON.parse(readFileSync('config/catalysts.json', 'utf8'));
  if (!Array.isArray(catalystList)) throw new Error('catalysts.json은 배열이어야 함');
} catch (e) {
  catalystConfigError = e?.message ?? String(e);
  catalystList = [];
}
for (const cat of catalystList) {
  const at = Date.parse(cat?.announced_at);
  if (!Number.isFinite(at) || now - at > 7 * 24 * H) continue;
  try {
    const start = Math.floor((at - 26 * H) / H) * H;
    const coinBars = parseKlines(await fetchCandles(cat.coin, start, now), now).rows;
    const others = [...marketBars.entries()].filter(([n]) => n !== cat.coin).map(([, b]) => b);
    majorCatalyst.push(evaluateCatalyst({ cat, coinBars, marketBars: others, atr: atrOf(coinBars.slice(-40)), now }));
  } catch (e) {
    majorCatalyst.push({ id: cat?.id ?? null, coin: cat?.coin ?? null, eligible: false, reason: `계산 오류: ${e?.message ?? e}` });
  }
}

// 바이낸스 상장 여부와 HL 전용 종목 손절 가이드 (규칙서 §2-4, rules-6.7)
const binanceList = await fetchBinanceBases();
const perpsAll = allPerps(hl.perp, new Set(symbols.map((x) => x.perp_name)), binanceList.set);
const HL_ONLY_MIN_VOLUME = 3_000_000;
const hlOnlyTargets = perpsAll
  .filter((p) => p.binance_listed === false && !p.in_feed_symbols && (p.day_volume_usd ?? 0) >= HL_ONLY_MIN_VOLUME)
  .slice(0, 40);
for (const p of hlOnlyTargets) {
  try {
    const start = Math.floor((now - 3 * 24 * H) / H) * H;
    const bars = parseKlines(await fetchCandles(p.name, start, now), now).rows;
    p.stop_guide = stopGuide(bars.slice(-72), p.mark);
  } catch (e) {
    p.stop_guide = { error: e?.message ?? String(e) };
  }
}

// 주식 선물 (trade.xyz HIP-3, 규칙서 1-2, rules-6.8)
const EQUITY_MIN_VOLUME = 3_000_000;
const equities = { dex: XYZ_DEX, ...equitySession(now), error: null, market: null, items: [] };
try {
  const xyz = parseXyz(await hlPost({ type: 'metaAndAssetCtxs', dex: XYZ_DEX }, globalThis.fetch));
  const barsOf = async (name) => parseKlines(await fetchCandles(name, Math.floor((now - HISTORY_DAYS * 24 * H) / H) * H, now), now).rows;
  const briefs = [];
  // 상세(지표·숏 신호·손절 가이드): 교차 마진 가능 + 거래대금 300만 USD 이상. 주식 상위 15개 + 지수·원자재·통화 상위 10개
  const liquid = (cls) => xyz.filter((x) => x.asset_class === cls && !x.only_isolated && (x.day_volume_usd ?? 0) >= EQUITY_MIN_VOLUME);
  for (const it of [...liquid('equity').slice(0, 15), ...liquid('index_commodity_fx').slice(0, 10)]) {
    try {
      const bars = await barsOf(it.name);
      const b = symbolBrief({ symbol: it.name, group: 'equity', bars, venue: 'Hyperliquid', strategies, now });
      Object.assign(it, { detail: true, quality: b.quality, change_24h_pct: b.change_24h_pct, change_7d_pct: b.change_7d_pct, indicators_1h: b.indicators_1h, signals: b.signals, short: b.short });
      it.stop_guide = stopGuide(bars.slice(-72), it.mid ?? it.mark);
      // 지수·원자재·통화는 주식 국면과 따로 움직이므로 종목 자체 추세로 국면을 정한다(규칙서 1-2)
      if (it.asset_class !== 'equity') it.own_regime = ownRegime(b);
      else briefs.push(b);
    } catch (e) {
      it.detail_error = e?.message ?? String(e);
    }
  }
  let indexBrief = null;
  const idx = xyz.find((x) => INDEX_FOR_REGIME.includes(x.ticker));
  if (idx) {
    try {
      indexBrief = symbolBrief({ symbol: idx.name, group: 'index', bars: await barsOf(idx.name), venue: 'Hyperliquid', strategies, now });
    } catch (e) {
      equities.index_error = e?.message ?? String(e);
    }
  }
  equities.market = equityRegime(indexBrief, briefs);
  equities.items = xyz;
} catch (e) {
  equities.error = e?.message ?? String(e);
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
  source: 'Binance spot public market data (Gate.io fallback for fixed symbols) and Hyperliquid public info API. Read-only. No account, wallet or order data.',
  disclaimer: '분석 참고용 데이터입니다. 매매 신호나 투자 권유가 아니며, 데이터가 늦거나 틀릴 수 있습니다.',
  quality_levels: {
    ok: 'Binance (or, for Hyperliquid-only auto symbols, Hyperliquid perp) data, last closed bar within 150 minutes',
    fallback: 'Binance unavailable, another exchange used; prices can differ slightly',
    stale: 'last closed bar older than 150 minutes; do not act on it',
    error: 'no usable data',
  },
  universe: {
    fixed: FIXED,
    auto,
    auto_rule: 'Hyperliquid perps (not delisted), top 10 by 24h notional volume, fixed names skipped; re-picked every run. Bars: Binance spot same ticker if it exists, else Hyperliquid perp 1h candles (venue Hyperliquid).',
    auto_error: autoError,
  },
  strategies,
  stop_rule: {
    ...STOP_RULE,
    formula: '손절 = 진입가 ± max(1.5×ATR14, 진입가~스윙 거리 + 0.1×ATR). 스윙 = 최근 24봉 안 좌우 2봉 기준 가장 최근 스윙 저점(롱)·고점(숏), 진입가 반대쪽에 없으면 24봉 최저·최고가. 거리 2.0 ATR 초과면 진입 안 함. 하이퍼리퀴드 1h 봉 기준.',
    note: 'stop_guide.long/short는 피드 생성 시점 가격 기준이다. 실제 진입가가 다르면 같은 공식으로 다시 계산한다.',
  },
  equities: {
    note: '규칙서 1-2. trade.xyz(HIP-3) 주식 선물. 주문·캔들 이름은 name(예: xyz:NVDA) 그대로. detail=true인 종목에만 지표·숏 신호·손절 가이드가 있다. 주식 국면은 market.regime, 지수·원자재·통화는 각 종목 own_regime(코인 국면과 별개).',
    ...equities,
  },
  major_catalyst: {
    rule: CATALYST_RULE,
    note: '규칙서 3-0-4. 목록은 소유자가 Catalyst Monitor CONFIRMED 신호만 config/catalysts.json에 넣은 것. eligible=true인 코인의 롱에만 예외 진입 가능. 손절·진입 구간은 피드 시점 기준이며 실제 진입가로 다시 계산한다.',
    config_error: catalystConfigError,
    items: majorCatalyst,
  },
  hyperliquid: {
    source: 'https://api.hyperliquid.xyz/info (public, read-only)',
    note: 'spot.coin / perp.name are the identifiers Hyperliquid orders use. Check spot.token_id against rules.md before trading. gap_vs_binance_pct = (Hyperliquid mid - feed close) / feed close; the feed close is Binance unless the symbol venue is Hyperliquid.',
    errors: hl.errors,
    // Every perp that can be traded now, most traded first. Symbols outside `symbols` have no indicators.
    perps_all: perpsAll,
    binance_listing: { sources: binanceList.sources, errors: binanceList.errors, note: 'binance_listed는 바이낸스 USDT·USDC·FDUSD 마켓 기준. sources에 futures가 없으면 현물만 확인한 것(선물 전용 상장 코인도 미상장으로 보임 → 더 엄격한 §2-4가 적용될 뿐 위험해지지는 않음).' },
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
