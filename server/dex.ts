// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 도감(Dex) 저장소 (FEATURE_SPEC F-12·F-14, TECH-SPEC §8)
// - playerId 별 인메모리 Map<cardId, count>
// - .data/dex.json 파일에 주기 저장 / 서버 시작 시 로드 (데모용 영속화 —
//   해커톤 범위 단순화. 실서비스는 Redis/DB 로 대체하는 것을 전제로 한다)
// - 동일 카드 누적 DEX_REGISTER_COUNT(10)회 제거 시 도감 등록
// - 카테고리 도감 완성 시 SBT 목(mock) 발급 (중복 발급 방지)
// ─────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEX_REGISTER_COUNT,
  type Ack,
  type DexEntry,
  type DexProgress,
  type SbtBadge,
} from "../shared/protocol.ts";
import type { PoolStore } from "./pool.ts";

const DEFAULT_DEX_PATH = fileURLToPath(new URL("../.data/dex.json", import.meta.url));
const SAVE_DEBOUNCE_MS = 1000; // 변경 후 1초 뒤 일괄 저장 (주기 저장)

interface PersistShape {
  players: Record<string, { counts: Record<string, number>; sbts: SbtBadge[] }>;
}

export class DexStore {
  private counts = new Map<string, Map<string, number>>(); // playerId → (cardId → 누적 제거 횟수)
  private sbts = new Map<string, SbtBadge[]>(); // playerId → 발급된 SBT 배지
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private filePath: string;

  constructor(private poolStore: PoolStore, filePath: string = DEFAULT_DEX_PATH) {
    this.filePath = filePath;
    this.load();
  }

  /** 시작 시 파일에서 복원 (없거나 손상되면 빈 상태로 시작) */
  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistShape;
      for (const [pid, entry] of Object.entries(raw.players ?? {})) {
        this.counts.set(pid, new Map(Object.entries(entry.counts ?? {})));
        if (entry.sbts?.length) this.sbts.set(pid, entry.sbts);
      }
    } catch {
      // 손상된 파일은 무시하고 빈 도감으로 시작 (데모 정책)
    }
  }

  /** 변경 발생 시 디바운스 저장 예약 */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 즉시 파일 저장 */
  flush(): void {
    try {
      const out: PersistShape = { players: {} };
      const pids = new Set([...this.counts.keys(), ...this.sbts.keys()]);
      for (const pid of pids) {
        out.players[pid] = {
          counts: Object.fromEntries(this.counts.get(pid) ?? []),
          sbts: this.sbts.get(pid) ?? [],
        };
      }
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(out, null, 2), "utf8");
    } catch {
      // 저장 실패는 치명적이지 않음 (인메모리 상태는 유지)
    }
  }

  /** 종료 시 타이머 정리 + 최종 저장 */
  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flush();
  }

  /**
   * 카드 제거 누적 (pairs = 제거된 짝 수).
   * 이번 누적으로 처음 DEX_REGISTER_COUNT 에 도달하면 true (= 이번에 도감 등록됨).
   */
  addRemoval(playerId: string, cardId: string, pairs: number): boolean {
    let m = this.counts.get(playerId);
    if (!m) {
      m = new Map();
      this.counts.set(playerId, m);
    }
    const prev = m.get(cardId) ?? 0;
    const next = prev + pairs;
    m.set(cardId, next);
    this.scheduleSave();
    return prev < DEX_REGISTER_COUNT && next >= DEX_REGISTER_COUNT;
  }

  entriesFor(playerId: string): DexEntry[] {
    const m = this.counts.get(playerId);
    if (!m) return [];
    return [...m.entries()].map(([cardId, count]) => ({
      cardId,
      count,
      registered: count >= DEX_REGISTER_COUNT,
    }));
  }

  progressFor(playerId: string): DexProgress {
    const reg = { pokemon: 0, "one-piece": 0 };
    const m = this.counts.get(playerId);
    if (m) {
      for (const [cardId, count] of m) {
        if (count < DEX_REGISTER_COUNT) continue;
        const game = this.poolStore.gameOf(cardId);
        if (game) reg[game]++;
      }
    }
    const mk = (game: "pokemon" | "one-piece") => {
      const total = this.poolStore.totalFor(game);
      return { registered: reg[game], total, complete: total > 0 && reg[game] >= total };
    };
    return { pokemon: mk("pokemon"), "one-piece": mk("one-piece") };
  }

  sbtsFor(playerId: string): SbtBadge[] {
    return this.sbts.get(playerId) ?? [];
  }

  /** SBT 목 발급 — 카테고리 도감 완성(complete) 시에만, 중복 발급 방지 */
  claim(playerId: string, category: unknown): Ack<{ sbt: SbtBadge }> {
    if (category !== "pokemon" && category !== "one-piece")
      return { ok: false, error: "알 수 없는 카테고리입니다" };
    const progress = this.progressFor(playerId);
    if (!progress[category].complete)
      return { ok: false, error: "도감이 아직 완성되지 않았습니다" };
    const list = this.sbts.get(playerId) ?? [];
    if (list.some((s) => s.category === category))
      return { ok: false, error: "이미 발급된 배지입니다" };
    const sbt: SbtBadge = { category, issuedAt: new Date().toISOString(), mock: true };
    list.push(sbt);
    this.sbts.set(playerId, list);
    this.scheduleSave();
    return { ok: true, data: { sbt } };
  }
}
