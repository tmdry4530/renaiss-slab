import {
  type DifficultyKey,
  type GameSel,
  type MapMode,
  type RoomState,
} from "../shared/protocol.ts";
import { t } from "./i18n.ts";

export const gameLabel = (g: GameSel): string => t(`label.game.${g}`);

export const modeLabel = (m: MapMode): string => t(`label.mode.${m}`);

export const modeDesc = (m: MapMode): string => t(`label.modeDesc.${m}`);

export const diffLabel = (d: DifficultyKey): string => t(`label.diff.${d}`);

export const stateLabel = (s: RoomState): string => t(`label.state.${s}`);

// 서버 Ack.error → 사용자 문구
const ERR_LABELS: Record<string, string> = {
  notFound: "error.notFound",
  full: "error.full",
  playing: "error.playing",
  badPassword: "error.badPassword",
  notHost: "error.notHost",
  badNickname: "error.badNickname",
  badRequest: "error.badRequest",
  notInRoom: "error.notInRoom",
  notPlaying: "error.notPlaying",
  quota: "error.quota",
  noQuota: "error.noQuota",
  noPower: "error.noPower",
  notComplete: "error.notComplete",
  alreadyClaimed: "error.alreadyClaimed",
  timeout: "error.timeout",
};

export const errText = (e?: string): string => {
  if (!e) return t("error.generic");
  if (ERR_LABELS[e]) return t(ERR_LABELS[e]);
  // 서버 guard 가 이미 한글 안내 문구를 error 로 보낸 경우(예: match.ts stuck 가드) 그대로 노출한다.
  // ERR_LABELS 에 없다고 "오류가 발생했습니다 (…)" 로 이중 표기하면 안내 문구가 뭉개진다.
  if (/[가-힣]/.test(e)) return e;
  return t("error.genericDetail", { error: e });
};

/** 초 → "mm:ss" */
export const fmtClock = (totalSec: number): string => {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** 밀리초 → "mm:ss" */
export const fmtMs = (ms: number): string => fmtClock(Math.round(ms / 1000));
