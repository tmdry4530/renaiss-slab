// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 매치 진행 (서버 권위, TECH-SPEC §2·§3.4)
// - 개인전: 매치 시작 시 seed 하나를 생성하고, 모든 플레이어가 동일 seed 로
//   생성된 동일 보드를 각자 푼다. 진행도는 player:progress 로 방 전체에 공유.
// - 보드 배치·짝 판정·점수·콤보·아이템 효과는 전부 서버가 계산한다 (shared 엔진 사용).
// - 게임 중 이탈자는 rooms.ts 에서 connected=false 마킹만 하고 매치는 계속 진행,
//   매치 종료 시 정리한다. 게임 중 재접속(보드 복구)은 미지원 — 데모 범위 단순화 가정.
// ─────────────────────────────────────────────────────────────
import {
  findHint,
  generateBoard,
  hasMove,
  reshuffle,
  rollRight,
  toTileStates,
  upRise,
  validateMatch,
  type Board,
  type Tile,
} from "../shared/board.ts";
import { applyComboPower, ComboTracker } from "../shared/combo.ts";
import { maskForTheme } from "../shared/mapThemes.ts";
import { finalScore, matchScore, rankPlayers, xpFor, type RankInput } from "../shared/score.ts";
import {
  COUNTDOWN_STEPS,
  ITEM_QUOTA,
  ROLLING_INTERVAL_MS,
  type Ack,
  type BoardPatch,
  type ComboPower,
  type ItemType,
  type PlayerSummary,
} from "../shared/protocol.ts";
import type { GameCard } from "../shared/cards.ts";
import type { DexStore } from "./dex.ts";
import type { Room } from "./rooms.ts";
import type { IO } from "./types.ts";

export interface MatchDeps {
  io: IO;
  dex: DexStore;
  finishGraceMs: number; // 1위 확정 후 유예 (테스트에서 짧게 주입 가능)
  countdownStepMs: number; // 3-2-1 카운트다운 스텝 간격 (테스트에서 짧게 주입 가능)
  onEnded: () => void; // 매치 종료 후처리 (방 waiting 복귀 등 — RoomManager 담당)
}

/** 플레이어별 매치 상태 */
interface PState {
  board: Board;
  combo: ComboTracker;
  score: number;
  items: Record<ItemType, number>; // 남은 아이템 (서치3/섞기3/가위1)
  cleared: boolean;
  stuck: boolean; // UP 모드: 예비 줄 소진/최상단 도달 + 교착으로 더 진행 불가 (클리어 불가 확정)
  clearTimeMs: number;
  met: Map<string, { card: GameCard; count: number }>; // 이번 판 제거 카드 집계 (짝 단위)
  dexNewly: GameCard[]; // 이번 판으로 도감에 새로 등록된 카드
  pendingPower: ComboPower | null; // 발동 대기 중 콤보 파워 (미사용 시 다음 파워로 대체)
}

export class Match {
  readonly seed: number;
  ended = false;
  private startedAt = Date.now();
  private states = new Map<string, PState>();
  private rollingTimer: ReturnType<typeof setInterval> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;
  private finishingAnnounced = false;
  private clearOrder = 0; // 클리어 시각 순 순번

  constructor(private room: Room, poolCards: GameCard[], private deps: MatchDeps) {
    // 매치당 seed 하나 — 전 플레이어 동일 보드 (개인전: 같은 보드를 각자 풂)
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    // 맵 프리셋 테마가 선택돼 있으면 그 테마에 배정된 마스크를 강제(이름↔디자인 일치, 스펙 A).
    // 미선택 시 undefined → generateBoard 의 기존 랜덤/모드별 기본 로직 그대로 사용(회귀 없음).
    const themedMask = maskForTheme(room.config.theme);
    for (const pl of room.players) {
      const board = generateBoard(poolCards, room.config.difficulty, this.seed, {
        mapMode: room.config.mapMode,
        ...(themedMask ? { mask: themedMask } : {}),
      });
      this.states.set(pl.playerId, {
        board,
        combo: new ComboTracker(),
        score: 0,
        items: { ...ITEM_QUOTA },
        cleared: false,
        stuck: false,
        clearTimeMs: 0,
        met: new Map(),
        dexNewly: [],
        pendingPower: null,
      });
    }
  }

  /** game:start 직후: 3→2→1 카운트다운 emit 후 board:init 전송(플레이 피드백 — 시작 연출) */
  start(): void {
    this.runCountdown(COUNTDOWN_STEPS);
  }

  private runCountdown(remaining: number): void {
    if (remaining <= 0) {
      this.countdownTimer = null;
      this.beginBoard();
      return;
    }
    this.deps.io.to(this.room.roomId).emit("game:countdown", { seconds: remaining });
    this.countdownTimer = setTimeout(() => this.runCountdown(remaining - 1), this.deps.countdownStepMs);
  }

  /** 각자에게 board:init 전송 + 모드별 타이머 기동 */
  private beginBoard(): void {
    for (const pl of this.room.players) {
      const st = this.states.get(pl.playerId);
      const sid = this.sockOf(pl.playerId);
      if (!st || !sid) continue;
      this.deps.io.to(sid).emit("board:init", {
        rows: st.board.rows,
        cols: st.board.cols,
        mapMode: st.board.mapMode,
        difficulty: st.board.difficulty,
        seed: this.seed,
        cards: st.board.cards,
        tiles: toTileStates(st.board),
        ...(this.room.config.mapMode === "up" ? { reserveRows: st.board.reserve.length } : {}),
        ...(this.room.config.theme ? { theme: this.room.config.theme } : {}),
      });
    }
    // 롤링 모드: ROLLING_INTERVAL_MS 마다 각 플레이어 보드 바깥 테두리를 시계방향 회전
    if (this.room.config.mapMode === "rolling") {
      this.rollingTimer = setInterval(() => this.tickRolling(), ROLLING_INTERVAL_MS);
    }
    // UP 모드: 연속 타이머 상승 폐지 — 상승은 '교착(연결 가능한 짝 0)'일 때만.
    // 게임 시작 직후 교착 검사(생성이 최소 한 수를 보장하므로 통상 no-op, 방어적).
    if (this.room.config.mapMode === "up") {
      for (const pl of this.room.players) {
        const st = this.states.get(pl.playerId);
        if (st && st.board.tiles.some((t) => !t.removed) && !hasMove(st.board)) {
          this.handleUpDeadlock(pl.playerId, st);
        }
      }
    }
  }

  /** 타이머 정리 (finishing/ended/방 삭제 시) */
  dispose(): void {
    if (this.rollingTimer) {
      clearInterval(this.rollingTimer);
      this.rollingTimer = null;
    }
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  /** 미니뷰용 진행도 (RoomDetail 채움) */
  progressOf(playerId: string): { remaining: number; score: number; combo: number } | null {
    const st = this.states.get(playerId);
    if (!st) return null;
    return {
      remaining: st.board.tiles.filter((t) => !t.removed).length,
      score: st.score,
      combo: st.combo.combo,
    };
  }

  /** 해당 플레이어의 현재 소켓 ID (미접속이면 null) */
  private sockOf(playerId: string): string | null {
    return this.room.players.find((pl) => pl.playerId === playerId)?.socketId ?? null;
  }

  // ── 이벤트 핸들러 ──────────────────────────────────────────

  /** tile:match — shared 엔진 validateMatch 로 서버 권위 검증 */
  handleTileMatch(
    playerId: string,
    p: { tileA: number; tileB: number },
    ack?: (r: Ack<Record<string, never>>) => void
  ): void {
    const st = this.guard(playerId, ack);
    if (!st) return;
    const res = validateMatch(st.board, p?.tileA ?? -1, p?.tileB ?? -1);
    if (!res.ok) {
      // 매칭 실패 → 콤보 0 리셋 (FEATURE_SPEC Open Issue 4 — 실패 시 리셋 가정, shared/combo.ts 참조)
      st.combo.onFail();
      const sid = this.sockOf(playerId);
      if (sid) this.deps.io.to(sid).emit("tile:rejected", { reason: res.reason });
      this.broadcastProgress(playerId, st);
      ack?.({ ok: false, error: res.reason });
      return;
    }
    const [a, b] = res.tiles;
    a.removed = true;
    b.removed = true;
    const { combo, power } = st.combo.onMatch(Date.now());
    const scoreDelta = matchScore(combo);
    st.score += scoreDelta;
    if (power) st.pendingPower = power; // 미사용 파워는 다음 파워로 대체
    const unlocked = this.registerRemoval(playerId, st, a.card, 1);
    const sid = this.sockOf(playerId);
    if (sid) {
      this.deps.io.to(sid).emit("tile:matched", {
        tileA: a.tileId,
        tileB: b.tileId,
        path: res.path,
        scoreDelta,
        combo,
        ...(power ? { comboPower: power } : {}),
        ...(unlocked.length ? { dexUnlocked: unlocked } : {}),
      });
    }
    this.afterRemoval(playerId, st, [a, b]);
    ack?.({ ok: true, data: {} });
  }

  /** combo:power — 대기 중 파워를 지정 카드에 적용 (경로 판정 무시, shared applyComboPower) */
  handleComboPower(
    playerId: string,
    p: { cardId: string },
    ack: (r: Ack<Record<string, never>>) => void
  ): void {
    const st = this.guard(playerId, ack);
    if (!st) return;
    if (!st.pendingPower) {
      ack({ ok: false, error: "발동 대기 중인 콤보 파워가 없습니다" });
      return;
    }
    const cardId = p?.cardId ?? "";
    // 승리 "승" 카드는 콤보 파워 대상에서 제외 — 경로 매칭으로만 승리하도록(플레이 피드백).
    // 파워는 유지되어 다른 카드를 다시 지정할 수 있다.
    if (cardId === "__victory__") {
      ack({ ok: false, error: "승리 카드는 콤보 파워로 제거할 수 없습니다" });
      return;
    }
    const removedIds = applyComboPower(st.board, cardId, st.pendingPower.kind);
    if (removedIds.length === 0) {
      // 대상이 없으면 파워는 유지 — 다른 카드를 다시 지정할 수 있다
      ack({ ok: false, error: "제거할 대상이 없습니다" });
      return;
    }
    st.pendingPower = null;
    const removedTiles = st.board.tiles.filter((t) => removedIds.includes(t.tileId));
    const pairs = Math.floor(removedIds.length / 2);
    // 콤보 파워 제거분 점수: 짝당 기본 점수 (콤보 보너스 없음 — 임의 결정)
    st.score += pairs * matchScore(0);
    const card = st.board.cards.find((c) => c.cardId === cardId);
    if (card && pairs > 0) this.registerRemoval(playerId, st, card, pairs);
    this.emitBoard(playerId, st, "combo");
    this.afterRemoval(playerId, st, removedTiles);
    ack({ ok: true, data: {} });
  }

  /**
   * item:use — 서치/섞기/가위. 사용 수신 시점에 소모 확정(클라 낙관적 즉시 차감과 정합).
   * 모든 ack 에 서버 권위 잔량 items 를 실어 최종 동기화(이중 차감 방지). 가위는 유효 대상일 때만 소모.
   */
  handleItemUse(
    playerId: string,
    p: { type: ItemType; tiles?: [number, number] },
    ack: (r: Ack<{ highlight?: [number, number]; items?: Record<ItemType, number> }>) => void
  ): void {
    const st = this.guard(playerId, ack);
    if (!st) return;
    const type = p?.type;
    if (type !== "search" && type !== "shuffle" && type !== "scissor") {
      ack({ ok: false, error: "알 수 없는 아이템입니다", data: { items: { ...st.items } } });
      return;
    }
    if (st.items[type] <= 0) {
      ack({ ok: false, error: "아이템을 모두 사용했습니다", data: { items: { ...st.items } } });
      return;
    }

    if (type === "search") {
      // 서치: 사용 수신 즉시 소모 + 매칭 가능한 짝 1쌍 반환 (본인 ack 만)
      st.items.search--;
      const hint = findHint(st.board);
      ack({
        ok: !!hint,
        ...(hint ? {} : { error: "매칭 가능한 짝이 없습니다" }),
        data: {
          ...(hint ? { highlight: [hint[0].tileId, hint[1].tileId] as [number, number] } : {}),
          items: { ...st.items },
        },
      });
      return;
    }

    if (type === "shuffle") {
      // 섞기: 사용 수신 즉시 소모 + 남은 타일 재배치 (카드 종류/개수 유지)
      st.items.shuffle--;
      reshuffle(st.board);
      this.emitBoard(playerId, st, "shuffle");
      // 셔플 후에도 교착이면(희귀) UP 은 상승/종료로 해소 (교착 검사 시점)
      if (
        this.room.config.mapMode === "up" &&
        st.board.tiles.some((t) => !t.removed) &&
        !hasMove(st.board)
      ) {
        this.handleUpDeadlock(playerId, st);
      }
      ack({ ok: true, data: { items: { ...st.items } } });
      return;
    }

    // 가위: 같은 카드면 경로 검증 없이 강제 제거 (콤보 카운트 반영 — FEATURE_SPEC 2.7).
    // 무효/승리 대상은 소모하지 않고 잔량 그대로 반환 → 클라 낙관적 차감이 복구된다.
    const tiles = p?.tiles;
    if (!Array.isArray(tiles) || tiles.length !== 2) {
      ack({ ok: false, error: "가위 대상 두 타일을 지정하세요", data: { items: { ...st.items } } });
      return;
    }
    const a = st.board.tiles.find((t) => t.tileId === tiles[0]);
    const b = st.board.tiles.find((t) => t.tileId === tiles[1]);
    if (!a || !b || a === b || a.removed || b.removed) {
      ack({ ok: false, error: "대상 타일이 유효하지 않습니다", data: { items: { ...st.items } } });
      return;
    }
    if (a.matchKey !== b.matchKey) {
      ack({ ok: false, error: "같은 카드만 제거할 수 있습니다", data: { items: { ...st.items } } });
      return;
    }
    // 승리 "승" 카드는 가위 대상에서 제외 — 경로 매칭으로만 승리하도록(플레이 피드백).
    if (a.victory || b.victory) {
      ack({ ok: false, error: "승리 카드는 가위로 제거할 수 없습니다", data: { items: { ...st.items } } });
      return;
    }
    st.items.scissor--;
    a.removed = true;
    b.removed = true;
    const { combo, power } = st.combo.onMatch(Date.now());
    const scoreDelta = matchScore(combo);
    st.score += scoreDelta;
    if (power) st.pendingPower = power;
    const unlocked = this.registerRemoval(playerId, st, a.card, 1);
    const sid = this.sockOf(playerId);
    if (sid) {
      // 가위는 경로가 없으므로 path: [] 로 tile:matched 전송
      this.deps.io.to(sid).emit("tile:matched", {
        tileA: a.tileId,
        tileB: b.tileId,
        path: [],
        scoreDelta,
        combo,
        ...(power ? { comboPower: power } : {}),
        ...(unlocked.length ? { dexUnlocked: unlocked } : {}),
      });
    }
    this.afterRemoval(playerId, st, [a, b]);
    ack({ ok: true, data: { items: { ...st.items } } });
  }

  // ── 내부 로직 ──────────────────────────────────────────────

  /** 공통 가드: 매치 진행 중 + 미클리어 플레이어만 조작 가능 */
  private guard<T>(playerId: string, ack?: (r: Ack<T>) => void): PState | null {
    const st = this.states.get(playerId);
    if (!st || this.ended) {
      ack?.({ ok: false, error: "진행 중인 매치가 없습니다" });
      return null;
    }
    if (st.cleared) {
      ack?.({ ok: false, error: "이미 클리어했습니다" });
      return null;
    }
    if (st.stuck) {
      ack?.({ ok: false, error: "더 진행할 수 없습니다" });
      return null;
    }
    return st;
  }

  /** 제거 이벤트 공통 후처리: 승리 판정 → 클리어 판정 → 교착 해소(UP 상승·그 외 재셔플) → 진행도 브로드캐스트 */
  private afterRemoval(playerId: string, st: PState, removedTiles: Tile[]): void {
    if (this.ended) return;

    // 승리 모드: 승리 카드 짝을 맞춘 플레이어 즉시 1위 + 게임 즉시 종료 (유예 없음, FEATURE_SPEC 2.5)
    if (this.room.config.mapMode === "victory" && removedTiles.some((t) => t.victory)) {
      this.endMatch(playerId);
      return;
    }

    const remaining = st.board.tiles.filter((t) => !t.removed).length;
    if (remaining === 0) {
      // 클리어: 클리어 보너스 반영, 최초 클리어자면 유예 카운트다운 시작
      st.cleared = true;
      st.clearTimeMs = Date.now() - this.startedAt;
      st.score = finalScore(st.score, true);
      this.clearOrder++;
      this.broadcastProgress(playerId, st);
      if (!this.finishingAnnounced) {
        this.finishingAnnounced = true;
        this.room.state = "finishing";
        // 롤링 등 매치 타이머는 finishing 진입 시 정리 (지시 사항)
        if (this.rollingTimer) {
          clearInterval(this.rollingTimer);
          this.rollingTimer = null;
        }
        const winner = this.room.players.find((pl) => pl.playerId === playerId);
        this.deps.io.to(this.room.roomId).emit("match:finishing", {
          winnerId: playerId,
          winnerNickname: winner?.nickname ?? "",
          countdownSec: Math.round(this.deps.finishGraceMs / 1000),
        });
        this.finishTimer = setTimeout(() => this.endMatch(), this.deps.finishGraceMs);
      }
      // 유예 중 남은 전원이 클리어/종료(stuck)면 조기 종료 (무한 대기 방지)
      if ([...this.states.values()].every((s) => s.cleared || s.stuck)) this.endMatch();
      return;
    }

    // 교착(연결 가능한 짝 0) 감지 — UP 은 상승/종료로, 그 외 모드는 자동 재셔플로 해소
    if (!hasMove(st.board)) {
      if (this.room.config.mapMode === "up") {
        this.handleUpDeadlock(playerId, st); // 상승 emit·종료까지 내부 처리
        return;
      }
      reshuffle(st.board);
      this.emitBoard(playerId, st, "reshuffle");
    }

    this.broadcastProgress(playerId, st);
  }

  /**
   * UP 교착 해소: 예비 줄이 있고 상승 여지가 있으면 1줄 상승(최하단 주입 줄은 하단 테두리로 항상 연결 가능 → 교착 해소).
   * 최상단까지 차오르거나(blocked) 예비 줄 소진(empty) 상태에서 교착이면 이 플레이어는 클리어 불가로 확정한다.
   */
  private handleUpDeadlock(playerId: string, st: PState): void {
    const res = upRise(st.board);
    if (res === "ok") {
      if (!hasMove(st.board)) reshuffle(st.board); // 희귀 방어 — 주입 후에도 막히면 재셔플
      this.emitBoard(playerId, st, "up");
      this.broadcastProgress(playerId, st);
      return;
    }
    // "blocked"(최상단 도달) / "empty"(예비 줄 소진) + 교착 → 클리어 불가 확정
    this.markUpStuck(playerId, st);
  }

  /** UP: 더 상승할 수 없는 교착 → 미클리어로 확정. 남은 전원이 클리어/종료면 매치 종료(무한 대기 방지). */
  private markUpStuck(playerId: string, st: PState): void {
    if (st.cleared || st.stuck) return;
    st.stuck = true;
    this.broadcastProgress(playerId, st);
    if ([...this.states.values()].every((s) => s.cleared || s.stuck)) this.endMatch();
  }

  /** 도감·이번 판 집계 반영. 이번에 도감 등록된 cardId 목록을 반환. */
  private registerRemoval(playerId: string, st: PState, card: GameCard, pairs: number): string[] {
    // 승리 합성 카드는 실물이 아니므로 도감/집계에서 제외
    if (card.cardId === "__victory__") return [];
    const cur = st.met.get(card.cardId) ?? { card, count: 0 };
    cur.count += pairs;
    st.met.set(card.cardId, cur);
    const newly = this.deps.dex.addRemoval(playerId, card.cardId, pairs);
    if (newly) {
      st.dexNewly.push(card);
      return [card.cardId];
    }
    return [];
  }

  /** 롤링 틱: 각 플레이어 보드 우측 순환 이동 (교착 발생 시 안전장치로 재셔플) */
  private tickRolling(): void {
    if (this.ended || this.room.state !== "playing") return;
    for (const [pid, st] of this.states) {
      if (st.cleared) continue;
      rollRight(st.board);
      if (st.board.tiles.some((t) => !t.removed) && !hasMove(st.board)) {
        reshuffle(st.board);
        this.emitBoard(pid, st, "reshuffle");
      } else {
        this.emitBoard(pid, st, "rolling");
      }
    }
  }

  /** 해당 플레이어에게 보드 전체 스냅샷 패치 전송 */
  private emitBoard(playerId: string, st: PState, reason: BoardPatch["reason"]): void {
    const sid = this.sockOf(playerId);
    if (!sid) return;
    this.deps.io.to(sid).emit("board:update", {
      tiles: toTileStates(st.board),
      ...(this.room.config.mapMode === "up" ? { reserveRows: st.board.reserve.length } : {}),
      reason,
    });
  }

  /** player:progress 를 방 전체에 브로드캐스트 (상대 미니뷰) */
  private broadcastProgress(playerId: string, st: PState): void {
    this.deps.io.to(this.room.roomId).emit("player:progress", {
      playerId,
      remaining: st.board.tiles.filter((t) => !t.removed).length,
      score: st.score,
      combo: st.combo.combo,
    });
  }

  /** 매치 종료: 순위 산정(rankPlayers) + PlayerSummary 브로드캐스트. forcedWinnerId = 승리 모드 승자. */
  private endMatch(forcedWinnerId?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.dispose();
    const now = Date.now();

    if (forcedWinnerId) {
      // 승리 모드 승자: 클리어로 간주해 즉시 1위 처리 (클리어 보너스 포함 — 임의 결정).
      // 승리 모드에서는 다른 플레이어가 먼저 클리어할 수 없으므로(클리어 과정에 승리 짝 포함) 항상 1위가 된다.
      const st = this.states.get(forcedWinnerId);
      if (st && !st.cleared) {
        st.cleared = true;
        st.clearTimeMs = now - this.startedAt;
        st.score = finalScore(st.score, true);
        this.broadcastProgress(forcedWinnerId, st);
      }
    }

    const inputs: RankInput[] = this.room.players.map((pl) => {
      const st = this.states.get(pl.playerId)!;
      return {
        playerId: pl.playerId,
        nickname: pl.nickname,
        score: st.score,
        remaining: st.board.tiles.filter((t) => !t.removed).length,
        cleared: st.cleared,
        timeMs: st.cleared ? st.clearTimeMs : now - this.startedAt,
      };
    });
    // 동점 추가 룰 없음 (FEATURE_SPEC Open Issue 5) — rankPlayers 정렬 그대로 순번 부여
    const ranks = rankPlayers(inputs);

    const summaries: PlayerSummary[] = this.room.players.map((pl) => {
      const st = this.states.get(pl.playerId)!;
      const met = [...st.met.values()].sort((x, y) => y.count - x.count);
      const gradeMap = new Map<string, number>();
      for (const m of met)
        gradeMap.set(m.card.gradeLabel, (gradeMap.get(m.card.gradeLabel) ?? 0) + m.count);
      let topCard: GameCard | null = null;
      for (const m of met)
        if (!topCard || m.card.priceUsdCents > topCard.priceUsdCents) topCard = m.card;
      return {
        playerId: pl.playerId,
        xp: xpFor(st.score, st.cleared),
        metCards: met.map((m) => ({ card: m.card, count: m.count })),
        gradeDist: [...gradeMap.entries()].map(([gradeLabel, count]) => ({ gradeLabel, count })),
        topCard,
        dexNewlyRegistered: st.dexNewly,
        dexProgress: this.deps.dex.progressFor(pl.playerId),
      };
    });

    // 방 플레이어에 최종 순위 반영 (대기실 표시용)
    for (const r of ranks) {
      const pl = this.room.players.find((x) => x.playerId === r.playerId);
      if (pl) pl.finishedRank = r.rank;
    }

    this.room.state = "ended";
    this.deps.io.to(this.room.roomId).emit("match:ended", { ranks, summaries });
    // ended → waiting 복귀 (재플레이 가능, 인원 유지) — RoomManager 가 처리
    this.deps.onEnded();
  }
}
