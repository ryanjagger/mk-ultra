/**
 * Synthesized game audio — Web Audio API, no asset files. Reads sim state
 * and never writes it (NFR-7 applies to ears too): continuous sounds track
 * the local kart each frame, one-shots fire on state *transitions* detected
 * by diffing against the previous frame.
 *
 * The AudioContext is created lazily and resumed on the first user gesture
 * (autoplay policy); until then every call is a safe no-op.
 */
import {
  ITEM_NONE,
  PHASE_COUNTDOWN,
  PHASE_RACING,
  COUNTDOWN_TICKS,
  MAX_SPEED,
  BOOST_CAP,
  DRIFT_TIER1_TICKS,
  DRIFT_TIER2_TICKS,
  fxToFloat,
  type GameState,
} from '@mk/sim';
import type { RaceController } from './game.js';

const MASTER_GAIN = 0.32;
/** one-shots from far-away karts/shells fade with distance (world units) */
const HEAR_RANGE = 70;

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

interface KartPrev {
  heldItem: number;
  boostTicks: number;
  spinTicks: number;
  driftTier: number;
  finishTick: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  // continuous voices (local kart only)
  private motorOsc: OscillatorNode | null = null;
  private motorOsc2: OscillatorNode | null = null; // inverter shimmer, ~1 octave up
  private motorGain: GainNode | null = null;
  private motorFilter: BiquadFilterNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private squealGain: GainNode | null = null;

  // previous-frame state for transition detection
  private prevKarts: KartPrev[] = [];
  private prevShellTtl: number[] = [];
  private prevShellBounces: number[] = [];
  private prevOilTtl: number[] = [];
  private prevCountdownN = -1;
  private prevPhase = -1;

  muted = localStorage.getItem('mk-muted') === '1';
  private hidden = false;

  /** Create/resume the context. Call from a user-gesture handler. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
      this.master.connect(this.ctx.destination);
      this.noise = makeNoiseBuffer(this.ctx);
      this.buildEngineVoice();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('mk-muted', this.muted ? '1' : '0');
    this.applyMaster();
    return this.muted;
  }

  /** Duck everything while the tab is hidden (the sim keeps running there). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.applyMaster();
  }

  private applyMaster(): void {
    if (this.master && this.ctx) {
      const target = this.muted || this.hidden ? 0 : MASTER_GAIN;
      this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * EV drivetrain + drift squeal: built once, steered every frame.
   * Electric character = near-silent idle, clean motor whine sweeping a wide
   * range with speed, a detuned upper partial (inverter shimmer), and
   * road/wind noise replacing combustion rumble.
   */
  private buildEngineVoice(): void {
    const ctx = this.ctx!;
    this.motorFilter = ctx.createBiquadFilter();
    this.motorFilter.type = 'lowpass';
    this.motorFilter.frequency.value = 1200;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.motorFilter.connect(this.motorGain).connect(this.master!);

    this.motorOsc = ctx.createOscillator();
    this.motorOsc.type = 'triangle';
    this.motorOsc.frequency.value = 70;
    this.motorOsc.connect(this.motorFilter);
    this.motorOsc.start();

    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.35; // quieter than the fundamental
    this.motorOsc2 = ctx.createOscillator();
    this.motorOsc2.type = 'sine';
    this.motorOsc2.frequency.value = 143;
    this.motorOsc2.connect(shimmerGain).connect(this.motorFilter);
    this.motorOsc2.start();

    const wind = ctx.createBufferSource();
    wind.buffer = this.noise!;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 350;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master!);
    wind.start();

    const squeal = ctx.createBufferSource();
    squeal.buffer = this.noise!;
    squeal.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 8;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    squeal.connect(bp).connect(this.squealGain).connect(this.master!);
    squeal.start();
  }

  /** Short synthesized blip. */
  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; slideTo?: number } = {},
  ): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = opts.type ?? 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (opts.slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.slideTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.gain ?? 0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Filtered noise burst (whoosh/crash). */
  private noiseBurst(
    dur: number,
    opts: { from?: number; to?: number; gain?: number; q?: number } = {},
  ): void {
    if (!this.ctx || !this.noise || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = opts.q ?? 1.2;
    bp.frequency.setValueAtTime(opts.from ?? 400, t);
    bp.frequency.exponentialRampToValueAtTime(opts.to ?? 1800, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.gain ?? 0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private arpeggio(freqs: number[], step = 0.09, gain = 0.16): void {
    if (!this.ctx || this.muted) return;
    freqs.forEach((f, i) => {
      const t = this.ctx!.currentTime + i * step;
      const osc = this.ctx!.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + step * 2.2);
      osc.connect(g).connect(this.master!);
      osc.start(t);
      osc.stop(t + step * 2.5);
    });
  }

  /** Volume scale for an event at world (x, y), heard from the local kart. */
  private hear(st: GameState, you: number, x: number, y: number): number {
    const me = st.karts[you]!;
    const d = Math.hypot(fxToFloat(me.x) - x, fxToFloat(me.y) - y);
    return Math.max(0.12, 1 - d / HEAR_RANGE);
  }

  /** Call once per render frame while a race is mounted. */
  update(controller: RaceController): void {
    if (!this.ctx || !this.master) return;
    const st = controller.state;
    const you = controller.you;

    this.updateEngineVoice(st, you);
    this.detectCountdown(st);
    this.detectKartEvents(st, you);
    this.detectShellEvents(st, you);
    this.detectOilEvents(st, you);

    this.prevPhase = st.phase;
  }

  /** Reset transition trackers at race start so old state can't misfire. */
  reset(): void {
    this.prevKarts = [];
    this.prevShellTtl = [];
    this.prevShellBounces = [];
    this.prevOilTtl = [];
    this.prevCountdownN = -1;
    this.prevPhase = -1;
  }

  private updateEngineVoice(st: GameState, you: number): void {
    const me = st.karts[you]!;
    const t = this.ctx!.currentTime;
    const speed = Math.hypot(fxToFloat(me.vx), fxToFloat(me.vy));
    const norm = Math.min(1, speed / (fxToFloat(MAX_SPEED) * 1.42));
    const boosting = me.boostTicks > 0;

    // motor whine: quadratic rise feels like an EV pulling — wide sweep,
    // shimmer riding just past an octave above so the partials beat slightly
    const whine = 70 + norm * norm * 760 + (boosting ? 90 : 0);
    this.motorOsc!.frequency.setTargetAtTime(whine, t, 0.06);
    this.motorOsc2!.frequency.setTargetAtTime(whine * 2.04, t, 0.06);
    this.motorFilter!.frequency.setTargetAtTime(900 + norm * 2600, t, 0.08);
    // near-silent at standstill — EVs creep quietly
    const motor = norm < 0.01 ? 0 : 0.012 + norm * 0.075;
    this.motorGain!.gain.setTargetAtTime(this.muted ? 0 : motor, t, 0.08);

    // road/wind noise carries the sense of speed instead of engine rumble
    this.windFilter!.frequency.setTargetAtTime(250 + norm * 900, t, 0.1);
    this.windGain!.gain.setTargetAtTime(this.muted ? 0 : norm * 0.05, t, 0.1);

    const squeal = me.driftDir !== 0 && speed > 0.1 ? 0.05 + Math.min(1, me.driftCharge / DRIFT_TIER2_TICKS) * 0.05 : 0;
    this.squealGain!.gain.setTargetAtTime(this.muted ? 0 : squeal, t, 0.05);
  }

  private detectCountdown(st: GameState): void {
    if (st.phase === PHASE_COUNTDOWN) {
      const n = Math.ceil((COUNTDOWN_TICKS - st.tick) / 60);
      if (n !== this.prevCountdownN && n >= 1 && n <= 3) this.tone(440, 0.12, { type: 'sine', gain: 0.2 });
      this.prevCountdownN = n;
    } else if (this.prevPhase === PHASE_COUNTDOWN && st.phase === PHASE_RACING) {
      this.tone(880, 0.4, { type: 'sine', gain: 0.24 });
      this.prevCountdownN = -1;
    }
  }

  private detectKartEvents(st: GameState, you: number): void {
    st.karts.forEach((k, i) => {
      const prev: KartPrev = this.prevKarts[i] ?? {
        heldItem: k.heldItem,
        boostTicks: 0,
        spinTicks: 0,
        driftTier: 0,
        finishTick: -1,
      };
      const local = i === you;
      const vol = local ? 1 : this.hear(st, you, fxToFloat(k.x), fxToFloat(k.y));

      // pickup chime (local only — remote pickups aren't your news)
      if (local && k.heldItem !== ITEM_NONE && prev.heldItem === ITEM_NONE) {
        this.arpeggio([660, 990]);
      }
      // boost ignition: a jump up in boostTicks (drift release, item, pad refresh)
      if (k.boostTicks > prev.boostTicks + 30 && k.boostTicks > 30 && prev.boostTicks < BOOST_CAP - 30) {
        this.noiseBurst(0.35, { from: 250, to: 2600, gain: 0.2 * vol });
      }
      // spin-out sting
      if (k.spinTicks > 0 && prev.spinTicks === 0) {
        this.tone(420, 0.5, { type: 'sawtooth', gain: 0.22 * vol, slideTo: 70 });
        this.noiseBurst(0.3, { from: 900, to: 200, gain: 0.18 * vol });
      }
      // drift charge tier-ups (local only — it's your charge meter)
      const tier = k.driftCharge >= DRIFT_TIER2_TICKS ? 2 : k.driftCharge >= DRIFT_TIER1_TICKS ? 1 : 0;
      if (local && tier > prev.driftTier) {
        this.tone(tier === 2 ? 1760 : 1320, 0.09, { type: 'sine', gain: 0.14 });
      }
      // finish line
      if (k.finishTick >= 0 && prev.finishTick < 0 && local) {
        this.arpeggio([523, 659, 784, 1047], 0.11, 0.2);
      }

      this.prevKarts[i] = {
        heldItem: k.heldItem,
        boostTicks: k.boostTicks,
        spinTicks: k.spinTicks,
        driftTier: tier,
        finishTick: k.finishTick,
      };
    });
  }

  private detectShellEvents(st: GameState, you: number): void {
    st.shells.forEach((s, i) => {
      const prevTtl = this.prevShellTtl[i] ?? 0;
      const prevBounces = this.prevShellBounces[i] ?? 0;
      const vol = this.hear(st, you, fxToFloat(s.x), fxToFloat(s.y));
      if (s.ttl > 0 && prevTtl === 0) {
        this.tone(240, 0.16, { type: 'square', gain: 0.2 * (s.owner === you ? 1 : vol), slideTo: 120 });
      } else if (s.ttl > 0 && s.bounces > prevBounces) {
        this.tone(320, 0.06, { type: 'square', gain: 0.16 * vol });
      }
      // a hit plays the victim's spin-out sting via detectKartEvents
      this.prevShellTtl[i] = s.ttl;
      this.prevShellBounces[i] = s.bounces;
    });
  }

  private detectOilEvents(st: GameState, you: number): void {
    st.oils.forEach((o, i) => {
      const prevTtl = this.prevOilTtl[i] ?? 0;
      if (o.ttl > 0 && prevTtl === 0) {
        const vol = this.hear(st, you, fxToFloat(o.x), fxToFloat(o.y));
        this.tone(170, 0.22, { type: 'sine', gain: 0.2 * vol, slideTo: 55 });
      }
      this.prevOilTtl[i] = o.ttl;
    });
  }
}
