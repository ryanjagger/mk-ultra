/**
 * Countdown rev-boost: hold accel into GO inside the window for a launch.
 */
import { describe, it, expect } from 'vitest';
import {
  createGameState,
  stepSim,
  COUNTDOWN_TICKS,
  BTN_ACCEL,
  INPUT_NEUTRAL,
  REV_PERFECT_TICKS,
  REV_OK_TICKS,
  REV_BOOST_PERFECT,
  REV_BOOST_OK,
} from '../src/index.js';

/** Run the whole countdown holding accel for the final `held` ticks. */
function launch(held: number): number {
  const st = createGameState({ seed: 1, lapCount: 1, playerCount: 1 });
  for (let t = 0; t < COUNTDOWN_TICKS + 1; t++) {
    const hold = COUNTDOWN_TICKS - t <= held;
    stepSim(st, [hold ? BTN_ACCEL : INPUT_NEUTRAL]);
  }
  return st.karts[0]!.boostTicks;
}

describe('countdown rev-boost', () => {
  it('perfect-window rev grants the big launch', () => {
    expect(launch(20)).toBe(REV_BOOST_PERFECT - 1); // -1: one racing tick elapsed
    expect(launch(REV_PERFECT_TICKS)).toBe(REV_BOOST_PERFECT - 1);
  });

  it('early rev grants the modest launch', () => {
    expect(launch(REV_PERFECT_TICKS + 10)).toBe(REV_BOOST_OK - 1);
    expect(launch(REV_OK_TICKS)).toBe(REV_BOOST_OK - 1);
  });

  it('flooding the engine or not revving grants nothing', () => {
    expect(launch(REV_OK_TICKS + 30)).toBe(0);
    expect(launch(COUNTDOWN_TICKS)).toBe(0); // held the whole countdown
    expect(launch(0)).toBe(0);
  });

  it('releasing before GO resets the rev', () => {
    const st = createGameState({ seed: 1, lapCount: 1, playerCount: 1 });
    for (let t = 0; t < COUNTDOWN_TICKS + 1; t++) {
      const left = COUNTDOWN_TICKS - t;
      // rev inside the window but let go for the last 5 ticks
      stepSim(st, [left <= 30 && left > 5 ? BTN_ACCEL : INPUT_NEUTRAL]);
    }
    expect(st.karts[0]!.boostTicks).toBe(0);
  });
});
