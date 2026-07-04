// F-07~F-10 게임 화면 — 서버 권위 구조:
// board:init 스냅샷으로 렌더하고, 클릭 2개는 tile:match 로 전송만 한다 (낙관적 선판정 없음).
// tile:matched/rejected/board:update/player:progress/match:finishing 수신으로만 상태를 갱신한다.
// 기존 GameScreen 의 연출(연결선 폴리라인·vanish 잔상·+점수 팝·도슨트 토스트·notice)을 이식.
import { useEffect, useMemo, useRef, useState } from "react";
import type { GameCard } from "../../shared/cards.ts";
import { marketUrl, usd } from "../../shared/cards.ts";
import {
  COMBO_WINDOW_MS,
  ITEM_QUOTA,
  type BoardInit,
  type ComboPower,
  type ItemType,
  type MapMode,
  type RoomDetail,
  type ServerToClient,
  type TileState,
} from "../../shared/protocol.ts";
import { getSocket } from "../net.ts";
import { errText, modeLabel } from "../labels.ts";
import { hasRealPrice } from "../ui.tsx";
import { findPath } from "../../shared/shisen.ts";
import { audio } from "../audio.ts";

interface Props {
  init: BoardInit;
  room: RoomDetail | null;
  myId: string;
}

const ASPECT = 1.4;

interface Vanish { id: number; card: GameCard; r: number; c: number; layer: number }
interface Pop { id: number; x: number; y: number; text: string }
interface Progress { remaining: number; score: number; combo: number }

/**
 * 상하이 free 판정 — shared/board.isTileFree 와 동일 규칙을
 * 프로토콜 TileState 배열만으로 판정하는 클라이언트 헬퍼 (직접 구현).
 * 같은 (r,c) 위에 layer+1 의 미제거 타일이 있으면 잠김.
 */
export function isFreeState(all: TileState[], t: TileState, mapMode: MapMode): boolean {
  if (t.removed) return false;
  if (mapMode !== "shanghai") return true;
  return !all.some((o) => !o.removed && o.layer === t.layer + 1 && o.r === t.r && o.c === t.c);
}

/**
 * 소거가능(연결 가능한 짝) 수 — 클라이언트 그리디 카운트.
 * shared/shisen.findPath 로 현재 free·미제거 타일 중 서로 연결되는 짝을 세되,
 * 한 타일은 한 짝에만 쓰이도록 그리디로 소비한다(보드 ≤ ~100 이라 허용).
 * grid: 패딩 포함 점유 격자(true=타일 있음). 테두리는 false 로 우회 경로 허용.
 */
export function countRemovable(
  all: TileState[],
  cols: number,
  rows: number,
  mapMode: MapMode,
  keyOf: (t: TileState) => string
): number {
  const R = rows + 2;
  const C = cols + 2;
  const grid: boolean[][] = Array.from({ length: R }, () => new Array(C).fill(false));
  for (const t of all) if (!t.removed) grid[t.r][t.c] = true;

  const free = all.filter((t) => !t.removed && isFreeState(all, t, mapMode));
  const byKey = new Map<string, TileState[]>();
  for (const t of free) {
    const k = keyOf(t);
    const g = byKey.get(k);
    if (g) g.push(t);
    else byKey.set(k, [t]);
  }

  let count = 0;
  const used = new Set<number>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (used.has(group[i].tileId)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(group[j].tileId)) continue;
        const a = { r: group[i].r, c: group[i].c };
        const b = { r: group[j].r, c: group[j].c };
        if (findPath(grid, a, b)) {
          used.add(group[i].tileId);
          used.add(group[j].tileId);
          count++;
          break;
        }
      }
    }
  }
  return count;
}

/** 플레이어 아바타 이모지(장식용, playerId 해시로 결정). */
const AVATAR_SET = ["🐵", "🐲", "🦊", "⭐", "🐱", "🐶", "🐼", "🦁", "🐸", "🐯", "🦄", "🐧"];
export function avatarFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_SET[h % AVATAR_SET.length];
}

function useViewport() {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return vp;
}

export default function Game({ init, room, myId }: Props) {
  const cards = init.cards;
  const cardOf = (t: TileState): GameCard => cards[t.cardIdx];

  // ── 보드/플레이 상태 (전부 서버 수신 기준) ───────────────────
  const [tiles, setTiles] = useState<TileState[]>(init.tiles);
  const [reserveRows, setReserveRows] = useState(init.reserveRows ?? 0);
  const [sel, setSel] = useState<number | null>(null);
  const [pending, setPending] = useState<[number, number] | null>(null); // 서버 응답 대기 중인 쌍
  const [shake, setShake] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<[number, number] | null>(null); // 서치 하이라이트
  const [line, setLine] = useState<{ r: number; c: number }[] | null>(null);
  const [lineKey, setLineKey] = useState(0);
  const [vanishing, setVanishing] = useState<Vanish[]>([]);
  const [pops, setPops] = useState<Pop[]>([]);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [comboKey, setComboKey] = useState(0); // 콤보 바 리스타트용
  const [seconds, setSeconds] = useState(0);
  const [toast, setToast] = useState<GameCard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<Record<ItemType, number>>({ ...ITEM_QUOTA });
  const [scissorOn, setScissorOn] = useState(false);
  const [power, setPower] = useState<ComboPower | null>(null); // 콤보 파워 지정 대기
  const [finishing, setFinishing] = useState<{ nickname: string; sec: number } | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [muted, setMuted] = useState(audio.isMuted);

  const tilesRef = useRef(tiles);
  const pendingRef = useRef<[number, number] | null>(null);
  const comboRef = useRef(0);
  const seq = useRef(0);
  const noticeTimer = useRef(0);
  const toastTimer = useRef(0);
  const hlTimer = useRef(0);
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);
  useEffect(() => {
    comboRef.current = combo;
  }, [combo]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 1600);
  };
  const showToast = (card: GameCard) => {
    setToast(card);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };
  const pushVanish = (vs: Vanish[]) => {
    setVanishing((v) => [...v, ...vs]);
    const ids = vs.map((x) => x.id);
    window.setTimeout(() => setVanishing((v) => v.filter((x) => !ids.includes(x.id))), 380);
  };
  const pushPop = (x: number, y: number, text: string) => {
    const id = ++seq.current;
    setPops((p) => [...p, { id, x, y, text }]);
    window.setTimeout(() => setPops((p) => p.filter((q) => q.id !== id)), 760);
  };
  const syncCombo = (v: number) => {
    if (v !== comboRef.current) {
      setCombo(v);
      if (v > 0) setComboKey((k) => k + 1);
    }
  };

  // ── 레이아웃 ────────────────────────────────────────────────
  const vp = useViewport();
  // 3컬럼 셸: 좌 플레이어(150) + 우 사이드바(168) + 중앙 여백 → 보드 가용 폭 산출
  const availW = vp.w - 150 - 168 - 72;
  const availH = vp.h - 120;
  const cellW = Math.round(
    Math.max(42, Math.min(150, Math.min(availW / init.cols, availH / (init.rows * ASPECT))))
  );
  const cellH = Math.round(cellW * ASPECT);
  const boardW = init.cols * cellW;
  const boardH = init.rows * cellH;
  const center = (r: number, c: number) => ({ x: (c - 1 + 0.5) * cellW, y: (r - 1 + 0.5) * cellH });

  // 마스크로 빈 칸이 있는 비사각형 보드: 초기 layer 0 타일 위치 = 유효 슬롯
  const baseCells = useMemo(() => {
    const seen = new Set<string>();
    const cells: { r: number; c: number }[] = [];
    for (const t of init.tiles) {
      if (t.layer !== 0) continue;
      const k = `${t.r},${t.c}`;
      if (!seen.has(k)) {
        seen.add(k);
        cells.push({ r: t.r, c: t.c });
      }
    }
    return cells;
  }, [init]);

  // ── 소켓 수신 ───────────────────────────────────────────────
  useEffect(() => {
    const s = getSocket();

    const onMatched: ServerToClient["tile:matched"] = (p) => {
      const cur = tilesRef.current;
      const a = cur.find((t) => t.tileId === p.tileA);
      const b = cur.find((t) => t.tileId === p.tileB);
      pendingRef.current = null;
      setPending(null);
      setSel(null);
      if (a && b) {
        pushVanish([
          { id: ++seq.current, card: cardOf(a), r: a.r, c: a.c, layer: a.layer },
          { id: ++seq.current, card: cardOf(b), r: b.r, c: b.c, layer: b.layer },
        ]);
        if (p.path.length > 0) {
          setLine(p.path);
          setLineKey((k) => k + 1);
          window.setTimeout(() => setLine(null), 520);
        }
        const mid = center((a.r + b.r) / 2, (a.c + b.c) / 2);
        pushPop(mid.x, mid.y, `+${p.scoreDelta}${p.combo >= 2 ? ` ×${p.combo}` : ""}`);
        showToast(cardOf(b)); // 카드 제거 도슨트 (1단계 정보)
      }
      setTiles((ts) => ts.map((t) => (t.tileId === p.tileA || t.tileId === p.tileB ? { ...t, removed: true } : t)));
      setScore((v) => v + p.scoreDelta);
      syncCombo(p.combo);
      // 콤보파워 발동(5·15=pair, 10·20=clear) 시 combo5/combo10, 아니면 콤보 배수(5·10회차) 또는 기본 매치음
      if (p.comboPower) {
        audio.playSound(p.comboPower.kind === "clear" ? "combo10" : "combo5");
      } else if (p.combo > 0 && p.combo % 10 === 0) {
        audio.playSound("combo10");
      } else if (p.combo > 0 && p.combo % 5 === 0) {
        audio.playSound("combo5");
      } else {
        audio.playSound("match");
      }
      if (p.comboPower) setPower(p.comboPower);
      if (p.dexUnlocked && p.dexUnlocked.length > 0) {
        const names = p.dexUnlocked.map((id) => cards.find((c) => c.cardId === id)?.name ?? id).join(", ");
        flash(`📖 도감 등록! ${names}`);
      }
    };

    const onRejected: ServerToClient["tile:rejected"] = () => {
      const pend = pendingRef.current;
      pendingRef.current = null;
      setPending(null);
      setSel(null);
      if (pend) {
        setShake(pend[1]);
        window.setTimeout(() => setShake(null), 400);
      }
      syncCombo(0); // 매칭 실패 → 콤보 리셋 (서버 규칙과 동일)
      audio.playSound("fail");
    };

    const onBoardUpdate: ServerToClient["board:update"] = (p) => {
      const prev = tilesRef.current;
      if (p.reason === "combo" || p.reason === "scissor") {
        // 일괄 제거 연출: 새 스냅샷과 비교해 사라진 타일에 vanish 잔상
        const next = new Map(p.tiles.map((t) => [t.tileId, t] as const));
        const gone = prev.filter((t) => !t.removed && (next.get(t.tileId)?.removed ?? true));
        if (gone.length > 0) {
          pushVanish(
            gone.map((t) => ({ id: ++seq.current, card: cardOf(t), r: t.r, c: t.c, layer: t.layer }))
          );
        }
      }
      setTiles(p.tiles);
      if (p.reserveRows !== undefined) setReserveRows(p.reserveRows);
      if (p.reason === "up") flash("⬆ 한 줄 상승!");
      else if (p.reason === "shuffle" || p.reason === "reshuffle")
        flash(p.reason === "reshuffle" ? "막혔어요 — 자동으로 카드를 섞었습니다" : "카드를 섞었습니다");
      else if (p.reason === "scissor") flash("✂️ 가위로 짝을 제거했습니다");
      else if (p.reason === "combo") flash("⚡ 콤보 효과 발동!");
      // rolling 은 CSS 트랜지션으로 부드럽게 이동 (별도 노티 없음)
    };

    const onProgress: ServerToClient["player:progress"] = (p) => {
      setProgress((m) => ({ ...m, [p.playerId]: { remaining: p.remaining, score: p.score, combo: p.combo } }));
      if (p.playerId === myId) {
        setScore(p.score); // 서버 점수를 권위로 동기화 (콤보 파워·가위 점수 포함)
        syncCombo(p.combo);
      }
    };

    const onFinishing: ServerToClient["match:finishing"] = (p) => {
      setFinishing({ nickname: p.winnerNickname, sec: p.countdownSec });
    };

    s.on("tile:matched", onMatched);
    s.on("tile:rejected", onRejected);
    s.on("board:update", onBoardUpdate);
    s.on("player:progress", onProgress);
    s.on("match:finishing", onFinishing);
    return () => {
      s.off("tile:matched", onMatched);
      s.off("tile:rejected", onRejected);
      s.off("board:update", onBoardUpdate);
      s.off("player:progress", onProgress);
      s.off("match:finishing", onFinishing);
    };
    // eslint 없음 — 마운트 시 1회 등록 (cards/myId 는 게임 동안 불변)
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 경과 시간
  useEffect(() => {
    const startAt = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - startAt) / 1000)), 500);
    return () => window.clearInterval(id);
  }, []);

  // BGM — 게임 화면 진입 시 시작, 결과/종료 등으로 화면을 떠나면(언마운트) 정지
  useEffect(() => {
    audio.startBgm();
    return () => audio.stopBgm();
  }, []);

  // 콤보 창(COMBO_WINDOW_MS) 만료 → 표시 리셋
  useEffect(() => {
    if (combo <= 0) return;
    const id = window.setTimeout(() => setCombo(0), COMBO_WINDOW_MS);
    return () => window.clearTimeout(id);
  }, [combo, comboKey]);

  // 1위 확정 카운트다운
  useEffect(() => {
    if (!finishing) return;
    const id = window.setInterval(() => {
      setFinishing((f) => (f ? { ...f, sec: Math.max(0, f.sec - 1) } : f));
    }, 1000);
    return () => window.clearInterval(id);
  }, [finishing?.nickname]); // eslint-disable-line react-hooks/exhaustive-deps

  // ESC — 가위/콤보 지정/선택 취소
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPower(null);
      setScissorOn(false);
      setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── 타일 클릭 ───────────────────────────────────────────────
  function onTile(t: TileState) {
    if (t.removed || !isFreeState(tiles, t, init.mapMode)) return;
    audio.playSound("select"); // 카드 클릭 — 짧고 가벼운 틱

    // 콤보 파워 지정 모드: 클릭한 카드로 발동
    if (power) {
      if (t.victory) {
        flash("승리 카드는 콤보 파워로 제거할 수 없어요"); // 파워 유지 — 다른 카드 지정 가능
        return;
      }
      getSocket().emit("combo:power", { cardId: cardOf(t).cardId }, (r) => {
        if (!r.ok) flash(errText(r.error));
      });
      setPower(null);
      return;
    }

    // 가위 모드: 카드 1장 클릭 → 같은 matchKey 의 다른 free·미제거 타일을 자동으로 찾아 짝 제거
    if (scissorOn) {
      if (t.victory) {
        flash("승리 카드는 가위로 제거할 수 없어요"); // 모드 유지 — 다른 카드 클릭 가능
        return;
      }
      const other = tiles.find(
        (x) =>
          x.tileId !== t.tileId &&
          !x.removed &&
          isFreeState(tiles, x, init.mapMode) &&
          cardOf(x).matchKey === cardOf(t).matchKey
      );
      if (!other) {
        flash("제거할 짝을 찾을 수 없어요"); // 모드 유지 — 다른 카드 클릭 가능
        return;
      }
      const pair: [number, number] = [t.tileId, other.tileId];
      audio.playSound("item"); // 가위 사용 — 스와이프/휘릭
      setItems((it) => ({ ...it, scissor: it.scissor - 1 })); // 낙관적 즉시 차감
      getSocket().emit("item:use", { type: "scissor", tiles: pair }, (r) => {
        if (r.data?.items) setItems(r.data.items); // 서버 권위 잔량으로 동기화
        else if (!r.ok) setItems((it) => ({ ...it, scissor: it.scissor + 1 })); // 실패 + items 미반환 → 복구
        if (!r.ok) flash(errText(r.error));
      });
      setScissorOn(false);
      return;
    }

    // 일반 매칭: 두 번째 클릭에서 서버로 전송 (판정은 전적으로 서버)
    if (pending) return; // 서버 응답 대기 중
    if (sel === null) {
      setSel(t.tileId);
      return;
    }
    if (sel === t.tileId) {
      setSel(null);
      return;
    }
    const a = tiles.find((x) => x.tileId === sel);
    if (!a) {
      setSel(t.tileId);
      return;
    }
    if (cardOf(a).matchKey !== cardOf(t).matchKey) {
      // 다른 카드는 선택 이동 (경로 선판정은 하지 않음)
      setSel(t.tileId);
      return;
    }
    const pair: [number, number] = [sel, t.tileId];
    pendingRef.current = pair;
    setPending(pair);
    getSocket().emit("tile:match", { tileA: pair[0], tileB: pair[1] });
  }

  // ── 아이템 ──────────────────────────────────────────────────
  function useSimpleItem(type: "search" | "shuffle") {
    if (items[type] <= 0) return;
    audio.playSound("item"); // 아이템 사용 — 스와이프/휘릭
    setItems((it) => ({ ...it, [type]: it[type] - 1 })); // 낙관적 즉시 차감 (개수 0이면 버튼 즉시 비활성)
    getSocket().emit("item:use", { type }, (r) => {
      // 서버 권위 잔량으로 최종 동기화(이중 차감 방지). items 미반환(가드 실패 등) + 실패면 낙관적 차감 복구.
      if (r.data?.items) setItems(r.data.items);
      else if (!r.ok) setItems((it) => ({ ...it, [type]: it[type] + 1 }));
      if (!r.ok) {
        flash(errText(r.error));
        return;
      }
      if (type === "search" && r.data?.highlight) {
        setHighlight(r.data.highlight);
        window.clearTimeout(hlTimer.current);
        hlTimer.current = window.setTimeout(() => setHighlight(null), 1800);
      }
      // shuffle 결과는 board:update(reason:"shuffle") 로 반영된다.
    });
  }

  function toggleScissor() {
    if (scissorOn) {
      setScissorOn(false);
      return;
    }
    if (items.scissor <= 0) {
      flash("가위를 모두 사용했어요");
      return;
    }
    setSel(null);
    setPower(null);
    setScissorOn(true);
  }

  // ── 아이템 단축키 (F1 서치 · F2 섞기 · F3 가위, 별칭 5/6/7·1/2/3) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      let action: "search" | "shuffle" | "scissor" | null = null;
      switch (e.key) {
        case "F1": case "5": case "1": action = "search"; break;
        case "F2": case "6": case "2": action = "shuffle"; break;
        case "F3": case "7": case "3": action = "scissor"; break;
      }
      if (!action) return;
      e.preventDefault(); // F1 브라우저 도움말 등 기본 동작 차단
      if (action === "scissor") toggleScissor();
      else useSimpleItem(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, scissorOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 렌더 ────────────────────────────────────────────────────
  const live = tiles.filter((t) => !t.removed);
  const remaining = live.length;
  const ordered = [...live].sort((a, b) => a.layer - b.layer || a.tileId - b.tileId);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const linePts = line
    ? line.map((p) => {
        const { x, y } = center(p.r, p.c);
        return `${x},${y}`;
      }).join(" ")
    : "";

  // 소거가능(연결 가능한 짝) — tiles 변할 때만 재계산
  const removable = useMemo(
    () => countRemovable(tiles, init.cols, init.rows, init.mapMode, (t) => cardOf(t).matchKey),
    [tiles] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // 현재 예상 등수 — 남은 패 적을수록 상위, 동률이면 점수 높을수록 상위
  const players = room?.players ?? [];
  const standings = players.map((p) =>
    p.playerId === myId
      ? { id: myId, remaining, score }
      : {
          id: p.playerId,
          remaining: progress[p.playerId]?.remaining ?? p.remaining,
          score: progress[p.playerId]?.score ?? p.score,
        }
  );
  const myStand = standings.find((s) => s.id === myId);
  const myRank = myStand
    ? 1 +
      standings.filter(
        (o) =>
          o.id !== myId &&
          (o.remaining < myStand.remaining ||
            (o.remaining === myStand.remaining && o.score > myStand.score))
      ).length
    : null;

  const centerTitle = room?.name ?? modeLabel(init.mapMode);

  return (
    <div className="screen-3col game-3col">
      {/* ── 좌: 플레이어(상대 미니뷰 통합) ── */}
      <aside className="side-left game-left">
        {players.length === 0 && (
          <div className="slot-player">
            <div className="avatar">{avatarFor(myId)}</div>
            <div className="sp-name">나</div>
          </div>
        )}
        {players.map((p) => {
          const isMe = p.playerId === myId;
          const pr = progress[p.playerId] ?? { remaining: p.remaining, score: p.score, combo: p.combo };
          return (
            <div key={p.playerId} className={`slot-player game-player ${isMe ? "me" : ""}`}>
              <div className="avatar">{avatarFor(p.playerId)}</div>
              <div className="sp-name">@{p.nickname}</div>
              {p.isHost && <span className="chip host game-host-chip">방장</span>}
              {!isMe && (
                <div className="gp-mini" title={`남은 ${pr.remaining} · 점수 ${pr.score}`}>
                  <span>남은 {pr.remaining}</span>
                  {!p.connected && <span className="pc-off">끊김</span>}
                  {p.finishedRank === 1 && <span> 🏆</span>}
                </div>
              )}
            </div>
          );
        })}
      </aside>

      {/* ── 중앙: 제목 + 보드 ── */}
      <div className="screen-center game-center">
        <div className="game-center-head">
          <h2 className="game-title">{centerTitle}</h2>
          <div className="game-title-tags">
            <span className={`tag ${init.mapMode}`}>{modeLabel(init.mapMode)}</span>
            {init.mapMode === "up" && <span className="tag reserve-tag">남은 줄 {reserveRows}</span>}
          </div>
        </div>

        {/* 모드 배너: 콤보 파워 지정 / 가위 대상 지정 */}
        {power && (
          <div className="mode-banner power">
            ⚡ {power.level}콤보!{" "}
            {power.kind === "pair"
              ? "카드를 지정하면 짝이 제거됩니다"
              : "카드를 지정하면 동일 카드 전체가 제거됩니다"}
            <button className="banner-cancel" onClick={() => setPower(null)}>취소</button>
          </div>
        )}
        {scissorOn && !power && (
          <div className="mode-banner scissor">
            ✂️ 가위 — 제거할 카드 1장을 선택하세요
            <button className="banner-cancel" onClick={toggleScissor}>취소</button>
          </div>
        )}

        <div className="board-wrap">
          <div className="gboard" style={{ width: boardW, height: boardH }}>
            {/* 마스크 유효 칸(빈 slot) 표시 */}
            {baseCells.map((cell) => (
              <div
                key={`bg-${cell.r}-${cell.c}`}
                className="slot-bg"
                style={{ left: (cell.c - 1) * cellW, top: (cell.r - 1) * cellH, width: cellW, height: cellH }}
              />
            ))}

            {ordered.map((t) => {
              const card = cardOf(t);
              const free = isFreeState(tiles, t, init.mapMode);
              const isSel =
                sel === t.tileId ||
                (pending !== null && (pending[0] === t.tileId || pending[1] === t.tileId));
              const isHl = highlight !== null && (highlight[0] === t.tileId || highlight[1] === t.tileId);
              return (
                <button
                  key={t.tileId}
                  className={[
                    "gtile",
                    t.layer > 0 ? "layer1" : "",
                    !free ? "covered" : "",
                    isSel ? "sel" : "",
                    isHl ? "hint" : "",
                    shake === t.tileId ? "shake" : "",
                    t.victory ? "victory" : "",
                    (power || scissorOn) && free ? "targeting" : "",
                  ].filter(Boolean).join(" ")}
                  style={{ left: (t.c - 1) * cellW, top: (t.r - 1) * cellH, width: cellW, height: cellH }}
                  disabled={!free}
                  onClick={() => onTile(t)}
                  title={t.victory ? "승리 카드" : `${card.name} · ${card.gradeLabel}`}
                >
                  {t.victory ? (
                    <span className="victory-face" style={{ fontSize: Math.round(cellH * 0.5) }}>승</span>
                  ) : (
                    <img src={card.imageUrlThumb || card.imageUrl} alt={card.name} draggable={false} />
                  )}
                  {t.victory && <span className="crown">👑</span>}
                </button>
              );
            })}

            {/* 제거 팝 잔상 */}
            {vanishing.map((v) => (
              <div
                key={v.id}
                className={`vanish ${v.layer > 0 ? "layer1" : ""}`}
                style={{ left: (v.c - 1) * cellW, top: (v.r - 1) * cellH, width: cellW, height: cellH }}
              >
                {v.card.imageUrlThumb || v.card.imageUrl ? (
                  <img src={v.card.imageUrlThumb || v.card.imageUrl} alt="" />
                ) : (
                  <span className="victory-face" style={{ fontSize: Math.round(cellH * 0.5) }}>승</span>
                )}
              </div>
            ))}

            {/* +점수 팝업 */}
            {pops.map((p) => (
              <div key={p.id} className="pop" style={{ left: p.x, top: p.y }}>{p.text}</div>
            ))}

            {/* 연결선 (서버가 내려준 path) */}
            {line && (
              <svg key={lineKey} className="link-line" style={{ width: boardW, height: boardH }}>
                <polyline
                  className="draw"
                  points={linePts}
                  pathLength={1}
                  fill="none"
                  stroke="#6ea8fe"
                  strokeWidth={Math.max(4, cellW * 0.09)}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </div>
        </div>
      </div>

      {/* ── 우: 사이드바(등수/패/소거/아이템/점수·시간) ── */}
      <aside className="side-right game-right">
        <div className="rank-box">
          <div className="rank-label">현재 등수</div>
          <div className="rank-value">{myRank !== null ? `${myRank}위` : "—"}</div>
        </div>

        <div className="panel side-metrics">
          <div className="side-stat">
            <span className="ss-label">남은 패</span>
            <span className="ss-val">{remaining}</span>
          </div>
          <div className="side-stat">
            <span className="ss-label">소거가능</span>
            <span className="ss-val green">{removable}</span>
          </div>
        </div>

        <div className="game-items">
          <button
            className="game-item"
            disabled={items.search <= 0}
            onClick={() => useSimpleItem("search")}
          >
            <span className="gi-top"><span className="key-cap">F1</span> 🔍 서치</span>
            <span className="gi-sub">남은 횟수 {items.search}</span>
          </button>
          <button
            className="game-item"
            disabled={items.shuffle <= 0}
            onClick={() => useSimpleItem("shuffle")}
          >
            <span className="gi-top"><span className="key-cap">F2</span> 🔀 패 섞기</span>
            <span className="gi-sub">남은 횟수 {items.shuffle}</span>
          </button>
          <button
            className={`game-item ${scissorOn ? "on" : ""}`}
            disabled={items.scissor <= 0 && !scissorOn}
            onClick={toggleScissor}
          >
            <span className="gi-top"><span className="key-cap">F3</span> ✂️ 가위</span>
            <span className="gi-sub">남은 횟수 {items.scissor}</span>
          </button>
        </div>

        <div className="panel side-metrics side-score">
          <div className="side-stat">
            <span className="ss-label">점수</span>
            <span className="ss-val" key={score} ><span className="score-bump">{score.toLocaleString()}</span></span>
          </div>
          <div className="side-stat">
            <span className="ss-label">시간</span>
            <span className="ss-val">{mm}:{ss}</span>
          </div>
          {combo > 0 && (
            <div className="side-combo" key={comboKey}>
              <span className="combo">{combo} 콤보!</span>
              <span className="combo-bar" style={{ animationDuration: `${COMBO_WINDOW_MS}ms` }} />
            </div>
          )}
        </div>

        <div className="spacer" />
        <button
          className="btn btn-dark btn-block mute-btn"
          onClick={() => setMuted(audio.toggleMute())}
          title={muted ? "음소거 해제" : "음소거"}
        >
          {muted ? "🔇 음소거됨" : "🔊 소리"}
        </button>
        <button className="btn btn-dark btn-block" onClick={() => flash("옵션은 준비 중입니다")}>옵션</button>
        {/* 게임 중 일방적 이탈 금지 (플레이 피드백) — 결과 화면 → 대기실 경로로만 퇴장 */}
        <button
          className="btn btn-dark btn-block"
          onClick={() => flash("게임 중에는 나갈 수 없습니다")}
          title="게임 중에는 나갈 수 없습니다"
        >
          🔒 나가기
        </button>
      </aside>

      {/* 1위 확정 → 10초 유예 카운트다운 (플레이는 계속 가능) */}
      {finishing && (
        <div className="finishing">
          🏆 <b>{finishing.nickname}</b> 1위! <b className="fin-sec">{finishing.sec}</b>초 후 종료 —
          남은 시간 동안 계속 플레이할 수 있어요
        </div>
      )}

      {/* 내 보드 클리어 (결과 대기) */}
      {remaining === 0 && (
        <div className="cleared-wait">🎉 모든 카드를 제거했어요! 결과 집계 중…</div>
      )}

      {notice && (
        <div className={`notice${power || scissorOn ? " below-banner" : ""}`}>{notice}</div>
      )}

      {/* 카드 제거 도슨트 토스트 (1단계 짧은 정보 — 상세는 도감에서) */}
      {toast && (
        <div className="docent">
          {toast.imageUrlThumb || toast.imageUrl ? (
            <img src={toast.imageUrlThumb || toast.imageUrl} alt="" />
          ) : (
            <span className="victory-face docent-face">승</span>
          )}
          <div>
            <div className="d-name">{toast.name}</div>
            <div className="d-sub">
              {toast.gradeLabel} · {hasRealPrice(toast) ? usd(toast.priceUsdCents) : "예시 데이터"}
            </div>
            <a className="d-src" href={marketUrl(toast.href)} target="_blank" rel="noreferrer">
              Renaiss OS Index ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
