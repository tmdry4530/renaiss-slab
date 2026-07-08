// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 공용 보드 엔진 (서버·클라이언트 공용, DOM/Node 전용 API 사용 금지)
// 보드 생성(시드 RNG)·마스크(비사각형 맵 모양)·모드별 규칙(상하이/승리/UP/롤링)·
// 힌트/교착감지·재셔플·직렬화(TileState). shisen.findPath 위에 구축.
// ─────────────────────────────────────────────────────────────
import { victoryCard, type GameCard } from "./cards.ts";
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

// 4방향(상하좌우) 오프셋 — 대각은 인접 대상 아님.
const ORTHO: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * 인접 동일 완화: 격자 위 셀 배치(cells 와 평행한 assign)에서 상하좌우 4방향으로 붙은 동일 matchKey
 * 쌍의 수를 결정적 그리디 스왑으로 줄인 새 배치를 반환한다. cells 에 없는 좌표(승리 셀·다른 층·마스크
 * 빈칸)는 이웃으로 잡히지 않아 자연히 완화 대상에서 빠진다(경계·홀은 통과). 대각 인접은 세지 않는다.
 *
 * 불변식: assign 의 카드 멀티셋을 보존한다(자리만 교환) — matchKey 짝수·cardIdx 정합·풀이 종류가 그대로.
 * 결정성: 후보 순회 순서를 rnd 로 한 번만 섞고(스왑 판정 자체엔 rnd 미사용) 같은 시드 → 항상 같은 결과.
 * 비용: 충돌(동일 이웃 있는) 셀만 후보 전체와 비교 → 충돌이 희소한 일반 보드는 사실상 준선형,
 *       최악(종류 극소·중복 과다)에도 패스당 O(n²)·이웃 상수(≤4)에 개선 멈추면 조기 종료. n≤80 라 저비용.
 *
 * floor: 남길 최소 인접 동일 쌍 수(기본 0). 사천성은 "빈 칸으로만 통과"하므로 빈틈 없이 가득 찬 판에서
 *   인접 동일 쌍을 0 으로 만들면 첫 수(0꺾임 인접 매칭)가 사라져 시작 즉시 교착이 된다. 그런 판은 floor=1 로
 *   호출해 "연결 가능한 인접 동일 쌍 한 개"를 남기면 hasMove 가 보장된다(인접 쌍은 항상 연결 가능).
 */
export function reduceAdjacency<T extends { matchKey: string }>(
  cells: Point[],
  assign: T[],
  rnd: () => number,
  floor = 0
): T[] {
  const n = cells.length;
  const a = assign.slice();
  if (n < 3) return a; // 0/1/2 칸은 스왑으로 인접을 줄일 여지가 없다
  const posIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) posIndex.set(cells[i].r + "," + cells[i].c, i);
  // 각 셀의 상하좌우 이웃 셀 인덱스(같은 cells 집합 내부에 실제로 존재하는 것만)
  const nbrs: number[][] = cells.map((p) => {
    const out: number[] = [];
    for (const [dr, dc] of ORTHO) {
      const j = posIndex.get(p.r + dr + "," + (p.c + dc));
      if (j !== undefined) out.push(j);
    }
    return out;
  });
  const incident = (i: number): number => {
    let cnt = 0;
    for (const j of nbrs[i]) if (a[i].matchKey === a[j].matchKey) cnt++;
    return cnt;
  };
  // i·j 두 셀에 걸린 변들의 동일 쌍 수(i-j 변은 한 번만 셈). 스왑은 이 국소량만 바꾼다.
  const around = (i: number, j: number): number => {
    let cnt = 0;
    for (const k of nbrs[i]) if (a[i].matchKey === a[k].matchKey) cnt++;
    for (const k of nbrs[j]) {
      if (k === i) continue; // i-j 변 중복 방지
      if (a[j].matchKey === a[k].matchKey) cnt++;
    }
    return cnt;
  };
  // 현재 인접 동일 쌍 총수(변 하나 = 쌍 하나). 각 변이 i·j 양쪽에서 세어지므로 /2.
  let total = 0;
  for (let i = 0; i < n; i++) total += incident(i);
  total = total / 2;
  const order = seededShuffle([...Array(n).keys()], rnd);
  // 각 충돌 셀마다 "가장 많이 줄이는" 스왑을 적용하는 패스를, 개선이 멈출 때까지 반복(상한 n).
  // 단, 총수가 floor 밑으로 내려가는 스왑은 채택하지 않아(첫 수 보장) floor 개 인접 쌍은 남긴다.
  for (let pass = 0; pass < n && total > floor; pass++) {
    let improved = false;
    for (const i of order) {
      if (total <= floor) break;
      if (incident(i) === 0) continue; // 인접 동일이 없는 셀은 건드릴 필요 없음
      let bestJ = -1;
      let bestDelta = 0;
      for (const j of order) {
        if (j === i || a[i].matchKey === a[j].matchKey) continue; // 동일 카드 교환은 무의미
        const before = around(i, j);
        [a[i], a[j]] = [a[j], a[i]];
        const delta = around(i, j) - before;
        [a[i], a[j]] = [a[j], a[i]]; // 판정용 롤백
        if (delta < bestDelta && total + delta >= floor) {
          bestDelta = delta;
          bestJ = j;
        }
      }
      if (bestJ >= 0) {
        [a[i], a[bestJ]] = [a[bestJ], a[i]];
        total += bestDelta;
        improved = true;
      }
    }
    if (!improved) break;
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
// F-05: 난이도별 카드 종류 수 차등 — cardKinds 는 각 난이도 보드의 최대 쌍 수와 같아
// (아래 참고) 판당 카드가 사실상 전부 유니크 쌍이 되며, 난이도 차이는 종류 중복 빈도가 아니라
// 보드 크기(칸 수·기억해야 할 짝 수)로 갈린다. reserveRows 는 UP 모드 앞으로 상승할 줄 수(= "남은 줄").
export interface Difficulty {
  key: DifficultyKey;
  label: string;
  rows: number;
  cols: number;
  cardKinds: number; // 카드 종류 수 상한 (풀 크기로 자동 캡)
  reserveRows: number; // UP 모드 예비(상승) 줄 수 = 남은 줄 (easy6/normal8/hard10)
}

// cardKinds 는 각 난이도 보드의 최대 쌍 수(rows*cols/2)에 맞춰 상향 — 카드 풀이 1,300장+로
// 충분해 종류 수 상한이 곧 병목이 아니므로, 판당 카드가 사실상 전부 유니크 쌍이 되게 한다
// (풀 부족 시에는 kindCount = Math.min(cardKinds, usable.length) 로 자동 캡됨).
export const DIFFICULTIES: Difficulty[] = [
  { key: "easy", label: "쉬움 (6×4)", rows: 4, cols: 6, cardKinds: 12, reserveRows: 6 },
  { key: "normal", label: "보통 (8×6)", rows: 6, cols: 8, cardKinds: 24, reserveRows: 8 },
  { key: "hard", label: "어려움 (10×8)", rows: 8, cols: 10, cardKinds: 40, reserveRows: 10 },
];

// UP 모드: 시작 시 하단에 미리 깔아두는 줄 수 (rows 보다 작게 캡). 나머지 상단은 빈 상태로 시작.
export const UP_INITIAL_ROWS = 3;
// UP 모드: 가로 폭 강제(난이도 무관) — 넓은 보드로 교착 상승 체감 (레퍼런스 반영, 6→10).
export const UP_BOARD_COLS = 10;
// 승리 모드: 삽입할 "승" 합성 카드 쌍 수. 모든 "승" 타일은 matchKey 가 같아 어느 둘이든
// 이어지면 즉시 종료되므로, 시작 시 서로 붙지 않게 배치하기 쉽도록 항상 1쌍(2장)만 넣는다.
export function victoryPairsFor(_diff: Difficulty): number {
  return 1;
}

export function resolveDifficulty(d: DifficultyKey | Difficulty): Difficulty {
  if (typeof d !== "string") return d;
  const found = DIFFICULTIES.find((x) => x.key === d);
  if (!found) throw new Error("알 수 없는 난이도: " + d);
  return found;
}

// ── 마스크 (비사각형 맵 모양, PRD §6) ────────────────────────
// 매 라운드 다양한 형태의 맵. true = 타일이 놓이는 유효 칸.
// 실루엣 종류(pikachu/charizard/crystal/star/skull/apple/fish)는 손으로 그린 비트맵(SILHOUETTES)을
// 각 맵 크기에 맞춰 샘플링한 테마 전용 마스크(shared/mapThemes.ts 로만 지정) — 시드 랜덤 선택 풀(MASK_KINDS)에는
// 넣지 않는다(기존 5종 랜덤 분포·테스트 유지, 테마 미지정 보드는 이전과 동일하게 동작).
export type MaskKind =
  | "rect"
  | "diamond"
  | "donut"
  | "cross"
  | "corners"
  | "pikachu"
  | "charizard"
  | "crystal"
  | "star"
  | "skull"
  | "apple"
  | "fish";
export const MASK_KINDS: MaskKind[] = ["rect", "diamond", "donut", "cross", "corners"];

// 손으로 그린 실루엣 비트맵('#'=타일, 그 외=빈칸). 각 테마 맵의 실제 보드 크기(초급 4×6·고급 8×10)에
// 정확히 맞춰 작성했다. 요청 크기가 다르면 sampleSilhouette 가 최근접(nearest-neighbor)으로 정합.
// 모든 실루엣은 유효 칸 수를 짝수로 그렸고(makeMask 짝수 보정으로 한 번 더 방어), 흩어진 칸도 빈 칸을
// 통한 경로 연결이 가능하도록 충분히 덩어리진 형태로 유지한다.
const SILHOUETTES: Partial<Record<MaskKind, string[]>> = {
  // 피카츄(상하이/8×10): 뾰족한 양 귀 + 둥근 몸통
  pikachu: [
    ".#......#.",
    ".##....##.",
    ".###..###.",
    "..######..",
    ".########.",
    ".########.",
    "..######..",
    "...####...",
  ],
  // 리자몽(승리/8×10): 위로 솟는 불꽃 + 양 날개 힌트 + 넓은 몸통
  charizard: [
    "....##....",
    "...####...",
    "#..####..#",
    "##.####.##",
    "##########",
    ".########.",
    "..######..",
    "...####...",
  ],
  // 뮤츠(일반/8×10): 사이킥 크리스탈(다이아몬드)
  crystal: [
    "....##....",
    "...####...",
    "..######..",
    ".########.",
    ".########.",
    "..######..",
    "...####...",
    "....##....",
  ],
  // 루피(승리/8×10): 오각 별
  star: [
    "....##....",
    "....##....",
    ".########.",
    "..######..",
    "..######..",
    ".##....##.",
    ".#......#.",
    "..........",
  ],
  // 해적깃발(일반/4×6): 해골 — 눈 구멍 두 개 + 턱뼈
  skull: [".####.", "#.##.#", "######", ".#..#."],
  // 악마의 열매(일반/4×6): 둥근 과실
  apple: [".####.", "######", "######", ".####."],
  // 나미(상하이/4×6): 물고기 — 둥근 몸통 + 오른쪽 꼬리 지느러미
  fish: [".####.", "####.#", "####.#", ".####."],
};

// 실루엣 비트맵을 요청 (rows×cols) 로 최근접 샘플링. 설계 크기와 같으면 1:1(항등).
function sampleSilhouette(pattern: string[], rows: number, cols: number): boolean[][] {
  const P = pattern.length;
  const Q = Math.max(...pattern.map((s) => s.length));
  const m = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
  for (let r = 0; r < rows; r++) {
    const pr = P === rows ? r : Math.min(P - 1, Math.floor((r * P) / rows));
    const line = pattern[pr] ?? "";
    for (let c = 0; c < cols; c++) {
      const pc = Q === cols ? c : Math.min(Q - 1, Math.floor((c * Q) / cols));
      m[r][c] = line[pc] === "#";
    }
  }
  return m;
}

/** rows×cols 마스크 생성. 유효 칸 수가 항상 짝수가 되도록 보정한다. */
export function makeMask(kind: MaskKind, rows: number, cols: number): boolean[][] {
  const sil = SILHOUETTES[kind];
  const m = sil
    ? sampleSilhouette(sil, rows, cols)
    : Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
  if (!sil) {
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
  // 인접 동일 완화(reduceAdjacency) 사용 여부. 기본 on. false 로 끄면 순수 셔플 배치(완화 전 baseline)를
  // 그대로 쓴다 — 주로 퍼즈/테스트에서 완화 전·후 인접 쌍 수를 비교하기 위한 훅.
  adjacencyReduction?: boolean;
  // 퍼즈/테스트 계측 훅(선택). 넘기면 생성 과정에서 시도·폴백·재셔플 횟수를 채워준다(프로덕션 미사용).
  stats?: GenerateStats;
}

// 생성 계측(테스트 전용): attempts=성공까지 시도 수, floorSafe=인접 쌍 1개 남긴 배치(floor=1)를 쓴
// 시도 수(가득 찬 판에서 정상 동작), reshuffled=reshuffleWith 호출 수.
export interface GenerateStats {
  attempts: number;
  floorSafe: number;
  reshuffled: number;
}

/**
 * 시드 기반 보드 생성. 같은 (pool, difficulty, seed, opts) → 항상 같은 보드.
 * - 마스크: opts.mask 강제 또는 시드 랜덤 (UP 모드는 줄 상승 로직 단순화를 위해 rect 강제 — 가정)
 * - 상하이: 2층 보드. 층별로 짝수 장, 층 내에서만 짝 성립(층별 페어 생성 — 단순화 가정)
 * - 승리: 합성 "승" 카드(matchKey "__victory__")를 난이도별 victoryPairs 쌍만큼 중앙 근처에 배치
 * - UP: 초기엔 하단 UP_INITIAL_ROWS 줄만 배치, reserveRows 만큼 상승 예비 줄 덱 생성 (줄 안에서 짝 성립)
 */
export function generateBoard(
  pool: GameCard[],
  difficulty: DifficultyKey | Difficulty,
  seed: number,
  opts: GenerateOpts = {}
): Board {
  const baseDiff = resolveDifficulty(difficulty);
  const mapMode: MapMode = opts.mapMode ?? "normal";
  // UP 모드는 가로 폭 10 강제 (rows·reserveRows 는 난이도 유지). 마스크·배치 전에 확정해야 함.
  const diff: Difficulty = mapMode === "up" ? { ...baseDiff, cols: UP_BOARD_COLS } : baseDiff;
  const rnd = mulberry32(seed >>> 0);
  const usable = pool.filter((c) => c.imageUrl);
  if (usable.length === 0) throw new Error("카드 풀이 비어 있습니다");

  // UP 은 항상 rect 강제(테마 마스크가 지정돼도 무시) — 넓은 직사각 보드로 교착 상승 체감 유지
  const maskKind: MaskKind =
    mapMode === "up" ? "rect" : (opts.mask ?? MASK_KINDS[Math.floor(rnd() * MASK_KINDS.length)]);
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

  // 승리 모드: 합성 "승" 카드(고유 matchKey)를 난이도별 쌍 수만큼 중앙 근처에 배치
  const vCard = mapMode === "victory" ? victoryCard() : null;
  const victoryPairs = vCard ? victoryPairsFor(diff) : 0;

  // 상하이: 층 간 짝 맞추기 금지 단순화 — 층별로 서로소 종류 집합 사용
  const kindsByLayer: GameCard[][] = [kinds];
  if (layerCells.length === 2) {
    const total = layerCells[0].length + layerCells[1].length;
    const n1 = Math.max(1, Math.min(kindCount - 1, Math.round((kindCount * layerCells[1].length) / total)));
    kindsByLayer[0] = kinds.slice(0, kindCount - n1);
    kindsByLayer[1] = kinds.slice(kindCount - n1);
    // 방어: usable 카드가 1종뿐이면 한쪽 층이 빈 배열이 돼 뒤의 layerKinds[p % 0]=undefined 크래시.
    // 층이 비면 전체 종류로 폴백(서로소 보장은 포기하되 안전 배치). 통상 kindCount≥2 라 no-op.
    if (kindsByLayer[0].length === 0) kindsByLayer[0] = kinds;
    if (kindsByLayer[1].length === 0) kindsByLayer[1] = kinds;
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
  if (vCard) idxOf(vCard); // 승리 합성 카드도 cards[]에 1회 등록

  // 인접 동일 완화 on/off (기본 on). 완화는 배치 셔플 뒤 마지막 단계라, 끄면 완화 전 baseline 배치를 그대로 쓴다.
  const reduce = opts.adjacencyReduction !== false;
  const stats = opts.stats; // 테스트 계측 훅(선택)

  // UP 모드: 초기엔 하단 일부 줄만 배치 + 앞으로 상승할 예비 줄 덱 (별도 경로)
  if (mapMode === "up") {
    return generateUpBoard(diff, seed, maskKind, mask, kinds, cardsList, idxOf, rnd, reduce, stats);
  }

  // 배치 시도: 시작부터 최소 한 수 보장 (실패 시 재셔플 → 재시도, 모두 시드 rnd 기반).
  // 각 시도는 층별로 baseline(순수 셔플) 과 arranged(reduceAdjacency 로 인접 동일 완화) 두 배치를 준비하고,
  // 완화 배치를 우선 채택하되 hasMove 게이트를 통과할 때만 확정한다. 완화가 solvable 을 깨는 드문 경우엔
  // baseline 으로 폴백해 데드락 안전성(불변식 2)을 기존 로직과 동일하게 보장한다. "승" 타일은 완화 대상 제외.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (stats) stats.attempts = attempt + 1;
    // 승리 모드: 매 시도마다 "승" 셀을 내부·분산으로 다시 고른다(시작 시 짝이 붙어
    // 즉시 종료되던 문제 방지 — 연결 가능한 배치는 아래 게이트에서 걸러 다음 시도로 넘긴다).
    const victoryCells =
      vCard && victoryPairs > 0
        ? pickVictoryCells(layerCells[0], Math.min(victoryPairs * 2, layerCells[0].length), rnd)
        : [];
    const victorySet = new Set(victoryCells.map((p) => `${p.r},${p.c}`));

    // 층별 배치 계획: "승" 셀을 뺀 이동 가능 셀 + 채울 페어 덱(baseline 셔플)과 완화 배치(arranged).
    const plans = layerCells.map((cells, layer) => {
      const layerKinds = kindsByLayer[layer];
      const movableCells =
        layer === 0 && victoryCells.length > 0
          ? cells.filter((cell) => !victorySet.has(`${cell.r},${cell.c}`))
          : cells;
      const pairs = movableCells.length / 2;
      const deck: GameCard[] = [];
      for (let p = 0; p < pairs; p++) {
        const card = layerKinds[p % layerKinds.length];
        deck.push(card, card);
      }
      const baseline = seededShuffle(deck, rnd);
      // 같은 층 이동 가능 셀 안에서만 결정적 스왑(층 간 이동·"승" 이동 없음, 멀티셋 보존).
      const arranged = reduce ? reduceAdjacency(movableCells, baseline, rnd) : baseline;
      return { layer, movableCells, baseline, arranged };
    });

    // 층별 배치(assign)로 타일을 만든다. "승" 셀은 항상 고정 배치(layer 0).
    const buildBoard = (assignByLayer: GameCard[][]): Board => {
      const tiles: Tile[] = [];
      let tileId = 0;
      for (const plan of plans) {
        if (plan.layer === 0 && vCard && victoryCells.length > 0) {
          for (const cell of victoryCells) {
            tiles.push({
              tileId: tileId++,
              cardIdx: idxOf(vCard),
              cardId: vCard.cardId,
              matchKey: vCard.matchKey,
              r: cell.r,
              c: cell.c,
              layer: 0,
              removed: false,
              victory: true,
              card: vCard,
            });
          }
        }
        const assign = assignByLayer[plan.layer];
        plan.movableCells.forEach((cell, i) => {
          const card = assign[i];
          tiles.push({
            tileId: tileId++,
            cardIdx: idxOf(card),
            cardId: card.cardId,
            matchKey: card.matchKey,
            r: cell.r,
            c: cell.c,
            layer: plan.layer,
            removed: false,
            card,
          });
        });
      }
      return {
        rows: diff.rows,
        cols: diff.cols,
        mapMode,
        difficulty: diff.key,
        seed,
        maskKind,
        mask,
        tiles,
        cards: cardsList,
        reserve: [],
        nextTileId: tileId,
      };
    };

    const arrangedAll = plans.map((p) => p.arranged);
    // 가득 찬(빈틈 없는) 판을 인접 동일 0 으로 만들면 첫 수가 사라진다 → hasMove 실패 시 최상단 층에 인접 쌍
    // 한 개를 남긴 완화 배치(floor=1)로 대체한다. 인접 쌍은 항상 연결 가능하고, 최상단 층(상하이 위층·그 외
    // layer0)은 늘 free 라 그 쌍이 곧 첫 수가 된다 → 이 배치는 solvable 이 보장된다.
    const topLayer = plans.length - 1;
    const safeAll = (): GameCard[][] => {
      const safe = arrangedAll.slice();
      safe[topLayer] = reduce
        ? reduceAdjacency(plans[topLayer].movableCells, plans[topLayer].baseline, rnd, 1)
        : plans[topLayer].baseline;
      return safe;
    };

    const arranged = buildBoard(arrangedAll);
    if (vCard && victoryCells.length > 0) {
      // "승" 짝 연결 여부는 셀 기하만으로 정해져 배치와 무관 → arranged 로 판정.
      // 시작 시 "승" 짝이 이어지면(=즉시 종료 위험) 이번 배치를 버리고 다음 시도에서 셀을 다시 고른다.
      if (victoryPairConnectable(arranged)) continue;
      if (hasMove(arranged)) return arranged;
      if (stats) stats.floorSafe++;
      // "승" 셀 위치는 배치와 무관하게 동일 → 위에서 victoryPairConnectable=false 가 그대로 성립(재검사 불필요).
      const safe = buildBoard(safeAll()); // 인접 쌍 1개 남긴 배치로 (일반 카드) 첫 수 확보
      if (hasMove(safe)) return safe;
      const baseline = buildBoard(plans.map((p) => p.baseline));
      if (hasMove(baseline)) return baseline;
      continue; // reshuffleWith 는 "승" 위치를 흩뜨리므로 쓰지 않고 다음 시도로
    }
    if (hasMove(arranged)) return arranged;
    if (stats) stats.floorSafe++;
    // 완화가 판을 첫 수 없는 상태로 만든 경우: 최상단(항상 free) 층에 인접 쌍 1개를 남긴 배치(항상 solvable)로 확보.
    const safe = buildBoard(safeAll());
    if (hasMove(safe)) return safe;
    // 그래도 실패하는 극단(baseline 자체가 첫 수 없음): 기존과 동일하게 baseline → reshuffle 로 데드락 방지.
    const baseline = buildBoard(plans.map((p) => p.baseline));
    if (hasMove(baseline)) return baseline;
    if (stats) stats.reshuffled++;
    reshuffleWith(baseline, rnd);
    if (hasMove(baseline)) return baseline;
  }
  throw new Error("보드 생성 실패");
}

/**
 * 승리 "승" 카드를 놓을 셀 선택 — 시작하자마자 짝이 붙어 즉시 종료되는 것을 막기 위해:
 *  1) 내부(4방향 이웃이 모두 채워지는) 셀만 후보로 삼아 꽉 찬 보드에서 서로 이어지지 않게 하고,
 *  2) 서로 최대한 멀리(체비쇼프 거리 최대) 퍼뜨려 인접을 피한다.
 * 내부 셀이 부족하면 전체 셀에서 퍼뜨린다(연결 여부는 호출측 victoryPairConnectable 로 최종 검증).
 */
function pickVictoryCells(cells: Point[], count: number, rnd: () => number): Point[] {
  const key = (r: number, c: number) => `${r},${c}`;
  const present = new Set(cells.map((p) => key(p.r, p.c)));
  const interior = cells.filter(
    (p) =>
      present.has(key(p.r - 1, p.c)) &&
      present.has(key(p.r + 1, p.c)) &&
      present.has(key(p.r, p.c - 1)) &&
      present.has(key(p.r, p.c + 1))
  );
  const pool = seededShuffle(interior.length >= count ? interior : cells, rnd);
  if (pool.length <= count) return pool.slice(0, count);
  const cheb = (a: Point, b: Point) => Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
  const picked: Point[] = [pool[0]];
  while (picked.length < count) {
    let best: Point | null = null;
    let bestD = -1;
    for (const p of pool) {
      if (picked.some((q) => q.r === p.r && q.c === p.c)) continue;
      const d = Math.min(...picked.map((q) => cheb(q, p)));
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked;
}

/** 시작(꽉 찬 보드)에서 "승" 타일끼리 이어지는 짝이 하나라도 있으면 true (즉시 종료 위험). */
function victoryPairConnectable(board: Board): boolean {
  const vt = board.tiles.filter((t) => !t.removed && t.victory && t.layer === 0);
  if (vt.length < 2) return false;
  const grid = occupiedGrid(board, 0);
  for (let i = 0; i < vt.length; i++)
    for (let j = i + 1; j < vt.length; j++)
      if (findPath(grid, pt(vt[i]), pt(vt[j]))) return true;
  return false;
}

// UP 모드 전용 생성: 하단 UP_INITIAL_ROWS 줄만 채우고 상단은 빈 상태로 시작.
// reserve = 앞으로 상승할 줄 덱(난이도별 reserveRows개, 각 줄 안에서 짝 성립).
function generateUpBoard(
  diff: Difficulty,
  seed: number,
  maskKind: MaskKind,
  mask: boolean[][],
  kinds: GameCard[],
  cardsList: GameCard[],
  idxOf: (card: GameCard) => number,
  rnd: () => number,
  reduce: boolean,
  stats?: GenerateStats
): Board {
  // 한 줄 덱: cols/2 페어 → 줄 안에서 셔플(줄 내부 짝 성립 → 전체 짝수 유지) → 가로 인접 동일 완화.
  // kinds 인덱스를 줄마다 랜덤 회전(offset)해 모듈로로 고르므로, kinds.length(cardKinds 상향분)가
  // 줄당 페어 수(cols/2)보다 크기만 하면 한 줄 안에서는 카드 종류가 항상 겹치지 않는다
  // (기존의 rnd()*kinds.length 완전 랜덤 추출은 종류 수를 늘려도 한 줄 내 중복이 흔했음).
  // UP 은 줄 상승 게임이라 가로(같은 줄) 인접 동일이 특히 도드라져, 줄 안에서 상하좌우 완화를 적용한다.
  // 완화는 줄 내부에서만 자리를 바꿔 줄별 멀티셋(짝수)을 그대로 보존한다(층·줄 간 이동 없음).
  const makeRowDeck = (): GameCard[] => {
    const pairs = diff.cols / 2;
    const offset = Math.floor(rnd() * kinds.length);
    const rowDeck: GameCard[] = [];
    for (let p = 0; p < pairs; p++) {
      const card = kinds[(offset + p) % kinds.length];
      rowDeck.push(card, card);
    }
    const shuffled = seededShuffle(rowDeck, rnd);
    if (!reduce) return shuffled;
    // 한 줄만 넘기면 이웃이 좌우(가로)로만 잡혀 세로 인접은 대상에서 제외된다(요구: 최소 가로 인접 제거).
    const rowCells: Point[] = shuffled.map((_, i) => ({ r: 1, c: i + 1 }));
    return reduceAdjacency(rowCells, shuffled, rnd);
  };

  // 예비(상승) 줄 덱 — 배치보다 먼저 생성해 시드 소비 순서를 고정(재현성)
  const reserve: GameCard[][] = [];
  for (let rrow = 0; rrow < diff.reserveRows; rrow++) reserve.push(makeRowDeck());

  const initialRows = Math.min(UP_INITIAL_ROWS, diff.rows);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (stats) stats.attempts = attempt + 1;
    const tiles: Tile[] = [];
    let tileId = 0;
    // 하단 initialRows 줄만 배치 (r = rows-initialRows+1 .. rows)
    for (let r = diff.rows - initialRows + 1; r <= diff.rows; r++) {
      const row = makeRowDeck();
      for (let c = 1; c <= diff.cols; c++) {
        const card = row[c - 1];
        tiles.push({
          tileId: tileId++,
          cardIdx: idxOf(card),
          cardId: card.cardId,
          matchKey: card.matchKey,
          r,
          c,
          layer: 0,
          removed: false,
          card,
        });
      }
    }
    const board: Board = {
      rows: diff.rows,
      cols: diff.cols,
      mapMode: "up",
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
    if (stats) stats.reshuffled++;
    reshuffleWith(board, rnd);
    if (hasMove(board)) return board;
  }
  throw new Error("UP 보드 생성 실패");
}

// ── 점유 격자 / 선택 가능 판정 ───────────────────────────────
/**
 * 해당 layer 의 점유 격자(패딩 포함). true = 미제거 타일 존재(통과 불가).
 * 패딩 링(0, rows+1 / 0, cols+1)은 1-based 좌표 정렬용으로만 남겨둔다 — findPath 가 탐색을
 * 내부(1..rows, 1..cols)로 제한하므로 테두리 밖 우회 경로는 생기지 않는다(팀 결정 규칙).
 */
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
 * UP 모드 타이머 상승. 타이머(server tickUp)가 주기적으로 호출한다.
 * - mapMode 가 up 이 아니거나 reserve 소진 → "empty" (더 이상 상승 없음).
 * - 최상단 행(r===1)에 미제거 타일이 있으면 상승 시 화면 밖으로 나가므로 이번 틱은 보류 → "blocked"
 *   (관대한 처리 — 즉사 없음, 시프트/주입 안 함).
 * - 그 외: 모든 미제거 타일을 한 줄 위로(r-=1) 올리고, reserve 에서 한 줄 꺼내 최하단(r=rows)에 주입 → "ok".
 */
export function upRise(board: Board): "ok" | "blocked" | "empty" {
  if (board.mapMode !== "up" || board.reserve.length === 0) return "empty";
  const live = board.tiles.filter((t) => !t.removed);
  if (live.length === 0) return "empty"; // 이미 전부 제거(클리어) — 부활 주입 방지
  // 최상단 점유 시 이번 틱 상승 보류
  if (live.some((t) => t.r === 1)) return "blocked";
  // 모든 미제거 타일 한 줄 위로
  for (const t of live) t.r -= 1;
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
  return "ok";
}

// ── 롤링 모드 ────────────────────────────────────────────────
/**
 * layer 0 마스크 활성 영역의 바운딩 박스 테두리 한 겹을 시계방향 순서로 반환.
 * 순서: 좌상단 → top행 우로 → 우측열 아래로 → bottom행 좌로 → 좌측열 위로.
 * 바운딩 박스 경계 위이면서 실제 유효(마스크 true) 칸만 포함한다(마름모 등 비사각형 방어).
 * 링 크기 1(단일 행/열)도 안전하게 처리.
 */
export function borderRingCells(board: Board): Point[] {
  let minR = Infinity,
    maxR = -Infinity,
    minC = Infinity,
    maxC = -Infinity;
  for (let r = 0; r < board.mask.length; r++)
    for (let c = 0; c < board.mask[r].length; c++)
      if (board.mask[r][c]) {
        const rr = r + 1,
          cc = c + 1;
        if (rr < minR) minR = rr;
        if (rr > maxR) maxR = rr;
        if (cc < minC) minC = cc;
        if (cc > maxC) maxC = cc;
      }
  if (!isFinite(minR)) return [];
  const valid = (r: number, c: number) =>
    r >= 1 && r <= board.rows && c >= 1 && c <= board.cols && board.mask[r - 1][c - 1];
  const ring: Point[] = [];
  const seen = new Set<string>();
  const push = (r: number, c: number) => {
    if (!valid(r, c)) return;
    const k = r + "," + c;
    if (seen.has(k)) return;
    seen.add(k);
    ring.push({ r, c });
  };
  if (minR === maxR) {
    for (let c = minC; c <= maxC; c++) push(minR, c); // 단일 행: 좌→우
    return ring;
  }
  if (minC === maxC) {
    for (let r = minR; r <= maxR; r++) push(r, minC); // 단일 열: 상→하
    return ring;
  }
  for (let c = minC; c <= maxC; c++) push(minR, c); // top: 좌→우
  for (let r = minR + 1; r <= maxR; r++) push(r, maxC); // right: 상→하
  for (let c = maxC - 1; c >= minC; c--) push(maxR, c); // bottom: 우→좌
  for (let r = maxR - 1; r >= minR + 1; r--) push(r, minC); // left: 하→상
  return ring;
}

/**
 * 롤링: 바깥 테두리 한 겹(경계 링)만 시계방향으로 1칸 회전. 내부 셀은 고정.
 * 각 링 셀의 layer0 타일을 다음 링 셀로 옮긴다(제거된 타일·빈 슬롯도 사이클에 포함).
 * ring[i] → ring[i+1] 은 셀 단위 전단사라 좌표 충돌이 없다. 넷마블 '롤링4각'과 동일 체감.
 */
export function rollRight(board: Board): void {
  const ring = borderRingCells(board);
  if (ring.length < 2) return; // 극단(1×1·단일 셀) 방어
  const tileAt = new Map<string, Tile>();
  for (const t of board.tiles) {
    if (t.layer !== 0) continue;
    tileAt.set(t.r + "," + t.c, t);
  }
  const ringTiles = ring.map((cell) => tileAt.get(cell.r + "," + cell.c));
  for (let i = 0; i < ring.length; i++) {
    const t = ringTiles[i];
    if (!t) continue; // 빈 슬롯 — 홀은 함께 시계방향으로 밀린다
    const dest = ring[(i + 1) % ring.length];
    t.r = dest.r;
    t.c = dest.c;
  }
}

export { findPath, canConnect } from "./shisen.ts";
export type { Point } from "./shisen.ts";
