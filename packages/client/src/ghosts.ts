/**
 * Ghost storage for time trials. A ghost is the complete input stream of a
 * run plus the config needed to re-simulate it: because the sim is
 * deterministic, replaying (seed, trackId, laps, inputs) reproduces the run
 * bit-exactly — no positions are stored, only inputs.
 *
 * Records live in localStorage, one per (track, laps). Inputs are RLE-coded
 * [mask, runLength] pairs; masks hold for many ticks so a multi-minute run
 * compresses to a few hundred pairs.
 */

import { encodeRle, decodeRle, TT_SEED } from '@mk/shared';
export { encodeRle, decodeRle, TT_SEED };

export interface GhostRecord {
  v: 1;
  trackId: string;
  laps: number;
  seed: number;
  /** tick the run crossed the line; time = (finishTick - COUNTDOWN_TICKS) / 60 */
  finishTick: number;
  /** input stream from tick 0 as [mask, runLength] pairs */
  rle: [number, number][];
}

const key = (trackId: string, laps: number): string => `mk-ghost-${trackId}-${laps}`;

export function loadGhost(trackId: string, laps: number): GhostRecord | null {
  try {
    const raw = localStorage.getItem(key(trackId, laps));
    if (!raw) return null;
    const rec = JSON.parse(raw) as GhostRecord;
    if (rec.v !== 1 || rec.trackId !== trackId || rec.laps !== laps) return null;
    if (!Array.isArray(rec.rle) || typeof rec.finishTick !== 'number') return null;
    return rec;
  } catch {
    return null;
  }
}

export function saveGhost(rec: GhostRecord): void {
  try {
    localStorage.setItem(key(rec.trackId, rec.laps), JSON.stringify(rec));
  } catch {
    // storage full or blocked — the run still happened, just isn't saved
  }
}
