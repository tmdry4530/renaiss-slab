// 공용 소형 UI 컴포넌트 — F-16 예시 데이터 정책 준수:
// 실데이터(priceUsdCents 등)가 없는 카드에는 "예시 데이터" 라벨을 붙이고,
// 가격 표기에는 항상 "Renaiss OS Index" 출처 캡션을 유지한다. 숫자 임의 생성 금지.
import type { GameCard } from "../shared/cards.ts";
import { usd } from "../shared/cards.ts";

/** 카드에 실가격 데이터가 있는지 (결측 시 예시 데이터 취급) */
export const hasRealPrice = (c: GameCard): boolean =>
  typeof c.priceUsdCents === "number" && Number.isFinite(c.priceUsdCents);

/** 가격 + 출처 캡션 한 줄. 실데이터 결측 시 "예시 데이터" 라벨로 대체. */
export function PriceLine({ card, big }: { card: GameCard; big?: boolean }) {
  return (
    <span className={`price-line ${big ? "big" : ""}`}>
      {hasRealPrice(card) ? (
        <b className="px">{usd(card.priceUsdCents)}</b>
      ) : (
        <span className="sample-tag">예시 데이터</span>
      )}
      <span className="src-cap">Renaiss OS Index</span>
    </span>
  );
}
