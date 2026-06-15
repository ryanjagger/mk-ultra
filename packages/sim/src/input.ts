/** Input frame encoding: one small bitmask per player per tick. */

export const BTN_ACCEL = 1;
export const BTN_BRAKE = 2;
export const BTN_LEFT = 4;
export const BTN_RIGHT = 8;
export const BTN_DRIFT = 16;
export const BTN_ITEM = 32;

export const INPUT_NEUTRAL = 0;

// Analog steer magnitude: bits 6-9 carry a 0..15 deflection level; the sign
// still comes from BTN_LEFT/BTN_RIGHT. Backward-compat trick (load-bearing):
// magnitude 0 *with a direction bit set* means full lock, so every legacy mask
// (keyboard, bots, replays, leaderboard RLE, determinism inputs) decodes to
// exactly full deflection, bit-for-bit unchanged. Only the mobile joystick
// ever writes a non-zero magnitude.
export const STEER_MAG_SHIFT = 6;
export const STEER_MAG_MAX = 15;
export const STEER_MAG_MASK = STEER_MAG_MAX << STEER_MAG_SHIFT; // 960
export const INPUT_MASK_ALL = 63 | STEER_MAG_MASK; // was 63 -> 1023

/**
 * Steering axis from a mask, CCW-positive to match the brad convention
 * (heading increases CCW): LEFT -> +1, RIGHT -> -1.
 */
export function steerOf(mask: number): number {
  return ((mask & BTN_LEFT) !== 0 ? 1 : 0) - ((mask & BTN_RIGHT) !== 0 ? 1 : 0);
}

/** Raw 4-bit magnitude field (0..15) — see steerMagOf for the legacy decode. */
export function steerMagRaw(mask: number): number {
  return (mask >> STEER_MAG_SHIFT) & STEER_MAG_MAX;
}

/**
 * Effective steer level: 0 if no direction; else 1..15, with raw 0 => full
 * lock (the legacy meaning, so bare direction bits steer fully).
 */
export function steerMagOf(mask: number): number {
  if (steerOf(mask) === 0) return 0;
  const raw = steerMagRaw(mask);
  return raw === 0 ? STEER_MAG_MAX : raw;
}

/**
 * Pack a direction with an explicit level, clamped to 1..15 so a steering
 * input never collides with the legacy "raw 0 == full lock" meaning.
 */
export function packSteer(sign: number, level: number): number {
  if (sign === 0) return 0;
  const dir = sign > 0 ? BTN_LEFT : BTN_RIGHT;
  const lv = level < 1 ? 1 : level > STEER_MAG_MAX ? STEER_MAG_MAX : level;
  return dir | (lv << STEER_MAG_SHIFT);
}
