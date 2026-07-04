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

export const MAP_THEMES: Record<string, MapThemeDef> = {
  "straw-hat": { mask: "donut" }, // 밀짚모자 — 챙(테두리 링) 모양, 롤링 회전과도 잘 맞음
  "devil-fruit": { mask: "diamond" }, // 악마의 열매 — 둥근 과실 형태
  "monster-ball": { mask: "rect" }, // 몬스터볼 — UP 강제 rect, 배경은 상하 이분할 색상으로 표현
  pikachu: { mask: "bolt" }, // 피카츄 — 번개 지그재그 배치
  charizard: { mask: "flame" }, // 리자몽 — 불꽃 실루엣 배치
  "jolly-roger": { mask: "cross" }, // 해적깃발 — 십자(크로스본) 배치
  bulbasaur: { mask: "rect" }, // 이상해씨 — 단순 사각(롤링 친화적), 배경은 초록 잎사귀 톤
  squirtle: { mask: "rect" }, // 꼬북이 — UP 강제 rect, 배경은 파랑 물결 톤
  luffy: { mask: "corners" }, // 루피 — 모서리 깎임(둥근 실루엣)
  nami: { mask: "fish" }, // 나미 — 물고기형 배치(바다 테마)
  mewtwo: { mask: "diamond" }, // 뮤츠 — 사이킥 크리스탈 다이아몬드 형태
  chopper: { mask: "donut" }, // 초파 — 둥근 순록뿔 링 형태
};

/** theme 키로 강제 마스크를 조회 (미지정/알 수 없는 키는 undefined → 호출측이 기존 랜덤/기본 로직 사용) */
export function maskForTheme(theme: string | undefined): MaskKind | undefined {
  return theme ? MAP_THEMES[theme]?.mask : undefined;
}
