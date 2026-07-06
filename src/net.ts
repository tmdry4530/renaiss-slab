// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 타입드 Socket.IO 클라이언트 (shared/protocol.ts 계약 기반)
// dev 에서는 vite 프록시(/socket.io → :8787)를 경유하므로 same-origin 기본 접속.
// playerId·nickname 은 localStorage 에 영속하고, 재접속 시 lobby:hello 를 재수행한다.
// ─────────────────────────────────────────────────────────────
import { io, type Socket } from "socket.io-client";
import type { Ack, ClientToServer, ResumeState, ServerToClient } from "../shared/protocol.ts";

export type GameSocket = Socket<ServerToClient, ClientToServer>;

let sock: GameSocket | null = null;

/** 싱글턴 소켓. 최초 호출 시 접속 시작 (socket.io 기본 자동 재접속 포함). */
export function getSocket(): GameSocket {
  if (!sock) {
    // path 기본값(/socket.io) 그대로 — vite dev 프록시가 서버(:8787)로 넘겨준다.
    sock = io();
  }
  return sock;
}

// ── 플레이어 신원 (localStorage 영속) ────────────────────────
const PID_KEY = "rsk:playerId";
const NICK_KEY = "rsk:nickname";

export const loadPlayerId = (): string | undefined =>
  localStorage.getItem(PID_KEY) ?? undefined;
export const loadNickname = (): string => localStorage.getItem(NICK_KEY) ?? "";

/**
 * lobby:hello 수행. 성공 시 playerId·nickname 을 localStorage 에 영속한다.
 * 서버 무응답 대비 타임아웃(기본 5초) 시 { ok:false, error:"timeout" } 으로 응답한다.
 */
export function hello(
  nickname: string,
  timeoutMs = 5000
): Promise<Ack<{ playerId: string; resume?: ResumeState }>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: "timeout" });
      }
    }, timeoutMs);
    getSocket().emit("lobby:hello", { nickname, playerId: loadPlayerId() }, (r) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (r.ok && r.data) {
        localStorage.setItem(PID_KEY, r.data.playerId);
        localStorage.setItem(NICK_KEY, nickname);
      }
      resolve(r);
    });
  });
}
