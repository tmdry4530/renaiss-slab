// 맵 모드(롤링/UP/승리/상하이)·마스크·콤보·점수·시드 재현성 테스트 (shared/)
import {
  generateBoard, toTileStates, isTileFree, rollRight, upInject, findHint,
  occupiedGrid, makeMask, MASK_KINDS, DIFFICULTIES, validateMatch, type Board,
} from "../shared/board.ts";
import { ComboTracker, comboPowerAt, nextCombo, applyComboPower } from "../shared/combo.ts";
import { matchScore, finalScore, xpFor, rankPlayers, settlementScore } from "../shared/score.ts";
import { COMBO_WINDOW_MS } from "../shared/protocol.ts";
import { readFileSync } from "node:fs";

const pool = JSON.parse(readFileSync(new URL("../public/data/card-pool.json", import.meta.url), "utf8")).cards;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean) => ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n));
const countBy = <T,>(arr: T[], key: (t: T) => string) => {
  const m = new Map<string, number>();
  for (const x of arr) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
};

// ── 1) 시드 재현성 ───────────────────────────────────────────
console.log("[시드 재현성]");
{
  const a = generateBoard(pool, "normal", 777);
  const b = generateBoard(pool, "normal", 777);
  const c = generateBoard(pool, "normal", 778);
  const sig = (x: Board) => JSON.stringify({ mask: x.maskKind, t: toTileStates(x), cards: x.cards.map((k) => k.cardId) });
  check("같은 seed → 같은 보드", sig(a) === sig(b));
  check("다른 seed → 다른 보드", sig(a) !== sig(c));
  for (const mode of ["rolling", "up", "victory", "shanghai"] as const) {
    const m1 = generateBoard(pool, "normal", 99, { mapMode: mode });
    const m2 = generateBoard(pool, "normal", 99, { mapMode: mode });
    check(`${mode} 모드도 seed 재현`, sig(m1) === sig(m2) && JSON.stringify(m1.reserve.map(r => r.map(c2 => c2.cardId))) === JSON.stringify(m2.reserve.map(r => r.map(c2 => c2.cardId))));
  }
}

// ── 2) 마스크: 5종 생성·짝수 보정 ────────────────────────────
console.log("[마스크]");
{
  check("마스크 프리셋 5종", MASK_KINDS.length === 5);
  for (const { rows, cols } of DIFFICULTIES) {
    for (const kind of MASK_KINDS) {
      const m = makeMask(kind, rows, cols);
      const n = m.flat().filter(Boolean).length;
      check(`${kind} ${rows}×${cols} 유효 칸 짝수(${n})`, n % 2 === 0 && n >= 2);
    }
  }
  const donut = makeMask("donut", 6, 8);
  check("donut 은 가운데 구멍 존재", donut.flat().some((v) => !v));
  // 보드 타일이 마스크 위에만 놓이는지
  const b = generateBoard(pool, "normal", 5, { mask: "diamond" });
  check("diamond 보드: 타일이 전부 유효 칸 위", b.tiles.every((t) => b.mask[t.r - 1][t.c - 1]));
  check("diamond 보드: 타일 수 = 유효 칸 수(짝수)", b.tiles.length === b.mask.flat().filter(Boolean).length && b.tiles.length % 2 === 0);
  const forced = generateBoard(pool, "normal", 5, { mask: "rect" });
  check("mask:'rect' 강제 옵션", forced.maskKind === "rect" && forced.tiles.length === 48);
}

// ── 3) 롤링: 행 순환·짝수 유지 ───────────────────────────────
console.log("[롤링]");
{
  const b = generateBoard(pool, "normal", 11, { mapMode: "rolling", mask: "rect" });
  // 한 쌍 제거해 빈 칸을 만들어 두고 굴린다
  const h = findHint(b)!;
  h[0].removed = true; h[1].removed = true;
  const before = b.tiles.filter((t) => !t.removed).map((t) => ({ id: t.tileId, r: t.r, c: t.c }));
  const beforeCount = countBy(b.tiles.filter((t) => !t.removed), (t) => t.matchKey);
  rollRight(b);
  const live = b.tiles.filter((t) => !t.removed);
  check("롤링 후 타일 수 불변", live.length === before.length);
  check("롤링 후 matchKey 짝수 유지", [...countBy(live, (t) => t.matchKey).values()].every((n) => n % 2 === 0) && JSON.stringify([...beforeCount].sort()) === JSON.stringify([...countBy(live, (t) => t.matchKey)].sort()));
  const byId = new Map(live.map((t) => [t.tileId, t]));
  check("각 타일이 오른쪽으로 1칸 순환(wrap)", before.every((p) => {
    const t = byId.get(p.id)!;
    return t.r === p.r && t.c === (p.c % b.cols) + 1; // rect: 유효 칸 = 1..cols
  }));
  check("롤링 후 좌표 충돌 없음", new Set(live.map((t) => t.r + "," + t.c)).size === live.length);
  // 마스크 보드에서도 유효 칸 위 유지
  const bm = generateBoard(pool, "normal", 12, { mapMode: "rolling", mask: "donut" });
  rollRight(bm);
  check("마스크 보드 롤링: 유효 칸 위 유지", bm.tiles.filter((t) => !t.removed).every((t) => bm.mask[t.r - 1][t.c - 1]));
}

// ── 4) UP: 줄 소진 시 주입·reserve 감소 ──────────────────────
console.log("[UP]");
{
  const diff = DIFFICULTIES.find((d) => d.key === "normal")!;
  const b = generateBoard(pool, "normal", 21, { mapMode: "up" });
  check("UP 은 rect 마스크 강제(가정)", b.maskKind === "rect");
  check("reserve 줄 수 = 난이도 설정", b.reserve.length === diff.reserveRows);
  check("reserve 각 줄은 cols 장·줄 안에서 짝수", b.reserve.every((row) => row.length === b.cols && [...countBy(row, (c) => c.matchKey).values()].every((n) => n % 2 === 0)));
  check("빈 줄 없으면 주입 안 함", upInject(b) === null);
  // 3행을 통째로 제거 → 주입 트리거 (행 단위 강제 제거라 보드 자체의 짝 균형은 깨진 상태)
  for (const t of b.tiles) if (t.r === 3) t.removed = true;
  const totalLiveBefore = b.tiles.filter((t) => !t.removed).length;
  const beforeCnt = countBy(b.tiles.filter((t) => !t.removed), (t) => t.matchKey);
  const left = upInject(b);
  check("주입 성공 시 남은 reserve 반환", left !== null && left.length === diff.reserveRows - 1);
  const live = b.tiles.filter((t) => !t.removed);
  check("주입 후 타일 수 = 기존 + 한 줄", live.length === totalLiveBefore + b.cols);
  check("최하단 줄이 가득 참", live.filter((t) => t.r === b.rows).length === b.cols);
  // 주입은 줄 안에서 짝이 성립하므로 카드별 증가분이 항상 짝수(전체 짝 균형을 깨지 않음)
  const afterCnt = countBy(live, (t) => t.matchKey);
  check("주입 증가분은 카드별 짝수", [...afterCnt].every(([k, n]) => (n - (beforeCnt.get(k) ?? 0)) % 2 === 0 && n >= (beforeCnt.get(k) ?? 0)));
  check("주입 타일 tileId 유일", new Set(b.tiles.map((t) => t.tileId)).size === b.tiles.length);
  check("주입 타일 cardIdx 정합", live.every((t) => b.cards[t.cardIdx]?.cardId === t.cardId));
  // reserve 소진 시 null
  for (const t of b.tiles) if (t.r === 2) t.removed = true;
  upInject(b);
  for (const t of b.tiles) if (t.r === 2 && !t.removed) t.removed = true;
  check("reserve 소진 후 주입 불가", b.reserve.length === 0 && upInject(b) === null);
}

// ── 5) 승리: victory 쌍 존재·매칭 시 식별 ────────────────────
console.log("[승리]");
{
  const b = generateBoard(pool, "hard", 31, { mapMode: "victory" });
  const vTiles = b.tiles.filter((t) => t.victory);
  check("victory 타일 정확히 1쌍(2장)", vTiles.length === 2);
  check("victory 쌍은 같은 카드", vTiles.length === 2 && vTiles[0].matchKey === vTiles[1].matchKey);
  const vCard = vTiles[0]?.card;
  check("victory 카드 = 풀 내 최고가", !!vCard && b.cards.every((c) => c.priceUsdCents <= vCard.priceUsdCents));
  check("victory 카드는 보드에 그 1쌍만 존재", b.tiles.filter((t) => t.matchKey === vCard.matchKey).length === 2);
  check("toTileStates 가 victory 플래그 보존", toTileStates(b).filter((s) => s.victory).length === 2);
  // 매칭 시 식별: 두 타일이 모두 victory 면 즉시 승리로 판별 가능
  check("victory 쌍 식별 가능", vTiles.every((t) => t.victory === true));
}

// ── 6) 상하이: 층별 짝수·덮인 타일 잠김·free 판정 ────────────
console.log("[상하이]");
{
  const b = generateBoard(pool, "normal", 41, { mapMode: "shanghai" });
  const l0 = b.tiles.filter((t) => t.layer === 0);
  const l1 = b.tiles.filter((t) => t.layer === 1);
  check("2층 보드 생성", l1.length > 0);
  check("층별 타일 수 짝수", l0.length % 2 === 0 && l1.length % 2 === 0);
  check("층별 matchKey 짝수 (층 내 짝 성립)",
    [...countBy(l0, (t) => t.matchKey).values()].every((n) => n % 2 === 0) &&
    [...countBy(l1, (t) => t.matchKey).values()].every((n) => n % 2 === 0));
  check("층 간 카드 종류 서로소", !l0.some((t) => l1.some((u) => u.matchKey === t.matchKey)));
  const covered = l0.find((t) => l1.some((u) => !u.removed && u.r === t.r && u.c === t.c))!;
  check("위층에 덮인 타일은 잠김", !!covered && !isTileFree(b, covered));
  check("위층 타일은 free", l1.every((t) => isTileFree(b, t)));
  // 덮은 타일 제거 → 아래층 해방
  for (const u of l1) if (u.r === covered.r && u.c === covered.c) u.removed = true;
  check("위층 제거 후 아래층 해방", isTileFree(b, covered));
  check("occupiedGrid 층 분리", occupiedGrid(b, 1).flat().filter(Boolean).length === l1.filter((t) => !t.removed).length);
  const h = findHint(b);
  check("힌트는 free + 같은 층 쌍", !!h && h[0].layer === h[1].layer && isTileFree(b, h[0]) && isTileFree(b, h[1]));
  // 잠긴 타일 매칭은 서버 검증에서 거부
  const locked = b.tiles.find((t) => !t.removed && !isTileFree(b, t));
  if (locked) {
    const twin = b.tiles.find((t) => t !== locked && !t.removed && t.matchKey === locked.matchKey)!;
    const v = validateMatch(b, locked.tileId, twin.tileId);
    check("잠긴 타일 매칭 거부", !v.ok && v.reason === "locked");
  }
}

// ── 7) 콤보: 2초 창·5/10/15/20 발동·파워 적용 ────────────────
console.log("[콤보]");
{
  check("nextCombo: 창 이내 +1", nextCombo(3, COMBO_WINDOW_MS) === 4);
  check("nextCombo: 창 초과 → 1", nextCombo(3, COMBO_WINDOW_MS + 1) === 1);
  const t = new ComboTracker();
  check("첫 매칭 = 콤보 1", t.onMatch(0).combo === 1);
  check("1초 뒤 = 콤보 2", t.onMatch(1000).combo === 2);
  check("2.5초 뒤 = 콤보 1로 리셋", t.onMatch(3500).combo === 1);
  t.onFail();
  check("매칭 실패 → 0 리셋(가정)", t.combo === 0 && t.onMatch(4000).combo === 1);
  // 5/10/15/20 발동
  const t2 = new ComboTracker();
  const powers: string[] = [];
  for (let i = 0; i < 20; i++) {
    const { combo, power } = t2.onMatch(i * 100);
    if (power) powers.push(combo + ":" + power.kind + ":" + power.level);
  }
  check("5/15 → pair, 10/20 → clear", JSON.stringify(powers) === JSON.stringify(["5:pair:5", "10:clear:10", "15:pair:15", "20:clear:20"]));
  check("그 외 콤보는 발동 없음", comboPowerAt(6) === undefined && comboPowerAt(4) === undefined);
  // 파워 적용: pair (경로 무관 1쌍 제거)
  const b = generateBoard(pool, "normal", 51, { mask: "rect" });
  const anyCard = b.cards.find((c) => b.tiles.filter((x) => !x.removed && x.matchKey === c.matchKey).length >= 4)!;
  const beforeN = b.tiles.filter((x) => !x.removed && x.matchKey === anyCard.matchKey).length;
  const removedPair = applyComboPower(b, anyCard.cardId, "pair");
  check("pair: 정확히 2장 제거", removedPair.length === 2 && b.tiles.filter((x) => !x.removed && x.matchKey === anyCard.matchKey).length === beforeN - 2);
  check("pair: 제거 타일은 해당 카드", removedPair.every((id) => b.tiles.find((x) => x.tileId === id)!.matchKey === anyCard.matchKey));
  // 파워 적용: clear (동일 카드 전부 제거)
  const removedAll = applyComboPower(b, anyCard.cardId, "clear");
  check("clear: 남은 동일 카드 전부 제거", removedAll.length === beforeN - 2 && b.tiles.every((x) => x.matchKey !== anyCard.matchKey || x.removed));
  // 상하이: free 타일 우선
  const sb = generateBoard(pool, "normal", 52, { mapMode: "shanghai" });
  const l1card = sb.tiles.find((x) => x.layer === 1)!.card;
  const rm = applyComboPower(sb, l1card.cardId, "pair");
  const rmTiles = rm.map((id) => sb.tiles.find((x) => x.tileId === id)!);
  check("상하이 pair: free 타일 우선 제거", rm.length === 2 && rmTiles.every((x) => x.layer === rmTiles[0].layer));
}

// ── 8) 점수·경험치·순위 ──────────────────────────────────────
console.log("[점수·순위]");
{
  check("기본 100점", matchScore(1) === 100);
  check("콤보 3 = 100 + 40", matchScore(3) === 140);
  check("클리어 보너스 반영", finalScore(1000, true) === 1500 && finalScore(1000, false) === 1000);
  check("xp = floor(score/10) + 클리어 50", xpFor(1234, true) === 173 && xpFor(1234, false) === 123);
  check("환산 점수: 잔여 적을수록 ↑", settlementScore(500, 4, 48) > settlementScore(500, 40, 48));
  const ranks = rankPlayers([
    { playerId: "a", nickname: "A", score: 900, remaining: 10, cleared: false, timeMs: 60000 },
    { playerId: "b", nickname: "B", score: 2000, remaining: 0, cleared: true, timeMs: 50000 },
    { playerId: "c", nickname: "C", score: 100, remaining: 4, cleared: false, timeMs: 60000 },
    { playerId: "d", nickname: "D", score: 1800, remaining: 0, cleared: true, timeMs: 40000 },
    { playerId: "e", nickname: "E", score: 300, remaining: 4, cleared: false, timeMs: 60000 },
  ]);
  check("클리어자 finishTime 순 우선", ranks[0].playerId === "d" && ranks[1].playerId === "b");
  check("미클리어자 remaining ↑ → score ↓", ranks[2].playerId === "e" && ranks[3].playerId === "c" && ranks[4].playerId === "a");
  check("rank 1..N 부여", ranks.map((r) => r.rank).join(",") === "1,2,3,4,5");
}

console.log("\n결과: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
