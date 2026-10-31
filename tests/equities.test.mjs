import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXyz, equitySession, equityRegime } from '../lib/equities.mjs';

test('xyz 마켓 파싱: 주식/지수 구분, 교차·격리, 오라클 차이, 거래대금 순', () => {
  const raw = [
    { universe: [
      { name: 'xyz:NVDA', maxLeverage: 20 },
      { name: 'xyz:PLTR', maxLeverage: 10, onlyIsolated: true },
      { name: 'xyz:GOLD', maxLeverage: 20 },
      { name: 'xyz:OLD', maxLeverage: 5, isDelisted: true },
    ] },
    [
      { markPx: '203.9', midPx: '204', oraclePx: '202', funding: '0.0000125', dayNtlVlm: '50000000', openInterest: '1000' },
      { markPx: '150', midPx: '150', oraclePx: '150', funding: '0', dayNtlVlm: '9000000', openInterest: '10' },
      { markPx: '4000', midPx: '4000', oraclePx: '4000', funding: '0', dayNtlVlm: '20000000', openInterest: '1' },
      {},
    ],
  ];
  const x = parseXyz(raw);
  assert.deepEqual(x.map((i) => i.name), ['xyz:NVDA', 'xyz:GOLD', 'xyz:PLTR']);
  const nvda = x[0];
  assert.equal(nvda.asset_class, 'equity');
  assert.equal(nvda.only_isolated, false);
  assert.equal(nvda.mark_vs_oracle_pct, 0.99);
  assert.equal(x[1].asset_class, 'index_commodity_fx');
  assert.equal(x[2].only_isolated, true);
  assert.equal(x[2].margin_mode, 'isolated');
});

test('세션: 금 20:00 ET ~ 일 20:05 ET는 주말(내부 가격)', () => {
  // 2026-11-06 금 19:59 EST = 2026-11-07 00:59 UTC
  assert.equal(equitySession(Date.UTC(2026, 10, 7, 0, 59)).session, 'weekday');
  assert.equal(equitySession(Date.UTC(2026, 10, 7, 1, 0)).session, 'weekend');
  // 일 20:04 EST = 월 01:04 UTC, 20:05 = 01:05 UTC
  assert.equal(equitySession(Date.UTC(2026, 10, 9, 1, 4)).session, 'weekend');
  assert.equal(equitySession(Date.UTC(2026, 10, 9, 1, 5)).session, 'weekday');
});

test('주식 국면: 지수 7일·종목 상승 비율', () => {
  const b = (c) => ({ quality: 'ok', change_24h_pct: c });
  assert.equal(equityRegime({ symbol: 'xyz:XYZ100', change_7d_pct: 2 }, [b(1), b(2), b(-1)]).regime, 'risk_on');
  assert.equal(equityRegime({ symbol: 'xyz:XYZ100', change_7d_pct: -2 }, [b(-1), b(-2), b(1)]).regime, 'risk_off');
  assert.equal(equityRegime(null, [b(1)]).regime, 'unknown');
});
