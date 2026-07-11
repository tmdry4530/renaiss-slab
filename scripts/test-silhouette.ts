// 피카츄 실루엣 보드 퍼즈: 3개 난이도 × 3개 모드 × 다수 시드로 캔버스·타일 수·데드락·결정성을
// 검증하고, 동일 조건 rect 마스크 대비 생성 재시도·재셔플을 계측한다. shared/ 만 사용(서버·DOM 미의존).
import { readFileSync } from "node:fs";
import {
  DIFFICULTIES,
  generateBoard,
  hasMove,
  toTileStates,
  type Board,
  type GenerateStats,
  type MaskKind,
} from "../shared/board.ts";
import type { DifficultyKey, MapMode } from "../shared/protocol.ts";

const pool = JSON.parse(
  readFileSync(new URL("../public/data/card-pool.json", import.meta.url), "utf8")
).cards;

let pass = 0,
  fail = 0;
const check = (name: string, ok: boolean) =>
  ok ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name));

// 완전 동일 직렬화(결정성 비교용): 타일 상태·카드 ID + reserve 카드열.
const sig = (board: Board): string =>
  JSON.stringify({
    t: toTileStates(board),
    ids: board.tiles.map((tile) => tile.cardId),
    r: board.reserve.map((row) => row.map((card) => card.cardId)),
  });

// 피카츄 머리 도안: easy 10×13/68 · normal 12×16/100 · hard 14×18/142
const EXPECTED: Record<
  DifficultyKey,
  { rows: number; cols: number; layer0: number; layer0Max: number }
> = {
  easy: { rows: 10, cols: 13, layer0: 68, layer0Max: 80 },
  normal: { rows: 12, cols: 16, layer0: 100, layer0Max: 110 },
  hard: { rows: 14, cols: 18, layer0: 142, layer0Max: 150 },
};
const MODES: MapMode[] = ["normal", "victory", "shanghai"];
const DIFFS: DifficultyKey[] = DIFFICULTIES.map((difficulty) => difficulty.key);
const SEEDS = 60;
const BASE_SEED = 7_110_000;

interface Agg {
  boards: number;
  totalTiles: number;
  maxTiles: number;
  pikachuAttempts: number;
  pikachuReshuffled: number;
  rectAttempts: number;
  rectReshuffled: number;
}

const zero = (): Agg => ({
  boards: 0,
  totalTiles: 0,
  maxTiles: 0,
  pikachuAttempts: 0,
  pikachuReshuffled: 0,
  rectAttempts: 0,
  rectReshuffled: 0,
});

const aggs = new Map<string, Agg>();
let canvasFail = 0;
let layer0CountFail = 0;
let layer0LimitFail = 0;
let oddTotal = 0;
let deadlocks = 0;
let detFail = 0;

for (const mode of MODES) {
  for (const diff of DIFFS) {
    const key = `${mode}/${diff}`;
    const expected = EXPECTED[diff];
    const agg = zero();
    aggs.set(key, agg);

    for (let s = 0; s < SEEDS; s++) {
      const seed = BASE_SEED + s * 131;
      const pikachuStats: GenerateStats = { attempts: 0, floorSafe: 0, reshuffled: 0 };
      const board = generateBoard(pool, diff, seed, {
        mapMode: mode,
        mask: "pikachu",
        stats: pikachuStats,
      });
      const repeated = generateBoard(pool, diff, seed, { mapMode: mode, mask: "pikachu" });
      const rectStats: GenerateStats = { attempts: 0, floorSafe: 0, reshuffled: 0 };
      generateBoard(pool, diff, seed, { mapMode: mode, mask: "rect", stats: rectStats });

      const layer0 = board.tiles.filter((tile) => tile.layer === 0).length;
      if (board.rows !== expected.rows || board.cols !== expected.cols) canvasFail++;
      if (layer0 !== expected.layer0) layer0CountFail++;
      if (layer0 > expected.layer0Max) layer0LimitFail++;
      if (board.tiles.length % 2 !== 0) oddTotal++;
      if (!hasMove(board)) deadlocks++;
      if (sig(board) !== sig(repeated)) detFail++;

      agg.boards++;
      agg.totalTiles += board.tiles.length;
      agg.maxTiles = Math.max(agg.maxTiles, board.tiles.length);
      agg.pikachuAttempts += pikachuStats.attempts;
      agg.pikachuReshuffled += pikachuStats.reshuffled;
      agg.rectAttempts += rectStats.attempts;
      agg.rectReshuffled += rectStats.reshuffled;
    }
  }
}

interface SilhouetteCase {
  mask: MaskKind;
  mode: MapMode;
  layer0: Record<DifficultyKey, number>;
}

const SILHOUETTE_CASES: SilhouetteCase[] = [
  { mask: "charizard", mode: "victory", layer0: { easy: 88, normal: 114, hard: 142 } },
  { mask: "strawhat", mode: "rolling", layer0: { easy: 56, normal: 88, hard: 108 } },
  { mask: "whitebeard", mode: "victory", layer0: { easy: 66, normal: 86, hard: 106 } },
  { mask: "laboon", mode: "rolling", layer0: { easy: 58, normal: 82, hard: 108 } },
  { mask: "zeus", mode: "shanghai", layer0: { easy: 62, normal: 80, hard: 106 } },
  { mask: "sudowoodo", mode: "normal", layer0: { easy: 46, normal: 82, hard: 90 } },
  { mask: "skull", mode: "normal", layer0: { easy: 62, normal: 70, hard: 88 } },
  { mask: "apple", mode: "normal", layer0: { easy: 82, normal: 122, hard: 150 } },
  { mask: "unown", mode: "normal", layer0: { easy: 38, normal: 56, hard: 62 } },
];
const SILHOUETTE_SEEDS = 30;
const SILHOUETTE_CANVAS: Record<DifficultyKey, { rows: number; cols: number; layer0Max: number }> = {
  easy: { rows: 10, cols: 13, layer0Max: 90 },
  normal: { rows: 12, cols: 16, layer0Max: 130 },
  hard: { rows: 14, cols: 18, layer0Max: 160 },
};
const observedLayer0 = new Map<string, Set<number>>();
let silhouetteCanvasFail = 0;
let silhouetteLayer0Fail = 0;
let silhouetteLayer0LimitFail = 0;
let silhouetteOddTotal = 0;
let silhouetteDeadlocks = 0;
let silhouetteDetFail = 0;

for (const silhouette of SILHOUETTE_CASES) {
  for (const diff of DIFFS) {
    const expected = SILHOUETTE_CANVAS[diff];
    const observed = new Set<number>();
    observedLayer0.set(`${silhouette.mask}/${diff}`, observed);
    for (let s = 0; s < SILHOUETTE_SEEDS; s++) {
      const seed = BASE_SEED + 100_000 + s * 131;
      const board = generateBoard(pool, diff, seed, {
        mapMode: silhouette.mode,
        mask: silhouette.mask,
      });
      const repeated = generateBoard(pool, diff, seed, {
        mapMode: silhouette.mode,
        mask: silhouette.mask,
      });
      const layer0 = board.tiles.filter((tile) => tile.layer === 0).length;
      observed.add(layer0);
      if (board.rows !== expected.rows || board.cols !== expected.cols) silhouetteCanvasFail++;
      if (layer0 !== silhouette.layer0[diff]) silhouetteLayer0Fail++;
      if (layer0 > expected.layer0Max) silhouetteLayer0LimitFail++;
      if (board.tiles.length % 2 !== 0) silhouetteOddTotal++;
      if (!hasMove(board)) silhouetteDeadlocks++;
      if (sig(board) !== sig(repeated)) silhouetteDetFail++;
    }
  }
}

// UP 은 테마 마스크 지정과 무관하게 rect 및 기존 난이도 크기를 유지해야 한다.
const UP_SEEDS = 10;
let upRectFail = 0;
let upSizeFail = 0;
for (const difficulty of DIFFICULTIES) {
  for (let s = 0; s < UP_SEEDS; s++) {
    const board = generateBoard(pool, difficulty.key, BASE_SEED + 50_000 + s * 131, {
      mapMode: "up",
      mask: "pikachu",
    });
    if (board.maskKind !== "rect" || board.mask.some((row) => row.some((cell) => !cell))) upRectFail++;
    if (board.rows !== difficulty.rows || board.cols !== 10) upSizeFail++;
  }
}

// 빈칸이 많은 실루엣은 rect 보다 재셔플이 적거나 비슷한 것이 정상이다. 환경 변화 추적용 정보이며 단언하지 않는다.
console.log(
  `\n[피카츄 실루엣 퍼즈] 조합당 시드 ${SEEDS} · 피카츄 보드 ${MODES.length * DIFFS.length * SEEDS} · UP 회귀 ${DIFFS.length * UP_SEEDS}`
);
console.log(
  "  " +
    [
      "mode/diff".padEnd(16),
      "boards".padStart(6),
      "tiles(avg/max)".padStart(15),
      "attempts(p/r)".padStart(15),
      "reshuf(p/r)".padStart(13),
    ].join(" ")
);
for (const mode of MODES) {
  for (const diff of DIFFS) {
    const agg = aggs.get(`${mode}/${diff}`)!;
    const avg = (value: number) => (value / agg.boards).toFixed(3);
    console.log(
      "  " +
        [
          `${mode}/${diff}`.padEnd(16),
          String(agg.boards).padStart(6),
          `${(agg.totalTiles / agg.boards).toFixed(1)}/${agg.maxTiles}`.padStart(15),
          `${avg(agg.pikachuAttempts)}/${avg(agg.rectAttempts)}`.padStart(15),
          `${avg(agg.pikachuReshuffled)}/${avg(agg.rectReshuffled)}`.padStart(13),
        ].join(" ")
    );
  }
}
console.log("  주: p=pikachu, r=rect. reshuf 비교는 정보성 계측이며 임계값 단언이 아니다.");

console.log(
  `\n[신규 실루엣 퍼즈] 조합당 시드 ${SILHOUETTE_SEEDS} · 보드 ${SILHOUETTE_CASES.length * DIFFS.length * SILHOUETTE_SEEDS}`
);
for (const silhouette of SILHOUETTE_CASES) {
  const counts = DIFFS.map((diff) => {
    const actual = [...observedLayer0.get(`${silhouette.mask}/${diff}`)!].join("/");
    return `${diff} ${actual} (expected ${silhouette.layer0[diff]})`;
  }).join(" · ");
  console.log(`  ${silhouette.mask.padEnd(11)} ${counts}`);
}

console.log("\n[단언]");
check("캔버스 치수 일치: easy 10×13 / normal 12×16 / hard 14×18", canvasFail === 0);
check("layer 0 타일 수 일치: easy 68 / normal 100 / hard 142", layer0CountFail === 0);
check("layer 0 난이도 상한 준수: easy ≤80 / normal ≤110 / hard ≤150", layer0LimitFail === 0);
check("총 타일 수 짝수 (상하이 상층 포함)", oddTotal === 0);
check("데드락 0건 (모든 피카츄 보드 hasMove)", deadlocks === 0);
check("결정성: 같은 시드 2회 완전 동일", detFail === 0);
check("신규 9종 캔버스 치수 일치: easy 10×13 / normal 12×16 / hard 14×18", silhouetteCanvasFail === 0);
check("신규 9종 layer 0 타일 수 핀 고정", silhouetteLayer0Fail === 0);
check("신규 9종 layer 0 상한 준수: easy ≤90 / normal ≤130 / hard ≤160", silhouetteLayer0LimitFail === 0);
check("신규 9종 총 타일 수 짝수 (상하이 상층 포함)", silhouetteOddTotal === 0);
check("신규 9종 데드락 0건 (모든 보드 hasMove)", silhouetteDeadlocks === 0);
check("신규 9종 결정성: 같은 시드 2회 완전 동일", silhouetteDetFail === 0);
check("UP 은 mask:'pikachu' 지정에도 rect 강제", upRectFail === 0);
check("UP 은 기존 치수 유지: rows 4/6/8, cols 10", upSizeFail === 0);

console.log("\n결과: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
