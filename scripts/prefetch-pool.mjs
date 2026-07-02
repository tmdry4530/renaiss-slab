// 카드 풀 프리페치: Renaiss OS Index 공개 API -> public/data/card-pool.json
// 이미지(imageUrl) 포함. TECH-SPEC 6.3(사전 워밍) 구현. 공개 티어 60/분 -> 스로틀 + 429 재시도.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.renaissos.com";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/data/card-pool.json");

const QUERIES = {
  pokemon: ["charizard", "pikachu", "mewtwo", "umbreon"],
  "one-piece": ["luffy", "zoro", "nami", "ace"],
};
const PER_QUERY = 8;
const THROTTLE_MS = 1200;
const MAX_RETRY = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (href) => href.split("/").filter(Boolean).join("-");
const matchKey = (c) =>
  [c.game, c.setName, c.cardNumber, c.variation ?? "", c.language].join("|").toLowerCase();

async function search(q) {
  const url = `${BASE}/v1/search?q=${encodeURIComponent(q)}&limit=${PER_QUERY}`;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()).results ?? [];
    if (res.status === 429 && attempt < MAX_RETRY) {
      const wait = 6000 * (attempt + 1);
      console.log("    (429 rate-limited, wait " + wait / 1000 + "s)");
      await sleep(wait);
      continue;
    }
    throw new Error('search "' + q + '" -> ' + res.status);
  }
  return [];
}

function normalize(c) {
  return {
    cardId: slug(c.href), matchKey: matchKey(c), game: c.game, type: c.type,
    name: c.name, setName: c.setName, setCode: c.setCode ?? null, cardNumber: c.cardNumber,
    variation: c.variation ?? null, language: c.language, imageUrl: c.imageUrl,
    imageUrlThumb: c.imageUrlThumb ?? c.imageUrl, company: c.company, grade: c.grade,
    gradeLabel: c.gradeLabel, priceUsdCents: c.priceUsdCents, deltaPct: c.deltaPct ?? 0,
    confidence: c.confidence, lastSaleAt: c.lastSaleAt, href: c.href, attribution: "Renaiss OS Index",
  };
}

async function main() {
  const byId = new Map();
  for (const [game, terms] of Object.entries(QUERIES)) {
    for (const q of terms) {
      try {
        const results = await search(q);
        for (const c of results) {
          if (c.game !== game) continue;
          if (!c.imageUrl || !c.href) continue;
          const card = normalize(c);
          if (!byId.has(card.cardId)) byId.set(card.cardId, card);
        }
        console.log("  " + game + "/" + q + ": " + results.length);
        await sleep(THROTTLE_MS);
      } catch (e) {
        console.log("  ! " + game + "/" + q + ": " + e.message);
      }
    }
  }
  const cards = [...byId.values()];
  const pool = {
    generatedAt: new Date().toISOString(),
    source: "Renaiss OS Index Public API (/v1/search)",
    counts: {
      pokemon: cards.filter((c) => c.game === "pokemon").length,
      "one-piece": cards.filter((c) => c.game === "one-piece").length,
    },
    cards,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(pool, null, 2));
  console.log("OK card-pool.json: " + cards.length + " cards (pokemon " + pool.counts.pokemon + ", one-piece " + pool.counts["one-piece"] + ")");
}

main().catch((e) => { console.error("prefetch failed:", e.message); process.exit(1); });
