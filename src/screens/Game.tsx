// F-07~F-10 게임 화면 — 서버 권위 구조:
// board:init 스냅샷으로 렌더하고, 클릭 2개는 tile:match 로 전송만 한다 (낙관적 선판정 없음).
// tile:matched/rejected/board:update/player:progress/match:finishing 수신으로만 상태를 갱신한다.
// 기존 GameScreen 의 연출(연결선 폴리라인·vanish 잔상·+점수 팝·도슨트 토스트·notice)을 이식.
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { GameCard } from "../../shared/cards.ts";
import { marketUrl, usd } from "../../shared/cards.ts";
import {
  COMBO_WINDOW_MS,
  ITEM_QUOTA,
  type BoardInit,
  type ComboPower,
  type ItemType,
  type MapMode,
  type ResumeProgress,
  type RoomDetail,
  type ServerToClient,
  type TileState,
} from "../../shared/protocol.ts";
import { getSocket } from "../net.ts";
import { errText, modeLabel } from "../labels.ts";
import { CardImg, hasRealPrice } from "../ui.tsx";
import { findPath } from "../../shared/shisen.ts";
import { audio } from "../audio.ts";
import { t } from "../i18n.ts";

interface Props {
  init: BoardInit;
  room: RoomDetail | null;
  myId: string;
  resume?: ResumeProgress | null; // 재접속 복구 시 초기 진행도(점수·콤보·아이템·경과·stuck)
}

const ASPECT = 1.4;

interface Vanish { id: number; card: GameCard; r: number; c: number; layer: number }
interface Pop { id: number; x: number; y: number; text: string }
interface Progress { remaining: number; score: number; combo: number; stuck?: boolean }

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

// ── 보드 타일(메모) ─────────────────────────────────────────
// 원시 props + React.memo 로, 점수/타이머/progress 리렌더 시 80개 버튼 재조정을 방지한다.
// 위치는 개별 `translate` 프로퍼티(--tx/--ty)로 주고, hover/layer1/shake 는 transform 으로 합성한다
// (styles.css .gtile 참고) — 레이아웃 없는 컴포지팅 이동.
interface TileProps {
  tileId: number;
  imgSrc: string;
  imgFull: string; // 썸네일 실패 시 폴백용 원본 URL (CardImg 체인)
  alt: string;
  victory: boolean;
  left: number;
  top: number;
  w: number;
  h: number;
  layer1: boolean;
  free: boolean;
  isSel: boolean;
  isHl: boolean;
  isShake: boolean;
  targeting: boolean;
  faceFont: number;
  victoryFace: string;
  title: string;
  onClick: (id: number) => void;
}

const Tile = memo(function Tile(p: TileProps) {
  const cls = [
    "gtile",
    p.layer1 ? "layer1" : "",
    !p.free ? "covered" : "",
    p.isSel ? "sel" : "",
    p.isHl ? "hint" : "",
    p.isShake ? "shake" : "",
    p.victory ? "victory" : "",
    p.targeting ? "targeting" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const style = {
    "--tx": `${p.left}px`,
    "--ty": `${p.top}px`,
    width: p.w,
    height: p.h,
  } as CSSProperties;
  return (
    <button
      className={cls}
      style={style}
      disabled={!p.free}
      onClick={() => p.onClick(p.tileId)}
      title={p.title}
    >
      {p.victory ? (
        <span className="victory-face" style={{ fontSize: p.faceFont }}>{p.victoryFace}</span>
      ) : (
        <CardImg thumb={p.imgSrc} full={p.imgFull} alt={p.alt} label={p.alt} />
      )}
      {p.victory && <span className="crown">👑</span>}
    </button>
  );
});

// ── 보드(메모) ──────────────────────────────────────────────
// 타일 map 을 memo 자식으로 격리 — 타이머/점수/progress 리렌더가 타일 map 재실행을 유발하지 않게.
interface BoardProps {
  ordered: TileState[];
  cards: GameCard[];
  sel: number | null;
  pending: [number, number] | null;
  highlight: [number, number] | null;
  shake: number | null;
  targeting: boolean;
  mapMode: MapMode;
  coveredKeys: Set<string>;
  cellW: number;
  cellH: number;
  faceFont: number;
  victoryFace: string;
  victoryTitle: string;
  onTileClick: (id: number) => void;
}

const Board = memo(function Board(p: BoardProps) {
  const { ordered, cards, sel, pending, highlight, shake, targeting, mapMode, coveredKeys, cellW, cellH, faceFont, onTileClick } = p;
  return (
    <>
      {ordered.map((t) => {
        const card = cards[t.cardIdx];
        // free 판정은 부모의 isFreeState 와 동일 규칙 — coveredKeys(덮인 (r,c,layer) Set)로 O(1) 조회
        const free = mapMode !== "shanghai" || !coveredKeys.has(`${t.r},${t.c},${t.layer + 1}`);
        const isSel =
          sel === t.tileId || (pending !== null && (pending[0] === t.tileId || pending[1] === t.tileId));
        const isHl = highlight !== null && (highlight[0] === t.tileId || highlight[1] === t.tileId);
        return (
          <Tile
            key={t.tileId}
            tileId={t.tileId}
            imgSrc={card.imageUrlThumb || card.imageUrl}
            imgFull={card.imageUrl}
            alt={card.name}
            victory={!!t.victory}
            left={(t.c - 1) * cellW}
            top={(t.r - 1) * cellH}
            w={cellW}
            h={cellH}
            layer1={t.layer > 0}
            free={free}
            isSel={isSel}
            isHl={isHl}
            isShake={shake === t.tileId}
            targeting={targeting && free}
            faceFont={faceFont}
            victoryFace={p.victoryFace}
            title={t.victory ? p.victoryTitle : `${card.name} · ${card.gradeLabel}`}
            onClick={onTileClick}
          />
        );
      })}
    </>
  );
});

export default function Game({ init, room, myId, resume }: Props) {
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
  // 재접속 복구(resume) 시 점수·콤보·아이템·경과·stuck 을 서버 스냅샷으로 초기화. 신규 판이면 기본값.
  const [score, setScore] = useState(resume?.score ?? 0);
  const [combo, setCombo] = useState(resume?.combo ?? 0);
  const [comboKey, setComboKey] = useState(0); // 콤보 바 리스타트용
  const [elapsedMs, setElapsedMs] = useState(resume?.elapsedMs ?? 0);
  const [toast, setToast] = useState<GameCard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<Record<ItemType, number>>(resume ? { ...resume.items } : { ...ITEM_QUOTA });
  const [scissorOn, setScissorOn] = useState(false);
  const [power, setPower] = useState<ComboPower | null>(null); // 콤보 파워 지정 대기
  const [finishing, setFinishing] = useState<{ nickname: string; sec: number } | null>(null);
  const [stuck, setStuck] = useState(resume?.stuck ?? false); // UP 교착 → 내 보드 진행 불가 (게임 오버)
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [muted, setMuted] = useState(audio.isMuted);

  const tilesRef = useRef(tiles);
  const pendingRef = useRef<[number, number] | null>(null);
  const comboRef = useRef(0);
  const seq = useRef(0);
  const noticeTimer = useRef(0);
  const toastTimer = useRef(0);
  const hlTimer = useRef(0);
  // 경과시간 기준점 — GO(game:countdown{0}) 수신 시 설정, 그 전엔 0.
  // 재접속 복구로 이미 진행 중(elapsedMs>0)이면 GO 를 다시 받지 않으므로 여기서 기준점을 소급 설정한다.
  const elapsedStartRef = useRef(resume && resume.elapsedMs > 0 ? Date.now() - resume.elapsedMs : 0);
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
  // 대형 실루엣 캔버스(피카츄 12×16·14×18)는 하한 42px 로는 1280×800 세로 오버플로우
  // → 캔버스 크기에 따라 하한 완화(>200칸 32px, >120칸 36px — 기존 보드 ≤8×10·UP 10×10 은 42 유지).
  // 대형 보드는 반올림 대신 내림: 0.5px 반올림이 행수만큼 증폭돼 가용 높이를 넘는 것을 방지.
  const boardCells = init.rows * init.cols;
  const minCellW = boardCells > 200 ? 32 : boardCells > 120 ? 36 : 42;
  const fitW = Math.max(minCellW, Math.min(150, Math.min(availW / init.cols, availH / (init.rows * ASPECT))));
  const cellW = boardCells > 120 ? Math.floor(fitW) : Math.round(fitW);
  const cellH = Math.round(cellW * ASPECT);
  // 승리 카드 표면 글자 — 언어별로 다름(ko "승" 1글자 / en "WIN" 3글자) → 길이에 맞춰 폰트 축소
  const victoryFace = t("game.victoryFace");
  const victoryFaceFont = Math.round(cellH * (victoryFace.length > 1 ? 0.26 : 0.5));
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
        flash(t("game.dexRegistered", { names }));
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
      if (p.reason === "up") flash(t("game.rowRaised"));
      else if (p.reason === "shuffle" || p.reason === "reshuffle")
        flash(t(p.reason === "reshuffle" ? "game.autoReshuffled" : "game.shuffled"));
      else if (p.reason === "scissor") flash(t("game.scissorRemoved"));
      else if (p.reason === "combo") flash(t("game.comboActivated"));
      // rolling 은 CSS 트랜지션으로 부드럽게 이동 (별도 노티 없음)
    };

    const onProgress: ServerToClient["player:progress"] = (p) => {
      setProgress((m) => ({ ...m, [p.playerId]: { remaining: p.remaining, score: p.score, combo: p.combo, stuck: p.stuck } }));
      if (p.playerId === myId) {
        setScore(p.score); // 서버 점수를 권위로 동기화 (콤보 파워·가위 점수 포함)
        syncCombo(p.combo);
        if (p.stuck) setStuck(true); // UP 교착 → 더 진행 불가, 게임오버 오버레이
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

  // 남은 시간 — 보드는 카운트다운 시작에 마운트되므로, 실제 플레이 시작(GO=game:countdown{0})
  // 시점을 기준점으로 잡는다. 재접속 시 서버 elapsedMs 를 기준점으로 소급해 제한시간과 정합시킨다.
  useEffect(() => {
    const sock = getSocket();
    const onGo = (p: { seconds: number }) => {
      if (p.seconds === 0) {
        elapsedStartRef.current = Date.now();
        setElapsedMs(0);
      }
    };
    sock.on("game:countdown", onGo);
    const id = window.setInterval(() => {
      if (elapsedStartRef.current === 0) return; // GO 전 — 0 유지
      setElapsedMs(Date.now() - elapsedStartRef.current);
    }, 500);
    return () => {
      sock.off("game:countdown", onGo);
      window.clearInterval(id);
    };
  }, []);

  // BGM — 게임 화면 진입 시 시작, 결과/종료 등으로 화면을 떠나면(언마운트) 정지
  useEffect(() => {
    audio.startBgm();
    return () => audio.stopBgm();
  }, []);

  // 첫 등장 깜빡임 완화 — 초기 보드에 쓰이는 distinct 썸네일을 미리 디코드/프리로드(best-effort).
  useEffect(() => {
    const urls = new Set<string>();
    for (const t of init.tiles) {
      const c = init.cards[t.cardIdx];
      const u = c?.imageUrlThumb || c?.imageUrl;
      if (u) urls.add(u);
    }
    for (const u of urls) {
      const img = new Image();
      img.decoding = "async";
      img.src = u;
      img.decode?.().catch(() => {}); // 실패 무시 — 캐시 워밍만 목적
    }
  }, [init]);

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
  function onTile(tile: TileState) {
    if (stuck || remaining === 0) return; // 교착/클리어 후 클릭 차단 — pending 진입 자체를 막아 소프트락 방지
    if (tile.removed || !isFreeState(tiles, tile, init.mapMode)) return;
    audio.playSound("select"); // 카드 클릭 — 짧고 가벼운 틱

    // 콤보 파워 지정 모드: 클릭한 카드로 발동
    if (power) {
      if (tile.victory) {
        flash(t("game.victoryComboForbidden")); // 파워 유지 — 다른 카드 지정 가능
        return;
      }
      getSocket().emit("combo:power", { cardId: cardOf(tile).cardId }, (r) => {
        if (!r.ok) flash(errText(r.error));
      });
      setPower(null);
      return;
    }

    // 가위 모드: 카드 1장 클릭 → 같은 matchKey 의 다른 free·미제거 타일을 자동으로 찾아 짝 제거
    if (scissorOn) {
      if (tile.victory) {
        flash(t("game.victoryScissorForbidden")); // 모드 유지 — 다른 카드 클릭 가능
        return;
      }
      const other = tiles.find(
        (x) =>
          x.tileId !== tile.tileId &&
          !x.removed &&
          isFreeState(tiles, x, init.mapMode) &&
          cardOf(x).matchKey === cardOf(tile).matchKey
      );
      if (!other) {
        flash(t("game.noPair")); // 모드 유지 — 다른 카드 클릭 가능
        return;
      }
      const pair: [number, number] = [tile.tileId, other.tileId];
      audio.playSound("scissor"); // 가위 사용 — 스와이프/휘릭
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
      setSel(tile.tileId);
      return;
    }
    if (sel === tile.tileId) {
      setSel(null);
      return;
    }
    const a = tiles.find((x) => x.tileId === sel);
    if (!a) {
      setSel(tile.tileId);
      return;
    }
    if (cardOf(a).matchKey !== cardOf(tile).matchKey) {
      // 다른 카드는 선택 이동 (경로 선판정은 하지 않음)
      setSel(tile.tileId);
      return;
    }
    const pair: [number, number] = [sel, tile.tileId];
    pendingRef.current = pair;
    setPending(pair);
    getSocket().emit("tile:match", { tileA: pair[0], tileB: pair[1] }, (r) => {
      // 서버 guard 실패 등으로 tile:matched/rejected 가 오지 않는 경우의 안전망 — pending 을 풀어 복구
      if (!r.ok) {
        pendingRef.current = null;
        setPending(null);
      }
    });
  }

  // 안정 클릭 핸들러 — memo Tile 이 매 렌더 새 클로저를 받지 않도록 ref 로 최신 onTile 을 고정.
  // tileId → 최신 tiles 에서 타일을 되찾아 onTile 에 넘긴다(동작은 인라인 onClick 과 100% 동일).
  const onTileRef = useRef(onTile);
  onTileRef.current = onTile;
  const handleTileClick = useCallback((id: number) => {
    const t = tilesRef.current.find((x) => x.tileId === id);
    if (t) onTileRef.current(t);
  }, []);

  // ── 아이템 ──────────────────────────────────────────────────
  function useSimpleItem(type: "search" | "shuffle") {
    if (items[type] <= 0) return;
    audio.playSound(type === "search" ? "search" : "shuffle"); // 아이템 사용 — 스와이프/휘릭
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
      flash(t("game.scissorExhausted"));
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
  const live = useMemo(() => tiles.filter((t) => !t.removed), [tiles]);
  const remaining = live.length;
  const ordered = useMemo(
    () => [...live].sort((a, b) => a.layer - b.layer || a.tileId - b.tileId),
    [live]
  );
  // 상하이 free 판정 O(1) 조회용 — 미제거 타일의 (r,c,layer) 점유 Set(변경 시 1회 계산).
  // 타일 t 는 (r,c,layer+1) 이 점유돼 있으면 덮여 잠김 → isFreeState 와 동일 규칙.
  const coveredKeys = useMemo(() => {
    const s = new Set<string>();
    if (init.mapMode === "shanghai") {
      for (const o of tiles) if (!o.removed) s.add(`${o.r},${o.c},${o.layer}`);
    }
    return s;
  }, [tiles, init.mapMode]);
  const remainingMs = Math.max(0, init.timeLimitMs - elapsedMs);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const mm = String(Math.floor(remainingSeconds / 60)).padStart(2, "0");
  const ss = String(remainingSeconds % 60).padStart(2, "0");
  const timeUrgent = remainingSeconds <= 30;
  const linePts = line
    ? line.map((p) => {
        const { x, y } = center(p.r, p.c);
        return `${x},${y}`;
      }).join(" ")
    : "";

  // 소거가능(연결 가능한 짝) — findPath BFS 부하가 vanish 연출과 같은 프레임에 겹치지 않도록
  // tiles 를 useDeferredValue 로 지연 계산. "소거가능" 숫자만 1프레임 늦게 갱신될 뿐(판정 무관).
  const dTiles = useDeferredValue(tiles);
  const removable = useMemo(
    () => countRemovable(dTiles, init.cols, init.rows, init.mapMode, (t) => cardOf(t).matchKey),
    [dTiles] // eslint-disable-line react-hooks/exhaustive-deps
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
            <div className="sp-name">{t("game.me")}</div>
          </div>
        )}
        {players.map((p) => {
          const isMe = p.playerId === myId;
          const pr = progress[p.playerId] ?? { remaining: p.remaining, score: p.score, combo: p.combo };
          return (
            <div key={p.playerId} className={`slot-player game-player ${isMe ? "me" : ""}`}>
              <div className="avatar">{avatarFor(p.playerId)}</div>
              <div className="sp-name">@{p.nickname}</div>
              {p.isHost && <span className="chip host game-host-chip">{t("game.host")}</span>}
              {!isMe && (
                <div className="gp-mini" title={t("game.playerStatus", { remaining: pr.remaining, score: pr.score })}>
                  <span>{t("game.remainingShort", { count: pr.remaining })}</span>
                  {!p.connected && <span className="pc-off">{t("game.disconnected")}</span>}
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
            {init.mapMode === "up" && <span className="tag reserve-tag">{t("game.rowsLeft", { count: reserveRows })}</span>}
          </div>
        </div>

        {/* 모드 배너: 콤보 파워 지정 / 가위 대상 지정 */}
        {power && (
          <div className="mode-banner power">
            ⚡ {t("game.combo", { count: power.level })}{" "}
            {power.kind === "pair"
              ? t("game.powerPairPrompt")
              : t("game.powerClearPrompt")}
            <button className="banner-cancel" onClick={() => setPower(null)}>{t("game.cancel")}</button>
          </div>
        )}
        {scissorOn && !power && (
          <div className="mode-banner scissor">
            {t("game.scissorPrompt")}
            <button className="banner-cancel" onClick={toggleScissor}>{t("game.cancel")}</button>
          </div>
        )}

        <div className={`board-wrap map-theme-${init.theme ?? "default"}`}>
          <div className="gboard" style={{ width: boardW, height: boardH }} role="group" aria-label={t("game.boardAria")}>

            {/* 마스크 유효 칸(빈 slot) 표시 */}
            {baseCells.map((cell) => (
              <div
                key={`bg-${cell.r}-${cell.c}`}
                className="slot-bg"
                style={{ left: (cell.c - 1) * cellW, top: (cell.r - 1) * cellH, width: cellW, height: cellH }}
              />
            ))}

            <Board
              ordered={ordered}
              cards={cards}
              sel={sel}
              pending={pending}
              highlight={highlight}
              shake={shake}
              targeting={!!power || scissorOn}
              mapMode={init.mapMode}
              coveredKeys={coveredKeys}
              cellW={cellW}
              cellH={cellH}
              faceFont={victoryFaceFont}
              victoryFace={victoryFace}
              victoryTitle={t("game.victoryCard")}
              onTileClick={handleTileClick}
            />

            {/* 제거 팝 잔상 */}
            {vanishing.map((v) => (
              <div
                key={v.id}
                className={`vanish ${v.layer > 0 ? "layer1" : ""}`}
                style={{ left: (v.c - 1) * cellW, top: (v.r - 1) * cellH, width: cellW, height: cellH }}
              >
                {v.card.imageUrlThumb || v.card.imageUrl ? (
                  <img src={v.card.imageUrlThumb || v.card.imageUrl} alt="" decoding="async" />
                ) : (
                  <span className="victory-face" style={{ fontSize: victoryFaceFont }}>{victoryFace}</span>
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
          <div className="rank-label">{t("game.currentRank")}</div>
          <div className="rank-value">{myRank !== null ? t("game.rank", { rank: myRank }) : "—"}</div>
        </div>

        <div className="panel side-metrics">
          <div className="side-stat">
            <span className="ss-label">{t("game.tilesLeft")}</span>
            <span className="ss-val">{remaining}</span>
          </div>
          <div className="side-stat">
            <span className="ss-label">{t("game.removable")}</span>
            <span className="ss-val green">{removable}</span>
          </div>
        </div>

        <div className="game-items">
          <button
            className="game-item"
            disabled={items.search <= 0}
            onClick={() => useSimpleItem("search")}
          >
            <span className="gi-top"><span className="key-cap">F1</span> {t("game.search")}</span>
            <span className="gi-sub">{t("game.usesLeft", { count: items.search })}</span>
          </button>
          <button
            className="game-item"
            disabled={items.shuffle <= 0}
            onClick={() => useSimpleItem("shuffle")}
          >
            <span className="gi-top"><span className="key-cap">F2</span> {t("game.shuffle")}</span>
            <span className="gi-sub">{t("game.usesLeft", { count: items.shuffle })}</span>
          </button>
          <button
            className={`game-item ${scissorOn ? "on" : ""}`}
            disabled={items.scissor <= 0 && !scissorOn}
            onClick={toggleScissor}
          >
            <span className="gi-top"><span className="key-cap">F3</span> {t("game.scissors")}</span>
            <span className="gi-sub">{t("game.usesLeft", { count: items.scissor })}</span>
          </button>
        </div>

        <div className="panel side-metrics side-score">
          <div className="side-stat">
            <span className="ss-label">{t("game.score")}</span>
            <span className="ss-val" key={score} ><span className="score-bump">{score.toLocaleString()}</span></span>
          </div>
          <div className="side-stat">
            <span className="ss-label">{t("game.timeLeft")}</span>
            <span className="ss-val" style={timeUrgent ? { color: "#ef4444" } : undefined}>{mm}:{ss}</span>
          </div>
          {/* 슬롯 상시 렌더(고정 높이) — 콤보 등장/소멸 때 사이드바 높이가 출렁여
              body 스크롤바가 깜빡이고 레이아웃이 점프하던 버그 방지 */}
          <div className="side-combo" key={combo > 0 ? comboKey : "idle"}>
            {combo > 0 && (
              <>
                <span className="combo">{t("game.combo", { count: combo })}</span>
                <span className="combo-bar" style={{ animationDuration: `${COMBO_WINDOW_MS}ms` }} />
              </>
            )}
          </div>
        </div>

        <div className="spacer" />
        <button
          className="btn btn-dark btn-block mute-btn"
          onClick={() => setMuted(audio.toggleMute())}
          title={t(muted ? "game.unmute" : "game.mute")}
        >
          {t(muted ? "game.muted" : "game.sound")}
        </button>
        <button className="btn btn-dark btn-block" onClick={() => flash(t("game.optionsPending"))}>{t("game.options")}</button>
        {/* 게임 중 일방적 이탈 금지 (플레이 피드백) — 결과 화면 → 대기실 경로로만 퇴장 */}
        <button
          className="btn btn-dark btn-block"
          onClick={() => flash(t("game.cannotLeave"))}
          title={t("game.cannotLeave")}
        >
          {t("game.leaveLocked")}
        </button>
      </aside>

      {/* 마지막 10초 — 시작 카운트다운의 전역 스타일을 재사용하되 플레이 입력은 막지 않는다. */}
      {elapsedStartRef.current !== 0 && remainingSeconds >= 1 && remainingSeconds <= 10 && (
        <div
          className="countdown-overlay"
          style={{ pointerEvents: "none", background: "rgba(6,10,18,0.18)" }}
          aria-live="assertive"
          aria-label={t("game.secondsLeft", { count: remainingSeconds })}
        >
          <div
            key={remainingSeconds}
            className="countdown-number"
            style={{ color: "#ef4444", textShadow: "0 0 40px rgba(239,68,68,0.6), 0 4px 18px rgba(0,0,0,0.6)" }}
          >
            {remainingSeconds}
          </div>
        </div>
      )}

      {/* 1위 확정 → 10초 유예 카운트다운 (플레이는 계속 가능) */}
      {finishing && (
        <div className="finishing">
          {t("game.finishingPrefix")} <b>{finishing.nickname}</b> {t("game.finishingMiddle")} <b className="fin-sec">{finishing.sec}</b>{t("game.finishingSuffix")}
        </div>
      )}

      {/* 내 보드 클리어 (결과 대기) */}
      {remaining === 0 && (
        <div className="cleared-wait">{t("game.clearedWaiting")}</div>
      )}

      {/* UP 교착 — 더 진행 불가 (게임 오버, 결과 대기) */}
      {stuck && remaining > 0 && (
        <div className="stuck-over">
          <div className="stuck-over-title">{t("game.gameOver")}</div>
          <div className="stuck-over-sub">
            {t("game.stuck")}
            <br />
            {t("game.rankingWaiting")}
          </div>
        </div>
      )}

      {notice && (
        <div className={`notice${power || scissorOn ? " below-banner" : ""}`} role="status" aria-live="assertive">{notice}</div>
      )}

      {/* 카드 제거 도슨트 토스트 (1단계 짧은 정보 — 상세는 도감에서) */}
      {toast && (
        <div className="docent" role="status" aria-live="polite">
          {toast.imageUrlThumb || toast.imageUrl ? (
            <img src={toast.imageUrlThumb || toast.imageUrl} alt="" decoding="async" />
          ) : (
            <span className="victory-face docent-face" style={victoryFace.length > 1 ? { fontSize: 14 } : undefined}>{victoryFace}</span>
          )}
          <div>
            <div className="d-name">{toast.name}</div>
            <div className="d-sub">
              {toast.gradeLabel} · {hasRealPrice(toast) ? usd(toast.priceUsdCents) : t("game.sampleData")}
            </div>
            <a className="d-src" href={marketUrl(toast.href)} target="_blank" rel="noreferrer">
              {t("common.indexLink")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
