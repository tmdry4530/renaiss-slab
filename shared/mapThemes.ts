// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 맵 테마 → 보드 마스크 매핑 (서버·클라이언트 공용)
// src/screens/MapSelect.tsx 의 MapPreset.theme(= id) 을 키로 사용한다.
// 서버(Match)는 이 테이블로 room.config.theme → 보드 생성 시 강제할 MaskKind 를 조회하고,
// 배경/색 등 시각 테마(CSS)는 src/styles.css 의 .map-theme-<theme> 클래스가 별도로 담당한다.
// ─────────────────────────────────────────────────────────────
import type { MaskKind } from "./board.ts";

export interface MapThemeDef {
  mask: MaskKind;
}

// 모드별 제약: UP 테마는 rect 강제(생성기가 무시하고 rect 로 강제) · 롤링 테마는 외곽이 연속된 링친화
// 형태(donut/rect) · 일반·승리·상하이 테마는 비트맵 실루엣(shared/board.ts SILHOUETTE_VARIANTS).
export const MAP_THEMES: Record<string, MapThemeDef> = {
  "straw-hat": { mask: "donut" }, // 밀짚모자(롤링) — 챙(테두리 링) 모양, 회전 친화
  "devil-fruit": { mask: "apple" }, // 악마의 열매(일반) — 둥근 과실 실루엣
  "monster-ball": { mask: "rect" }, // 몬스터볼(UP) — rect 강제, 배경은 상하 이분할 색상으로 표현
  pikachu: { mask: "pikachu" }, // 피카츄(상하이) — 양 귀+둥근 몸 실루엣
  charizard: { mask: "charizard" }, // 리자몽(승리) — 불꽃+날개 실루엣
  sudowoodo: { mask: "sudowoodo" }, // 꼬지모(일반) — 가지와 나무 몸통 실루엣
  "jolly-roger": { mask: "skull" }, // 해적깃발(일반) — 해골 실루엣
  bulbasaur: { mask: "rect" }, // 이상해씨(롤링) — 꽉 찬 사각, 회전 친화, 배경은 초록 잎사귀 톤
  squirtle: { mask: "rect" }, // 꼬북이(UP) — rect 강제, 배경은 파랑 물결 톤
  luffy: { mask: "strawhat" }, // 루피(승리) — 밀짚모자 실루엣
  nami: { mask: "tangerine" }, // 나미(상하이) — 귤 실루엣
  mewtwo: { mask: "crystal" }, // 뮤츠(일반) — 사이킥 크리스탈(다이아몬드) 실루엣
  chopper: { mask: "donut" }, // 초파(롤링) — 둥근 순록뿔 링, 회전 친화
  "going-merry": { mask: "rect" }, // 고잉메리호(UP) — rect 강제, 배경은 청록 바다/돛 톤
};

/** theme 키로 강제 마스크를 조회 (미지정/알 수 없는 키는 undefined → 호출측이 기존 랜덤/기본 로직 사용) */
export function maskForTheme(theme: string | undefined): MaskKind | undefined {
  return theme ? MAP_THEMES[theme]?.mask : undefined;
}
