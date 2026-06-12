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

/** KartState.heldItem when empty-handed. Item types live in items.ts. */
export const ITEM_NONE = -1;

/** Ticks after the first finisher before stragglers are cut off. */
export const STRAGGLER_TICKS = 45 * TICK_RATE;
/** Absolute cap on race length. */
export const MAX_RACE_TICKS = 600 * TICK_RATE;
/** Battle mode: starting balloons and the round time limit. */
export const BATTLE_BALLOONS = 3;
export const BATTLE_TICKS = 150 * TICK_RATE;

export interface RaceConfig {
  seed: number;
  lapCount: number;
  playerCount: number;
  /** registry track id; undefined = the classic track (back-compat) */
  trackId?: string;
  /**
   * 'battle': no laps — every kart carries balloons, hits pop them, last
   * kart flying wins. undefined = 'race'.
   */
  mode?: 'race' | 'battle';
  /**
   * Per-seat CPU flags. Bot masks are computed inside stepSim as a pure
   * function of state — identical on every client, never on the wire.
   */
  bots?: readonly boolean[];
}

export interface KartState {
  x: Fx;
  y: Fx;
  vx: Fx;
  vy: Fx;
  z: Fx; // height above the road surface; 0 = grounded
  vz: Fx; // vertical speed while airborne (ramp jumps)
  heading: number; // brads, 0..65535
  driftDir: number; // -1 | 0 | 1
  driftCharge: number; // ticks held
  boostTicks: number;
  nextCp: number; // gate index that counts next (0 = finish line)
  lap: number; // 1-based; lapCount+1 => finished
  finishTick: number; // -1 until finished
  heldItem: number; // ITEM_NONE or an ITEM_* type (items.ts)
  spinTicks: number; // spin-out remaining; controls locked while > 0
  revTicks: number; // accel held during countdown (launch-boost timing)
  draftTicks: number; // consecutive ticks spent in another kart's wake
  itemCooldown: number; // ticks until BTN_ITEM works again (multi-charge items)
  balloons: number; // battle mode lives; 0 + battle = eliminated
}

/** Fired shell. Slot is live while ttl > 0; pool length is always MAX_SHELLS. */
export interface ShellState {
  ttl: number;
  x: Fx;
  y: Fx;
  vx: Fx;
  vy: Fx;
  owner: number; // kart index that fired it
  bounces: number;
  homing: number; // 1 = arcs toward the nearest kart in range
}

/** Dropped oil slick. Slot is live while ttl > 0; pool length is always MAX_OILS. */
export interface OilState {
  ttl: number;
  x: Fx;
  y: Fx;
  owner: number; // kart index that dropped it (for takedown attribution)
}

export const MAX_SHELLS = 8; // 4 players x 2 in flight (pickup cadence < shell ttl)
export const MAX_OILS = 12;

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
  shells: ShellState[]; // fixed length MAX_SHELLS
  oils: OilState[]; // fixed length MAX_OILS
}

const KART_INTS = 19;
const GLOBAL_INTS = 4;
const SHELL_INTS = 8;
const OIL_INTS = 4;
const POOL_INTS = MAX_SHELLS * SHELL_INTS + MAX_OILS * OIL_INTS;

export function snapshotInts(cfg: RaceConfig): number {
  return (
    GLOBAL_INTS + cfg.playerCount * KART_INTS + getTrack(cfg.trackId).itemSpawns.length + POOL_INTS
  );
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
      z: 0,
      vz: 0,
      heading: s.heading,
      driftDir: 0,
      driftCharge: 0,
      boostTicks: 0,
      nextCp: 1,
      lap: 1,
      finishTick: -1,
      heldItem: ITEM_NONE,
      spinTicks: 0,
      revTicks: 0,
      draftTicks: 0,
      itemCooldown: 0,
      balloons: cfg.mode === 'battle' ? BATTLE_BALLOONS : 0,
    });
  }

  const shells: ShellState[] = [];
  for (let i = 0; i < MAX_SHELLS; i++) {
    shells.push({ ttl: 0, x: 0, y: 0, vx: 0, vy: 0, owner: 0, bounces: 0, homing: 0 });
  }
  const oils: OilState[] = [];
  for (let i = 0; i < MAX_OILS; i++) {
    oils.push({ ttl: 0, x: 0, y: 0, owner: 0 });
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
    shells,
    oils,
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
    out[i++] = k.z;
    out[i++] = k.vz;
    out[i++] = k.heading;
    out[i++] = k.driftDir;
    out[i++] = k.driftCharge;
    out[i++] = k.boostTicks;
    out[i++] = k.nextCp;
    out[i++] = k.lap;
    out[i++] = k.finishTick;
    out[i++] = k.heldItem;
    out[i++] = k.spinTicks;
    out[i++] = k.revTicks;
    out[i++] = k.draftTicks;
    out[i++] = k.itemCooldown;
    out[i++] = k.balloons;
  }
  for (let j = 0; j < st.items.length; j++) out[i++] = st.items[j]!;
  for (const s of st.shells) {
    out[i++] = s.ttl;
    out[i++] = s.x;
    out[i++] = s.y;
    out[i++] = s.vx;
    out[i++] = s.vy;
    out[i++] = s.owner;
    out[i++] = s.bounces;
    out[i++] = s.homing;
  }
  for (const o of st.oils) {
    out[i++] = o.ttl;
    out[i++] = o.x;
    out[i++] = o.y;
    out[i++] = o.owner;
  }
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
    k.z = arr[i++]!;
    k.vz = arr[i++]!;
    k.heading = arr[i++]!;
    k.driftDir = arr[i++]!;
    k.driftCharge = arr[i++]!;
    k.boostTicks = arr[i++]!;
    k.nextCp = arr[i++]!;
    k.lap = arr[i++]!;
    k.finishTick = arr[i++]!;
    k.heldItem = arr[i++]!;
    k.spinTicks = arr[i++]!;
    k.revTicks = arr[i++]!;
    k.draftTicks = arr[i++]!;
    k.itemCooldown = arr[i++]!;
    k.balloons = arr[i++]!;
  }
  for (let j = 0; j < st.items.length; j++) st.items[j] = arr[i++]!;
  for (const s of st.shells) {
    s.ttl = arr[i++]!;
    s.x = arr[i++]!;
    s.y = arr[i++]!;
    s.vx = arr[i++]!;
    s.vy = arr[i++]!;
    s.owner = arr[i++]!;
    s.bounces = arr[i++]!;
    s.homing = arr[i++]!;
  }
  for (const o of st.oils) {
    o.ttl = arr[i++]!;
    o.x = arr[i++]!;
    o.y = arr[i++]!;
    o.owner = arr[i++]!;
  }
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
const scratch = new Int32Array(GLOBAL_INTS + MAX_PLAYERS * KART_INTS + MAX_ITEM_SPAWNS + POOL_INTS);

export function hashState(st: GameState): number {
  const view = scratch.subarray(0, snapshotInts(st.cfg));
  writeSnapshot(st, view);
  return hashSnapshot(view);
}
