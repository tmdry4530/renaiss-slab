// Renaiss Slab King — 클라이언트 루트. 화면 흐름(FEATURE_SPEC §3):
// 로그인 → 대기(로비) → 방 → 게임 → 결과 → 로비 복귀. 서버 권위(shared/protocol.ts 계약).
import { useEffect, useRef, useState } from "react";
import type { CardPool, MarketSnapshot } from "../shared/cards.ts";
import type {
  BoardInit,
  PlayerSummary,
  RankEntry,
  RoomDetail,
} from "../shared/protocol.ts";
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

// board:init 미도착 대비 안전 타임아웃(ms) — 정상 흐름에선 board:init 도착 시 취소된다.
const BOARD_INIT_FALLBACK_MS = 6000;

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [nickname, setNickname] = useState(loadNickname());
  const [playerId, setPlayerId] = useState(loadPlayerId() ?? "");
  const [pool, setPool] = useState<CardPool | null>(null);
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [boardInit, setBoardInit] = useState<BoardInit | null>(null);
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
  const boardInitFallbackTimer = useRef(0);

  const flash = (msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600);
  };

  // ── 정적 데이터 (카드 풀 / 마켓 스냅샷) ──────────────────────
  useEffect(() => {
    fetch("/data/card-pool.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("card-pool.json 없음 — npm run prefetch 실행"))))
      .then(setPool)
      .catch((e) => setDataError(String(e.message ?? e)));
    fetch("/data/market-snapshot.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMarket)
      .catch(() => {});
  }, []);

  // ── 소켓 수신 (앱 수명 동안 1회 등록) ────────────────────────
  useEffect(() => {
    const s = getSocket();

    const onConnect = () => {
      setConnected(true);
      // 재접속 시 lobby:hello 재수행 (playerId 영속 → 같은 신원 복구)
      if (loggedInRef.current) void hello(loadNickname());
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
    // 3-2-1 카운트다운 — game:start 후 board:init 직전 서버가 순차 emit
    const onCountdown = (p: { seconds: number }) => {
      // 라운드가 빠르게 전환될 때 이전 goTimer 가 새 카운트다운을 삼키지 않도록 취소
      window.clearTimeout(goTimer.current);
      window.clearTimeout(boardInitFallbackTimer.current);
      countdownActiveRef.current = true;
      setShowGo(false);
      setCountdownSec(p.seconds);
      audio.playSound("countdown");
      // board:init 미도착 대비 안전 타임아웃 — 정상 흐름에선 board:init 이 먼저 도착해 아래에서 취소된다.
      boardInitFallbackTimer.current = window.setTimeout(() => {
        countdownActiveRef.current = false;
        setShowGo(false);
        setCountdownSec(null);
      }, BOARD_INIT_FALLBACK_MS);
    };
    const onBoardInit = (b: BoardInit) => {
      window.clearTimeout(boardInitFallbackTimer.current);
      setBoardInit(b);
      setGameNo((n) => n + 1);
      setResult(null);
      setScreen("game");
      if (countdownActiveRef.current) {
        // 카운트다운 직후 도착한 board:init — "시작!" 을 짧게 보여준 뒤 오버레이 해제
        countdownActiveRef.current = false;
        setShowGo(true);
        audio.playSound("go");
        window.clearTimeout(goTimer.current);
        goTimer.current = window.setTimeout(() => {
          setShowGo(false);
          setCountdownSec(null);
        }, 500);
      } else {
        setCountdownSec(null);
      }
    };
    const onEnded = (p: { ranks: RankEntry[]; summaries: PlayerSummary[] }) => {
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

  // ── 액션 ────────────────────────────────────────────────────
  async function onLogin(nick: string): Promise<boolean> {
    const r = await hello(nick);
    if (r.ok && r.data) {
      loggedInRef.current = true;
      setNickname(nick);
      setPlayerId(r.data.playerId);
      setScreen("lobby");
      return true;
    }
    flash(errText(r.error));
    return false;
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
          pool={pool}
          market={market}
          onEnterRoom={(rm) => {
            setRoom(rm);
            setScreen("room");
          }}
          onSoloRoom={(rm) => setRoom(rm)}
          onDex={() => setScreen("dex")}
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
        <Game key={gameNo} init={boardInit} room={room} myId={playerId} />
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

      {notice && <div className="notice app-notice">{notice}</div>}

      {/* 게임 시작 3-2-1 카운트다운 — game:start 후 board:init 직전 서버 주도 오버레이(클릭 차단) */}
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
