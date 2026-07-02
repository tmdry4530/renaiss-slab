// F-12/13/14 카드 도감 — 포켓몬/원피스 탭, 달성률, 등록/진행/미발견 그리드,
// 상세 패널(이미지 우측 배치 + 하단 간단 정보 + "자세히 보기" → Renaiss 마켓), SBT 뱃지·보상
import { useEffect, useMemo, useState } from "react";
import type { CardPool, GameCard } from "../../shared/cards.ts";
import { marketUrl, usd } from "../../shared/cards.ts";
import {
  DEX_REGISTER_COUNT,
  type DexEntry,
  type DexProgress,
  type SbtBadge,
} from "../../shared/protocol.ts";
import { getSocket } from "../net.ts";
import { errText, gameLabel } from "../labels.ts";
import { hasRealPrice } from "../ui.tsx";

type Tab = "pokemon" | "one-piece";

interface Props {
  pool: CardPool | null;
  onBack: () => void;
  flash: (msg: string) => void;
}

export default function Dex({ pool, onBack, flash }: Props) {
  const [tab, setTab] = useState<Tab>("pokemon");
  const [entries, setEntries] = useState<Record<string, DexEntry>>({});
  const [progress, setProgress] = useState<DexProgress | null>(null);
  const [sbts, setSbts] = useState<SbtBadge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  // 도감 데이터 로드
  useEffect(() => {
    getSocket().emit("dex:get", (r) => {
      if (r.ok && r.data) {
        const map: Record<string, DexEntry> = {};
        for (const e of r.data.entries) map[e.cardId] = e;
        setEntries(map);
        setProgress(r.data.progress);
        setSbts(r.data.sbts);
      } else {
        flash(errText(r.error));
      }
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cards = useMemo(
    () => (pool ? pool.cards.filter((c) => c.game === tab) : []),
    [pool, tab]
  );
  const selectedCard: GameCard | null = useMemo(
    () => (selected ? cards.find((c) => c.cardId === selected) ?? null : null),
    [cards, selected]
  );

  function claim(category: Tab) {
    if (claiming) return;
    setClaiming(true);
    getSocket().emit("sbt:claim", { category }, (r) => {
      setClaiming(false);
      if (r.ok && r.data) {
        setSbts((s) => [...s, r.data!.sbt]);
        flash(`🏅 ${gameLabel(category)} 도감 SBT 발급 완료!`);
      } else {
        flash(errText(r.error));
      }
    });
  }

  const statusOf = (c: GameCard): "reg" | "prog" | "unk" => {
    const e = entries[c.cardId];
    if (e?.registered) return "reg";
    if (e && e.count > 0) return "prog";
    return "unk";
  };

  return (
    <section className="dex-screen">
      <div className="panel-head">
        <h2>카드 도감</h2>
        <button className="ghost" onClick={onBack}>← 로비로</button>
      </div>

      {/* 카테고리 탭 + 달성률 */}
      <div className="dex-tabs">
        {(["pokemon", "one-piece"] as Tab[]).map((t) => {
          const pr = progress?.[t];
          const pct = pr && pr.total > 0 ? Math.round((pr.registered / pr.total) * 100) : 0;
          return (
            <button
              key={t}
              className={`dex-tab ${tab === t ? "on" : ""}`}
              onClick={() => {
                setTab(t);
                setSelected(null);
              }}
            >
              <span className={`badge ${t}`}>{gameLabel(t)}</span>
              {pr ? (
                <span className="dex-tab-progress">
                  <span className="gb-track"><span className="gb-fill" style={{ width: `${pct}%` }} /></span>
                  <span className="muted">{pr.registered}/{pr.total} ({pct}%)</span>
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </button>
          );
        })}
      </div>

      {/* SBT 뱃지 + 완성 보상 */}
      <div className="dex-sbt-row">
        {sbts.map((s) => (
          <span key={s.category} className="sbt-badge">
            🏅 {gameLabel(s.category)} 도감 SBT
            <span className="muted"> · {new Date(s.issuedAt).toLocaleDateString("ko-KR")}{s.mock ? " (목 발급)" : ""}</span>
          </span>
        ))}
        {progress?.[tab]?.complete && !sbts.some((s) => s.category === tab) && (
          <button className="btn primary sm" disabled={claiming} onClick={() => claim(tab)}>
            🏅 {gameLabel(tab)} 도감 완성 보상 받기
          </button>
        )}
      </div>

      <p className="muted small">
        동일 카드를 누적 {DEX_REGISTER_COUNT}회 제거하면 도감에 등록됩니다. 등급·가격은 Renaiss OS
        Index 실데이터 기준이며, 미확보 항목은 "예시 데이터"로 표기합니다.
      </p>

      {!pool && <p className="muted">카드 풀을 불러오는 중…</p>}
      {pool && !loaded && <p className="muted">도감 데이터를 불러오는 중…</p>}

      {/* 상세 패널 — 이미지 우측 배치 */}
      {selectedCard && (
        <div className="dex-detail">
          <div className="dd-info">
            <h3>{selectedCard.name}</h3>
            <p className="muted">
              {selectedCard.setName} · #{selectedCard.cardNumber} · {selectedCard.language}
            </p>
            <p className="dd-price-row">
              <span className="grade">{selectedCard.gradeLabel}</span>{" "}
              {hasRealPrice(selectedCard) ? (
                <b className="px">{usd(selectedCard.priceUsdCents)}</b>
              ) : (
                <span className="sample-tag">예시 데이터</span>
              )}
            </p>
            <p className="attribution">출처: Renaiss OS Index</p>
            <p className="muted small dd-story">
              등급 감정(슬랩)된 실물 카드입니다. 온라인에서 구매하면 소유권이 계정에 귀속되고,
              원하면 실물 카드로 수령할 수도 있어요. 세트({selectedCard.setName}) 단위로 모으는
              재미도 놓치지 마세요.
            </p>
            <div className="dd-actions">
              <a className="btn primary" href={marketUrl(selectedCard.href)} target="_blank" rel="noreferrer">
                자세히 보기 ↗
              </a>
              <button className="ghost" onClick={() => setSelected(null)}>닫기</button>
            </div>
          </div>
          <div className="dd-image">
            <img src={selectedCard.imageUrl || selectedCard.imageUrlThumb} alt={selectedCard.name} />
          </div>
        </div>
      )}

      {/* 카드 그리드: 등록(컬러) / 진행 중(흑백 + n/10) / 미발견(실루엣 ?) */}
      {pool && loaded && (
        <div className="dex-grid">
          {cards.map((c) => {
            const st = statusOf(c);
            const e = entries[c.cardId];
            return (
              <button
                key={c.cardId}
                className={`dex-card ${st} ${selected === c.cardId ? "sel" : ""}`}
                disabled={st === "unk"}
                onClick={() => setSelected(selected === c.cardId ? null : c.cardId)}
                title={st === "unk" ? "미발견 카드" : c.name}
              >
                <div className="dex-thumb">
                  <img src={c.imageUrlThumb || c.imageUrl} alt={st === "unk" ? "미발견" : c.name} loading="lazy" />
                  {st === "unk" && <span className="dex-q">?</span>}
                </div>
                <div className="dex-meta">
                  {st === "unk" ? (
                    <span className="muted">미발견</span>
                  ) : (
                    <>
                      <span className="dex-name">{c.name}</span>
                      {st === "prog" ? (
                        <span className="dex-count">{e!.count}/{DEX_REGISTER_COUNT}</span>
                      ) : (
                        <span className="dex-count reg">등록</span>
                      )}
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
