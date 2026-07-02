// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 카드 풀 로더
// 서버 시작 시 public/data/card-pool.json (사전 워밍 스냅샷, TECH-SPEC §6.3) 을 1회 로드한다.
// ─────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CardPool, GameCard } from "../shared/cards.ts";
import type { GameSel } from "../shared/protocol.ts";

const DEFAULT_POOL_PATH = fileURLToPath(new URL("../public/data/card-pool.json", import.meta.url));

export class PoolStore {
  readonly pool: CardPool;
  private byId = new Map<string, GameCard>();
  private totals: { pokemon: number; "one-piece": number };

  constructor(filePath: string = DEFAULT_POOL_PATH) {
    this.pool = JSON.parse(readFileSync(filePath, "utf8")) as CardPool;
    for (const c of this.pool.cards) this.byId.set(c.cardId, c);
    this.totals = {
      pokemon: this.pool.cards.filter((c) => c.game === "pokemon").length,
      "one-piece": this.pool.cards.filter((c) => c.game === "one-piece").length,
    };
  }

  /** 게임 셀렉션별 카드 목록 (mixed = 전체) */
  cardsFor(game: GameSel): GameCard[] {
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
