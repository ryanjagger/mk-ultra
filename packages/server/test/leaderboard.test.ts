/**
 * Verified leaderboards: the server replays submitted inputs through the sim
 * and stores the time the sim computed. Legit runs (generated here by the
 * in-sim bot) verify; fabricated input streams that never finish are
 * rejected; boards keep the best run per name and persist to disk.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGameState,
  stepSim,
  botMask,
  PHASE_FINISHED,
  COUNTDOWN_TICKS,
  TICK_RATE,
  BTN_ACCEL,
} from '@mk/sim';
import { encodeRle, TT_SEED } from '@mk/shared';
import { Leaderboards } from '../src/leaderboard.js';

/**
 * A legitimate finished run, as the client would submit it. `hesitate` drops
 * the throttle for that many ticks after GO — a genuinely slower run (input
 * streams are closed-loop recordings; they cannot simply be time-shifted).
 */
function botRun(trackId: string, hesitate = 0): { rle: [number, number][]; timeMs: number } {
  const st = createGameState({ seed: TT_SEED, lapCount: 1, playerCount: 1, trackId });
  const recorded: number[] = [];
  while (st.phase !== PHASE_FINISHED && st.tick < 60 * 240) {
    let mask = botMask(st, 0);
    if (st.tick >= COUNTDOWN_TICKS && st.tick < COUNTDOWN_TICKS + hesitate) mask &= ~BTN_ACCEL;
    recorded.push(mask);
    stepSim(st, [mask]);
  }
  const ft = st.karts[0]!.finishTick;
  expect(ft).toBeGreaterThan(0);
  return {
    rle: encodeRle(recorded.slice(0, ft)),
    timeMs: Math.round(((ft - COUNTDOWN_TICKS) / TICK_RATE) * 1000),
  };
}

describe('verified leaderboards', () => {
  it('accepts a real run with the sim-computed time, rejects fabrications', () => {
    const lb = new Leaderboards(mkdtempSync(join(tmpdir(), 'mk-lb-')));
    const run = botRun('sunny-circuit');

    const rank = lb.submit('alice', 'sunny-circuit', 1, run.rle);
    expect(rank).toBe(0);
    const top = lb.top('sunny-circuit', 1);
    expect(top).toEqual([{ name: 'alice', timeMs: run.timeMs }]);

    // a forged stream that just holds accel into the first wall never finishes
    expect(lb.submit('mallory', 'sunny-circuit', 1, [[BTN_ACCEL, 600]])).toBeNull();
    // unknown tracks are rejected outright
    expect(lb.submit('mallory', 'nope', 1, run.rle)).toBeNull();
    // a run submitted for the wrong lap count fails verification
    expect(lb.submit('mallory', 'sunny-circuit', 3, run.rle)).toBeNull();
    expect(lb.top('sunny-circuit', 1)).toHaveLength(1);
  });

  it('keeps the best run per name and ranks rivals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mk-lb-'));
    const lb = new Leaderboards(dir);
    const run = botRun('sunny-circuit');
    // a slower legit run: sit still for 1.5s after GO, then drive
    const slow = botRun('sunny-circuit', 90);
    expect(slow.timeMs).toBeGreaterThan(run.timeMs);

    expect(lb.submit('alice', 'sunny-circuit', 1, slow.rle)).toBe(0);
    expect(lb.submit('bob', 'sunny-circuit', 1, run.rle)).toBe(0); // bob is faster
    expect(lb.top('sunny-circuit', 1).map((e) => e.name)).toEqual(['bob', 'alice']);

    // alice improves and retakes the lead
    expect(lb.submit('alice', 'sunny-circuit', 1, run.rle)).toBe(0);
    const top = lb.top('sunny-circuit', 1);
    expect(top[0]!.name).toBe('alice'); // ties break alphabetically
    expect(top).toHaveLength(2);

    // resubmitting a worse run does not regress the stored best
    expect(lb.submit('alice', 'sunny-circuit', 1, slow.rle)).toBe(0);
    expect(lb.top('sunny-circuit', 1)[0]!.timeMs).toBe(run.timeMs);

    // ghosts come back with the stored inputs
    const ghost = lb.ghost('sunny-circuit', 1, 0);
    expect(ghost?.name).toBe('alice');
    expect(ghost?.rle).toEqual(run.rle);

    // persistence: a fresh instance reads the same boards
    const lb2 = new Leaderboards(dir);
    expect(lb2.top('sunny-circuit', 1)).toEqual(lb.top('sunny-circuit', 1));
  });
});
