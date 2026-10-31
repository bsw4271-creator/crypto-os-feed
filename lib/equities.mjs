// 하이퍼리퀴드 HIP-3 trade.xyz 주식 선물 (규칙서 1-2, rules-6.8). 순수 함수 + 조회.
// 이름은 "xyz:NVDA" 형식. 주문·캔들 모두 이 이름을 그대로 쓴다.

export const XYZ_DEX = 'xyz';
// 주식이 아닌 xyz 마켓(지수·원자재·통화). 여기 없는 이름은 주식으로 본다.
export const NON_EQUITY = new Set([
  'SP500', 'XYZ100', 'US500', 'NDX', 'DJI', 'RUSSELL', 'VIX', 'DXY',
  'GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'COPPER', 'CL', 'WTI', 'BRENTOIL', 'NATGAS', 'URANIUM', 'CORN', 'WHEAT', 'SOY', 'COFFEE', 'COCOA', 'SUGAR',
  'JPY', 'EUR', 'GBP', 'CNH', 'CHF', 'AUD', 'CAD', 'KRW',
]);
export const INDEX_FOR_REGIME = ['XYZ100', 'SP500', 'US500'];

const num = (v) => {
  const x = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(x) ? null : x;
};
const gap = (a, b) => (a !== null && b !== null && b !== 0 ? Number((((a - b) / b) * 100).toFixed(3)) : null);
export const bare = (name) => String(name).replace(/^[a-z0-9]+:/i, '');

/** metaAndAssetCtxs(dex: xyz) → 마켓 목록 */
export function parseXyz(raw) {
  if (!Array.isArray(raw) || raw.length !== 2 || !Array.isArray(raw[0]?.universe) || !Array.isArray(raw[1]))
    throw new Error('unexpected xyz metaAndAssetCtxs shape');
  const [meta, ctxs] = raw;
  const out = [];
  meta.universe.forEach((u, i) => {
    if (!u || typeof u.name !== 'string' || u.isDelisted) return;
    const c = ctxs[i] ?? {};
    const mark = num(c.markPx),
      mid = num(c.midPx),
      oracle = num(c.oraclePx),
      f = num(c.funding);
    const ticker = bare(u.name);
    out.push({
      name: u.name.includes(':') ? u.name : `${XYZ_DEX}:${u.name}`,
      ticker,
      asset_class: NON_EQUITY.has(ticker) ? 'index_commodity_fx' : 'equity',
      mark,
      mid,
      oracle_px: oracle,
      mark_vs_oracle_pct: gap(mid ?? mark, oracle),
      funding_1h: f,
      funding_annual_pct: f === null ? null : Math.round(f * 24 * 365 * 10000) / 100,
      day_volume_usd: num(c.dayNtlVlm) === null ? null : Math.round(num(c.dayNtlVlm)),
      open_interest_usd: num(c.openInterest) !== null && mark !== null ? Math.round(num(c.openInterest) * mark) : null,
      max_leverage: num(u.maxLeverage),
      only_isolated: Boolean(u.onlyIsolated),
      margin_mode: u.marginMode ?? (u.onlyIsolated ? 'isolated' : 'cross'),
      growth_mode: u.growthMode ?? null,
    });
  });
  return out.sort((a, b) => (b.day_volume_usd ?? 0) - (a.day_volume_usd ?? 0) || a.name.localeCompare(b.name));
}

/**
 * 미국 주식 세션. 외부(external): 실제 주가를 오라클로 씀. 내부(internal): 금 20:00 ET ~ 일 20:05 ET, xyz 자체 호가.
 * (미국 공휴일은 반영하지 않음 — 규칙서에 적어 둠)
 */
export function equitySession(nowMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value]),
  );
  const wd = parts.weekday;
  const mins = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const internal = (wd === 'Fri' && mins >= 20 * 60) || wd === 'Sat' || (wd === 'Sun' && mins < 20 * 60 + 5);
  return { session: internal ? 'weekend' : 'weekday', price_source: internal ? 'internal(xyz 자체 호가)' : 'external(실제 주가)', et: `${wd} ${parts.hour}:${parts.minute}` };
}

/** 주식 시장 국면: 지수(XYZ100 등) 7일 변화 + 주식 종목 24h 상승 비율. 코인 국면과 같은 기준 */
export function equityRegime(indexBrief, equityBriefs) {
  const usable = equityBriefs.filter((x) => x && (x.quality === 'ok' || x.quality === 'fallback') && Number.isFinite(x.change_24h_pct));
  const up = usable.filter((x) => x.change_24h_pct > 0).length;
  const share = usable.length ? up / usable.length : null;
  const idx7 = indexBrief?.change_7d_pct ?? null;
  let regime = 'unknown';
  if (idx7 !== null && share !== null) regime = idx7 > 0 && share >= 0.6 ? 'risk_on' : idx7 < 0 && share <= 0.4 ? 'risk_off' : 'neutral';
  return {
    regime,
    regime_rule: 'risk_on: 지수 7d > 0 이고 주식 종목 60% 이상 24h 상승 / risk_off: 지수 7d < 0 이고 40% 이하 상승 / 그 밖 neutral / 지수 없으면 unknown',
    index: indexBrief?.symbol ?? null,
    index_change_7d_pct: idx7,
    index_change_24h_pct: indexBrief?.change_24h_pct ?? null,
    breadth_24h_up: usable.length ? `${up}/${usable.length}` : null,
  };
}

/** 지수·원자재·통화의 자체 국면: 7일 변화와 ema9/sma9로 정한다. up | down | range | unknown */
export function ownRegime(brief) {
  const c7 = brief?.change_7d_pct;
  const emaUp = brief?.indicators_1h?.ema_above_sma;
  if (!Number.isFinite(c7) || emaUp === null || emaUp === undefined) return 'unknown';
  if (c7 > 0 && emaUp) return 'up';
  if (c7 < 0 && !emaUp) return 'down';
  return 'range';
}
