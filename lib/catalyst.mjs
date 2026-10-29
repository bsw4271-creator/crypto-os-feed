// 대형 공식 호재(major_catalyst) 예외 진입 (규칙서 3-0-4, rules-6.5, 소유자 승인 2026-10-29). 순수 함수.
// 판정 a)~c)(공식 출처·실체·규모)는 Catalyst Monitor가 CONFIRMED로 기록한 것만 config/catalysts.json에 넣는다.
// 이 파일은 d) 시장 확인과 유효기간·진입 구간·손절 기준만 계산한다.

export const CATALYST_RULE = {
  valid_hours: 72,
  confirm_window_hours: 24,
  min_excess_pp: 5, // 시장 중앙값 대비 초과 상승 %p
  min_volume_ratio: 3, // 발표 시간봉 거래량 ÷ 직전 24봉 평균
  max_stop_atr: 4.0,
  stop_buffer_atr: 0.1,
  max_loss_usd: 1.0,
  max_leverage: 1,
  min_rr: 1.5,
  allowed_kinds: ['final_contract', 'launch', 'listing', 'buyback_burn', 'regulatory_approval'],
  // 숏(공식 악재, 2026-10-29): 해킹·익스플로잇 공식 확인, 티어1 상장폐지 확정, 규제 제재·기소, 서비스·체인 중단, 계획 밖 대량 발행·해제
  allowed_kinds_short: ['exploit', 'delisting', 'regulatory_action', 'outage', 'unplanned_supply'],
};

const H = 3600000;
const round = (x, d = 6) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(d)));
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 시각 t에 열려 있던(또는 막 닫힌) 봉의 인덱스: 봉 시작 ≤ t < 봉 시작+1h */
const barAt = (bars, t) => bars.findIndex((b) => b.t <= t && t < b.t + H);
/** 시각 t 직전에 닫힌 봉의 종가 */
function closeBefore(bars, t) {
  let c = null;
  for (const b of bars) if (b.t + H <= t) c = b.c;
  return c;
}
function emaLast(values, length = 9) {
  if (values.length < length) return null;
  const k = 2 / (length + 1);
  let e = values.slice(0, length).reduce((s, x) => s + x, 0) / length;
  for (let i = length; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** 설정 항목 형식 검사. 문제 목록(빈 배열이면 정상) */
export function validateCatalyst(c, R = CATALYST_RULE) {
  const errs = [];
  for (const k of ['id', 'coin', 'announced_at', 'kind', 'source_url', 'confirmed_by']) if (!c?.[k]) errs.push(`${k} 없음`);
  if (c?.announced_at && !Number.isFinite(Date.parse(c.announced_at))) errs.push('announced_at 형식 오류');
  const dir = c?.direction ?? 'long';
  if (!['long', 'short'].includes(dir)) errs.push(`direction 목록 밖: ${dir}`);
  const kinds = dir === 'short' ? R.allowed_kinds_short : R.allowed_kinds;
  if (c?.kind && !kinds.includes(c.kind)) errs.push(`kind 목록 밖(${dir}): ${c.kind}`);
  if (c?.confirmed_by && c.confirmed_by !== 'Catalyst Monitor') errs.push('confirmed_by는 Catalyst Monitor만');
  if (c?.status && c.status !== 'CONFIRMED') errs.push(`status가 CONFIRMED 아님: ${c.status}`);
  if (c?.source_url && !/^https:\/\//.test(c.source_url)) errs.push('source_url은 https');
  return errs;
}

/**
 * cat: 설정 항목. coinBars: 그 코인 HL 1h 봉(닫힌 봉, 오래된 것부터, 발표 24봉 전부터).
 * marketBars: 시장 중앙값용 다른 종목들의 1h 봉 배열들. atr: 그 코인 HL 1h ATR14. now: 현재 ms.
 */
export function evaluateCatalyst({ cat, coinBars, marketBars = [], atr = null, now, R = CATALYST_RULE }) {
  const errors = validateCatalyst(cat, R);
  const at = Date.parse(cat.announced_at);
  const expiresAt = at + R.valid_hours * H;
  const out = {
    id: cat.id,
    coin: cat.coin,
    direction: cat.direction ?? 'long',
    kind: cat.kind,
    title: cat.title ?? null,
    counterparty: cat.counterparty ?? null,
    source_url: cat.source_url,
    announced_at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    expires_at: Number.isFinite(at) ? new Date(expiresAt).toISOString() : null,
    active: Number.isFinite(at) && now >= at && now < expiresAt,
    config_errors: errors,
  };
  if (errors.length || !Array.isArray(coinBars) || !coinBars.length) return { ...out, eligible: false, reason: errors.length ? '설정 오류' : '봉 없음' };

  const pre = closeBefore(coinBars, at);
  const ni = barAt(coinBars, at);
  const news = ni >= 0 ? coinBars[ni] : null;
  const windowEnd = Math.min(now, at + R.confirm_window_hours * H);
  const last = closeBefore(coinBars, windowEnd + 1);
  const ret = pre && last ? ((last - pre) / pre) * 100 : null;
  const mkt = median(
    marketBars.map((b) => {
      const p0 = closeBefore(b, at),
        p1 = closeBefore(b, windowEnd + 1);
      return p0 && p1 ? ((p1 - p0) / p0) * 100 : NaN;
    }),
  );
  const prior = ni >= 24 ? coinBars.slice(ni - 24, ni) : coinBars.slice(0, Math.max(0, ni));
  const avgVol = prior.length ? prior.reduce((s, b) => s + b.v, 0) / prior.length : null;
  const volRatio = news && avgVol > 0 ? news.v / avgVol : null;
  const short = (cat.direction ?? 'long') === 'short';
  // 롱: 시장보다 강함, 숏: 시장보다 약함
  const excess = ret !== null && mkt !== null ? (short ? mkt - ret : ret - mkt) : null;
  const confirmed = excess !== null && volRatio !== null && excess >= R.min_excess_pp && volRatio >= R.min_volume_ratio;

  // 진입 구간: EMA9 근처 또는 뉴스 봉 몸통 50%. 손절: 뉴스 봉 저점과 발표 직전 가격 중 높은 쪽(가까운 쪽) − 0.1 ATR
  const closesAfter = coinBars.filter((b) => b.t + H <= now).map((b) => b.c);
  const ema9 = emaLast(closesAfter, 9);
  const bodyMid = news ? (news.o + news.c) / 2 : null;
  // 롱: 뉴스 봉 저점·발표 직전 가격 중 높은 쪽 − 0.1 ATR / 숏: 뉴스 봉 고점·발표 직전 가격 중 낮은 쪽 + 0.1 ATR
  const stopBase = short
    ? news && pre ? Math.min(news.h, pre) : (news?.h ?? pre)
    : news && pre ? Math.max(news.l, pre) : (news?.l ?? pre);
  const stop = stopBase && atr ? stopBase + (short ? 1 : -1) * R.stop_buffer_atr * atr : null;
  const zone = (entry) => {
    if (!(entry && stop && atr)) return null;
    const dist = short ? stop - entry : entry - stop;
    return { entry: round(entry), stop: round(stop), distance_atr: round(dist / atr, 3), too_wide: dist / atr > R.max_stop_atr, stop_wrong_side: dist <= 0 };
  };

  const eligible = out.active && confirmed;
  return {
    ...out,
    pre_announce_price: round(pre),
    news_bar: news ? { open_at: new Date(news.t).toISOString(), open: round(news.o), high: round(news.h), low: round(news.l), close: round(news.c), body_mid: round(bodyMid) } : null,
    confirm: {
      window_end: new Date(windowEnd).toISOString(),
      window_complete: windowEnd === at + R.confirm_window_hours * H,
      return_pct: round(ret, 4),
      market_median_pct: round(mkt, 4),
      excess_pp: round(excess, 4),
      volume_ratio: round(volRatio, 4),
      market_confirmed: confirmed,
    },
    atr14: round(atr),
    ema9: round(ema9),
    entry_zones: { ema9: zone(ema9), body_mid: zone(bodyMid) },
    eligible,
    reason: !out.active ? (now < at ? '발표 전' : '유효기간 지남') : !confirmed ? '시장 확인(d) 미충족' : null,
  };
}
