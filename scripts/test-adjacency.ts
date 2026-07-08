// 인접 동일 완화(reduceAdjacency) 퍼즈: 4개 모드 × 3개 난이도 × 여러 마스크 × 다수 시드로 보드를
// 대량 생성해 (1) 상하좌우 인접 동일 쌍 수의 완화 전/후 평균 (2) 데드락 0건(hasMove) (3) 시드 결정성
// (4) 재시도·재셔플 폭주 없음을 측정·단언한다. shared/ 만 사용(서버·DOM 미의존).
import {
  generateBoard,
  toTileStates,
  MASK_KINDS,
  DIFFICULTIES,
  type Board,
  type MaskKind,
  type GenerateStats,
} from "../shared/board.ts";
import type { DifficultyKey, MapMode } from "../shared/protocol.ts";
import { readFileSync } from "node:fs";

const pool = JSON.parse(
  readFileSync(new URL("../public/data/card-pool.json", import.meta.url), "utf8")
).cards;

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean) =>
  ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n));

// ── 인접 동일 쌍 수 계측 ──────────────────────────────────────
// 비-UP: 층별로 상하좌우 4방향 인접 중 같은 matchKey 쌍(각 쌍 1회, "승" 타일 제외).
function countOrthoSame(board: Board): number {
  const byLayer = new Map<number, Map<string, string>>(); // layer → "r,c" → matchKey
  for (const t of board.tiles) {
    if (t.removed || t.victory) continue;
    let g = byLayer.get(t.layer);
    if (!g) {
      g = new Map();
      byLayer.set(t.layer, g);
    }
    g.set(t.r + "," + t.c, t.matchKey);
  }
  let cnt = 0;
  for (const g of byLayer.values()) {
    for (const [key, mk] of g) {
      const [r, c] = key.split(",").map(Number);
      const right = g.get(r + "," + (c + 1)); // 각 쌍을 오른쪽·아래로만 세어 1회
      const down = g.get(r + 1 + "," + c);
      if (right === mk) cnt++;
      if (down === mk) cnt++;
    }
  }
  return cnt;
}

// UP: 가로(같은 줄) 인접 동일만 — 배치된 초기 줄 + 예비(상승) 줄 모두. UP 은 줄 상승 게임이라 가로 인접이 핵심.
function countUpHorizontal(board: Board): number {
  let cnt = 0;
  const byRow = new Map<number, Map<number, string>>(); // r → c → matchKey
  for (const t of board.tiles) {
    if (t.removed) continue;
    let g = byRow.get(t.r);
    if (!g) {
      g = new Map();
      byRow.set(t.r, g);
    }
    g.set(t.c, t.matchKey);
  }
  for (const g of byRow.values())
    for (const [c, mk] of g) if (g.get(c + 1) === mk) cnt++;
  for (const row of board.reserve)
    for (let i = 0; i + 1 < row.length; i++) if (row[i].matchKey === row[i + 1].matchKey) cnt++;
  return cnt;
}

const countAdj = (b: Board): number => (b.mapMode === "up" ? countUpHorizontal(b) : countOrthoSame(b));

// 완전 동일 직렬화(결정성 비교용): 타일(위치·카드·층·승리) + reserve 카드열.
const sig = (b: Board): string =>
  JSON.stringify({
    t: toTileStates(b),
    ids: b.tiles.map((t) => t.cardId),
    r: b.reserve.map((row) => row.map((c) => c.cardId)),
  });

// ── 퍼즈 실행 ────────────────────────────────────────────────
const MODES: MapMode[] = ["normal", "victory", "shanghai", "up"];
const DIFFS: DifficultyKey[] = DIFFICULTIES.map((d) => d.key);
const SEEDS = 90; // 조합당 시드 수
const BASE_SEED = 4_242_000;

interface Agg {
  boards: number;
  before: number;
  after: number;
  deadlocks: number;
  detFail: number;
  attempts: number;
  floorSafe: number;
  reshuffled: number;
  reshuffledBase: number;
  worstAfter: number;
}
const zero = (): Agg => ({
  boards: 0,
  before: 0,
  after: 0,
  deadlocks: 0,
  detFail: 0,
  attempts: 0,
  floorSafe: 0,
  reshuffled: 0,
  reshuffledBase: 0,
  worstAfter: 0,
});
const aggs = new Map<string, Agg>();

// hasMove 는 board.ts 내부에서 게이트로 이미 쓰이지만, 최종 보드 solvable 을 독립 확인한다.
import { hasMove } from "../shared/board.ts";

for (const mode of MODES) {
  // UP 은 rect 강제라 마스크 순회가 무의미 → rect 한 번만. 그 외는 프리셋 5종 순회.
  const masks: (MaskKind | undefined)[] = mode === "up" ? [undefined] : MASK_KINDS;
  for (const diff of DIFFS) {
    const key = `${mode}/${diff}`;
    const agg = aggs.get(key) ?? zero();
    aggs.set(key, agg);
    for (const mask of masks) {
      for (let s = 0; s < SEEDS; s++) {
        const seed = BASE_SEED + s * 131 + (mask ? mask.length * 7 : 0);
        const opts = { mapMode: mode, ...(mask ? { mask } : {}) };
        // before: 완화 off (순수 셔플 배치) — reshuffle 도 계측해 완화 전 대비 폭주 여부를 비교
        const bStats: GenerateStats = { attempts: 0, floorSafe: 0, reshuffled: 0 };
        const before = generateBoard(pool, diff, seed, { ...opts, adjacencyReduction: false, stats: bStats });
        // after: 완화 on (기본) + 계측
        const stats: GenerateStats = { attempts: 0, floorSafe: 0, reshuffled: 0 };
        const after = generateBoard(pool, diff, seed, { ...opts, stats });
        // 결정성: 같은 시드 2회 → 완전 동일
        const after2 = generateBoard(pool, diff, seed, { ...opts });

        agg.boards++;
        agg.before += countAdj(before);
        const aAfter = countAdj(after);
        agg.after += aAfter;
        agg.worstAfter = Math.max(agg.worstAfter, aAfter);
        if (!hasMove(after)) agg.deadlocks++;
        if (sig(after) !== sig(after2)) agg.detFail++;
        agg.attempts += stats.attempts;
        agg.floorSafe += stats.floorSafe;
        agg.reshuffled += stats.reshuffled;
        agg.reshuffledBase += bStats.reshuffled;
      }
    }
  }
}

// ── 리포트 ───────────────────────────────────────────────────
console.log(`\n[인접 동일 완화 퍼즈] 조합당 시드 ${SEEDS} · 총 보드(after) ${[...aggs.values()].reduce((a, x) => a + x.boards, 0)}`);
console.log(
  "  " +
    ["mode/diff".padEnd(16), "boards".padStart(7), "before".padStart(8), "after".padStart(8), "improve".padStart(9), "worst".padStart(6), "avgAtt".padStart(7), "deadlk".padStart(7), "detFail".padStart(8)].join(" ")
);
let totBefore = 0,
  totAfter = 0,
  totBoards = 0,
  totDead = 0,
  totDet = 0,
  totReshuf = 0,
  totReshufBase = 0,
  totFloorSafe = 0;
for (const mode of MODES)
  for (const diff of DIFFS) {
    const a = aggs.get(`${mode}/${diff}`)!;
    const bAvg = a.before / a.boards;
    const aAvg = a.after / a.boards;
    const imp = bAvg > 0 ? ((1 - aAvg / bAvg) * 100).toFixed(1) + "%" : "n/a";
    const attAvg = (a.attempts / a.boards).toFixed(3);
    console.log(
      "  " +
        [
          `${mode}/${diff}`.padEnd(16),
          String(a.boards).padStart(7),
          bAvg.toFixed(2).padStart(8),
          aAvg.toFixed(2).padStart(8),
          imp.padStart(9),
          String(a.worstAfter).padStart(6),
          attAvg.padStart(7),
          String(a.deadlocks).padStart(7),
          String(a.detFail).padStart(8),
        ].join(" ")
    );
    totBefore += a.before;
    totAfter += a.after;
    totBoards += a.boards;
    totDead += a.deadlocks;
    totDet += a.detFail;
    totReshuf += a.reshuffled;
    totReshufBase += a.reshuffledBase;
    totFloorSafe += a.floorSafe;
  }
const totImp = totBefore > 0 ? (1 - totAfter / totBefore) * 100 : 0;
console.log(
  `\n  합계: before 평균 ${(totBefore / totBoards).toFixed(2)} → after 평균 ${(totAfter / totBoards).toFixed(2)} ` +
    `(개선 ${totImp.toFixed(1)}%) · floorSafe(인접 1쌍 유지) ${totFloorSafe} · reshuffle 완화후 ${totReshuf} / 완화전 ${totReshufBase}`
);
console.log(
  "  주: 가득 찬 판(rect 등)은 사천성 규칙상 인접 동일 쌍이 0 이면 첫 수가 없어 교착 → 최소 1쌍을 남긴다(정상)."
);
console.log(
  "  주: reshuffle 은 완화와 무관하게 순수 셔플 자체가 첫 수 없는 시드에서 나며(완화전=완화후), 완화가 늘리지 않는다."
);

// ── 완료 조건 단언 ───────────────────────────────────────────
console.log("\n[단언]");
check("데드락 0건 (모든 after 보드 hasMove)", totDead === 0);
check("결정성: 같은 시드 2회 완전 동일 (detFail 0)", totDet === 0);
check("전체 인접 동일 쌍 평균 대폭 감소 (after < before·개선율 ≥ 60%)", totAfter < totBefore && totImp >= 60);
// 모드·난이도별로도 완화 개선율이 충분해야 한다(각 조합 ≥ 50% 감소).
let weakImprove = false;
for (const [k, a] of aggs) {
  const bAvg = a.before / a.boards;
  const aAvg = a.after / a.boards;
  if (bAvg > 0 && (aAvg > bAvg || 1 - aAvg / bAvg < 0.5)) {
    weakImprove = true;
    console.log(`    · 개선 부족: ${k} = ${(bAvg > 0 ? (1 - aAvg / bAvg) * 100 : 0).toFixed(1)}%`);
  }
}
check("모드·난이도별 개선율 ≥ 50%", !weakImprove);
// 완화가 가득 찬 판에서도 인접을 실질적으로 없앤다: 비-UP after 평균 ≤ 1.5
// (첫 수용 1쌍 남김 + 종류 중복이 큰 소형 상하이 층의 잔여 포함).
let anyHighAfter = false;
for (const [k, a] of aggs) {
  if (k.startsWith("up/")) continue;
  const avg = a.after / a.boards;
  if (avg > 1.5) { anyHighAfter = true; console.log(`    · after 과다: ${k} = ${avg.toFixed(2)}`); }
}
check("비-UP after 평균 인접 쌍 ≤ 1.5", !anyHighAfter);
// UP 은 가로 인접을 완전히 없앨 수 있다(빈 상단으로 우회 가능 → 첫 수 보장).
let upNotZero = false;
for (const [k, a] of aggs) if (k.startsWith("up/") && a.after > 0) { upNotZero = true; console.log(`    · UP 가로 잔여: ${k} = ${a.after}`); }
check("UP 가로 인접 동일 0 (완전 제거)", !upNotZero);
// 재시도/재셔플 폭주 없음: 완화가 reshuffle 을 완화전 대비 늘리지 않는다(순수 셔플 자체가 첫 수 없는 시드가 원인).
check("완화가 reshuffle 을 늘리지 않음 (완화후 ≤ 완화전)", totReshuf <= totReshufBase);
let nonVictoryAttHigh = false;
for (const [k, a] of aggs) {
  if (k.startsWith("victory/")) continue;
  const avg = a.attempts / a.boards;
  if (avg > 1.05) { nonVictoryAttHigh = true; console.log(`    · attempt 과다: ${k} = ${avg.toFixed(3)}`); }
}
check("비-승리 모드 평균 attempt ≤ 1.05 (재시도 폭주 없음)", !nonVictoryAttHigh);

console.log("\n결과: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
