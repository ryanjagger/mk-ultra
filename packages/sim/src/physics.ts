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
  wideCross,
} from './fixed.js';
import { sinB, cosB } from './trig.js';
import { BTN_ACCEL, BTN_BRAKE, BTN_DRIFT, INPUT_NEUTRAL, steerOf, steerMagOf, STEER_MAG_MAX } from './input.js';
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

const SPIN_DRAG: Fx = fxConst(0.93); // extra forward decay per tick while spun out

const WALL_BOUNCE: Fx = fxConst(1.25); // 1 + restitution
const WALL_FRICTION: Fx = fxConst(0.96);
const KART_IMPULSE: Fx = fxConst(0.8); // (1+e)/2 with e=0.6

// ramp jumps: launched karts fly ballistically — no engine, no tire grip,
// reduced air steering; they clear shells, oil and kart contact below them
const GRAVITY_Z: Fx = fxConst(0.008); // vz decay per tick airborne
const RAMP_MIN_SPEED: Fx = fxConst(0.1);
export const KART_Z_CLEAR: Fx = fxConst(1.0); // height that clears ground hazards

// slipstream: sit in a leader's wake to charge a tow; swing out of the wake
// once charged and the stored air converts to a slingshot boost burst
const DRAFT_RANGE: Fx = fxConst(7); // wake length behind the leader
const DRAFT_HALF_WIDTH: Fx = fxConst(1.3);
const DRAFT_MIN_SPEED: Fx = fxConst(0.3); // both karts must be at pace
export const DRAFT_CHARGE_TICKS = 45; // time in wake before the tow kicks in
const DRAFT_ACCEL: Fx = fxConst(0.004); // extra accel while towing
const DRAFT_CAP_MULT: Fx = fxConst(1.18);
export const DRAFT_BURST_TICKS = 40; // slingshot boost on exiting the wake

// off-track dirt (skipped entirely while boosting — Mario Kart rule)
const DIRT_DRAG: Fx = fxConst(0.96); // extra forward decay per tick
const DIRT_CAP: Fx = mul(MAX_SPEED, fxConst(0.55));
const DIRT_BLEED: Fx = fxConst(0.012); // over-cap decay per tick on dirt
const LAT_GRIP_DIRT: Fx = fxConst(0.9);

// hills: height is lerped along the closest centerline segment, constant
// across the track width. Gravity accelerates karts along -∇h; the forward
// slope also moves the speed cap so climbs are slow and descents are fast.
const GRAVITY: Fx = fxConst(0.02); // accel per unit of slope, per tick
const SLOPE_CAP_GAIN: Fx = fxConst(1.5); // cap multiplier change per unit forward slope
const SLOPE_CAP_MIN: Fx = fxConst(0.6); // steepest climb still allows 60% of MAX_SPEED
const SLOPE_CAP_MAX: Fx = fxConst(1.25); // downhill cap ceiling (below boost's 1.42)

// closest-centerline-segment probe results — transient scratch, fully written
// by probeSurface before every read; never part of snapshotted state
let probeDist: Fx = 0;
let probeHalfW: Fx = 0;
let probeSeg = 0;

/**
 * Closest point on the centerline polyline: distance, lerped half-width and
 * segment index, written to the probe scratch. Strict `<` on the best
 * distance makes vertex ties resolve to the lowest segment index —
 * deterministic.
 */
function probeSurface(track: TrackRuntime, x: Fx, y: Fx): void {
  const pts = track.centerline;
  const n = pts.length;
  let bestD: Fx = 0x7fffffff;
  let bestW: Fx = 0;
  let bestI = 0;
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
      bestI = i;
    }
  }
  probeDist = bestD;
  probeHalfW = bestW;
  probeSeg = bestI;
}

/** Is (x, y) beyond the asphalt? */
export function onDirt(track: TrackRuntime, x: Fx, y: Fx): boolean {
  probeSurface(track, x, y);
  return probeDist > probeHalfW;
}

// height-field gradient of a probed segment (constant along the segment)
let gradX: Fx = 0;
let gradY: Fx = 0;

function slopeGradient(track: TrackRuntime, i: number): void {
  const pts = track.centerline;
  const j = (i + 1) % pts.length;
  const dh = sub(track.heights[j]!, track.heights[i]!);
  gradX = 0;
  gradY = 0;
  if (dh === 0) return;
  const a = pts[i]!;
  const b = pts[j]!;
  const abx = sub(b.x, a.x);
  const aby = sub(b.y, a.y);
  const den = wideDot(abx, aby, abx, aby);
  if (den === 0) return;
  // ∇(lerp of h along the segment) = dh * ab / |ab|², exact via wide math
  gradX = ratioFx(dh * abx, den);
  gradY = ratioFx(dh * aby, den);
}

/**
 * Slipstream pass, run on pre-move positions so every kart sees the same
 * world (fixed kart order, no pair asymmetry). In a wake: charge. Out of a
 * wake with a full charge: slingshot.
 */
export function updateDraft(st: GameState): void {
  const karts = st.karts;
  const speeds: Fx[] = [];
  for (const k of karts) speeds.push(len(k.vx, k.vy));
  for (let i = 0; i < karts.length; i++) {
    const k = karts[i]!;
    let inWake = false;
    if (k.finishTick < 0 && k.spinTicks === 0 && k.z === 0 && speeds[i]! >= DRAFT_MIN_SPEED) {
      const fwdX = cosB(k.heading);
      const fwdY = sinB(k.heading);
      for (let j = 0; j < karts.length; j++) {
        if (j === i) continue;
        const lead = karts[j]!;
        if (lead.finishTick >= 0 || lead.z !== 0 || speeds[j]! < DRAFT_MIN_SPEED) continue;
        const dx = sub(lead.x, k.x);
        const dy = sub(lead.y, k.y);
        // leader ahead along our heading, inside the narrow wake corridor,
        // and actually driving away from us (not oncoming)
        const along = wideDot(dx, dy, fwdX, fwdY);
        if (along <= 0 || along > DRAFT_RANGE * 65536) continue;
        const lat = wideCross(fwdX, fwdY, dx, dy);
        if ((lat < 0 ? -lat : lat) > DRAFT_HALF_WIDTH * 65536) continue;
        if (wideDot(lead.vx, lead.vy, fwdX, fwdY) <= 0) continue;
        inWake = true;
        break;
      }
    }
    if (inWake) {
      if (k.draftTicks < 0x7fffffff) k.draftTicks += 1;
    } else {
      if (k.draftTicks >= DRAFT_CHARGE_TICKS && k.boostTicks < DRAFT_BURST_TICKS) {
        k.boostTicks = DRAFT_BURST_TICKS; // the slingshot
      }
      k.draftTicks = 0;
    }
  }
}

export function stepKart(st: GameState, kart: KartState, mask: number): void {
  // spun out: controls are locked, the kart coasts with extra drag
  const spinning = kart.spinTicks > 0;
  if (spinning) {
    kart.spinTicks -= 1;
    mask = INPUT_NEUTRAL;
  }
  const steer = steerOf(mask);

  // forward speed along current heading
  let fwdX = cosB(kart.heading);
  let fwdY = sinB(kart.heading);
  const vf0 = add(mul(kart.vx, fwdX), mul(kart.vy, fwdY));

  // airborne karts fly ballistically: the drift machine freezes mid-charge,
  // steering authority drops, engine/brake/grip do nothing until touchdown
  const grounded = kart.z === 0 && kart.vz === 0;

  // --- drift state machine ---
  if (grounded) {
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
  }

  // --- steering ---
  // Analog deflection: full lock (mag 15, every legacy mask) short-circuits to
  // the literal fx(steer) so today's hashes stay byte-identical; partial levels
  // scale it with fx/int-*/div only (all fixed.ts-sanctioned). |steer*mag| <= 15.
  const mag = steerMagOf(mask); // 0..15
  const steerAxis: Fx =
    steer === 0
      ? 0
      : mag === STEER_MAG_MAX
        ? fx(steer)
        : div(fx(steer * mag), fx(STEER_MAG_MAX));
  let steerEff: Fx;
  if (kart.driftDir !== 0) {
    steerEff = add(mul(fx(kart.driftDir), DRIFT_TURN_BASE), mul(steerAxis, DRIFT_TURN_MOD));
  } else {
    steerEff = steerAxis;
  }
  const speed = len(kart.vx, kart.vy);
  const speedFactor = clamp(div(speed, TURN_SPEED_REF), 0, FX_ONE);
  const turn = mul(steerEff, speedFactor); // fx, |.| <= ~1.85
  let deltaBrads = (turn * TURN_RATE_BRADS) >> 16;
  if (vf0 < 0) deltaBrads = -deltaBrads; // reversing steers mirrored
  if (!grounded) deltaBrads = deltaBrads >> 2; // quarter authority in the air
  kart.heading = (kart.heading + deltaBrads) & 0xffff;

  fwdX = cosB(kart.heading);
  fwdY = sinB(kart.heading);

  // --- longitudinal accel ---
  const boosting = kart.boostTicks > 0;
  // surface probe on the pre-move position, only on tracks that need it
  // (classic flat tracks skip all of this, keeping their v1 hashes intact)
  const hills = st.track.hasHills;
  if (grounded) {
    let offRoad = false;
    if ((!boosting && st.track.hasDirt) || hills) {
      probeSurface(st.track, kart.x, kart.y);
      offRoad = !boosting && st.track.hasDirt && probeDist > probeHalfW;
      if (hills) slopeGradient(st.track, probeSeg);
    }
    let accel: Fx = 0;
    if (boosting) {
      accel = mul(ACCEL, BOOST_ACCEL_MULT);
    } else if ((mask & BTN_BRAKE) !== 0) {
      accel = vf0 > MOVE_EPS ? -BRAKE_DECEL | 0 : -REVERSE_ACCEL | 0;
    } else if ((mask & BTN_ACCEL) !== 0) {
      accel = ACCEL;
    }
    // charged slipstream: the leader's wake tows us along
    const towing = kart.draftTicks >= DRAFT_CHARGE_TICKS;
    if (towing && !boosting && (mask & BTN_ACCEL) !== 0) {
      accel = add(accel, DRAFT_ACCEL);
    }
    kart.vx = add(kart.vx, mul(fwdX, accel));
    kart.vy = add(kart.vy, mul(fwdY, accel));
    if (hills) {
      // gravity pulls along -∇h; the grip stage bleeds the lateral part
      kart.vx = sub(kart.vx, mul(GRAVITY, gradX));
      kart.vy = sub(kart.vy, mul(GRAVITY, gradY));
    }

    // --- grip: split velocity into forward + lateral, decay each ---
    let vf = add(mul(kart.vx, fwdX), mul(kart.vy, fwdY));
    const latX = sub(kart.vx, mul(fwdX, vf));
    const latY = sub(kart.vy, mul(fwdY, vf));
    const grip = kart.driftDir !== 0 ? LAT_GRIP_DRIFT : offRoad ? LAT_GRIP_DIRT : LAT_GRIP;

    vf = mul(vf, ROLL_RESIST);
    if (spinning) vf = mul(vf, SPIN_DRAG);
    if (offRoad) {
      vf = mul(vf, DIRT_DRAG);
      if (vf > DIRT_CAP) vf = max(DIRT_CAP, sub(vf, DIRT_BLEED));
    }
    let cap = boosting ? mul(MAX_SPEED, BOOST_SPEED_MULT) : MAX_SPEED;
    if (hills && !boosting) {
      // climbing lowers the speed cap, descending raises it (downhill rush)
      const sFwd = add(mul(gradX, fwdX), mul(gradY, fwdY));
      cap = mul(MAX_SPEED, clamp(sub(FX_ONE, mul(SLOPE_CAP_GAIN, sFwd)), SLOPE_CAP_MIN, SLOPE_CAP_MAX));
    }
    if (towing && !boosting) cap = max(cap, mul(MAX_SPEED, DRAFT_CAP_MULT));
    if (vf > cap) vf = max(cap, sub(vf, SPEED_BLEED)); // bleed down smoothly post-boost
    if (vf < -REVERSE_MAX) vf = -REVERSE_MAX | 0;

    kart.vx = add(mul(fwdX, vf), mul(latX, grip));
    kart.vy = add(mul(fwdY, vf), mul(latY, grip));
  }

  // --- integrate ---
  kart.x = clampWorld(add(kart.x, kart.vx));
  kart.y = clampWorld(add(kart.y, kart.vy));
  if (!grounded) {
    kart.vz = sub(kart.vz, GRAVITY_Z);
    kart.z = add(kart.z, kart.vz);
    if (kart.z <= 0) {
      kart.z = 0;
      kart.vz = 0;
    }
  }

  if (kart.boostTicks > 0) kart.boostTicks -= 1;
}

/**
 * Ramp launch pass: grounded karts crossing a ramp at pace take off. The
 * launch scales with planar speed — crawling hops, flat-out flies.
 */
export function stepRamps(st: GameState): void {
  const ramps = st.track.ramps;
  if (ramps.length === 0) return;
  for (const kart of st.karts) {
    if (kart.finishTick >= 0 || kart.z !== 0 || kart.vz !== 0) continue;
    const speed = len(kart.vx, kart.vy);
    if (speed < RAMP_MIN_SPEED) continue;
    for (const r of ramps) {
      const rx = sub(kart.x, r.cx);
      const ry = sub(kart.y, r.cy);
      const along = wideDot(rx, ry, r.dx, r.dy);
      const lat = wideCross(r.dx, r.dy, rx, ry);
      if (
        (along < 0 ? -along : along) <= r.halfLen * 65536 &&
        (lat < 0 ? -lat : lat) <= r.halfWid * 65536
      ) {
        kart.vz = mul(r.vz, clamp(div(speed, MAX_SPEED), fxConst(0.45), fxConst(1.3)));
        break;
      }
    }
  }
}

/** Kart-vs-kart: positional separation + impulse. Fixed pair order (i<j). */
export function collideKarts(st: GameState): void {
  const karts = st.karts;
  const twoR = add(KART_RADIUS, KART_RADIUS);
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i]!;
      const b = karts[j]!;
      // a kart flying clear overhead passes, no contact
      const dz = sub(a.z, b.z);
      if ((dz < 0 ? -dz : dz) > KART_Z_CLEAR) continue;
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
