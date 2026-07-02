// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 서버 공용 타입 (Socket.IO 제네릭 별칭)
// shared/protocol.ts 의 ClientToServer/ServerToClient 를 그대로 타입 계약으로 사용한다.
// ─────────────────────────────────────────────────────────────
import type { Server, Socket } from "socket.io";
import type { ClientToServer, ServerToClient } from "../shared/protocol.ts";

/** socket.data — 소켓별 세션 상태 */
export interface SocketData {
  playerId?: string; // lobby:hello 로 발급/재사용된 플레이어 ID
  roomId?: string; // 현재 참가 중인 방 ID
}

export type IO = Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
export type GameSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
