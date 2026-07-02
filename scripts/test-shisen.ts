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
// 6) 한 칸 막힌 직선은 우회 필요(연결은 됨)
{
  const g = grid(1, 5, [[1, 1], [1, 3], [1, 5]]); // (1,3) 장애물
  check("막힌 직선 테두리 우회", canConnect(g, P(1, 1), P(1, 5)), true);
}

console.log("\n결과: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
