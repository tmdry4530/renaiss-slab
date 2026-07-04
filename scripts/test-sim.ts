// 전 난이도·전 게임 셀렉션 자동 플레이 시뮬레이션 (시드 기반 — 재현 가능)
import { generateBoard, findHint, reshuffle, DIFFICULTIES, type Board } from "../shared/board.ts";
import { readFileSync } from "node:fs";

const all = JSON.parse(readFileSync(new URL("../public/data/card-pool.json", import.meta.url), "utf8")).cards;
const filter = (g: string) => all.filter((c: any) => c.game === g);

function playToEnd(board: Board, seed: number): { cleared: boolean; moves: number; reshuffles: number } {
  let moves = 0, reshuffles = 0, guard = 0;
  while (board.tiles.some((t) => !t.removed)) {
    if (++guard > 100000) return { cleared: false, moves, reshuffles };
    let h = findHint(board);
    if (!h) { reshuffle(board, seed + reshuffles); reshuffles++; h = findHint(board); if (!h) return { cleared: false, moves, reshuffles }; }
    h[0].removed = true; h[1].removed = true; moves++;
  }
  return { cleared: true, moves, reshuffles };
}

let pass = 0, fail = 0;
for (const g of ["pokemon", "one-piece"]) {
  for (const { key } of DIFFICULTIES) {
    let okAll = true, totalRe = 0;
    for (let trial = 0; trial < 20; trial++) {
      const seed = trial * 7919 + 13; // 마스크도 시드로 랜덤 선택됨 (재현 가능)
      const b = generateBoard(filter(g), key, seed);
      const r = playToEnd(b, seed);
      totalRe += r.reshuffles;
      if (!r.cleared) { okAll = false; break; }
    }
    okAll ? pass++ : fail++;
    console.log(`  ${okAll ? "✓" : "✗"} ${g}/${key} 20판 전부 클리어 (총 자동섞기 ${totalRe})`);
  }
}
console.log("\n결과: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
