import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PREV_AGE_MS, addPerpChanges, fetchStablecoins, parseStablecoins } from '../lib/flows.mjs';

const asset = (symbol, now, d1, d7, d30, pegType = 'peggedUSD') => ({
  symbol,
  pegType,
  circulating: { peggedUSD: now },
  circulatingPrevDay: { peggedUSD: d1 },
  circulatingPrevWeek: { peggedUSD: d7 },
  circulatingPrevMonth: { peggedUSD: d30 },
});

test('stablecoins: USD-pegged totals and changes, USDT and USDC on their own, other pegs ignored', () => {
  const r = parseStablecoins({
    peggedAssets: [
      asset('USDT', 1000, 990, 950, 900),
      asset('USDC', 500, 505, 480, 450),
      asset('EURC', 99999, 1, 1, 1, 'peggedEUR'),
    ],
  });
  assert.equal(r.total.supply_usd, 1500);
  assert.equal(r.total.change_1d_usd, 5);
  assert.equal(r.total.change_1d_pct, Number(((5 / 1495) * 100).toFixed(3)));
  assert.equal(r.total.change_7d_usd, 70);
  assert.equal(r.USDT.change_1d_usd, 10);
  assert.equal(r.USDC.change_1d_usd, -5);
  assert.equal(r.USDC.change_30d_pct, Number(((50 / 450) * 100).toFixed(3)));
});

test('stablecoins: missing history gives nulls, bad shape throws, fetch errors are reported', async () => {
  const r = parseStablecoins({ peggedAssets: [{ symbol: 'USDT', pegType: 'peggedUSD', circulating: { peggedUSD: 10 } }] });
  assert.equal(r.total.supply_usd, 10);
  assert.equal(r.total.change_1d_pct, null);
  assert.equal(r.USDC, null);
  assert.throws(() => parseStablecoins({}), /unexpected/);
  const down = await fetchStablecoins(async () => ({ ok: false, status: 502 }));
  assert.deepEqual(down, { data: null, error: 'HTTP 502 from DefiLlama stablecoins' });
});

const now = Date.parse('2026-10-21T09:50:00Z');
const sym = (symbol, oi, mark, funding) => ({ symbol, hyperliquid: { spot: null, perp: { name: symbol.replace('USDT', ''), open_interest: oi, mark, funding_1h: funding } } });

test('perp changes: OI change in coins against the previous run, USD OI, previous funding', () => {
  const symbols = [sym('BTCUSDT', 110, 80000, 0.00002), sym('ZROUSDT', 50, 2, 0.00001), { symbol: 'XUSDT', quality: 'error' }];
  const prev = { generated_at: new Date(now - 60 * 60000).toISOString(), symbols: [sym('BTCUSDT', 100, 81000, 0.00001)] };
  const info = addPerpChanges(symbols, prev, now);
  assert.equal(info.compared_with, prev.generated_at);
  assert.equal(symbols[0].hyperliquid.perp.oi_change_pct, 10);
  assert.equal(symbols[0].hyperliquid.perp.open_interest_usd, 110 * 80000);
  assert.equal(symbols[0].hyperliquid.perp.funding_1h_prev, 0.00001);
  assert.equal(symbols[1].hyperliquid.perp.oi_change_pct, null, 'not in the previous feed');
});

test('perp changes: a previous run older than the limit, missing or in the future is not used', () => {
  for (const generated_at of [new Date(now - MAX_PREV_AGE_MS - 1).toISOString(), new Date(now + 60000).toISOString(), 'garbage']) {
    const symbols = [sym('BTCUSDT', 110, 80000, 0)];
    const info = addPerpChanges(symbols, { generated_at, symbols: [sym('BTCUSDT', 100, 1, 0)] }, now);
    assert.equal(info.compared_with, null);
    assert.equal(symbols[0].hyperliquid.perp.oi_change_pct, null);
  }
  const symbols = [sym('BTCUSDT', 110, 80000, 0)];
  assert.equal(addPerpChanges(symbols, null, now).compared_with, null);
});
