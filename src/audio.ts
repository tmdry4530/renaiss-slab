// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 효과음/BGM (Web Audio API 절차적 합성, 사운드 파일 0개)
// 싱글톤 AudioManager: lazy AudioContext 생성 + resume() 언락 + muted 토글 + 마스터 게인.
// 자동재생 정책 대응: 첫 사용자 제스처(로그인 등)에서 unlock() 을 호출한다 (src/screens/Login.tsx).
// 컨텍스트 생성/언락에 실패해도 예외를 던지지 않고 조용히 no-op 한다 (오디오는 부수 기능).
// ─────────────────────────────────────────────────────────────
export type SoundName =
  | "select" // 카드 선택(클릭) — 짧고 가벼운 틱
  | "match" // 매치 성공 — 밝은 상승 2음
  | "combo5" // 5회차 콤보 파워 — 화려한 아르페지오
  | "combo10" // 10회차 콤보 파워 — 더 크고 화려하게
  | "fail" // 매치 실패 — 낮은 부저/하강음
  | "item" // 아이템 사용(서치/셔플/가위) — 스와이프/휘릭
  | "countdown" // 카운트다운 틱(3·2·1)
  | "go"; // 시작! 강조음

const MASTER_VOLUME = 0.5; // 마스터 게인(과음량/클리핑 방지 — 개별 톤 peak 는 이보다 훨씬 낮게 유지)

interface ToneOpts {
  type?: OscillatorType;
  start?: number; // ctx.currentTime 기준 지연(초)
  duration?: number; // 전체 길이(초)
  attack?: number; // 어택 구간(초)
  peak?: number; // 피크 게인(0~1)
}

/** BGM 4코드 진행(I-vi-IV-V, C 메이저) — 잔잔한 아르페지오 루프용 주파수(Hz) */
const BGM_CHORDS: number[][] = [
  [261.63, 329.63, 392.0], // C E G
  [220.0, 261.63, 329.63], // A C E
  [174.61, 220.0, 261.63], // F A C
  [196.0, 246.94, 293.66], // G B D
];

class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private bgmPlaying = false;
  private bgmTimer: ReturnType<typeof setTimeout> | null = null;
  private bgmGain: GainNode | null = null; // 현재 스텝의 게인 노드 — stopBgm 에서 즉시 무음 처리용

  /** 컨텍스트를 lazy 생성(1회)해 반환. 생성 실패(미지원 브라우저 등)면 null. */
  private getCtx(): { ctx: AudioContext; master: GainNode } | null {
    if (this.ctx && this.master) return { ctx: this.ctx, master: this.master };
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : MASTER_VOLUME;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return { ctx, master };
    } catch {
      return null; // 부수효과 없이 안전 — 오디오 없이도 게임은 정상 동작해야 한다
    }
  }

  /** 첫 사용자 제스처에서 호출 — 자동재생 정책 언락(AudioContext.resume). */
  unlock(): void {
    const c = this.getCtx();
    if (!c) return;
    if (c.ctx.state === "suspended") c.ctx.resume().catch(() => {});
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** 음소거 토글 — BGM·효과음 공통 마스터 게인에 즉시 반영. 반환값 = 토글 후 muted 상태. */
  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_VOLUME;
    return this.muted;
  }

  /** 오실레이터 1개 + 엔벨로프(어택/디케이) 톤 재생. peak 는 클리핑 방지를 위해 항상 0.4 이하로 호출한다. */
  private tone(ctx: AudioContext, master: GainNode, freq: number, opts: ToneOpts = {}): void {
    const { type = "sine", start = 0, duration = 0.15, attack = 0.008, peak = 0.25 } = opts;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /** 주파수가 start→end 로 미끄러지는 스윕 톤(스와이프/휘릭 효과용). */
  private sweep(
    ctx: AudioContext,
    master: GainNode,
    freqStart: number,
    freqEnd: number,
    opts: ToneOpts = {}
  ): void {
    const { type = "triangle", start = 0, duration = 0.15, attack = 0.005, peak = 0.2 } = opts;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freqStart), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  private build(name: SoundName, ctx: AudioContext, master: GainNode): void {
    switch (name) {
      case "select":
        this.tone(ctx, master, 980, { type: "sine", duration: 0.055, attack: 0.002, peak: 0.16 });
        break;
      case "match":
        this.tone(ctx, master, 660, { type: "sine", duration: 0.1, peak: 0.22 });
        this.tone(ctx, master, 880, { type: "sine", start: 0.07, duration: 0.14, peak: 0.24 });
        break;
      case "combo5":
        [523.25, 659.25, 783.99].forEach((f, i) =>
          this.tone(ctx, master, f, { type: "triangle", start: i * 0.06, duration: 0.13, peak: 0.22 })
        );
        break;
      case "combo10":
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
          this.tone(ctx, master, f, { type: "triangle", start: i * 0.055, duration: 0.15, peak: 0.24 })
        );
        this.tone(ctx, master, 1318.5, { type: "sine", start: 0.22, duration: 0.16, peak: 0.2 });
        break;
      case "fail":
        this.sweep(ctx, master, 240, 100, { type: "sawtooth", duration: 0.26, peak: 0.2 });
        break;
      case "item":
        this.sweep(ctx, master, 1100, 260, { type: "triangle", duration: 0.1, peak: 0.18 });
        this.sweep(ctx, master, 260, 620, { type: "triangle", start: 0.1, duration: 0.08, peak: 0.14 });
        break;
      case "countdown":
        this.tone(ctx, master, 700, { type: "square", duration: 0.11, attack: 0.004, peak: 0.22 });
        break;
      case "go":
        [523.25, 659.25, 783.99].forEach((f) =>
          this.tone(ctx, master, f, { type: "sine", duration: 0.3, attack: 0.006, peak: 0.28 })
        );
        break;
    }
  }

  /** 절차적 효과음 재생. 컨텍스트 미생성/미언락이어도 예외 없이 no-op. */
  playSound(name: SoundName): void {
    const c = this.getCtx();
    if (!c) return;
    try {
      this.build(name, c.ctx, c.master);
    } catch {
      /* 오디오는 부수 기능 — 실패해도 게임 흐름에 영향 없어야 한다 */
    }
  }

  private scheduleBgmStep(ctx: AudioContext, master: GainNode, step: number): void {
    if (!this.bgmPlaying) return;
    const chord = BGM_CHORDS[step % BGM_CHORDS.length];
    const stepDur = 1.8;
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + stepDur);
    g.connect(master);
    this.bgmGain = g;
    chord.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t0 + i * 0.05);
      osc.connect(g);
      osc.start(t0 + i * 0.05);
      osc.stop(t0 + stepDur);
    });
    this.bgmTimer = setTimeout(() => this.scheduleBgmStep(ctx, master, step + 1), stepDur * 1000);
  }

  /** 배경음 루프 시작 — 잔잔한 저음량 코드 아르페지오. 이미 재생 중이면 no-op. */
  startBgm(): void {
    if (this.bgmPlaying) return;
    const c = this.getCtx();
    if (!c) return;
    this.bgmPlaying = true;
    this.scheduleBgmStep(c.ctx, c.master, 0);
  }

  /** 배경음 정지 — 예약된 다음 스텝을 취소하고, 이미 스케줄된 현재 스텝도 즉시 무음 처리한다. */
  stopBgm(): void {
    this.bgmPlaying = false;
    if (this.bgmTimer !== null) {
      clearTimeout(this.bgmTimer);
      this.bgmTimer = null;
    }
    if (this.bgmGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.bgmGain.gain.cancelScheduledValues(now);
      this.bgmGain.gain.setValueAtTime(0, now);
      this.bgmGain = null;
    }
  }
}

/** 싱글톤 인스턴스 — 앱 전역에서 이 하나만 사용한다. */
export const audio = new AudioManager();
