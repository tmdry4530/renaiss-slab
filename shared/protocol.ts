// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 서버·클라이언트 통신 프로토콜 (TECH-SPEC §7)
// 이 파일이 계약(contract)이다. 서버(server/)와 클라이언트(src/) 모두 이 타입만 사용한다.
// ─────────────────────────────────────────────────────────────
import type { GameCard } from "./cards.ts";

export type MapMode = "normal" | "rolling" | "up" | "victory" | "shanghai";
export type DifficultyKey = "easy" | "normal" | "hard";
export type GameSel = "pokemon" | "one-piece";
export type RoomState = "waiting" | "playing" | "finishing" | "ended";
export type ItemType = "search" | "shuffle" | "scissor";

/**
 * 서버 Ack/REST 실패 코드. 사용자 노출 문구는 클라이언트 i18n 사전에서 결정한다.
 *
 * - routeNotFound: 존재하지 않는 REST 경로
 * - notFound/full/playing/badPassword: 방 조회·입장 실패
 * - notHost/notInRoom: 방 권한·소속 실패
 * - badNickname/helloRequired: 로비 세션 검증 실패
 * - badRoomName/badVisibility/badMaxPlayers/passwordRequired: 방 생성 설정 검증 실패
 * - unknownGame/unknownMapMode/unknownDifficulty/unknownTheme: 게임·맵 설정 값 검증 실패
 * - boardGenerationFailed/gameStartFailed: 매치 생성·시작 실패
 * - cardNotFound: 카드 조회 실패
 * - notPlaying/notStarted/alreadyCleared/stuck: 매치 조작 가능 상태가 아님
 * - noPower/victoryComboForbidden/noTarget: 콤보 파워 적용 실패
 * - itemUnavailable/unknownItem/noQuota/noMatch: 아이템 사용 실패
 * - badScissorTarget/invalidTiles/mismatch/victoryScissorForbidden: 가위 대상 검증 실패
 * - removed/sameTile/locked/noPath: 일반 타일 매칭 검증 실패
 * - unknownCategory/notComplete/alreadyClaimed: 도감 SBT 발급 실패
 * - timeout: 클라이언트가 합성하는 Ack 응답 시간 초과
 */
export type ErrCode =
  | "routeNotFound"
  | "notFound"
  | "full"
  | "playing"
  | "badPassword"
  | "notHost"
  | "badNickname"
  | "helloRequired"
  | "badRoomName"
  | "badVisibility"
  | "badMaxPlayers"
  | "passwordRequired"
  | "unknownGame"
  | "unknownMapMode"
  | "unknownDifficulty"
  | "unknownTheme"
  | "notInRoom"
  | "boardGenerationFailed"
  | "gameStartFailed"
  | "cardNotFound"
  | "notPlaying"
  | "notStarted"
  | "alreadyCleared"
  | "stuck"
  | "noPower"
  | "victoryComboForbidden"
  | "noTarget"
  | "itemUnavailable"
  | "unknownItem"
  | "noQuota"
  | "noMatch"
  | "badScissorTarget"
  | "invalidTiles"
  | "mismatch"
  | "victoryScissorForbidden"
  | "removed"
  | "sameTile"
  | "locked"
  | "noPath"
  | "unknownCategory"
  | "notComplete"
  | "alreadyClaimed"
  | "timeout";

export const MAP_MODES: { key: MapMode; label: string; desc: string }[] = [
  { key: "normal", label: "일반", desc: "기본 매칭 규칙" },
  { key: "rolling", label: "롤링", desc: "4초마다 바깥 테두리가 시계방향으로 회전" },
  { key: "up", label: "UP", desc: "넓은 보드 · 짝이 막히면(교착) 최하단에서 한 줄 상승" },
  { key: "victory", label: "승리", desc: "승리 카드 짝을 먼저 맞추면 즉시 1위" },
  { key: "shanghai", label: "상하이", desc: "겹층 — 위층을 걷어야 아래층 선택 가능" },
];

export const ROLLING_INTERVAL_MS = 4000; // PRD §4.3 (넷마블 '롤링4각' — 3→4초, 바깥 테두리 시계 회전)
export const COMBO_WINDOW_MS = 3000; // 콤보 지속시간 3초 (플레이 피드백 반영 — 2초는 콤보 잇기 어려워)
export const FINISH_GRACE_MS = 10000; // 1위 확정 후 10초 유예
export const MATCH_TIME_LIMIT_MS = 180_000; // 전 모드·난이도 공통 매치 제한시간 3분
export const DISCONNECT_GRACE_MS = 60000; // 소켓 끊김(새로고침·순단) 후 재접속 유예 60초
export const DEX_REGISTER_COUNT = 10; // 동일 카드 누적 10회 제거 시 도감 등록
export const ITEM_QUOTA: Record<ItemType, number> = { search: 3, shuffle: 3, scissor: 1 };
export const COUNTDOWN_STEPS = 3; // 3→2→1 카운트다운 스텝 수
export const COUNTDOWN_STEP_MS = 1000; // 스텝 간 간격(ms). game:start ~ board:init 사이 = STEPS * STEP_MS

// ── 방/플레이어 ──────────────────────────────────────────────
export interface RoomConfig {
  name: string;
  visibility: "public" | "private";
  password?: string; // 생성/입장 시에만 전송, 목록엔 hasPassword 로만 노출
  maxPlayers: number; // 1~4
  game: GameSel;
  mapMode: MapMode;
  difficulty: DifficultyKey;
  theme?: string; // 맵 프리셋 테마 키(MapPreset.theme, shared/mapThemes.ts MAP_THEMES 참조) — 대기실 맵 선택 시에만 설정
}

export interface RoomSummary {
  roomId: string;
  name: string;
  hostNickname: string;
  visibility: "public" | "private";
  hasPassword: boolean;
  maxPlayers: number;
  playerCount: number;
  state: RoomState;
  game: GameSel;
  mapMode: MapMode;
  difficulty: DifficultyKey;
  theme?: string; // 선택된 맵 프리셋 테마 키 (미선택 시 undefined)
}

export interface PlayerPublic {
  playerId: string;
  nickname: string;
  isHost: boolean;
  connected: boolean;
  // 진행 미니뷰 용
  remaining: number;
  score: number;
  combo: number;
  finishedRank?: number;
}

export interface RoomDetail extends RoomSummary {
  players: PlayerPublic[];
}

// ── 재접속 복구 (새로고침·순단 후 lobby:hello ack 로 반환) ─────
// 유예(disconnect grace) 중인 같은 playerId 가 재접속하면 서버가 방/보드/진행도를 복원해준다.
export interface ResumeProgress {
  score: number;
  combo: number;
  remaining: number;
  items: Record<ItemType, number>;
  elapsedMs: number; // 플레이 경과(ms). active 전(카운트다운 중)이면 0.
  stuck?: boolean; // UP 교착으로 진행 불가 확정
}

export interface ResumeState {
  room: RoomDetail;
  board?: BoardInit; // 게임 진행 중일 때만 (waiting 복귀 시 없음 → 대기실로)
  progress?: ResumeProgress; // board 와 함께 제공
}

// ── 보드 ────────────────────────────────────────────────────
export interface TileState {
  tileId: number;
  cardIdx: number; // BoardInit.cards 인덱스
  r: number; // 패딩 격자 기준 1..rows
  c: number; // 1..cols
  layer: number; // 상하이 모드 겹층, 기본 0
  removed: boolean;
  victory?: boolean; // 승리 모드 특수 카드
}

export interface BoardInit {
  rows: number;
  cols: number;
  mapMode: MapMode;
  difficulty: DifficultyKey;
  seed: number;
  timeLimitMs: number;
  cards: GameCard[]; // 이 판에 등장하는 카드 (tiles[].cardIdx 참조 대상)
  tiles: TileState[];
  reserveRows?: number; // UP 모드: 남은 상승 예비 줄 수
  theme?: string; // 맵 프리셋 테마 키 (선택 시에만) — 클라 배경 렌더링용
}

export interface BoardPatch {
  tiles: TileState[]; // 전체 타일 상태 스냅샷 (롤링/UP/섞기/콤보 일괄 제거 후)
  reserveRows?: number;
  reason: "rolling" | "up" | "shuffle" | "reshuffle" | "combo" | "scissor";
}

// ── 콤보 ────────────────────────────────────────────────────
// 5·15회: 지정 카드 1종의 짝 1쌍 자동 제거 / 10·20회: 지정 카드와 동일 카드 전부 제거
export type ComboPowerKind = "pair" | "clear";
export interface ComboPower {
  level: number; // 5 | 10 | 15 | 20
  kind: ComboPowerKind;
}

// ── 결과 ────────────────────────────────────────────────────
export interface RankEntry {
  playerId: string;
  nickname: string;
  rank: number;
  score: number;
  remaining: number;
  cleared: boolean;
  timeMs: number;
}

export interface PlayerSummary {
  playerId: string;
  xp: number; // 획득 경험치
  metCards: { card: GameCard; count: number }[]; // 오늘 만난 카드
  gradeDist: { gradeLabel: string; count: number }[]; // 등급 분포
  topCard: GameCard | null; // 만난 카드 중 최고가
  dexNewlyRegistered: GameCard[]; // 이번 판으로 도감에 새로 등록된 카드
  dexProgress: DexProgress;
}

export interface DexProgress {
  pokemon: { registered: number; total: number; complete: boolean };
  "one-piece": { registered: number; total: number; complete: boolean };
}

export interface DexEntry {
  cardId: string;
  count: number; // 누적 제거 횟수
  registered: boolean; // count >= DEX_REGISTER_COUNT
}

export interface SbtBadge {
  category: "pokemon" | "one-piece";
  issuedAt: string;
  mock: true; // 데모: 목 발급 (TECH-SPEC §8)
}

// ── Socket.IO 이벤트 맵 ──────────────────────────────────────
export interface Ack<T> {
  ok: boolean;
  error?: ErrCode;
  data?: T;
}

export interface ClientToServer {
  "lobby:hello": (p: { nickname: string; playerId?: string }, ack: (r: Ack<{ playerId: string; resume?: ResumeState }>) => void) => void;
  "room:create": (p: RoomConfig, ack: (r: Ack<{ room: RoomDetail }>) => void) => void;
  "room:list": (ack: (r: Ack<{ rooms: RoomSummary[] }>) => void) => void;
  "room:join": (p: { roomId: string; password?: string }, ack: (r: Ack<{ room: RoomDetail }>) => void) => void;
  "room:leave": () => void;
  "room:config": (p: Partial<Pick<RoomConfig, "game" | "mapMode" | "difficulty" | "theme">>, ack: (r: Ack<{ room: RoomDetail }>) => void) => void;
  "game:start": (ack: (r: Ack<Record<string, never>>) => void) => void;
  "tile:match": (p: { tileA: number; tileB: number }, ack?: (r: Ack<Record<string, never>>) => void) => void;
  "item:use": (
    p: { type: ItemType; tiles?: [number, number] }, // scissor 는 대상 짝 지정
    // 서치는 사용 즉시 연결 가능한 짝(승리 제외) 1쌍을 서버가 정상 매칭 파이프라인으로 제거한다.
    // highlight: 서치가 자동 제거한 짝의 tileId(제거 연출·연결선은 tile:matched 로 별도 방송).
    // items: 사용 수신 시점 서버 권위 잔량 (클라 낙관적 차감의 최종 동기화용 — 미소모 시 잔량 그대로).
    ack: (r: Ack<{ highlight?: [number, number]; items?: Record<ItemType, number> }>) => void
  ) => void;
  "combo:power": (p: { cardId: string }, ack: (r: Ack<Record<string, never>>) => void) => void;
  "dex:get": (ack: (r: Ack<{ entries: DexEntry[]; progress: DexProgress; sbts: SbtBadge[] }>) => void) => void;
  "sbt:claim": (p: { category: "pokemon" | "one-piece" }, ack: (r: Ack<{ sbt: SbtBadge }>) => void) => void;
}

export interface ServerToClient {
  "lobby:rooms": (p: { rooms: RoomSummary[] }) => void; // 로비 목록 실시간 푸시 (방 생성/입장/퇴장/상태 변경)
  "room:update": (p: { room: RoomDetail }) => void;
  "room:closed": (p: { reason: string }) => void;
  // 시작 연출: board:init 먼저 → 3→2→1 순차 → 0(GO=시작!). seconds 는 3~1(카운트) 또는 0(GO 신호)
  "game:countdown": (p: { seconds: number }) => void;
  "board:init": (p: BoardInit) => void;
  "board:update": (p: BoardPatch) => void;
  "tile:matched": (p: {
    tileA: number;
    tileB: number;
    path: { r: number; c: number }[];
    scoreDelta: number;
    combo: number;
    comboPower?: ComboPower; // 이번 매칭으로 발동된 콤보 효과 (플레이어가 카드 지정 대기)
    dexUnlocked?: string[]; // 이번 제거로 도감 등록된 cardId
  }) => void;
  "tile:rejected": (p: { reason: string }) => void;
  "player:progress": (p: { playerId: string; remaining: number; score: number; combo: number; stuck?: boolean }) => void;
  "match:finishing": (p: { winnerId: string; winnerNickname: string; countdownSec: number }) => void;
  "match:ended": (p: { ranks: RankEntry[]; summaries: PlayerSummary[]; timedOut: boolean }) => void;
}

// ── REST (TECH-SPEC §7.1) ────────────────────────────────────
// POST /api/rooms            → { room: RoomDetail }
// GET  /api/rooms            → { rooms: RoomSummary[] }
// POST /api/rooms/:id/join   → { ok } (검증만; 실입장은 socket room:join)
// GET  /api/cards/pool?game= → CardPool (public/data 스냅샷 서빙)
// GET  /api/dex/:playerId    → { entries, progress, sbts }
// GET  /api/cards/:cardId/docent → { card, marketUrl } 도슨트 상세
