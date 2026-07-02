# Renaiss Slab King — 기술 명세서 (Tech Spec)

> 본 문서는 [`PROPOSAL.md`](./PROPOSAL.md)의 기획을 구현 관점으로 옮긴 기술 명세서입니다.
> 대상 독자는 해커톤 개발팀이며, 범위는 **직접 플레이 가능한 웹 데모**입니다.
> 카드 시세·등급 데이터는 Renaiss OS Index 공개 API(`https://api.renaissos.com`)를 출처로 사용합니다.
> API 레퍼런스: [`https://index.renaissos.com/api-docs`](https://index.renaissos.com/api-docs) · Swagger `https://api.renaissos.com/docs` · OpenAPI `https://api.renaissos.com/v1/openapi.json` (v1.0.0, 2026-07 기준 실제 스펙 검증 완료).

---

## 0. 가정 및 결정 사항 (Assumptions)

기획서에 명시되지 않아 합리적 기본값으로 결정한 항목입니다. 팀 합의에 따라 변경 가능합니다.

| 항목 | 결정 | 근거 |
| --- | --- | --- |
| 프런트엔드 | React + TypeScript + Vite, 캔버스 렌더링은 PixiJS | 보드 렌더·연결선 애니메이션에 WebGL 가속 필요, 생산성 |
| 실시간 통신 | WebSocket (Socket.IO) | 방/매칭 동기화에 양방향 저지연 필요 |
| 백엔드 | Node.js + TypeScript (Fastify) | 프런트와 언어 통일, Renaiss API 프록시/캐시 서버 겸용 |
| 상태 저장 | 인메모리(해커톤) → Redis(확장) | 데모는 단일 인스턴스로 충분 |
| 권위(authority) 모델 | 서버 권위(server-authoritative) | 멀티플레이 치팅·동기화 일관성 확보 |
| 인증 | 데모는 게스트 닉네임, 추가 범위에서 X·Web3 지갑 | 기획 "여유 시 지갑 연동" 반영 |
| 데이터 | 데모는 예시 카드 풀, 추가 범위에서 실제 API 연동 | 기획 안전·저작권 3항 |

---

## 1. 개요 및 목표

Renaiss Slab King은 **사천성(Shisen-Sho) 방식의 실시간 카드 짝맞추기 퍼즐**이다. 플레이어는 화면에 깔린 카드 타일 중 같은 카드 두 장을, 꺾임이 적은 경로로 연결해 제거한다. 제거되는 카드는 실제 Renaiss에 등록된 포켓몬·원피스 수집 카드이며, 플레이 중 도감에 누적되어 카드의 등급·시세·소유 개념을 자연스럽게 학습시키고 Renaiss 마켓 전환으로 이어준다.

기술적 성공 기준:

1. 4인까지 동시 플레이 가능한 실시간 방 시스템이 동작한다.
2. 짝 연결 판정(꺾임 ≤ 2회)이 서버에서 권위적으로 검증된다.
3. 교착(더 이상 제거할 짝 없음) 자동 감지 및 재섞기가 동작한다.
4. 5종 맵 모드 중 최소 "일반"이 완성되고 나머지는 모듈로 확장 가능하다.
5. 도감 3단계 도슨트(한 줄 미리보기 → 자세히 보기 → 판 종료 요약)와 마켓 링크가 동작한다.
6. 카드 시세·등급 숫자는 임의 생성 없이 Renaiss API에서 가져오며 출처를 표기한다.

---

## 2. 시스템 아키텍처

```
┌──────────────┐    WebSocket(게임)     ┌─────────────────────┐
│  Web Client  │◄──────────────────────►│   Game Server       │
│ React+Pixi   │    REST(로비/도감)      │   Fastify + Socket   │
│              │◄──────────────────────►│   - 방/매치 권위 상태  │
└──────────────┘                        │   - 보드 생성/판정     │
       │                                │   - 점수/콤보/아이템   │
       │ REST(이미지/도감 메타)           └──────────┬──────────┘
       ▼                                           │ 서버사이드 호출
┌──────────────┐                         ┌─────────▼──────────┐
│ Renaiss CDN  │  카드 이미지(webp)        │ Renaiss API Proxy   │
│ (blob)       │                         │ + 캐시(TTL)          │
└──────────────┘                         └─────────┬──────────┘
                                                   │ X-Api-Key(있으면)
                                                   ▼
                                         api.renaissos.com/v1
```

설계 원칙:

- **클라이언트는 표현만, 서버가 진실의 원천.** 보드 배치, 짝 매칭 정당성, 점수, 아이템 효과는 모두 서버가 계산하고 클라이언트에 브로드캐스트한다. 클라이언트는 "이 두 타일을 연결하겠다"는 의도만 보낸다.
- **Renaiss API는 클라이언트가 직접 호출하지 않는다.** 공개 티어 레이트 리밋(IP당 60/분·1000/일)과 출처 표기 의무 때문에, 게임 서버가 프록시·캐시 계층을 두고 정규화된 카드 데이터를 내려준다.

---

## 3. 게임 도메인 모델

### 3.1 카드 (Card)

게임 내 카드는 Renaiss API의 카드 식별 구조를 그대로 차용한다.

API의 `CardSummary` 스키마 필드명을 그대로 차용한다(임의 변형 금지).

```ts
interface GameCard {
  cardId: string;        // 게임 내부 식별자 = href 세그먼트 해시 (game/set/card)
  game: 'pokemon' | 'one-piece';
  type: 'POKEMON' | 'ONE_PIECE' | 'SPORTS'; // API 원본 enum
  name: string;
  setName: string;
  setCode: string;
  cardNumber: string;
  variation: string;     // 베이스 프린트는 "" (구조 튜플 일부)
  language: string;      // BCP-47 (다른 언어 = 다른 상품)
  imageUrl: string;      // Renaiss CDN
  imageUrlThumb: string;
  // 도감/도슨트용 메타 (실제 데이터, 임의 생성 금지)
  company: string;       // 예: PSA / CGC / BGS
  grade: string;
  gradeLabel: string;    // 예: PSA 10
  priceUsdCents: number; // 센트 정수, 표시 시 /100
  deltaPct: number;      // 가격 변동률
  confidence: 'high' | 'medium' | 'low';
  lastSaleAt: string;    // ISO 타임스탬프
  spark?: number[];      // 미니 스파크라인
  href: string;          // `/card/{game}/{set}/{card}` (마켓/상세 링크용)
  attribution: 'Renaiss OS Index';
}
```

> **카드 식별 구조 튜플:** API는 카드를 `(set_name, item_no, variation, language)` 또는 등급 슬랩 cert로 식별한다. 내부 Renaiss item id는 이 표면에서 쓰지 않는다.
>
> **매칭 키:** 두 타일이 "같은 카드"인지는 `cardId`(= 동일 game·set·번호·variation·언어 조합) 기준으로 판정한다. 기획의 "등급까지 맞추는 보통 난이도"는 매칭 키에 `gradeLabel`을 포함시키는 옵션 플래그로 구현한다.

### 3.2 타일 (Tile)

```ts
interface Tile {
  tileId: number;
  cardId: string;     // 같은 cardId 끼리 짝
  row: number;
  col: number;
  layer: number;      // 상하이 모드용 (겹층), 기본 0
  removed: boolean;
}
```

### 3.3 보드 (Board)

- 짝맞추기 성립을 보장하려면 **모든 cardId가 정확히 짝수(보통 2장, 상하이는 4의 배수)로 배치**되어야 한다. 카드 풀에서 무작위로 N종을 뽑고 각 종을 짝수 장 복제 후 셔플하여 좌표에 배치한다.
- 보드 외곽에 1칸 빈 테두리(가상 좌표)를 두어, 경로가 보드 밖을 한 번 돌아 연결되는 사천성 규칙을 지원한다.

### 3.4 방/매치 (Room / Match)

```ts
interface Room {
  roomId: string;
  hostId: string;
  visibility: 'public' | 'private';
  password?: string;
  maxPlayers: number;          // ≤ 4
  mapMode: MapMode;
  difficulty: 'normal' | 'hard';
  state: 'waiting' | 'playing' | 'finishing' | 'ended';
  players: Player[];
}

interface Player {
  playerId: string;
  nickname: string;
  board: Board;                // 개인전: 플레이어별 동일 시드 보드
  score: number;
  comboCount: number;
  items: { search: number; shuffle: number; scissor: number }; // 기본 3/3/1
  dex: Set<string>;            // 누적 도감 등록 cardId
  finishedRank?: number;
}
```

> **개인전 구조:** 기획상 "개인전, 최대 4명, 가장 먼저 모든 짝을 찾는 사람이 1위". 따라서 각 플레이어는 **동일 시드로 생성된 동일 보드**를 각자 풀며, 진행도를 서로의 화면에 미니뷰로 공유한다. 1위 확정 시 10초 카운트다운 후 종료, 잔여 패로 나머지 순위 산정.

---

## 4. 핵심 알고리즘

### 4.1 연결 경로 판정 (Shisen-Sho Pathfinding)

두 타일을 잇는 경로가 **최대 2회 꺾임(= 직선 3개 구간)** 안에 장애물 없이 연결되는지 검사한다.

- 그리드를 (테두리 포함) 2D 격자로 모델링, 제거된/빈 칸은 통과 가능.
- 알고리즘: 0~2회 꺾임 경로 탐색. 각 타일에서 상/하/좌/우 직선상의 "도달 가능한 빈 칸 집합"을 구하고, 두 집합이 한 직선상에서 만나는지 확인하는 방식(번개형 BFS, 복잡도 O(W·H)).
- 서버가 권위적으로 판정한다. 클라이언트는 동일 알고리즘으로 선판정(낙관적 UI)하되 서버 결과로 확정.

```
판정 케이스: 직선(0꺾임) / L자(1꺾임) / Z·U자(2꺾임)
실패: 3회 이상 꺾여야 닿는 경우
```

### 4.2 교착 감지 및 재섞기

- 매 제거 후 남은 타일들에 대해 **연결 가능한 짝이 하나라도 존재하는지** 전수 검사(쌍 후보를 4.1로 검증).
- 존재하지 않으면 기획대로 자동 재섞기(remaining 타일의 좌표만 셔플, cardId 보존) 또는 힌트 노출.

### 4.3 콤보

- 제거 성공 시 `comboCount++`. 5의 배수마다 콤보 발동.
- 5회차: 임의 카드 1종의 짝 1쌍을 지정 제거. 10회차: 클릭 카드와 동일 cardId 전부 제거.
- 점수식(예시, 튜닝 대상): `score += base × (1 + comboBonus)`. 콤보·잔여시간 보너스 가중.

### 4.4 아이템

| 아이템 | 게임당 수량 | 효과 | 서버 처리 |
| --- | --- | --- | --- |
| 서치 | 3 | 제거 가능한 짝 1쌍을 화면에서 강조 | 4.2의 후보 1쌍 반환 |
| 카드 섞기 | 3 | 남은 카드 전체 셔플 | 좌표 재배치 후 보드 브로드캐스트 |
| 가위 | 1 | 경로 무관, 지정한 짝 1쌍 강제 파괴 | 연결 판정 생략하고 제거 (콤보 카운트 반영) |

---

## 5. 맵 모드

공통 보드 엔진 위에 모드별 "틱(tick) 규칙"을 플러그인으로 얹는다.

| 모드 | 규칙 | 구현 포인트 |
| --- | --- | --- |
| 일반 | 정적 배치 | 기본 엔진 (해커톤 필수) |
| 롤링 | 3초마다 카드가 우측 이동 | 타이머 틱(3s)마다 col +1, 경계 래핑/판정 좌표 갱신 |
| UP | 맨 아랫줄부터 한 줄씩 상승, 비면 추가 상승 | 행 push, 빈 층 감지 후 신규 행 주입 |
| 승리 | "승리" 카드 짝을 먼저 연결한 사람이 승 | 특수 cardId 1종, 연결 시 즉시 매치 종료 |
| 상하이 | 겹층 사천성 | `Tile.layer` 활용, 상위 레이어가 덮은 타일은 선택 불가 |

맵 **모양**(네모 외 형태)은 좌표 마스크(boolean grid)로 정의한다. 기획의 Renaiss/포켓몬/원피스 실루엣은 마스크 프리셋으로 제작한다.

---

## 6. Renaiss API 연동

### 6.0 인증 모델 (실제 스펙)

API는 **두 가지 표면**을 제공한다. 게임 데모는 (A) 공개 read-only 표면을 기본으로 쓴다.

| 표면 | 인증 | 용도 |
| --- | --- | --- |
| (A) 공개 read-only (`openapi.json` 기준) | **무인증**, 모든 엔드포인트 `GET`, 응답에 허용적 CORS(브라우저 직접 호출 가능) | 검색·세트·카드 상세·overview·지수·트레이드 |
| (B) 파트너/key-auth (`/api-docs` 기준) | `X-Api-Key` + `X-Api-Secret` 헤더, 또는 무인증(IP당 레이트 리밋) | 높은 쿼터·신선도, `index/by-cert`, `graded/by-image` |

> secret은 **발급 시 1회만** 노출되고 서버엔 해시로만 저장된다. 절대 브라우저 번들에 포함하지 말고 게임 서버(서버사이드)에만 보관한다. 잘못된 키/시크릿은 `401`.

### 6.1 사용 엔드포인트 (OpenAPI v1.0.0 검증)

게임 서버가 서버사이드에서 호출하고 캐시한다. 모두 공개 티어 사용을 기본으로 하며, 파트너 키 확보 시 더 높은 쿼터·신선도로 승격.

| 용도 | 엔드포인트 | 핵심 파라미터 |
| --- | --- | --- |
| 카드 검색(풀 후보) | `GET /v1/search` | `q`, `limit` |
| 세트 단위 카드 목록 | `GET /v1/sets/{game}/{set}` | path: game, set |
| 카드 상세(가격/신뢰도/다른 등급/유사) | `GET /v1/cards/{game}/{set}/{card}` | path 3종 |
| 카드 overview(전 등급) | `GET /v1/cards/{game}/{set}/{card}/overview` | path 3종 |
| 카드 트레이드 이력 | `GET /v1/cards/{game}/{set}/{card}/trades` | `source`, `window`, `scope`, `limit` |
| 카드 가격 시계열 | `GET /v1/cards/{game}/{set}/{card}/series` | `window` |
| 카드 일별 FMV 시계열 | `GET /v1/cards/{game}/{set}/{card}/fmv-series` | `window` |
| 추천 무버(마무리 컨텍스트) | `GET /v1/cards/featured` | `limit` |
| 지수 타일 / 드릴다운 | `GET /v1/indices`, `GET /v1/indices/{game}` | path: game |
| 최근 트레이드 피드 | `GET /v1/trades/recent` | `limit` |
| 등급 슬랩 조회(온디맨드 평가) | `GET /v1/graded/{cert}` | 항상 200, `found` 확인 |
| 등급 슬랩 — 실시간 진행(SSE) | `GET /v1/graded/{cert}/stream` | (추가 범위) |
| 사진으로 등급 평가(SSE) | `POST /v1/graded/by-image` | multipart `file` ≤15MB |

> **(B) 파트너 표면 별도 엔드포인트:** `/api-docs`에는 구조 튜플 직접 조회 `GET /v1/index/item-by-no`(`set_name`,`item_no`,`variation`,`language`)와 cert 조회 `GET /v1/index/by-cert`(`grading_company`,`grade_id`)가 노출돼 있다. 데모는 위 (A) 표면으로 충분하므로 선택 사용한다.
>
> **카드 식별 흐름:** `/v1/search` 결과의 `href`(`/card/{game}/{set}/{card}`) 세 세그먼트를 그대로 상세/overview/trades/series 경로에 사용한다. `by-id/{id}`, `by-renaiss-id/{rid}` 변형도 존재하나 게임은 `href` 세그먼트 경로만 쓴다.

### 6.2 데이터 매핑 (`CardSummary` → `GameCard`)

검색·세트·overview 응답은 모두 `CardSummary`(또는 그 상위 객체) 형태다. 필드명을 그대로 사용한다.

| GameCard | API 필드 | 비고 |
| --- | --- | --- |
| `game`, `type` | `game`, `type` | `type` enum: `POKEMON`/`ONE_PIECE`/`SPORTS` |
| `name`, `setName`, `setCode`, `cardNumber` | 동명 필드 | |
| `variation`, `language` | 동명 필드 | 구조 튜플 구성요소 |
| `imageUrl`, `imageUrlThumb` | 동명 필드 (Renaiss CDN) | 상세는 `imageUrlLg` |
| `company`, `grade`, `gradeLabel` | 동명 필드 | 예: PSA / "PSA 10" |
| `priceUsdCents` | `priceUsdCents` | 센트 정수, 표시 시 /100 |
| `deltaPct` | `deltaPct` | 변동률 |
| `confidence` | `confidence` | `high`/`medium`/`low` |
| `lastSaleAt`, `spark` | 동명 필드 | |
| `href` | `href` → 마켓/상세 링크 | |

카드 상세(`CardDetail`)는 추가로 `deltas`, `sourceCount`, `observationCount`, `methods`(FMV 산출법), `otherGrades`(다른 등급 시세), `similar`(유사 카드), `pageUrl`을 제공한다. 도감 "자세히 보기"의 등급 비교·신뢰도 표시는 이 필드로 구성한다. **시세·등급 숫자를 코드에서 생성하지 않는다**(기획 안전·저작권 4항).

### 6.3 캐시·레이트 리밋·폴백

- **공개 티어 한도: IP당 60/분, 1000/일**, p95 ~800ms(캐시), 신선도 best-effort. **파트너 티어: 1k~100k/일, p95 <300ms, 99.5%·24h SLA.**
- 게임 서버에서 호출을 집약·캐시한다. 카드 메타(이미지·이름)는 사실상 불변 → **장기 캐시(예: 24h)**. 가격·`deltaPct`는 **짧은 TTL(예: 5~15분)**.
- 데모 시작 시 카드 풀(수십~수백 종)을 **사전 워밍(prefetch)하여 정적 JSON 스냅샷**으로 적재 → 플레이 중 실시간 호출 0에 수렴, 리밋 회피.
- API 장애/미커버 카드 대비 폴백: API는 베타(커버리지 확대 중)이므로 미커버 가능성이 있다. 기획 "예시 데이터 사용 시 화면에 분명히 표시" 규칙을 따라 `isSampleData: true` 배지를 노출한다. 등급 조회는 `found:false` + `reason`(`not_ingested`/`company_unsupported`/`compute_incomplete`/`no_grade_price`/`game_unsupported`/`needs_photo`)을 명시적으로 처리한다.

### 6.4 출처 표기 (필수)

API 약관상 숫자를 공개 표시할 때 **"Renaiss OS Index" 표기 + 출처 페이지 링크**가 의무다(공개·파트너 티어 공통). 도감 카드 하단·마무리 요약의 가격 옆에 "Renaiss OS Index" 캡션과 `href`(또는 `pageUrl`) 링크를 항상 렌더한다.

---

## 7. 백엔드 API (자체 서버)

### 7.1 REST (로비·도감·메타)

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/rooms` | 방 생성(인원·공개여부·비밀번호·맵·난이도) |
| `GET` | `/api/rooms` | 방 목록 |
| `POST` | `/api/rooms/{id}/join` | 방 입장 |
| `GET` | `/api/cards/pool?game=` | 사전 워밍된 카드 풀 스냅샷 |
| `GET` | `/api/dex/{playerId}` | 도감 달성도 조회 |
| `GET` | `/api/cards/{cardId}/docent` | 도슨트 상세(자세히 보기) |

### 7.2 WebSocket 이벤트 (인게임)

클라이언트 → 서버:

| 이벤트 | 페이로드 |
| --- | --- |
| `room:ready` / `game:start`(host) | — |
| `tile:match` | `{ tileA, tileB }` 연결 의도 |
| `item:use` | `{ type: 'search'|'shuffle'|'scissor', target? }` |
| `combo:trigger` | `{ targetCardId }` |

서버 → 클라이언트:

| 이벤트 | 페이로드 |
| --- | --- |
| `board:init` | `{ tiles[], mapMode, seed }` |
| `tile:matched` | `{ tileA, tileB, path[], scoreDelta, dexUnlocked? }` |
| `tile:rejected` | `{ reason }` |
| `board:reshuffle` | `{ tiles[] }` (교착/섞기 아이템) |
| `player:progress` | `{ playerId, remaining, score }` (상대 미니뷰) |
| `match:finishing` | `{ winnerId, countdownSec: 10 }` |
| `match:ended` | `{ ranks[], summaries[] }` |

---

## 8. 도감(Dex) 및 보상(SBT)

- **등록 규칙:** 동일 카드 누적 10회 제거 시 해당 cardId가 플레이어 도감에 영구 등록(기획 도감 시스템).
- **3단계 도슨트:**
  1. *한 줄 미리보기* — 카드 제거 순간 짧은 정보 토스트(이름·등급).
  2. *자세히 보기* — 카드 클릭 시 등급·가치·소유 설명 + 마켓 링크(`href`).
  3. *판 종료 요약* — 오늘 만난 카드, 등급 분포, 가장 값진 카드, 도감 달성률, 마켓 CTA.
- **SBT:** 도감 완성(포켓몬/원피스 카테고리별) 시 참여 보상 배지 지급. 데모는 **목(mock) 발급**으로 UI만 구현, 추가 범위에서 Web3 지갑 연동 후 온체인 SBT 민팅. (기획 "여유 시 실제 참여 보상 배지 연동")

---

## 9. 인증

- **데모:** 게스트 닉네임 입력으로 즉시 플레이.
- **추가 범위:** 기획대로 Renaiss 연동 계정(X OAuth, Web3 지갑) 로그인. 지갑 로그인 시 보유 슬랩을 `/v1/graded/{cert}`로 검증해 도감 프리언락 등 연계 가능.

---

## 10. 비기능 요구사항

- **성능:** 보드 렌더 60fps 목표(PixiJS), 연결선 애니메이션은 GPU 가속. 판정 알고리즘 O(W·H)로 인터랙션당 1ms 미만.
- **동기화:** 서버 권위 + 클라이언트 낙관적 예측. 거부 시 롤백.
- **확장성:** 인메모리 방 상태를 Redis로 외부화하면 수평 확장 가능(데모는 단일 인스턴스).
- **레이트 리밋 준수:** §6.3 캐시·프리워밍으로 공개 티어 한도 내 운용.
- **안전·저작권(기획 §안전과 저작권):** 비영리 팬게임, 과금 없음. 예시 데이터는 화면 표시. 시세·등급은 실제 API 출처만 사용, 임의 생성 금지. "Renaiss OS Index" 출처 표기.

---

## 11. 기술 스택 요약

| 레이어 | 선택 |
| --- | --- |
| 프런트 | React, TypeScript, Vite, PixiJS, Zustand(상태) |
| 실시간 | Socket.IO (WebSocket) |
| 백엔드 | Node.js, TypeScript, Fastify |
| 캐시/상태 | 인메모리(데모) → Redis(확장) |
| 데이터 출처 | Renaiss OS Index Public API (`api.renaissos.com/v1`) |
| 배포 | 정적 호스팅(Vercel/Netlify) + 단일 노드 게임 서버 |

---

## 12. 마일스톤 (해커톤 범위)

기획 "꼭 만드는 것"을 우선 순위로 분해한다.

**M1 — 코어 퍼즐 (필수)**
- 보드 생성·셔플, 연결 판정(꺾임 ≤ 2), 짝 제거, 교착 자동 섞기
- 일반 맵 + 매 판 다른 마스크 모양
- 등급 매칭(보통 난이도) 옵션
- 예시 카드 데이터(등급·시세 포함, 샘플 표시)

**M2 — 점수·도슨트·마켓**
- 점수/콤보/아이템, 마무리 요약 화면
- 도슨트 3단계, 도감 누적, 마켓 링크
- Renaiss API 프리워밍 연동 + 출처 표기

**M3 — 멀티플레이**
- 방 생성/입장, 4인 동기화, 진행 미니뷰
- 1위 확정 후 10초 종료, 순위 산정

**M4 — 추가 범위(여유 시)**
- X·지갑 로그인, 실시간 카드 데이터, SBT 온체인 민팅
- 롤링/UP/승리/상하이 맵, 순위표·일일 챌린지, 플레이 기록 저장

---

## 부록 A. Renaiss API 빠른 참조 (검증 완료)

- Base URL: `https://api.renaissos.com` · API 문서: `https://index.renaissos.com/api-docs`
- 인증: 공개 read-only 엔드포인트 무인증·GET·CORS 허용(IP당 60/분·1000/일) / 파트너 `X-Api-Key` + `X-Api-Secret` 헤더(1k~100k/일). secret은 서버사이드 전용, 잘못된 키 `401`.
- 카드 식별: 구조 튜플 `(set_name, item_no, variation, language)` 또는 등급 슬랩 cert. 내부 Renaiss item id는 미사용.
- 검색→상세 흐름: `/v1/search` → 결과 `href`(`/card/{game}/{set}/{card}`) 세그먼트 → `/v1/cards/{game}/{set}/{card}[/overview|/trades|/series|/fmv-series]`
- 게임 활용 엔드포인트: `/v1/search`, `/v1/sets/{game}/{set}`, `/v1/cards/{game}/{set}/{card}`(+`/overview`), `/v1/indices`, `/v1/cards/featured`, `/v1/graded/{cert}`
- Swagger: `https://api.renaissos.com/docs` · OpenAPI(v1.0.0): `https://api.renaissos.com/v1/openapi.json`
- 상태: **베타** — 카드 커버리지 확대 중, 일부 데이터 누락 가능 → 폴백 배지 필수
- 출처 표기 의무: 숫자 공개 표시 시 "Renaiss OS Index" + 출처 링크(`href`/`pageUrl`)

> **이전 초안 대비 정정 사항:** 검색 결과는 `q≥2자`/`limit≤30` 같은 하드 제약이 스펙에 명시돼 있지 않음(파라미터만 존재). 등급 슬랩 조회 `/v1/graded/{cert}`는 추가 범위가 아니라 공개 표면에 상시 노출되며 항상 200 + `found` 플래그로 응답함. 카드 상세는 `priceUsdCents`/`confidence` 외에 `methods`/`otherGrades`/`similar`까지 제공.
