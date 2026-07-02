// 공용 보드 엔진 기본 동작 테스트 (shared/board.ts)
import {
  generateBoard, hasMove, findHint, reshuffle, occupiedGrid, toTileStates, validateMatch,
} from "../shared/board.ts";
import { readFileSync } from "node:fs";

const pool = JSON.parse(readFileSync(new URL("../public/data/card-pool.json", import.meta.url), "utf8")).cards;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean) => ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n));

const b = generateBoard(pool, "normal", 20260702, { mask: "rect" });
check("타일 수 = 48", b.tiles.length === 48);
check("모든 matchKey 짝수 개", [...b.tiles.reduce((m: Map<string, number>, t) => m.set(t.matchKey, (m.get(t.matchKey) ?? 0) + 1), new Map<string, number>())].every(([, n]) => n % 2 === 0));
check("시작부터 최소 한 수 존재", hasMove(b));
const hint = findHint(b);
check("힌트 한 쌍 반환 + 같은 카드", !!hint && hint[0].matchKey === hint[1].matchKey);
// 서버 권위 검증기와 힌트의 일치
if (hint) {
  const v = validateMatch(b, hint[0].tileId, hint[1].tileId);
  check("validateMatch 가 힌트 쌍을 승인", v.ok);
}
// 한 쌍 제거 후에도 격자 일관성
if (hint) { hint[0].removed = true; hint[1].removed = true; }
const g = occupiedGrid(b);
check("제거 후 점유격자 카운트 일치", g.flat().filter(Boolean).length === 46);
reshuffle(b, 42);
check("재셔플 후에도 수 존재(가능시)", hasMove(b) || b.tiles.filter(t => !t.removed).length === 0);
// TileState 직렬화
const ts = toTileStates(b);
check("toTileStates 길이·필드 일치", ts.length === b.tiles.length && ts.every((s, i) =>
  s.tileId === b.tiles[i].tileId && s.cardIdx === b.tiles[i].cardIdx &&
  s.r === b.tiles[i].r && s.c === b.tiles[i].c && s.layer === b.tiles[i].layer && s.removed === b.tiles[i].removed));
check("cardIdx 가 cards 범위 내", b.tiles.every(t => t.cardIdx >= 0 && t.cardIdx < b.cards.length && b.cards[t.cardIdx].cardId === t.cardId));

console.log("\n결과: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
