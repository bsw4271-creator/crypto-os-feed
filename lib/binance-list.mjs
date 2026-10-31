// 바이낸스 상장 자산 목록 (규칙서 §2-4 "바이낸스 미상장 종목" 판정용). 공개 API, 키 없음.
// 현물은 data-api.binance.vision(피드가 이미 쓰는 주소), 선물은 fapi(지역에 따라 막힐 수 있음 → 실패하면 현물만).
const QUOTES = ['USDT', 'USDC', 'FDUSD'];

/** exchangeInfo 응답 → 거래 중인 기준 자산 이름 Set */
export function basesFrom(info) {
  const out = new Set();
  for (const s of info?.symbols ?? []) {
    if (s.status !== 'TRADING') continue;
    if (!QUOTES.includes(s.quoteAsset)) continue;
    let base = s.baseAsset;
    const m = /^1000+([A-Z0-9]+)$/.exec(base); // 선물의 1000PEPE 같은 이름
    if (m) base = m[1];
    out.add(base);
  }
  return out;
}

export async function fetchBinanceBases(fetchImpl = globalThis.fetch) {
  const set = new Set();
  const sources = [];
  const errors = [];
  const tries = [
    ['spot', 'https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT'],
    ['futures', 'https://fapi.binance.com/fapi/v1/exchangeInfo'],
  ];
  for (const [name, url] of tries) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const b of basesFrom(await res.json())) set.add(b);
      sources.push(name);
    } catch (e) {
      errors.push(`${name}: ${e?.message ?? e}`);
    }
  }
  return { set: sources.length ? set : null, sources, errors };
}
