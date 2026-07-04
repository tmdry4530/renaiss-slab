// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 방 관리 (FEATURE_SPEC F-02·F-03, TECH-SPEC §3.4)
// 가정(Open Issue 6): 방장 퇴장 시 다음 입장자(입장 순서상 가장 앞 플레이어)에게 방장 승계.
// 게임 중 이탈자: connected=false 마킹만 하고 보드는 유지, 매치는 계속 진행.
//   매치 종료 시 이탈자를 정리한다. 게임 중 재접속(보드 복구)은 미지원 — 데모 범위 단순화.
// ─────────────────────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import { DIFFICULTIES } from "../shared/board.ts";
import { MAP_THEMES } from "../shared/mapThemes.ts";
import {
  MAP_MODES,
  type Ack,
  type PlayerPublic,
  type RoomConfig,
  type RoomDetail,
  type RoomState,
  type RoomSummary,
} from "../shared/protocol.ts";
import { Match } from "./match.ts";
import type { DexStore } from "./dex.ts";
import type { PoolStore } from "./pool.ts";
import type { GameSocket, IO } from "./types.ts";

const GAME_SELS = ["pokemon", "one-piece"] as const;
const MODE_KEYS = MAP_MODES.map((m) => m.key);
const DIFF_KEYS = DIFFICULTIES.map((d) => d.key);
const ROOM_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 혼동 문자(I/O/0/1) 제외

export interface RoomPlayer {
  playerId: string;
  nickname: string;
  socketId: string | null;
  connected: boolean;
  finishedRank?: number; // 직전 매치 최종 순위 (대기실 표시용)
}

export interface Room {
  roomId: string;
  config: RoomConfig;
  hostId: string;
  state: RoomState;
  players: RoomPlayer[]; // 입장 순서 유지 (방장 승계 기준)
  match: Match | null;
}

/** 닉네임 검증: 공백 제거 후 1~12자 */
export function validateNickname(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const nick = v.trim();
  if (nick.length < 1 || nick.length > 12) return null;
  return nick;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private nicknames = new Map<string, string>(); // playerId → 최근 닉네임 (재접속 시 재사용)

  constructor(
    private io: IO,
    private pool: PoolStore,
    private dex: DexStore,
    private finishGraceMs: number,
    private countdownStepMs: number
  ) {}

  /** 종료 시 모든 매치 타이머 정리 */
  dispose(): void {
    for (const room of this.rooms.values()) room.match?.dispose();
    this.rooms.clear();
  }

  // ── 로비 ───────────────────────────────────────────────────

  /** lobby:hello — playerId 발급/재사용 (재접속 지원) */
  hello(nickname: unknown, playerId?: unknown): Ack<{ playerId: string }> {
    const nick = validateNickname(nickname);
    if (!nick) return { ok: false, error: "닉네임은 1~12자여야 합니다" };
    // 기존 playerId 를 제시하면 그대로 재사용 (서버 재시작 후에도 도감 연속성 유지)
    const pid =
      typeof playerId === "string" && playerId.length >= 1 && playerId.length <= 64
        ? playerId
        : "p-" + randomUUID();
    this.nicknames.set(pid, nick);
    return { ok: true, data: { playerId: pid } };
  }

  // ── 방 생성/목록/입장 ──────────────────────────────────────

  /** RoomConfig 검증 — 실패 시 에러 메시지(한국어) 반환 */
  private sanitizeConfig(body: unknown): RoomConfig | string {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < 1 || name.length > 24) return "방 이름은 1~24자여야 합니다";
    const visibility = b.visibility === "private" ? "private" : b.visibility === "public" ? "public" : null;
    if (!visibility) return "공개 여부(visibility)가 잘못되었습니다";
    const maxPlayers = Number(b.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 4)
      return "최대 인원은 1~4명이어야 합니다";
    const password = typeof b.password === "string" && b.password.length > 0 ? b.password : undefined;
    if (visibility === "private" && !password) return "비공개 방은 비밀번호가 필수입니다";
    const game = GAME_SELS.find((g) => g === b.game);
    if (!game) return "알 수 없는 카드 세트입니다";
    const mapMode = MODE_KEYS.find((m) => m === b.mapMode);
    if (!mapMode) return "알 수 없는 맵 모드입니다";
    const difficulty = DIFF_KEYS.find((d) => d === b.difficulty);
    if (!difficulty) return "알 수 없는 난이도입니다";
    let theme: string | undefined;
    if (b.theme !== undefined) {
      // hasOwnProperty 로 검사 — "in" 은 "constructor" 등 프로토타입 키를 통과시킨다.
      if (typeof b.theme !== "string" || !Object.prototype.hasOwnProperty.call(MAP_THEMES, b.theme))
        return "알 수 없는 맵 테마입니다";
      theme = b.theme;
    }
    return {
      name,
      visibility,
      ...(password ? { password } : {}),
      maxPlayers,
      game,
      mapMode,
      difficulty,
      ...(theme ? { theme } : {}),
    };
  }

  private genRoomId(): string {
    for (;;) {
      let id = "";
      for (let i = 0; i < 6; i++) id += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
      if (!this.rooms.has(id)) return id;
    }
  }

  private instantiateRoom(hostId: string, nickname: string, config: RoomConfig, socket: GameSocket | null): Room {
    const room: Room = {
      roomId: this.genRoomId(),
      config,
      hostId,
      state: "waiting",
      players: [{ playerId: hostId, nickname, socketId: socket?.id ?? null, connected: !!socket }],
      match: null,
    };
    this.rooms.set(room.roomId, room);
    if (socket) {
      socket.join(room.roomId);
      socket.data.roomId = room.roomId;
    }
    return room;
  }

  /** room:create (소켓 경유) — 생성자가 방장 */
  createSocket(socket: GameSocket, body: unknown): Ack<{ room: RoomDetail }> {
    const pid = socket.data.playerId;
    if (!pid) return { ok: false, error: "먼저 lobby:hello 를 보내세요" };
    const cfg = this.sanitizeConfig(body);
    if (typeof cfg === "string") return { ok: false, error: cfg };
    this.leaveSocket(socket); // 기존 방이 있으면 나가고 새 방 생성
    const room = this.instantiateRoom(pid, this.nicknames.get(pid) ?? "게스트", cfg, socket);
    this.broadcastLobby(); // 새 방을 로비에 즉시 노출
    return { ok: true, data: { room: this.toDetail(room) } };
  }

  /** POST /api/rooms — 소켓 미접속 상태의 방 생성 (실입장은 socket room:join 으로 재접속) */
  restCreate(body: unknown): Ack<{ room: RoomDetail }> {
    const b = (body ?? {}) as Record<string, unknown>;
    const nick = validateNickname(b.nickname ?? "게스트");
    if (!nick) return { ok: false, error: "닉네임은 1~12자여야 합니다" };
    const cfg = this.sanitizeConfig(body);
    if (typeof cfg === "string") return { ok: false, error: cfg };
    const pid = typeof b.playerId === "string" && b.playerId ? b.playerId : "p-" + randomUUID();
    this.nicknames.set(pid, nick);
    const room = this.instantiateRoom(pid, nick, cfg, null);
    this.broadcastLobby(); // REST 로 만든 방도 로비에 즉시 노출
    return { ok: true, data: { room: this.toDetail(room) } };
  }

  /** room:list — 공개방 + 비공개방 모두 목록에 노출 (비공개는 hasPassword=true, FEATURE_SPEC 2.2) */
  list(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => this.toSummary(r));
  }

  /** 입장 가능 여부만 검증 (REST POST /api/rooms/:id/join 용) — 에러 코드 또는 null */
  validateJoin(roomId: string, password?: unknown): "notFound" | "playing" | "full" | "badPassword" | null {
    const room = this.rooms.get(roomId);
    if (!room) return "notFound";
    if (room.state !== "waiting") return "playing"; // 진행 중 입장 불가
    if (room.players.length >= room.config.maxPlayers) return "full";
    if (room.config.visibility === "private" && room.config.password !== password) return "badPassword";
    return null;
  }

  /** room:join — notFound/full/playing/badPassword 처리, 성공 시 socket join + 전원 room:update */
  joinSocket(socket: GameSocket, p: { roomId?: string; password?: string } | undefined): Ack<{ room: RoomDetail }> {
    const pid = socket.data.playerId;
    if (!pid) return { ok: false, error: "먼저 lobby:hello 를 보내세요" };
    const room = this.rooms.get(p?.roomId ?? "");
    if (!room) return { ok: false, error: "notFound" };

    // 이미 이 방의 멤버면(대기 중 재입장 등) 소켓만 재부착
    const existing = room.players.find((pl) => pl.playerId === pid);
    if (existing && room.state === "waiting") {
      existing.socketId = socket.id;
      existing.connected = true;
      existing.nickname = this.nicknames.get(pid) ?? existing.nickname;
      socket.join(room.roomId);
      socket.data.roomId = room.roomId;
      this.broadcastRoom(room);
      return { ok: true, data: { room: this.toDetail(room) } };
    }

    const err = this.validateJoin(room.roomId, p?.password);
    if (err) return { ok: false, error: err };

    this.leaveSocket(socket); // 다른 방에 있었으면 먼저 퇴장
    room.players.push({ playerId: pid, nickname: this.nicknames.get(pid) ?? "게스트", socketId: socket.id, connected: true });
    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    this.broadcastRoom(room);
    return { ok: true, data: { room: this.toDetail(room) } };
  }

  // ── 퇴장/접속 종료 ─────────────────────────────────────────

  /** room:leave — 명시적 퇴장 */
  leaveSocket(socket: GameSocket): void {
    const rid = socket.data.roomId;
    const pid = socket.data.playerId;
    socket.data.roomId = undefined;
    if (!rid || !pid) return;
    socket.leave(rid);
    const room = this.rooms.get(rid);
    if (room) this.removeFromRoom(room, pid);
  }

  /** disconnect — 대기 중이면 제거, 게임 중이면 connected=false 마킹만 (재접속 미지원) */
  onDisconnect(socket: GameSocket): void {
    const rid = socket.data.roomId;
    const pid = socket.data.playerId;
    if (!rid || !pid) return;
    const room = this.rooms.get(rid);
    if (room) this.removeFromRoom(room, pid);
  }

  private removeFromRoom(room: Room, playerId: string): void {
    if (room.state === "waiting" || room.state === "ended") {
      room.players = room.players.filter((pl) => pl.playerId !== playerId);
      if (room.players.length === 0) {
        this.deleteRoom(room, "모든 플레이어가 나갔습니다");
        return;
      }
      // 방장 승계: 다음 입장자 (가정 — FEATURE_SPEC Open Issue 6)
      if (room.hostId === playerId) room.hostId = room.players[0].playerId;
      this.broadcastRoom(room);
      return;
    }
    // 게임 중(playing/finishing): connected=false 마킹만 하고 보드·매치 유지 (매치 종료 시 정리)
    const pl = room.players.find((x) => x.playerId === playerId);
    if (pl) {
      pl.connected = false;
      pl.socketId = null;
    }
    // 전원 이탈 시 매치 중단 + 방 삭제
    if (room.players.every((x) => !x.connected)) {
      room.match?.dispose();
      room.match = null;
      this.deleteRoom(room, "모든 플레이어가 이탈했습니다");
      return;
    }
    // 일부만 이탈: 이탈자를 매치 종료조건(abandoned)에 반영 — UP 등 타이머 없는 모드에서
    // "한 명 stuck + 다른 한 명 이탈" 시 종료조건이 재평가되지 않아 영구 대기하던 문제를 해소.
    // 종료조건을 채우면 endMatch→onMatchEnded 가 방을 정리한다(그 경우 아래 broadcast 는 no-op 수준).
    room.match?.markAbandoned(playerId);
    this.broadcastRoom(room);
  }

  private deleteRoom(room: Room, reason: string): void {
    room.match?.dispose();
    this.io.to(room.roomId).emit("room:closed", { reason });
    this.io.in(room.roomId).socketsLeave(room.roomId);
    this.rooms.delete(room.roomId);
    this.broadcastLobby(); // 삭제된 방을 로비에서 즉시 제거
  }

  // ── 설정/시작 ──────────────────────────────────────────────

  /** room:config — 방장만(notHost), waiting 상태에서만 */
  configSocket(
    socket: GameSocket,
    patch: Partial<Pick<RoomConfig, "game" | "mapMode" | "difficulty" | "theme">> | undefined
  ): Ack<{ room: RoomDetail }> {
    const ctx = this.roomOf(socket);
    if (!ctx) return { ok: false, error: "참가 중인 방이 없습니다" };
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) return { ok: false, error: "notHost" };
    if (room.state !== "waiting") return { ok: false, error: "playing" };
    const p = (patch ?? {}) as Record<string, unknown>;
    if (p.game !== undefined) {
      const game = GAME_SELS.find((g) => g === p.game);
      if (!game) return { ok: false, error: "알 수 없는 카드 세트입니다" };
      room.config.game = game;
    }
    if (p.mapMode !== undefined) {
      const mode = MODE_KEYS.find((m) => m === p.mapMode);
      if (!mode) return { ok: false, error: "알 수 없는 맵 모드입니다" };
      room.config.mapMode = mode;
    }
    if (p.difficulty !== undefined) {
      const diff = DIFF_KEYS.find((d) => d === p.difficulty);
      if (!diff) return { ok: false, error: "알 수 없는 난이도입니다" };
      room.config.difficulty = diff;
    }
    if (p.theme !== undefined) {
      // hasOwnProperty 로 검사 — "in" 은 "constructor" 등 프로토타입 키를 통과시킨다.
      if (typeof p.theme !== "string" || !Object.prototype.hasOwnProperty.call(MAP_THEMES, p.theme))
        return { ok: false, error: "알 수 없는 맵 테마입니다" };
      room.config.theme = p.theme;
    }
    this.broadcastRoom(room);
    return { ok: true, data: { room: this.toDetail(room) } };
  }

  /** game:start — 방장만, waiting 에서만. 동일 seed 보드로 매치 시작. */
  startSocket(socket: GameSocket): Ack<Record<string, never>> {
    const ctx = this.roomOf(socket);
    if (!ctx) return { ok: false, error: "참가 중인 방이 없습니다" };
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) return { ok: false, error: "notHost" };
    if (room.state !== "waiting") return { ok: false, error: "playing" };
    // 보드 생성(generateBoard)이 throw 할 수 있으므로 Match 를 먼저 만들고, 성공한 뒤에만 상태를 커밋한다.
    // (실패 시 room.state 를 playing 으로 바꾸지 않아 방 벽돌화·ack 무응답을 방지.)
    let match: Match;
    try {
      match = new Match(room, this.pool.cardsFor(room.config.game), {
        io: this.io,
        dex: this.dex,
        finishGraceMs: this.finishGraceMs,
        countdownStepMs: this.countdownStepMs,
        onEnded: () => this.onMatchEnded(room),
      });
    } catch (e) {
      console.error("[rooms] 보드 생성 실패:", e);
      return { ok: false, error: "보드 생성에 실패했습니다" };
    }
    for (const pl of room.players) pl.finishedRank = undefined;
    room.state = "playing";
    room.match = match;
    this.broadcastRoom(room);
    match.start();
    return { ok: true, data: {} };
  }

  /** 매치 종료 후처리: ended → waiting 복귀(재플레이 가능, 인원 유지), 게임 중 이탈자 정리 */
  private onMatchEnded(room: Room): void {
    room.match = null;
    room.players = room.players.filter((pl) => pl.connected);
    if (room.players.length === 0) {
      this.deleteRoom(room, "매치 종료 후 남은 플레이어가 없습니다");
      return;
    }
    if (!room.players.some((pl) => pl.playerId === room.hostId)) room.hostId = room.players[0].playerId;
    room.state = "waiting";
    this.broadcastRoom(room);
  }

  // ── 인게임 이벤트 라우팅 ───────────────────────────────────

  /** 진행 중 매치 컨텍스트 (tile:match/item:use/combo:power 라우팅용) */
  matchContext(socket: GameSocket): { match: Match; playerId: string } | null {
    const ctx = this.roomOf(socket);
    if (!ctx) return null;
    const { room, playerId } = ctx;
    if (!room.match || room.match.ended) return null;
    return { match: room.match, playerId };
  }

  // ── 조회/직렬화 ────────────────────────────────────────────

  private roomOf(socket: GameSocket): { room: Room; playerId: string } | null {
    const rid = socket.data.roomId;
    const pid = socket.data.playerId;
    if (!rid || !pid) return null;
    const room = this.rooms.get(rid);
    if (!room) return null;
    return { room, playerId: pid };
  }

  private toSummary(room: Room): RoomSummary {
    const host = room.players.find((pl) => pl.playerId === room.hostId);
    return {
      roomId: room.roomId,
      name: room.config.name,
      hostNickname: host?.nickname ?? "",
      visibility: room.config.visibility,
      hasPassword: !!room.config.password, // 비밀번호 자체는 절대 노출하지 않음
      maxPlayers: room.config.maxPlayers,
      playerCount: room.players.length,
      state: room.state,
      game: room.config.game,
      mapMode: room.config.mapMode,
      difficulty: room.config.difficulty,
      ...(room.config.theme ? { theme: room.config.theme } : {}),
    };
  }

  toDetail(room: Room): RoomDetail {
    const players: PlayerPublic[] = room.players.map((pl) => {
      const prog = room.match && !room.match.ended ? room.match.progressOf(pl.playerId) : null;
      return {
        playerId: pl.playerId,
        nickname: pl.nickname,
        isHost: pl.playerId === room.hostId,
        connected: pl.connected,
        remaining: prog?.remaining ?? 0,
        score: prog?.score ?? 0,
        combo: prog?.combo ?? 0,
        ...(pl.finishedRank !== undefined ? { finishedRank: pl.finishedRank } : {}),
      };
    });
    return { ...this.toSummary(room), players };
  }

  broadcastRoom(room: Room): void {
    this.io.to(room.roomId).emit("room:update", { room: this.toDetail(room) });
    this.broadcastLobby();
  }

  /** 로비(전체 접속자)에 방 목록 변경을 즉시 푸시 — 4초 폴링 지연 없이 실시간 반영.
   *  게임 화면 등 로비 미표시 클라이언트는 리스너가 없어 무시한다. */
  broadcastLobby(): void {
    this.io.emit("lobby:rooms", { rooms: this.list() });
  }
}
