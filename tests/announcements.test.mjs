import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickersIn, parseBinance, parseBithumb, coinbaseNew, mergeItems, buildAnnouncements } from '../lib/announcements.mjs';

const NOW = Date.parse('2026-11-14T10:00:00Z');

test('tickers from titles: parentheses and pairs, common words skipped', () => {
  assert.deepEqual(tickersIn('Binance Will List Berachain (BERA) with Seed Tag'), ['BERA']);
  assert.deepEqual(tickersIn('Notice of Removal of Spot Trading Pairs - 2026-11-15: FOO/USDT, BAR/BTC'), ['FOO', 'BAR']);
  assert.deepEqual(tickersIn('스카이프로토콜(SKY) 원화 마켓 추가 (USDT)'), ['SKY']);
  assert.deepEqual(tickersIn(null), []);
});

test('binance parse', () => {
  const r = parseBinance({ data: { catalogs: [{ articles: [{ title: 'Binance Will Delist ABC (ABC)', code: 'x1', releaseDate: NOW }] }] } }, 'delisting');
  assert.equal(r[0].url, 'https://www.binance.com/en/support/announcement/x1');
  assert.equal(r[0].published_at, new Date(NOW).toISOString());
  assert.deepEqual(r[0].tickers, ['ABC']);
  assert.throws(() => parseBinance({ data: {} }, 'listing'), /unexpected/);
});

test('bithumb parse: KST time without zone, kind from title', () => {
  const r = parseBithumb([
    { categories: ['거래지원'], title: '페페(PEPE) 원화 마켓 추가', pc_url: 'https://feed.bithumb.com/notice/1', published_at: '2026-11-14 18:00:00' },
    { categories: ['안내'], title: '에이비씨(ABC) 거래지원 종료 안내', pc_url: 'u2', published_at: '2026-11-13 10:00:00' },
  ]);
  assert.equal(r[0].kind, 'listing');
  assert.equal(r[0].published_at, '2026-11-14T09:00:00.000Z');
  assert.equal(r[1].kind, 'delisting');
  assert.equal(r[0].category, '거래지원');
  assert.throws(() => parseBithumb({ x: 1 }), /unexpected/);
});

test('coinbase: first run is baseline only, then new ids become listings', () => {
  const a = coinbaseNew([{ id: 'BTC-USD' }, { id: 'ETH-USD' }], [], 'T');
  assert.equal(a.baseline, true);
  assert.equal(a.items.length, 0);
  const b = coinbaseNew([{ id: 'BTC-USD' }, { id: 'ETH-USD' }, { id: 'NEW-USD', base_currency: 'NEW', status: 'online', auction_mode: true }], a.ids, 'T');
  assert.equal(b.items.length, 1);
  assert.deepEqual(b.items[0].tickers, ['NEW']);
  assert.match(b.items[0].title, /경매 모드/);
});

test('merge: is_new only for unseen, first run all false, older than 7 days dropped', () => {
  const old = { source: 'binance', url: 'a', title: 'A', published_at: new Date(NOW - 8 * 864e5).toISOString() };
  const kept = { source: 'binance', url: 'b', title: 'B', published_at: new Date(NOW - 864e5).toISOString(), first_seen_at: 'X' };
  const fresh = [{ source: 'binance', url: 'b', title: 'B', published_at: kept.published_at }, { source: 'bithumb', url: 'c', title: 'C', published_at: new Date(NOW).toISOString() }];
  const r = mergeItems([old, kept], fresh, NOW);
  assert.deepEqual(r.map((x) => [x.url, x.is_new]), [['c', true], ['b', false]]);
  assert.equal(r[1].first_seen_at, 'X');
  assert.ok(mergeItems([], fresh, NOW, true).every((x) => !x.is_new));
});

test('build: one source failing keeps the others and is reported', async () => {
  const fake = async (url) => {
    if (url.includes('binance')) return { ok: true, json: async () => ({ data: { catalogs: [{ articles: [{ title: 'Binance Will List X (XX)', code: 'c', releaseDate: NOW }] }] } }) };
    if (url.includes('bithumb')) return { ok: false, status: 403 };
    return { ok: true, json: async () => [{ id: 'BTC-USD' }] };
  };
  const r = await buildAnnouncements({ prev: { items: [], coinbase_product_ids: ['BTC-USD'] }, now: NOW, fetchImpl: fake });
  assert.deepEqual(r.sources_ok, ['binance:listing', 'binance:delisting', 'coinbase']);
  assert.match(r.errors[0], /bithumb: HTTP 403/);
  assert.equal(r.items.length, 1); // 같은 공지가 두 카탈로그에서 와도 한 번만
  assert.equal(r.new_count, 1);
});
