// 거래소 공지 묶음 (feed/announcements.json). 공개 API만, 키 없음.
// Grok 서버에서 막히는 출처를 GitHub 서버가 대신 모아 둔다 (2026-11-14 접속 점검 기준).
//   바이낸스 공지(신규 상장·상장 폐지), 빗썸 공지 API, 코인베이스 상품 목록(새 상품 감지)
//   업비트는 GitHub 서버에서 403이라 넣지 않는다 (Grok Bot이 직접 확인).
// 한 출처가 실패해도 나머지는 그대로 싣고, 실패는 errors에 남긴다.

const H = 3600000;
export const KEEP_DAYS = 7;

export const BINANCE_CATALOGS = [
  [48, 'listing'], // New Cryptocurrency Listing
  [161, 'delisting'], // Delisting
];
const BINANCE_LIST = (id) => `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${id}&pageNo=1&pageSize=15`;
const BITHUMB = 'https://api.bithumb.com/v1/notices?count=20';
const COINBASE = 'https://api.exchange.coinbase.com/products';

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; crypto-os-feed)', accept: 'application/json' };

/** 제목에서 코인 티커 뽑기: "(XYZ)" 또는 "XYZ/USDT" 꼴. 너무 흔한 단어는 뺀다. */
const NOT_TICKERS = new Set(['USDT', 'USDC', 'FDUSD', 'KRW', 'BTC', 'USD', 'TRY', 'EUR', 'BRL', 'API', 'NFT', 'AI', 'APR', 'BNB', 'HODLER']);
export function tickersIn(title) {
  const out = new Set();
  for (const m of String(title ?? '').matchAll(/\(([A-Z0-9]{2,15})\)|\b([A-Z0-9]{2,15})\/(?:USDT|USDC|KRW|BTC|FDUSD)\b|\b([A-Z0-9]{2,15}?)(?:USDT|USDC)\b/g)) {
    const t = m[1] ?? m[2] ?? m[3];
    if (!NOT_TICKERS.has(t) && /[A-Z]/.test(t)) out.add(t);
  }
  return [...out];
}

function toIso(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : '+09:00'));
  if (!Number.isFinite(n)) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

export function parseBinance(json, kind) {
  const articles = json?.data?.catalogs?.[0]?.articles ?? json?.data?.articles;
  if (!Array.isArray(articles)) throw new Error('unexpected Binance announcement response');
  return articles.map((a) => ({
    source: 'binance',
    kind,
    title: a.title,
    url: a.code ? `https://www.binance.com/en/support/announcement/${a.code}` : null,
    published_at: toIso(a.releaseDate),
    tickers: tickersIn(a.title),
  }));
}

/** 빗썸 공지 API. 필드 이름이 바뀌어도 버티도록 후보를 여러 개 본다. 시각에 시간대가 없으면 KST로 본다. */
export function parseBithumb(json) {
  const list = Array.isArray(json) ? json : json?.data ?? json?.notices;
  if (!Array.isArray(list)) throw new Error('unexpected Bithumb notice response');
  return list.map((n) => {
    const title = n.title ?? n.subject ?? '';
    const cats = Array.isArray(n.categories) ? n.categories.join(',') : n.category ?? '';
    return {
      source: 'bithumb',
      kind: /폐지|종료/.test(title) ? 'delisting' : /유의|경고|주의/.test(title) ? 'warning' : /원화 마켓|신규|추가|오픈|상장/.test(title) ? 'listing' : 'notice',
      category: String(cats).trim() || null,
      title,
      url: n.pc_url ?? n.url ?? n.link ?? n.mobile_url ?? null,
      published_at: toIso(n.published_at ?? n.publishedAt ?? n.created_at ?? n.date ?? n.modified_at),
      tickers: tickersIn(title),
    };
  });
}

/** 코인베이스 상품 목록 → 이전 실행에 없던 상품을 새 상품으로. 처음 실행이면 기준선만 만든다. */
export function coinbaseNew(products, prevIds, nowIso) {
  if (!Array.isArray(products)) throw new Error('unexpected Coinbase products response');
  const ids = products.map((p) => p.id).filter(Boolean).sort();
  if (!Array.isArray(prevIds) || !prevIds.length) return { ids, items: [], baseline: true };
  const prev = new Set(prevIds);
  const items = products
    .filter((p) => p.id && !prev.has(p.id))
    .map((p) => ({
      source: 'coinbase',
      kind: 'listing',
      title: `Coinbase 새 상품 ${p.id} (상태 ${p.status ?? '?'}${p.trading_disabled ? ', 거래 중지' : ''}${p.auction_mode ? ', 경매 모드' : ''})`,
      url: `https://exchange.coinbase.com/trade/${p.id}`,
      published_at: nowIso, // 공개 시각이 없어서 처음 본 시각
      tickers: p.base_currency ? [p.base_currency] : [],
    }));
  return { ids, items, baseline: false };
}

const keyOf = (it) => `${it.source}|${it.url ?? it.title}`;

/** 이전 파일과 합쳐 7일치만 남기고, 이번에 처음 본 항목에 is_new=true(첫 실행은 전부 false). 최신순. */
export function mergeItems(prevItems, fresh, now, firstRun = false) {
  const nowIso = new Date(now).toISOString();
  const byKey = new Map();
  for (const it of prevItems ?? []) byKey.set(keyOf(it), { ...it, is_new: false });
  const seenNow = new Set();
  for (const it of fresh) {
    const k = keyOf(it);
    if (seenNow.has(k)) continue; // 같은 실행에서 두 번 온 공지(여러 카탈로그)는 처음 것만
    seenNow.add(k);
    const old = byKey.get(k);
    byKey.set(k, old ? { ...it, first_seen_at: old.first_seen_at, is_new: false } : { ...it, first_seen_at: nowIso, is_new: !firstRun });
  }
  const cutoff = now - KEEP_DAYS * 24 * H;
  return [...byKey.values()]
    .filter((it) => Date.parse(it.published_at ?? it.first_seen_at) >= cutoff)
    .sort((a, b) => Date.parse(b.published_at ?? b.first_seen_at) - Date.parse(a.published_at ?? a.first_seen_at));
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export async function buildAnnouncements({ prev, now = Date.now(), fetchImpl = globalThis.fetch }) {
  const nowIso = new Date(now).toISOString();
  const errors = [];
  const fresh = [];
  const ok = [];
  for (const [id, kind] of BINANCE_CATALOGS) {
    try {
      fresh.push(...parseBinance(await getJson(BINANCE_LIST(id), fetchImpl), kind));
      ok.push(`binance:${kind}`);
    } catch (e) {
      errors.push(`binance ${kind}: ${e?.message ?? e}`);
    }
  }
  try {
    fresh.push(...parseBithumb(await getJson(BITHUMB, fetchImpl)));
    ok.push('bithumb');
  } catch (e) {
    errors.push(`bithumb: ${e?.message ?? e}`);
  }
  let coinbaseIds = prev?.coinbase_product_ids ?? [];
  let coinbaseBaseline = false;
  try {
    const r = coinbaseNew(await getJson(COINBASE, fetchImpl), coinbaseIds, nowIso);
    fresh.push(...r.items);
    coinbaseIds = r.ids;
    coinbaseBaseline = r.baseline;
    ok.push('coinbase');
  } catch (e) {
    errors.push(`coinbase: ${e?.message ?? e}`);
  }
  const items = mergeItems(prev?.items, fresh, now, !prev);
  return {
    schema_version: 1,
    generated_at: nowIso,
    note: '거래소 공지 묶음. 매시간 GitHub 서버에서 모은다. is_new=true는 이번 실행에서 처음 본 항목. 업비트는 여기 없음(GitHub 서버에서 막힘) → 직접 확인. tickers는 제목에서 뽑은 추정값이라 틀릴 수 있음.',
    sources_ok: ok,
    errors,
    coinbase_baseline_run: coinbaseBaseline,
    new_count: items.filter((x) => x.is_new).length,
    items,
    coinbase_product_ids: coinbaseIds,
  };
}
