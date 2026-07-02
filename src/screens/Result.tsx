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
            {roomName ? `${roomName} — ` : ""}{myRank?.rank === 1 ? "🏆 " : ""}게임 결과
          </h2>
        </div>

        <div className="panel result-rank-panel">
          <table className="rank-table result-rank">
            <thead>
              <tr>
                <th>순위</th>
                <th>아이디</th>
                <th className="ta-r">남은 수량</th>
                <th className="ta-r">점수</th>
              </tr>
            </thead>
            <tbody>
              {ranks.map((r) => (
                <tr key={r.playerId} className={r.playerId === myId ? "me" : ""}>
                  <td className="rk">{medal(r.rank)}</td>
                  <td>
                    @{r.nickname}
                    {r.playerId === myId && <span className="muted"> — 나</span>}
                  </td>
                  <td className="ta-r"><b>{r.remaining}</b>장</td>
                  <td className="ta-r"><b>{r.score.toLocaleString()}</b>점</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 퇴장은 대기실을 거쳐서만 — 결과 → 대기실 → (대기실의 나가기) → 로비 (플레이 피드백) */}
        {canRetry ? (
          <button className="btn btn-accent btn-block result-leave" onClick={onRetry}>
            🏠 대기실로 돌아가기
          </button>
        ) : (
          <>
            <button className="btn btn-accent btn-block result-leave" onClick={onLobby}>
              로비로 나가기
            </button>
            <p className="muted small center">방이 닫혀 다시 하기를 할 수 없어요 — 로비에서 새 방을 만들어 주세요.</p>
          </>
        )}

        {/* ── 기존 상세 요약(획득 XP·오늘 만난 카드·등급 분포·최고가·도감 신규/달성률·SBT) 보존 ── */}
        {my && myRank && (
          <details className="result-summary" open>
            <summary>결과 요약</summary>

            <div className="panel">
              <h3>내 결과</h3>
              <div className="sum-cards">
                <div className="sum-card">
                  <span>클리어</span>
                  <b>{myRank.cleared ? "성공 🎉" : "미완료"}</b>
                </div>
                <div className="sum-card">
                  <span>점수</span>
                  <b>{myRank.score.toLocaleString()}</b>
                </div>
                <div className="sum-card">
                  <span>소요 시간</span>
                  <b>{fmtMs(myRank.timeMs)}</b>
                </div>
                <div className="sum-card xp">
                  <span>획득 경험치</span>
                  <b>+{my.xp} XP</b>
                </div>
              </div>
            </div>

            <div className="result-cols">
              <div className="result-col">
                {/* 오늘 만난 카드 */}
                <div className="panel">
                  <h3>
                    오늘 만난 카드 <span className="muted">({my.metCards.length}종)</span>
                  </h3>
                  {my.metCards.length === 0 ? (
                    <p className="muted">이번 판에는 제거한 카드가 없어요.</p>
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
                          {newIds.has(card.cardId) && <span className="met-new">도감 NEW</span>}
                        </a>
                      ))}
                    </div>
                  )}
                  {my.dexNewlyRegistered.length > 0 && (
                    <p className="dex-new-note">
                      📖 이번 판으로 도감에 새로 등록:{" "}
                      <b>{my.dexNewlyRegistered.map((c) => c.name).join(", ")}</b>
                    </p>
                  )}
                </div>

                {/* 등급 분포 */}
                <div className="panel">
                  <h3>등급 분포</h3>
                  {my.gradeDist.length === 0 ? (
                    <p className="muted">데이터 없음</p>
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
                  <p className="attribution">등급·가격 출처: Renaiss OS Index (임의 생성 없음)</p>
                </div>
              </div>

              <div className="result-col">
                {/* 최고가 카드 */}
                {my.topCard && (
                  <div className="panel top-card-panel">
                    <h3>오늘 만난 최고가 카드</h3>
                    <div className="top-card">
                      <img src={my.topCard.imageUrl || my.topCard.imageUrlThumb} alt={my.topCard.name} />
                      <div className="top-card-info">
                        <b className="tc-name">{my.topCard.name}</b>
                        <span className="muted">{my.topCard.setName}</span>
                        <span className="grade">{my.topCard.gradeLabel}</span>
                        <span className="tc-price">
                          {hasRealPrice(my.topCard) ? usd(my.topCard.priceUsdCents) : "예시 데이터"}
                        </span>
                        <a className="d-src" href={marketUrl(my.topCard.href)} target="_blank" rel="noreferrer">
                          Renaiss OS Index ↗
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* 도감 달성률 + SBT 보상 */}
                <div className="panel">
                  <h3>도감 달성률</h3>
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
                              🏅 보상 받기
                            </button>
                          )}
                          {hasBadge && <span className="sbt-badge">🏅 SBT 발급 완료</span>}
                        </div>
                        <div className="gb-track big">
                          <span className={`gb-fill ${pr.complete ? "done" : ""}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                  <p className="muted small">카테고리 도감 100% 달성 시 전용 SBT(데모: 목 발급)를 받을 수 있어요.</p>
                </div>
              </div>
            </div>

            <div className="result-actions big-row">
              <a className="btn" href={RENAISS_INDEX_BASE} target="_blank" rel="noreferrer">
                🛒 마켓 구경하기
              </a>
            </div>
          </details>
        )}
      </div>

      {/* ── 우: 사이드바(게임 레이아웃 유지용 · 종료 상태 dim) ── */}
      <aside className="side-right game-right result-right" aria-hidden="true">
        <div className="rank-box">
          <div className="rank-label">현재 등수</div>
          <div className="rank-value">{myRank ? `${myRank.rank}위` : "—"}</div>
        </div>
        <div className="panel side-metrics">
          <div className="side-stat">
            <span className="ss-label">남은 패</span>
            <span className="ss-val">{myRank ? myRank.remaining : 0}</span>
          </div>
          <div className="side-stat">
            <span className="ss-label">소거가능</span>
            <span className="ss-val">0</span>
          </div>
        </div>
        <div className="game-items">
          <div className="game-item" aria-disabled="true">
            <span className="gi-top"><span className="key-cap">F1</span> 🔍 서치</span>
            <span className="gi-sub">종료</span>
          </div>
          <div className="game-item" aria-disabled="true">
            <span className="gi-top"><span className="key-cap">F2</span> 🔀 패 섞기</span>
            <span className="gi-sub">종료</span>
          </div>
          <div className="game-item" aria-disabled="true">
            <span className="gi-top"><span className="key-cap">F3</span> ✂️ 가위</span>
            <span className="gi-sub">종료</span>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-dark btn-block" disabled>옵션</button>
        <button className="btn btn-danger btn-block" onClick={canRetry ? onRetry : onLobby}>
          {canRetry ? "대기실로" : "나가기"}
        </button>
      </aside>

      {/* SBT 발급 연출 */}
      {justClaimed && (
        <div className="overlay sbt-overlay" onClick={() => setJustClaimed(null)}>
          <div className="sbt-pop">
            <div className="sbt-medal">🏅</div>
            <h3>{gameLabel(justClaimed.category)} 도감 완성!</h3>
            <p>
              전용 SBT가 발급되었습니다
              <br />
              <span className="muted small">
                {new Date(justClaimed.issuedAt).toLocaleString("ko-KR")} · 데모 목 발급
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
