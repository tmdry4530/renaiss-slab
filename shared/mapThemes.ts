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

// 모드별 제약: UP 테마는 rect 강제(생성기가 무시하고 rect 로 강제) · 롤링 테마는 마스크 유효 칸만
// 회전 링으로 삼는다. 일반·롤링·승리·상하이 테마는 비트맵 실루엣(shared/board.ts SILHOUETTE_VARIANTS).
export const MAP_THEMES: Record<string, MapThemeDef> = {
  "straw-hat": { mask: "strawhat" }, // 밀짚모자(롤링) — 밀짚모자 실루엣
  "devil-fruit": { mask: "apple" }, // 악마의 열매(일반) — 둥근 과실 실루엣
  "monster-ball": { mask: "rect" }, // 몬스터볼(UP) — rect 강제, 배경은 상하 이분할 색상으로 표현
  pikachu: { mask: "pikachu" }, // 피카츄(상하이) — 양 귀+둥근 머리 실루엣
  charizard: { mask: "charizard" }, // 리자몽(승리) — 불꽃+날개 실루엣
  sudowoodo: { mask: "sudowoodo" }, // 꼬지모(일반) — 가지와 나무 몸통 실루엣
  "jolly-roger": { mask: "skull" }, // 해적깃발(일반) — 해골 실루엣
  magikarp: { mask: "rect" }, // 잉어킹(롤링) — 꽉 찬 사각, 회전 친화, 배경은 주홍·금빛 물결 톤
  ditto: { mask: "rect" }, // 메타몽(UP) — rect 강제, 배경은 연보라 젤리 톤
  whitebeard: { mask: "whitebeard" }, // 흰수염해적단(승리) — 십자+해골+수염 실루엣
  zeus: { mask: "zeus" }, // 제우스(상하이) — 나미의 뇌운 호미
  unown: { mask: "unown" }, // 안농(일반) — 물음표 폼 실루엣
  laboon: { mask: "laboon" }, // 라분(롤링) — 고래+꼬리 실루엣
  "navy-road": { mask: "rect" }, // 해군로(UP) — rect 강제, 해군 네이비 톤
};

/** theme 키로 강제 마스크를 조회 (미지정/알 수 없는 키는 undefined → 호출측이 기존 랜덤/기본 로직 사용) */
export function maskForTheme(theme: string | undefined): MaskKind | undefined {
  return theme ? MAP_THEMES[theme]?.mask : undefined;
}
