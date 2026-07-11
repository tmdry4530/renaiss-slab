import {
  type DifficultyKey,
  type ErrCode,
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
const ERR_LABELS: Record<ErrCode, string> = {
  routeNotFound: "err.routeNotFound",
  notFound: "err.notFound",
  full: "err.full",
  playing: "err.playing",
  badPassword: "err.badPassword",
  notHost: "err.notHost",
  badNickname: "err.badNickname",
  helloRequired: "err.helloRequired",
  badRoomName: "err.badRoomName",
  badVisibility: "err.badVisibility",
  badMaxPlayers: "err.badMaxPlayers",
  passwordRequired: "err.passwordRequired",
  unknownGame: "err.unknownGame",
  unknownMapMode: "err.unknownMapMode",
  unknownDifficulty: "err.unknownDifficulty",
  unknownTheme: "err.unknownTheme",
  notInRoom: "err.notInRoom",
  boardGenerationFailed: "err.boardGenerationFailed",
  gameStartFailed: "err.gameStartFailed",
  cardNotFound: "err.cardNotFound",
  notPlaying: "err.notPlaying",
  notStarted: "err.notStarted",
  alreadyCleared: "err.alreadyCleared",
  stuck: "err.stuck",
  noPower: "err.noPower",
  victoryComboForbidden: "err.victoryComboForbidden",
  noTarget: "err.noTarget",
  itemUnavailable: "err.itemUnavailable",
  unknownItem: "err.unknownItem",
  noQuota: "err.noQuota",
  noMatch: "err.noMatch",
  badScissorTarget: "err.badScissorTarget",
  invalidTiles: "err.invalidTiles",
  mismatch: "err.mismatch",
  victoryScissorForbidden: "err.victoryScissorForbidden",
  removed: "err.removed",
  sameTile: "err.sameTile",
  locked: "err.locked",
  noPath: "err.noPath",
  unknownCategory: "err.unknownCategory",
  notComplete: "err.notComplete",
  alreadyClaimed: "err.alreadyClaimed",
  timeout: "err.timeout",
};

export const errText = (e?: string): string => {
  if (!e) return t("error.generic");
  if (Object.prototype.hasOwnProperty.call(ERR_LABELS, e)) return t(ERR_LABELS[e as ErrCode]);
  return e;
};

/** 초 → "mm:ss" */
export const fmtClock = (totalSec: number): string => {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** 밀리초 → "mm:ss" */
export const fmtMs = (ms: number): string => fmtClock(Math.round(ms / 1000));
