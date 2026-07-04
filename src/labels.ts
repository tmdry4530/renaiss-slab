// 공용 라벨·포맷 헬퍼 (한국어 UI 문구 매핑)
import {
  MAP_MODES,
  type DifficultyKey,
  type GameSel,
  type MapMode,
  type RoomState,
} from "../shared/protocol.ts";

export const gameLabel = (g: GameSel): string => (g === "pokemon" ? "포켓몬" : "원피스");

export const modeLabel = (m: MapMode): string =>
  MAP_MODES.find((x) => x.key === m)?.label ?? m;

export const modeDesc = (m: MapMode): string =>
  MAP_MODES.find((x) => x.key === m)?.desc ?? "";

export const diffLabel = (d: DifficultyKey): string =>
  d === "easy" ? "쉬움" : d === "normal" ? "보통" : "어려움";

export const stateLabel = (s: RoomState): string =>
  s === "waiting" ? "대기" : s === "ended" ? "종료" : "진행중";

// 서버 Ack.error → 사용자 문구
const ERR_LABELS: Record<string, string> = {
  notFound: "방을 찾을 수 없습니다",
  full: "정원이 가득 찼습니다",
  playing: "이미 게임이 진행 중인 방입니다",
  badPassword: "비밀번호가 일치하지 않습니다",
  notHost: "방장만 할 수 있는 작업입니다",
  badNickname: "닉네임은 1~12자로 입력하세요",
  badRequest: "잘못된 요청입니다",
  notInRoom: "방에 입장한 상태가 아닙니다",
  notPlaying: "게임 중이 아닙니다",
  quota: "아이템을 모두 사용했습니다",
  noQuota: "아이템을 모두 사용했습니다",
  noPower: "발동 중인 콤보 효과가 없습니다",
  notComplete: "아직 도감을 완성하지 못했습니다",
  alreadyClaimed: "이미 보상을 받았습니다",
  timeout: "서버 응답이 없습니다 — 서버 실행 여부를 확인하세요",
};

export const errText = (e?: string): string =>
  (e && ERR_LABELS[e]) || `오류가 발생했습니다${e ? ` (${e})` : ""}`;

/** 초 → "mm:ss" */
export const fmtClock = (totalSec: number): string => {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** 밀리초 → "mm:ss" */
export const fmtMs = (ms: number): string => fmtClock(Math.round(ms / 1000));
