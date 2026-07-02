// 방(대기실) 화면 — 참가자 목록(방장 👑·나), 방장 전용 설정 변경(room:config)·게임 시작
import { useState } from "react";
import { DIFFICULTIES } from "../../shared/board.ts";
import {
  MAP_MODES,
  type GameSel,
  type RoomConfig,
  type RoomDetail,
} from "../../shared/protocol.ts";
import { getSocket } from "../net.ts";
import { errText, gameLabel } from "../labels.ts";

interface Props {
  room: RoomDetail;
  myId: string;
  onLeave: () => void;
  flash: (msg: string) => void;
}

export default function Room({ room, myId, onLeave, flash }: Props) {
  const [busy, setBusy] = useState(false);
  const me = room.players.find((p) => p.playerId === myId);
  const isHost = !!me?.isHost;

  function setCfg(patch: Partial<Pick<RoomConfig, "game" | "mapMode" | "difficulty">>) {
    if (!isHost) return;
    getSocket().emit("room:config", patch, (r) => {
      if (!r.ok) flash(errText(r.error));
      // 성공 시 room:update 브로드캐스트로 반영된다.
    });
  }

  function start() {
    if (busy) return;
    setBusy(true);
    getSocket().emit("game:start", (r) => {
      setBusy(false);
      if (!r.ok) flash(errText(r.error));
      // 성공 시 board:init 수신으로 게임 화면 전환.
    });
  }

  return (
    <section className="room-screen">
      <div className="panel-head">
        <h2>
          {room.visibility === "private" && <span title="비공개 방">🔒 </span>}
          {room.name} <span className="muted">({room.playerCount}/{room.maxPlayers}명)</span>
        </h2>
        <button className="ghost" onClick={onLeave}>← 나가기</button>
      </div>

      <div className="room-cols">
        <div className="room-config setup">
          <div className="field">
            <label>카드</label>
            <div className="seg">
              {(["pokemon", "one-piece", "mixed"] as GameSel[]).map((g) => (
                <button
                  key={g}
                  className={room.game === g ? "on" : ""}
                  disabled={!isHost}
                  onClick={() => setCfg({ game: g })}
                >
                  {gameLabel(g)}
                </button>
              ))}
            </div>
          </div>
          <div className="field field-top">
            <label>맵 모드</label>
            <div className="mode-list">
              {MAP_MODES.map((m) => (
                <button
                  key={m.key}
                  className={`mode-opt ${room.mapMode === m.key ? "on" : ""}`}
                  disabled={!isHost}
                  onClick={() => setCfg({ mapMode: m.key })}
                >
                  <b>{m.label}</b>
                  <span>{m.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>난이도</label>
            <div className="seg">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d.key}
                  className={room.difficulty === d.key ? "on" : ""}
                  disabled={!isHost}
                  onClick={() => setCfg({ difficulty: d.key })}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="start-row">
            {isHost ? (
              <button className="btn primary big" onClick={start} disabled={busy}>
                ▶ 게임 시작
              </button>
            ) : (
              <p className="muted">방장이 게임을 시작하면 자동으로 입장합니다. (별도 준비 절차 없음)</p>
            )}
          </div>
        </div>

        <div className="room-players">
          <h3 className="muted">참가자</h3>
          <div className="player-list">
            {Array.from({ length: room.maxPlayers }, (_, i) => {
              const p = room.players[i];
              if (!p) {
                return (
                  <div key={`empty-${i}`} className="player-chip empty">
                    빈 자리
                  </div>
                );
              }
              return (
                <div key={p.playerId} className={`player-chip ${p.playerId === myId ? "me" : ""}`}>
                  <span className="pc-name">
                    {p.isHost && <span title="방장">👑 </span>}
                    {p.nickname}
                    {p.playerId === myId && <span className="pc-me"> (나)</span>}
                  </span>
                  {!p.connected && <span className="pc-off">연결 끊김</span>}
                </div>
              );
            })}
          </div>
          <p className="muted small">
            "실제 Renaiss 카드로 즐기는 입문 게임" — 같은 카드 두 장을 꺾임 2번 이내로 이어 없애세요.
          </p>
        </div>
      </div>
    </section>
  );
}
