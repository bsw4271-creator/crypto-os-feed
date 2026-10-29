# config/catalysts.json — 대형 공식 호재 목록 (규칙서 3-0-4)

**Catalyst Monitor가 CONFIRMED로 기록한 신호만** 넣는다. 그록봇은 이 파일을 쓰지 않는다(쓰기 권한 없음).
피드가 매시간 시장 확인(발표 후 24h 상승률이 시장 중앙값보다 5%p 이상, 발표 시간봉 거래량 3배 이상)과
유효기간(72시간)·진입 구간·손절 기준을 계산해 `feed.json`의 `major_catalyst.items`에 싣는다.

```json
[
  {
    "id": "Catalyst Monitor 신호 ID",
    "coin": "HYPE",
    "announced_at": "2026-10-29T11:25:00Z",
    "kind": "final_contract",
    "title": "한 줄 요약",
    "counterparty": "상대 기관",
    "source_url": "https://공식 발표 링크",
    "confirmed_by": "Catalyst Monitor",
    "status": "CONFIRMED"
  }
]
```

- `coin`: 하이퍼리퀴드 선물 이름(perps_all의 name)
- `announced_at`: **공식 발표** 시각(UTC). 1급 매체 보도가 먼저였으면 그 보도 시각을 쓰되, 6시간 안에 공식 발표가 있어야 함
- `kind`: `final_contract`, `launch`, `listing`, `buyback_burn`, `regulatory_approval` 중 하나
