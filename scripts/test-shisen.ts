import { canConnect, findPath, Point } from "../shared/shisen.ts";

// 패딩 격자 빌더: rows×cols 내부 + 테두리. occ=[[r,c],...] 점유 셀(내부 1..rows,1..cols)
function grid(rows: number, cols: number, occ: [number, number][]): boolean[][] {
  const R = rows + 2, C = cols + 2;
  const g = Array.from({ length: R }, () => Array<boolean>(C).fill(false));
  for (const [r, c] of occ) g[r][c] = true;
  return g;
}

let pass = 0, fail = 0;
function check(name: string, got: boolean, want: boolean) {
  if (got === want) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + " — got " + got + " want " + want); }
}

const P = (r: number, c: number): Point => ({ r, c });

// 1) 인접 두 타일 (0꺾임)
{
  const g = grid(3, 3, [[1, 1], [1, 2]]);
  check("인접 직선 연결", canConnect(g, P(1, 1), P(1, 2)), true);
}
// 2) 빈 보드 대각 (2꺾임 이내)
{
  const g = grid(3, 3, [[1, 1], [3, 3]]);
  check("빈 보드 대각 연결", canConnect(g, P(1, 1), P(3, 3)), true);
}
// 3) 내부 꽉 참 → 대각 코너는 3꺾임 필요 → 불가
{
  const occ: [number, number][] = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) occ.push([r, c]);
  const g = grid(3, 3, occ);
  check("내부 꽉참 대각 불가", canConnect(g, P(1, 1), P(3, 3)), false);
}
// 4) 내부 꽉 참이라도 테두리 1꺾임 우회로 인접변 연결 가능
{
  const occ: [number, number][] = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) occ.push([r, c]);
  const g = grid(3, 3, occ);
  check("테두리 우회 연결", canConnect(g, P(1, 1), P(2, 1)), true);
}
// 5) 경로 셀 목록 반환(양 끝 포함)
{
  const g = grid(3, 3, [[1, 1], [1, 3]]);
  const path = findPath(g, P(1, 1), P(1, 3));
  const ok = !!path && path[0].r === 1 && path[0].c === 1 && path[path.length - 1].c === 3;
  check("경로 반환 양끝 포함", ok, true);
}
// 6) 새 규칙(경로 보드 내부 제한): 1행 보드에서 막힌 직선은 우회로가 없어 연결 불가
{
  const g = grid(1, 5, [[1, 1], [1, 3], [1, 5]]); // (1,3) 장애물
  check("막힌 1행 직선은 보드 밖 우회 불가 → 연결 불가", canConnect(g, P(1, 1), P(1, 5)), false);
}
// 7) 회귀: visited 키에 turns 누락으로 정당한 2꺾임 매칭이 거부되던 버그.
//    3×3 보드, 1열이 전부 점유 — A(1,1)↔B(3,1) 은 내부 ㄷ자(우→하→좌) 2꺾임으로 연결돼야 한다.
//      r1: # . .   r2: # . .   r3: # . .
{
  const occ: [number, number][] = [[1, 1], [2, 1], [3, 1]];
  const g = grid(3, 3, occ);
  const path = findPath(g, P(1, 1), P(3, 1));
  check("내부 ㄷ자 2꺾임 경로 연결(visited turns 회귀)", !!path, true);
  check(
    "ㄷ자 경로가 전부 보드 내부(1..3)",
    !!path && path.every((p) => p.r >= 1 && p.r <= 3 && p.c >= 1 && p.c <= 3) &&
      path[0].r === 1 && path[0].c === 1 && path[path.length - 1].r === 3 && path[path.length - 1].c === 1,
    true
  );
}

console.log("\n결과: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
