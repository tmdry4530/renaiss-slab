// 공용 소형 UI 컴포넌트 — F-16 예시 데이터 정책 준수:
// 실데이터(priceUsdCents 등)가 없는 카드에는 "예시 데이터" 라벨을 붙이고,
// 가격 표기에는 항상 "Renaiss OS Index" 출처 캡션을 유지한다. 숫자 임의 생성 금지.
import { useState } from "react";
import type { GameCard } from "../shared/cards.ts";
import { usd } from "../shared/cards.ts";
import { t } from "./i18n.ts";

/**
 * 카드 이미지 + 실패 폴백 체인: 썸네일 → (다르면) 원본 → 카드명 텍스트 타일.
 * 원피스 카드 일부(374장)는 썸네일이 풀사이즈(228KB)라 일괄 로드 중 일시 실패가 나는데,
 * 폴백이 없으면 그 타일이 영영 빈 채로 남는다(플레이 피드백 "이미지 안 나옴").
 */
export function CardImg({
  thumb,
  full,
  alt,
  label,
  lazy,
}: {
  thumb: string;
  full: string;
  alt: string;
  label: string;
  lazy?: boolean;
}) {
  const [stage, setStage] = useState(0); // 0=썸네일, 1=원본 재시도, 2=텍스트 폴백
  const primary = thumb || full;
  const secondary = full && full !== thumb ? full : "";
  if (stage >= 2 || !primary) {
    return <span className="img-fallback" title={label}>{label}</span>;
  }
  return (
    <img
      src={stage === 0 ? primary : secondary || primary}
      alt={alt}
      draggable={false}
      decoding="async"
      loading={lazy ? "lazy" : undefined}
      onError={() => setStage(stage === 0 && secondary ? 1 : 2)}
    />
  );
}

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
        <span className="sample-tag">{t("game.sampleData")}</span>
      )}
      <span className="src-cap">Renaiss OS Index</span>
    </span>
  );
}
