/**
 * Debug auto-driver (enable with ?bot): steers toward the next checkpoint
 * gate using the same integer-only math as the sim test bot. The mask it
 * produces goes through the exact same input path as the keyboard, so it is
 * also a handy end-to-end test driver.
 */
import {
  cosB,
  sinB,
  sub,
  wideCross,
  wideDot,
  BTN_ACCEL,
  BTN_BRAKE,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_DRIFT,
  type GameState,
} from '@mk/sim';

export function botMask(st: GameState, k: number): number {
  const kart = st.karts[k];
  if (!kart || kart.finishTick >= 0) return 0;
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
