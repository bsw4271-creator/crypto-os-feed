import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHyperliquid, hyperliquidFor, parsePerp, parseSpot } from '../lib/hyperliquid.mjs';

// Shapes of the public info API (spotMetaAndAssetCtxs, metaAndAssetCtxs), trimmed.
const spotRaw = [
  {
    tokens: [
      { name: 'USDC', index: 0, tokenId: '0xusdc' },
      { name: 'HYPE', index: 150, tokenId: '0xhype' },
      { name: 'UBTC', index: 197, tokenId: '0xubtc' },
      { name: 'FAKE', index: 300, tokenId: '0xfake' },
    ],
    universe: [
      { name: '@107', tokens: [150, 0], index: 107 },
      { name: '@142', tokens: [197, 0], index: 142 },
      { name: '@500', tokens: [300, 150], index: 500 }, // quoted in HYPE, not USDC: ignored
    ],
  },
  [
    { coin: '@107', midPx: '40.10', markPx: '40.12', dayNtlVlm: '1000000' },
    { coin: '@142', midPx: '81700', markPx: '81710', dayNtlVlm: '500000' },
    { coin: '@500', midPx: '1', markPx: '1', dayNtlVlm: '1' },
  ],
];
const perpRaw = [
  { universe: [{ name: 'BTC', maxLeverage: 40 }, { name: 'OLD', maxLeverage: 3, isDelisted: true }, { name: 'ZRO', maxLeverage: 5 }] },
  [
    { markPx: '81600', midPx: '81605', funding: '0.0000125', openInterest: '1000', dayNtlVlm: '9000000' },
    { markPx: '1', midPx: '1' },
    { markPx: '1.87', midPx: '1.88', funding: '-0.00001', openInterest: '50', dayNtlVlm: '20000' },
  ],
];

test('spot: USDC pairs are indexed by base token with order coin, tokenId and prices', () => {
  const s = parseSpot(spotRaw);
  assert.deepEqual(s.get('UBTC'), { coin: '@142', pair: 'UBTC/USDC', token: 'UBTC', token_id: '0xubtc', mid: 81700, mark: 81710, day_volume_usd: 500000, duplicates: 0 });
  assert.equal(s.get('HYPE').coin, '@107');
  assert.equal(s.has('FAKE'), false, 'non-USDC pairs are skipped');
});

test('perp: delisted markets are dropped, numbers parsed', () => {
  const p = parsePerp(perpRaw);
  assert.equal(p.has('OLD'), false);
  assert.deepEqual(p.get('ZRO'), { name: 'ZRO', mark: 1.87, mid: 1.88, funding_1h: -0.00001, open_interest: 50, day_volume_usd: 20000, max_leverage: 5 });
});

test('per symbol: spot only where a spot token is mapped; gap to the Binance price in percent', () => {
  const s = parseSpot(spotRaw),
    p = parsePerp(perpRaw);
  const btc = hyperliquidFor('BTCUSDT', 81567.4, s, p);
  assert.equal(btc.spot.coin, '@142');
  assert.equal(btc.spot.gap_vs_binance_pct, Number((((81700 - 81567.4) / 81567.4) * 100).toFixed(3)));
  assert.equal(btc.perp.name, 'BTC');
  const zro = hyperliquidFor('ZROUSDT', 1.875, s, p);
  assert.equal(zro.spot, null, 'no mapped spot token for ZRO');
  assert.equal(zro.perp.name, 'ZRO');
  assert.deepEqual(hyperliquidFor('XRPUSDT', 1.3, s, p), { spot: null, perp: null });
  assert.deepEqual(hyperliquidFor('BTCUSDT', 1, null, null), { spot: null, perp: null }, 'API down: no data, no throw');
});

test('unexpected shapes throw in the parsers but fetchHyperliquid reports them as errors', async () => {
  assert.throws(() => parseSpot({}), /unexpected/);
  assert.throws(() => parsePerp([1]), /unexpected/);
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.type === 'spotMetaAndAssetCtxs') return { ok: false, status: 503 };
    return { ok: true, json: async () => perpRaw };
  };
  const r = await fetchHyperliquid(fake);
  assert.equal(r.spot, null);
  assert.equal(r.perp.get('BTC').mark, 81600);
  assert.deepEqual(r.errors, ['spot: HTTP 503 from Hyperliquid']);
});

import { allPerps, autoPerps, candlesToKlines } from '../lib/hyperliquid.mjs';
const perpMap = (rows) => new Map(rows.map((r) => [r.name, { mark: 1, funding_1h: 0, open_interest: 10, max_leverage: 5, ...r }]));

test('auto perps: top by 24h volume, fixed names and zero-volume skipped', () => {
  const m = perpMap([
    { name: 'BTC', day_volume_usd: 900 },
    { name: 'kPEPE', day_volume_usd: 500 },
    { name: 'FARTCOIN', day_volume_usd: 700 },
    { name: 'DEAD', day_volume_usd: 0 },
    { name: 'AAA', day_volume_usd: 100 },
  ]);
  assert.deepEqual(autoPerps(m, ['BTC'], 2), ['FARTCOIN', 'kPEPE']);
  assert.deepEqual(autoPerps(null), []);
});

test('all perps: compact, most traded first, marks feed symbols', () => {
  const list = allPerps(perpMap([{ name: 'A', day_volume_usd: 1, mark: 2 }, { name: 'B', day_volume_usd: 5 }]), new Set(['A']));
  assert.deepEqual(list.map((x) => x.name), ['B', 'A']);
  assert.equal(list[1].open_interest_usd, 20);
  assert.equal(list[1].in_feed_symbols, true);
});

test('candles: Hyperliquid rows become kline arrays with hour close time', () => {
  const k = candlesToKlines([{ t: 3600000, T: 7199999, o: '1', h: '2', l: '0.5', c: '1.5', v: '10' }]);
  assert.deepEqual(k, [[3600000, '1', '2', '0.5', '1.5', '10', 7199999]]);
  assert.throws(() => candlesToKlines({}), /unexpected/);
});
