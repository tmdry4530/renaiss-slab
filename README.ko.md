# Renaiss Slab King

[English](./README.md) · **한국어**

사천성 방식 실시간 카드 매칭 퍼즐 — **문서(PRD·기능정의서·TECH-SPEC) 요구 기능 전체 구현**.
실제 Renaiss 카드(포켓몬·원피스)를 타일로 사용하고, 가격·등급 데이터는 **Renaiss OS Index**에서,
마켓·팩(가챠) 컨텍스트는 **공식 `renaiss` CLI**에서 가져온다.

> 기획·기술 문서는 [`docs/`](./docs) 참조 (PRD · 기능정의서 · TECH-SPEC · CTO-QNA).

## 빠른 시작

```bash
npm install
npm run prefetch   # (선택) 데이터 스냅샷 최신화. 미실행 시 동봉된 스냅샷 사용
npm run dev        # 게임 서버(8787) + 웹(5173) 동시 기동 → http://localhost:5173
```

프로덕션: `npm run build` → `npm start` (단일 프로세스가 dist/ 정적 서빙 + API + WebSocket, http://localhost:8787)

## 구현 기능 (FEATURE_SPEC F-01~F-16)

| 영역 | 내용 |
| --- | --- |
| 계정 (F-01) | 게스트 닉네임 로그인(데모 범위). playerId 로컬 영속 |
| 대기실 (F-02/03) | 방 생성(1~4인·공개/비공개·비밀번호), 방 목록, 입장 검증(정원/진행중/비밀번호), 방장 승계, "혼자 바로 하기" |
| 게임 설정 (F-04/05/06) | 카드 세트(포켓몬/원피스/혼합), 맵 모드 5종, 난이도 3종(카드 종류 수 차등), 방장만 변경·시작 |
| 매칭 (F-07) | 꺾임 ≤2 경로 판정(서버 권위), 연결선 이펙트, 교착 자동 재섞기, 비사각형 마스크 5종 |
| 맵 모드 (F-08) | 일반 · 롤링(3초 우측 순환) · UP(줄 소진 시 하단 주입 상승) · 승리(특수 짝 → 즉시 1위·즉시 종료) · 상하이(2겹층) |
| 콤보 (F-09) | 2초 창, 5/15콤보 → 지정 카드 짝 제거, 10/20콤보 → 동일 카드 전체 제거 |
| 아이템 (F-10) | 서치 3 · 섞기 3 · 가위 1 (경로 무관 강제 제거, 콤보 반영) |
| 순위 (F-11) | 1위 확정 후 10초 유예 → 잔여 패·점수 기준 순위. 상대 진행 미니뷰 |
| 도감 (F-12/13/14) | 동일 카드 누적 10회 → 등록. 포켓몬/원피스 탭, 달성률, 마켓 "자세히 보기", 100% 달성 시 SBT(목 발급) |
| 결과 (F-15) | 순위표, 점수·시간·경험치, 오늘 만난 카드, 등급 분포, 최고가 카드, 마켓/보상 버튼, 재플레이 |
| 데이터 정책 (F-16) | 시세·등급 임의 생성 금지, 결측 시 "예시 데이터" 라벨, 상시 "Renaiss OS Index" 출처 표기 |

## 아키텍처 (TECH-SPEC §2)

```
src/  (React 18 + Vite)  ←WebSocket/REST→  server/ (Fastify + Socket.IO, 서버 권위)
        └────────────── shared/ (공용 엔진: 판정·보드·모드·콤보·점수·프로토콜) ──────────────┘
```

- **서버 권위**: 보드 생성(시드)·매칭 판정·점수·콤보·아이템·모드 틱 전부 서버 계산. 클라이언트는 의도만 전송.
- **개인전 동일 보드**: 매치당 시드 1개, 전원 같은 보드를 각자 풀고 진행도 공유 (TECH-SPEC §3.4).
- 렌더링은 React DOM 유지(PixiJS 미사용 — 문서 가정 대비 변경, 로컬 데모 성능 충분).

```
shared/    protocol.ts(계약) · cards.ts · shisen.ts(BFS) · board.ts(마스크·모드) · combo.ts · score.ts
server/    index.ts(REST·소켓) · rooms.ts(방) · match.ts(매치 권위) · dex.ts(도감·SBT, .data/dex.json 영속)
src/       net.ts(타입드 소켓) · screens/(Login·Lobby·Room·Game·Result·Dex)
scripts/   prefetch-*.mjs · test-*.ts
```

## 테스트

```bash
npm test   # 연결판정 6 · 보드 9 · 모드/콤보/마스크 78 · 시뮬 9(전 난이도 자동클리어) · 서버 e2e 59
```

서버 e2e 는 실제 소켓 2클라이언트로 방 생성→입장→시작→자동 플레이→클리어→유예→순위·요약까지 검증.

## 데이터 파이프라인

| 용도 | 소스 | 산출물 | 비고 |
| --- | --- | --- | --- |
| 카드 풀(퍼즐 타일·도감) | Renaiss OS Index `GET /v1/search` | `public/data/card-pool.json` | **이미지 포함**(imageUrl) |
| 마켓 리스팅·팩 | 공식 `npx renaiss` CLI | `public/data/market-snapshot.json` | CLI 리스트엔 이미지 없음 → 컨텍스트용 |

- `npm run prefetch:pool` — 공개 티어 60/분 제한 대응(스로틀 1.2s + 429 재시도). 탐색어는 `scripts/prefetch-pool.mjs`의 `QUERIES`.
- `npm run prefetch:cli` — `renaiss marketplace` + `renaiss packs` 스냅샷.

## 출처 표기 (필수)

가격·등급 숫자를 표시할 때 **"Renaiss OS Index" + 출처 링크**가 의무다. 시세·등급은 임의 생성 금지, 실제 API 값만 사용. 결측 카드는 "예시 데이터" 라벨.

## 문서 대비 구현 가정 (미확정 → 코드 주석 명시)

- UP 트리거: "한 줄 전부 제거 시 상승"으로 해석 · 콤보 리셋: 실패 시 0, 2초 초과 시 1
- 방장 퇴장: 다음 입장자 승계 · 게임 중 이탈: 매치 유지, 재접속 미지원
- 난이도별 카드 종류 수 6/16/30 · 클리어 보너스 500점 · XP = 점수/10 + 클리어 50
- SBT: 목(mock) 발급 (온체인 미연동) — 확정 질문은 [`docs/CTO-QNA.md`](./docs/CTO-QNA.md)
