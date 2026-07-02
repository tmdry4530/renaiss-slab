// 마켓/팩 스냅샷: 공식 Renaiss CLI(`npx renaiss`) → public/data/market-snapshot.json
// CLI 리스트 출력엔 이미지가 없으므로 카드 풀이 아닌 "마켓/가챠 컨텍스트"용.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/data/market-snapshot.json");
const WEI = 1e18;

async function renaiss(args) {
  // 로컬에 설치돼 있지 않으면 npx가 받아서 실행
  const { stdout } = await run("npx", ["-y", "renaiss", ...args], { maxBuffer: 8 * 1024 * 1024 });
  const i = stdout.indexOf("{");
  const j = stdout.lastIndexOf("}");
  if (i < 0 || j < 0) throw new Error(`JSON 파싱 실패: renaiss ${args.join(" ")}`);
  return JSON.parse(stdout.slice(i, j + 1));
}

const num = (v, div = 1) => (v == null || v === "" ? null : Number(v) / div);

async function marketplace(category) {
  const data = await renaiss(["marketplace", "--category", category, "--limit", "20", "--json"]);
  return (data.collection ?? []).map((c) => ({
    tokenId: c.tokenId,
    name: c.name,
    setName: c.setName,
    cardNumber: c.cardNumber,
    character: c.pokemonName ?? null,
    category,
    grade: c.grade,
    gradingCompany: c.gradingCompany,
    year: c.year ?? null,
    askUsd: num(c.askPriceInUSDT, WEI),
    fmvUsd: num(c.fmvPriceInUSD, 100),
  }));
}

async function packs() {
  const data = await renaiss(["packs", "--json"]);
  return (data.cardPacks ?? []).map((p) => ({
    slug: p.slug,
    name: p.name,
    packType: p.packType,
    stage: p.stage,
    author: p.author,
    priceUsd: num(p.priceInUsdt, WEI),
    expectedValueUsd: num(p.expectedValueInUsd, 100),
    featuredCardFmvUsd: num(p.featuredCardFmvInUsd, 100),
  }));
}

async function main() {
  const listings = [];
  for (const cat of ["POKEMON", "ONE_PIECE"]) {
    try {
      const rows = await marketplace(cat);
      listings.push(...rows);
      console.log(`  marketplace ${cat}: ${rows.length}`);
    } catch (e) {
      console.log(`  ! marketplace ${cat}: ${e.message}`);
    }
  }
  let packList = [];
  try {
    packList = await packs();
    console.log(`  packs: ${packList.length}`);
  } catch (e) {
    console.log(`  ! packs: ${e.message}`);
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "Renaiss CLI (npx renaiss) — marketplace, packs",
    listings,
    packs: packList,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(snapshot, null, 2));
  console.log(`✓ market-snapshot.json: 리스팅 ${listings.length}, 팩 ${packList.length}`);
}

main().catch((e) => {
  console.error("CLI 프리페치 실패:", e.message);
  process.exit(1);
});
