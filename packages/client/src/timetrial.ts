/**
 * Offline time-trial controller: one local kart, fixed timestep, no netcode.
 * Records the input mask every tick; the stored best run is replayed as a
 * ghost — a second, independent sim instance fed the recorded inputs, which
 * determinism makes bit-exact. Only inputs are ever stored.
 */
import {
  createGameState,
  stepSim,
  computePlacements,
  getTrack,
  hashState,
  COUNTDOWN_TICKS,
  TICK_RATE,
  PHASE_FINISHED,
  type GameState,
  type TrackRuntime,
} from '@mk/sim';
import { botMask } from './autodrive.js';
import type { Keyboard } from './keyboard.js';
import {
  snapshotKarts,
  writeKarts,
  fillKart,
  lerpAngle,
  type KartRender,
  type RaceLike,
} from './game.js';
import {
  TT_SEED,
  encodeRle,
  decodeRle,
  loadGhost,
  saveGhost,
  type GhostRecord,
} from './ghosts.js';

export interface TimeTrialResult {
  timeSec: number;
  /** previous best, if there was one */
  bestSec: number | null;
  isRecord: boolean;
}

export class TimeTrialController implements RaceLike {
  readonly you = 0;
  readonly names = ['Racer']; // results row reads "Racer (you)"
  stalled = false;
  readonly state: GameState;
  readonly trackId: string;
  readonly laps: number;
  /** set once, the frame the run finishes */
  result: TimeTrialResult | null = null;
  /** the finished run's input stream — leaderboard submission payload */
  finishedRle: [number, number][] | null = null;

  private readonly track: TrackRuntime;
  private startAt: number;
  private recorded: number[] = [];
  private prevKarts: KartRender[];
  private currKarts: KartRender[];
  private visualKarts: KartRender[];
  private alpha = 0;

  private readonly ghost: GhostRecord | null;
  private ghostSim: GameState | null = null;
  private ghostInputs: number[] = [];
  private ghostPrev: KartRender | null = null;
  private ghostCurr: KartRender | null = null;

  constructor(
    private readonly keyboard: Keyboard,
    opts: { trackId: string; laps: number; ghostOverride?: GhostRecord },
    private readonly bot = false,
  ) {
    this.trackId = opts.trackId;
    this.laps = opts.laps;
    this.track = getTrack(opts.trackId);
    this.state = createGameState({
      seed: TT_SEED,
      lapCount: opts.laps,
      playerCount: 1,
      trackId: opts.trackId,
    });
    // a downloaded leaderboard ghost replaces the local best for this run
    this.ghost = opts.ghostOverride ?? loadGhost(opts.trackId, opts.laps);
    if (this.ghost) {
      this.ghostSim = createGameState({
        seed: this.ghost.seed,
        lapCount: opts.laps,
        playerCount: 1,
        trackId: opts.trackId,
      });
      this.ghostInputs = decodeRle(this.ghost.rle);
      // two distinct objects — ping-pong of an aliased pair would collapse
      // prev===curr permanently and kill interpolation.
      this.ghostPrev = snapshotKarts(this.ghostSim, this.track)[0]!;
      this.ghostCurr = snapshotKarts(this.ghostSim, this.track)[0]!;
    }
    this.prevKarts = snapshotKarts(this.state, this.track);
    this.currKarts = snapshotKarts(this.state, this.track);
    this.visualKarts = snapshotKarts(this.state, this.track);
    this.startAt = performance.now() + 500;
  }

  /** Previous best in seconds, or null if the track is unrecorded. */
  get bestSec(): number | null {
    return this.ghost ? (this.ghost.finishTick - COUNTDOWN_TICKS) / TICK_RATE : null;
  }

  get hasGhost(): boolean {
    return this.ghost !== null;
  }

  update(): void {
    const elapsed = (performance.now() - this.startAt) / 1000;
    if (elapsed < 0) {
      this.alpha = 0;
      return;
    }
    const elapsedTicks = elapsed * TICK_RATE;
    let target = Math.floor(elapsedTicks);
    // hidden-tab catch-up: rebase the clock rather than mega-burst the sim
    if (target - this.state.tick > 120) {
      this.startAt += ((target - this.state.tick - 30) / TICK_RATE) * 1000;
      target = this.state.tick + 30;
    }

    while (this.state.tick < target) {
      const finishedBefore = this.state.phase === PHASE_FINISHED;
      if (!finishedBefore) {
        const mask = this.bot ? botMask(this.state, 0) : this.keyboard.sample();
        this.recorded.push(mask);
        stepSim(this.state, [mask]);
        const tmp = this.prevKarts;
        this.prevKarts = this.currKarts;
        this.currKarts = tmp;
        writeKarts(this.currKarts, this.state, this.track);
        if (this.state.phase === PHASE_FINISHED) this.onFinish();
      } else {
        stepSim(this.state, [0]); // tick the clock; the world is frozen
      }

      // the ghost advances in lockstep, one tick per live tick
      if (this.ghostSim && this.ghostSim.phase !== PHASE_FINISHED) {
        const gmask = this.ghostInputs[this.ghostSim.tick] ?? 0;
        stepSim(this.ghostSim, [gmask]);
        const g = this.ghostPrev;
        this.ghostPrev = this.ghostCurr;
        this.ghostCurr = g;
        fillKart(this.ghostCurr!, this.ghostSim.karts[0]!, this.track);
      }
    }
    this.alpha = Math.min(Math.max(elapsedTicks - this.state.tick + 1, 0), 1);
  }

  private onFinish(): void {
    const ft = this.state.karts[0]!.finishTick;
    const bestSec = this.bestSec;
    const isRecord = this.ghost === null || ft < this.ghost.finishTick;
    const rle = encodeRle(this.recorded.slice(0, ft));
    this.finishedRle = rle;
    if (isRecord) {
      saveGhost({
        v: 1,
        trackId: this.trackId,
        laps: this.laps,
        seed: TT_SEED,
        finishTick: ft,
        rle,
      });
    }
    this.result = {
      timeSec: (ft - COUNTDOWN_TICKS) / TICK_RATE,
      bestSec,
      isRecord,
    };
  }

  renderKarts(_dt: number): KartRender[] {
    const p = this.prevKarts[0]!;
    const c = this.currKarts[0]!;
    const v = this.visualKarts[0]!;
    const a = this.alpha;
    v.x = p.x + (c.x - p.x) * a;
    v.z = p.z + (c.z - p.z) * a;
    v.jump = p.jump + (c.jump - p.jump) * a;
    v.headingRad = lerpAngle(p.headingRad, c.headingRad, a);
    v.speed = c.speed;
    v.boosting = c.boosting;
    v.driftDir = c.driftDir;
    v.driftCharge = c.driftCharge;
    v.spinTicks = c.spinTicks;
    v.finished = c.finished;
    v.onDirt = c.onDirt;
    return this.visualKarts;
  }

  /** Interpolated ghost pose, or null before the start / after it finishes. */
  ghostRender(): KartRender | null {
    if (!this.ghostSim || !this.ghostPrev || !this.ghostCurr) return null;
    if (this.ghostSim.phase === PHASE_FINISHED) return null; // vanish at the line
    const p = this.ghostPrev;
    const c = this.ghostCurr;
    const a = this.alpha;
    return {
      ...c,
      x: p.x + (c.x - p.x) * a,
      z: p.z + (c.z - p.z) * a,
      jump: p.jump + (c.jump - p.jump) * a,
      headingRad: lerpAngle(p.headingRad, c.headingRad, a),
    };
  }

  placements(): number[] {
    return computePlacements(this.state);
  }

  raceTimeSec(): number {
    return Math.max(0, this.state.tick - COUNTDOWN_TICKS) / TICK_RATE;
  }

  finishTimeSec(kart: number): number | null {
    const ft = this.state.karts[kart]!.finishTick;
    return ft >= 0 ? (ft - COUNTDOWN_TICKS) / TICK_RATE : null;
  }

  debugText(_pingMs: number): string {
    return [
      `tick       ${this.state.tick}`,
      `ghost tick ${this.ghostSim?.tick ?? '—'}`,
      `recorded   ${this.recorded.length} inputs`,
      `state hash ${(hashState(this.state) >>> 0).toString(16)}`,
    ].join('\n');
  }
}
