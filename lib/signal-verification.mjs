// Pure projection of already collected observations. No I/O, source adapter or
// positive Smart Money confirmation engine is connected by this module.
export const RISK_MAX_AGE_MS = 5 * 60000;
export const EVIDENCE_CONTRACT = 'crypto-os.independent-risk.v1';
export const VERIFICATION_LABELS = { CHECKED: '제한 범위 검사 확인', UNKNOWN: '판정 불가', EXCLUDED: '위험' };
const validTime = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const REASONS = new Set(['INDEPENDENT_RISK_EVIDENCE_MISSING', 'INDEPENDENT_RISK_EVIDENCE_INVALID', 'INDEPENDENT_RISK_RECORDED',
  'INDEPENDENT_RISK_CHECK_INCOMPLETE', 'INDEPENDENT_RISK_EVIDENCE_EXPIRED', 'INDEPENDENT_RISK_LIMITED_CHECK',
  'OBSERVATIONS_UNAVAILABLE', 'NO_OBSERVATIONS_IN_WINDOW', 'PARTIAL_OBSERVATIONS', 'INDEPENDENT_RISK_EVIDENCE_MISSING_OR_INCOMPLETE', 'VERIFICATION_CONTRACT_MISSING']);
const record = (status, reason, checked_at = null, expires_at = null) => ({
  status, label: VERIFICATION_LABELS[status], scope: 'independent_risk', reason,
  checked_at, expires_at, positive_confirmation_allowed: false,
});

// This exact identity is used only in a caller's offline evidence contract. It
// is never included in the public verification projection or logged.
export function transferSubject(t) {
  return JSON.stringify(['ethereum', t.wallet, t.direction, t.counterparty, t.asset, t.amount, t.usd, t.at, t.tx]);
}

/**
 * Validate a caller-supplied, already source-verified OFFLINE contract. This is
 * not source authentication. A future authenticated adapter is separate work.
 * Live feed.mjs supplies no evidence, so every live transfer remains UNKNOWN.
 * CHECKED is limited risk inspection, never a positive trading confirmation.
 */
export function transferVerification(t, evidence, now) {
  if (!evidence) return record('UNKNOWN', 'INDEPENDENT_RISK_EVIDENCE_MISSING');
  if (!validTime(now) || !evidence || evidence.contract !== EVIDENCE_CONTRACT || evidence.source_verified !== true ||
      typeof evidence.evidence_id !== 'string' || !evidence.evidence_id.trim() || evidence.evidence_id.length > 200 ||
      evidence.subject !== transferSubject(t) || !validTime(evidence.checked_at) || evidence.checked_at > now)
    return record('UNKNOWN', 'INDEPENDENT_RISK_EVIDENCE_INVALID');
  // A matching known negative survives time/cache expiry. Only a future trusted
  // source's newer clean inspection may supersede it; elapsed time cannot.
  if (evidence.status === 'EXCLUDED') return record('EXCLUDED', 'INDEPENDENT_RISK_RECORDED', evidence.checked_at);
  if (evidence.status !== 'CHECKED' || evidence.risk_check_complete !== true)
    return record('UNKNOWN', 'INDEPENDENT_RISK_CHECK_INCOMPLETE');
  if (!validTime(evidence.expires_at) || evidence.expires_at <= evidence.checked_at ||
      evidence.expires_at > evidence.checked_at + RISK_MAX_AGE_MS || now >= evidence.expires_at || now - evidence.checked_at >= RISK_MAX_AGE_MS)
    return record('UNKNOWN', 'INDEPENDENT_RISK_EVIDENCE_EXPIRED');
  return record('CHECKED', 'INDEPENDENT_RISK_LIMITED_CHECK', evidence.checked_at, evidence.expires_at);
}

export function verificationSummary(transfers, errors = []) {
  const counts = { CHECKED: 0, UNKNOWN: 0, EXCLUDED: 0 };
  for (const t of transfers) counts[t.verification.status]++;
  const status = counts.EXCLUDED ? 'EXCLUDED' : !transfers.length || errors.length || counts.UNKNOWN ? 'UNKNOWN' : 'CHECKED';
  const relevant = transfers.filter(t => t.verification.status === status);
  const checked = relevant.map(t => t.verification.checked_at).filter(Number.isFinite);
  const expiry = relevant.map(t => t.verification.expires_at).filter(Number.isFinite);
  return {
    ...record(status, !transfers.length ? (errors.length ? 'OBSERVATIONS_UNAVAILABLE' : 'NO_OBSERVATIONS_IN_WINDOW') :
      errors.length ? 'PARTIAL_OBSERVATIONS' : status === 'UNKNOWN' ? 'INDEPENDENT_RISK_EVIDENCE_MISSING_OR_INCOMPLETE' :
      status === 'EXCLUDED' ? 'INDEPENDENT_RISK_RECORDED' : 'INDEPENDENT_RISK_LIMITED_CHECK',
      checked.length ? Math.max(...checked) : null, status === 'CHECKED' && expiry.length ? Math.min(...expiry) : null),
    observed_transfers: transfers.length, count_unit: 'transfer_observations', counts,
    observation_status: errors.length ? 'PARTIAL' : transfers.length ? 'OBSERVED' : 'EMPTY',
  };
}

/** The optional Map is only for pure offline contract tests; no live adapter reads it. */
export function withWhaleVerification(whales, now, offlineEvidence = new Map()) {
  const transfers = (whales.transfers ?? []).map(t => ({
    ...t, verification: transferVerification(t, offlineEvidence.get(transferSubject(t)), now),
  }));
  return { ...whales, transfers, verification: verificationSummary(transfers, whales.errors ?? []) };
}

/** Legacy JSON without this additive contract must display UNKNOWN. */
export function displayVerification(value, now = Date.now()) {
  const unknown = reason => record('UNKNOWN', reason);
  if (!value || typeof value !== 'object' || value.scope !== 'independent_risk' || value.positive_confirmation_allowed !== false ||
      !['CHECKED', 'UNKNOWN', 'EXCLUDED'].includes(value.status) || !REASONS.has(value.reason))
    return unknown('VERIFICATION_CONTRACT_MISSING');
  if (value.status === 'UNKNOWN') return unknown(value.reason);
  if (!validTime(now) || !validTime(value.checked_at) || value.checked_at > now)
    return unknown('INDEPENDENT_RISK_EVIDENCE_INVALID');
  // Display validation cannot authenticate the source. It can avoid trusting
  // malformed/expired projections while preserving a valid known negative.
  if (value.status === 'EXCLUDED') return record('EXCLUDED', value.reason, value.checked_at);
  if (!validTime(value.expires_at) || value.expires_at <= value.checked_at || value.expires_at > value.checked_at + RISK_MAX_AGE_MS ||
      now >= value.expires_at || now - value.checked_at >= RISK_MAX_AGE_MS)
    return unknown('INDEPENDENT_RISK_EVIDENCE_EXPIRED');
  return record('CHECKED', value.reason, value.checked_at, value.expires_at);
}

export function verificationText(value, now = Date.now()) {
  const v = displayVerification(value, now);
  return `[위험 검사 ${v.status}] ${VERIFICATION_LABELS[v.status]} · 긍정 확인 보류 · 사유 ${v.reason} · 검사 ${v.checked_at === null ? '미확인' : new Date(v.checked_at).toISOString()} · 만료 ${v.expires_at === null ? '해당 없음/미확인' : new Date(v.expires_at).toISOString()}`;
}
