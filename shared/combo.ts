// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 콤보 상태 머신 (PRD §4.4, FEATURE_SPEC F-09)
// - COMBO_WINDOW_MS(3000ms) 이내 연속 매칭 성공 시 combo+1, 초과 시 1로 리셋
// - 매칭 실패 시 콤보 0 리셋 (Open Issue 4 미확정 → 실패 시 리셋으로 가정, 주석 명시)
// - 5/15 도달 → pair(지정 카드 1쌍 자동 제거), 10/20 도달 → clear(동일 카드 전부 제거)
// 서버·클라이언트 공용. now(ms) 를 주입받아 테스트 가능.
// ─────────────────────────────────────────────────────────────
import { COMBO_WINDOW_MS, type ComboPower, type ComboPowerKind } from "./protocol.ts";
import { isTileFree, type Board } from "./board.ts";

/** 해당 콤보 수치에서 발동되는 콤보 파워 (없으면 undefined) */
export function comboPowerAt(combo: number): ComboPower | undefined {
  if (combo === 5 || combo === 15) return { level: combo, kind: "pair" };
  if (combo === 10 || combo === 20) return { level: combo, kind: "clear" };
  return undefined;
}

/** 순수 함수: 직전 콤보와 경과 시간으로 다음 콤보 계산 (창 이내면 +1, 아니면 1) */
export function nextCombo(prevCombo: number, elapsedMs: number): number {
  return prevCombo > 0 && elapsedMs <= COMBO_WINDOW_MS ? prevCombo + 1 : 1;
}

/** 콤보 상태 머신. now 는 밀리초 단위 단조 시계(주입식 — 테스트 재현 가능). */
export class ComboTracker {
  combo = 0;
  private lastMatchAt = Number.NEGATIVE_INFINITY;

  /** 매칭 성공. 갱신된 콤보와 (도달 시) 콤보 파워를 반환. */
  onMatch(now: number): { combo: number; power?: ComboPower } {
    this.combo = nextCombo(this.combo, now - this.lastMatchAt);
    this.lastMatchAt = now;
    const power = comboPowerAt(this.combo);
    return power ? { combo: this.combo, power } : { combo: this.combo };
  }

  /** 매칭 실패 → 0 리셋 (가정: FEATURE_SPEC Open Issue 4 미확정) */
  onFail(): void {
    this.combo = 0;
  }

  /** 현재 시점 기준 유효 콤보 (창을 넘겼으면 0으로 간주) */
  peek(now: number): number {
    return now - this.lastMatchAt <= COMBO_WINDOW_MS ? this.combo : 0;
  }

  reset(): void {
    this.combo = 0;
    this.lastMatchAt = Number.NEGATIVE_INFINITY;
  }
}

/**
 * 콤보 파워 적용 (경로 판정 무시).
 * - pair: 해당 카드의 미제거 짝 1쌍 제거 (상하이 모드에서는 free 타일 우선, 같은 층끼리)
 * - clear: 해당 카드와 동일한 미제거 타일 전부 제거
 * 제거된 tileId 배열을 반환. 대상이 없으면 빈 배열.
 */
export function applyComboPower(board: Board, cardId: string, kind: ComboPowerKind): number[] {
  const card = board.cards.find((c) => c.cardId === cardId);
  if (!card) return [];
  const targets = board.tiles.filter((t) => !t.removed && t.matchKey === card.matchKey);
  if (targets.length < 2) return [];

  if (kind === "clear") {
    for (const t of targets) t.removed = true;
    return targets.map((t) => t.tileId);
  }

  // pair: 같은 층에서 2장 선택 — free 타일 우선(상하이), 층은 free 쌍이 많은 순
  const byLayer = new Map<number, typeof targets>();
  for (const t of targets) {
    const arr = byLayer.get(t.layer) ?? [];
    arr.push(t);
    byLayer.set(t.layer, arr);
  }
  let best: [number, number] | null = null; // [tileIdA, tileIdB]
  let bestFree = -1;
  for (const group of byLayer.values()) {
    if (group.length < 2) continue;
    const sorted = group
      .slice()
      .sort((a, b) => Number(isTileFree(board, b)) - Number(isTileFree(board, a)));
    const freeCount = Number(isTileFree(board, sorted[0])) + Number(isTileFree(board, sorted[1]));
    if (freeCount > bestFree) {
      bestFree = freeCount;
      best = [sorted[0].tileId, sorted[1].tileId];
    }
  }
  if (!best) return [];
  const removed: number[] = [];
  for (const id of best) {
    const t = board.tiles.find((x) => x.tileId === id)!;
    t.removed = true;
    removed.push(id);
  }
  return removed;
}
