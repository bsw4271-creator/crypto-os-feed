import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCatalyst, validateCatalyst } from '../lib/catalyst.mjs';

const H = 3600000;
const AT = Date.UTC(2026, 9, 29, 11, 25); // 발표 20:25 KST
const base = (Math.floor(AT / H) - 30) * H; // 발표 30봉 전부터
/** 30봉 평탄(100, 거래량 10) → 발표 봉 급등(거래량 300) → 이후 유지 */
function coinBars(nAfter = 10, jump = 12) {
  const out = [];
  for (let i = 0; i < 30; i++) out.push({ t: base + i * H, o: 100, h: 100.5, l: 99.5, c: 100, v: 10 });
  out.push({ t: base + 30 * H, o: 100, h: 110, l: 99.8, c: 108, v: 300 }); // 뉴스 봉
  for (let i = 1; i <= nAfter; i++) out.push({ t: base + (30 + i) * H, o: 108, h: 100 + jump + 1, l: 106, c: 100 + jump, v: 40 });
  return out;
}
const flat = (pct) => Array.from({ length: 45 }, (_, i) => ({ t: base + i * H, o: 100, h: 101, l: 99, c: i > 30 ? 100 + pct : 100, v: 1 }));
const cat = {
  id: 'CM-1', coin: 'HYPE', announced_at: new Date(AT).toISOString(), kind: 'final_contract',
  source_url: 'https://example.org/pr', confirmed_by: 'Catalyst Monitor', status: 'CONFIRMED',
};

test('상대강도·거래량을 모두 넘으면 eligible, 진입 구간과 손절(뉴스 봉 저점·발표 전 가격 중 높은 쪽 − 0.1 ATR)', () => {
  const now = base + 41 * H + 60000;
  const r = evaluateCatalyst({ cat, coinBars: coinBars(), marketBars: [flat(-2), flat(-1), flat(0)], atr: 2, now });
  assert.equal(r.active, true);
  assert.equal(r.confirm.market_confirmed, true, JSON.stringify(r.confirm));
  assert.ok(r.confirm.excess_pp >= 5);
  assert.ok(r.confirm.volume_ratio >= 3);
  assert.equal(r.eligible, true);
  assert.equal(r.pre_announce_price, 100);
  assert.equal(r.entry_zones.body_mid.stop, 100 - 0.2); // max(99.8, 100) − 0.1×2
  assert.equal(r.entry_zones.body_mid.entry, 104);
  assert.equal(r.entry_zones.body_mid.too_wide, false);
});

test('시장도 같이 올랐으면(초과 5%p 미만) 시장 확인 실패', () => {
  const now = base + 41 * H + 60000;
  const r = evaluateCatalyst({ cat, coinBars: coinBars(), marketBars: [flat(10), flat(9), flat(11)], atr: 2, now });
  assert.equal(r.confirm.market_confirmed, false);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /시장 확인/);
});

test('72시간이 지나면 신호 소멸', () => {
  const now = AT + 73 * H;
  const r = evaluateCatalyst({ cat, coinBars: coinBars(), marketBars: [flat(0)], atr: 2, now });
  assert.equal(r.active, false);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /유효기간/);
});

test('CONFIRMED가 아니거나 Catalyst Monitor가 확정하지 않은 항목은 거부', () => {
  assert.match(validateCatalyst({ ...cat, status: 'PENDING' }).join(), /CONFIRMED/);
  assert.match(validateCatalyst({ ...cat, confirmed_by: 'grok' }).join(), /Catalyst Monitor/);
  assert.match(validateCatalyst({ ...cat, kind: 'mou' }).join(), /kind/);
  const r = evaluateCatalyst({ cat: { ...cat, status: 'PENDING' }, coinBars: coinBars(), atr: 2, now: AT + H });
  assert.equal(r.eligible, false);
});

test('손절이 4 ATR보다 멀면 too_wide', () => {
  const now = base + 41 * H + 60000;
  const r = evaluateCatalyst({ cat, coinBars: coinBars(10, 30), marketBars: [flat(0)], atr: 1, now });
  assert.equal(r.entry_zones.ema9.too_wide, true);
});
