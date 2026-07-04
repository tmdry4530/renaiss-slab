// 화면 3 — 맵 선택 (Room 내부에서 열리는 오버레이). 필터(유형/난이도) + 프리셋 그리드.
// IP(game)는 방 생성 시 확정되어 여기서 바꾸지 않는다 — 프리셋 목록도 room.game 과 일치하는 것만 노출.
// 선택 완료 시 호스트가 room:config { mapMode, difficulty, theme } emit (Room 에서 처리).
import { useState, type CSSProperties } from "react";
import type {
  DifficultyKey,
  GameSel,
  MapMode,
  RoomDetail,
} from "../../shared/protocol.ts";
import { gameLabel, modeLabel } from "../labels.ts";

// ── 프리셋 정의 (테마명 상수 배열, 12종) ─────────────────────────
// theme: 배경/보드모양 테마 키(= id, shared/mapThemes.ts MAP_THEMES 참조) — 이름↔디자인 일치(스펙 A).
export interface MapPreset {
  id: string;
  name: string; // 테마 맵 이름
  emoji: string;
  mapMode: MapMode;
  difficulty: DifficultyKey; // easy=초급 / normal=중급 / hard=고급
  game: GameSel; // 포켓몬 | 원피스
  theme: string; // 배경/보드모양 테마 키 (= id)
}

export const MAP_PRESETS: MapPreset[] = [
  { id: "straw-hat",    name: "밀짚모자",   emoji: "👒", mapMode: "rolling",  difficulty: "easy", game: "one-piece", theme: "straw-hat" },
  { id: "devil-fruit",  name: "악마의 열매", emoji: "🍎", mapMode: "normal",   difficulty: "easy", game: "one-piece", theme: "devil-fruit" },
  { id: "monster-ball", name: "몬스터볼",   emoji: "🔴", mapMode: "up",       difficulty: "easy", game: "pokemon", theme: "monster-ball" },
  { id: "pikachu",      name: "피카츄",     emoji: "⚡", mapMode: "shanghai", difficulty: "hard", game: "pokemon", theme: "pikachu" },
  { id: "charizard",    name: "리자몽",     emoji: "🔥", mapMode: "victory",  difficulty: "hard", game: "pokemon", theme: "charizard" },
  { id: "jolly-roger",  name: "해적깃발",   emoji: "☠️", mapMode: "normal",   difficulty: "easy", game: "one-piece", theme: "jolly-roger" },
  { id: "bulbasaur",    name: "이상해씨",   emoji: "🌿", mapMode: "rolling",  difficulty: "easy", game: "pokemon", theme: "bulbasaur" },
  { id: "squirtle",     name: "꼬북이",     emoji: "💧", mapMode: "up",       difficulty: "hard", game: "pokemon", theme: "squirtle" },
  { id: "luffy",        name: "루피",       emoji: "🐸", mapMode: "victory",  difficulty: "hard", game: "one-piece", theme: "luffy" },
  { id: "nami",         name: "나미",       emoji: "🌊", mapMode: "shanghai", difficulty: "easy", game: "one-piece", theme: "nami" },
  { id: "mewtwo",       name: "뮤츠",       emoji: "💜", mapMode: "normal",   difficulty: "hard", game: "pokemon", theme: "mewtwo" },
  { id: "chopper",      name: "초파",       emoji: "🦌", mapMode: "rolling",  difficulty: "easy", game: "one-piece", theme: "chopper" },
];

// 맵 난이도 라벨(초급/중급/고급) — 게임 난이도 라벨(쉬움/보통/어려움)과 구분
export const mapDiffLabel = (d: DifficultyKey): string =>
  d === "easy" ? "초급" : d === "normal" ? "중급" : "고급";

const ipClass = (g: MapPreset["game"]): string => (g === "pokemon" ? "pokemon" : "onepiece");

type TypeFilter = MapMode | "all";
type DiffFilter = DifficultyKey | "all";

const TYPE_OPTS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "normal", label: "일반" },
  { key: "rolling", label: "롤링" },
  { key: "up", label: "UP" },
  { key: "victory", label: "승리" },
  { key: "shanghai", label: "상하이" },
];
// 프리셋 난이도는 초급/고급만 존재 → 목업대로 전체/초급/고급 (중급 제외, 빈 결과 방지)
const DIFF_OPTS: { key: DiffFilter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "easy", label: "초급" },
  { key: "hard", label: "고급" },
];

interface Props {
  room: RoomDetail;
  onCancel: () => void;
  onConfirm: (preset: MapPreset) => void;
}

export default function MapSelect({ room, onCancel, onConfirm }: Props) {
  const [typeF, setTypeF] = useState<TypeFilter>("all");
  const [diffF, setDiffF] = useState<DiffFilter>("all");
  const [sel, setSel] = useState<string | null>(
    () =>
      MAP_PRESETS.find(
        (p) =>
          p.mapMode === room.mapMode &&
          p.difficulty === room.difficulty &&
          p.game === room.game &&
          (room.theme ? p.theme === room.theme : true)
      )?.id ?? null
  );

  // IP(카드 세트)는 방 생성 시 확정되어 바뀌지 않는다 — 대기실 맵 선택은 그 IP 맵만 노출(스펙 B).
  const list = MAP_PRESETS.filter(
    (p) =>
      p.game === room.game &&
      (typeF === "all" || p.mapMode === typeF) &&
      (diffF === "all" || p.difficulty === diffF)
  );

  // 필터 버튼(텍스트형, 활성 강조)
  const fbtn = (on: boolean): CSSProperties => ({
    textAlign: "left",
    background: on ? "var(--panel-2)" : "transparent",
    color: on ? "var(--fg)" : "var(--muted)",
    border: "1px solid " + (on ? "var(--border)" : "transparent"),
    borderRadius: 8,
    padding: "7px 10px",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: on ? 700 : 400,
    width: "100%",
    fontFamily: "inherit",
  });

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        gridTemplateRows: "auto 1fr auto",
        // 뷰포트에 고정(100dvh) — 부모 .screen-3col 은 min-height 라 콘텐츠가 길면 늘어나
        // 하단 취소/선택 완료 바가 화면 밖으로 잘렸다. 여기서 높이를 못 박아 가운데 그리드만
        // 내부 스크롤되고 푸터는 항상 보이도록 한다(짧은 뷰포트 대응, 플레이 피드백).
        height: "100dvh",
        maxHeight: "100dvh",
        minHeight: 0,
      }}
    >
      {/* 상단 제목 */}
      <div
        style={{
          gridColumn: "1 / -1",
          textAlign: "center",
          padding: "16px 0",
          fontWeight: 700,
          fontSize: 16,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {room.name} <span className="muted">— 맵 선택</span>
      </div>

      {/* 좌: 필터 */}
      <aside style={{ padding: "16px 12px", overflow: "auto", borderRight: "1px solid var(--border)" }}>
        <div style={{ marginBottom: 22 }}>
          <div className="section-label">맵 유형</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {TYPE_OPTS.map((o) => (
              <button key={o.key} style={fbtn(typeF === o.key)} onClick={() => setTypeF(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 22 }}>
          <div className="section-label">난이도</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {DIFF_OPTS.map((o) => (
              <button key={o.key} style={fbtn(diffF === o.key)} onClick={() => setDiffF(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="section-label">IP</div>
          {/* IP 는 방 생성 시 확정 — 대기실에서 바꿀 수 없다(스펙 B). 선택 가능한 필터가 아니라 안내만 표시. */}
          <div className={`badge-ip ${room.game === "pokemon" ? "pokemon" : "onepiece"}`} style={{ display: "inline-block" }}>
            {gameLabel(room.game)} 전용
          </div>
        </div>
      </aside>

      {/* 중앙: 프리셋 그리드 */}
      <div style={{ padding: 16, overflow: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {list.map((p) => {
            const on = sel === p.id;
            return (
              <button
                key={p.id}
                className={`map-theme-${p.theme}`}
                onClick={() => setSel(p.id)}
                style={{
                  border: "2px solid " + (on ? "var(--accent)" : "var(--border)"),
                  borderRadius: "var(--r)",
                  padding: "16px 12px 14px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  color: "var(--fg)",
                  textAlign: "center",
                  boxShadow: on ? "0 0 0 3px rgba(245,158,11,.18)" : "none",
                }}
              >
                <div style={{ fontSize: 40, lineHeight: 1, margin: "6px 0 12px" }}>{p.emoji}</div>
                <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 10 }}>
                  <span style={{ color: "var(--accent)" }}>[{modeLabel(p.mapMode)}]</span> {p.name}
                </div>
                <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                  <span className={`badge-diff ${p.difficulty}`}>{mapDiffLabel(p.difficulty)}</span>
                  <span className={`badge-ip ${ipClass(p.game)}`}>{gameLabel(p.game)}</span>
                </div>
              </button>
            );
          })}
          {list.length === 0 && (
            <p className="muted" style={{ gridColumn: "1 / -1", padding: 20, textAlign: "center" }}>
              조건에 맞는 맵이 없습니다.
            </p>
          )}
        </div>
      </div>

      {/* 하단: 취소 / 선택 완료 */}
      <div
        style={{
          gridColumn: "1 / -1",
          display: "grid",
          gridTemplateColumns: "220px 1fr",
          gap: 14,
          padding: "14px 16px",
          borderTop: "1px solid var(--border)",
        }}
      >
        <button className="btn btn-dark" onClick={onCancel}>
          취소
        </button>
        <button
          className="btn btn-accent"
          disabled={!sel}
          onClick={() => {
            const p = MAP_PRESETS.find((x) => x.id === sel);
            if (p) onConfirm(p);
          }}
        >
          선택 완료
        </button>
      </div>
    </div>
  );
}
