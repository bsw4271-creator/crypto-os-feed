import test from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_CONTRACT, RISK_MAX_AGE_MS, displayVerification, verificationText, transferSubject, transferVerification, withWhaleVerification } from '../lib/signal-verification.mjs';
import { toMarkdown } from '../lib/brief.mjs';

const now = Date.parse('2031-01-01T00:00:00Z');
const transfer = (n = 1) => ({ wallet: 'SYNTHETIC_WATCH', direction: 'out', counterparty: 'SYNTHETIC_EXCHANGE', counterparty_label: 'SYNTHETIC_EXCHANGE', kind: 'to_exchange', asset: 'ETH', amount: 1000, usd: 2_000_000, at: new Date(now - 1000).toISOString(), tx: 'SYNTHETIC_TX_' + n });
const whales = transfers => ({ source: 'SYNTHETIC', threshold_usd: 1_000_000, transfers, to_exchange_usd: transfers.length * 2_000_000, from_exchange_usd: 0, errors: [] });
const evidence = (t, status = 'CHECKED') => ({ contract: EVIDENCE_CONTRACT, source_verified: true, evidence_id: 'SYNTHETIC_EVIDENCE', subject: transferSubject(t), checked_at: now - 500, expires_at: now + 1000, risk_check_complete: true, status });
const markdown = wh => toMarkdown({ generated_at: new Date(now).toISOString(), generated_at_kst: 'synthetic', next_update_expected_by: new Date(now + 3600000).toISOString(), market: { regime: 'risk_on' }, symbols: [], flows: { whales: wh } });

test('missing independent evidence keeps every observation UNKNOWN regardless of labels, quality or market regime', () => {
  const input = whales([transfer()]), copy = structuredClone(input), result = withWhaleVerification(input, now);
  assert.equal(result.transfers.length, 1); assert.equal(result.to_exchange_usd, input.to_exchange_usd);
  assert.equal(result.transfers[0].verification.status, 'UNKNOWN'); assert.equal(result.verification.status, 'UNKNOWN');
  assert.deepEqual(result.verification.counts, { CHECKED: 0, UNKNOWN: 1, EXCLUDED: 0 });
  assert.equal(result.transfers[0].verification.positive_confirmation_allowed, false);
  assert.deepEqual(input, copy); assert.match(markdown(result), /risk_on/); assert.match(markdown(result), /판정 불가/);
});

test('explicit offline contract requires source verification, exact identity and valid original clocks', () => {
  const t = transfer();
  for (const mode of ['source', 'subject', 'contract', 'id', 'future', 'invalid-time', 'incomplete']) {
    const e = evidence(t);
    if (mode === 'source') e.source_verified = false;
    if (mode === 'subject') e.subject = transferSubject(transfer(2));
    if (mode === 'contract') e.contract = 'unrecognized';
    if (mode === 'id') e.evidence_id = '';
    if (mode === 'future') e.checked_at = now + 1;
    if (mode === 'invalid-time') e.checked_at = NaN;
    if (mode === 'incomplete') e.risk_check_complete = false;
    assert.equal(transferVerification(t, e, now).status, 'UNKNOWN', mode);
  }
  const checked = transferVerification(t, evidence(t), now);
  assert.equal(checked.status, 'CHECKED');
  assert.equal(checked.positive_confirmation_allowed, false, 'no live confirmation engine is connected');
});

test('expired CHECKED evidence never borrows a fresh feed receipt clock', () => {
  const t = transfer();
  for (const expiry of [now, now - 1, null, NaN, Infinity, now + RISK_MAX_AGE_MS + 1]) {
    const e = { ...evidence(t), expires_at: expiry };
    assert.equal(transferVerification(t, e, now).status, 'UNKNOWN');
  }
  const e = { ...evidence(t), checked_at: now - RISK_MAX_AGE_MS, expires_at: now + 1 };
  assert.equal(transferVerification(t, e, now).status, 'UNKNOWN');
});

test('matching EXCLUDED evidence stays dangerous after expiry and cannot be borrowed by another signal', () => {
  const t = transfer(), old = { ...evidence(t, 'EXCLUDED'), checked_at: now - 86400000, expires_at: now - 86000000 };
  const r = transferVerification(t, old, now);
  assert.equal(r.status, 'EXCLUDED'); assert.equal(r.expires_at, null); assert.equal(r.positive_confirmation_allowed, false);
  assert.equal(transferVerification(transfer(2), old, now).status, 'UNKNOWN');
});

test('aggregate and every individual JSON/Markdown status agree, including after the first five details', () => {
  const ts = Array.from({ length: 7 }, (_, i) => transfer(i + 1)), input = whales(ts), map = new Map();
  map.set(transferSubject(ts[0]), evidence(ts[0]));
  map.set(transferSubject(ts[6]), { ...evidence(ts[6], 'EXCLUDED'), expires_at: now - 1 });
  const result = JSON.parse(JSON.stringify(withWhaleVerification(input, now, map))), md = markdown(result);
  assert.equal(result.verification.status, 'EXCLUDED');
  assert.deepEqual(result.verification.counts, { CHECKED: 1, UNKNOWN: 5, EXCLUDED: 1 });
  assert.equal(result.verification.observed_transfers, 7);
  assert.equal(result.verification.positive_confirmation_allowed, false);
  assert.match(md, /검사 확인 1건 · 판정 불가 5건 · 위험 1건/);
  result.transfers.forEach((t, i) => assert.match(md.split('\n').find(line => line.includes(`관측 #${i + 1}:`)), new RegExp(`위험 검사 ${t.verification.status}`)));
  assert.equal(md.split('\n').filter(line => /SYNTHETIC_WATCH/.test(line)).length, 5, 'no additional detailed addresses beyond legacy five');
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_EVIDENCE'), 'evidence identity is not public');
  assert.ok(!JSON.stringify(result).includes('source_verified'), 'trusted input marker is not public');
});

test('empty healthy window and unavailable collection differ but neither is CHECKED or a safe zero', () => {
  const empty = withWhaleVerification(whales([]), now), failed = withWhaleVerification({ ...whales([]), errors: ['SYNTHETIC_UNAVAILABLE'] }, now);
  assert.equal(empty.verification.status, 'UNKNOWN'); assert.equal(failed.verification.status, 'UNKNOWN');
  assert.equal(empty.verification.reason, 'NO_OBSERVATIONS_IN_WINDOW'); assert.equal(failed.verification.reason, 'OBSERVATIONS_UNAVAILABLE');
  assert.equal(empty.verification.observation_status, 'EMPTY'); assert.equal(failed.verification.observation_status, 'PARTIAL');
  for (const x of [empty, failed]) { assert.equal(x.verification.observed_transfers, 0); assert.match(markdown(x), /판정 불가/); }
});

test('partial collection cannot promote a checked subset to an aggregate confirmation', () => {
  const t = transfer(), r = withWhaleVerification({ ...whales([t]), errors: ['SYNTHETIC_GAP'] }, now, new Map([[transferSubject(t), evidence(t)]]));
  assert.equal(r.transfers[0].verification.status, 'CHECKED'); assert.equal(r.verification.status, 'UNKNOWN');
  assert.equal(r.verification.positive_confirmation_allowed, false);
});

test('legacy observations without a verification contract display UNKNOWN instead of disappearing', () => {
  const md = markdown(whales([transfer()]));
  assert.match(md, /관측 #1:/); assert.match(md, /위험 검사 UNKNOWN/); assert.match(md, /判定|판정 불가/);
});

test('render boundary fails closed for partial, malformed, future and expired legacy projections', () => {
  const t = transfer(), checked = transferVerification(t, evidence(t), now);
  for (const value of [undefined, null, {}, { status: 'CHECKED' }, { ...checked, checked_at: undefined }, { ...checked, checked_at: now + 1 },
    { ...checked, expires_at: now }, { ...checked, expires_at: Infinity }, { ...checked, checked_at: Number.MAX_SAFE_INTEGER },
    { ...checked, positive_confirmation_allowed: true }, { ...checked, scope: 'unrecognized' }]) {
    assert.equal(displayVerification(value, now).status, 'UNKNOWN');
    assert.match(verificationText(value, now), /판정 불가/);
    const w = whales([{ ...t, verification: value }]);
    w.verification = checked;
    const md = markdown(w);
    assert.match(md, /판정 불가 1건/);
    assert.doesNotMatch(md, /위험 검사 CHECKED/);
  }
  const negative = transferVerification(t, { ...evidence(t, 'EXCLUDED'), checked_at: now - 86400000 }, now);
  assert.equal(displayVerification(negative, now + 86400000).status, 'EXCLUDED');
  assert.match(verificationText(negative, now + 86400000), /위험 검사 EXCLUDED/);
});

test('first five legacy Markdown detail prefixes and order are preserved before the additive suffix', () => {
  const ts = Array.from({ length: 7 }, (_, i) => ({ ...transfer(i + 1), wallet: `SYNTHETIC_${i + 1}`, at: `2030-12-31T23:${55 + i < 60 ? 55 + i : 59}:00.000Z`, direction: i % 2 ? 'in' : 'out' }));
  const md = markdown(withWhaleVerification(whales(ts), now)), lines = md.split('\n');
  const prefixes = [
    '  - 23:55Z SYNTHETIC_1 → SYNTHETIC_EXCHANGE · ETH 2.0M USD',
    '  - 23:56Z SYNTHETIC_2 ← SYNTHETIC_EXCHANGE · ETH 2.0M USD',
    '  - 23:57Z SYNTHETIC_3 → SYNTHETIC_EXCHANGE · ETH 2.0M USD',
    '  - 23:58Z SYNTHETIC_4 ← SYNTHETIC_EXCHANGE · ETH 2.0M USD',
    '  - 23:59Z SYNTHETIC_5 → SYNTHETIC_EXCHANGE · ETH 2.0M USD',
  ];
  const indices = prefixes.map((prefix, i) => {
    const index = lines.findIndex(line => line.startsWith(prefix + ` · 관측 #${i + 1}: `));
    assert.ok(index >= 0, 'legacy detail prefix must remain byte-for-byte before its suffix');
    return index;
  });
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  for (const i of [6, 7]) assert.ok(lines.some(line => line.startsWith(`  - 관측 #${i}: [위험 검사 UNKNOWN]`)));
  assert.ok(!md.includes('SYNTHETIC_6') && !md.includes('SYNTHETIC_7'));
});
