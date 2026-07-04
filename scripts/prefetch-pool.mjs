// 카드 풀 프리페치: Renaiss OS Index 공개 API -> public/data/card-pool.json
// 이미지(imageUrl) 포함. TECH-SPEC 6.3(사전 워밍) 구현. 공개 티어 60/분 -> 스로틀 + 429 재시도.
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api.renaissos.com";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/data/card-pool.json");

// 검색어를 늘리고 쿼리당 건수를 올려 일본어 카드 풀을 확장(플레이 피드백: 이미지 종류가 적음).
// API limit 상한은 30(그 이상은 거부되어 빈 결과) — PER_QUERY 30 고정.
// 쿼리를 대폭 확장해 풀 상한을 높인다(누적 모드라 실행할수록 커지고, 소진되면 자연히 정체).
const QUERIES = {
  pokemon: [
    "charizard", "pikachu", "mewtwo", "umbreon", "eevee", "gyarados",
    "rayquaza", "lugia", "gengar", "blastoise", "venusaur", "mew",
    "snorlax", "dragonite", "sylveon", "greninja",
    "charmander", "bulbasaur", "squirtle", "lucario", "garchomp", "tyranitar",
    "metagross", "arceus", "giratina", "dialga", "palkia", "zacian",
    "jolteon", "vaporeon", "flareon", "espeon", "glaceon", "leafeon",
    "ho-oh", "entei", "raikou", "suicune", "celebi", "jirachi",
    "darkrai", "gardevoir", "alakazam", "machamp", "salamence", "gengar",
    "zapdos", "moltres", "articuno", "dragonite",
  ],
  "one-piece": [
    "luffy", "zoro", "nami", "ace", "sanji", "robin",
    "yamato", "kaido", "sabo", "chopper", "doflamingo", "katakuri",
    "law", "shanks", "whitebeard", "roger", "rayleigh", "hancock",
    "jinbe", "brook", "franky", "usopp", "bigmom", "blackbeard",
    "crocodile", "mihawk", "garp", "marco", "oden", "kid",
    "killer", "bonney", "smoker", "buggy", "perona", "bartolomeo",
  ],
};
const PER_QUERY = 30;
const THROTTLE_MS = 9000; // 공개 티어 레이트리밋이 매우 빡빡 — 넉넉히 스로틀
const MAX_RETRY = 2; // 실패 쿼리에 시간·레이트 예산을 오래 쓰지 않는다(다음 스케줄에서 회전 순회)
// API가 소량 요청만 허용하고 하드 429 → 한 실행에서 전체를 돌리지 않고 소량 '회전 배치'만 처리.
// 시간 기반 오프셋으로 매 실행마다 다른 쿼리 묶음을 골라 스케줄 반복으로 전체를 순회·누적한다.
const PER_RUN = 10;

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
  // 누적(merge): 기존 스냅샷을 먼저 적재한 뒤 이번 실행에서 새 카드만 추가한다(중복 cardId 무시).
  // 공개 티어 레이트리밋이 빡빡해도 실행을 반복할수록 풀이 계속 커진다(절대 줄지 않음).
  let seeded = 0;
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8"));
    for (const c of prev.cards ?? []) byId.set(c.cardId, c);
    seeded = byId.size;
    console.log("기존 스냅샷 로드: " + seeded + "장 (누적 모드)");
  } catch {
    console.log("기존 스냅샷 없음 — 새로 생성");
  }
  // 현재 스냅샷을 파일로 저장(중단돼도 진행분 유실 최소화 — 증분 저장).
  const writePool = async () => {
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
    return pool;
  };

  // 전체 쿼리를 (game,q)로 평탄화 → 시간 기반 오프셋으로 PER_RUN 개만 회전 슬라이스.
  const flat = [];
  for (const [game, terms] of Object.entries(QUERIES)) for (const q of terms) flat.push({ game, q });
  const batches = Math.max(1, Math.ceil(flat.length / PER_RUN));
  const rot = Math.floor(Date.now() / (6 * 3600 * 1000)) % batches; // 6시간마다 다음 배치
  const batch = flat.slice(rot * PER_RUN, rot * PER_RUN + PER_RUN);
  console.log(`이번 배치: ${batch.length}개 쿼리 (회전 ${rot + 1}/${batches}, 전체 ${flat.length})`);

  for (const { game, q } of batch) {
    try {
      const results = await search(q);
      let added = 0;
      for (const c of results) {
        if (c.game !== game) continue;
        if (!c.imageUrl || !c.href) continue;
        const card = normalize(c);
        if (!byId.has(card.cardId)) { byId.set(card.cardId, card); added++; }
      }
      console.log("  " + game + "/" + q + ": " + results.length + " (+" + added + ")");
      if (added) await writePool(); // 부분 진행 즉시 저장
      await sleep(THROTTLE_MS);
    } catch (e) {
      console.log("  ! " + game + "/" + q + ": " + e.message);
    }
  }

  // 실제로 카드가 늘었을 때만 파일을 갱신한다. 변화 없으면 미갱신 → git diff 없음 →
  // 워크플로가 커밋/배포를 생략(불필요 배포 방지). generatedAt 만 바뀌어 매번 커밋되는 것을 막음.
  if (byId.size > seeded) {
    const pool = await writePool();
    const cards = pool.cards;
    const jp = cards.filter((c) => c.language === "Japanese");
    console.log(
      "OK card-pool.json: " + cards.length + "장 (누적 +" + (cards.length - seeded) + ") — " +
      "pokemon " + pool.counts.pokemon + ", one-piece " + pool.counts["one-piece"] +
      " | 일본어 " + jp.length + " (pk " + jp.filter((c) => c.game === "pokemon").length +
      ", op " + jp.filter((c) => c.game === "one-piece").length + ")"
    );
  } else {
    console.log("변화 없음 — card-pool.json 미갱신 (총 " + byId.size + "장). 다음 스케줄에서 다른 배치 순회.");
  }
}

main().catch((e) => { console.error("prefetch failed:", e.message); process.exit(1); });
