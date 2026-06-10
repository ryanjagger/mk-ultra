/**
 * Mulberry32 PRNG — integer-only, deterministic across engines.
 * State is a single int32 that lives inside the game state snapshot.
 */

/** Advance the state by one step. Returns the new state (int32). */
export function rngNextState(state: number): number {
  return (state + 0x6d2b79f5) | 0;
}

/** Derive the uint32 output for a given state. */
export function rngValue(state: number): number {
  let t = state | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

/** Uniform-ish integer in [0, n). Modulo bias is acceptable for gameplay. */
export function rngRange(value: number, n: number): number {
  return value % n;
}
