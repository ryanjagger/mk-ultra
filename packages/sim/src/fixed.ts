/**
 * Q16.16 fixed-point math. The only numeric representation allowed in sim state.
 *
 * Determinism rationale: every function here uses only operations whose results
 * are exactly specified by ECMAScript (integer +/-/*, bitwise ops, IEEE-754
 * `/` on exact-integer doubles, Math.trunc/floor/round on exact values).
 * No Math.sin/cos/tan/pow/exp/log anywhere in the sim.
 *
 * Magnitude contract: world coordinates stay within ±500 units (±2^25 raw),
 * so products of two raw values stay below 2^53 and are exact in doubles.
 * `wideCross`/`wideDot` rely on this.
 */

/** A Q16.16 fixed-point value stored in a signed 32-bit integer. */
export type Fx = number;

export const FX_SHIFT = 16;
export const FX_ONE: Fx = 1 << FX_SHIFT; // 65536
export const FX_HALF: Fx = 1 << (FX_SHIFT - 1);

/** Small integer -> Fx. |i| must be < 32768. */
export function fx(i: number): Fx {
  return (i << FX_SHIFT) | 0;
}

/**
 * Float literal -> Fx, for compile-time constants ONLY (never on runtime data).
 * Deterministic because ES exactly specifies literal parsing, `*` rounding and
 * Math.round.
 */
export function fxConst(f: number): Fx {
  return Math.round(f * 65536) | 0;
}

/** Fx -> float. RENDER/DEBUG ONLY — never feed the result back into the sim. */
export function fxToFloat(a: Fx): number {
  return a / 65536;
}

export function fxToInt(a: Fx): number {
  return a >> FX_SHIFT;
}

export function add(a: Fx, b: Fx): Fx {
  return (a + b) | 0;
}

export function sub(a: Fx, b: Fx): Fx {
  return (a - b) | 0;
}

export function neg(a: Fx): Fx {
  return -a | 0;
}

export function abs(a: Fx): Fx {
  return a < 0 ? -a | 0 : a;
}

export function min(a: Fx, b: Fx): Fx {
  return a < b ? a : b;
}

export function max(a: Fx, b: Fx): Fx {
  return a > b ? a : b;
}

export function clamp(a: Fx, lo: Fx, hi: Fx): Fx {
  return a < lo ? lo : a > hi ? hi : a;
}

/**
 * Q16.16 multiply, rounds toward -infinity.
 * Split into 16-bit halves so every partial product is an exact double
 * (< 2^49); the final `| 0` wraps to int32 deterministically.
 */
export function mul(a: Fx, b: Fx): Fx {
  const ah = a >> 16;
  const al = a & 0xffff;
  const bh = b >> 16;
  const bl = b & 0xffff;
  return (ah * bh * 65536 + ah * bl + al * bh + ((al * bl) >>> 16)) | 0;
}

/**
 * Q16.16 divide, truncates toward zero. b must be non-zero.
 * a * 65536 is an exact double (|a| < 2^31 -> < 2^47); IEEE-754 `/` is
 * exactly specified, so the result is deterministic across engines.
 */
export function div(a: Fx, b: Fx): Fx {
  return Math.trunc((a * 65536) / b) | 0;
}

/** Linear interpolation: a + (b-a)*t, t in Q16.16. */
export function lerp(a: Fx, b: Fx, t: Fx): Fx {
  return (a + mul(sub(b, a), t)) | 0;
}

/**
 * Exact integer sqrt: floor(sqrt(n)) for 0 <= n < 2^52.
 * Math.sqrt only seeds the guess; the fix-up loops below make the result
 * exact regardless of how the seed was rounded — deterministic by construction.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x -= 1;
  while ((x + 1) * (x + 1) <= n) x += 1;
  return x;
}

/** sqrt of a Q16.16 value (a >= 0): floor(sqrt(a * 2^16)) is again Q16.16. */
export function sqrt(a: Fx): Fx {
  if (a <= 0) return 0;
  return isqrt(a * 65536) | 0;
}

/**
 * Length of a raw fx vector. |dx|,|dy| must be < 2^25 (world bound), so
 * dx*dx + dy*dy < 2^51 is exact; isqrt of (real^2 * 2^32) = real * 2^16 = Fx.
 */
export function len(dx: Fx, dy: Fx): Fx {
  return isqrt(dx * dx + dy * dy) | 0;
}

/**
 * Wide 2D cross product a × b on raw fx components. Result is a plain exact
 * integer double scaled by 2^32 — use only for sign tests and ratios.
 * Exact while |components| < 2^26.
 */
export function wideCross(ax: Fx, ay: Fx, bx: Fx, by: Fx): number {
  return ax * by - ay * bx;
}

/** Wide dot product, same contract as wideCross. */
export function wideDot(ax: Fx, ay: Fx, bx: Fx, by: Fx): number {
  return ax * bx + ay * by;
}

/**
 * floor-toward-zero of (num / den) * 2^16 where num/den are wide exact-integer
 * doubles (e.g. results of wideDot). Uses BigInt so the 16-bit upshift cannot
 * lose precision; BigInt division truncates deterministically.
 */
export function ratioFx(num: number, den: number): Fx {
  return Number((BigInt(num) << 16n) / BigInt(den)) | 0;
}
