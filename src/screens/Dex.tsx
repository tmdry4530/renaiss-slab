// F-12/13/14 카드 도감 — 포켓몬/원피스 탭, 달성률, 등록/진행/미발견 그리드,
// 상세 패널(이미지 우측 배치 + 하단 간단 정보 + "자세히 보기" → Renaiss 마켓), SBT 뱃지·보상
import { useEffect, useMemo, useRef, useState } from "react";
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
import { t, useLang } from "../i18n.ts";

type Tab = "pokemon" | "one-piece";

const DEX_PAGE_SIZE = 60;

// 페이지 번호 압축 표기: 처음/끝 + 현재 페이지 ±1 + 생략(…)
function pageList(current: number, total: number): (number | "…")[] {
  const keep = new Set<number>([1, total, current]);
  if (current - 1 >= 1) keep.add(current - 1);
  if (current + 1 <= total) keep.add(current + 1);
  const sorted = Array.from(keep).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push("…");
    out.push(sorted[i]);
  }
  return out;
}

interface Props {
  pool: CardPool | null;
  onBack: () => void;
  flash: (msg: string) => void;
}

export default function Dex({ pool, onBack, flash }: Props) {
  const { lang } = useLang();
  const [tab, setTab] = useState<Tab>("pokemon");
  const [entries, setEntries] = useState<Record<string, DexEntry>>({});
  const [progress, setProgress] = useState<DexProgress | null>(null);
  const [sbts, setSbts] = useState<SbtBadge[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [page, setPage] = useState(1);
  const gridRef = useRef<HTMLDivElement>(null);

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

  const totalPages = Math.max(1, Math.ceil(cards.length / DEX_PAGE_SIZE));
  const pageSafe = Math.min(Math.max(1, page), totalPages);
  const pageCards = useMemo(
    () => cards.slice((pageSafe - 1) * DEX_PAGE_SIZE, pageSafe * DEX_PAGE_SIZE),
    [cards, pageSafe]
  );
  const rangeStart = cards.length === 0 ? 0 : (pageSafe - 1) * DEX_PAGE_SIZE + 1;
  const rangeEnd = Math.min(pageSafe * DEX_PAGE_SIZE, cards.length);

  function goToPage(p: number) {
    const clamped = Math.min(Math.max(1, p), totalPages);
    setPage(clamped);
    setSelected(null);
    gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function claim(category: Tab) {
    if (claiming) return;
    setClaiming(true);
    getSocket().emit("sbt:claim", { category }, (r) => {
      setClaiming(false);
      if (r.ok && r.data) {
        setSbts((s) => [...s, r.data!.sbt]);
        flash(t("dex.sbtIssuedToast", { game: gameLabel(category) }));
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
        <h2>{t("dex.title")}</h2>
        <button className="ghost" onClick={onBack}>{t("app.backToLobby")}</button>
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
                setPage(1);
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
            {t("dex.sbtBadge", { game: gameLabel(s.category) })}
            <span className="muted"> · {new Date(s.issuedAt).toLocaleDateString(lang === "ko" ? "ko-KR" : "en-US")}{s.mock ? t("dex.mockIssue") : ""}</span>
          </span>
        ))}
        {progress?.[tab]?.complete && !sbts.some((s) => s.category === tab) && (
          <button className="btn primary sm" disabled={claiming} onClick={() => claim(tab)}>
            {t("dex.claimReward", { game: gameLabel(tab) })}
          </button>
        )}
      </div>

      <p className="muted small">
        {t("dex.hint", { count: DEX_REGISTER_COUNT })}
      </p>

      {!pool && <p className="muted">{t("dex.poolLoading")}</p>}
      {pool && !loaded && <p className="muted">{t("dex.dataLoading")}</p>}

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
                <span className="sample-tag">{t("game.sampleData")}</span>
              )}
            </p>
            <p className="attribution">{t("dex.source")}</p>
            <p className="muted small dd-story">
              {t("dex.story", { set: selectedCard.setName })}
            </p>
            <div className="dd-actions">
              <a className="btn primary" href={marketUrl(selectedCard.href)} target="_blank" rel="noreferrer">
                {t("dex.details")}
              </a>
              <button className="ghost" onClick={() => setSelected(null)}>{t("dex.close")}</button>
            </div>
          </div>
          <div className="dd-image">
            <img src={selectedCard.imageUrl || selectedCard.imageUrlThumb} alt={selectedCard.name} />
          </div>
        </div>
      )}

      {/* 카드 그리드: 등록(컬러 + 테두리/체크) / 진행 중(컬러 + n/10 뱃지) / 미발견(실루엣 ?) */}
      {pool && loaded && (
        <div className="dex-grid" ref={gridRef}>
          {pageCards.map((c) => {
            const st = statusOf(c);
            const e = entries[c.cardId];
            return (
              <button
                key={c.cardId}
                className={`dex-card ${st} ${selected === c.cardId ? "sel" : ""}`}
                disabled={st === "unk"}
                onClick={() => setSelected(selected === c.cardId ? null : c.cardId)}
                title={st === "unk" ? t("dex.undiscoveredCard") : c.name}
              >
                <div className="dex-thumb">
                  <img src={c.imageUrlThumb || c.imageUrl} alt={st === "unk" ? t("dex.undiscovered") : c.name} loading="lazy" />
                  {st === "unk" && <span className="dex-q">?</span>}
                  {st === "prog" && (
                    <span className="dex-progress-badge">{e!.count}/{DEX_REGISTER_COUNT}</span>
                  )}
                  {st === "reg" && <span className="dex-reg-badge">✓</span>}
                </div>
                <div className="dex-meta">
                  {st === "unk" ? (
                    <span className="muted">{t("dex.undiscovered")}</span>
                  ) : (
                    <>
                      <span className="dex-name">{c.name}</span>
                      {st === "prog" ? (
                        <span className="dex-count">{e!.count}/{DEX_REGISTER_COUNT}</span>
                      ) : (
                        <span className="dex-count reg">{t("dex.registered")}</span>
                      )}
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 페이지네이션: 압축 표기(처음/끝 + 현재 ±1 + …) */}
      {pool && loaded && (
        <>
          {totalPages > 1 && (
            <div className="dex-pagination">
              <button
                className="ghost"
                disabled={pageSafe <= 1}
                onClick={() => goToPage(pageSafe - 1)}
              >
                {t("dex.previous")}
              </button>
              <div className="dex-page-nums">
                {pageList(pageSafe, totalPages).map((p, i) =>
                  p === "…" ? (
                    <span key={`e${i}`} className="dex-page-ellipsis">…</span>
                  ) : (
                    <button
                      key={p}
                      className={`dex-page-btn ${p === pageSafe ? "on" : ""}`}
                      onClick={() => goToPage(p)}
                    >
                      {p}
                    </button>
                  )
                )}
              </div>
              <button
                className="ghost"
                disabled={pageSafe >= totalPages}
                onClick={() => goToPage(pageSafe + 1)}
              >
                {t("dex.next")}
              </button>
            </div>
          )}
          <p className="muted small dex-page-info">
            {t("dex.pageInfo", { start: rangeStart, end: rangeEnd, total: cards.length })}
          </p>
        </>
      )}
    </section>
  );
}
