// ─────────────────────────────────────────────────────────────
// Renaiss Slab King — 효과음/BGM (실제 사운드 파일 우선, 실패 시 절차적 합성 폴백)
// 싱글톤 AudioManager: lazy AudioContext + 마스터 게인 + muted 토글 + unlock().
// 재생 경로: 파일을 fetch → decodeAudioData 로 AudioBuffer 캐시 → AudioBufferSourceNode 로
//   master 게인 경유 재생(겹침 재생·저지연, 뮤트/게인 일관성). unlock()(첫 사용자 제스처)에서
//   전 파일을 백그라운드 프리페치한다. 아직 안 실렸거나 로드 실패면 절차적 합성으로 대체한다.
// 자동재생 정책 대응: 첫 사용자 제스처(로그인 등)에서 unlock() 을 호출한다 (src/screens/Login.tsx).
// 컨텍스트 생성/언락/로드/재생 실패 전부 예외를 던지지 않고 조용히 no-op — 오디오는 부수 기능이다.
// ─────────────────────────────────────────────────────────────
export type SoundName =
  | "select" // 카드 선택(클릭) — 짧고 가벼운 틱
  | "match" // 매치 성공
  | "combo5" // 5회차 콤보 파워
  | "combo10" // 10회차 콤보 파워
  | "fail" // 매치 실패
  | "search" // 아이템: 서치
  | "shuffle" // 아이템: 셔플
  | "scissor" // 아이템: 가위
  | "countdown" // 카운트다운 틱(3·2·1)
  | "go" // 시작! 강조음
  | "gameover" // 게임 종료
  | "timeup" // 시간 종료
  | "win" // 승리
  | "lose"; // 패배

const MASTER_VOLUME = 0.5; // 마스터 게인(과음량/클리핑 방지)
const BGM_VOLUME = 0.3; // BGM 상대 게인 — 효과음보다 낮게(master 경유 → 실효 ~0.15)
const SOUND_BASE = "/sound/"; // public/sound/ 런타임 경로

/** SoundName → 실제 파일명(고정 매핑). combo5·combo10 은 동일 파일을 공유한다. */
const SOUND_FILES: Record<SoundName, string> = {
  select: "select.wav",
  match: "match.wav",
  combo5: "combo.ogg",
  combo10: "combo.ogg",
  fail: "fail.wav",
  search: "search.ogg",
  shuffle: "shuffle.wav",
  scissor: "scissor.mp3",
  countdown: "ready.wav",
  go: "go.wav",
  gameover: "gameover.wav",
  timeup: "timeup.wav",
  win: "win.wav",
  lose: "lose.wav",
};

const BGM_FILE = "bgm.ogg";

/** 동일 파일(combo.ogg)을 쓰는 콤보음의 강약 구분용 상대 게인. 없으면 1.0. */
const SOUND_GAIN: Partial<Record<SoundName, number>> = {
  combo5: 0.85,
  combo10: 1.0,
};

interface ToneOpts {
  type?: OscillatorType;
  start?: number; // ctx.currentTime 기준 지연(초)
  duration?: number; // 전체 길이(초)
  attack?: number; // 어택 구간(초)
  peak?: number; // 피크 게인(0~1)
}

/** BGM 4코드 진행(I-vi-IV-V, C 메이저) — 절차적 폴백 아르페지오 루프용 주파수(Hz) */
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

  // ── 파일 버퍼 캐시(파일명 키) ────────────────────────────────
  private buffers = new Map<string, AudioBuffer>(); // 디코드 완료된 버퍼
  private loading = new Map<string, Promise<AudioBuffer | null>>(); // 진행 중 로드(중복 방지)
  private failed = new Set<string>(); // 로드/디코드 실패 → 절차적 폴백, 재시도 안 함
  private prefetched = false; // unlock() 프리페치 1회 가드

  // ── BGM 상태 ────────────────────────────────────────────────
  private bgmPlaying = false; // startBgm 의도(재생 요청됨, 아직 stop 안 함)
  private bgmBuffer: AudioBuffer | null = null; // bgm.ogg 디코드 버퍼
  private bgmLoadStarted = false; // bgm 로드 1회 가드
  private bgmSource: AudioBufferSourceNode | null = null; // 파일 BGM 루프 소스
  private bgmFileGain: GainNode | null = null; // 파일 BGM 게인
  // 절차적 폴백 BGM 상태
  private bgmProcedural = false; // 절차적 BGM 루프 활성 가드
  private bgmTimer: ReturnType<typeof setTimeout> | null = null;
  private bgmGain: GainNode | null = null; // 현재 스텝 게인 — stop 시 즉시 무음용

  /** 컨텍스트를 lazy 생성(1회)해 반환. 생성 실패(미지원 브라우저 등)면 null. */
  private getCtx(): { ctx: AudioContext; master: GainNode } | null {
    if (this.ctx && this.master) return { ctx: this.ctx, master: this.master };
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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

  /** 첫 사용자 제스처에서 호출 — 자동재생 정책 언락 + 효과음 백그라운드 프리페치. */
  unlock(): void {
    const c = this.getCtx();
    if (!c) return;
    if (c.ctx.state === "suspended") c.ctx.resume().catch(() => {});
    this.prefetch();
  }

  /** 효과음을 백그라운드로 fetch·decode 해 캐시. 1회만 수행.
   *  BGM(4.4MB)은 여기서 받지 않는다 — startBgm(게임 진입) 시 lazy 로드 (로비만 쓰는 유저의 대역폭·메모리 절약).
   *  timeup 은 현재 미사용(제한시간 없음)이라 프리페치 제외 — 매핑·절차적 폴백은 나중 대비로 유지. */
  private prefetch(): void {
    if (this.prefetched) return;
    this.prefetched = true;
    const files = new Set(Object.values(SOUND_FILES));
    files.delete(SOUND_FILES.timeup);
    for (const file of files) void this.load(file);
  }

  /** 파일을 fetch → decode → 버퍼 캐시. 실패 시 failed 로 표시하고 null. 중복 로드는 dedupe. */
  private load(file: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(file);
    if (cached) return Promise.resolve(cached);
    if (this.failed.has(file)) return Promise.resolve(null);
    const inflight = this.loading.get(file);
    if (inflight) return inflight;

    const p = (async (): Promise<AudioBuffer | null> => {
      try {
        const c = this.getCtx();
        if (!c) return null;
        const res = await fetch(SOUND_BASE + file);
        if (!res.ok) throw new Error(`fetch ${file} → ${res.status}`);
        const data = await res.arrayBuffer();
        const buf = await this.decode(c.ctx, data);
        this.buffers.set(file, buf);
        return buf;
      } catch {
        this.failed.add(file); // 사파리 ogg 미지원·네트워크 실패 등 → 절차적 폴백 경로로
        return null;
      } finally {
        this.loading.delete(file);
      }
    })();
    this.loading.set(file, p);
    return p;
  }

  /** decodeAudioData 의 Promise/콜백 두 형태를 모두 지원(구형 사파리 대응). */
  private decode(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise<AudioBuffer>((resolve, reject) => {
      const ret = ctx.decodeAudioData(data, resolve, reject) as unknown as
        | Promise<AudioBuffer>
        | undefined;
      if (ret && typeof ret.then === "function") ret.then(resolve, reject);
    });
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** 음소거 토글 — BGM·효과음 공통 마스터 게인에 즉시 반영(파일/절차적 모두). 반환값 = 토글 후 muted. */
  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_VOLUME;
    return this.muted;
  }

  /**
   * 효과음 재생. 파일 버퍼가 있으면 파일을, 없으면(미로드/실패) 절차적 합성으로 재생한다.
   * 컨텍스트 미생성/미언락이어도 예외 없이 no-op.
   */
  playSound(name: SoundName): void {
    const c = this.getCtx();
    if (!c) return;
    try {
      const file = SOUND_FILES[name];
      const buf = this.buffers.get(file);
      if (buf) {
        this.playBuffer(c.ctx, c.master, buf, name);
      } else {
        // 아직 안 실렸으면 로드를 걸어두고(다음 재생 대비), 이번엔 절차적 합성으로 대체(무음 방지).
        if (!this.failed.has(file)) void this.load(file);
        this.build(name, c.ctx, c.master);
      }
    } catch {
      /* 오디오는 부수 기능 — 실패해도 게임 흐름에 영향 없어야 한다 */
    }
  }

  /** 디코드된 버퍼를 per-play 게인 → master 경유로 1회 재생(겹침 허용). */
  private playBuffer(ctx: AudioContext, master: GainNode, buf: AudioBuffer, name: SoundName): void {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = SOUND_GAIN[name] ?? 1;
    src.connect(g).connect(master);
    src.onended = () => {
      try {
        src.disconnect();
        g.disconnect();
      } catch {
        /* no-op */
      }
    };
    src.start();
  }

  // ── 절차적 합성 폴백 ──────────────────────────────────────────

  /** 오실레이터 1개 + 엔벨로프(어택/디케이) 톤. peak 는 클리핑 방지를 위해 항상 0.4 이하로 호출한다. */
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

  /** 파일 재생 실패/미로드 시 이름별 절차적 합성. 신규 이름도 무음이 아니게 매핑한다. */
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
      // 매치 실패·패배 — 낮은 하강 부저
      case "fail":
      case "lose":
        this.sweep(ctx, master, 240, 100, { type: "sawtooth", duration: 0.26, peak: 0.2 });
        break;
      // 아이템(서치/셔플/가위) — 기존 스와이프/휘릭 합성 재활용
      case "search":
      case "shuffle":
      case "scissor":
        this.sweep(ctx, master, 1100, 260, { type: "triangle", duration: 0.1, peak: 0.18 });
        this.sweep(ctx, master, 260, 620, { type: "triangle", start: 0.1, duration: 0.08, peak: 0.14 });
        break;
      case "countdown":
        this.tone(ctx, master, 700, { type: "square", duration: 0.11, attack: 0.004, peak: 0.22 });
        break;
      // 시작·승리 — 밝은 상승 3화음
      case "go":
      case "win":
        [523.25, 659.25, 783.99].forEach((f) =>
          this.tone(ctx, master, f, { type: "sine", duration: 0.3, attack: 0.006, peak: 0.28 })
        );
        break;
      // 게임 종료·시간 종료 — 하강 종료 톤
      case "gameover":
      case "timeup":
        [440.0, 349.23, 261.63].forEach((f, i) =>
          this.tone(ctx, master, f, { type: "triangle", start: i * 0.14, duration: 0.26, peak: 0.22 })
        );
        break;
    }
  }

  // ── BGM ──────────────────────────────────────────────────────

  /** bgm.ogg 를 1회 로드 예약. 완료되면 재생 요청 상태일 때 자동 시작한다. */
  private ensureBgmLoaded(): void {
    if (this.bgmLoadStarted) return;
    this.bgmLoadStarted = true;
    void this.load(BGM_FILE).then((buf) => {
      if (buf) this.bgmBuffer = buf;
      this.maybeStartBgm();
    });
  }

  /** 재생 요청 상태이고 아직 안 울리고 있으면 BGM 을 시작(파일 우선, 실패 시 절차적). */
  private maybeStartBgm(): void {
    if (!this.bgmPlaying) return;
    if (this.bgmSource || this.bgmProcedural) return; // 이미 재생 중
    if (this.bgmBuffer) {
      this.startFileBgm(this.bgmBuffer);
    } else if (this.failed.has(BGM_FILE)) {
      this.startProceduralBgm();
    }
    // 아직 로드 중이면 대기 — 로드 완료 콜백이 다시 maybeStartBgm 을 호출한다.
  }

  /** 파일 BGM 루프 재생(저음량, master 경유 → 뮤트 반영). 실패 시 절차적 폴백. */
  private startFileBgm(buf: AudioBuffer): void {
    const c = this.getCtx();
    if (!c) return;
    try {
      const src = c.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = c.ctx.createGain();
      g.gain.value = BGM_VOLUME;
      src.connect(g).connect(c.master);
      src.start();
      this.bgmSource = src;
      this.bgmFileGain = g;
    } catch {
      this.startProceduralBgm();
    }
  }

  /** 배경음 시작 — 이미 재생 중이면 no-op. 버퍼가 아직이면 로드 완료 시 자동 시작한다. */
  startBgm(): void {
    try {
      if (this.bgmPlaying) return;
      const c = this.getCtx();
      if (!c) return;
      this.bgmPlaying = true;
      if (c.ctx.state === "suspended") c.ctx.resume().catch(() => {});
      this.ensureBgmLoaded(); // BGM lazy 로드 진입점 — unlock 프리페치에선 받지 않는다
      this.maybeStartBgm();
    } catch {
      /* 오디오는 부수 기능 — React effect(setup)로 예외를 전파하지 않는다 */
    }
  }

  /** 배경음 정지 — 파일 루프·절차적 루프 모두 즉시 멈춘다. */
  stopBgm(): void {
    try {
      this.bgmPlaying = false;
      if (this.bgmSource) {
        try {
          this.bgmSource.stop();
          this.bgmSource.disconnect();
        } catch {
          /* no-op */
        }
        this.bgmSource = null;
      }
      if (this.bgmFileGain) {
        try {
          this.bgmFileGain.disconnect();
        } catch {
          /* no-op */
        }
        this.bgmFileGain = null;
      }
      this.stopProceduralBgm();
    } catch {
      /* 오디오는 부수 기능 — React effect(cleanup)로 예외를 전파하지 않는다 */
    }
  }

  /** 절차적 폴백 BGM 루프 시작 — 잔잔한 저음량 코드 아르페지오. */
  private startProceduralBgm(): void {
    if (this.bgmProcedural) return;
    const c = this.getCtx();
    if (!c) return;
    this.bgmProcedural = true;
    this.scheduleBgmStep(c.ctx, c.master, 0);
  }

  private scheduleBgmStep(ctx: AudioContext, master: GainNode, step: number): void {
    if (!this.bgmProcedural) return;
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

  /** 절차적 BGM 정지 — 예약된 다음 스텝을 취소하고 현재 스텝도 즉시 무음 처리. */
  private stopProceduralBgm(): void {
    this.bgmProcedural = false;
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
