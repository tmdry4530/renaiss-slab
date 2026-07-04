// 화면 2 — 대기실(방). 3컬럼: 좌 플레이어 슬롯 / 중앙 방제목·맵 프리뷰·시작 / 우 사이드바.
// 맵 선택은 Room 내부 오버레이(MapSelect)로 처리. 기존 room props/room:config/game:start/leave 계약 보존.
import { useState, type CSSProperties } from "react";
import type { RoomConfig, RoomDetail } from "../../shared/protocol.ts";
import { getSocket } from "../net.ts";
import { errText, modeLabel, stateLabel } from "../labels.ts";
import MapSelect, { MAP_PRESETS, mapDiffLabel, type MapPreset } from "./MapSelect.tsx";

interface Props {
  room: RoomDetail;
  myId: string;
  onLeave: () => void;
  flash: (msg: string) => void;
}

// 좌측 슬롯 아바타(장식용 이모지 — 실제 아바타 데이터 없음)
const AVATARS = ["🐵", "🐉", "🦊", "⭐", "🐱", "🐼"];

export default function Room({ room, myId, onLeave, flash }: Props) {
  const [busy, setBusy] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  // 선택된 프리셋(로컬 표시용). 초기값 = 현재 방 설정과 일치하는 프리셋(없으면 null).
  const [picked, setPicked] = useState<MapPreset | null>(
    () =>
      MAP_PRESETS.find(
        (p) =>
          p.mapMode === room.mapMode &&
          p.difficulty === room.difficulty &&
          p.game === room.game &&
          (room.theme ? p.theme === room.theme : true)
      ) ?? null
  );

  const me = room.players.find((p) => p.playerId === myId);
  const isHost = !!me?.isHost;

  function setCfg(patch: Partial<Pick<RoomConfig, "game" | "mapMode" | "difficulty" | "theme">>) {
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

  // 맵 선택 완료 → 호스트가 room:config emit(기존 계약) + 로컬 프리뷰 반영.
  // IP(game)는 방 생성 시 확정되어 여기서 덮어쓰지 않는다 — mapMode/difficulty/theme만 반영(스펙 B).
  function onMapConfirm(p: MapPreset) {
    setPicked(p);
    setMapOpen(false);
    setCfg({ mapMode: p.mapMode, difficulty: p.difficulty, theme: p.theme });
  }

  // 프리뷰: 선택 프리셋 or 현재 방 설정 기반(날조 없이 실제 모드/난이도 표기).
  const prevEmoji = picked?.emoji ?? "🗺️";
  const prevName = picked?.name ?? `${modeLabel(room.mapMode)} 맵`;
  const prevDiff = picked?.difficulty ?? room.difficulty;
  const prevTheme = picked?.theme ?? room.theme ?? "default";

  const bigBtn: CSSProperties = { minWidth: 150, padding: "14px 20px", fontSize: 15 };

  return (
    <section
      className="screen-3col"
      style={mapOpen ? { gridTemplateColumns: "1fr" } : undefined}
    >
      {/* ── 좌: 플레이어 슬롯 (맵 선택 중엔 숨김 — 맵선택 자체 필터가 좌측) ── */}
      {!mapOpen && (
      <aside className="side-left">
        {Array.from({ length: room.maxPlayers }, (_, i) => {
          const p = room.players[i];
          if (!p) {
            return (
              <div key={`empty-${i}`} className="slot-player empty">
                <div className="avatar lg">＋</div>
                <span className="sp-name">빈 자리</span>
              </div>
            );
          }
          return (
            <div key={p.playerId} className="slot-player">
              <div className="avatar lg">{AVATARS[i % AVATARS.length]}</div>
              <span className="sp-name">@{p.nickname}</span>
              {p.isHost && <span className="chip host">방장</span>}
              {!p.isHost && p.playerId === myId && <span className="chip green">나</span>}
              {!p.connected && <span className="pc-off">연결 끊김</span>}
            </div>
          );
        })}
      </aside>
      )}

      {/* ── 중앙 ── */}
      <main className="screen-center" style={mapOpen ? { padding: 0 } : undefined}>
        {mapOpen ? (
          <MapSelect room={room} onCancel={() => setMapOpen(false)} onConfirm={onMapConfirm} />
        ) : (
          <>
            {/* 상단 방제목 + 상태 */}
            <div style={{ alignSelf: "stretch", textAlign: "center", paddingBottom: 8 }}>
              <span style={{ fontWeight: 700 }}>{room.name}</span>{" "}
              <span className="chip accent">
                {room.state === "waiting" ? "대기 중" : stateLabel(room.state)}
              </span>
            </div>

            {/* 맵 프리뷰 + 액션 (세로 중앙) */}
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                gap: 22,
              }}
            >
              <div
                style={{
                  width: "min(440px, 92%)",
                  background: "var(--panel)",
                  border: "2px solid var(--accent)",
                  borderRadius: "var(--r)",
                  padding: 20,
                  boxShadow: "0 0 0 3px rgba(245,158,11,.15)",
                }}
              >
                <div
                  className={`map-theme-${prevTheme}`}
                  style={{
                    borderRadius: 10,
                    padding: "44px 0",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 96,
                    lineHeight: 1,
                  }}
                >
                  {prevEmoji}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
                  <span className={`badge-diff ${prevDiff}`}>{mapDiffLabel(prevDiff)}</span>
                  <span style={{ fontWeight: 700, fontSize: 18 }}>{prevName}</span>
                </div>
              </div>

              {isHost ? (
                <div style={{ display: "flex", gap: 14 }}>
                  <button className="btn btn-dark" style={bigBtn} onClick={() => setMapOpen(true)}>
                    맵 선택
                  </button>
                  <button className="btn btn-green" style={bigBtn} onClick={start} disabled={busy}>
                    게임 시작
                  </button>
                </div>
              ) : (
                <div className="chip">방장이 게임을 시작하길 기다리는 중…</div>
              )}

              <p className="muted" style={{ fontSize: 12.5, textAlign: "center", margin: 0 }}>
                방장이 맵을 선택하고 게임 시작 버튼을 누르면 게임이 시작됩니다.
              </p>
            </div>
          </>
        )}
      </main>

      {/* ── 우: 사이드바 (대기 중이라 값은 —, 맵 선택 중엔 숨김) ── */}
      {!mapOpen && (
      <aside className="side-right">
        <div style={{ textAlign: "center", padding: "6px 0 12px", borderBottom: "1px solid var(--border)" }}>
          <div className="ss-label">현재 등수</div>
          <div className="ss-val" style={{ fontSize: 26 }}>—</div>
        </div>
        <div className="side-stat">
          <span className="ss-label">남은 패</span>
          <span className="ss-val">—</span>
        </div>
        <div className="side-stat">
          <span className="ss-label">소거가능</span>
          <span className="ss-val">—</span>
        </div>

        <div className="item-row disabled">
          <span className="key-cap">F1</span> 🔍 서치
        </div>
        <div className="item-row disabled">
          <span className="key-cap">F2</span> 🎴 섞기
        </div>
        <div className="item-row disabled">
          <span className="key-cap">F3</span> ✂️ 가위
        </div>

        <div className="spacer" />

        <button className="btn btn-dark btn-block" onClick={() => flash("옵션은 준비 중입니다")}>
          옵션
        </button>
        <button className="btn btn-danger btn-block" onClick={onLeave}>
          나가기
        </button>
      </aside>
      )}
    </section>
  );
}
