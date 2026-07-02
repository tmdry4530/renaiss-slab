// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 점수·경험치·순위 산정 (PRD §4.2, FEATURE_SPEC F-11)
// 서버·클라이언트 공용 순수 함수 모음.
// ─────────────────────────────────────────────────────────────
import type { RankEntry } from "./protocol.ts";

export const BASE_MATCH_SCORE = 100; // 매칭 1회 기본 점수
export const COMBO_BONUS_PER_STEP = 20; // 콤보 1단계당 보너스
export const CLEAR_BONUS_SCORE = 500; // 가정: 클리어 보너스 점수 (문서 미확정 → 임의 결정)
export const CLEAR_BONUS_XP = 50; // 클리어 시 추가 경험치

/** 매칭 1회 점수: 기본 100점 + 콤보 보너스 (콤보 2 이상이면 (combo-1)*20 — 기존 코드 유지) */
export function matchScore(combo: number): number {
  return BASE_MATCH_SCORE + (combo >= 2 ? (combo - 1) * COMBO_BONUS_PER_STEP : 0);
}

/** 최종 점수: 누적 점수 + 클리어 보너스 */
export function finalScore(score: number, cleared: boolean): number {
  return score + (cleared ? CLEAR_BONUS_SCORE : 0);
}

/**
 * 잔여 패 기반 환산 점수 (2위 이하 비교·표시용 참고 지표).
 * 남은 패가 적을수록(진행률이 높을수록) 높다. 순위 자체는 rankPlayers 의 정렬 규칙을 따른다.
 */
export function settlementScore(score: number, remaining: number, totalTiles: number): number {
  const progress = totalTiles > 0 ? (totalTiles - remaining) / totalTiles : 0;
  return score + Math.round(progress * 100);
}

/** 경험치: floor(점수/10) + 클리어 보너스 50 */
export function xpFor(score: number, cleared: boolean): number {
  return Math.floor(score / 10) + (cleared ? CLEAR_BONUS_XP : 0);
}

export interface RankInput {
  playerId: string;
  nickname: string;
  score: number;
  remaining: number; // 유예 시간 종료 시점의 남은 패 수
  cleared: boolean;
  timeMs: number; // 클리어자: 클리어 소요 시간 / 미클리어자: 플레이 시간
}

/**
 * 순위 산정 (FEATURE_SPEC F-11):
 * 1) 클리어자 먼저 — finishTime(timeMs) 오름차순
 * 2) 미클리어자 — remaining 오름차순 → score 내림차순
 * 동점 시 추가 룰 없음 (FEATURE_SPEC Open Issue 5: 별도 타이브레이커 없이 그대로 순번 부여)
 */
export function rankPlayers(entries: RankInput[]): RankEntry[] {
  const sorted = entries.slice().sort((a, b) => {
    if (a.cleared !== b.cleared) return a.cleared ? -1 : 1;
    if (a.cleared && b.cleared) return a.timeMs - b.timeMs;
    if (a.remaining !== b.remaining) return a.remaining - b.remaining;
    return b.score - a.score;
  });
  return sorted.map((e, i) => ({
    playerId: e.playerId,
    nickname: e.nickname,
    rank: i + 1,
    score: e.score,
    remaining: e.remaining,
    cleared: e.cleared,
    timeMs: e.timeMs,
  }));
}
