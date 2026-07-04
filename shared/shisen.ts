// 사천성(Shisen-Sho) 연결 판정. 꺾임 ≤ 2회(직선 3구간) 안에 빈 칸으로 두 타일을 잇는 경로 탐색.
// grid: 패딩 포함 점유 격자. true = 타일 있음(통과 불가), false = 빈 칸(통과 가능). 테두리는 모두 false.
// 좌표는 패딩 격자 기준(0..R-1, 0..C-1). 내부 타일은 1..rows, 1..cols.

export interface Point {
  r: number;
  c: number;
}

const DIRS: Point[] = [
  { r: -1, c: 0 }, // 0 up
  { r: 1, c: 0 }, // 1 down
  { r: 0, c: -1 }, // 2 left
  { r: 0, c: 1 }, // 3 right
];
const opposite = (a: number, b: number) =>
  (a === 0 && b === 1) || (a === 1 && b === 0) || (a === 2 && b === 3) || (a === 3 && b === 2);

interface Node {
  r: number;
  c: number;
  di: number;
  turns: number;
  prev: Node | null;
}

/** A→B 경로(셀 목록, 양 끝 포함)를 반환. 없으면 null. 두 끝점은 타일 위치(점유)여도 무방. */
export function findPath(grid: boolean[][], a: Point, b: Point): Point[] | null {
  const R = grid.length;
  const C = grid[0].length;
  const inBounds = (r: number, c: number) => r >= 0 && r < R && c >= 0 && c < C;
  const isB = (r: number, c: number) => r === b.r && c === b.c;
  // 진입 가능: 목적지 B이거나, 격자 안 빈 칸
  const canEnter = (r: number, c: number) => isB(r, c) || (inBounds(r, c) && !grid[r][c]);

  const visited = new Set<string>();
  const queue: Node[] = [];
  for (let di = 0; di < 4; di++) {
    const nr = a.r + DIRS[di].r;
    const nc = a.c + DIRS[di].c;
    if (!canEnter(nr, nc)) continue;
    const key = nr + "," + nc + "," + di + ",0";
    if (visited.has(key)) continue;
    visited.add(key);
    queue.push({ r: nr, c: nc, di, turns: 0, prev: null });
  }

  while (queue.length) {
    const n = queue.shift()!;
    if (isB(n.r, n.c)) {
      const path: Point[] = [];
      let cur: Node | null = n;
      while (cur) {
        path.push({ r: cur.r, c: cur.c });
        cur = cur.prev;
      }
      path.reverse();
      path.unshift({ r: a.r, c: a.c });
      return path;
    }
    for (let ndi = 0; ndi < 4; ndi++) {
      if (opposite(ndi, n.di)) continue; // U턴 금지
      const nturns = ndi === n.di ? n.turns : n.turns + 1;
      if (nturns > 2) continue;
      const nr = n.r + DIRS[ndi].r;
      const nc = n.c + DIRS[ndi].c;
      if (!canEnter(nr, nc)) continue;
      const key = nr + "," + nc + "," + ndi + "," + nturns;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ r: nr, c: nc, di: ndi, turns: nturns, prev: n });
    }
  }
  return null;
}

export const canConnect = (grid: boolean[][], a: Point, b: Point): boolean =>
  findPath(grid, a, b) !== null;
