/**
 * Run-length coding for input-mask streams. Masks hold for many ticks, so a
 * multi-minute run compresses to a few hundred [mask, runLength] pairs.
 * Used by time-trial ghosts (client) and race replays (server → client).
 */

export type RlePair = [number, number];

export function encodeRle(masks: readonly number[]): RlePair[] {
  const out: RlePair[] = [];
  for (const m of masks) {
    const last = out[out.length - 1];
    if (last && last[0] === m) last[1]++;
    else out.push([m, 1]);
  }
  return out;
}

export function decodeRle(rle: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const [mask, len] of rle) for (let i = 0; i < len; i++) out.push(mask);
  return out;
}
