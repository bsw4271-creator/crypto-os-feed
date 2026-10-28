import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atr, swings, stopFor, stopGuide } from '../lib/stopguide.mjs';

const H = 3600000;
const mk = (rows) => rows.map(([h, l, c], i) => ({ t: i * H, o: c, h, l, c, v: 1 }));

test('ATR: 고가-저가 폭이 일정하면 그 폭', () => {
  const bars = mk(Array.from({ length: 40 }, () => [101, 99, 100]));
  assert.ok(Math.abs(atr(bars) - 2) < 1e-9);
});

test('스윙: 좌우 2봉보다 낮은 가장 최근 저점을 찾는다', () => {
  const rows = Array.from({ length: 30 }, () => [101, 99, 100]);
  rows[20] = [100, 96, 97]; // 스윙 저점 96
  rows[24] = [103, 99.5, 102]; // 스윙 고점 103
  const s = swings(mk(rows));
  assert.equal(s.swing_low.price, 96);
  assert.equal(s.swing_high.price, 103);
});

test('손절: 스윙이 1.5 ATR보다 가까우면 1.5 ATR, 멀면 스윙 + 0.1 ATR', () => {
  const sw = { swing_low: { price: 99 }, swing_high: { price: 101 }, low_24h: 95, high_24h: 105 };
  const near = stopFor('long', 100, 2, sw); // 스윙까지 1+0.2 < 3
  assert.equal(near.stop, 97);
  assert.equal(near.bound_by, 'atr');
  assert.equal(near.distance_atr, 1.5);
  const far = stopFor('long', 100, 1, { ...sw, swing_low: { price: 98.5 } }); // 1.5+0.1=1.6 > 1.5
  assert.equal(far.stop, 98.4);
  assert.equal(far.bound_by, 'swing');
  assert.equal(far.too_wide, false);
  const tooWide = stopFor('short', 100, 1, { ...sw, swing_high: { price: 102.5 } }); // 2.6 ATR
  assert.equal(tooWide.too_wide, true);
  assert.equal(tooWide.stop, 102.6);
});

test('스윙이 이미 깨졌으면(진입가 위의 저점) 24봉 극값을 쓴다', () => {
  const sw = { swing_low: { price: 101 }, swing_high: null, low_24h: 97, high_24h: 104 };
  const g = stopFor('long', 100, 1, sw);
  assert.equal(g.swing_source, '24h_extreme');
  assert.equal(g.stop, 96.9);
  assert.equal(stopFor('short', 100, 1, sw).swing, 104);
});

test('stopGuide: 롱·숏 가이드와 ATR%를 함께 낸다', () => {
  const rows = Array.from({ length: 60 }, (_, i) => [101 + Math.sin(i) , 99 + Math.sin(i), 100 + Math.sin(i)]);
  const g = stopGuide(mk(rows), 100);
  assert.ok(g.atr14 > 0 && g.atr14_pct > 0);
  assert.ok(g.long.stop < 100 && g.short.stop > 100);
  assert.ok(g.long.distance_atr >= 1.5 && g.short.distance_atr >= 1.5);
});
