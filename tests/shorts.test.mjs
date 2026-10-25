import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { shortBrief } from '../lib/shorts.mjs';
import { symbolBrief, toMarkdown } from '../lib/brief.mjs';

const H = 3600000;
const now = Date.parse('2026-10-25T08:10:00Z');
/** 종가 배열 → 닫힌 1h 봉. 고가·저가는 시가·종가 ± wick */
function toBars(closes, wick = 0.2) {
  const lastOpen = now - 10 * 60000 - H;
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: lastOpen - (closes.length - 1 - i) * H, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1000 };
  });
}
const strategies = readdirSync(new URL('../strategies', import.meta.url))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(`../strategies/${f}`, import.meta.url), 'utf8')));

test('반등 실패 숏: 하락 중 반등이 볼린저 상단·RSI 60 근처까지 갔다가 꺾이면 신호, 손절은 위·목표는 아래', () => {
  const c = [];
  for (let i = 0; i < 150; i++) c.push(120 - i * 0.1 + Math.sin(i / 3) * 0.3); // 완만한 하락
  const base = c.at(-1);
  for (let k = 1; k <= 5; k++) c.push(base + k * 0.9); // 빠른 반등
  c.push(c.at(-1) - 1.2); // 꺾임
  const s = shortBrief(toBars(c));
  const f = s.setups.bounce_fade;
  assert.equal(f.now, true, JSON.stringify(f));
  assert.ok(f.peak_bb_position >= 0.8 || f.peak_rsi >= 60);
  assert.ok(f.stop > c.at(-1));
  assert.ok(f.target < c.at(-1));
  assert.ok(f.reward_risk > 0);
  assert.equal(s.entry_now, true);
});

test('과매도(RSI 35 미만)에서는 반등 실패 숏을 내지 않는다', () => {
  const c = [];
  for (let i = 0; i < 150; i++) c.push(100);
  for (let i = 0; i < 20; i++) c.push(c.at(-1) - 1.5); // 급락
  c.push(c.at(-1) + 0.4);
  c.push(c.at(-1) - 0.6); // 작은 반등 후 꺾임
  const s = shortBrief(toBars(c));
  assert.equal(s.setups.bounce_fade.now, false);
  assert.equal(s.oversold, true);
});

test('지지선 이탈 숏: 박스권 최저가를 처음 깨는 봉에서만 신호', () => {
  const c = [];
  for (let i = 0; i < 150; i++) c.push(100 + Math.sin(i / 2) * 1);
  c.push(97.5);
  const s = shortBrief(toBars(c));
  const b = s.setups.breakdown;
  assert.equal(b.now, true, JSON.stringify(b));
  assert.ok(b.support > 97.5);
  assert.ok(b.stop > 97.5);
  c.push(97.3); // 다음 봉은 새 이탈이 아님
  assert.equal(shortBrief(toBars(c)).setups.breakdown.now, false);
});

test('bb 숏: 상단 위 종가가 상단 안으로 돌아올 때. 상단 위에 있는 동안(롱 청산 신호)은 숏 진입 아님', () => {
  const c = [];
  for (let i = 0; i < 150; i++) c.push(100 + Math.sin(i / 2) * 0.3);
  c.push(103); // 상단 돌파 — 롱 기준 exit 신호지만 숏 진입은 아님
  const above = shortBrief(toBars(c));
  assert.equal(above.strategies.bb.entry_now, false);
  c.push(100.6); // 상단 안으로 복귀 = 돌파 실패
  assert.equal(shortBrief(toBars(c)).strategies.bb.entry_now, true);
});

test('피드 항목에 short 블록이 붙고, 롱 signals는 그대로이며, 마크다운에 숏 칸이 있다', () => {
  const c = [];
  for (let i = 0; i < 240; i++) c.push(100 + 10 * Math.sin(i / 6));
  const x = symbolBrief({ symbol: 'BTCUSDT', group: 'fixed', bars: toBars(c), venue: 'Binance', strategies, now });
  assert.deepEqual(Object.keys(x.short.strategies).sort(), ['bb', 'ema', 'macd', 'rsi']);
  assert.deepEqual(Object.keys(x.short.setups).sort(), ['bounce_fade', 'breakdown']);
  assert.equal(typeof x.short.entry_now, 'boolean');
  assert.deepEqual(Object.keys(x.signals).sort(), strategies.map((s) => s.name).sort());
  // 사인파는 위아래로 여러 번 꺾이므로 숏 전략 신호도 한 번 이상 나온다
  assert.ok(Object.values(x.short.strategies).some((s) => s.last_entry_signal_at));
  const md = toMarkdown({
    generated_at_kst: 'x', generated_at: 'x', next_update_expected_by: 'x',
    market: { regime: 'neutral', btc_change_24h_pct: 0, btc_change_7d_pct: 0, breadth_24h_up: '1/1' },
    symbols: [x],
  });
  assert.match(md, /지금 숏 진입/);
});
