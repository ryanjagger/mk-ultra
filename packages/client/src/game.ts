/**
 * Race controller: owns the RollbackSession, paces the sim against the
 * synced server clock, feeds local input with zero delay, relays inputs and
 * confirmed-state hashes, and exposes interpolated render state.
 *
 * The renderer only ever READS from this (NFR-7).
 */
import {
  RollbackSession,
  TICK_RATE,
  COUNTDOWN_TICKS,
  PHASE_FINISHED,
  fxToFloat,
  hashState,
  computePlacements,
  getTrack,
  onDirt,
  type RaceConfig,
  type GameState,
  type TrackRuntime,
} from '@mk/sim';
import { HASH_INTERVAL } from '@mk/shared';
import type { Net } from './net.js';
import type { ClockSync } from './clock.js';
import type { Keyboard } from './keyboard.js';
import { botMask } from './autodrive.js';

export interface KartRender {
  x: number;
  z: number;
  /** ramp-jump height above the road, world units */
  jump: number;
  headingRad: number;
  speed: number;
  boosting: boolean;
  driftDir: number;
  driftCharge: number;
  spinTicks: number;
  finished: boolean;
  onDirt: boolean;
}

/**
 * The controller surface the HUD, renderer and audio consume — implemented
 * by the networked RaceController and the offline TimeTrialController.
 */
export interface RaceLike {
  readonly you: number;
  readonly names: string[];
  stalled: boolean;
  readonly state: GameState;
  update(): void;
  renderKarts(dt: number): KartRender[];
  placements(): number[];
  raceTimeSec(): number;
  finishTimeSec(kart: number): number | null;
  debugText(pingMs: number): string;
}

const TWO_PI = Math.PI * 2;

function headingToRad(brads: number): number {
  return ((brads & 0xffff) / 65536) * TWO_PI;
}

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

export function snapshotKarts(state: GameState, track: TrackRuntime): KartRender[] {
  return state.karts.map((k) => ({
    x: fxToFloat(k.x),
    z: -fxToFloat(k.y), // sim y (north) -> three -z
    jump: fxToFloat(k.z),
    headingRad: headingToRad(k.heading),
    speed: Math.hypot(fxToFloat(k.vx), fxToFloat(k.vy)),
    boosting: k.boostTicks > 0,
    driftDir: k.driftDir,
    driftCharge: k.driftCharge,
    spinTicks: k.spinTicks,
    finished: k.finishTick >= 0,
    onDirt: track.hasDirt && onDirt(track, k.x, k.y),
  }));
}

export class RaceController implements RaceLike {
  readonly session: RollbackSession;
  readonly you: number;
  readonly names: string[];
  readonly cfg: RaceConfig;
  private startAtMs: number;

  private lastInputFrame = -1;
  private nextHashFrame = HASH_INTERVAL;
  raceEndedSent = false;
  desyncFrame: number | null = null;
  stalled = false;

  private trackRt: TrackRuntime;
  private prevKarts: KartRender[];
  private currKarts: KartRender[];
  /** visually smoothed karts (remote pops from rollback get eased out) */
  private visualKarts: KartRender[];
  private alpha = 0;

  constructor(
    private net: Net,
    private clock: ClockSync,
    private keyboard: Keyboard,
    opts: {
      seed: number;
      laps: number;
      trackId: string;
      startAtMs: number;
      you: number;
      names: string[];
      bots?: boolean[];
    },
    private bot = false,
  ) {
    this.cfg = {
      seed: opts.seed,
      lapCount: opts.laps,
      playerCount: opts.names.length,
      trackId: opts.trackId,
      bots: opts.bots,
    };
    this.session = new RollbackSession(this.cfg, opts.you);
    this.you = opts.you;
    this.names = opts.names;
    this.startAtMs = opts.startAtMs;
    this.trackRt = getTrack(opts.trackId);
    this.prevKarts = snapshotKarts(this.session.state, this.trackRt);
    this.currKarts = snapshotKarts(this.session.state, this.trackRt);
    this.visualKarts = snapshotKarts(this.session.state, this.trackRt);
  }

  get state(): GameState {
    return this.session.state;
  }

  onRemoteInput(p: number, f: number, m: number): void {
    if (p === this.you) return;
    this.session.addInput(p, f, m);
  }

  onDropped(p: number, fromFrame: number): void {
    this.session.dropPlayer(p, fromFrame);
  }

  onDesync(frame: number, detail: string): void {
    this.desyncFrame = frame;
    console.error(
      `%c!!! DESYNC at frame ${frame} — simulations diverged (${detail})`,
      'color:#ff4757;font-weight:bold;font-size:14px',
    );
  }

  /** Advance the sim toward the wall-clock target. Call once per RAF. */
  update(): void {
    const elapsedMs = this.clock.serverNow() - this.startAtMs;
    if (elapsedMs < 0) {
      this.alpha = 0;
      return;
    }
    const elapsedTicks = (elapsedMs / 1000) * TICK_RATE;
    let target = Math.floor(elapsedTicks);

    // hopelessly behind (hidden tab): rebase instead of a mega-burst
    if (target - this.session.frame > 120) {
      const skip = target - this.session.frame - 30;
      this.startAtMs += (skip / TICK_RATE) * 1000;
      target = this.session.frame + 30;
    }

    this.stalled = false;
    let advances = 0;
    while (this.session.frame < target && advances < 30) {
      const f = this.session.frame;
      if (f > this.lastInputFrame) {
        const mask = this.bot ? botMask(this.session.state, this.you) : this.keyboard.sample();
        this.session.addLocalInput(mask);
        this.net.send({ t: 'input', f, m: mask });
        this.lastInputFrame = f;
      }
      this.prevKarts = this.currKarts;
      if (!this.session.advance()) {
        this.stalled = true;
        break;
      }
      this.currKarts = snapshotKarts(this.session.state, this.trackRt);
      advances++;
    }
    // apply any corrections that arrived while we were paced out
    this.session.applyCorrections();
    if (advances > 0) this.currKarts = snapshotKarts(this.session.state, this.trackRt);

    this.alpha = Math.min(Math.max(elapsedTicks - this.session.frame + 1, 0), 1);
    this.sendHashes();

    if (this.state.phase === PHASE_FINISHED && !this.raceEndedSent) {
      this.raceEndedSent = true;
      // deterministic placements ride along for cup scoring (first reporter wins)
      this.net.send({ t: 'raceEnded', placements: computePlacements(this.state) });
    }
  }

  private sendHashes(): void {
    const confirmedState = Math.min(this.session.confirmedFrame() + 1, this.session.frame);
    while (this.nextHashFrame <= confirmedState) {
      const h = this.session.confirmedHash(this.nextHashFrame);
      if (h !== null) this.net.send({ t: 'hash', f: this.nextHashFrame, h });
      this.nextHashFrame += HASH_INTERVAL;
    }
  }

  /** Interpolated + smoothed kart poses for rendering. dt in seconds. */
  renderKarts(dt: number): KartRender[] {
    const a = this.alpha;
    const smooth = 1 - Math.pow(0.0001, dt); // ~exponential catch-up
    for (let i = 0; i < this.currKarts.length; i++) {
      const p = this.prevKarts[i]!;
      const c = this.currKarts[i]!;
      const tx = p.x + (c.x - p.x) * a;
      const tz = p.z + (c.z - p.z) * a;
      const tj = p.jump + (c.jump - p.jump) * a;
      const th = lerpAngle(p.headingRad, c.headingRad, a);
      const v = this.visualKarts[i]!;
      if (i === this.you) {
        // local kart: exact — zero added latency
        v.x = tx;
        v.z = tz;
        v.jump = tj;
        v.headingRad = th;
      } else {
        v.x += (tx - v.x) * smooth;
        v.z += (tz - v.z) * smooth;
        v.jump += (tj - v.jump) * smooth;
        v.headingRad = lerpAngle(v.headingRad, th, smooth);
      }
      v.speed = c.speed;
      v.boosting = c.boosting;
      v.driftDir = c.driftDir;
      v.driftCharge = c.driftCharge;
      v.spinTicks = c.spinTicks;
      v.finished = c.finished;
      v.onDirt = c.onDirt;
    }
    return this.visualKarts;
  }

  placements(): number[] {
    return computePlacements(this.state);
  }

  /** Race clock in seconds (post-countdown). */
  raceTimeSec(): number {
    return Math.max(0, this.state.tick - COUNTDOWN_TICKS) / TICK_RATE;
  }

  finishTimeSec(kart: number): number | null {
    const ft = this.state.karts[kart]!.finishTick;
    return ft >= 0 ? (ft - COUNTDOWN_TICKS) / TICK_RATE : null;
  }

  debugText(pingMs: number): string {
    const s = this.session;
    return [
      `frame      ${s.frame}`,
      `confirmed  ${Math.min(s.confirmedFrame(), s.frame)} (lag ${s.frame - Math.min(s.confirmedFrame(), s.frame)})`,
      `rollbacks  ${s.stats.rollbacks} (last depth ${s.stats.lastRollbackDepth})`,
      `resims     ${s.stats.rolledBackFrames}`,
      `stalls     ${s.stats.stalledFrames}`,
      `ping       ${pingMs.toFixed(0)} ms`,
      `state hash ${(hashState(this.state) >>> 0).toString(16)}`,
    ].join('\n');
  }
}
