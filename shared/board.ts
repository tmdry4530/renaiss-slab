// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 공용 보드 엔진 (서버·클라이언트 공용, DOM/Node 전용 API 사용 금지)
// 보드 생성(시드 RNG)·마스크(비사각형 맵 모양)·모드별 규칙(상하이/승리/UP/롤링)·
// 힌트/교착감지·재셔플·직렬화(TileState). shisen.findPath 위에 구축.
// ─────────────────────────────────────────────────────────────
import type { GameCard } from "./cards.ts";
import type { DifficultyKey, MapMode, TileState } from "./protocol.ts";
import { findPath, type Point } from "./shisen.ts";

// ── 시드 기반 RNG (mulberry32) ───────────────────────────────
// 서버 권위 + 테스트 재현성: 같은 seed → 항상 같은 난수열 → 같은 보드.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 셔플 (시드 rnd 주입, 원본 불변) */
export function seededShuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── 타일/보드 모델 ───────────────────────────────────────────
// protocol.TileState 와 호환되는 필드 + 엔진 내부 편의용 card 참조.
export interface Tile {
  tileId: number;
  cardIdx: number; // Board.cards 인덱스 (BoardInit.cards 와 동일)
  cardId: string; // 편의 필드 (= card.cardId)
  matchKey: string; // "같은 카드" 판정 키 (= card.matchKey)
  r: number; // 패딩 격자 기준 1..rows
  c: number; // 1..cols
  layer: number; // 상하이 모드 겹층 (기본 0)
  removed: boolean;
  victory?: boolean; // 승리 모드 특수 카드
  card: GameCard;
}

export interface Board {
  rows: number;
  cols: number;
  mapMode: MapMode;
  difficulty: DifficultyKey;
  seed: number;
  maskKind: MaskKind;
  mask: boolean[][]; // rows×cols(0-based) — layer 0 의 유효 칸
  tiles: Tile[];
  cards: GameCard[]; // 이 판에 등장하는 카드 목록 (tiles[].cardIdx 참조 대상)
  reserve: GameCard[][]; // UP 모드 예비 줄 덱 (한 원소 = 한 줄 분량, 줄 안에서 짝 성립)
  nextTileId: number;
}

/** 보드 타일을 프로토콜 TileState[] 로 직렬화 */
export function toTileStates(board: Board): TileState[] {
  return board.tiles.map((t) => ({
    tileId: t.tileId,
    cardIdx: t.cardIdx,
    r: t.r,
    c: t.c,
    layer: t.layer,
    removed: t.removed,
    ...(t.victory ? { victory: true } : {}),
  }));
}

// ── 난이도 ───────────────────────────────────────────────────
// F-05: 난이도별 카드 종류 수 차등 — easy 는 종류가 적어 짝이 많이 중복(쉬움),
// hard 는 종류가 많아 같은 카드 찾기가 어려움. reserveRows 는 UP 모드 예비 줄 수.
export interface Difficulty {
  key: DifficultyKey;
  label: string;
  rows: number;
  cols: number;
  cardKinds: number; // 카드 종류 수 상한 (풀 크기로 자동 캡)
  reserveRows: number; // UP 모드 예비 줄 수 (2~3)
}

export const DIFFICULTIES: Difficulty[] = [
  { key: "easy", label: "쉬움 (6×4)", rows: 4, cols: 6, cardKinds: 6, reserveRows: 2 },
  { key: "normal", label: "보통 (8×6)", rows: 6, cols: 8, cardKinds: 16, reserveRows: 2 },
  { key: "hard", label: "어려움 (10×8)", rows: 8, cols: 10, cardKinds: 30, reserveRows: 3 },
];

export function resolveDifficulty(d: DifficultyKey | Difficulty): Difficulty {
  if (typeof d !== "string") return d;
  const found = DIFFICULTIES.find((x) => x.key === d);
  if (!found) throw new Error("알 수 없는 난이도: " + d);
  return found;
}

// ── 마스크 (비사각형 맵 모양, PRD §6) ────────────────────────
// 매 라운드 다양한 형태의 맵. true = 타일이 놓이는 유효 칸.
export type MaskKind = "rect" | "diamond" | "donut" | "cross" | "corners";
export const MASK_KINDS: MaskKind[] = ["rect", "diamond", "donut", "cross", "corners"];

/** rows×cols 마스크 생성. 유효 칸 수가 항상 짝수가 되도록 보정한다. */
export function makeMask(kind: MaskKind, rows: number, cols: number): boolean[][] {
  const m = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
  const cr = (rows - 1) / 2;
  const cc = (cols - 1) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      switch (kind) {
        case "rect":
          m[r][c] = true;
          break;
        case "diamond":
          // 마름모: 중심 거리의 정규화 합 ≤ 1 (+ 여유)
          m[r][c] = Math.abs(r - cr) / (rows / 2) + Math.abs(c - cc) / (cols / 2) <= 1.001;
          break;
        case "donut": {
          // 도넛: 가운데 구멍 뚫린 사각형
          const hr = Math.max(1, Math.floor(rows / 3));
          const hc = Math.max(2, Math.floor(cols / 3));
          const r0 = Math.floor((rows - hr) / 2);
          const c0 = Math.floor((cols - hc) / 2);
          const inHole = r >= r0 && r < r0 + hr && c >= c0 && c < c0 + hc;
          m[r][c] = !inHole;
          break;
        }
        case "cross": {
          // 십자: 중앙 가로 밴드 ∪ 중앙 세로 밴드
          const bandR = Math.max(1, Math.floor(rows / 3));
          const bandC = Math.max(1, Math.floor(cols / 3));
          const inRowBand = r >= bandR && r <= rows - 1 - bandR;
          const inColBand = c >= bandC && c <= cols - 1 - bandC;
          m[r][c] = inRowBand || inColBand;
          break;
        }
        case "corners": {
          // 모서리 깎임: 네 귀퉁이 k×k 제거
          const k = Math.max(1, Math.floor(Math.min(rows, cols) / 3));
          const corner =
            (r < k && c < k) ||
            (r < k && c >= cols - k) ||
            (r >= rows - k && c < k) ||
            (r >= rows - k && c >= cols - k);
          m[r][c] = !corner;
          break;
        }
      }
    }
  }
  // 짝수 보정: 유효 칸 수가 홀수면 마지막 유효 칸 하나를 제거
  let count = 0;
  for (const row of m) for (const v of row) if (v) count++;
  if (count % 2 === 1) {
    outer: for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        if (m[r][c]) {
          m[r][c] = false;
          break outer;
        }
      }
    }
  }
  return m;
}

/** 마스크의 유효 칸 목록 (1-based 좌표, 스캔 순서 고정) */
export function maskCells(mask: boolean[][]): Point[] {
  const cells: Point[] = [];
  for (let r = 0; r < mask.length; r++)
    for (let c = 0; c < mask[r].length; c++) if (mask[r][c]) cells.push({ r: r + 1, c: c + 1 });
  return cells;
}

// 상하이 layer 1: 중앙 축소 영역(대략 절반 크기) ∩ layer 0 마스크, 짝수 보정
function shanghaiUpperCells(mask: boolean[][], rows: number, cols: number): Point[] {
  const hr = Math.max(2, Math.floor(rows / 2));
  const hc = Math.max(2, Math.floor(cols / 2));
  const r0 = Math.floor((rows - hr) / 2) + 1; // 1-based 시작
  const c0 = Math.floor((cols - hc) / 2) + 1;
  const cells: Point[] = [];
  for (let r = r0; r < r0 + hr; r++)
    for (let c = c0; c < c0 + hc; c++) if (mask[r - 1][c - 1]) cells.push({ r, c });
  if (cells.length % 2 === 1) cells.pop(); // 짝수 보정
  return cells;
}

// ── 보드 생성 ────────────────────────────────────────────────
export interface GenerateOpts {
  mapMode?: MapMode; // 기본 "normal"
  mask?: MaskKind; // 지정 시 강제 (예: "rect"). 미지정 시 시드 기반 랜덤 선택
}

/**
 * 시드 기반 보드 생성. 같은 (pool, difficulty, seed, opts) → 항상 같은 보드.
 * - 마스크: opts.mask 강제 또는 시드 랜덤 (UP 모드는 줄 상승 로직 단순화를 위해 rect 강제 — 가정)
 * - 상하이: 2층 보드. 층별로 짝수 장, 층 내에서만 짝 성립(층별 페어 생성 — 단순화 가정)
 * - 승리: 풀에서 최고가 카드 1쌍을 victory 로 마킹 (해당 카드는 보드에 정확히 1쌍만 존재)
 * - UP: 난이도별 reserveRows 만큼 예비 줄 덱 생성 (줄 안에서 짝 성립)
 */
export function generateBoard(
  pool: GameCard[],
  difficulty: DifficultyKey | Difficulty,
  seed: number,
  opts: GenerateOpts = {}
): Board {
  const diff = resolveDifficulty(difficulty);
  const mapMode: MapMode = opts.mapMode ?? "normal";
  const rnd = mulberry32(seed >>> 0);
  const usable = pool.filter((c) => c.imageUrl);
  if (usable.length === 0) throw new Error("카드 풀이 비어 있습니다");

  const maskKind: MaskKind =
    opts.mask ?? (mapMode === "up" ? "rect" : MASK_KINDS[Math.floor(rnd() * MASK_KINDS.length)]);
  const mask = makeMask(maskKind, diff.rows, diff.cols);

  // 층별 셀 목록 (layer 0 = 마스크 전체, 상하이 layer 1 = 중앙 축소 영역)
  const layerCells: Point[][] = [maskCells(mask)];
  if (mapMode === "shanghai") {
    const upper = shanghaiUpperCells(mask, diff.rows, diff.cols);
    if (upper.length >= 2) layerCells.push(upper);
  }

  // 카드 종류 선택 (난이도별 종류 수 차등, 풀 크기로 캡)
  const kindCount = Math.min(diff.cardKinds, usable.length);
  const kinds = seededShuffle(usable, rnd).slice(0, kindCount);

  // 승리 모드: 종류 중 최고가 카드 = 승리 카드 (보드에 1쌍만 배치)
  const victoryCard =
    mapMode === "victory"
      ? kinds.reduce((a, b) => (b.priceUsdCents > a.priceUsdCents ? b : a))
      : null;

  // 상하이: 층 간 짝 맞추기 금지 단순화 — 층별로 서로소 종류 집합 사용
  const kindsByLayer: GameCard[][] = [kinds];
  if (layerCells.length === 2) {
    const total = layerCells[0].length + layerCells[1].length;
    const n1 = Math.max(1, Math.min(kindCount - 1, Math.round((kindCount * layerCells[1].length) / total)));
    kindsByLayer[0] = kinds.slice(0, kindCount - n1);
    kindsByLayer[1] = kinds.slice(kindCount - n1);
  }

  const cardsList: GameCard[] = [];
  const cardIdxOf = new Map<string, number>();
  const idxOf = (card: GameCard): number => {
    let i = cardIdxOf.get(card.cardId);
    if (i === undefined) {
      i = cardsList.length;
      cardsList.push(card);
      cardIdxOf.set(card.cardId, i);
    }
    return i;
  };
  // 종류를 미리 등록해 cards 인덱스를 안정화 (reserve 주입 카드 포함)
  for (const k of kinds) idxOf(k);

  // UP 모드: 예비 줄 덱 (줄 안에서 짝 성립 → 주입 후에도 전체 짝수 유지)
  const reserve: GameCard[][] = [];
  if (mapMode === "up") {
    for (let rrow = 0; rrow < diff.reserveRows; rrow++) {
      const rowDeck: GameCard[] = [];
      for (let p = 0; p < diff.cols / 2; p++) {
        const card = kinds[Math.floor(rnd() * kinds.length)];
        rowDeck.push(card, card);
      }
      reserve.push(seededShuffle(rowDeck, rnd));
    }
  }

  // 배치 시도: 시작부터 최소 한 수 보장 (실패 시 재셔플 → 재시도, 모두 시드 rnd 기반)
  for (let attempt = 0; attempt < 60; attempt++) {
    const tiles: Tile[] = [];
    let tileId = 0;
    for (let layer = 0; layer < layerCells.length; layer++) {
      const cells = layerCells[layer];
      const layerKinds = kindsByLayer[layer];
      const pairs = cells.length / 2;
      const deck: GameCard[] = [];
      if (layer === 0 && victoryCard) {
        // 승리 카드 1쌍 고정 + 나머지는 승리 카드 제외 종류를 순환
        deck.push(victoryCard, victoryCard);
        const rest = layerKinds.filter((k) => k.cardId !== victoryCard.cardId);
        const cyc = rest.length ? rest : layerKinds;
        for (let p = 1; p < pairs; p++) {
          const card = cyc[(p - 1) % cyc.length];
          deck.push(card, card);
        }
      } else {
        for (let p = 0; p < pairs; p++) {
          const card = layerKinds[p % layerKinds.length];
          deck.push(card, card);
        }
      }
      const shuffled = seededShuffle(deck, rnd);
      cells.forEach((cell, i) => {
        const card = shuffled[i];
        tiles.push({
          tileId: tileId++,
          cardIdx: idxOf(card),
          cardId: card.cardId,
          matchKey: card.matchKey,
          r: cell.r,
          c: cell.c,
          layer,
          removed: false,
          ...(victoryCard && layer === 0 && card.cardId === victoryCard.cardId ? { victory: true } : {}),
          card,
        });
      });
    }
    const board: Board = {
      rows: diff.rows,
      cols: diff.cols,
      mapMode,
      difficulty: diff.key,
      seed,
      maskKind,
      mask,
      tiles,
      cards: cardsList,
      reserve: reserve.map((row) => row.slice()),
      nextTileId: tileId,
    };
    if (hasMove(board)) return board;
    reshuffleWith(board, rnd);
    if (hasMove(board)) return board;
  }
  throw new Error("보드 생성 실패");
}

// ── 점유 격자 / 선택 가능 판정 ───────────────────────────────
/** 해당 layer 의 점유 격자(패딩 포함). true = 미제거 타일 존재(통과 불가). */
export function occupiedGrid(board: Board, layer = 0): boolean[][] {
  const R = board.rows + 2;
  const C = board.cols + 2;
  const g = Array.from({ length: R }, () => Array<boolean>(C).fill(false));
  for (const t of board.tiles) if (!t.removed && t.layer === layer) g[t.r][t.c] = true;
  return g;
}

/** 상하이 모드: 같은 (r,c) 에 layer+1 의 미제거 타일이 있으면 잠김(선택 불가). */
export function isTileFree(board: Board, tile: Tile): boolean {
  if (tile.removed) return false;
  if (board.mapMode !== "shanghai") return true;
  return !board.tiles.some(
    (o) => !o.removed && o.layer === tile.layer + 1 && o.r === tile.r && o.c === tile.c
  );
}

const pt = (t: Tile): Point => ({ r: t.r, c: t.c });

// ── 매칭 검증 (서버 권위 판정용) ─────────────────────────────
export type MatchResult =
  | { ok: true; tiles: [Tile, Tile]; path: Point[] }
  | { ok: false; reason: "notFound" | "removed" | "sameTile" | "locked" | "mismatch" | "noPath" };

/** 두 tileId 의 매칭 정당성 검증: 같은 카드 + (상하이) 둘 다 free·같은 층 + 꺾임 ≤2 경로. */
export function validateMatch(board: Board, tileA: number, tileB: number): MatchResult {
  const a = board.tiles.find((t) => t.tileId === tileA);
  const b = board.tiles.find((t) => t.tileId === tileB);
  if (!a || !b) return { ok: false, reason: "notFound" };
  if (a === b) return { ok: false, reason: "sameTile" };
  if (a.removed || b.removed) return { ok: false, reason: "removed" };
  if (!isTileFree(board, a) || !isTileFree(board, b)) return { ok: false, reason: "locked" };
  // 층 내에서만 짝 성립 (상하이 단순화 가정) + 같은 카드
  if (a.layer !== b.layer || a.matchKey !== b.matchKey) return { ok: false, reason: "mismatch" };
  const path = findPath(occupiedGrid(board, a.layer), pt(a), pt(b));
  if (!path) return { ok: false, reason: "noPath" };
  return { ok: true, tiles: [a, b], path };
}

// ── 힌트 / 교착 감지 ─────────────────────────────────────────
/** 연결 가능한 같은 카드 한 쌍(상하이면 free + 같은 층만 후보). 없으면 null. */
export function findHint(board: Board): [Tile, Tile] | null {
  const grids = new Map<number, boolean[][]>();
  const gridOf = (layer: number) => {
    let g = grids.get(layer);
    if (!g) {
      g = occupiedGrid(board, layer);
      grids.set(layer, g);
    }
    return g;
  };
  const live = board.tiles.filter((t) => !t.removed && isTileFree(board, t));
  const groups = new Map<string, Tile[]>();
  for (const t of live) {
    const key = t.matchKey + "|" + t.layer; // 층 내에서만 짝 성립
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++)
        if (findPath(gridOf(group[i].layer), pt(group[i]), pt(group[j]))) return [group[i], group[j]];
  }
  return null;
}

export const hasMove = (board: Board): boolean => findHint(board) !== null;

// ── 재셔플 ───────────────────────────────────────────────────
/** 남은 타일의 카드만 자리 위에서 섞는다(상하이는 층별로). 최소 한 수 보장(여러 번 시도). */
export function reshuffle(board: Board, seed: number = Date.now() & 0xffffffff): void {
  reshuffleWith(board, mulberry32(seed >>> 0));
}

function reshuffleWith(board: Board, rnd: () => number): void {
  const layers = [...new Set(board.tiles.filter((t) => !t.removed).map((t) => t.layer))];
  for (let attempt = 0; attempt < 40; attempt++) {
    for (const layer of layers) {
      const live = board.tiles.filter((t) => !t.removed && t.layer === layer);
      const payload = seededShuffle(
        live.map((t) => ({ card: t.card, cardIdx: t.cardIdx, victory: t.victory })),
        rnd
      );
      live.forEach((t, i) => {
        t.card = payload[i].card;
        t.cardIdx = payload[i].cardIdx;
        t.cardId = payload[i].card.cardId;
        t.matchKey = payload[i].card.matchKey;
        if (payload[i].victory) t.victory = true;
        else delete t.victory;
      });
    }
    if (hasMove(board)) return;
  }
}

// ── UP 모드 ──────────────────────────────────────────────────
/**
 * UP 모드 상승 주입.
 * 가정(주석 명시): FEATURE_SPEC 의 "특정 층의 매칭 가능 카드 소진 → 최하단부터 한 줄 추가 상승"을
 * "어떤 줄(행)의 타일이 전부 제거되면, 그 아래 줄들을 한 줄 위로 shift 하고 최하단에 예비 한 줄 주입"
 * 으로 구현한다. 주입 후 남은 reserve 를 반환하고, 주입 조건이 아니면 null 을 반환한다.
 */
export function upInject(board: Board): GameCard[][] | null {
  if (board.mapMode !== "up" || board.reserve.length === 0) return null;
  const live = board.tiles.filter((t) => !t.removed);
  if (live.length === 0) return null; // 전부 제거 = 클리어, 주입 없음
  // 완전히 비워진 줄(위에서부터) 탐색
  let emptyRow = -1;
  for (let r = 1; r <= board.rows; r++) {
    if (!live.some((t) => t.r === r)) {
      emptyRow = r;
      break;
    }
  }
  if (emptyRow < 0) return null;
  // 빈 줄 아래의 미제거 타일을 한 줄 위로 shift
  for (const t of live) if (t.r > emptyRow) t.r -= 1;
  // 최하단에 예비 한 줄 주입 (UP 은 rect 마스크 — c = 1..cols 전부 유효)
  const rowCards = board.reserve.shift()!;
  const idxOf = new Map(board.cards.map((c, i) => [c.cardId, i] as const));
  rowCards.forEach((card, i) => {
    let ci = idxOf.get(card.cardId);
    if (ci === undefined) {
      ci = board.cards.length;
      board.cards.push(card);
      idxOf.set(card.cardId, ci);
    }
    board.tiles.push({
      tileId: board.nextTileId++,
      cardIdx: ci,
      cardId: card.cardId,
      matchKey: card.matchKey,
      r: board.rows,
      c: i + 1,
      layer: 0,
      removed: false,
      card,
    });
  });
  return board.reserve;
}

// ── 롤링 모드 ────────────────────────────────────────────────
/**
 * 각 행에서 미제거 타일을 마스크 내 유효 칸 기준 오른쪽으로 1칸 순환 이동(줄 끝은 wrap).
 * 제거된 칸(빈 칸)은 이동 대상이 아니며, 미제거 타일만 같은 행의 유효 셀 목록 위에서 한 칸씩 민다.
 * 유효 셀 인덱스 i → i+1 (mod n) 은 전단사라 충돌이 없다.
 */
export function rollRight(board: Board): void {
  for (let r = 1; r <= board.rows; r++) {
    const validCols: number[] = [];
    for (let c = 1; c <= board.cols; c++) if (board.mask[r - 1][c - 1]) validCols.push(c);
    if (validCols.length < 2) continue;
    const idxByCol = new Map(validCols.map((c, i) => [c, i] as const));
    for (const t of board.tiles) {
      if (t.removed || t.layer !== 0 || t.r !== r) continue;
      const i = idxByCol.get(t.c);
      if (i === undefined) continue;
      t.c = validCols[(i + 1) % validCols.length];
    }
  }
}

export { findPath, canConnect } from "./shisen.ts";
export type { Point } from "./shisen.ts";
