/**
 * Rollback netcode core (GGPO-style), transport-agnostic and Node-testable.
 *
 * - Local inputs apply at the current frame with zero delay (NFR-9).
 * - Missing remote inputs are predicted by repeating that player's last
 *   confirmed input.
 * - When a correction arrives for a past frame, we restore the snapshot at
 *   that frame and re-simulate to the present (NFR-11).
 * - If prediction would exceed `maxPrediction` frames past the oldest
 *   unconfirmed remote input, we stall instead of advancing (NFR-10).
 */
import {
  type GameState,
  type RaceConfig,
  createGameState,
  snapshotInts,
  writeSnapshot,
  readSnapshot,
  hashSnapshot,
} from './state.js';
import { stepSim } from './sim.js';
import { INPUT_NEUTRAL } from './input.js';

export const DEFAULT_MAX_PREDICTION = 8;
/** Snapshot ring length; also bounds how late a confirmed-frame hash can be taken. */
const SNAPSHOT_RING = 512;

export interface RollbackStats {
  rollbacks: number;
  rolledBackFrames: number;
  stalledFrames: number;
  lastRollbackDepth: number;
}

export class RollbackSession {
  readonly cfg: RaceConfig;
  readonly localPlayer: number;
  readonly maxPrediction: number;

  /** Number of frames simulated; the current state is at this frame. */
  frame = 0;
  state: GameState;

  private readonly players: number;
  /** inputs[p][f] = confirmed input mask (undefined = not yet known). */
  private readonly inputs: (number | undefined)[][];
  /** Highest frame F such that every frame <= F has a confirmed input for p. */
  private readonly contig: number[];
  /** Frame from which player p is gone and inputs are neutral-confirmed. */
  private readonly droppedFrom: number[];
  /** used[p][f] = mask actually fed to the sim when simulating frame f. */
  private readonly used: number[][];

  private readonly snapInts: number;
  private readonly snapshots: Int32Array[];
  private readonly snapshotFrame: number[];

  /** Earliest frame whose used input is now known to be wrong (-1 = none). */
  private dirtyFrame = -1;

  readonly stats: RollbackStats = {
    rollbacks: 0,
    rolledBackFrames: 0,
    stalledFrames: 0,
    lastRollbackDepth: 0,
  };

  constructor(cfg: RaceConfig, localPlayer: number, maxPrediction = DEFAULT_MAX_PREDICTION) {
    this.cfg = cfg;
    this.localPlayer = localPlayer;
    this.maxPrediction = maxPrediction;
    this.players = cfg.playerCount;
    this.state = createGameState(cfg);
    this.inputs = [];
    this.used = [];
    this.contig = [];
    this.droppedFrom = [];
    for (let p = 0; p < this.players; p++) {
      this.inputs.push([]);
      this.used.push([]);
      this.contig.push(-1);
      // CPU seats never send inputs: neutral-confirmed from frame 0 (stepSim
      // computes their real masks from state) so they never stall prediction
      this.droppedFrom.push(cfg.bots?.[p] ? 0 : Number.MAX_SAFE_INTEGER);
    }
    this.snapInts = snapshotInts(cfg);
    this.snapshots = [];
    this.snapshotFrame = [];
    for (let i = 0; i < SNAPSHOT_RING; i++) {
      this.snapshots.push(new Int32Array(this.snapInts));
      this.snapshotFrame.push(-1);
    }
    this.saveSnapshot(0); // state at frame 0
  }

  /** Confirmed input for (p, f) taking drops into account, or undefined. */
  private confirmedInput(p: number, f: number): number | undefined {
    if (f >= this.droppedFrom[p]!) return INPUT_NEUTRAL;
    return this.inputs[p]![f];
  }

  /** Best-known input for (p, f): confirmed, else repeat the latest known one before f. */
  private bestInput(p: number, f: number): number {
    for (let g = f; g >= 0; g--) {
      const v = this.confirmedInput(p, g);
      if (v !== undefined) return v;
    }
    return INPUT_NEUTRAL;
  }

  /** Highest frame through which p's inputs are contiguously confirmed. */
  contigFrame(p: number): number {
    if (this.droppedFrom[p]! <= this.contig[p]! + 1) return Number.MAX_SAFE_INTEGER;
    return this.contig[p]!;
  }

  /** Highest frame F such that ALL players' inputs are confirmed through F. */
  confirmedFrame(): number {
    let m = Number.MAX_SAFE_INTEGER;
    for (let p = 0; p < this.players; p++) {
      const c = this.contigFrame(p);
      if (c < m) m = c;
    }
    return m;
  }

  addLocalInput(mask: number): void {
    this.addInput(this.localPlayer, this.frame, mask);
  }

  /**
   * Record a confirmed input. First write wins (the server relays in
   * first-arrival order, so all peers agree). If it contradicts an input we
   * already simulated with, schedule a rollback.
   */
  addInput(player: number, frame: number, mask: number): void {
    const arr = this.inputs[player]!;
    if (arr[frame] !== undefined) return;
    arr[frame] = mask;
    // advance contiguous-confirmed pointer
    let c = this.contig[player]!;
    while (arr[c + 1] !== undefined) c++;
    this.contig[player] = c;
    // misprediction check
    if (frame < this.frame) {
      const usedMask = this.used[player]![frame];
      if (usedMask !== undefined && usedMask !== mask) {
        if (this.dirtyFrame < 0 || frame < this.dirtyFrame) this.dirtyFrame = frame;
      }
    }
  }

  /** Player permanently gone; inputs are neutral-confirmed from `fromFrame`. */
  dropPlayer(player: number, fromFrame: number): void {
    this.droppedFrom[player] = fromFrame;
    // re-check frames we already simulated with predictions for this player
    for (let f = fromFrame; f < this.frame; f++) {
      const usedMask = this.used[player]![f];
      if (usedMask !== undefined && usedMask !== INPUT_NEUTRAL) {
        if (this.dirtyFrame < 0 || f < this.dirtyFrame) this.dirtyFrame = f;
        break;
      }
    }
  }

  private saveSnapshot(frame: number): void {
    const slot = frame % SNAPSHOT_RING;
    writeSnapshot(this.state, this.snapshots[slot]!);
    this.snapshotFrame[slot] = frame;
  }

  private restoreSnapshot(frame: number): void {
    const slot = frame % SNAPSHOT_RING;
    if (this.snapshotFrame[slot] !== frame) {
      throw new Error(`rollback: snapshot for frame ${frame} no longer in ring`);
    }
    readSnapshot(this.state, this.snapshots[slot]!);
  }

  private simulateFrame(): void {
    const masks: number[] = [];
    for (let p = 0; p < this.players; p++) {
      const m = this.bestInput(p, this.frame);
      this.used[p]![this.frame] = m;
      masks.push(m);
    }
    stepSim(this.state, masks);
    this.frame += 1;
    this.saveSnapshot(this.frame);
  }

  /** Apply any pending correction: restore + re-simulate to the present. */
  applyCorrections(): void {
    if (this.dirtyFrame < 0) return;
    const target = this.frame;
    const depth = target - this.dirtyFrame;
    this.restoreSnapshot(this.dirtyFrame);
    this.frame = this.dirtyFrame;
    this.dirtyFrame = -1;
    while (this.frame < target) {
      this.simulateFrame();
    }
    this.stats.rollbacks += 1;
    this.stats.rolledBackFrames += depth;
    this.stats.lastRollbackDepth = depth;
  }

  /**
   * Try to advance one frame. The local input for the current frame must
   * already have been added (addLocalInput). Returns false when stalled at
   * the prediction limit.
   */
  advance(): boolean {
    this.applyCorrections();
    // stall if any remote player is too far behind
    let oldest = Number.MAX_SAFE_INTEGER;
    for (let p = 0; p < this.players; p++) {
      if (p === this.localPlayer) continue;
      const c = this.contigFrame(p);
      if (c < oldest) oldest = c;
    }
    if (this.players > 1 && this.frame - oldest > this.maxPrediction) {
      this.stats.stalledFrames += 1;
      return false;
    }
    this.simulateFrame();
    return true;
  }

  /**
   * Hash of the state at `frame`, valid only for fully-confirmed frames that
   * are still inside the snapshot ring. Returns null if unavailable.
   */
  confirmedHash(frame: number): number | null {
    if (frame > this.confirmedFrame() + 1 || frame > this.frame) return null;
    if (this.dirtyFrame >= 0 && this.dirtyFrame < frame) this.applyCorrections();
    const slot = frame % SNAPSHOT_RING;
    if (this.snapshotFrame[slot] !== frame) return null;
    return hashSnapshot(this.snapshots[slot]!);
  }
}
