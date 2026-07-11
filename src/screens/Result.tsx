// F-15 결과 요약 화면 (match:ended) — 순위표(메달·내 행 하이라이트)·내 요약·오늘 만난 카드·
// 등급 분포·최고가 카드·도감 신규 등록 하이라이트·도감 달성률·SBT 보상 받기·마켓/재시작/로비 액션
import { useEffect, useMemo, useRef, useState } from "react";
import { RENAISS_INDEX_BASE, marketUrl, usd } from "../../shared/cards.ts";
import type {
  PlayerSummary,
  RankEntry,
  SbtBadge,
} from "../../shared/protocol.ts";
import { getSocket } from "../net.ts";
import { errText, fmtMs, gameLabel } from "../labels.ts";
import { hasRealPrice } from "../ui.tsx";
import { t, useLang } from "../i18n.ts";
import { avatarFor } from "./Game.tsx";

interface Props {
  ranks: RankEntry[];
  summaries: PlayerSummary[];
  myId: string;
  /** 방이 아직 살아있으면(다시 하기 가능) true */
  canRetry: boolean;
  /** 결과 제목 접두 (예: "포켓몬 고수만 — 게임 결과") */
  roomName?: string;
  onRetry: () => void;
  onLobby: () => void;
  flash: (msg: string) => void;
}

/** 순위 메달(1~3위) 또는 숫자 */
const medal = (rank: number): string =>
  rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : String(rank);

// 로비 사이드바에 표시되는 로컬 통계 카운터(Lobby.tsx 와 동일 키)
const STAT_PLAYS_KEY = "rsk:stats:plays";
const STAT_WINS_KEY = "rsk:stats:wins";

export default function Result({ ranks, summaries, myId, canRetry, roomName, onRetry, onLobby, flash }: Props) {
  const { lang } = useLang();
  const my = summaries.find((s) => s.playerId === myId) ?? null;
  const myRank = ranks.find((r) => r.playerId === myId) ?? null;
  const [claimed, setClaimed] = useState<SbtBadge[]>([]);
  const [claiming, setClaiming] = useState<"pokemon" | "one-piece" | null>(null);
  const [justClaimed, setJustClaimed] = useState<SbtBadge | null>(null);

  const newIds = useMemo(
    () => new Set((my?.dexNewlyRegistered ?? []).map((c) => c.cardId)),
    [my]
  );
  const gradeMax = useMemo(
    () => Math.max(1, ...(my?.gradeDist ?? []).map((g) => g.count)),
    [my]
  );

  // 총 플레이 +1 / (2명 이상 대전에서만) 1위 +1 — 결과 화면 진입 시 1회 집계.
  // 혼자 하기(참가자 1명)의 1위는 승수에 포함하지 않는다(플레이 피드백).
  const countedRef = useRef(false);
  useEffect(() => {
    if (countedRef.current) return;
    countedRef.current = true;
    try {
      const bump = (key: string) => {
        const n = Math.max(0, Math.floor(Number(localStorage.getItem(key)) || 0));
        localStorage.setItem(key, String(n + 1));
      };
      bump(STAT_PLAYS_KEY);
      if (myRank?.rank === 1 && ranks.length > 1) bump(STAT_WINS_KEY);
    } catch {
      /* localStorage 사용 불가 — 무시 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 결과음(win/lose)은 App.tsx onEnded 가 match:ended 수신 즉시 1회 재생한다 (지연·중복 제거).

  function claim(category: "pokemon" | "one-piece") {
    if (claiming) return;
    setClaiming(category);
    getSocket().emit("sbt:claim", { category }, (r) => {
      setClaiming(null);
      if (r.ok && r.data) {
        setClaimed((c) => [...c, r.data!.sbt]);
        setJustClaimed(r.data.sbt);
        window.setTimeout(() => setJustClaimed(null), 2600);
      } else {
        flash(errText(r.error));
      }
    });
  }

  return (
    <div className="screen-3col result-3col">
      {/* ── 좌: 플레이어 ── */}
      <aside className="side-left result-left">
        {ranks.map((r) => (
          <div key={r.playerId} className={`slot-player game-player ${r.playerId === myId ? "me" : ""}`}>
            <div className="avatar">{avatarFor(r.playerId)}</div>
            <div className="sp-name">@{r.nickname}</div>
          </div>
        ))}
      </aside>

      {/* ── 중앙: 순위 테이블 + 액션 + 요약 상세 ── */}
      <div className="screen-center result-center">
        <div className="game-center-head">
          <h2 className="game-title">
            {roomName ? `${roomName} — ` : ""}{myRank?.rank === 1 ? "🏆 " : ""}{t("result.title")}
          </h2>
        </div>

        <div className="panel result-rank-panel">
          <table className="rank-table result-rank">
            <thead>
              <tr>
                <th>{t("result.rank")}</th>
                <th>{t("result.player")}</th>
                <th className="ta-r">{t("result.remaining")}</th>
                <th className="ta-r">{t("game.score")}</th>
              </tr>
            </thead>
            <tbody>
              {ranks.map((r) => (
                <tr key={r.playerId} className={r.playerId === myId ? "me" : ""}>
                  <td className="rk">{medal(r.rank)}</td>
                  <td>
                    @{r.nickname}
                    {r.playerId === myId && <span className="muted"> — {t("game.me")}</span>}
                  </td>
                  <td className="ta-r">{t("result.cards", { count: r.remaining })}</td>
                  <td className="ta-r">{t("result.points", { score: r.score.toLocaleString() })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 결과에서 대기실 복귀와 즉시 퇴장(로비) 모두 제공 (회의 피드백: 결과 → 나가기 동선 추가) */}
        {canRetry ? (
          <>
            <button className="btn btn-accent btn-block result-leave" onClick={onRetry}>
              {t("result.backToWaitingRoom")}
            </button>
            <button className="ghost btn-block result-leave" onClick={onLobby}>
              {t("result.leaveToLobby")}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-accent btn-block result-leave" onClick={onLobby}>
              {t("result.backToLobby")}
            </button>
            <p className="muted small center">{t("result.roomClosed")}</p>
          </>
        )}

        {/* ── 기존 상세 요약(획득 XP·오늘 만난 카드·등급 분포·최고가·도감 신규/달성률·SBT) 보존 ── */}
        {my && myRank && (
          <details className="result-summary" open>
            <summary>{t("result.summary")}</summary>

            <div className="panel">
              <h3>{t("result.myResult")}</h3>
              <div className="sum-cards">
                <div className="sum-card">
                  <span>{t("result.clear")}</span>
                  <b>{t(myRank.cleared ? "result.success" : "result.incomplete")}</b>
                </div>
                <div className="sum-card">
                  <span>{t("game.score")}</span>
                  <b>{myRank.score.toLocaleString()}</b>
                </div>
                <div className="sum-card">
                  <span>{t("result.time")}</span>
                  <b>{fmtMs(myRank.timeMs)}</b>
                </div>
                <div className="sum-card xp">
                  <span>{t("result.xp")}</span>
                  <b>{t("result.xpAmount", { xp: my.xp })}</b>
                </div>
              </div>
            </div>

            <div className="result-cols">
              <div className="result-col">
                {/* 오늘 만난 카드 */}
                <div className="panel">
                  <h3>
                    {t("result.cardsSeen", { count: my.metCards.length })}
                  </h3>
                  {my.metCards.length === 0 ? (
                    <p className="muted">{t("result.noCards")}</p>
                  ) : (
                    <div className="met-grid">
                      {my.metCards.map(({ card, count }) => (
                        <a
                          key={card.cardId}
                          className={`met-card ${newIds.has(card.cardId) ? "new" : ""}`}
                          href={marketUrl(card.href)}
                          target="_blank"
                          rel="noreferrer"
                          title={`${card.name} · ${card.gradeLabel}`}
                        >
                          <img src={card.imageUrlThumb || card.imageUrl} alt={card.name} loading="lazy" />
                          <span className="met-count">×{count}</span>
                          {newIds.has(card.cardId) && <span className="met-new">{t("result.dexNew")}</span>}
                        </a>
                      ))}
                    </div>
                  )}
                  {my.dexNewlyRegistered.length > 0 && (
                    <p className="dex-new-note">
                      {t("result.newlyRegistered")}{" "}
                      <b>{my.dexNewlyRegistered.map((c) => c.name).join(", ")}</b>
                    </p>
                  )}
                </div>

                {/* 등급 분포 */}
                <div className="panel">
                  <h3>{t("result.gradeDistribution")}</h3>
                  {my.gradeDist.length === 0 ? (
                    <p className="muted">{t("result.noData")}</p>
                  ) : (
                    <div className="grade-bars">
                      {my.gradeDist.map((g) => (
                        <div key={g.gradeLabel} className="grade-bar-row">
                          <span className="gb-label">{g.gradeLabel}</span>
                          <div className="gb-track">
                            <span className="gb-fill" style={{ width: `${(g.count / gradeMax) * 100}%` }} />
                          </div>
                          <span className="gb-count">{g.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="attribution">{t("result.attribution")}</p>
                </div>
              </div>

              <div className="result-col">
                {/* 최고가 카드 */}
                {my.topCard && (
                  <div className="panel top-card-panel">
                    <h3>{t("result.topCard")}</h3>
                    <div className="top-card">
                      <img src={my.topCard.imageUrl || my.topCard.imageUrlThumb} alt={my.topCard.name} />
                      <div className="top-card-info">
                        <b className="tc-name">{my.topCard.name}</b>
                        <span className="muted">{my.topCard.setName}</span>
                        <span className="grade">{my.topCard.gradeLabel}</span>
                        <span className="tc-price">
                          {hasRealPrice(my.topCard) ? usd(my.topCard.priceUsdCents) : t("game.sampleData")}
                        </span>
                        <a className="d-src" href={marketUrl(my.topCard.href)} target="_blank" rel="noreferrer">
                          {t("common.indexLink")}
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* 도감 달성률 + SBT 보상 */}
                <div className="panel">
                  <h3>{t("result.dexProgress")}</h3>
                  {(["pokemon", "one-piece"] as const).map((cat) => {
                    const pr = my.dexProgress[cat];
                    const pct = pr.total > 0 ? Math.round((pr.registered / pr.total) * 100) : 0;
                    const hasBadge = claimed.some((s) => s.category === cat);
                    return (
                      <div key={cat} className="dexp-row">
                        <div className="dexp-head">
                          <span className={`badge ${cat}`}>{gameLabel(cat)}</span>
                          <span className="muted">
                            {pr.registered}/{pr.total} ({pct}%)
                          </span>
                          {pr.complete && !hasBadge && (
                            <button className="btn primary sm" disabled={claiming !== null} onClick={() => claim(cat)}>
                              {t("result.claimReward")}
                            </button>
                          )}
                          {hasBadge && <span className="sbt-badge">{t("result.sbtIssued")}</span>}
                        </div>
                        <div className="gb-track big">
                          <span className={`gb-fill ${pr.complete ? "done" : ""}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                  <p className="muted small">{t("result.sbtHint")}</p>
                </div>
              </div>
            </div>

            <div className="result-actions big-row">
              <a className="btn" href={RENAISS_INDEX_BASE} target="_blank" rel="noreferrer">
                {t("result.market")}
              </a>
            </div>
          </details>
        )}
      </div>

      {/* ── 우: 사이드바(게임 레이아웃 유지용 · 종료 상태 dim) ── */}
      <aside className="side-right game-right result-right" aria-hidden="true">
        <div className="rank-box">
          <div className="rank-label">{t("game.currentRank")}</div>
          <div className="rank-value">{myRank ? t("game.rank", { rank: myRank.rank }) : "—"}</div>
        </div>
        <div className="panel side-metrics">
          <div className="side-stat">
            <span className="ss-label">{t("game.tilesLeft")}</span>
            <span className="ss-val">{myRank ? myRank.remaining : 0}</span>
          </div>
          <div className="side-stat">
            <span className="ss-label">{t("game.removable")}</span>
            <span className="ss-val">0</span>
          </div>
        </div>
        <div className="game-items">
          <div className="game-item" aria-disabled="true">
            <span className="gi-top"><span className="key-cap">F1</span> {t("game.search")}</span>
            <span className="gi-sub">{t("result.ended")}</span>
          </div>
          <div className="game-item" aria-disabled="true">
            <span className="gi-top"><span className="key-cap">F2</span> {t("game.shuffle")}</span>
            <span className="gi-sub">{t("result.ended")}</span>
          </div>
          <div className="game-item" aria-disabled="true">
            <span className="gi-top"><span className="key-cap">F3</span> {t("game.scissors")}</span>
            <span className="gi-sub">{t("result.ended")}</span>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-dark btn-block" disabled>{t("game.options")}</button>
        <button className="btn btn-danger btn-block" onClick={canRetry ? onRetry : onLobby}>
          {t(canRetry ? "result.waitingRoom" : "room.leave")}
        </button>
      </aside>

      {/* SBT 발급 연출 */}
      {justClaimed && (
        <div className="overlay sbt-overlay" onClick={() => setJustClaimed(null)}>
          <div className="sbt-pop">
            <div className="sbt-medal">🏅</div>
            <h3>{t("result.dexComplete", { game: gameLabel(justClaimed.category) })}</h3>
            <p>
              {t("result.exclusiveSbtIssued")}
              <br />
              <span className="muted small">
                {t("result.mockIssuedAt", { date: new Date(justClaimed.issuedAt).toLocaleString(lang === "ko" ? "ko-KR" : "en-US") })}
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
