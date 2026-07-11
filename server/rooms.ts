// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 방 관리 (FEATURE_SPEC F-02·F-03, TECH-SPEC §3.4)
// 가정(Open Issue 6): 방장 퇴장 시 다음 입장자(입장 순서상 가장 앞 플레이어)에게 방장 승계.
// 소켓 끊김(새로고침·순단): 즉시 제거하지 않고 재접속 유예(disconnectGraceMs) 를 준다.
//   유예 중 connected=false 마킹만 하고 방·보드·매치 유지. lobby:hello 재수신 시 같은 playerId 를
//   새 소켓으로 승계(tryResume)하고 방/보드 스냅샷을 복구해 준다. 유예 만료 시에만 기존 제거 로직 실행.
// ─────────────────────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import { DIFFICULTIES } from "../shared/board.ts";
import { MAP_THEMES } from "../shared/mapThemes.ts";
import {
  DISABLED_MAP_MODES,
  MAP_MODES,
  type Ack,
  type ErrCode,
  type PlayerPublic,
  type ResumeState,
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
  graceTimer?: ReturnType<typeof setTimeout>; // disconnect 유예 타이머 (재접속 시 취소, 만료 시 제거)
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
    private timeLimitMs: number,
    private countdownStepMs: number,
    private disconnectGraceMs: number // 소켓 끊김 후 재접속 유예 (만료 시에만 방에서 제거)
  ) {}

  /** 종료 시 모든 매치 타이머 + 재접속 유예 타이머 정리 */
  dispose(): void {
    for (const room of this.rooms.values()) {
      room.match?.dispose();
      for (const pl of room.players) this.clearGrace(pl);
    }
    this.rooms.clear();
  }

  /** 재접속 유예 타이머 취소 (재접속·제거·방 삭제 시) */
  private clearGrace(pl: RoomPlayer): void {
    if (pl.graceTimer) {
      clearTimeout(pl.graceTimer);
      pl.graceTimer = undefined;
    }
  }

  // ── 로비 ───────────────────────────────────────────────────

  /**
   * lobby:hello — playerId 발급/재사용 + 유예 중 방 재접속 복구.
   * 같은 playerId 가 (유예 중이거나) 방 소속이면 새 소켓으로 승계하고 resume 데이터를 반환한다.
   */
  helloSocket(socket: GameSocket, nickname: unknown, playerId?: unknown): Ack<{ playerId: string; resume?: ResumeState }> {
    const nick = validateNickname(nickname);
    if (!nick) return { ok: false, error: "badNickname" };
    // 기존 playerId 를 제시하면 그대로 재사용 (서버 재시작 후에도 도감 연속성 유지)
    const pid =
      typeof playerId === "string" && playerId.length >= 1 && playerId.length <= 64
        ? playerId
        : "p-" + randomUUID();
    this.nicknames.set(pid, nick);
    socket.data.playerId = pid;
    const resume = this.tryResume(socket, pid);
    return { ok: true, data: { playerId: pid, ...(resume ? { resume } : {}) } };
  }

  /**
   * 재접속 복구: 이 playerId 가 소속된 방을 찾아 새 소켓으로 승계한다.
   * - 이전 소켓(중복 탭·순단 잔존)은 방 채널에서 내보내 유령 이벤트를 차단.
   * - connected=true·유예 타이머 취소·room:update 브로드캐스트.
   * - 진행 중 매치면 보드 스냅샷+진행도를, 아니면 방(RoomDetail)만 반환.
   * 소속 방이 없으면 undefined (일반 신규 로그인).
   */
  private tryResume(socket: GameSocket, playerId: string): ResumeState | undefined {
    const room = [...this.rooms.values()].find((r) => r.players.some((p) => p.playerId === playerId));
    if (!room) return undefined;
    const pl = room.players.find((p) => p.playerId === playerId)!;
    // 이전 소켓이 살아있으면(중복 접속) 방 채널에서 정리 — 유령 소켓이 계속 이벤트를 받지 않도록.
    const oldSid = pl.socketId;
    if (oldSid && oldSid !== socket.id) {
      const old = this.io.sockets.sockets.get(oldSid);
      if (old) {
        old.leave(room.roomId);
        old.data.roomId = undefined;
      }
    }
    this.clearGrace(pl);
    pl.connected = true;
    pl.socketId = socket.id;
    pl.nickname = this.nicknames.get(playerId) ?? pl.nickname;
    socket.join(room.roomId);
    socket.data.roomId = room.roomId;
    this.broadcastRoom(room);

    const resume: ResumeState = { room: this.toDetail(room) };
    if (room.match && !room.match.ended) {
      const snap = room.match.snapshotFor(playerId);
      if (snap) {
        resume.board = snap.board;
        resume.progress = snap.progress;
      }
    }
    return resume;
  }

  // ── 방 생성/목록/입장 ──────────────────────────────────────

  /** RoomConfig 검증 — 실패 시 에러 코드 반환 */
  private sanitizeConfig(body: unknown): RoomConfig | ErrCode {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < 1 || name.length > 24) return "badRoomName";
    const visibility = b.visibility === "private" ? "private" : b.visibility === "public" ? "public" : null;
    if (!visibility) return "badVisibility";
    const maxPlayers = Number(b.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 4)
      return "badMaxPlayers";
    const password = typeof b.password === "string" && b.password.length > 0 ? b.password : undefined;
    if (visibility === "private" && !password) return "passwordRequired";
    const game = GAME_SELS.find((g) => g === b.game);
    if (!game) return "unknownGame";
    const mapMode = MODE_KEYS.find((m) => m === b.mapMode);
    if (!mapMode) return "unknownMapMode";
    if (DISABLED_MAP_MODES.includes(mapMode)) return "modeDisabled";
    const difficulty = DIFF_KEYS.find((d) => d === b.difficulty);
    if (!difficulty) return "unknownDifficulty";
    let theme: string | undefined;
    if (b.theme !== undefined) {
      // hasOwnProperty 로 검사 — "in" 은 "constructor" 등 프로토타입 키를 통과시킨다.
      if (typeof b.theme !== "string" || !Object.prototype.hasOwnProperty.call(MAP_THEMES, b.theme))
        return "unknownTheme";
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
    if (!pid) return { ok: false, error: "helloRequired" };
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
    if (!nick) return { ok: false, error: "badNickname" };
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
    if (!pid) return { ok: false, error: "helloRequired" };
    const room = this.rooms.get(p?.roomId ?? "");
    if (!room) return { ok: false, error: "notFound" };

    // 이미 이 방의 멤버면(대기 중 재입장 등) 소켓만 재부착
    const existing = room.players.find((pl) => pl.playerId === pid);
    if (existing && room.state === "waiting") {
      this.clearGrace(existing); // 유예 중이었다면 취소 (만료 제거 방지)
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

  /**
   * disconnect — 즉시 제거하지 않고 재접속 유예(disconnectGraceMs) 를 준다.
   * connected=false 마킹 + 유예 타이머만 걸고, 만료 시에만 기존 제거 로직(removeFromRoom)을 실행한다.
   * 방장 새로고침으로 방이 즉시 닫히지 않게 하고, 게임 중 순단·새로고침도 재접속으로 복구 가능하게 한다.
   */
  onDisconnect(socket: GameSocket): void {
    const rid = socket.data.roomId;
    const pid = socket.data.playerId;
    if (!rid || !pid) return;
    const room = this.rooms.get(rid);
    if (!room) return;
    const pl = room.players.find((x) => x.playerId === pid);
    if (!pl) return;
    // 이 소켓이 이미 다른 소켓으로 승계됐으면(재접속·중복 탭) 유령 소켓의 disconnect 는 무시.
    if (pl.socketId && pl.socketId !== socket.id) return;
    pl.connected = false;
    pl.socketId = null;
    this.broadcastRoom(room);
    this.clearGrace(pl);
    pl.graceTimer = setTimeout(() => {
      pl.graceTimer = undefined;
      // 만료 시점에 방이 이미 삭제/교체됐거나 재접속했으면 스킵.
      if (this.rooms.get(room.roomId) !== room || pl.connected) return;
      this.removeFromRoom(room, pid);
    }, this.disconnectGraceMs);
  }

  private removeFromRoom(room: Room, playerId: string): void {
    if (room.state === "waiting" || room.state === "ended") {
      // 방어적: 제거 대상이 유예 타이머를 들고 있었다면 정리(향후 호출 경로 추가 시 누수 방지 불변식).
      const leaving = room.players.find((pl) => pl.playerId === playerId);
      if (leaving) this.clearGrace(leaving);
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
    // 전원 이탈 시 매치 중단 + 방 삭제 — 단 아직 유예(재접속 대기) 중인 플레이어가 있으면 보류.
    // (양쪽이 거의 동시에 새로고침해도, 유예가 남은 상대가 돌아올 여지를 남긴다.)
    if (room.players.every((x) => !x.connected) && room.players.every((x) => !x.graceTimer)) {
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
    for (const pl of room.players) this.clearGrace(pl); // 유예 타이머 누수 방지
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
    if (!ctx) return { ok: false, error: "notInRoom" };
    const { room, playerId } = ctx;
    if (room.hostId !== playerId) return { ok: false, error: "notHost" };
    if (room.state !== "waiting") return { ok: false, error: "playing" };
    const p = (patch ?? {}) as Record<string, unknown>;
    if (p.game !== undefined) {
      const game = GAME_SELS.find((g) => g === p.game);
      if (!game) return { ok: false, error: "unknownGame" };
      room.config.game = game;
    }
    if (p.mapMode !== undefined) {
      const mode = MODE_KEYS.find((m) => m === p.mapMode);
      if (!mode) return { ok: false, error: "unknownMapMode" };
      if (DISABLED_MAP_MODES.includes(mode)) return { ok: false, error: "modeDisabled" };
      room.config.mapMode = mode;
    }
    if (p.difficulty !== undefined) {
      const diff = DIFF_KEYS.find((d) => d === p.difficulty);
      if (!diff) return { ok: false, error: "unknownDifficulty" };
      room.config.difficulty = diff;
    }
    if (p.theme !== undefined) {
      // hasOwnProperty 로 검사 — "in" 은 "constructor" 등 프로토타입 키를 통과시킨다.
      if (typeof p.theme !== "string" || !Object.prototype.hasOwnProperty.call(MAP_THEMES, p.theme))
        return { ok: false, error: "unknownTheme" };
      room.config.theme = p.theme;
    }
    this.broadcastRoom(room);
    return { ok: true, data: { room: this.toDetail(room) } };
  }

  /** game:start — 방장만, waiting 에서만. 동일 seed 보드로 매치 시작. */
  startSocket(socket: GameSocket): Ack<Record<string, never>> {
    const ctx = this.roomOf(socket);
    if (!ctx) return { ok: false, error: "notInRoom" };
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
        timeLimitMs: this.timeLimitMs,
        countdownStepMs: this.countdownStepMs,
        onEnded: () => this.onMatchEnded(room),
      });
    } catch (e) {
      console.error("[rooms] 보드 생성 실패:", e);
      return { ok: false, error: "boardGenerationFailed" };
    }
    for (const pl of room.players) pl.finishedRank = undefined;
    room.state = "playing";
    room.match = match;
    this.broadcastRoom(room);
    match.start();
    return { ok: true, data: {} };
  }

  /** 매치 종료 후처리: ended → waiting 복귀(재플레이 가능, 인원 유지), 게임 중 이탈자 정리.
   *  유예 중(재접속 대기)인 이탈자는 남겨 둔다 — 재접속 시 waiting 방으로 복귀시키기 위함. */
  private onMatchEnded(room: Room): void {
    room.match = null;
    room.players = room.players.filter((pl) => pl.connected || pl.graceTimer);
    if (room.players.length === 0) {
      this.deleteRoom(room, "매치 종료 후 남은 플레이어가 없습니다");
      return;
    }
    // 방장 승계: 방장이 아예 없거나(퇴장) 유예 중(끊김, connected=false)이면 접속 중인 다음
    // 플레이어에게 이양 — 그렇지 않으면 남은 플레이어가 game:start 시 notHost 로 막혀 재시작 불가.
    // 접속 중인 플레이어가 없으면(전원 유예) 이양하지 않고 유지 — 재접속 시 원래 방장 그대로 복귀.
    const hostPlayer = room.players.find((pl) => pl.playerId === room.hostId);
    if (!hostPlayer || !hostPlayer.connected) {
      const nextHost = room.players.find((pl) => pl.connected);
      if (nextHost) room.hostId = nextHost.playerId;
    }
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
