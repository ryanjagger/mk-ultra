/**
 * Regression for the render-buffer refresh path in RaceController.update().
 *
 * RollbackSession.advance() runs applyCorrections() BEFORE its prediction-stall
 * check, so a late remote input can roll the sim back AND then stall on the very
 * same advance() call (it returns false). The render buffers must still pick up
 * that correction — otherwise the renderer keeps drawing stale predicted
 * positions while session.state / the HUD read the corrected world, until a
 * later successful advance papers over it.
 *
 * This test forces exactly that coincidence and asserts the rendered remote
 * kart matches the corrected sim state.
 */
import { describe, it, expect } from 'vitest';
import { BTN_ACCEL, INPUT_NEUTRAL, getTrack, TICK_RATE } from '@mk/sim';
import { RaceController, snapshotKarts } from '../src/game.js';
import type { Net } from '../src/net.js';
import type { ClockSync } from '../src/clock.js';
import type { Keyboard } from '../src/keyboard.js';

const TRACK = 'sunny-circuit';
const ticksToMs = (t: number) => (t / TICK_RATE) * 1000;

function makeController() {
  const clock = { nowMs: 0 };
  const net = { send() {} } as unknown as Net;
  const clockSync = { serverNow: () => clock.nowMs } as unknown as ClockSync;
  const keyboard = { sample: () => INPUT_NEUTRAL } as unknown as Keyboard;
  const ctrl = new RaceController(net, clockSync, keyboard, {
    seed: 1,
    laps: 3,
    trackId: TRACK,
    startAtMs: 0,
    you: 0,
    names: ['you', 'p1'],
  });
  return { ctrl, clock };
}

describe('RaceController render-buffer freshness', () => {
  it('captures a correction that lands on the same advance() that stalls', () => {
    const { ctrl, clock } = makeController();
    const track = getTrack(TRACK);
    const maxPred = ctrl.session.maxPrediction;

    // Remote player 1 is confirmed through frame 183 (control unlocks at the
    // 180-tick countdown, so these are real racing frames), with a deliberate
    // HOLE at 184. The hole means the later misprediction at 185 can't advance
    // the contiguous-confirmed pointer past 183, so the stall persists even
    // after the correction is recorded.
    const CONFIRM_THROUGH = 183;
    const MISPREDICT = 185; // 184 left as a hole
    for (let f = 0; f <= CONFIRM_THROUGH; f++) ctrl.onRemoteInput(1, f, BTN_ACCEL);

    // Walk update() to the prediction wall: stall once frame - 183 > maxPred.
    const stallFrame = CONFIRM_THROUGH + maxPred + 1;
    let t = 25;
    for (let i = 0; i < 40 && !ctrl.stalled; i++) {
      clock.nowMs = ticksToMs(t);
      ctrl.update();
      t += 25;
    }
    expect(ctrl.stalled).toBe(true);
    expect(ctrl.session.frame).toBe(stallFrame);

    // Settle interpolation alpha to 1 (clock just past the stalled frame, small
    // enough not to trip the hidden-tab rebase).
    clock.nowMs = ticksToMs(stallFrame + 2);
    ctrl.update();

    // The predicted remote pose, before the correction arrives.
    const predicted = ctrl.renderKarts(10)[1]!;
    const predX = predicted.x;
    const predZ = predicted.z;
    const rbBefore = ctrl.session.stats.rollbacks;

    // A late, contradicting input for frame 185 arrives. used[1][185] was the
    // repeated-ACCEL prediction, so this schedules a rollback (dirtyFrame=185);
    // the 184 hole keeps contig at 183, so the stall is still live.
    ctrl.onRemoteInput(1, MISPREDICT, INPUT_NEUTRAL);

    // This update()'s single advance() applies the rollback then returns false.
    clock.nowMs = ticksToMs(stallFrame + 3);
    ctrl.update();

    // The correction happened on a still-stalled frame.
    expect(ctrl.stalled).toBe(true);
    expect(ctrl.session.frame).toBe(stallFrame);
    expect(ctrl.session.stats.rollbacks).toBe(rbBefore + 1);

    const truth = snapshotKarts(ctrl.session.state, track)[1]!;
    // Guard against a vacuous test: the rollback must actually move the kart.
    expect(Math.hypot(truth.x - predX, truth.z - predZ)).toBeGreaterThan(0.05);

    // The fix: the rendered remote kart reflects the corrected state, not the
    // stale predicted buffer. alpha=1 + large dt snaps visualKarts onto curr.
    const rendered = ctrl.renderKarts(10)[1]!;
    expect(rendered.x).toBeCloseTo(truth.x, 5);
    expect(rendered.z).toBeCloseTo(truth.z, 5);
  });
});
