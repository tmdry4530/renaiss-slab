// Renaiss Slab King — 클라이언트 루트. 화면 흐름(FEATURE_SPEC §3):
// 로그인 → 대기(로비) → 방 → 게임 → 결과 → 로비 복귀. 서버 권위(shared/protocol.ts 계약).
import { useEffect, useRef, useState } from "react";
import type { CardPool } from "../shared/cards.ts";
import type {
  BoardInit,
  PlayerSummary,
  RankEntry,
  ResumeProgress,
  ResumeState,
  RoomDetail,
} from "../shared/protocol.ts";
import { COUNTDOWN_STEPS, COUNTDOWN_STEP_MS } from "../shared/protocol.ts";
import { getSocket, hello, loadNickname, loadPlayerId } from "./net.ts";
import { errText } from "./labels.ts";
import { audio } from "./audio.ts";
import Login from "./screens/Login.tsx";
import Lobby from "./screens/Lobby.tsx";
import Room from "./screens/Room.tsx";
import Game from "./screens/Game.tsx";
import Result from "./screens/Result.tsx";
import Dex from "./screens/Dex.tsx";

type Screen = "login" | "lobby" | "room" | "game" | "result" | "dex";

// GO(game:countdown{0}) 미도착 대비 안전 타임아웃(ms) — 카운트다운 총 길이 + 여유.
// board:init 은 카운트다운 시작에 먼저 도착하므로, 이 fallback 은 GO 신호 누락 시 오버레이를 강제 해제한다.
const GO_FALLBACK_MS = COUNTDOWN_STEPS * COUNTDOWN_STEP_MS + 1500;

// ── 해시 라우팅 (라이브러리 없이 hashchange 수동 구현) ─────────
// #/lobby · #/room/<id> · #/game · #/result · #/dex · 기본 #/(login).
// 새로고침 시 URL 이 화면을 반영해 되돌아올 위치 힌트를 남기고, 뒤로가기(back)를 방어적으로 처리한다.
// 남의 방 딥링크 자동 입장은 스코프 밖(resume 전용) — roomId 파싱 구조만 추후 확장 가능하게 남긴다.
function hashFor(screen: Screen, roomId?: string): string {
  switch (screen) {
    case "lobby":
      return "#/lobby";
    case "room":
      return roomId ? `#/room/${roomId}` : "#/room";
    case "game":
      return "#/game";
    case "result":
      return "#/result";
    case "dex":
      return "#/dex";
    default:
      return "#/";
  }
}

function parseHash(): { screen: Screen; roomId?: string } {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  switch (parts[0]) {
    case "lobby":
      return { screen: "lobby" };
    case "room":
      return { screen: "room", roomId: parts[1] };
    case "game":
      return { screen: "game" };
    case "result":
      return { screen: "result" };
    case "dex":
      return { screen: "dex" };
    default:
      return { screen: "login" };
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [nickname, setNickname] = useState(loadNickname());
  const [playerId, setPlayerId] = useState(loadPlayerId() ?? "");
  // 소켓 이펙트(deps [])의 이벤트 핸들러에서 최신 playerId 참조용 미러 (클로저 stale 방지)
  const playerIdRef = useRef(playerId);
  playerIdRef.current = playerId;
  const [pool, setPool] = useState<CardPool | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [boardInit, setBoardInit] = useState<BoardInit | null>(null);
  const [resumeProgress, setResumeProgress] = useState<ResumeProgress | null>(null); // 재접속 복구 시에만 세팅
  const [gameNo, setGameNo] = useState(0); // board:init 마다 증가 → Game 리마운트 키
  const [result, setResult] = useState<{ ranks: RankEntry[]; summaries: PlayerSummary[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [countdownSec, setCountdownSec] = useState<number | null>(null); // 3-2-1 카운트다운 오버레이
  const [showGo, setShowGo] = useState(false); // board:init 도착 시 "시작!" 짧게 표시
  const loggedInRef = useRef(false);
  const noticeTimer = useRef(0);
  const countdownActiveRef = useRef(false);
  const goTimer = useRef(0);
  const overlayFallbackTimer = useRef(0);
  // 해시 라우팅용: 최신 screen/room 을 이벤트 핸들러(hashchange·onConnect)에서 stale 없이 읽기 위한 ref.
  const screenRef = useRef<Screen>("login");
  const roomRef = useRef<RoomDetail | null>(null);
  const prevScreenRef = useRef<Screen>("login"); // 해시 sync 의 push/replace 판단용
  const initialHashRef = useRef(parseHash()); // 마운트 시점(해시 sync 이전)의 새로고침 URL

  const flash = (msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600);
  };

  // ── 카드 풀 지연 로드 — 도감(Dex) 진입 시점에만 fetch(≈348KB). 게임은 board:init.cards 로 충분.
  const poolLoadingRef = useRef(false);
  function ensurePool() {
    if (pool || poolLoadingRef.current) return;
    poolLoadingRef.current = true;
    fetch("/data/card-pool.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("card-pool.json 없음 — npm run prefetch 실행"))))
      .then(setPool)
      .catch((e) => setDataError(String(e.message ?? e)))
      .finally(() => {
        poolLoadingRef.current = false;
      });
  }

  // ── 재접속 복구 + 자동 로그인 ────────────────────────────────
  // resume(서버 lobby:hello ack) → 화면 상태 반영: board 있으면 진행 중 게임으로 직행(모드 무관 —
  // 실제 진행 중인 매치를 놓치지 않는 게 더 중요). board 없을 때(대기 중 방만 존재)는 mode 로 갈린다:
  //  - reconnect(순단 재접속): 화면은 건드리지 않고 room 상태만 동기화 — 결과 화면(match:ended 직후)을
  //    보고 있거나 로비를 보고 있던 유저가 room 으로 튕기지 않게 한다.
  //  - auto/manual(진짜 새로고침·수동 로그인): 기존대로 방 화면으로 직행(로그인 화면 재노출 회피).
  function applyResume(resume: ResumeState, mode: "manual" | "auto" | "reconnect") {
    setRoom(resume.room);
    if (resume.board && resume.progress) {
      setResumeProgress(resume.progress);
      setBoardInit(resume.board);
      setGameNo((n) => n + 1); // Game 리마운트 (복구 보드로)
      setResult(null);
      // 이미 시작된 판 복구 — 카운트다운 오버레이는 띄우지 않는다.
      countdownActiveRef.current = false;
      setShowGo(false);
      setCountdownSec(null);
      setScreen("game");
      return;
    }
    // 진행 중 매치 없음(대기 중 방만 존재) — reconnect 는 현재 화면을 존중, room 상태만 갱신했다.
    if (mode === "reconnect") return;
    setScreen("room");
  }

  // lobby:hello 수행 + resume 처리. mode 로 진입 화면/에러 표시 정책을 나눈다.
  //  - manual: 로그인 화면에서 직접 로그인 (실패 시 에러 표시, 성공 시 lobby)
  //  - auto: 마운트 시 저장 닉네임으로 자동 로그인 (실패 조용, 성공 시 새로고침 해시 반영)
  //  - reconnect: 소켓 자동 재접속 후 재수행 (resume 만 반영, 없으면 현재 화면 유지 — 로비 순단 등)
  async function loginAndResume(nick: string, mode: "manual" | "auto" | "reconnect"): Promise<boolean> {
    const r = await hello(nick);
    if (!(r.ok && r.data)) {
      if (mode === "manual") flash(errText(r.error));
      return false;
    }
    loggedInRef.current = true;
    setNickname(nick);
    setPlayerId(r.data.playerId);
    if (r.data.resume) {
      applyResume(r.data.resume, mode);
      return true;
    }
    if (mode === "reconnect") return true; // 복구할 것 없음 → 현재 화면 유지
    // 최초 진입: auto 는 새로고침 해시가 dex 면 dex, 그 외엔 lobby. manual 은 항상 lobby.
    if (mode === "auto" && initialHashRef.current.screen === "dex") {
      ensurePool();
      setScreen("dex");
    } else {
      setScreen("lobby");
    }
    return true;
  }

  // 최신 참조를 1회 등록 effect(onConnect·hashchange)에서 stale 없이 쓰기 위한 ref 브리지.
  const ensurePoolRef = useRef(ensurePool);
  ensurePoolRef.current = ensurePool;
  const loginResumeRef = useRef(loginAndResume);
  loginResumeRef.current = loginAndResume;

  // ── 소켓 수신 (앱 수명 동안 1회 등록) ────────────────────────
  useEffect(() => {
    const s = getSocket();

    const onConnect = () => {
      setConnected(true);
      // 재접속 시 lobby:hello 재수행 → resume 있으면 게임/방 복구(순단 중 진행 반영), 없으면 화면 유지.
      if (loggedInRef.current) void loginResumeRef.current(loadNickname(), "reconnect");
    };
    const onDisconnect = () => setConnected(false);
    const onRoomUpdate = (p: { room: RoomDetail }) => setRoom(p.room);
    const onRoomClosed = (p: { reason: string }) => {
      setRoom(null);
      flash(
        p.reason === "hostLeft"
          ? "방장이 나가서 방이 사라졌습니다"
          : `방이 닫혔습니다 (${p.reason})`
      );
      setScreen((cur) => (cur === "room" || cur === "game" ? "lobby" : cur));
    };
    // board:init — 카운트다운 시작에 먼저 도착. 보드를 오버레이 뒤에서 미리 마운트해
    // 무거운 첫 렌더/썸네일 디코드를 유휴 3초로 흡수한다("시작!"/go 사운드는 GO={0} 이벤트에서만).
    const onBoardInit = (b: BoardInit) => {
      window.clearTimeout(goTimer.current);
      window.clearTimeout(overlayFallbackTimer.current);
      setBoardInit(b);
      setResumeProgress(null); // 새 판(정상 시작) — 복구 진행도 아님
      setGameNo((n) => n + 1);
      setResult(null);
      setScreen("game");
      // 오버레이 즉시 표시(placeholder) — 보드가 뒤에서 준비되는 동안 노출 프레임을 막는다.
      // 곧 도착할 {3} 이벤트가 같은 값으로 갱신하므로 숫자 element 는 리마운트되지 않는다(애니 1회).
      countdownActiveRef.current = true;
      setShowGo(false);
      setCountdownSec(COUNTDOWN_STEPS);
      // GO(=game:countdown{0}) 미도착 대비 안전 fallback — 정상 흐름에선 GO 도착 시 취소된다.
      overlayFallbackTimer.current = window.setTimeout(() => {
        countdownActiveRef.current = false;
        setShowGo(false);
        setCountdownSec(null);
      }, GO_FALLBACK_MS);
    };
    // 카운트다운 — board:init 뒤 3→2→1(seconds>0) 순차, 그리고 0(GO=시작!)
    const onCountdown = (p: { seconds: number }) => {
      window.clearTimeout(goTimer.current);
      if (p.seconds > 0) {
        // 3→2→1 진행 — 보드는 이미 오버레이 뒤에 마운트됨(board:init 이 먼저 도착)
        window.clearTimeout(overlayFallbackTimer.current);
        countdownActiveRef.current = true;
        setShowGo(false);
        setCountdownSec(p.seconds);
        // ready 사운드는 첫 틱(3)에서 1회만 — 긴 지글이 틱마다 겹치던 문제 해소 (회의 피드백)
        if (p.seconds === COUNTDOWN_STEPS) audio.playSound("countdown");
        overlayFallbackTimer.current = window.setTimeout(() => {
          countdownActiveRef.current = false;
          setShowGo(false);
          setCountdownSec(null);
        }, GO_FALLBACK_MS);
      } else {
        // seconds === 0 → GO(시작!). 선행 카운트다운이 없던 홀로 GO 는 무시(방어).
        if (!countdownActiveRef.current) return;
        window.clearTimeout(overlayFallbackTimer.current);
        countdownActiveRef.current = false;
        setShowGo(true);
        audio.playSound("go");
        goTimer.current = window.setTimeout(() => {
          setShowGo(false);
          setCountdownSec(null);
        }, 500);
      }
    };
    const onEnded = (p: { ranks: RankEntry[]; summaries: PlayerSummary[] }) => {
      // 종료음 단일화: 즉시 1개만 — 대전은 1등 여부, 혼자는 클리어 여부 (gameover+win 겹침·800ms 지연 제거)
      const mine = p.ranks.find((r) => r.playerId === playerIdRef.current);
      const won = p.ranks.length > 1 ? mine?.rank === 1 : !!mine?.cleared;
      audio.playSound(won ? "win" : "lose");
      setResult(p);
      setScreen("result");
    };

    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("room:update", onRoomUpdate);
    s.on("room:closed", onRoomClosed);
    s.on("game:countdown", onCountdown);
    s.on("board:init", onBoardInit);
    s.on("match:ended", onEnded);
    return () => {
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
      s.off("room:update", onRoomUpdate);
      s.off("room:closed", onRoomClosed);
      s.off("game:countdown", onCountdown);
      s.off("board:init", onBoardInit);
      s.off("match:ended", onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 해시 라우팅 ──────────────────────────────────────────────
  // 화면(및 방 id) → URL 해시 반영 + 이벤트 핸들러용 최신 ref 동기화.
  // 히스토리 오염 방지 위해 replace 위주, lobby→room/dex 진입만 push 해 back 으로 돌아올 수 있게 한다.
  useEffect(() => {
    screenRef.current = screen;
    roomRef.current = room;
    const target = hashFor(screen, room?.roomId);
    const prev = prevScreenRef.current;
    prevScreenRef.current = screen;
    if (window.location.hash === target) return;
    const push = prev === "lobby" && (screen === "room" || screen === "dex");
    if (push) window.history.pushState(null, "", target);
    else window.history.replaceState(null, "", target);
  }, [screen, room]);

  // 뒤로가기(back)/해시 직접 변경 수신 — 우리 push/replaceState 는 이벤트를 발생시키지 않으므로
  // 여기 도달하는 건 사용자 네비게이션이다. 안전한 전환만 허용하고 나머지는 현재 화면으로 되돌린다.
  useEffect(() => {
    const onHash = () => {
      const target = parseHash().screen;
      const cur = screenRef.current;
      if (cur === target) return;
      if (cur === "lobby" && target === "dex") {
        ensurePoolRef.current();
        setScreen("dex");
      } else if (cur === "dex" && target === "lobby") {
        setScreen("lobby");
      } else if ((cur === "room" || cur === "result") && target === "lobby") {
        // room/result 에서 lobby 로 back → 기존 leaveRoom 흐름(room:leave) 재사용
        getSocket().emit("room:leave");
        setRoom(null);
        setScreen("lobby");
      } else {
        // 정의되지 않은 전환 → 현재 화면 해시로 복원(방어).
        // "game" 은 여기로 떨어진다 — 게임 중 나가기 버튼과 동일하게 Back 으로도 매치 이탈 불가(방어).
        window.history.replaceState(null, "", hashFor(cur, roomRef.current?.roomId));
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 마운트 시 자동 재로그인 — 저장된 닉네임+playerId 가 있으면 hello → resume 있으면 직행.
  // 저장 닉네임 없으면 login 화면 유지. (앱 수명 동안 1회)
  useEffect(() => {
    const nick = loadNickname();
    const pid = loadPlayerId();
    if (nick && pid) void loginAndResume(nick, "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 액션 ────────────────────────────────────────────────────
  async function onLogin(nick: string): Promise<boolean> {
    return loginAndResume(nick, "manual");
  }

  function leaveRoom() {
    getSocket().emit("room:leave");
    setRoom(null);
    setScreen("lobby");
  }

  const showHero = screen === "login" || screen === "dex";
  // 로비·대기실·게임·결과는 목업대로 풀블리드 셸(구 히어로 헤더 없음)
  const wide = screen === "lobby" || screen === "room" || screen === "game" || screen === "result";

  return (
    <div className={wide ? "app app-wide" : "app"}>
      {screen === "lobby" && (
        <header className="app-header">
          <div className="logo-r">R</div>
          <div>
            <div className="brand-title">Slab King</div>
            <div className="brand-sub">by Renaiss</div>
          </div>
        </header>
      )}
      {showHero && (
        <header className="hero">
          <div className="brand">
            <span className="logo">♔</span>
            <div>
              <h1>Renaiss Slab King</h1>
              <p className="tagline">실제 Renaiss 카드로 즐기는 입문 게임</p>
            </div>
          </div>
          <div className="hero-right">
            {screen !== "login" && nickname && (
              <span className="hero-nick">👤 {nickname}</span>
            )}
            <div className="data-note">
              데이터{" "}
              <a href="https://index.renaissos.com" target="_blank" rel="noreferrer">
                Renaiss OS Index
              </a>
              {" · "}마켓/팩 공식 <code>renaiss</code> CLI
            </div>
          </div>
        </header>
      )}

      {!connected && screen !== "login" && (
        <div className="banner error">⚠ 서버와 연결이 끊겼습니다 — 자동 재접속 중…</div>
      )}
      {dataError && <div className="banner error">⚠ {dataError}</div>}

      {screen === "login" && <Login initial={nickname} onSubmit={onLogin} />}

      {screen === "lobby" && (
        <Lobby
          nickname={nickname}
          playerId={playerId}
          onEnterRoom={(rm) => {
            setRoom(rm);
            setScreen("room");
          }}
          onSoloRoom={(rm) => setRoom(rm)}
          onDex={() => {
            ensurePool();
            setScreen("dex");
          }}
          flash={flash}
        />
      )}

      {screen === "room" && room && (
        <Room room={room} myId={playerId} onLeave={leaveRoom} flash={flash} />
      )}
      {screen === "room" && !room && (
        <section className="panel">
          <p className="muted">방 정보가 없습니다.</p>
          <button className="ghost" onClick={() => setScreen("lobby")}>← 로비로</button>
        </section>
      )}

      {screen === "game" && boardInit && (
        <Game key={gameNo} init={boardInit} room={room} myId={playerId} resume={resumeProgress} />
      )}

      {screen === "result" && result && (
        <Result
          ranks={result.ranks}
          summaries={result.summaries}
          myId={playerId}
          canRetry={room !== null}
          roomName={room?.name}
          onRetry={() => setScreen(room ? "room" : "lobby")}
          onLobby={leaveRoom}
          flash={flash}
        />
      )}

      {screen === "dex" && <Dex pool={pool} onBack={() => setScreen("lobby")} flash={flash} />}

      {notice && <div className="notice app-notice" role="status" aria-live="polite">{notice}</div>}

      {/* 게임 시작 카운트다운 — board:init 뒤 3→2→1→시작! 서버 주도 오버레이(클릭 차단, 보드 프리마운트) */}
      {(countdownSec !== null || showGo) && (
        <div className="countdown-overlay">
          <div key={showGo ? "go" : countdownSec} className={`countdown-number${showGo ? " go" : ""}`}>
            {showGo ? "시작!" : countdownSec}
          </div>
        </div>
      )}

      {showHero && (
        <footer className="foot">가격·등급은 Renaiss OS Index 출처. 비영리 팬 프로토타입.</footer>
      )}
    </div>
  );
}
