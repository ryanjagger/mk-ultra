/**
 * Arcade kart physics — all Q16.16, all branches deterministic.
 *
 * Model: velocity is split into forward and lateral components each tick.
 * Lateral velocity decays fast normally (grip) and slowly while drifting
 * (slide). Drift charges a mini-boost released on drift end, Mario Kart style.
 */
import {
  type Fx,
  fxConst,
  fx,
  FX_ONE,
  add,
  sub,
  mul,
  div,
  len,
  lerp,
  clamp,
  max,
  ratioFx,
  wideDot,
} from './fixed.js';
import { sinB, cosB } from './trig.js';
import { BTN_ACCEL, BTN_BRAKE, BTN_DRIFT, steerOf } from './input.js';
import type { GameState, KartState } from './state.js';
import { KART_RADIUS, clampWorld, type WallSeg, type TrackRuntime } from './track.js';

// --- tuning (units are track-units and ticks) ---------------------------
const ACCEL: Fx = fxConst(0.0062);
const BRAKE_DECEL: Fx = fxConst(0.014);
const REVERSE_ACCEL: Fx = fxConst(0.0045);
const REVERSE_MAX: Fx = fxConst(0.16);
const MAX_SPEED: Fx = fxConst(0.42);
const BOOST_SPEED_MULT: Fx = fxConst(1.42);
const BOOST_ACCEL_MULT: Fx = fxConst(2.4);
const SPEED_BLEED: Fx = fxConst(0.004); // over-cap decay per tick (post-boost)
const ROLL_RESIST: Fx = fxConst(0.992); // forward speed kept per tick
const LAT_GRIP: Fx = fxConst(0.78); // lateral velocity kept per tick
const LAT_GRIP_DRIFT: Fx = fxConst(0.95);
const TURN_RATE_BRADS = 400; // at full steer + full speed
const TURN_SPEED_REF: Fx = mul(MAX_SPEED, fxConst(0.55));
const DRIFT_MIN_SPEED: Fx = fxConst(0.26);
const DRIFT_TURN_BASE: Fx = fxConst(1.3);
const DRIFT_TURN_MOD: Fx = fxConst(0.55);
const MOVE_EPS: Fx = fxConst(0.02);

export const DRIFT_TIER1_TICKS = 50;
export const DRIFT_TIER2_TICKS = 110;
const DRIFT_BOOST1 = 55;
const DRIFT_BOOST2 = 110;
export const BOOST_CAP = 240;
const DRIFT_CHARGE_CAP = 300;

const WALL_BOUNCE: Fx = fxConst(1.25); // 1 + restitution
const WALL_FRICTION: Fx = fxConst(0.96);
const KART_IMPULSE: Fx = fxConst(0.8); // (1+e)/2 with e=0.6

// off-track dirt (skipped entirely while boosting — Mario Kart rule)
const DIRT_DRAG: Fx = fxConst(0.96); // extra forward decay per tick
const DIRT_CAP: Fx = mul(MAX_SPEED, fxConst(0.55));
const DIRT_BLEED: Fx = fxConst(0.012); // over-cap decay per tick on dirt
const LAT_GRIP_DIRT: Fx = fxConst(0.9);

/**
 * Is (x, y) beyond the asphalt? Distance to the centerline polyline compared
 * against the segment's lerped half-width. Strict `<` on the best distance
 * makes vertex ties resolve to the lowest segment index — deterministic.
 */
export function onDirt(track: TrackRuntime, x: Fx, y: Fx): boolean {
  const pts = track.centerline;
  const n = pts.length;
  let bestD: Fx = 0x7fffffff;
  let bestW: Fx = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const abx = sub(b.x, a.x);
    const aby = sub(b.y, a.y);
    const den = wideDot(abx, aby, abx, aby);
    if (den === 0) continue;
    const t = clamp(ratioFx(wideDot(sub(x, a.x), sub(y, a.y), abx, aby), den), 0, FX_ONE);
    const d = len(sub(x, add(a.x, mul(abx, t))), sub(y, add(a.y, mul(aby, t))));
    if (d < bestD) {
      bestD = d;
      bestW = lerp(track.halfWidths[i]!, track.halfWidths[(i + 1) % n]!, t);
    }
  }
  return bestD > bestW;
}

export function stepKart(st: GameState, kart: KartState, mask: number): void {
  const steer = steerOf(mask);

  // forward speed along current heading
  let fwdX = cosB(kart.heading);
  let fwdY = sinB(kart.heading);
  const vf0 = add(mul(kart.vx, fwdX), mul(kart.vy, fwdY));

  // --- drift state machine ---
  const wantDrift = (mask & BTN_DRIFT) !== 0 && vf0 > DRIFT_MIN_SPEED;
  if (kart.driftDir === 0 && wantDrift && steer !== 0) {
    kart.driftDir = steer;
  }
  if (kart.driftDir !== 0) {
    if (!wantDrift) {
      // release: award mini-boost by charge tier
      if (kart.driftCharge >= DRIFT_TIER2_TICKS) {
        kart.boostTicks = Math.min(kart.boostTicks + DRIFT_BOOST2, BOOST_CAP);
      } else if (kart.driftCharge >= DRIFT_TIER1_TICKS) {
        kart.boostTicks = Math.min(kart.boostTicks + DRIFT_BOOST1, BOOST_CAP);
      }
      kart.driftDir = 0;
      kart.driftCharge = 0;
    } else {
      const into = steer === kart.driftDir ? 2 : 1;
      kart.driftCharge = Math.min(kart.driftCharge + into, DRIFT_CHARGE_CAP);
    }
  }

  // --- steering ---
  let steerEff: Fx;
  if (kart.driftDir !== 0) {
    steerEff = add(mul(fx(kart.driftDir), DRIFT_TURN_BASE), mul(fx(steer), DRIFT_TURN_MOD));
  } else {
    steerEff = fx(steer);
  }
  const speed = len(kart.vx, kart.vy);
  const speedFactor = clamp(div(speed, TURN_SPEED_REF), 0, FX_ONE);
  const turn = mul(steerEff, speedFactor); // fx, |.| <= ~1.85
  let deltaBrads = (turn * TURN_RATE_BRADS) >> 16;
  if (vf0 < 0) deltaBrads = -deltaBrads; // reversing steers mirrored
  kart.heading = (kart.heading + deltaBrads) & 0xffff;

  fwdX = cosB(kart.heading);
  fwdY = sinB(kart.heading);

  // --- longitudinal accel ---
  const boosting = kart.boostTicks > 0;
  // surface test on the pre-move position, only on tracks that have dirt
  // (classic tracks skip all of this, keeping their v1 hashes intact)
  const offRoad = !boosting && st.track.hasDirt && onDirt(st.track, kart.x, kart.y);
  let accel: Fx = 0;
  if (boosting) {
    accel = mul(ACCEL, BOOST_ACCEL_MULT);
  } else if ((mask & BTN_BRAKE) !== 0) {
    accel = vf0 > MOVE_EPS ? -BRAKE_DECEL | 0 : -REVERSE_ACCEL | 0;
  } else if ((mask & BTN_ACCEL) !== 0) {
    accel = ACCEL;
  }
  kart.vx = add(kart.vx, mul(fwdX, accel));
  kart.vy = add(kart.vy, mul(fwdY, accel));

  // --- grip: split velocity into forward + lateral, decay each ---
  let vf = add(mul(kart.vx, fwdX), mul(kart.vy, fwdY));
  const latX = sub(kart.vx, mul(fwdX, vf));
  const latY = sub(kart.vy, mul(fwdY, vf));
  const grip = kart.driftDir !== 0 ? LAT_GRIP_DRIFT : offRoad ? LAT_GRIP_DIRT : LAT_GRIP;

  vf = mul(vf, ROLL_RESIST);
  if (offRoad) {
    vf = mul(vf, DIRT_DRAG);
    if (vf > DIRT_CAP) vf = max(DIRT_CAP, sub(vf, DIRT_BLEED));
  }
  const cap = boosting ? mul(MAX_SPEED, BOOST_SPEED_MULT) : MAX_SPEED;
  if (vf > cap) vf = max(cap, sub(vf, SPEED_BLEED)); // bleed down smoothly post-boost
  if (vf < -REVERSE_MAX) vf = -REVERSE_MAX | 0;

  kart.vx = add(mul(fwdX, vf), mul(latX, grip));
  kart.vy = add(mul(fwdY, vf), mul(latY, grip));

  // --- integrate ---
  kart.x = clampWorld(add(kart.x, kart.vx));
  kart.y = clampWorld(add(kart.y, kart.vy));

  if (kart.boostTicks > 0) kart.boostTicks -= 1;
}

/** Kart-vs-kart: positional separation + impulse. Fixed pair order (i<j). */
export function collideKarts(st: GameState): void {
  const karts = st.karts;
  const twoR = add(KART_RADIUS, KART_RADIUS);
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i]!;
      const b = karts[j]!;
      const dx = sub(b.x, a.x);
      const dy = sub(b.y, a.y);
      const d = len(dx, dy);
      if (d >= twoR) continue;
      let nx: Fx;
      let ny: Fx;
      if (d > 0) {
        nx = div(dx, d);
        ny = div(dy, d);
      } else {
        nx = FX_ONE;
        ny = 0;
      }
      const push = sub(twoR, d) >> 1;
      a.x = clampWorld(sub(a.x, mul(nx, push)));
      a.y = clampWorld(sub(a.y, mul(ny, push)));
      b.x = clampWorld(add(b.x, mul(nx, push)));
      b.y = clampWorld(add(b.y, mul(ny, push)));
      // relative approach speed along n (a toward b)
      const rel = add(mul(sub(a.vx, b.vx), nx), mul(sub(a.vy, b.vy), ny));
      if (rel > 0) {
        const imp = mul(rel, KART_IMPULSE);
        a.vx = sub(a.vx, mul(nx, imp));
        a.vy = sub(a.vy, mul(ny, imp));
        b.vx = add(b.vx, mul(nx, imp));
        b.vy = add(b.vy, mul(ny, imp));
      }
    }
  }
}

function collideWall(kart: KartState, w: WallSeg): void {
  if (kart.x < w.minX || kart.x > w.maxX || kart.y < w.minY || kart.y > w.maxY) return;
  const abx = sub(w.x1, w.x0);
  const aby = sub(w.y1, w.y0);
  const apx = sub(kart.x, w.x0);
  const apy = sub(kart.y, w.y0);
  const den = wideDot(abx, aby, abx, aby);
  if (den === 0) return;
  const t = clamp(ratioFx(wideDot(apx, apy, abx, aby), den), 0, FX_ONE);
  const cx = add(w.x0, mul(abx, t));
  const cy = add(w.y0, mul(aby, t));
  const dx = sub(kart.x, cx);
  const dy = sub(kart.y, cy);
  const d = len(dx, dy);
  if (d >= KART_RADIUS) return;
  let nx: Fx;
  let ny: Fx;
  if (d > 0) {
    nx = div(dx, d);
    ny = div(dy, d);
  } else {
    // dead center on the wall: push along the wall's left normal
    const l = len(abx, aby);
    nx = div(-aby | 0, l);
    ny = div(abx, l);
  }
  const push = sub(KART_RADIUS, d);
  kart.x = clampWorld(add(kart.x, mul(nx, push)));
  kart.y = clampWorld(add(kart.y, mul(ny, push)));
  const vn = add(mul(kart.vx, nx), mul(kart.vy, ny));
  if (vn < 0) {
    kart.vx = sub(kart.vx, mul(nx, mul(vn, WALL_BOUNCE)));
    kart.vy = sub(kart.vy, mul(ny, mul(vn, WALL_BOUNCE)));
    kart.vx = mul(kart.vx, WALL_FRICTION);
    kart.vy = mul(kart.vy, WALL_FRICTION);
  }
}

export function collideWalls(st: GameState): void {
  for (const kart of st.karts) {
    for (const w of st.track.walls) {
      collideWall(kart, w);
    }
  }
}

export { MAX_SPEED };
