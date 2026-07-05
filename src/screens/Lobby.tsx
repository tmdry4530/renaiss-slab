// F-02/F-03 대기(로비) 화면 — 방 목록 조회·입장, 방 만들기, 혼자 바로 하기, 프로필/통계·마켓 사이드바
import { useCallback, useEffect, useState, type CSSProperties } from "react";
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
import { diffLabel, errText, gameLabel, modeLabel } from "../labels.ts";

interface Props {
  nickname: string;
  /** 도감 달성률·레벨 조회에 사용 (/api/dex/:playerId) */
  playerId: string;
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
// 결과 화면에서 증가시키는 로컬 통계 카운터 (없으면 0)
const STAT_PLAYS_KEY = "rsk:stats:plays";
const STAT_WINS_KEY = "rsk:stats:wins";

// localStorage draft 검증용 화이트리스트 — 옛 버전의 값(예: game:"mixed")이 남아있어도
// 서버가 거부하지 않도록 유효 enum 이 아니면 기본값으로 폴백한다.
const GAME_VALUES: GameSel[] = ["pokemon", "one-piece"];
const DIFFICULTY_VALUES: DifficultyKey[] = ["easy", "normal", "hard"];
const MAP_MODE_VALUES: MapMode[] = MAP_MODES.map((m) => m.key);

function loadDraft(nickname: string): DraftConfig {
  const base: DraftConfig = {
    name: `${nickname}의 방`,
    maxPlayers: 4,
    visibility: "public",
    password: "",
    game: "pokemon",
    mapMode: "normal",
    difficulty: "normal",
  };
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DraftConfig>;
      return {
        ...base,
        ...parsed,
        name: base.name,
        password: "",
        game: GAME_VALUES.includes(parsed.game as GameSel) ? (parsed.game as GameSel) : base.game,
        mapMode: MAP_MODE_VALUES.includes(parsed.mapMode as MapMode) ? (parsed.mapMode as MapMode) : base.mapMode,
        difficulty: DIFFICULTY_VALUES.includes(parsed.difficulty as DifficultyKey)
          ? (parsed.difficulty as DifficultyKey)
          : base.difficulty,
      };
    }
  } catch {
    /* 무시 — 기본값 사용 */
  }
  return base;
}

function loadCounter(key: string): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

// mapMode 키가 .tag 변형 클래스명과 1:1 대응 (normal/rolling/up/shanghai/victory)
const modeTagClass = (m: MapMode): string => m;

export default function Lobby({ nickname, playerId, onEnterRoom, onSoloRoom, onDex, flash }: Props) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<DraftConfig>(() => loadDraft(nickname));
  const [joinTarget, setJoinTarget] = useState<RoomSummary | null>(null);
  const [joinPwd, setJoinPwd] = useState("");
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 사이드바 통계: 총 플레이·1위 횟수는 로컬 카운터, 도감%·레벨은 서버 실데이터
  const [totalPlays] = useState(() => loadCounter(STAT_PLAYS_KEY));
  const [wins] = useState(() => loadCounter(STAT_WINS_KEY));
  const [dexPct, setDexPct] = useState<number | null>(null);
  const [level, setLevel] = useState(1);

  // ── 방 목록: 주기 갱신(4초) + 수동 새로고침 ─────────────────
  const refresh = useCallback(() => {
    getSocket().emit("room:list", (r) => {
      if (r.ok && r.data) setRooms(r.data.rooms);
    });
  }, []);

  useEffect(() => {
    refresh();
    const sock = getSocket();
    // 서버 푸시로 방 생성/입장/퇴장/상태 변경을 즉시 반영. 폴링은 푸시 누락 대비 백업.
    const onRooms = (p: { rooms: RoomSummary[] }) => setRooms(p.rooms);
    sock.on("lobby:rooms", onRooms);
    const id = window.setInterval(refresh, 4000);
    return () => {
      sock.off("lobby:rooms", onRooms);
      window.clearInterval(id);
    };
  }, [refresh]);

  // ── 도감 달성률 (실데이터) + 간이 레벨 ─────────────────────────
  useEffect(() => {
    if (!playerId) return;
    let alive = true;
    fetch(`/api/dex/${playerId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.progress) return;
        const p = d.progress as {
          pokemon: { registered: number; total: number };
          "one-piece": { registered: number; total: number };
        };
        const reg = p.pokemon.registered + p["one-piece"].registered;
        const total = p.pokemon.total + p["one-piece"].total;
        setDexPct(total > 0 ? Math.round((reg / total) * 100) : 0);
        setLevel(Math.max(1, Math.floor(reg / 5) + 1)); // 도감 등록 5종당 +1
      })
      .catch(() => {
        /* 조회 실패 시 "—" 유지 */
      });
    return () => {
      alive = false;
    };
  }, [playerId]);

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

  // 방 테이블 열 정렬 (헤더·각 행 공용 그리드)
  const rowGrid: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr) 120px 150px 96px",
    gap: 12,
    alignItems: "center",
  };

  return (
    <>
      <div className="lobby-2col">
        {/* ── 좌: 방 목록 ── */}
        <main>
          <div className="toolbar">
            <button className="btn btn-ghost" onClick={refresh}>🔄 새로고침</button>
            <button className="btn btn-accent" onClick={() => setCreateOpen(true)}>＋ 방 만들기</button>
            <button className="btn btn-dark" onClick={soloPlay} disabled={busy}>⚡ 바로 시작</button>
          </div>

          {/* 테이블 헤더 */}
          <div
            className="section-label"
            style={{ ...rowGrid, borderBottom: "1px solid var(--border)", paddingBottom: 10, margin: 0 }}
          >
            <span>방 제목</span>
            <span>맵</span>
            <span>인원</span>
            <span>방장</span>
            <span />
          </div>

          {rooms === null && <p className="muted" style={{ padding: "16px 2px" }}>방 목록을 불러오는 중…</p>}
          {rooms !== null && rooms.length === 0 && (
            <p className="muted" style={{ padding: "16px 2px" }}>
              아직 열린 방이 없어요. <b>방 만들기</b>로 첫 방을 열거나 <b>바로 시작</b>으로 시작해 보세요.
            </p>
          )}

          {rooms !== null &&
            rooms.map((rm) => {
              const full = rm.playerCount >= rm.maxPlayers;
              const joinable = canJoin(rm);
              return (
                <div
                  key={rm.roomId}
                  style={{
                    ...rowGrid,
                    padding: "16px 2px",
                    borderBottom: "1px solid var(--border)",
                    opacity: joinable ? 1 : 0.55,
                  }}
                >
                  {/* 방 제목 */}
                  <span style={{ fontWeight: 700, minWidth: 0, display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {rm.hasPassword && <span title="비밀번호 방">🔒 </span>}
                      {rm.name}
                    </span>
                    {full && <span className="badge-full">FULL</span>}
                  </span>

                  {/* 맵: 모드 태그 + 난이도 + IP */}
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                    <span className={`tag ${modeTagClass(rm.mapMode)}`}>[{modeLabel(rm.mapMode)}]</span>
                    <span className={`badge-diff ${rm.difficulty}`}>{diffLabel(rm.difficulty)}</span>
                    <span className={`badge-ip ${rm.game === "pokemon" ? "pokemon" : "onepiece"}`}>
                      {gameLabel(rm.game)}
                    </span>
                  </span>

                  {/* 인원: 점 + n/max */}
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="dots">
                      {Array.from({ length: rm.maxPlayers }).map((_, i) => (
                        <i key={i} className={i < rm.playerCount ? (full ? "full" : "on") : ""} />
                      ))}
                    </span>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {rm.playerCount}/{rm.maxPlayers}
                    </span>
                  </span>

                  {/* 방장 */}
                  <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    @{rm.hostNickname}
                  </span>

                  {/* 액션 */}
                  <button
                    className={joinable ? "btn btn-blue" : "btn btn-dark"}
                    disabled={!joinable || busy}
                    onClick={() => onJoinClick(rm)}
                  >
                    {rm.state !== "waiting" ? "진행중" : full ? "정원초과" : "입장"}
                  </button>
                </div>
              );
            })}
        </main>

        {/* ── 우: 사이드바 ── */}
        <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 프로필 카드 */}
          <div>
            <div className="section-label">내 프로필</div>
            <div className="panel" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="avatar lg">🐵</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                <span
                  style={{ fontWeight: 700, fontSize: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  @{nickname}
                </span>
                <span className="chip accent" style={{ alignSelf: "flex-start" }}>Lv.{level}</span>
              </div>
            </div>
          </div>

          {/* 통계 */}
          <div className="stat-grid">
            <div className="stat">
              <div className="stat-num">{totalPlays}</div>
              <div className="stat-label">총 플레이</div>
            </div>
            <div className="stat">
              <div className="stat-num">{wins}</div>
              <div className="stat-label">1위 횟수</div>
            </div>
            <div className="stat wide">
              <div className="stat-num">{dexPct === null ? "—" : `${dexPct}%`}</div>
              <div className="stat-label">도감 달성</div>
            </div>
          </div>

          {/* RENAISS MARKET */}
          <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span
              className="accent"
              style={{ color: "var(--accent)", fontSize: 11, fontWeight: 700, letterSpacing: 1 }}
            >
              RENAISS MARKET
            </span>
            <strong style={{ fontSize: 16, lineHeight: 1.35 }}>진짜 카드를<br />온라인에서 소유하세요</strong>
            <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: 0 }}>
              PSA 등급 카드를 디지털로 소유하고, 원하면 실물로 받을 수 있습니다.
            </p>
            <a
              className="btn btn-accent btn-block"
              href="https://index.renaissos.com"
              target="_blank"
              rel="noreferrer"
              style={{ textAlign: "center", marginTop: 4 }}
            >
              마켓 구경하기 →
            </a>
          </div>

          <div className="spacer" style={{ flex: 1 }} />

          {/* 하단 도감·설정 */}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-dark btn-block" onClick={onDex}>📖 도감</button>
            <button className="btn btn-dark btn-block" onClick={() => flash("설정은 준비 중입니다")}>⚙ 설정</button>
          </div>
        </aside>
      </div>

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
                {(["pokemon", "one-piece"] as GameSel[]).map((g) => (
                  <button key={g} className={draft.game === g ? "on" : ""} onClick={() => saveDraft({ ...draft, game: g })}>
                    {gameLabel(g)}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small" style={{ margin: "2px 0 4px" }}>
              맵 모드·난이도는 방을 만든 뒤 <b>대기실에서 방장이</b> 선택합니다.
            </p>
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
