/**
 * Race replay: the deterministic sim re-runs the server's canonical input
 * record of the last finished race — same seed, same inputs, bit-identical
 * race. The chase camera follows a switchable focus kart.
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
import { decodeRle, type ServerMsg } from '@mk/shared';
import { snapshotKarts, lerpAngle, type KartRender, type RaceLike } from './game.js';

export type ReplayData = Extract<ServerMsg, { t: 'replay' }>;

const LINGER_TICKS = 150; // hold the final frame ~2.5s before auto-exit

export class ReplayController implements RaceLike {
  /** chase-cam target; switched with the number keys */
  focus = 0;
  readonly names: string[];
  stalled = false;
  readonly state: GameState;
  /** true once the replay has played out (auto-exit point) */
  done = false;

  private readonly track: TrackRuntime;
  private readonly inputs: number[][];
  private readonly maxTick: number;
  private startAt: number;
  private finishedAt = -1;
  private prevKarts: KartRender[];
  private currKarts: KartRender[];
  private visualKarts: KartRender[];
  private alpha = 0;

  get you(): number {
    return this.focus;
  }

  constructor(data: ReplayData) {
    this.names = data.players;
    this.track = getTrack(data.trackId);
    this.state = createGameState({
      seed: data.seed,
      lapCount: data.laps,
      playerCount: data.players.length,
      trackId: data.trackId,
      bots: data.bots, // CPU karts re-drive themselves; their input logs are empty
    });
    this.inputs = data.inputs.map(decodeRle);
    // safety stop: if the recording ends without the race finishing
    this.maxTick = Math.max(...this.inputs.map((a) => a.length)) + TICK_RATE * 10;
    this.prevKarts = snapshotKarts(this.state, this.track);
    this.currKarts = snapshotKarts(this.state, this.track);
    this.visualKarts = snapshotKarts(this.state, this.track);
    this.startAt = performance.now() + 300;
  }

  update(): void {
    const elapsed = (performance.now() - this.startAt) / 1000;
    if (elapsed < 0) {
      this.alpha = 0;
      return;
    }
    const elapsedTicks = elapsed * TICK_RATE;
    let target = Math.floor(elapsedTicks);
    if (target - this.state.tick > 120) {
      this.startAt += ((target - this.state.tick - 30) / TICK_RATE) * 1000;
      target = this.state.tick + 30;
    }
    while (this.state.tick < target && !this.done) {
      const masks = this.state.karts.map((_, i) => this.inputs[i]![this.state.tick] ?? 0);
      this.prevKarts = this.currKarts;
      stepSim(this.state, masks);
      this.currKarts = snapshotKarts(this.state, this.track);
      if (this.state.phase === PHASE_FINISHED && this.finishedAt < 0) {
        this.finishedAt = this.state.tick;
      }
      const pastEnd = this.finishedAt >= 0 && this.state.tick > this.finishedAt + LINGER_TICKS;
      if (pastEnd || this.state.tick > this.maxTick) this.done = true;
    }
    this.alpha = Math.min(Math.max(elapsedTicks - this.state.tick + 1, 0), 1);
  }

  renderKarts(_dt: number): KartRender[] {
    const a = this.alpha;
    for (let i = 0; i < this.currKarts.length; i++) {
      const p = this.prevKarts[i]!;
      const c = this.currKarts[i]!;
      const v = this.visualKarts[i]!;
      v.x = p.x + (c.x - p.x) * a;
      v.z = p.z + (c.z - p.z) * a;
      v.headingRad = lerpAngle(p.headingRad, c.headingRad, a);
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

  raceTimeSec(): number {
    return Math.max(0, this.state.tick - COUNTDOWN_TICKS) / TICK_RATE;
  }

  finishTimeSec(kart: number): number | null {
    const ft = this.state.karts[kart]!.finishTick;
    return ft >= 0 ? (ft - COUNTDOWN_TICKS) / TICK_RATE : null;
  }

  debugText(_pingMs: number): string {
    return [
      `REPLAY tick ${this.state.tick}`,
      `focus      ${this.focus} (${this.names[this.focus]})`,
      `state hash ${(hashState(this.state) >>> 0).toString(16)}`,
    ].join('\n');
  }
}
