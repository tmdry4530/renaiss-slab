// TECH-SPEC §3.1 GameCard 와 정합. Renaiss OS Index CardSummary 필드명 차용.
// 서버·클라이언트 공용 (shared).
export interface GameCard {
  cardId: string; // href 세그먼트 기반 안정 식별자
  matchKey: string; // 퍼즐 "같은 카드" 판정 키 (game|set|number|variation|language[|grade])
  game: "pokemon" | "one-piece";
  type: "POKEMON" | "ONE_PIECE" | "SPORTS";
  name: string;
  setName: string;
  setCode: string | null;
  cardNumber: string;
  variation: string | null;
  language: string;
  imageUrl: string;
  imageUrlThumb: string;
  company: string; // PSA / CGC / BGS
  grade: string;
  gradeLabel: string; // 예: "PSA 10"
  priceUsdCents: number; // 표시 시 /100
  deltaPct: number;
  confidence: "high" | "medium" | "low";
  lastSaleAt: string;
  href: string; // /card/{game}/{set}/{card}
  attribution: "Renaiss OS Index";
}

// 승리 모드 합성 "승" 카드: 실물 풀에 없는 특수 카드. matchKey 가 고유("__victory__")라
// 승리 타일끼리만 매칭된다. imageUrl 이 비어 usable 풀(imageUrl 필터)에는 자연 제외된다.
export function victoryCard(): GameCard {
  return {
    cardId: "__victory__",
    matchKey: "__victory__",
    game: "pokemon", // 무해한 기본값 (도감엔 등록하지 않음)
    type: "POKEMON",
    name: "승리",
    setName: "",
    setCode: null,
    cardNumber: "",
    variation: null,
    language: "ko",
    imageUrl: "",
    imageUrlThumb: "",
    company: "",
    grade: "",
    gradeLabel: "승리",
    priceUsdCents: 0,
    deltaPct: 0,
    confidence: "low",
    lastSaleAt: "",
    href: "",
    attribution: "Renaiss OS Index",
  };
}

export interface CardPool {
  generatedAt: string;
  source: string;
  counts: { pokemon: number; "one-piece": number };
  cards: GameCard[];
}

// 공식 Renaiss CLI 마켓/팩 스냅샷
export interface MarketListing {
  tokenId: string;
  name: string;
  setName: string;
  cardNumber: string;
  character: string | null;
  category: "POKEMON" | "ONE_PIECE";
  grade: string;
  gradingCompany: string;
  year: number | null;
  askUsd: number | null; // askPriceInUSDT(1e18) → USD
  fmvUsd: number | null; // fmvPriceInUSD(cents) → USD
}

export interface PackInfo {
  slug: string;
  name: string;
  packType: string;
  stage: string;
  author: string;
  priceUsd: number | null;
  expectedValueUsd: number | null;
  featuredCardFmvUsd: number | null;
}

export interface MarketSnapshot {
  generatedAt: string;
  source: string;
  listings: MarketListing[];
  packs: PackInfo[];
}

export const RENAISS_INDEX_BASE = "https://index.renaissos.com";
export const marketUrl = (href: string) => `${RENAISS_INDEX_BASE}${href}`;
export const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
