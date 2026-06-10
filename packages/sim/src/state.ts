/**
 * Game state, snapshot serialization and state hashing.
 *
 * The entire mutable state is plain int32 fields; a snapshot is a fixed-layout
 * Int32Array copy (cheap to save/restore every frame for rollback) and the
 * state hash is FNV-1a over those bytes.
 */
import type { Fx } from './fixed.js';
import { rngNextState } from './prng.js';
import { getTrack, TRACKS, type TrackRuntime } from './track.js';

export const MAX_PLAYERS = 4;
export const TICK_RATE = 60;
export const COUNTDOWN_TICKS = 180; // 3s of 3-2-1 before control unlocks

export const PHASE_COUNTDOWN = 0;
export const PHASE_RACING = 1;
export const PHASE_FINISHED = 2;

/** Ticks after the first finisher before stragglers are cut off. */
export const STRAGGLER_TICKS = 45 * TICK_RATE;
/** Absolute cap on race length. */
export const MAX_RACE_TICKS = 600 * TICK_RATE;

export interface RaceConfig {
  seed: number;
  lapCount: number;
  playerCount: number;
  /** registry track id; undefined = the classic track (back-compat) */
  trackId?: string;
}

export interface KartState {
  x: Fx;
  y: Fx;
  vx: Fx;
  vy: Fx;
  heading: number; // brads, 0..65535
  driftDir: number; // -1 | 0 | 1
  driftCharge: number; // ticks held
  boostTicks: number;
  nextCp: number; // gate index that counts next (0 = finish line)
  lap: number; // 1-based; lapCount+1 => finished
  finishTick: number; // -1 until finished
}

export interface GameState {
  readonly cfg: RaceConfig; // static per race — not part of snapshots
  readonly track: TrackRuntime; // derived from cfg.trackId — not part of snapshots
  tick: number;
  rng: number;
  phase: number;
  endTick: number; // -1 until PHASE_FINISHED
  karts: KartState[]; // length cfg.playerCount
  /** Per item spawn: tick at which it is (re)active. Active when tick >= value. */
  items: number[];
}

const KART_INTS = 11;
const GLOBAL_INTS = 4;

export function snapshotInts(cfg: RaceConfig): number {
  return GLOBAL_INTS + cfg.playerCount * KART_INTS + getTrack(cfg.trackId).itemSpawns.length;
}

export function createGameState(cfg: RaceConfig): GameState {
  const track = getTrack(cfg.trackId);
  // mix the seed a little so similar seeds diverge immediately
  let rng = cfg.seed | 0;
  rng = rngNextState(rng);
  rng = rngNextState(rng);

  const karts: KartState[] = [];
  for (let i = 0; i < cfg.playerCount; i++) {
    const s = track.spawns[i]!;
    karts.push({
      x: s.x,
      y: s.y,
      vx: 0,
      vy: 0,
      heading: s.heading,
      driftDir: 0,
      driftCharge: 0,
      boostTicks: 0,
      nextCp: 1,
      lap: 1,
      finishTick: -1,
    });
  }

  return {
    cfg,
    track,
    tick: 0,
    rng,
    phase: PHASE_COUNTDOWN,
    endTick: -1,
    karts,
    items: track.itemSpawns.map(() => 0),
  };
}

export function writeSnapshot(st: GameState, out: Int32Array): void {
  let i = 0;
  out[i++] = st.tick;
  out[i++] = st.rng;
  out[i++] = st.phase;
  out[i++] = st.endTick;
  for (const k of st.karts) {
    out[i++] = k.x;
    out[i++] = k.y;
    out[i++] = k.vx;
    out[i++] = k.vy;
    out[i++] = k.heading;
    out[i++] = k.driftDir;
    out[i++] = k.driftCharge;
    out[i++] = k.boostTicks;
    out[i++] = k.nextCp;
    out[i++] = k.lap;
    out[i++] = k.finishTick;
  }
  for (let j = 0; j < st.items.length; j++) out[i++] = st.items[j]!;
}

export function readSnapshot(st: GameState, arr: Int32Array): void {
  let i = 0;
  st.tick = arr[i++]!;
  st.rng = arr[i++]!;
  st.phase = arr[i++]!;
  st.endTick = arr[i++]!;
  for (const k of st.karts) {
    k.x = arr[i++]!;
    k.y = arr[i++]!;
    k.vx = arr[i++]!;
    k.vy = arr[i++]!;
    k.heading = arr[i++]!;
    k.driftDir = arr[i++]!;
    k.driftCharge = arr[i++]!;
    k.boostTicks = arr[i++]!;
    k.nextCp = arr[i++]!;
    k.lap = arr[i++]!;
    k.finishTick = arr[i++]!;
  }
  for (let j = 0; j < st.items.length; j++) st.items[j] = arr[i++]!;
}

/** FNV-1a (32-bit) over the snapshot ints, byte by byte. */
export function hashSnapshot(a: Int32Array): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    h = Math.imul(h ^ (v & 0xff), 16777619);
    h = Math.imul(h ^ ((v >>> 8) & 0xff), 16777619);
    h = Math.imul(h ^ ((v >>> 16) & 0xff), 16777619);
    h = Math.imul(h ^ (v >>> 24), 16777619);
  }
  return h >>> 0;
}

// sized for the largest registered track so hashState never overflows
const MAX_ITEM_SPAWNS = TRACKS.reduce((m, t) => (t.itemSpawns.length > m ? t.itemSpawns.length : m), 0);
const scratch = new Int32Array(GLOBAL_INTS + MAX_PLAYERS * KART_INTS + MAX_ITEM_SPAWNS);

export function hashState(st: GameState): number {
  const view = scratch.subarray(0, snapshotInts(st.cfg));
  writeSnapshot(st, view);
  return hashSnapshot(view);
}
