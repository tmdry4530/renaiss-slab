// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 카드 풀 로더
// 서버 시작 시 public/data/card-pool.json (사전 워밍 스냅샷, TECH-SPEC §6.3) 을 1회 로드한다.
// ─────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CardPool, GameCard } from "../shared/cards.ts";

const DEFAULT_POOL_PATH = fileURLToPath(new URL("../public/data/card-pool.json", import.meta.url));

// REST 전용 필터 값 — RoomConfig.game(GameSel: pokemon|one-piece, mixed 제거됨)과는 별개로,
// /api/cards/pool 카드 브라우징 API 는 "mixed"(전체 카드) 조회 편의를 그대로 유지한다.
export type PoolGameFilter = "pokemon" | "one-piece" | "mixed";

export class PoolStore {
  readonly pool: CardPool;
  private byId = new Map<string, GameCard>();
  private totals: { pokemon: number; "one-piece": number };

  constructor(filePath: string = DEFAULT_POOL_PATH) {
    this.pool = JSON.parse(readFileSync(filePath, "utf8")) as CardPool;

    // 언어 통일 vs 카드 종류 다양성 균형(플레이 피드백: "카드 종류가 너무 적음").
    // 게임별로 일본어 카드가 충분(가장 어려운 보드의 종류 상한 = VARIETY_TARGET)하면 일본어만
    // 사용해 언어 통일을 유지하고, 부족하면 그 게임에 한해 전체 언어 카드를 포함해 종류를 늘린다.
    // 보드는 항상 "동일 카드(같은 이미지) 쌍"을 매칭하므로 언어 혼재로 인한 오매칭 위험은 없다.
    // → 프리페치로 일본어 풀이 커지면 자동으로 일본어 전용으로 복귀한다.
    const VARIETY_TARGET = 30; // hard 난이도 cardKinds 상한과 동일
    const usable = (cards: GameCard[], game: "pokemon" | "one-piece") =>
      cards.filter((c) => c.game === game && c.imageUrl);
    const jp = this.pool.cards.filter((c) => c.language === "Japanese");
    const pickForGame = (game: "pokemon" | "one-piece") => {
      const jpg = usable(jp, game);
      return jpg.length >= VARIETY_TARGET ? jpg : usable(this.pool.cards, game);
    };
    this.pool.cards = [...pickForGame("pokemon"), ...pickForGame("one-piece")];

    for (const c of this.pool.cards) this.byId.set(c.cardId, c);
    this.totals = {
      pokemon: this.pool.cards.filter((c) => c.game === "pokemon").length,
      "one-piece": this.pool.cards.filter((c) => c.game === "one-piece").length,
    };
  }

  /** 게임 셀렉션별 카드 목록 (mixed = 전체) */
  cardsFor(game: PoolGameFilter): GameCard[] {
    if (game === "mixed") return this.pool.cards;
    return this.pool.cards.filter((c) => c.game === game);
  }

  cardById(cardId: string): GameCard | undefined {
    return this.byId.get(cardId);
  }

  gameOf(cardId: string): "pokemon" | "one-piece" | undefined {
    return this.byId.get(cardId)?.game;
  }

  /** 도감 카테고리 total = 카드 풀의 해당 game 카드 수 */
  totalFor(game: "pokemon" | "one-piece"): number {
    return this.totals[game];
  }
}
