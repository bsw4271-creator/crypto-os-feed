import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { MIN_BARS, STALE_AFTER_MIN, marketSummary, symbolBrief, toMarkdown } from '../lib/brief.mjs';

const H = 3600000;
const strategies = readdirSync(new URL('../strategies', import.meta.url))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(`../strategies/${f}`, import.meta.url), 'utf8')));

/** n closed 1h bars ending so that the last one closed `ageMin` minutes before `now`. */
function bars(n, now, ageMin = 10, price = (i) => 100 + 10 * Math.sin(i / 6)) {
  const lastOpen = now - ageMin * 60000 - H;
  return Array.from({ length: n }, (_, i) => {
    const c = price(i),
      o = price(i - 1);
    return { t: lastOpen - (n - 1 - i) * H, o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v: 1000 };
  });
}
const now = Date.parse('2026-10-20T09:10:00Z');

test('fresh Binance data is ok and carries indicators, changes and one signal block per strategy', () => {
  const b = bars(240, now);
  const x = symbolBrief({ symbol: 'BTCUSDT', group: 'fixed', bars: b, venue: 'Binance', strategies, now });
  assert.equal(x.quality, 'ok');
  assert.equal(x.quality_reason, null);
  assert.equal(x.age_min, 10);
  assert.equal(x.price, Number(b.at(-1).c.toPrecision(6)));
  assert.ok(Number.isFinite(x.change_24h_pct) && Number.isFinite(x.change_7d_pct));
  for (const k of ['rsi14', 'macd', 'macd_signal', 'macd_histogram', 'bb_upper', 'bb_lower', 'bb_position', 'ema9', 'sma9'])
    assert.ok(Number.isFinite(x.indicators_1h[k]), k);
  assert.deepEqual(Object.keys(x.signals).sort(), strategies.map((s) => s.name).sort());
  for (const s of Object.values(x.signals)) {
    assert.equal(typeof s.entry_now, 'boolean');
    assert.ok(['entry', 'exit', 'none'].includes(s.latest));
  }
  // The sine wave crosses RSI 30/70 and the bands, so at least one strategy has fired in the window.
  assert.ok(Object.values(x.signals).some((s) => s.last_entry_signal_at));
});

test('24h change compares with the close 24 bars earlier', () => {
  const b = bars(240, now, 10, (i) => 100 + i);
  const x = symbolBrief({ symbol: 'ETHUSDT', group: 'fixed', bars: b, venue: 'Binance', strategies, now });
  const expected = ((b.at(-1).c - b.at(-25).c) / b.at(-25).c) * 100;
  assert.ok(Math.abs(x.change_24h_pct - expected) < 1e-3);
});

test('old data is stale, another exchange is fallback, too few bars is error', () => {
  const stale = symbolBrief({ symbol: 'A', group: 'auto', bars: bars(240, now, STALE_AFTER_MIN + 1), venue: 'Binance', strategies, now });
  assert.equal(stale.quality, 'stale');
  assert.match(stale.quality_reason, /min old/);
  const edge = symbolBrief({ symbol: 'A', group: 'auto', bars: bars(240, now, STALE_AFTER_MIN), venue: 'Binance', strategies, now });
  assert.equal(edge.quality, 'ok', 'exactly at the limit is still ok');
  const fb = symbolBrief({ symbol: 'B', group: 'auto', bars: bars(240, now), venue: 'Gate', fallbackReason: 'HTTP 451', strategies, now });
  assert.equal(fb.quality, 'fallback');
  assert.match(fb.quality_reason, /Gate.*HTTP 451/);
  const few = symbolBrief({ symbol: 'C', group: 'auto', bars: bars(MIN_BARS - 1, now), venue: 'Binance', strategies, now });
  assert.equal(few.quality, 'error');
});

test('market label: risk_on, risk_off, neutral, and unknown without BTC; stale symbols are left out', () => {
  const e = (symbol, d24, d7, quality = 'ok') => ({ symbol, quality, change_24h_pct: d24, change_7d_pct: d7 });
  assert.equal(marketSummary([e('BTCUSDT', 1, 5), e('X', 1, 0), e('Y', 2, 0), e('Z', -1, 0)]).regime, 'risk_on');
  assert.equal(marketSummary([e('BTCUSDT', -1, -5), e('X', -1, 0), e('Y', -2, 0), e('Z', 1, 0)]).regime, 'risk_off');
  assert.equal(marketSummary([e('BTCUSDT', 1, 5), e('X', -1, 0), e('Y', -2, 0), e('Z', -1, 0)]).regime, 'neutral');
  assert.equal(marketSummary([e('BTCUSDT', 1, 5, 'stale'), e('X', 1, 0)]).regime, 'unknown');
  const m = marketSummary([e('BTCUSDT', 1, 5), e('X', 1, 0, 'stale'), { symbol: 'Y', quality: 'error' }]);
  assert.equal(m.breadth_24h_up, '1/1');
  assert.equal(m.usable_symbols, 1);
  assert.equal(m.total_symbols, 3);
});

test('markdown lists every symbol and says it is not a trading signal', () => {
  const ok = symbolBrief({ symbol: 'BTCUSDT', group: 'fixed', bars: bars(240, now), venue: 'Binance', strategies, now });
  const md = toMarkdown({
    generated_at: '2026-10-20T09:10:00.000Z',
    generated_at_kst: '2026-10-20 18:10 KST',
    next_update_expected_by: '2026-10-20T11:10:00.000Z',
    market: marketSummary([ok]),
    symbols: [ok, { symbol: 'NOPEUSDT', group: 'auto', quality: 'error', quality_reason: 'x' }],
  });
  assert.match(md, /\| BTCUSDT \| ok \|/);
  assert.match(md, /\| NOPEUSDT \| error \|/);
  assert.match(md, /매매 신호나 투자 권유가 아닙니다/);
});
