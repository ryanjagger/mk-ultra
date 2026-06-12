/**
 * CPU seats: bot masks are computed inside stepSim from state alone, so a
 * race with bots is exactly as deterministic as one without — including
 * under rollback, where bot seats are neutral-confirmed and never stall.
 */
import { describe, it, expect } from 'vitest';
import {
  RollbackSession,
  createGameState,
  stepSim,
  hashState,
  computePlacements,
  rngNextState,
  rngValue,
  BTN_ACCEL,
  COUNTDOWN_TICKS,
  TICK_RATE,
  PHASE_FINISHED,
  TRACKS,
  type RaceConfig,
} from '../src/index.js';

const MAX_TICKS = 300 * TICK_RATE;

function humanInputs(seed: number, frames: number): number[] {
  const row: number[] = [];
  let s = seed | 0;
  let mask = BTN_ACCEL;
  for (let f = 0; f < frames; f++) {
    s = rngNextState(s);
    const v = rngValue(s);
    if (v % 5 === 0) mask = (v >>> 8) & 63;
    row.push(mask);
  }
  return row;
}

describe('CPU seats (in-sim bots)', () => {
  it.each(TRACKS.map((t) => [t.def.id] as const))(
    'a full-bot race on %s finishes with valid placements and re-runs identically',
    (trackId) => {
      const cfg: RaceConfig = {
        seed: 4242,
        lapCount: 2,
        playerCount: 4,
        trackId,
        bots: [true, true, true, true],
      };
      const run = (): { hash: number; st: ReturnType<typeof createGameState> } => {
        const st = createGameState(cfg);
        // inputs are irrelevant for bot seats — pass garbage to prove it
        while (st.phase !== PHASE_FINISHED && st.tick < MAX_TICKS) {
          stepSim(st, [63, 63, 63, 63]);
        }
        return { hash: hashState(st), st };
      };
      const a = run();
      const b = run();
      expect(a.st.phase).toBe(PHASE_FINISHED);
      expect(a.hash).toBe(b.hash);
      const placements = computePlacements(a.st);
      expect([...placements].sort()).toEqual([0, 1, 2, 3]);
      for (const k of a.st.karts) {
        expect(k.finishTick).toBeGreaterThan(COUNTDOWN_TICKS);
      }
    },
  );

  it('rollback with bot seats: late human inputs converge to the lockstep oracle', () => {
    const FRAMES = 900;
    const cfg: RaceConfig = {
      seed: 9001,
      lapCount: 3,
      playerCount: 4,
      bots: [false, false, true, true],
    };
    const h0 = humanInputs(0xb0b0, FRAMES);
    const h1 = humanInputs(0xb1b1, FRAMES);

    // oracle: zero-delay lockstep
    const oracle = createGameState(cfg);
    for (let f = 0; f < FRAMES; f++) stepSim(oracle, [h0[f]!, h1[f]!, 0, 0]);

    // session: player 1's inputs arrive in late bursts; bots never send at all
    const sess = new RollbackSession(cfg, 0);
    let delivered = 0;
    for (let f = 0; f < FRAMES; f++) {
      sess.addLocalInput(h0[f]!);
      if (!sess.advance()) {
        // stalled at the prediction cap: deliver what the wire owes us
        while (delivered <= f) {
          sess.addInput(1, delivered, h1[delivered]!);
          delivered++;
        }
        expect(sess.advance()).toBe(true);
        continue;
      }
      // deliver remote inputs in bursts of 11 frames, lagging behind
      if (f % 11 === 0) {
        while (delivered <= f - 5 && delivered < FRAMES) {
          sess.addInput(1, delivered, h1[delivered]!);
          delivered++;
        }
      }
    }
    while (delivered < FRAMES) {
      sess.addInput(1, delivered, h1[delivered]!);
      delivered++;
    }
    sess.applyCorrections();
    expect(sess.frame).toBe(FRAMES);
    expect(hashState(sess.state)).toBe(hashState(oracle));
    expect(sess.stats.rollbacks).toBeGreaterThan(0); // the test actually exercised rollback
  });
});
