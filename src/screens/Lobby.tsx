// F-02/F-03 대기(로비) 화면 — 방 목록 조회·입장, 방 만들기, 혼자 바로 하기, 도감·마켓 패널
import { useCallback, useEffect, useState } from "react";
import type { CardPool, MarketSnapshot } from "../../shared/cards.ts";
import { DIFFICULTIES } from "../../shared/board.ts";
import {
  MAP_MODES,
  type DifficultyKey,
  type GameSel,
  type MapMode,
  type RoomConfig,
  type RoomDetail,
  type RoomSummary,
} from "../../shared/protocol.ts";
import { getSocket } from "../net.ts";
import { diffLabel, errText, gameLabel, modeLabel, stateLabel } from "../labels.ts";

interface Props {
  nickname: string;
  pool: CardPool | null;
  market: MarketSnapshot | null;
  /** 방 입장·생성 성공 → 방(대기실) 화면으로 */
  onEnterRoom: (room: RoomDetail) => void;
  /** 혼자 바로 하기: 방 상태만 저장 (화면 전환은 board:init 수신 시) */
  onSoloRoom: (room: RoomDetail) => void;
  onDex: () => void;
  flash: (msg: string) => void;
}

// 방 만들기 폼 상태 (마지막 설정을 localStorage 에 기억)
interface DraftConfig {
  name: string;
  maxPlayers: number;
  visibility: "public" | "private";
  password: string;
  game: GameSel;
  mapMode: MapMode;
  difficulty: DifficultyKey;
}

const DRAFT_KEY = "rsk:lastRoomConfig";

function loadDraft(nickname: string): DraftConfig {
  const base: DraftConfig = {
    name: `${nickname}의 방`,
    maxPlayers: 4,
    visibility: "public",
    password: "",
    game: "mixed",
    mapMode: "normal",
    difficulty: "normal",
  };
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<DraftConfig>), name: base.name, password: "" };
  } catch {
    /* 무시 — 기본값 사용 */
  }
  return base;
}

export default function Lobby({ nickname, pool, market, onEnterRoom, onSoloRoom, onDex, flash }: Props) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<DraftConfig>(() => loadDraft(nickname));
  const [joinTarget, setJoinTarget] = useState<RoomSummary | null>(null);
  const [joinPwd, setJoinPwd] = useState("");
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── 방 목록: 주기 갱신(4초) + 수동 새로고침 ─────────────────
  const refresh = useCallback(() => {
    getSocket().emit("room:list", (r) => {
      if (r.ok && r.data) setRooms(r.data.rooms);
    });
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // ── 입장 ─────────────────────────────────────────────────────
  function join(roomId: string, password?: string) {
    setBusy(true);
    getSocket().emit("room:join", { roomId, password }, (r) => {
      setBusy(false);
      if (r.ok && r.data) {
        setJoinTarget(null);
        setJoinPwd("");
        setJoinErr(null);
        onEnterRoom(r.data.room);
      } else if (joinTarget) {
        setJoinErr(errText(r.error));
      } else {
        flash(errText(r.error));
        refresh();
      }
    });
  }

  function onJoinClick(rm: RoomSummary) {
    if (rm.hasPassword) {
      setJoinTarget(rm);
      setJoinPwd("");
      setJoinErr(null);
    } else {
      join(rm.roomId);
    }
  }

  // ── 방 만들기 ────────────────────────────────────────────────
  function saveDraft(d: DraftConfig) {
    setDraft(d);
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ maxPlayers: d.maxPlayers, visibility: d.visibility, game: d.game, mapMode: d.mapMode, difficulty: d.difficulty })
      );
    } catch {
      /* 저장 실패 무시 */
    }
  }

  function buildConfig(d: DraftConfig): RoomConfig {
    return {
      name: d.name.trim() || `${nickname}의 방`,
      visibility: d.visibility,
      ...(d.visibility === "private" && d.password ? { password: d.password } : {}),
      maxPlayers: d.maxPlayers,
      game: d.game,
      mapMode: d.mapMode,
      difficulty: d.difficulty,
    };
  }

  function createRoom() {
    if (busy) return;
    setBusy(true);
    getSocket().emit("room:create", buildConfig(draft), (r) => {
      setBusy(false);
      if (r.ok && r.data) {
        setCreateOpen(false);
        onEnterRoom(r.data.room);
      } else {
        flash(errText(r.error));
      }
    });
  }

  // ── 혼자 바로 하기: 1인 방 생성 → 즉시 game:start ────
  // 서버 계약상 비공개(private) 방은 비밀번호가 필수이므로(rooms.ts sanitizeConfig),
  // 솔로는 공개(public) 방으로 만든다. maxPlayers:1 이라 정원이 즉시 차서 남이 입장할 수 없다.
  function soloPlay() {
    if (busy) return;
    setBusy(true);
    const cfg: RoomConfig = {
      name: `${nickname}의 싱글 플레이`,
      visibility: "public",
      maxPlayers: 1,
      game: draft.game,
      mapMode: draft.mapMode,
      difficulty: draft.difficulty,
    };
    getSocket().emit("room:create", cfg, (r) => {
      if (!r.ok || !r.data) {
        setBusy(false);
        flash(errText(r.error));
        return;
      }
      const room = r.data.room;
      onSoloRoom(room);
      getSocket().emit("game:start", (r2) => {
        setBusy(false);
        if (!r2.ok) {
          flash(errText(r2.error));
          onEnterRoom(room); // 시작 실패 시 방 화면에서 재시도
        }
      });
    });
  }

  const canJoin = (rm: RoomSummary) => rm.state === "waiting" && rm.playerCount < rm.maxPlayers;

  return (
    <>
      <section className="lobby-top">
        <div className="lobby-hello">
          <b>{nickname}</b>님, 환영합니다 — 방에 들어가거나 새 방을 만들어 보세요.
        </div>
        <div className="lobby-actions">
          <button className="btn primary" onClick={() => setCreateOpen(true)}>＋ 방 만들기</button>
          <button className="btn" onClick={soloPlay} disabled={busy}>⚡ 혼자 바로 하기</button>
          <button className="ghost" onClick={onDex}>📖 카드 도감</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>
            방 목록{" "}
            <span className="muted">{rooms ? `(${rooms.length})` : ""}</span>
          </h2>
          <button className="ghost" onClick={refresh}>🔄 새로고침</button>
        </div>
        {rooms === null && <p className="muted">방 목록을 불러오는 중…</p>}
        {rooms !== null && rooms.length === 0 && (
          <div className="empty-rooms">
            아직 열린 방이 없어요. <b>방 만들기</b>로 첫 방을 열거나 <b>혼자 바로 하기</b>로 시작해 보세요.
          </div>
        )}
        {rooms !== null && rooms.length > 0 && (
          <div className="room-list">
            {rooms.map((rm) => (
              <div key={rm.roomId} className="room-item">
                <div className="room-title">
                  <span className="room-name">
                    {rm.hasPassword && <span title="비밀번호 방">🔒 </span>}
                    {rm.name}
                  </span>
                  <span className={`state-badge ${rm.state === "waiting" ? "waiting" : "playing"}`}>
                    {stateLabel(rm.state)}
                  </span>
                </div>
                <div className="room-sub muted">
                  방장 {rm.hostNickname} · 인원 {rm.playerCount}/{rm.maxPlayers}
                </div>
                <div className="room-tags">
                  <span className="tag">{gameLabel(rm.game)}</span>
                  <span className="tag">{modeLabel(rm.mapMode)}</span>
                  <span className="tag">{diffLabel(rm.difficulty)}</span>
                </div>
                <button
                  className="btn primary room-join"
                  disabled={!canJoin(rm) || busy}
                  onClick={() => onJoinClick(rm)}
                >
                  {rm.state !== "waiting" ? "진행중" : rm.playerCount >= rm.maxPlayers ? "정원초과" : "입장"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {market && (
        <section className="panel">
          <div className="panel-head">
            <h2>마켓 · 팩 <span className="muted">(공식 CLI 스냅샷)</span></h2>
            <a className="ghost" href="https://index.renaissos.com" target="_blank" rel="noreferrer">마켓 구경하기 ↗</a>
          </div>
          <div className="packs">
            {market.packs.map((p) => (
              <div key={p.slug} className="pack">
                <strong>{p.name}</strong>
                <span className="muted">{p.author}</span>
                {p.priceUsd != null && <span className="price">팩 ${p.priceUsd.toLocaleString()}</span>}
                {p.featuredCardFmvUsd != null && (
                  <span className="muted">대표 FMV ${p.featuredCardFmvUsd.toLocaleString()}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {pool && (
        <p className="muted small">
          카드 풀 {pool.cards.length}종 (포켓몬 {pool.counts.pokemon} · 원피스 {pool.counts["one-piece"]}) —
          가격·등급은 임의 생성 없이 Renaiss OS Index 실데이터입니다.
        </p>
      )}

      {/* ── 방 만들기 모달 ── */}
      {createOpen && (
        <div className="modal-back" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>방 만들기</h3>
            <div className="mfield">
              <label>방 이름</label>
              <input
                value={draft.name}
                maxLength={24}
                onChange={(e) => saveDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="mfield">
              <label>최대 인원</label>
              <div className="seg">
                {[1, 2, 3, 4].map((n) => (
                  <button key={n} className={draft.maxPlayers === n ? "on" : ""} onClick={() => saveDraft({ ...draft, maxPlayers: n })}>
                    {n}명
                  </button>
                ))}
              </div>
            </div>
            <div className="mfield">
              <label>공개 여부</label>
              <div className="seg">
                <button className={draft.visibility === "public" ? "on" : ""} onClick={() => saveDraft({ ...draft, visibility: "public" })}>공개</button>
                <button className={draft.visibility === "private" ? "on" : ""} onClick={() => saveDraft({ ...draft, visibility: "private" })}>비공개</button>
              </div>
            </div>
            {draft.visibility === "private" && (
              <div className="mfield">
                <label>비밀번호</label>
                <input
                  type="password"
                  value={draft.password}
                  maxLength={20}
                  placeholder="비워두면 비밀번호 없음"
                  onChange={(e) => saveDraft({ ...draft, password: e.target.value })}
                />
              </div>
            )}
            <div className="mfield">
              <label>카드</label>
              <div className="seg">
                {(["pokemon", "one-piece", "mixed"] as GameSel[]).map((g) => (
                  <button key={g} className={draft.game === g ? "on" : ""} onClick={() => saveDraft({ ...draft, game: g })}>
                    {gameLabel(g)}
                  </button>
                ))}
              </div>
            </div>
            <div className="mfield">
              <label>맵 모드</label>
              <div className="mode-list">
                {MAP_MODES.map((m) => (
                  <button
                    key={m.key}
                    className={`mode-opt ${draft.mapMode === m.key ? "on" : ""}`}
                    onClick={() => saveDraft({ ...draft, mapMode: m.key })}
                  >
                    <b>{m.label}</b>
                    <span>{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="mfield">
              <label>난이도</label>
              <div className="seg">
                {DIFFICULTIES.map((d) => (
                  <button key={d.key} className={draft.difficulty === d.key ? "on" : ""} onClick={() => saveDraft({ ...draft, difficulty: d.key })}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setCreateOpen(false)}>취소</button>
              <button className="btn primary" onClick={createRoom} disabled={busy || draft.name.trim().length === 0}>
                방 만들기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 비밀번호 입력 모달 ── */}
      {joinTarget && (
        <div className="modal-back" onClick={() => setJoinTarget(null)}>
          <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
            <h3>🔒 {joinTarget.name}</h3>
            <p className="muted small">비공개 방입니다. 비밀번호를 입력하세요.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                join(joinTarget.roomId, joinPwd);
              }}
            >
              <input
                type="password"
                value={joinPwd}
                autoFocus
                placeholder="비밀번호"
                onChange={(e) => {
                  setJoinPwd(e.target.value);
                  setJoinErr(null);
                }}
              />
              {joinErr && <p className="form-error">{joinErr}</p>}
              <div className="modal-actions">
                <button type="button" className="ghost" onClick={() => setJoinTarget(null)}>취소</button>
                <button type="submit" className="btn primary" disabled={busy}>입장</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
