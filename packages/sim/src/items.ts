/**
 * Item system (FR-14..16). Item boxes are mystery boxes: driving over one
 * grants a HELD item, rolled by the seeded PRNG and weighted by current race
 * placement (leaders draw defensive items, the tail draws catch-up items).
 * BTN_ITEM uses the held item: boost applies instantly, a shell is fired
 * forward into the shells pool, an oil slick is dropped behind into the oils
 * pool. Shells and oils hit karts into a spin-out (controls locked, speed
 * scrubbed — see physics.ts for the locked-control branch).
 *
 * Determinism notes: pools are fixed-length and walked by slot index; kart
 * scans are by kart index; the PRNG is consumed exactly twice per pickup
 * (item roll, respawn jitter) in fixed (item, kart) order.
 */
import {
  type Fx,
  FX_ONE,
  add,
  sub,
  mul,
  div,
  len,
  clamp,
  fxConst,
  ratioFx,
  wideDot,
} from './fixed.js';
import { sinB, cosB } from './trig.js';
import { rngNextState, rngValue, rngRange } from './prng.js';
import { ITEM_NONE, type GameState, type KartState, type ShellState } from './state.js';
import { BOOST_CAP, KART_Z_CLEAR } from './physics.js';
import { KART_RADIUS, clampWorld } from './track.js';
import { computePlacements } from './race.js';

export const ITEM_BOOST = 0;
export const ITEM_SHELL = 1;
export const ITEM_OIL = 2;
/** Spins out every other kart still racing — pure catch-up artillery. */
export const ITEM_LIGHTNING = 3;
/** Three boost charges; using one downgrades 3 -> 2 -> plain boost. */
export const ITEM_TRIPLE_BOOST = 4;
export const ITEM_DOUBLE_BOOST = 5;
/** Shell that arcs toward the nearest kart in range. */
export const ITEM_HOMING_SHELL = 6;

const ITEM_PICKUP_RADIUS: Fx = fxConst(1.4);
const ITEM_RESPAWN_BASE = 300; // 5s
const ITEM_RESPAWN_JITTER = 120; // + rng in [0, 2s)
const ITEM_BOOST_TICKS = 90;

export const SHELL_SPEED: Fx = fxConst(0.7); // > boosted kart max (0.6) — can't outrun your own
export const SHELL_TTL = 360; // 6s
export const SHELL_RADIUS: Fx = fxConst(0.45);
const SHELL_MAX_BOUNCES = 3;
const SHELL_REFLECT: Fx = fxConst(2); // mirror bounce, no energy loss

export const OIL_TTL = 720; // 12s on the track
export const OIL_ARM_TICKS = 24; // grace period before it triggers
export const OIL_RADIUS: Fx = fxConst(1.1);

export const SPIN_OUT_TICKS = 50;
const SPIN_SPEED_KEEP: Fx = fxConst(0.35);

/**
 * Placement-weighted draw tables, one d6 row per placement band
 * (leader / midfield / tail). Leaders defend, the tail gets artillery.
 */
const ITEM_TABLE: readonly (readonly number[])[] = [
  [ITEM_OIL, ITEM_OIL, ITEM_OIL, ITEM_SHELL, ITEM_SHELL, ITEM_BOOST],
  [ITEM_OIL, ITEM_SHELL, ITEM_SHELL, ITEM_HOMING_SHELL, ITEM_BOOST, ITEM_TRIPLE_BOOST],
  [ITEM_LIGHTNING, ITEM_HOMING_SHELL, ITEM_HOMING_SHELL, ITEM_TRIPLE_BOOST, ITEM_TRIPLE_BOOST, ITEM_BOOST],
];

export function isItemActive(st: GameState, index: number): boolean {
  return st.tick >= st.items[index]!;
}

/**
 * Knock a kart into a spin: boost and drift are lost, most speed scrubbed.
 * In battle mode every spin pops a balloon; the last balloon eliminates
 * (finishTick doubles as the elimination tick — frozen controls, no targeting).
 */
export function spinOut(st: GameState, kart: KartState): void {
  kart.spinTicks = SPIN_OUT_TICKS;
  kart.boostTicks = 0;
  kart.driftDir = 0;
  kart.driftCharge = 0;
  kart.vx = mul(kart.vx, SPIN_SPEED_KEEP);
  kart.vy = mul(kart.vy, SPIN_SPEED_KEEP);
  if (st.cfg.mode === 'battle' && kart.balloons > 0) {
    kart.balloons -= 1;
    if (kart.balloons === 0) kart.finishTick = st.tick;
  }
}

/** First inactive slot, else the closest-to-expiry one (lowest index wins ties). */
function allocSlot(ttls: readonly number[]): number {
  let best = 0;
  let bestTtl = 0x7fffffff;
  for (let i = 0; i < ttls.length; i++) {
    const t = ttls[i]!;
    if (t <= 0) return i;
    if (t < bestTtl) {
      bestTtl = t;
      best = i;
    }
  }
  return best;
}

/**
 * Pickups, in fixed (item, kart) order so PRNG consumption is deterministic.
 * A kart already holding an item drives through without consuming the box.
 * Respawn delay is PRNG-jittered (FR-15).
 */
export function stepItems(st: GameState): void {
  for (let i = 0; i < st.track.itemSpawns.length; i++) {
    if (!isItemActive(st, i)) continue;
    const spawn = st.track.itemSpawns[i]!;
    for (let p = 0; p < st.karts.length; p++) {
      const kart = st.karts[p]!;
      if (kart.finishTick >= 0 || kart.heldItem !== ITEM_NONE) continue;
      const d = len(sub(kart.x, spawn.x), sub(kart.y, spawn.y));
      if (d >= ITEM_PICKUP_RADIUS) continue;
      st.rng = rngNextState(st.rng);
      kart.heldItem = ITEM_TABLE[placementBand(st, p)]![rngRange(rngValue(st.rng), 6)]!;
      st.rng = rngNextState(st.rng);
      const jitter = rngRange(rngValue(st.rng), ITEM_RESPAWN_JITTER);
      st.items[i] = st.tick + ITEM_RESPAWN_BASE + jitter;
      break; // one pickup per box
    }
  }
}

/** 0 = race leader, 2 = last place, 1 = everyone in between. */
function placementBand(st: GameState, kartIndex: number): number {
  const order = computePlacements(st);
  const rank = order.indexOf(kartIndex);
  if (rank === st.karts.length - 1) return 2;
  return rank === 0 ? 0 : 1;
}

function fireShell(st: GameState, p: number, homing: number): void {
  const kart = st.karts[p]!;
  const fwdX = cosB(kart.heading);
  const fwdY = sinB(kart.heading);
  const s = st.shells[allocSlot(st.shells.map((x) => x.ttl))]!;
  const off = add(add(KART_RADIUS, SHELL_RADIUS), fxConst(0.15));
  s.ttl = SHELL_TTL;
  s.x = clampWorld(add(kart.x, mul(fwdX, off)));
  s.y = clampWorld(add(kart.y, mul(fwdY, off)));
  s.vx = mul(fwdX, SHELL_SPEED);
  s.vy = mul(fwdY, SHELL_SPEED);
  s.owner = p;
  s.bounces = 0;
  s.homing = homing;
}

/** Re-press delay so multi-charge items need distinct button presses. */
export const ITEM_REUSE_TICKS = 18;

/** Consume the held item of kart `p`. Caller gates on phase/finish/spin/cooldown. */
export function useHeldItem(st: GameState, p: number): void {
  const kart = st.karts[p]!;
  const item = kart.heldItem;
  if (item === ITEM_NONE) return;
  kart.heldItem = ITEM_NONE;
  kart.itemCooldown = ITEM_REUSE_TICKS;
  const fwdX = cosB(kart.heading);
  const fwdY = sinB(kart.heading);
  if (item === ITEM_BOOST || item === ITEM_TRIPLE_BOOST || item === ITEM_DOUBLE_BOOST) {
    kart.boostTicks = Math.min(kart.boostTicks + ITEM_BOOST_TICKS, BOOST_CAP);
    // triple/double boosts keep their remaining charges in hand
    if (item === ITEM_TRIPLE_BOOST) kart.heldItem = ITEM_DOUBLE_BOOST;
    else if (item === ITEM_DOUBLE_BOOST) kart.heldItem = ITEM_BOOST;
  } else if (item === ITEM_SHELL) {
    fireShell(st, p, 0);
  } else if (item === ITEM_HOMING_SHELL) {
    fireShell(st, p, 1);
  } else if (item === ITEM_LIGHTNING) {
    // thunder for everyone else still racing
    for (let i = 0; i < st.karts.length; i++) {
      if (i === p) continue;
      const other = st.karts[i]!;
      if (other.finishTick >= 0 || other.spinTicks > 0) continue;
      spinOut(st, other);
    }
  } else if (item === ITEM_OIL) {
    const o = st.oils[allocSlot(st.oils.map((x) => x.ttl))]!;
    const off = add(add(KART_RADIUS, OIL_RADIUS), fxConst(0.15));
    o.ttl = OIL_TTL;
    o.x = clampWorld(sub(kart.x, mul(fwdX, off)));
    o.y = clampWorld(sub(kart.y, mul(fwdY, off)));
    o.owner = p;
  }
}

/** Reflect a shell off any fence wall it touches. Returns true if it bounced. */
function bounceShell(st: GameState, s: ShellState): boolean {
  let bounced = false;
  for (const w of st.track.walls) {
    if (s.x < w.minX || s.x > w.maxX || s.y < w.minY || s.y > w.maxY) continue;
    const abx = sub(w.x1, w.x0);
    const aby = sub(w.y1, w.y0);
    const den = wideDot(abx, aby, abx, aby);
    if (den === 0) continue;
    const t = clamp(ratioFx(wideDot(sub(s.x, w.x0), sub(s.y, w.y0), abx, aby), den), 0, FX_ONE);
    const dx = sub(s.x, add(w.x0, mul(abx, t)));
    const dy = sub(s.y, add(w.y0, mul(aby, t)));
    const d = len(dx, dy);
    if (d >= SHELL_RADIUS || d === 0) continue;
    const nx = div(dx, d);
    const ny = div(dy, d);
    const push = sub(SHELL_RADIUS, d);
    s.x = clampWorld(add(s.x, mul(nx, push)));
    s.y = clampWorld(add(s.y, mul(ny, push)));
    const vn = add(mul(s.vx, nx), mul(s.vy, ny));
    if (vn < 0) {
      s.vx = sub(s.vx, mul(nx, mul(vn, SHELL_REFLECT)));
      s.vy = sub(s.vy, mul(ny, mul(vn, SHELL_REFLECT)));
      bounced = true;
    }
  }
  return bounced;
}

const HOMING_RANGE: Fx = fxConst(28);
const HOMING_TURN: Fx = fxConst(0.18); // velocity blend toward the target per tick

/** Arc a homing shell toward the nearest eligible kart (index breaks ties). */
function steerShell(st: GameState, s: ShellState): void {
  let bx: Fx = 0;
  let by: Fx = 0;
  let bestD: Fx = 0x7fffffff;
  for (let p = 0; p < st.karts.length; p++) {
    if (p === s.owner && s.bounces === 0) continue;
    const kart = st.karts[p]!;
    if (kart.finishTick >= 0 || kart.spinTicks > 0) continue;
    const dx = sub(kart.x, s.x);
    const dy = sub(kart.y, s.y);
    const d = len(dx, dy);
    if (d > 0 && d < bestD) {
      bestD = d;
      bx = dx;
      by = dy;
    }
  }
  if (bestD >= HOMING_RANGE) return;
  const tx = div(bx, bestD);
  const ty = div(by, bestD);
  s.vx = add(s.vx, mul(sub(mul(tx, SHELL_SPEED), s.vx), HOMING_TURN));
  s.vy = add(s.vy, mul(sub(mul(ty, SHELL_SPEED), s.vy), HOMING_TURN));
  const vl = len(s.vx, s.vy);
  if (vl > 0) {
    // renormalize so homing never gains or sheds speed
    s.vx = mul(div(s.vx, vl), SHELL_SPEED);
    s.vy = mul(div(s.vy, vl), SHELL_SPEED);
  }
}

/** Shells: move, bounce off fences, hit karts. Slot-major, karts by index. */
export function stepShells(st: GameState): void {
  for (const s of st.shells) {
    if (s.ttl <= 0) continue;
    s.ttl -= 1;
    if (s.ttl === 0) continue;
    if (s.homing === 1) steerShell(st, s);
    // two half-steps: per-check movement (0.35) stays under SHELL_RADIUS,
    // so a shell can never tunnel through a wall's centerline between checks
    for (let h = 0; h < 2 && s.ttl > 0; h++) {
      s.x = clampWorld(add(s.x, s.vx >> 1));
      s.y = clampWorld(add(s.y, s.vy >> 1));
      if (bounceShell(st, s)) {
        s.bounces += 1;
        if (s.bounces > SHELL_MAX_BOUNCES) s.ttl = 0;
      }
    }
    if (s.ttl === 0) continue;
    const hitR = add(KART_RADIUS, SHELL_RADIUS);
    for (let p = 0; p < st.karts.length; p++) {
      // a fresh shell can't hit its owner — only after a wall bounce
      if (p === s.owner && s.bounces === 0) continue;
      const kart = st.karts[p]!;
      // jumping clears ground hazards
      if (kart.finishTick >= 0 || kart.spinTicks > 0 || kart.z > KART_Z_CLEAR) continue;
      if (len(sub(kart.x, s.x), sub(kart.y, s.y)) >= hitR) continue;
      spinOut(st, kart);
      s.ttl = 0;
      break;
    }
  }
}

/** Oil slicks: arm after a grace period, spin the first kart over them. */
export function stepOils(st: GameState): void {
  const hitR = add(KART_RADIUS, OIL_RADIUS);
  for (const o of st.oils) {
    if (o.ttl <= 0) continue;
    o.ttl -= 1;
    if (o.ttl === 0) continue;
    if (OIL_TTL - o.ttl < OIL_ARM_TICKS) continue;
    for (let p = 0; p < st.karts.length; p++) {
      const kart = st.karts[p]!;
      // any air at all clears an oil slick
      if (kart.finishTick >= 0 || kart.spinTicks > 0 || kart.z > 0) continue;
      if (len(sub(kart.x, o.x), sub(kart.y, o.y)) >= hitR) continue;
      spinOut(st, kart);
      o.ttl = 0;
      break;
    }
  }
}
