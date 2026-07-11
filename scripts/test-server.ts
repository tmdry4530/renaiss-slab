// 게임 서버 스모크 e2e 테스트 — createServer 를 임의 포트로 기동하고 socket.io-client 로 실플레이 검증
// 실행: npx tsx scripts/test-server.ts
import { io as connect } from "socket.io-client";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/index.ts";
import { findHint, type Board, type Tile } from "../shared/board.ts";
import type { GameCard } from "../shared/cards.ts";
import { DEX_REGISTER_COUNT, type Ack, type BoardInit, type BoardPatch, type RoomConfig } from "../shared/protocol.ts";

let pass = 0,
  fail = 0;
const check = (n: string, ok: boolean) =>
  ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 테스트 클라이언트: 수신 이벤트를 큐잉하고, 보드 미러를 도착 순서대로 동기 반영 ──
const EVENTS = [
  "room:update",
  "room:closed",
  "game:countdown",
  "board:init",
  "board:update",
  "tile:matched",
  "tile:rejected",
  "player:progress",
  "match:finishing",
  "match:ended",
] as const;

class TC {
  sock: ReturnType<typeof connect>;
  playerId = "";
  board: Board | null = null;
  private pending = new Map<string, unknown[]>();
  private waiters = new Map<string, ((v: unknown) => void)[]>();

  constructor(url: string) {
    this.sock = connect(url, { transports: ["websocket"], forceNew: true });
    for (const ev of EVENTS) this.sock.on(ev, (p: unknown) => this.onEvent(ev, p));
  }

  private onEvent(ev: string, p: unknown): void {
    // 보드 미러는 도착 즉시(순서대로) 반영해 서버 상태와 동기화
    if (ev === "board:init") this.board = buildBoard(p as BoardInit);
    else if (ev === "board:update" && this.board) this.applyPatch(p as BoardPatch);
    else if (ev === "tile:matched" && this.board) {
      const m = p as { tileA: number; tileB: number };
      for (const id of [m.tileA, m.tileB]) {
        const t = this.board.tiles.find((x) => x.tileId === id);
        if (t) t.removed = true;
      }
    }
    const ws = this.waiters.get(ev);
    if (ws && ws.length) {
      ws.shift()!(p);
      return;
    }
    const q = this.pending.get(ev) ?? [];
    q.push(p);
    this.pending.set(ev, q);
  }

  private applyPatch(p: BoardPatch): void {
    const b = this.board!;
    b.tiles = p.tiles.map((s) => {
      const card = b.cards[s.cardIdx];
      return {
        tileId: s.tileId,
        cardIdx: s.cardIdx,
        cardId: card.cardId,
        matchKey: card.matchKey,
        r: s.r,
        c: s.c,
        layer: s.layer,
        removed: s.removed,
        ...(s.victory ? { victory: true } : {}),
        card,
      };
    });
  }

  waitFor<T = any>(ev: string, timeoutMs = 8000): Promise<T> {
    const q = this.pending.get(ev);
    if (q && q.length) return Promise.resolve(q.shift() as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(ev + " 수신 시간 초과")), timeoutMs);
      const ws = this.waiters.get(ev) ?? [];
      ws.push((v) => {
        clearTimeout(timer);
        resolve(v as T);
      });
      this.waiters.set(ev, ws);
    });
  }

  /** GO(game:countdown{0}) 도착까지 대기 — 3→2→1 을 흘려보내고 0(GO) 에서 resolve.
   *  새 순서(board:init 먼저 → 3→2→1 → 0)에서 active=true 가 되는 GO 시점 이후에만 실플레이. */
  async waitForGo(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await this.waitFor<{ seconds: number }>("game:countdown", Math.max(1, deadline - Date.now()));
      if (p.seconds === 0) return;
    }
  }

  drain(ev: string): void {
    this.pending.delete(ev);
  }

  pendingCount(ev: string): number {
    return this.pending.get(ev)?.length ?? 0;
  }
}

/** BoardInit → shared 엔진용 로컬 보드 미러 (findHint 재사용을 위해 Tile 형태로 복원) */
function buildBoard(init: BoardInit): Board {
  const tiles: Tile[] = init.tiles.map((s) => {
    const card = init.cards[s.cardIdx];
    return {
      tileId: s.tileId,
      cardIdx: s.cardIdx,
      cardId: card.cardId,
      matchKey: card.matchKey,
      r: s.r,
      c: s.c,
      layer: s.layer,
      removed: s.removed,
      ...(s.victory ? { victory: true } : {}),
      card,
    };
  });
  return {
    rows: init.rows,
    cols: init.cols,
    mapMode: init.mapMode,
    difficulty: init.difficulty,
    seed: init.seed,
    maskKind: "rect", // findHint/occupiedGrid 는 mask 를 사용하지 않음 (더미)
    mask: [],
    tiles,
    cards: init.cards as GameCard[],
    reserve: [],
    nextTileId: tiles.length ? Math.max(...tiles.map((t) => t.tileId)) + 1 : 0,
  };
}

function emitAck<T>(sock: ReturnType<typeof connect>, event: string, ...args: unknown[]): Promise<Ack<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(event + " ack 시간 초과")), 8000);
    sock.emit(event, ...args, (r: Ack<T>) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

const baseCfg = (over: Partial<RoomConfig> = {}): RoomConfig => ({
  name: "테스트방",
  visibility: "public",
  maxPlayers: 2,
  game: "pokemon",
  mapMode: "normal",
  difficulty: "easy",
  ...over,
});

/** 살아있는 같은 카드 짝 하나 선택 (경로 무관 — 가위용) */
function pickPair(board: Board): [Tile, Tile] | null {
  const groups = new Map<string, Tile[]>();
  for (const t of board.tiles) {
    if (t.removed) continue;
    const arr = groups.get(t.matchKey) ?? [];
    arr.push(t);
    groups.set(t.matchKey, arr);
  }
  for (const g of groups.values()) if (g.length >= 2) return [g[0], g[1]];
  return null;
}

async function main(): Promise<void> {
  // 테스트용 짧은 유예(400ms) + 짧은 카운트다운 스텝(10ms, board:init 지연 최소화)
  // + 짧은 재접속 유예(500ms, 재접속 복구/만료 테스트용) + 도감 파일 격리
  const dexFile = fileURLToPath(new URL("../.data/dex-test.json", import.meta.url));
  const srv = await createServer(0, { finishGraceMs: 400, countdownStepMs: 10, disconnectGraceMs: 500, dexFile });
  const url = `http://127.0.0.1:${srv.port}`;
  console.log("서버 기동: " + url);

  // ── REST 스모크 ─────────────────────────────────────────────
  console.log("\n[REST]");
  const roomsRes = (await fetch(url + "/api/rooms").then((r) => r.json())) as any;
  check("GET /api/rooms 목록 형태", Array.isArray(roomsRes.rooms));
  const poolRes = (await fetch(url + "/api/cards/pool?game=pokemon").then((r) => r.json())) as any;
  check(
    "GET /api/cards/pool?game=pokemon 필터",
    Array.isArray(poolRes.cards) && poolRes.cards.length > 0 && poolRes.cards.every((c: any) => c.game === "pokemon")
  );
  const docent = (await fetch(
    url + `/api/cards/${encodeURIComponent(poolRes.cards[0].cardId)}/docent`
  ).then((r) => r.json())) as any;
  check("GET /api/cards/:cardId/docent", docent.card?.cardId === poolRes.cards[0].cardId && typeof docent.marketUrl === "string");
  const docent404 = await fetch(url + "/api/cards/no-such-card/docent");
  const docent404Body = (await docent404.json()) as any;
  check("docent 미존재 카드 404", docent404.status === 404 && docent404Body.error === "cardNotFound");
  const restRoom = (await fetch(url + "/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseCfg({ name: "REST방", maxPlayers: 4 }), nickname: "레스트" }),
  }).then((r) => r.json())) as any;
  check("POST /api/rooms 생성", typeof restRoom.room?.roomId === "string" && restRoom.room.roomId.length === 6);
  const restBad = await fetch(url + "/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseCfg(), maxPlayers: 9 }),
  });
  const restBadBody = (await restBad.json()) as any;
  check("POST /api/rooms 인원 초과 400", restBad.status === 400 && restBadBody.error === "badMaxPlayers");
  const restUp = await fetch(url + "/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseCfg({ mapMode: "up" }), nickname: "레스트" }),
  });
  const restUpBody = (await restUp.json()) as any;
  check("POST /api/rooms UP 모드 비활성화 거부", restUp.status === 400 && restUpBody.error === "modeDisabled");

  // ── 로비/방 ────────────────────────────────────────────────
  console.log("\n[로비·방]");
  const c1 = new TC(url);
  const c2 = new TC(url);
  const h1 = await emitAck<{ playerId: string }>(c1.sock, "lobby:hello", { nickname: "슬랩왕" });
  check("lobby:hello playerId 발급", h1.ok && !!h1.data?.playerId);
  c1.playerId = h1.data!.playerId;
  const hBad = await emitAck(c1.sock, "lobby:hello", { nickname: "" });
  check("빈 닉네임 거부", !hBad.ok && hBad.error === "badNickname");
  const hLong = await emitAck(c1.sock, "lobby:hello", { nickname: "열두자를넘는아주긴닉네임임" });
  check("13자 닉네임 거부", !hLong.ok && hLong.error === "badNickname");
  const h1b = await emitAck<{ playerId: string }>(c1.sock, "lobby:hello", {
    nickname: "슬랩왕",
    playerId: c1.playerId,
  });
  check("playerId 재사용(재접속)", h1b.ok && h1b.data?.playerId === c1.playerId);
  const h2 = await emitAck<{ playerId: string }>(c2.sock, "lobby:hello", { nickname: "도전자" });
  c2.playerId = h2.data!.playerId;

  const cr = await emitAck<{ room: any }>(c1.sock, "room:create", baseCfg({ name: "메인방" }));
  check(
    "room:create 성공 (생성자=방장)",
    cr.ok && cr.data!.room.players.length === 1 && cr.data!.room.players[0].isHost === true
  );
  const roomId: string = cr.data!.room.roomId;
  check("roomId 6자리 코드", roomId.length === 6);
  const crBad = await emitAck(c1.sock, "room:create", baseCfg({ maxPlayers: 9 }));
  check("잘못된 RoomConfig 거부(인원 9)", !crBad.ok && crBad.error === "badMaxPlayers");
  const crUp = await emitAck(c1.sock, "room:create", baseCfg({ mapMode: "up" }));
  check("room:create UP 모드 비활성화 거부", !crUp.ok && crUp.error === "modeDisabled");

  const lst = await emitAck<{ rooms: any[] }>(c2.sock, "room:list");
  const found = lst.data!.rooms.find((r) => r.roomId === roomId);
  check("room:list 노출 + state", !!found && found.state === "waiting" && found.hasPassword === false);

  const jnf = await emitAck(c2.sock, "room:join", { roomId: "XXXXXX" });
  check("room:join notFound", !jnf.ok && jnf.error === "notFound");
  const jn = await emitAck<{ room: any }>(c2.sock, "room:join", { roomId });
  check("room:join 성공 (2인)", jn.ok && jn.data!.room.players.length === 2);

  // ── 매치: 정상 플레이 → 클리어 → finishing → ended ─────────
  console.log("\n[매치 플레이]");
  const gsBad = await emitAck(c2.sock, "game:start");
  check("game:start notHost", !gsBad.ok && gsBad.error === "notHost");
  const gs = await emitAck(c1.sock, "game:start");
  check("game:start 성공(방장)", gs.ok);
  const b1 = await c1.waitFor<BoardInit>("board:init");
  const b2 = await c2.waitFor<BoardInit>("board:init");
  check(
    "동일 seed 동일 보드 (개인전)",
    b1.seed === b2.seed && b1.tiles.length === b2.tiles.length && b1.tiles.length > 0 && b1.tiles.length % 2 === 0
  );
  const gsDup = await emitAck(c1.sock, "game:start");
  check("진행 중 game:start 거부", !gsDup.ok && gsDup.error === "playing");

  // 입력 게이트: board:init 은 도착했지만 GO(카운트다운 0) 전에는 active=false → 조작 거부
  // (새 순서에서 보드가 오버레이 뒤에 미리 마운트돼도 GO 전 입력은 서버가 차단함을 검증)
  // 서로 다른 카드를 지정 → active=false 면 guard 로, 만에 하나 active=true 면 validateMatch 로 어차피 거부
  // → 타이밍과 무관하게 tile:rejected 가 보장돼 게이트만 검증한다.
  {
    const live = c1.board!.tiles.filter((t) => !t.removed);
    const a = live[0];
    const b = live.find((t) => t.matchKey !== a.matchKey)!;
    const gateMatch = await emitAck(c1.sock, "tile:match", { tileA: a.tileId, tileB: b.tileId });
    const gateRej = await c1.waitFor<{ reason: string }>("tile:rejected");
    check("카운트다운 중(GO 전) tile:match 거부", !gateMatch.ok && typeof gateRej.reason === "string");
    const gateItem = await emitAck(c1.sock, "item:use", { type: "search" });
    check("카운트다운 중(GO 전) item:use 거부", !gateItem.ok && gateItem.error === "itemUnavailable");
  }
  // GO(game:countdown 0) 대기 — 여기서부터 active=true (입력 허용)
  await c1.waitForGo();
  await c2.waitForGo();
  // 게이트 검증에서 리셋된 콤보 잔여 이벤트 정리 (이후 실플레이가 깨끗한 상태에서 시작)
  c1.drain("tile:rejected");
  c1.drain("player:progress");

  // 잘못된 매칭 → tile:rejected + 콤보 리셋
  {
    const live = c1.board!.tiles.filter((t) => !t.removed);
    const a = live[0];
    const b = live.find((t) => t.matchKey !== a.matchKey)!;
    const rej = await emitAck(c1.sock, "tile:match", { tileA: a.tileId, tileB: b.tileId });
    const rejEv = await c1.waitFor<{ reason: string }>("tile:rejected");
    check("잘못된 매칭 → tile:rejected", !rej.ok && typeof rejEv.reason === "string");
  }

  // c1 자동 플레이: shared findHint 로 짝 찾아 전부 제거 (도중 콤보 파워 1회 검증)
  let comboPowerTested = false;
  let comboSeen = 0;
  let progressSeen = false;
  while (c1.board!.tiles.some((t) => !t.removed)) {
    const hint = findHint(c1.board!);
    if (!hint) throw new Error("로컬 보드 힌트 없음 — 서버와 동기화 실패");
    const r = await emitAck(c1.sock, "tile:match", { tileA: hint[0].tileId, tileB: hint[1].tileId });
    if (!r.ok) throw new Error("tile:match 실패: " + r.error);
    const ev = await c1.waitFor<any>("tile:matched");
    if (ev.combo > comboSeen) comboSeen = ev.combo;
    if (ev.scoreDelta <= 0 || !Array.isArray(ev.path) || ev.path.length < 2)
      throw new Error("tile:matched 페이로드 이상");
    if (c1.pendingCount("player:progress") > 0) {
      progressSeen = true;
      c1.drain("player:progress");
    }
    if (ev.comboPower && !comboPowerTested && c1.board!.tiles.some((t) => !t.removed)) {
      comboPowerTested = true;
      check("콤보 파워 도달 통지 (5콤보=pair)", ev.comboPower.level === 5 && ev.comboPower.kind === "pair");
      const liveT = c1.board!.tiles.find((t) => !t.removed)!;
      c1.drain("board:update");
      const pw = await emitAck(c1.sock, "combo:power", { cardId: liveT.card.cardId });
      check("combo:power 발동", pw.ok);
      const up = await c1.waitFor<BoardPatch>("board:update");
      check("board:update reason=combo", up.reason === "combo");
    }
  }
  check("연속 매칭으로 콤보 상승", comboSeen >= 2);
  check("player:progress 브로드캐스트 수신", progressSeen);
  check("콤보 파워 시나리오 실행됨", comboPowerTested);

  const fin1 = await c1.waitFor<any>("match:finishing");
  const fin2 = await c2.waitFor<any>("match:finishing");
  check(
    "match:finishing 브로드캐스트 (승자=c1)",
    fin1.winnerId === c1.playerId && fin2.winnerId === c1.playerId && typeof fin1.countdownSec === "number"
  );
  const end1 = await c1.waitFor<any>("match:ended", 5000);
  await c2.waitFor<any>("match:ended", 5000);
  check("정상 종료: timedOut=false", end1.timedOut === false);
  check(
    "순위: c1 1위·클리어",
    end1.ranks[0].playerId === c1.playerId && end1.ranks[0].rank === 1 && end1.ranks[0].cleared === true
  );
  check(
    "순위: c2 2위·미클리어(잔여패 유지)",
    end1.ranks[1].playerId === c2.playerId && end1.ranks[1].rank === 2 && !end1.ranks[1].cleared && end1.ranks[1].remaining > 0
  );
  const s1 = end1.summaries.find((s: any) => s.playerId === c1.playerId);
  const s2 = end1.summaries.find((s: any) => s.playerId === c2.playerId);
  check("요약: xp·metCards·topCard", s1.xp > 0 && s1.metCards.length > 0 && s1.topCard !== null);
  const metSum = s1.metCards.reduce((a: number, m: any) => a + m.count, 0);
  const gradeSum = s1.gradeDist.reduce((a: number, g: any) => a + g.count, 0);
  check("요약: gradeDist 합계 = metCards 합계", metSum === gradeSum && metSum > 0);
  check("요약: 미플레이어는 빈 집계", s2.metCards.length === 0 && s2.topCard === null);
  check(
    "요약: dexProgress 형태",
    typeof s1.dexProgress.pokemon.total === "number" && s1.dexProgress.pokemon.total > 0 && "one-piece" in s1.dexProgress
  );
  {
    const lst2 = await emitAck<{ rooms: any[] }>(c1.sock, "room:list");
    check("매치 종료 후 방 waiting 복귀", lst2.data!.rooms.find((r) => r.roomId === roomId)?.state === "waiting");
  }

  // ── 아이템 3종 (재플레이로 검증) ────────────────────────────
  console.log("\n[아이템]");
  for (const ev of EVENTS) {
    c1.drain(ev);
    c2.drain(ev);
  }
  const gs2 = await emitAck(c1.sock, "game:start");
  check("재플레이 game:start (인원 유지)", gs2.ok);
  await c1.waitFor<BoardInit>("board:init");
  await c2.waitFor<BoardInit>("board:init");
  await c1.waitForGo(); // GO 이후에만 아이템 사용 가능
  await c2.waitForGo();

  // 서치: 연결 가능한 짝(승리 제외)을 서버가 찾아 정상 매칭 파이프라인으로 즉시 제거
  const se = await emitAck<{ highlight?: [number, number] }>(c1.sock, "item:use", { type: "search" });
  const hi = se.data?.highlight;
  const hiSame =
    !!hi &&
    c1.board!.tiles.find((t) => t.tileId === hi[0])?.matchKey === c1.board!.tiles.find((t) => t.tileId === hi[1])?.matchKey;
  check("서치: ack ok + 같은 카드 짝 하이라이트", se.ok && hiSame);
  // ack 직후 본인 소켓에 tile:matched 가 뒤따라 도착(같은 스트림상 ack 보다 먼저 emit 됨) — 여기서 소비해
  // 이후 가위 검증의 waitFor("tile:matched") 가 이 이벤트를 대신 집어가지 않게 한다.
  const seEv = await c1.waitFor<any>("tile:matched");
  const seIdsMatch =
    !!hi && ((seEv.tileA === hi[0] && seEv.tileB === hi[1]) || (seEv.tileA === hi[1] && seEv.tileB === hi[0]));
  check(
    "서치: tile:matched 로 즉시 제거 방송 (path 길이≥2, tileId 일치)",
    Array.isArray(seEv.path) && seEv.path.length >= 2 && seIdsMatch
  );
  check(
    "서치: 제거된 타일이 보드에서 즉시 사라짐",
    !!hi &&
      c1.board!.tiles.find((t) => t.tileId === hi[0])?.removed === true &&
      c1.board!.tiles.find((t) => t.tileId === hi[1])?.removed === true
  );

  // 섞기: board:update reason=shuffle
  c1.drain("board:update");
  const sh = await emitAck(c1.sock, "item:use", { type: "shuffle" });
  const shUp = await c1.waitFor<BoardPatch>("board:update");
  check("섞기: board:update reason=shuffle", sh.ok && shUp.reason === "shuffle");

  // 가위: 경로 무관 강제 제거, path=[] + 콤보 반영
  const pair = pickPair(c1.board!)!;
  const sc = await emitAck(c1.sock, "item:use", { type: "scissor", tiles: [pair[0].tileId, pair[1].tileId] });
  const scEv = await c1.waitFor<any>("tile:matched");
  check("가위: path=[] 제거 + 콤보 카운트 반영", sc.ok && scEv.path.length === 0 && scEv.combo >= 1);
  const scDiff = pickPair(c1.board!);
  {
    // 서로 다른 카드 지정 → 거부 (수량은 이미 소진이라 소진 에러가 먼저 나와도 !ok)
    const sc2 = await emitAck(c1.sock, "item:use", { type: "scissor", tiles: [scDiff![0].tileId, scDiff![1].tileId] });
    check("가위 소진(게임당 1개) error", !sc2.ok && sc2.error === "noQuota");
  }
  // 서치 소진: 앞서 1회 사용 → 2회 추가 사용 후 4회차 거부
  // se2/se3 도 성공 시 각각 짝을 제거하고 tile:matched(+드물게 board:update 재셔플) 를 방송하므로,
  // 이후 스텝(방 이탈/승리 모드 등)이 잔여 이벤트로 오염되지 않게 즉시 drain 한다.
  const se2 = await emitAck(c1.sock, "item:use", { type: "search" });
  if (se2.ok) c1.drain("tile:matched");
  const se3 = await emitAck(c1.sock, "item:use", { type: "search" });
  if (se3.ok) c1.drain("tile:matched");
  const se4 = await emitAck(c1.sock, "item:use", { type: "search" });
  check("서치 소진(게임당 3개) error", se2.ok && se3.ok && !se4.ok && se4.error === "noQuota");
  c1.drain("board:update");
  c1.drain("player:progress");

  // 게임 중 전원 이탈 → 방 삭제
  c1.sock.emit("room:leave");
  c2.sock.emit("room:leave");
  await sleep(150);
  const lst3 = await emitAck<{ rooms: any[] }>(c1.sock, "room:list");
  check("게임 중 전원 이탈 시 방 삭제", !lst3.data!.rooms.some((r) => r.roomId === roomId));

  // ── 정원 초과 / 비밀번호 ────────────────────────────────────
  console.log("\n[정원·비밀번호]");
  const crSolo = await emitAck<{ room: any }>(c1.sock, "room:create", baseCfg({ name: "솔로방", maxPlayers: 1 }));
  const jFull = await emitAck(c2.sock, "room:join", { roomId: crSolo.data!.room.roomId });
  check("정원 초과 full", !jFull.ok && jFull.error === "full");

  const crNoPw = await emitAck(c1.sock, "room:create", baseCfg({ name: "비번없는비공개", visibility: "private" }));
  check("비공개방 비밀번호 필수", !crNoPw.ok);
  const crPw = await emitAck<{ room: any }>(
    c1.sock,
    "room:create",
    baseCfg({ name: "비밀방", visibility: "private", password: "1234" })
  );
  const pwRoomId: string = crPw.data!.room.roomId;
  const lstPw = await emitAck<{ rooms: any[] }>(c2.sock, "room:list");
  const pwSummary = lstPw.data!.rooms.find((r) => r.roomId === pwRoomId);
  check(
    "비공개방도 목록 노출 (hasPassword=true, 비밀번호 비노출)",
    !!pwSummary && pwSummary.hasPassword === true && !("password" in pwSummary)
  );
  const jWrong = await emitAck(c2.sock, "room:join", { roomId: pwRoomId, password: "wrong" });
  check("badPassword", !jWrong.ok && jWrong.error === "badPassword");
  // REST 검증은 c2 실입장 전에 수행 (입장 후에는 정원이 차서 full/409 가 먼저 반환됨)
  const restJoinBad = await fetch(url + `/api/rooms/${pwRoomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "nope" }),
  });
  check("REST join 검증 badPassword 403", restJoinBad.status === 403);
  const jRight = await emitAck(c2.sock, "room:join", { roomId: pwRoomId, password: "1234" });
  check("비밀번호 일치 입장", jRight.ok);

  // room:config — 방장만
  const cfgBad = await emitAck(c2.sock, "room:config", { difficulty: "hard" });
  check("room:config notHost", !cfgBad.ok && cfgBad.error === "notHost");
  const cfgUp = await emitAck(c1.sock, "room:config", { mapMode: "up" });
  check("room:config UP 모드 비활성화 거부", !cfgUp.ok && cfgUp.error === "modeDisabled");
  const cfgOk = await emitAck<{ room: any }>(c1.sock, "room:config", { difficulty: "normal", game: "one-piece" });
  check("room:config 방장 변경", cfgOk.ok && cfgOk.data!.room.difficulty === "normal" && cfgOk.data!.room.game === "one-piece");

  // ── 승리 모드: 즉시 종료 + 진행 중 입장 불가 ────────────────
  console.log("\n[승리 모드]");
  const crV = await emitAck<{ room: any }>(
    c1.sock,
    "room:create",
    baseCfg({ name: "승리전", game: "one-piece", mapMode: "victory" })
  );
  const vRoomId: string = crV.data!.room.roomId;
  const jV = await emitAck(c2.sock, "room:join", { roomId: vRoomId });
  check("승리전 입장", jV.ok);
  for (const ev of EVENTS) {
    c1.drain(ev);
    c2.drain(ev);
  }
  const gsV = await emitAck(c1.sock, "game:start");
  check("승리전 시작", gsV.ok);
  await c1.waitFor<BoardInit>("board:init");
  await c2.waitFor<BoardInit>("board:init");
  await c1.waitForGo(); // GO 이후에만 가위/매칭 가능 (승리 카드 가위 거부·경로 매칭 검증)
  await c2.waitForGo();
  const vic = c1.board!.tiles.filter((t) => t.victory);
  check("승리 카드 정확히 1쌍 배치", vic.length === 2 && vic[0].matchKey === vic[1].matchKey);

  const c3 = new TC(url);
  await emitAck(c3.sock, "lobby:hello", { nickname: "늦깎이" });
  const jPlaying = await emitAck(c3.sock, "room:join", { roomId: vRoomId });
  check("진행 중 입장 불가 playing", !jPlaying.ok && jPlaying.error === "playing");

  // 승리 카드는 가위로 제거 불가 — 경로 매칭으로만 승리 (회귀 방지, 소모도 되지 않음)
  const scReject = await emitAck(c1.sock, "item:use", { type: "scissor", tiles: [vic[0].tileId, vic[1].tileId] });
  check("승리 카드는 가위로 제거 불가", !scReject.ok);

  // c1 이 힌트를 이어가다 승리 짝을 경로로 연결하면 유예 없이 즉시 종료
  let endV: any = null;
  let victoryMatched = false;
  for (let guard = 0; guard < 500 && c1.board!.tiles.some((t) => !t.removed); guard++) {
    const hint = findHint(c1.board!);
    if (!hint) throw new Error("승리 모드 로컬 보드 힌트 없음 — 서버와 동기화 실패");
    const isVictory = hint[0].matchKey === "__victory__";
    const r = await emitAck(c1.sock, "tile:match", { tileA: hint[0].tileId, tileB: hint[1].tileId });
    if (!r.ok) throw new Error("승리 모드 tile:match 실패: " + r.error);
    if (isVictory) {
      victoryMatched = true;
      endV = await c1.waitFor<any>("match:ended", 3000);
      break;
    }
    await c1.waitFor<any>("tile:matched");
    c1.drain("player:progress");
    c1.drain("board:update");
  }
  await c2.waitFor<any>("match:ended", 3000);
  check("승리 모드: 승리 짝을 경로 매칭으로 연결", victoryMatched && !!endV);
  check(
    "승리 모드: 승리 짝 매칭 → 즉시 1위·즉시 종료",
    !!endV && endV.ranks[0].playerId === c1.playerId && endV.ranks[0].rank === 1
  );
  check("승리 모드: match:finishing 유예 없음", c1.pendingCount("match:finishing") === 0);

  // ── 도감/SBT ───────────────────────────────────────────────
  console.log("\n[도감·SBT]");
  const dg = await emitAck<any>(c1.sock, "dex:get");
  check(
    "dex:get entries/progress/sbts",
    dg.ok && Array.isArray(dg.data.entries) && dg.data.entries.length > 0 && dg.data.progress.pokemon.total > 0 && Array.isArray(dg.data.sbts)
  );
  check(
    `도감: ${DEX_REGISTER_COUNT}회 매칭한 엔트리 즉시 등록`,
    dg.data.entries.every((entry: any) => entry.count >= DEX_REGISTER_COUNT && entry.registered)
  );
  const sb = await emitAck(c1.sock, "sbt:claim", { category: "pokemon" });
  check("도감 미완성 시 sbt:claim 거부", !sb.ok);
  const restDex = (await fetch(url + `/api/dex/${encodeURIComponent(c1.playerId)}`).then((r) => r.json())) as any;
  check(
    "REST /api/dex 소켓과 동일 데이터",
    restDex.entries.length === dg.data.entries.length && restDex.progress.pokemon.registered === dg.data.progress.pokemon.registered
  );

  // ── 재접속 복구 (disconnect grace + resume) ─────────────────
  console.log("\n[재접속 복구]");
  // 1) 대기실: A 방 생성 → 소켓 끊김(유예 중 방 유지) → 같은 playerId 재접속 → resume.room 복구
  const ra = new TC(url);
  const ha = await emitAck<{ playerId: string }>(ra.sock, "lobby:hello", { nickname: "복구왕" });
  ra.playerId = ha.data!.playerId;
  const rcr = await emitAck<{ room: any }>(ra.sock, "room:create", baseCfg({ name: "복구방", maxPlayers: 2 }));
  const rRoomId: string = rcr.data!.room.roomId;
  ra.sock.disconnect();
  await sleep(120); // onDisconnect 처리 대기 (유예 500ms 이내)
  // 방장 새로고침: 유예 중엔 방이 즉시 닫히지 않는다
  const lstGrace = await emitAck<{ rooms: any[] }>(c1.sock, "room:list");
  check("방장 새로고침: 유예 중 방 유지(즉시 안 닫힘)", lstGrace.data!.rooms.some((r) => r.roomId === rRoomId));
  const ra2 = new TC(url);
  const reHello = await emitAck<{ playerId: string; resume?: any }>(ra2.sock, "lobby:hello", {
    nickname: "복구왕",
    playerId: ra.playerId,
  });
  ra2.playerId = ra.playerId;
  const resume1 = reHello.data?.resume;
  check(
    "대기실 재접속: resume.room 반환 + 방 유지",
    reHello.ok && !!resume1?.room && resume1.room.roomId === rRoomId && !resume1.board
  );
  check(
    "대기실 재접속: connected 복원(true)",
    resume1?.room.players.find((p: any) => p.playerId === ra.playerId)?.connected === true
  );

  // 2) 게임 중: 몇 매칭 진행 → 끊김 → 재접속 → resume.board removed 수·progress 일치, elapsedMs>0
  const rb = new TC(url);
  await emitAck(rb.sock, "lobby:hello", { nickname: "복구비" });
  await emitAck(rb.sock, "room:join", { roomId: rRoomId });
  for (const ev of EVENTS) {
    ra2.drain(ev);
    rb.drain(ev);
  }
  const rgs = await emitAck(ra2.sock, "game:start"); // ra2 가 방장(승계됨)
  check("복구방 재플레이 game:start", rgs.ok);
  await ra2.waitFor<BoardInit>("board:init");
  await rb.waitFor<BoardInit>("board:init");
  await ra2.waitForGo();
  await rb.waitForGo();
  let scoreBefore = 0;
  for (let i = 0; i < 3; i++) {
    const hint = findHint(ra2.board!);
    if (!hint) break;
    const r = await emitAck(ra2.sock, "tile:match", { tileA: hint[0].tileId, tileB: hint[1].tileId });
    if (!r.ok) break;
    const ev = await ra2.waitFor<any>("tile:matched");
    scoreBefore += ev.scoreDelta;
    ra2.drain("player:progress");
    ra2.drain("board:update");
  }
  const removedBefore = ra2.board!.tiles.filter((t) => t.removed).length;
  const liveBefore = ra2.board!.tiles.filter((t) => !t.removed).length;
  check("게임 중 진행: 매칭으로 타일 제거됨", removedBefore >= 2 && scoreBefore > 0);
  ra2.sock.disconnect();
  await sleep(120);
  const ra3 = new TC(url);
  const reHello2 = await emitAck<{ resume?: any }>(ra3.sock, "lobby:hello", { nickname: "복구왕", playerId: ra.playerId });
  ra3.playerId = ra.playerId;
  const resume2 = reHello2.data?.resume;
  const snapRemoved = resume2?.board ? resume2.board.tiles.filter((t: any) => t.removed).length : -1;
  check("게임 중 재접속: resume.board removed 타일 수 일치", !!resume2?.board && snapRemoved === removedBefore);
  check(
    "게임 중 재접속: progress score/remaining/items/elapsed 일치",
    !!resume2?.progress &&
      resume2.progress.score === scoreBefore &&
      resume2.progress.remaining === liveBefore &&
      resume2.progress.items.search === 3 &&
      resume2.progress.items.scissor === 1 &&
      resume2.progress.elapsedMs > 0
  );
  // 복구 후 계속 플레이 가능 (재조인된 소켓이 매치에 유효)
  ra3.board = buildBoard(resume2.board as BoardInit);
  const contHint = findHint(ra3.board);
  const contMatch = contHint
    ? await emitAck(ra3.sock, "tile:match", { tileA: contHint[0].tileId, tileB: contHint[1].tileId })
    : { ok: false };
  if (contHint) await ra3.waitFor<any>("tile:matched", 3000);
  check("게임 중 재접속: 복구 후 계속 플레이 가능", contMatch.ok);

  // 3) 방장 유예 중 매치 종료 → 남은 플레이어에게 방장 승계 (game:start 재시작 가능해야 함)
  //    타이밍 경합 방지를 위해 전용 서버(유예 5000ms — 이 시나리오 안에서 절대 만료되지 않게)를 따로 띄운다.
  //    victory 모드로 매치를 즉시 종료(finishGrace 대기 없음)시켜 실행 시간도 짧게 유지한다.
  {
    const srv2 = await createServer(0, { finishGraceMs: 200, countdownStepMs: 10, disconnectGraceMs: 5000, dexFile });
    const url2 = `http://127.0.0.1:${srv2.port}`;
    const h1c = new TC(url2);
    const h2c = new TC(url2);
    const hh1 = await emitAck<{ playerId: string }>(h1c.sock, "lobby:hello", { nickname: "방장" });
    h1c.playerId = hh1.data!.playerId;
    const hh2 = await emitAck<{ playerId: string }>(h2c.sock, "lobby:hello", { nickname: "부방장" });
    h2c.playerId = hh2.data!.playerId;
    const hcr = await emitAck<{ room: any }>(
      h1c.sock,
      "room:create",
      baseCfg({ name: "승계방", maxPlayers: 2, mapMode: "victory" })
    );
    const hRoomId: string = hcr.data!.room.roomId;
    await emitAck(h2c.sock, "room:join", { roomId: hRoomId });
    const hgs = await emitAck(h1c.sock, "game:start");
    check("승계 테스트: 방장 game:start 성공", hgs.ok);
    await h1c.waitFor<BoardInit>("board:init");
    await h2c.waitFor<BoardInit>("board:init");
    await h1c.waitForGo();
    await h2c.waitForGo();
    // 방장(h1c) 소켓 끊김 — 유예(5000ms) 시작, 방·매치는 유지된다
    h1c.sock.disconnect();
    await sleep(60);
    // 상대(h2c) 가 힌트를 따라가다 승리 짝을 경로 매칭으로 연결 → 즉시 종료(유예 없음)
    let hEnded: any = null;
    for (let guard = 0; guard < 500 && h2c.board!.tiles.some((t) => !t.removed); guard++) {
      const hint = findHint(h2c.board!);
      if (!hint) throw new Error("승계 테스트 로컬 보드 힌트 없음 — 서버와 동기화 실패");
      const isVictory = hint[0].matchKey === "__victory__";
      const r = await emitAck(h2c.sock, "tile:match", { tileA: hint[0].tileId, tileB: hint[1].tileId });
      if (!r.ok) throw new Error("승계 테스트 tile:match 실패: " + r.error);
      if (isVictory) {
        hEnded = await h2c.waitFor<any>("match:ended", 3000);
        break;
      }
      await h2c.waitFor<any>("tile:matched");
      h2c.drain("player:progress");
      h2c.drain("board:update");
    }
    check("승계 테스트: 방장 유예 중 상대가 승리해 매치 종료", !!hEnded);
    // 매치 종료 직후 room:list 로 상태를 확인 — 방장(h1c) 은 여전히 유예 중(5000ms 안 지남)이라 방에 남아있되 미접속.
    const hlst = await emitAck<{ rooms: any[] }>(h2c.sock, "room:list");
    check(
      "승계 테스트: 매치 종료 후 waiting 복귀 + 인원 유지(유예 중 방장 포함)",
      hlst.data!.rooms.find((r) => r.roomId === hRoomId)?.state === "waiting" &&
        hlst.data!.rooms.find((r) => r.roomId === hRoomId)?.playerCount === 2
    );
    // 남은 접속 플레이어(h2c)에게 방장이 이양돼 game:start 가 성공해야 한다(수정 전에는 notHost).
    const hgs2 = await emitAck(h2c.sock, "game:start");
    check("방장 유예 중 매치 종료 → 남은 플레이어에게 방장 승계되어 game:start 성공", hgs2.ok);
    h2c.sock.disconnect();
    await srv2.close();
  }

  // 4) 유예 만료: 새 방 생성 → 끊김 → grace 초과 대기 → 방 제거(기존 동작)
  const rc = new TC(url);
  const hc = await emitAck<{ playerId: string }>(rc.sock, "lobby:hello", { nickname: "만료씨" });
  rc.playerId = hc.data!.playerId;
  const rcr2 = await emitAck<{ room: any }>(rc.sock, "room:create", baseCfg({ name: "만료방", maxPlayers: 2 }));
  const expRoomId: string = rcr2.data!.room.roomId;
  rc.sock.disconnect();
  await sleep(900); // > 유예 500ms
  const lstExp = await emitAck<{ rooms: any[] }>(c1.sock, "room:list");
  check("유예 만료: 방 제거됨(기존 제거 동작)", !lstExp.data!.rooms.some((r) => r.roomId === expRoomId));

  ra3.sock.disconnect();
  rb.sock.disconnect();

  // ── 서버 권위 제한시간: 아무도 클리어하지 않은 채 만료 → 현재 점수로 강제 종료 ──
  console.log("\n[3분 제한시간 — 단축 타이머]");
  {
    const timeSrv = await createServer(0, {
      finishGraceMs: 200,
      timeLimitMs: 800,
      countdownStepMs: 10,
      disconnectGraceMs: 500,
      dexFile,
    });
    const timeUrl = `http://127.0.0.1:${timeSrv.port}`;
    const t1 = new TC(timeUrl);
    const t2 = new TC(timeUrl);
    const th1 = await emitAck<{ playerId: string }>(t1.sock, "lobby:hello", { nickname: "타임일" });
    const th2 = await emitAck<{ playerId: string }>(t2.sock, "lobby:hello", { nickname: "타임이" });
    t1.playerId = th1.data!.playerId;
    t2.playerId = th2.data!.playerId;
    const tcr = await emitAck<{ room: any }>(
      t1.sock,
      "room:create",
      baseCfg({ name: "제한시간방", maxPlayers: 2 })
    );
    await emitAck(t2.sock, "room:join", { roomId: tcr.data!.room.roomId });
    const tgs = await emitAck(t1.sock, "game:start");
    check("단축 제한시간: game:start 성공", tgs.ok);
    const tb1 = await t1.waitFor<BoardInit>("board:init");
    const tb2 = await t2.waitFor<BoardInit>("board:init");
    check("board:init: 실제 timeLimitMs 전달", tb1.timeLimitMs === 800 && tb2.timeLimitMs === 800);
    await t1.waitForGo();
    await t2.waitForGo();

    // t1만 한 쌍을 제거해 현재 점수·잔여 패에 차이를 만든 뒤, 아무도 완주하지 않고 만료를 기다린다.
    const timeHint = findHint(t1.board!);
    if (!timeHint) throw new Error("제한시간 테스트 로컬 보드 힌트 없음");
    const timeMatch = await emitAck(t1.sock, "tile:match", {
      tileA: timeHint[0].tileId,
      tileB: timeHint[1].tileId,
    });
    check("단축 제한시간: 만료 전 현재 점수 생성", timeMatch.ok);
    if (timeMatch.ok) await t1.waitFor<any>("tile:matched");

    const [timeEnd1, timeEnd2] = await Promise.all([
      t1.waitFor<any>("match:ended", 3000),
      t2.waitFor<any>("match:ended", 3000),
    ]);
    check("단축 제한시간: 전원 timedOut=true 수신", timeEnd1.timedOut === true && timeEnd2.timedOut === true);
    check(
      "단축 제한시간: 현재 점수·잔여 패 기준 순위",
      timeEnd1.ranks[0].playerId === t1.playerId &&
        timeEnd1.ranks[0].score > timeEnd1.ranks[1].score &&
        timeEnd1.ranks[0].remaining < timeEnd1.ranks[1].remaining
    );
    check(
      "단축 제한시간: 전원 동일 순위 결과",
      JSON.stringify(timeEnd1.ranks) === JSON.stringify(timeEnd2.ranks)
    );
    t1.sock.disconnect();
    t2.sock.disconnect();
    await timeSrv.close();
  }

  // ── 정리 ───────────────────────────────────────────────────
  c1.sock.disconnect();
  c2.sock.disconnect();
  c3.sock.disconnect();
  await srv.close();
}

main()
  .then(() => {
    console.log("\n결과: " + pass + " pass, " + fail + " fail");
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error("\n테스트 실행 실패:", err);
    console.log("결과: " + pass + " pass, " + (fail + 1) + " fail (실행 중단)");
    process.exit(1);
  });
