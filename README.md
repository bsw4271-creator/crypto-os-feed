# crypto-os-feed

Crypto OS의 **공개 브리핑 피드**입니다. 그록봇 등 AI가 링크 하나로 시장 상태를 읽을 수 있게, 매시간 자동으로 갱신됩니다.

- 피드(JSON): https://raw.githubusercontent.com/bsw4271-creator/crypto-os-feed/main/feed/feed.json
- 피드(표): https://raw.githubusercontent.com/bsw4271-creator/crypto-os-feed/main/feed/feed.md
- 매매 규칙서: https://raw.githubusercontent.com/bsw4271-creator/crypto-os-feed/main/rules.md

## 담는 것 / 담지 않는 것
- 담는 것: 바이낸스 현물 공개 시세로 계산한 1시간 봉 지표(RSI·MACD·볼린저·EMA/SMA), 24시간·7일 등락, 모의매매 4가지 전략의 현재 신호, 단순 시장 국면, **데이터 품질 표시**
- 자금 흐름(`flows`): 스테이블코인(USDT·USDC 등) 공급량과 1일·7일·30일 변화(DefiLlama), Hyperliquid 선물 미결제약정(OI)의 직전 실행 대비 변화와 직전 펀딩비. 참고 신호이며 큰 자금 이동이 곧 매수·매도를 뜻하지는 않습니다.
- 큰 지갑 이동(`flows.whales`): 이더리움 메인넷에서 지켜보는 공개 지갑(`config/wallets.json`)의 100만 달러 이상 ETH·USDT·USDC·WETH·WBTC 이동. 상대가 알려진 거래소 지갑이면 "거래소로/거래소에서"로 표시합니다. 이름표는 Etherscan 공개 라벨로 확인한 것만 넣습니다. 무료 Etherscan 키(저장소 비밀값 `ETHERSCAN_API_KEY`)를 쓰며 키는 피드에 기록되지 않습니다.
- 담지 않는 것: 소유자 보유 내역·지갑 주소, API 키, 주문 기능. 이 저장소는 공개라 누구나 볼 수 있습니다.

## 종목
- 고정 5개: BTC, ETH, SOL, HYPE, ZRO
- 자동 10개: Hyperliquid 선물 24시간 거래대금 상위 10개(고정 종목 제외), 매시간 다시 고름. 바이낸스 현물에 같은 이름이 있으면 바이낸스 1시간 봉, 없으면 Hyperliquid 선물 1시간 봉(`venue: Hyperliquid`)으로 지표를 계산합니다. 2026-10-22부터이며, 이전 규칙(바이낸스 상장 1년 이상)은 비공개 모의매매 저장소에만 남아 있습니다.
- 전체 선물 목록(`hyperliquid.perps_all`): Hyperliquid에서 지금 거래할 수 있는 모든 선물의 가격·펀딩비·미결제약정·거래대금·최대 레버리지

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

## 큰 지갑 관측의 독립 위험 검사 계약

`flows.whales.verification`과 모든 `transfers[].verification`을 기존 필드에 추가합니다. `schema_version: 1`, 기존 거래량·이동·시장·전략 필드는 유지합니다. 상태는 `CHECKED`(제한 범위 검사 확인), `UNKNOWN`(판정 불가), `EXCLUDED`(위험)입니다. 이동 관측은 `UNKNOWN`이어도 JSON·Markdown과 건수에 남습니다. 건수 단위는 지갑 수가 아닌 이동 관측 수입니다. 자료가 없거나 수집이 실패한 경우도 정상/안전 판정으로 바꾸지 않습니다.

현재 피드에는 OS 독립 위험 검사와 Smart Money 확인 규칙을 연결하는 인증된 어댑터가 **없습니다**. 따라서 실제 생성기는 기존 수집 결과에 `UNKNOWN`, `positive_confirmation_allowed: false`를 붙입니다. 지갑 이름표, Etherscan 조회 성공, 시장 `risk_on`, 시세 `quality: ok`는 독립 위험 검사가 아닙니다. `CHECKED`도 안전 보증이나 긍정 매매 확인이 아닙니다. 기존 기술적 전략의 `entry_now`는 독립 위험 확인을 뜻하지 않습니다.

이번 계약 범위는 큰 지갑 이동 `flows.whales`입니다. 시세 기반 RSI·MACD 등 `symbols[].signals`, 스테이블코인 공급량, OI 변화는 별도 관측이며 Smart Money 위험 검사나 지갑 추종 신호로 재분류하지 않습니다.

`lib/signal-verification.mjs`의 선택적 Map 인자는 네트워크·파일 입력이 없는 **오프라인 계약 검증** 용도입니다. 계약 이름, 출처 검증 표시, 불투명 근거 ID, 정확한 개별 관측 주체, 원검사 시각과 5분 이내 만료를 확인합니다. 이 함수는 출처를 인증하지 않습니다. 향후 인증된 생산자 연결은 별도 설계·검토가 필요하며, 현재 생성기는 이 인자를 전달하지 않습니다. 일치하는 과거 `EXCLUDED`는 만료만으로 해제하지 않습니다. 출처가 확인된 새 정상 검사가 같은 주체의 이전 위험을 대체해야 합니다. 원근거·주체 식별·추가 주소는 공개 `verification`에 넣지 않습니다.

개별·합계 모두 `status`, `label`, `scope`, `reason`, `checked_at`, `expires_at`, `positive_confirmation_allowed`를 전달합니다. 합계는 `counts`, `observed_transfers`, `count_unit`, `observation_status`를 추가합니다. 빈 관측과 수집 오류는 서로 다른 이유를 전달하고 모두 `UNKNOWN`입니다. Markdown은 합계와 모든 개별 관측 번호의 상태를 표시하며 기존 상세 표본 5개 제한은 유지합니다. 계약이 없는 이전 JSON은 `UNKNOWN`으로 해석해야 합니다. 소비자는 원검사 만료·누락을 확인해야 하며, 현재 확인 규칙이 연결되지 않았으므로 긍정 확인은 항상 보류합니다.
