/**
 * CPU driver. A bot's input mask is a pure, integer-only function of the
 * current state, so every client (and every rollback re-simulation) computes
 * the identical mask — bot inputs never cross the wire at all. Seats are
 * flagged in RaceConfig.bots and stepSim substitutes these masks for them.
 *
 * The driving model is the greedy gate-chaser the test suite and the ?bot
 * client always used: steer by the sign of cross(forward, toNextGate),
 * drift on sharp angles, fire held items on a fixed cadence.
 */
import { sub, wideCross, wideDot } from './fixed.js';
import { cosB, sinB } from './trig.js';
import { BTN_ACCEL, BTN_BRAKE, BTN_LEFT, BTN_RIGHT, BTN_DRIFT, BTN_ITEM } from './input.js';
import { ITEM_NONE, type GameState } from './state.js';

export function botMask(st: GameState, k: number): number {
  const kart = st.karts[k];
  if (!kart || kart.finishTick >= 0) return 0;
  // fire whatever we're holding shortly after pickup (cheap but lively)
  if (kart.heldItem !== ITEM_NONE && st.tick % 45 === 0) {
    return botSteer(st, k) | BTN_ITEM;
  }
  return botSteer(st, k);
}

function botSteer(st: GameState, k: number): number {
  const kart = st.karts[k]!;
  const g = st.track.gates[kart.nextCp]!;
  const fwdX = cosB(kart.heading);
  const fwdY = sinB(kart.heading);
  const tx = sub(g.cx, kart.x);
  const ty = sub(g.cy, kart.y);
  const crossV = wideCross(fwdX, fwdY, tx, ty);
  const dotV = wideDot(fwdX, fwdY, tx, ty);
  let mask = BTN_ACCEL;
  if (crossV > 0) mask |= BTN_LEFT;
  else if (crossV < 0) mask |= BTN_RIGHT;
  if (dotV > 0 && (crossV > dotV || -crossV > dotV)) mask |= BTN_DRIFT;
  if (dotV < 0) mask = (mask & ~BTN_ACCEL) | BTN_BRAKE;
  return mask;
}
