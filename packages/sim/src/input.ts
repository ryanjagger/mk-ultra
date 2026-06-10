/** Input frame encoding: one small bitmask per player per tick. */

export const BTN_ACCEL = 1;
export const BTN_BRAKE = 2;
export const BTN_LEFT = 4;
export const BTN_RIGHT = 8;
export const BTN_DRIFT = 16;
export const BTN_ITEM = 32;

export const INPUT_NEUTRAL = 0;
export const INPUT_MASK_ALL = 63;

/**
 * Steering axis from a mask, CCW-positive to match the brad convention
 * (heading increases CCW): LEFT -> +1, RIGHT -> -1.
 */
export function steerOf(mask: number): number {
  return ((mask & BTN_LEFT) !== 0 ? 1 : 0) - ((mask & BTN_RIGHT) !== 0 ? 1 : 0);
}
