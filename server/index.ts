// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 게임 서버 진입점 (Fastify + Socket.IO 단일 프로세스)
// - 포트 8787 기본, 환경변수 PORT 허용
// - dev: vite 가 /api·/socket.io 를 프록시 / production: dist/ 정적 서빙
// - REST 는 TECH-SPEC §7.1, 소켓 이벤트는 shared/protocol.ts 계약을 그대로 따른다
// - 테스트에서 createServer(port, opts) 로 임의 포트·짧은 유예 주입 가능
// ─────────────────────────────────────────────────────────────
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { Server as SocketIOServer } from "socket.io";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import {
  COUNTDOWN_STEP_MS,
  FINISH_GRACE_MS,
  type ClientToServer,
  type ServerToClient,
} from "../shared/protocol.ts";
import { marketUrl } from "../shared/cards.ts";
import { DexStore } from "./dex.ts";
import { PoolStore, type PoolGameFilter } from "./pool.ts";
import { RoomManager } from "./rooms.ts";
import type { IO, SocketData } from "./types.ts";

export interface CreateServerOpts {
  /** 테스트용: 1위 확정 후 유예 시간(ms) 주입 (기본 FINISH_GRACE_MS = 10초) */
  finishGraceMs?: number;
  /** 테스트용: 3-2-1 카운트다운 스텝 간격(ms) 주입 (기본 COUNTDOWN_STEP_MS = 1초) */
  countdownStepMs?: number;
  /** 테스트용: 도감 저장 파일 경로 격리 */
  dexFile?: string;
}

export interface RunningServer {
  port: number;
  io: IO;
  close: () => Promise<void>;
}

// 전역 예외 안전망은 1회만 설치 (createServer 를 여러 번 호출해도 리스너 중복 방지).
let globalGuardsInstalled = false;
function installProcessGuards(): void {
  if (globalGuardsInstalled) return;
  globalGuardsInstalled = true;
  // game:start 등에서 예기치 못한 throw 가 이벤트 루프로 새어 나가도 프로세스는 유지한다.
  // (진짜 버그를 숨기지 않도록 스택을 명확히 로깅 — 종료는 하지 않음.)
  process.on("uncaughtException", (e) => console.error("[server] uncaughtException (프로세스 유지):", e));
  process.on("unhandledRejection", (e) => console.error("[server] unhandledRejection (프로세스 유지):", e));
}

export async function createServer(
  port: number = Number(process.env.PORT) || 8787,
  opts: CreateServerOpts = {}
): Promise<RunningServer> {
  installProcessGuards();
  // maxParamLength: cardId(해시 포함 100자 초과)가 URL 파라미터로 오므로 기본값(100)을 상향
  const app = Fastify({ logger: false, maxParamLength: 512 });
  await app.register(fastifyCors, { origin: true }); // dev CORS 허용

  // production: 빌드된 프런트(dist/) 정적 서빙 + SPA 폴백
  // (Windows 에서 `NODE_ENV=production` 접두사가 안 되므로 --static 플래그도 지원)
  if (process.env.NODE_ENV === "production" || process.argv.includes("--static")) {
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL("../dist", import.meta.url)),
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) return reply.sendFile("index.html");
      return reply.code(404).send({ ok: false, error: "찾을 수 없습니다" });
    });
  }

  // 카드 풀은 서버 시작 시 1회 로드 (public/data/card-pool.json)
  const pool = new PoolStore();
  const dex = new DexStore(pool, opts.dexFile);

  // Socket.IO — fastify 의 http 서버에 부착 (fastify 가 요청 리스너를 먼저 등록한 뒤 부착되므로 안전)
  const io: IO = new SocketIOServer<ClientToServer, ServerToClient, Record<string, never>, SocketData>(
    app.server,
    { cors: { origin: true } }
  );
  const mgr = new RoomManager(
    io,
    pool,
    dex,
    opts.finishGraceMs ?? FINISH_GRACE_MS,
    opts.countdownStepMs ?? COUNTDOWN_STEP_MS
  );

  // ── REST (TECH-SPEC §7.1) ──────────────────────────────────
  app.post("/api/rooms", async (req, reply) => {
    const r = mgr.restCreate(req.body);
    if (!r.ok || !r.data) return reply.code(400).send({ ok: false, error: r.error });
    return { room: r.data.room };
  });

  app.get("/api/rooms", async () => ({ rooms: mgr.list() }));

  // 검증만 수행 — 실입장은 socket room:join
  app.post("/api/rooms/:id/join", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { password?: string };
    const err = mgr.validateJoin(id, body.password);
    if (err) {
      const code = err === "notFound" ? 404 : err === "badPassword" ? 403 : 409;
      return reply.code(code).send({ ok: false, error: err });
    }
    return { ok: true };
  });

  app.get("/api/cards/pool", async (req, reply) => {
    const q = (req.query ?? {}) as { game?: string };
    if (q.game && q.game !== "pokemon" && q.game !== "one-piece" && q.game !== "mixed")
      return reply.code(400).send({ ok: false, error: "알 수 없는 카드 세트입니다" });
    const game: PoolGameFilter = q.game === "pokemon" || q.game === "one-piece" ? q.game : "mixed";
    const cards = pool.cardsFor(game);
    return {
      generatedAt: pool.pool.generatedAt,
      source: pool.pool.source,
      counts: {
        pokemon: cards.filter((c) => c.game === "pokemon").length,
        "one-piece": cards.filter((c) => c.game === "one-piece").length,
      },
      cards,
    };
  });

  app.get("/api/dex/:playerId", async (req) => {
    const { playerId } = req.params as { playerId: string };
    return {
      entries: dex.entriesFor(playerId),
      progress: dex.progressFor(playerId),
      sbts: dex.sbtsFor(playerId),
    };
  });

  app.get("/api/cards/:cardId/docent", async (req, reply) => {
    const { cardId } = req.params as { cardId: string };
    const card = pool.cardById(cardId);
    if (!card) return reply.code(404).send({ ok: false, error: "카드를 찾을 수 없습니다" });
    return { card, marketUrl: marketUrl(card.href) };
  });

  // ── Socket.IO 이벤트 (shared/protocol.ts 계약) ─────────────
  io.on("connection", (socket) => {
    socket.on("lobby:hello", (p, ack) => {
      const r = mgr.hello(p?.nickname, p?.playerId);
      if (r.ok && r.data) socket.data.playerId = r.data.playerId;
      ack(r);
    });

    socket.on("room:create", (p, ack) => ack(mgr.createSocket(socket, p)));
    socket.on("room:list", (ack) => ack({ ok: true, data: { rooms: mgr.list() } }));
    socket.on("room:join", (p, ack) => ack(mgr.joinSocket(socket, p)));
    socket.on("room:leave", () => mgr.leaveSocket(socket));
    socket.on("room:config", (p, ack) => ack(mgr.configSocket(socket, p)));
    socket.on("game:start", (ack) => {
      // 핸들러가 throw 하더라도 ack 를 반드시 호출해 클라가 무응답으로 멈추지 않게 한다.
      try {
        ack(mgr.startSocket(socket));
      } catch (e) {
        console.error("[server] game:start 처리 실패:", e);
        ack({ ok: false, error: "게임 시작에 실패했습니다" });
      }
    });

    socket.on("tile:match", (p, ack) => {
      const ctx = mgr.matchContext(socket);
      if (!ctx) return ack?.({ ok: false, error: "진행 중인 매치가 없습니다" });
      ctx.match.handleTileMatch(ctx.playerId, p, ack);
    });

    socket.on("item:use", (p, ack) => {
      const ctx = mgr.matchContext(socket);
      if (!ctx) return ack({ ok: false, error: "진행 중인 매치가 없습니다" });
      ctx.match.handleItemUse(ctx.playerId, p, ack);
    });

    socket.on("combo:power", (p, ack) => {
      const ctx = mgr.matchContext(socket);
      if (!ctx) return ack({ ok: false, error: "진행 중인 매치가 없습니다" });
      ctx.match.handleComboPower(ctx.playerId, p, ack);
    });

    socket.on("dex:get", (ack) => {
      const pid = socket.data.playerId;
      if (!pid) return ack({ ok: false, error: "먼저 lobby:hello 를 보내세요" });
      ack({
        ok: true,
        data: { entries: dex.entriesFor(pid), progress: dex.progressFor(pid), sbts: dex.sbtsFor(pid) },
      });
    });

    socket.on("sbt:claim", (p, ack) => {
      const pid = socket.data.playerId;
      if (!pid) return ack({ ok: false, error: "먼저 lobby:hello 를 보내세요" });
      ack(dex.claim(pid, p?.category));
    });

    socket.on("disconnect", () => mgr.onDisconnect(socket));
  });

  await app.listen({ port, host: "0.0.0.0" });
  const actualPort = (app.server.address() as AddressInfo).port;

  return {
    port: actualPort,
    io,
    close: async () => {
      mgr.dispose();
      dex.close();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await app.close().catch(() => {});
    },
  };
}

// 직접 실행 시 자동 기동 (모듈 임포트 시에는 기동하지 않음 — 테스트에서 createServer 사용)
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createServer()
    .then(({ port }) => console.log(`[server] Renaiss Slab King 게임 서버 기동 — http://localhost:${port}`))
    .catch((e) => {
      console.error("[server] 기동 실패:", e);
      process.exit(1);
    });
}
