// 맵 모드(롤링/UP/승리/상하이)·마스크·콤보·점수·시드 재현성 테스트 (shared/)
import {
  generateBoard, toTileStates, isTileFree, rollRight, borderRingCells, upRise, findHint, hasMove,
  occupiedGrid, makeMask, MASK_KINDS, DIFFICULTIES, UP_INITIAL_ROWS, validateMatch, type Board,
} from "../shared/board.ts";
import { ComboTracker, comboPowerAt, nextCombo, applyComboPower } from "../shared/combo.ts";
import { matchScore, finalScore, xpFor, rankPlayers, settlementScore } from "../shared/score.ts";
import { COMBO_WINDOW_MS, type DifficultyKey, type MapMode } from "../shared/protocol.ts";
import { maskForTheme } from "../shared/mapThemes.ts";
import { findPath } from "../shared/shisen.ts";
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

// ── 3) 롤링: 바깥 테두리 시계방향 링 회전·내부 고정 ──────────
console.log("[롤링]");
{
  const b = generateBoard(pool, "normal", 11, { mapMode: "rolling", mask: "rect" });
  // 한 쌍 제거해 빈 칸(홀)을 만들어 두고 굴린다 — 홀도 사이클에 포함되어 함께 회전
  const h = findHint(b)!;
  h[0].removed = true; h[1].removed = true;
  const snap = b.tiles.filter((t) => t.layer === 0).map((t) => ({ id: t.tileId, r: t.r, c: t.c, removed: t.removed }));
  const posBefore = new Set(snap.map((p) => p.r + "," + p.c));
  const liveCountBefore = snap.filter((p) => !p.removed).length;
  const beforeCount = countBy(b.tiles.filter((t) => !t.removed), (t) => t.matchKey);
  const ring = borderRingCells(b);
  const ringSet = new Set(ring.map((p) => p.r + "," + p.c));
  rollRight(b);
  const live = b.tiles.filter((t) => !t.removed);
  const byId = new Map(b.tiles.map((t) => [t.tileId, t]));
  check("롤링 후 미제거 타일 수 불변", live.length === liveCountBefore);
  check("롤링 후 matchKey 짝수 유지", [...countBy(live, (t) => t.matchKey).values()].every((n) => n % 2 === 0) && JSON.stringify([...beforeCount].sort()) === JSON.stringify([...countBy(live, (t) => t.matchKey)].sort()));
  // 링 위 타일(제거 포함)은 시계방향으로 한 칸 이동: ring[i]에 있던 타일이 ring[i+1]로
  check("바깥 테두리 타일이 시계방향 1칸 회전", ring.length >= 4 && ring.every((cell, i) => {
    const src = snap.find((p) => p.r === cell.r && p.c === cell.c)!;
    const dest = ring[(i + 1) % ring.length];
    const t = byId.get(src.id)!;
    return t.r === dest.r && t.c === dest.c;
  }));
  // 내부(비테두리) 타일은 이동 없음
  check("내부 타일은 고정(이동 없음)", snap.filter((p) => !ringSet.has(p.r + "," + p.c)).every((p) => {
    const t = byId.get(p.id)!;
    return t.r === p.r && t.c === p.c;
  }));
  check("롤링 후 좌표 충돌 없음", new Set(b.tiles.filter((t) => t.layer === 0).map((t) => t.r + "," + t.c)).size === snap.length);
  check("롤링 후 점유 셀 집합 불변(순열)", new Set(b.tiles.filter((t) => t.layer === 0).map((t) => t.r + "," + t.c)).size === posBefore.size && [...posBefore].every((k) => b.tiles.some((t) => t.layer === 0 && t.r + "," + t.c === k)));
  // 마스크 보드(도넛: 바깥 테두리만 회전)에서도 유효 칸 위 유지
  const bm = generateBoard(pool, "normal", 12, { mapMode: "rolling", mask: "donut" });
  rollRight(bm);
  check("마스크 보드 롤링: 유효 칸 위 유지", bm.tiles.filter((t) => !t.removed).every((t) => bm.mask[t.r - 1][t.c - 1]));
}

// ── 4) UP: 타이머 상승(upRise)·초기 하단 배치·reserve 감소 ────
console.log("[UP]");
{
  const diff = DIFFICULTIES.find((d) => d.key === "normal")!;
  const b = generateBoard(pool, "normal", 21, { mapMode: "up" });
  check("UP 은 rect 마스크 강제(가정)", b.maskKind === "rect");
  check("UP 보드 폭 강제 10(난이도 무관)", b.cols === 10 && b.cols !== diff.cols);
  check("reserve 줄 수 = 난이도 설정(normal=8)", b.reserve.length === diff.reserveRows && diff.reserveRows === 8);
  check("reserve 각 줄은 cols 장·줄 안에서 짝수", b.reserve.every((row) => row.length === b.cols && [...countBy(row, (c) => c.matchKey).values()].every((n) => n % 2 === 0)));
  // 초기엔 하단 UP_INITIAL_ROWS 줄만 배치, 상단은 빈 상태
  const initialRows = Math.min(UP_INITIAL_ROWS, b.rows);
  const occRows = [...new Set(b.tiles.map((t) => t.r))].sort((x, y) => x - y);
  check("초기 배치는 하단 UP_INITIAL_ROWS 줄만", occRows.length === initialRows && occRows.every((r) => r > b.rows - initialRows));
  check("각 하단 줄이 가득 참(cols 장)", occRows.every((r) => b.tiles.filter((t) => t.r === r).length === b.cols));
  check("각 줄 내부에서 카드별 짝수", occRows.every((r) => [...countBy(b.tiles.filter((t) => t.r === r), (t) => t.matchKey).values()].every((n) => n % 2 === 0)));
  check("초기부터 최소 한 수 존재", hasMove(b));
  check("초기 총 타일 = initialRows × cols(짝수)", b.tiles.length === initialRows * b.cols && b.tiles.length % 2 === 0);

  // upRise 1회: 전체 한 줄 상승 + 최하단 한 줄 주입
  const totalLiveBefore = b.tiles.filter((t) => !t.removed).length;
  const reserveBefore = b.reserve.length;
  const res = upRise(b);
  check("upRise 반환 'ok'", res === "ok");
  check("upRise 후 reserve 하나 감소", b.reserve.length === reserveBefore - 1);
  const live = b.tiles.filter((t) => !t.removed);
  check("upRise 후 타일 수 = 기존 + 한 줄", live.length === totalLiveBefore + b.cols);
  check("upRise 후 최하단 줄이 가득 참", live.filter((t) => t.r === b.rows).length === b.cols);
  check("upRise 타일 tileId 유일", new Set(b.tiles.map((t) => t.tileId)).size === b.tiles.length);
  check("upRise 타일 cardIdx 정합", live.every((t) => b.cards[t.cardIdx]?.cardId === t.cardId));
  check("전체 matchKey 짝수 유지", [...countBy(live, (t) => t.matchKey).values()].every((n) => n % 2 === 0));

  // 최상단 점유까지 상승하면 "blocked"(reserve 남아도 상승 보류)
  const b2 = generateBoard(pool, "normal", 22, { mapMode: "up" });
  let last: "ok" | "blocked" | "empty" = "ok";
  for (let i = 0; i < 50 && (last = upRise(b2)) === "ok"; i++);
  check("최상단 점유 시 blocked (reserve 남음)", last === "blocked" && b2.reserve.length > 0);
  check("blocked 시엔 최상단 행 점유 상태", b2.tiles.some((t) => !t.removed && t.r === 1));

  // reserve 소진 시 "empty"
  const b3 = generateBoard(pool, "normal", 23, { mapMode: "up" });
  b3.reserve.length = 0;
  check("reserve 소진 시 empty", upRise(b3) === "empty");
  const nb = generateBoard(pool, "normal", 24);
  check("UP 아닌 보드는 empty", upRise(nb) === "empty");
}

// ── 5) 승리: 합성 "승" 카드 삽입(난이도별 쌍 수)·매칭 시 식별 ──
console.log("[승리]");
{
  const easy = generateBoard(pool, "easy", 30, { mapMode: "victory" });
  const normal = generateBoard(pool, "normal", 31, { mapMode: "victory" });
  const hard = generateBoard(pool, "hard", 32, { mapMode: "victory" });
  check("easy 승리 타일 1쌍(2장)", easy.tiles.filter((t) => t.victory).length === 2);
  check("normal 승리 타일 1쌍(2장)", normal.tiles.filter((t) => t.victory).length === 2);
  check("hard 승리 타일 1쌍(2장)", hard.tiles.filter((t) => t.victory).length === 2);

  const vTiles = normal.tiles.filter((t) => t.victory);
  check("승리 타일 matchKey = __victory__", vTiles.every((t) => t.matchKey === "__victory__"));
  check("승리 타일은 합성 '승' 카드", vTiles.every((t) => t.card.cardId === "__victory__" && t.card.name === "승리" && t.card.gradeLabel === "승리" && t.card.imageUrl === ""));
  check("승리 카드 cards[]에 1회만 등록", normal.cards.filter((c) => c.cardId === "__victory__").length === 1);
  check("__victory__ matchKey 는 승리 타일만", normal.tiles.filter((t) => t.matchKey === "__victory__").length === 2);
  check("모든 승리 타일 cardIdx 정합", vTiles.every((t) => normal.cards[t.cardIdx]?.cardId === "__victory__"));
  check("toTileStates 가 victory 플래그 보존", toTileStates(normal).filter((s) => s.victory).length === 2);
  // 승리 짝 매칭 → 즉시 승리로 판별 가능 (victory:true 기반)
  check("승리 쌍 식별 가능", vTiles.every((t) => t.victory === true));

  // 회귀 방지(플레이 피드백): 시작(꽉 찬 보드)에서 "승" 짝이 서로 이어지면 즉시 종료됨 →
  // 여러 시드·난이도에서 시작 시 승리 짝이 절대 연결되지 않아야 한다.
  const victoryConnectableAtStart = (b: Board): boolean => {
    const vt = b.tiles.filter((t) => t.victory);
    const grid = occupiedGrid(b, 0);
    for (let i = 0; i < vt.length; i++)
      for (let j = i + 1; j < vt.length; j++)
        if (findPath(grid, { r: vt[i].r, c: vt[i].c }, { r: vt[j].r, c: vt[j].c })) return true;
    return false;
  };
  let anyStartConnectable = false;
  for (let s = 0; s < 40 && !anyStartConnectable; s++)
    for (const d of ["easy", "normal", "hard"] as const)
      if (victoryConnectableAtStart(generateBoard(pool, d, 1000 + s, { mapMode: "victory" }))) {
        anyStartConnectable = true;
        break;
      }
  check("승리 짝은 시작 시 서로 연결 불가(즉시 종료 방지)", !anyStartConnectable);
  // 일반 타일은 승리 카드가 아님(전체 짝수 유지)
  check("일반 타일 matchKey 짝수 유지", [...countBy(normal.tiles, (t) => t.matchKey).values()].every((n) => n % 2 === 0));

  // 회귀 방지(플레이 피드백): 콤보 파워(pair/clear)는 "승" 카드를 제거하지 못한다 →
  // 경로 매칭으로만 승리하도록. applyComboPower("__victory__", …) 는 항상 빈 배열.
  {
    const vb = generateBoard(pool, "normal", 77, { mapMode: "victory" });
    const before = vb.tiles.filter((t) => t.victory && !t.removed).length;
    check("콤보 파워 pair 는 승리 카드 제거 불가", applyComboPower(vb, "__victory__", "pair").length === 0);
    check("콤보 파워 clear 는 승리 카드 제거 불가", applyComboPower(vb, "__victory__", "clear").length === 0);
    check("콤보 파워 후 승리 타일 그대로 유지", vb.tiles.filter((t) => t.victory && !t.removed).length === before && before === 2);
  }
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

// ── 7) 콤보: 3초 창·5/10/15/20 발동·파워 적용 ────────────────
console.log("[콤보]");
{
  check("nextCombo: 창 이내 +1", nextCombo(3, COMBO_WINDOW_MS) === 4);
  check("nextCombo: 창 초과 → 1", nextCombo(3, COMBO_WINDOW_MS + 1) === 1);
  const t = new ComboTracker();
  check("첫 매칭 = 콤보 1", t.onMatch(0).combo === 1);
  check("1초 뒤 = 콤보 2", t.onMatch(1000).combo === 2);
  check("2.5초 뒤(창 이내) = 콤보 3 유지", t.onMatch(3500).combo === 3);
  check("3초 초과 뒤 = 콤보 1로 리셋", t.onMatch(7000).combo === 1);
  t.onFail();
  check("매칭 실패 → 0 리셋(가정)", t.combo === 0 && t.onMatch(8000).combo === 1);
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
  // cardKinds 상향으로 일반 보드는 전부 유니크 쌍 → 풀을 6장으로 잘라 의도적으로 중복(종류당 4쌍)을 만든다
  const b = generateBoard(pool.slice(0, 6), "normal", 51, { mask: "rect" });
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

// ── 9) 테마 맵 실루엣/마스크: 13개 맵 각각 실제 mode+difficulty 로 다회 생성 검증 ──
// (a) throw 없음 (b) 마스크 유효 칸·타일 수 짝수 (c) 항상 최소 한 수(풀이가능) (d) layer0 타일이 마스크 위.
// MAP_PRESETS(=.tsx, React) 를 Node 테스트에 끌어오지 않도록 theme→(mode,difficulty) 를 여기서 미러링한다.
console.log("[테마 맵 실루엣]");
{
  const THEME_MAPS: { theme: string; mode: MapMode; diff: DifficultyKey; sil: boolean }[] = [
    { theme: "straw-hat",    mode: "rolling",  diff: "easy", sil: false }, // 롤링 — donut(링)
    { theme: "devil-fruit",  mode: "normal",   diff: "easy", sil: true },  // 일반 — apple 실루엣
    { theme: "monster-ball", mode: "up",       diff: "easy", sil: false }, // UP — rect 강제
    { theme: "pikachu",      mode: "shanghai", diff: "hard", sil: true },  // 상하이 — pikachu 실루엣
    { theme: "charizard",    mode: "victory",  diff: "hard", sil: true },  // 승리 — charizard 실루엣
    { theme: "jolly-roger",  mode: "normal",   diff: "easy", sil: true },  // 일반 — skull 실루엣
    { theme: "magikarp",     mode: "rolling",  diff: "easy", sil: false }, // 롤링 — rect
    { theme: "ditto",        mode: "up",       diff: "hard", sil: false }, // UP — rect 강제
    { theme: "luffy",        mode: "victory",  diff: "hard", sil: true },  // 승리 — star 실루엣
    { theme: "zeus",         mode: "shanghai", diff: "easy", sil: true },  // 상하이 — zeus(뇌운) 실루엣
    { theme: "unown",        mode: "normal",   diff: "hard", sil: true },  // 일반 — unown 실루엣
    { theme: "chopper",      mode: "rolling",  diff: "easy", sil: false }, // 롤링 — donut(링)
    { theme: "navy-road",    mode: "up",       diff: "hard", sil: false }, // UP — rect 강제
  ];
  const RUNS = 100;
  for (const tm of THEME_MAPS) {
    const mask = maskForTheme(tm.theme);
    let ok = true, evenOk = true, moveOk = true, onMaskOk = true, firstErr = "";
    for (let s = 0; s < RUNS && ok; s++) {
      try {
        const b = generateBoard(pool, tm.diff, 424242 + s * 7, {
          mapMode: tm.mode,
          ...(mask ? { mask } : {}),
        });
        const maskCount = b.mask.flat().filter(Boolean).length;
        if (maskCount % 2 !== 0 || b.tiles.length % 2 !== 0) evenOk = false;
        if (!hasMove(b)) moveOk = false;
        if (!b.tiles.filter((t) => t.layer === 0).every((t) => b.mask[t.r - 1]?.[t.c - 1])) onMaskOk = false;
      } catch (e) {
        ok = false;
        firstErr = String(e);
      }
    }
    check(`${tm.theme}(${tm.mode}/${tm.diff}) ${RUNS}회 생성 throw 없음${firstErr ? " — " + firstErr : ""}`, ok);
    check(`${tm.theme} 마스크 유효 칸·타일 수 짝수`, evenOk);
    check(`${tm.theme} 항상 최소 한 수(풀이가능)`, moveOk);
    check(`${tm.theme} layer0 타일이 마스크 위`, onMaskOk);
  }
}

console.log("\n결과: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
