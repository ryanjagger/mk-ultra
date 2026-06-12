/**
 * CPU driver. A bot's input mask is a pure, integer-only function of the
 * current state, so every client (and every rollback re-simulation) computes
 * the identical mask — bot inputs never cross the wire at all. Seats are
 * flagged in RaceConfig.bots and stepSim substitutes these masks for them.
 *
 * Racing model: the greedy gate-chaser the test suite and the ?bot client
 * always used — steer by the sign of cross(forward, toTarget), drift on
 * sharp angles, fire held items on a fixed cadence.
 *
 * Battle model: gates don't advance in battle, so gate-chasing would orbit
 * one point forever. Battle bots hunt instead — the nearest live item box
 * when empty-handed, the nearest surviving rival when armed (firing once
 * roughly lined up). Same integer-only math, targets picked by index order.
 */
import { type Fx, sub, len, wideCross, wideDot } from './fixed.js';
import { cosB, sinB } from './trig.js';
import { BTN_ACCEL, BTN_BRAKE, BTN_LEFT, BTN_RIGHT, BTN_DRIFT, BTN_ITEM } from './input.js';
import { COUNTDOWN_TICKS, ITEM_NONE, PHASE_COUNTDOWN, type GameState } from './state.js';
import { isItemActive } from './items.js';

export function botMask(st: GameState, k: number): number {
  const kart = st.karts[k];
  if (!kart || kart.finishTick >= 0) return 0;
  // time the rev into GO like a player would (inside the perfect window)
  if (st.phase === PHASE_COUNTDOWN) {
    return st.tick >= COUNTDOWN_TICKS - 30 ? BTN_ACCEL : 0;
  }
  if (st.cfg.mode === 'battle') return battleMask(st, k);
  // fire whatever we're holding shortly after pickup (cheap but lively)
  if (kart.heldItem !== ITEM_NONE && st.tick % 45 === 0) {
    return steerToward(st, k, st.track.gates[kart.nextCp]!.cx, st.track.gates[kart.nextCp]!.cy) | BTN_ITEM;
  }
  return steerToward(st, k, st.track.gates[kart.nextCp]!.cx, st.track.gates[kart.nextCp]!.cy);
}

function battleMask(st: GameState, k: number): number {
  const kart = st.karts[k]!;
  let tx: Fx;
  let ty: Fx;
  let armedAndHunting = false;
  if (kart.heldItem === ITEM_NONE) {
    // restock: nearest live box (index breaks ties); fall back to gate 1
    let bestD: Fx = 0x7fffffff;
    tx = st.track.gates[1]!.cx;
    ty = st.track.gates[1]!.cy;
    for (let i = 0; i < st.track.itemSpawns.length; i++) {
      if (!isItemActive(st, i)) continue;
      const s = st.track.itemSpawns[i]!;
      const d = len(sub(s.x, kart.x), sub(s.y, kart.y));
      if (d < bestD) {
        bestD = d;
        tx = s.x;
        ty = s.y;
      }
    }
  } else {
    // hunt: nearest surviving rival
    let bestD: Fx = 0x7fffffff;
    tx = kart.x;
    ty = kart.y;
    for (let i = 0; i < st.karts.length; i++) {
      if (i === k) continue;
      const o = st.karts[i]!;
      if (o.finishTick >= 0) continue;
      const d = len(sub(o.x, kart.x), sub(o.y, kart.y));
      if (d < bestD) {
        bestD = d;
        tx = o.x;
        ty = o.y;
      }
    }
    armedAndHunting = tx !== kart.x || ty !== kart.y;
  }
  let mask = steerToward(st, k, tx, ty);
  if (armedAndHunting && st.tick % 30 === 0) {
    // fire when the target is in the forward half-plane
    const fwdX = cosB(kart.heading);
    const fwdY = sinB(kart.heading);
    if (wideDot(sub(tx, kart.x), sub(ty, kart.y), fwdX, fwdY) > 0) mask |= BTN_ITEM;
  }
  return mask;
}

function steerToward(st: GameState, k: number, gx: Fx, gy: Fx): number {
  const kart = st.karts[k]!;
  const fwdX = cosB(kart.heading);
  const fwdY = sinB(kart.heading);
  const tx = sub(gx, kart.x);
  const ty = sub(gy, kart.y);
  const crossV = wideCross(fwdX, fwdY, tx, ty);
  const dotV = wideDot(fwdX, fwdY, tx, ty);
  let mask = BTN_ACCEL;
  if (crossV > 0) mask |= BTN_LEFT;
  else if (crossV < 0) mask |= BTN_RIGHT;
  if (dotV > 0 && (crossV > dotV || -crossV > dotV)) mask |= BTN_DRIFT;
  if (dotV < 0) mask = (mask & ~BTN_ACCEL) | BTN_BRAKE;
  return mask;
}
