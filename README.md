# crypto-os-feed

Crypto OS의 **공개 브리핑 피드**입니다. 그록봇 등 AI가 링크 하나로 시장 상태를 읽을 수 있게, 매시간 자동으로 갱신됩니다.

- 피드(JSON): https://raw.githubusercontent.com/bsw4271-creator/crypto-os-feed/main/feed/feed.json
- 피드(표): https://raw.githubusercontent.com/bsw4271-creator/crypto-os-feed/main/feed/feed.md
- 매매 규칙서: https://raw.githubusercontent.com/bsw4271-creator/crypto-os-feed/main/rules.md

## 담는 것 / 담지 않는 것
- 담는 것: 바이낸스 현물 공개 시세로 계산한 1시간 봉 지표(RSI·MACD·볼린저·EMA/SMA), 24시간·7일 등락, 모의매매 4가지 전략의 현재 신호, 단순 시장 국면, **데이터 품질 표시**
- 자금 흐름(`flows`): 스테이블코인(USDT·USDC 등) 공급량과 1일·7일·30일 변화(DefiLlama), Hyperliquid 선물 미결제약정(OI)의 직전 실행 대비 변화와 직전 펀딩비. 참고 신호이며 큰 자금 이동이 곧 매수·매도를 뜻하지는 않습니다.
- 담지 않는 것: 보유 내역, 지갑 주소, API 키, 주문 기능. 이 저장소는 공개라 누구나 볼 수 있습니다.

## 종목
- 고정 5개: BTC, ETH, SOL, HYPE, ZRO
- 자동 10개: 매일 00:00 UTC 기준, 상장 1년 이상·스테이블코인 제외·30일 평균 거래대금 상위 10개 (모의매매 자동 선정 규칙과 같음)

## 데이터 품질 (`quality`)
| 값 | 뜻 |
|---|---|
| ok | 바이낸스 데이터, 마지막 봉이 150분 이내 |
| fallback | 바이낸스 실패로 Gate.io 사용. 가격이 조금 다를 수 있음 |
| stale | 마지막 봉이 150분보다 오래됨. 판단에 쓰지 말 것 |
| error | 데이터 없음 |

## 주의
분석 참고용 데이터입니다. 매매 신호나 투자 권유가 아니며, 데이터가 늦거나 틀릴 수 있습니다.

## 구조
- `feed.mjs` — 피드 생성 (GitHub Actions가 매시간 17분에 실행)
- `lib/` — 지표·백테스트 엔진 (crypto-backtester와 같은 코드), `lib/brief.mjs` — 피드 항목 계산
- `strategies/` — 모의매매와 같은 전략 4개
- `tests/` — `node --test`
