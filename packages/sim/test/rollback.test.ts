/**
 * The M4 gate: a client whose remote inputs arrive late and out of order must
 * converge to the exact same state hashes as a zero-delay lockstep run.
 */
import { describe, it, expect } from 'vitest';
import {
  RollbackSession,
  createGameState,
  stepSim,
  hashState,
  rngNextState,
  rngValue,
  BTN_ACCEL,
  INPUT_NEUTRAL,
  type RaceConfig,
} from '../src/index.js';

const CFG2: RaceConfig = { seed: 777, lapCount: 3, playerCount: 2 };
const CFG4: RaceConfig = { seed: 777, lapCount: 3, playerCount: 4 };

function chaosInputs(seed: number, players: number, frames: number): number[][] {
  const out: number[][] = [];
  let s = seed | 0;
  for (let p = 0; p < players; p++) {
    const row: number[] = [];
    let mask = BTN_ACCEL;
    for (let f = 0; f < frames; f++) {
      s = rngNextState(s);
      const v = rngValue(s);
      if (v % 5 === 0) mask = (v >>> 8) & 31;
      row.push(mask);
    }
    out.push(row);
  }
  return out;
}

function oracleHashes(cfg: RaceConfig, inputs: number[][], frames: number): Map<number, number> {
  const st = createGameState(cfg);
  const hashes = new Map<number, number>();
  hashes.set(0, hashState(st));
  for (let f = 0; f < frames; f++) {
    stepSim(
      st,
      Array.from({ length: cfg.playerCount }, (_, p) => inputs[p]![f]!),
    );
    hashes.set(f + 1, hashState(st));
  }
  return hashes;
}

describe('M4 rollback gate', () => {
  it('zero-delay delivery never rolls back and matches the oracle', () => {
    const FRAMES = 600;
    const inputs = chaosInputs(0xaa, 2, FRAMES);
    const oracle = oracleHashes(CFG2, inputs, FRAMES);
    const sess = new RollbackSession(CFG2, 0);
    for (let f = 0; f < FRAMES; f++) {
      sess.addInput(1, f, inputs[1]![f]!); // remote arrives before we sim the frame
      sess.addLocalInput(inputs[0]![f]!);
      expect(sess.advance()).toBe(true);
    }
    expect(sess.stats.rollbacks).toBe(0);
    expect(hashState(sess.state)).toBe(oracle.get(FRAMES));
  });

  it('delayed + reordered remote inputs converge to oracle hashes (incl. mid-run confirmed hashes)', () => {
    const FRAMES = 900;
    const inputs = chaosInputs(0xbb, 2, FRAMES);
    const oracle = oracleHashes(CFG2, inputs, FRAMES);

    const sess = new RollbackSession(CFG2, 0, 8);
    // schedule remote deliveries with jittered delays (0..12 frames) — beyond
    // the 8-frame window at times, forcing stalls — and shuffle same-time order
    let s = 0x5eed;
    const deliveries: { time: number; frame: number; mask: number }[] = [];
    for (let f = 0; f < FRAMES; f++) {
      s = rngNextState(s);
      const delay = rngValue(s) % 13;
      deliveries.push({ time: f + delay, frame: f, mask: inputs[1]![f]! });
    }
    s = rngNextState(s);
    // sort by delivery time, with PRNG tiebreak => reordering within bursts
    const jitter = deliveries.map((d) => {
      s = rngNextState(s);
      return { ...d, tie: rngValue(s) };
    });
    jitter.sort((a, b) => (a.time - b.time !== 0 ? a.time - b.time : a.tie - b.tie));

    const confirmedSeen = new Map<number, number>();
    let di = 0;
    let stalls = 0;
    for (let now = 0; now < FRAMES * 3 && sess.frame < FRAMES; now++) {
      while (di < jitter.length && jitter[di]!.time <= now) {
        const d = jitter[di]!;
        sess.addInput(1, d.frame, d.mask);
        di++;
      }
      if (sess.frame < FRAMES) {
        sess.addLocalInput(inputs[0]![sess.frame]!);
        if (!sess.advance()) stalls++;
      }
      // poll confirmed hashes like a real client would (every 30 frames)
      for (let f = Math.max(0, sess.frame - 60); f <= sess.frame; f += 1) {
        if (f % 30 === 0 && !confirmedSeen.has(f)) {
          const h = sess.confirmedHash(f);
          if (h !== null) confirmedSeen.set(f, h);
        }
      }
    }
    // drain
    while (di < jitter.length) {
      const d = jitter[di]!;
      sess.addInput(1, d.frame, d.mask);
      di++;
    }
    sess.applyCorrections();

    expect(sess.frame).toBe(FRAMES);
    expect(sess.stats.rollbacks).toBeGreaterThan(0); // the test actually exercised rollback
    expect(stalls).toBeGreaterThan(0); // and the stall path
    expect(hashState(sess.state)).toBe(oracle.get(FRAMES));
    expect(confirmedSeen.size).toBeGreaterThan(10);
    for (const [f, h] of confirmedSeen) {
      expect(h, `confirmed hash at frame ${f}`).toBe(oracle.get(f));
    }
  });

  it('two peer sessions cross-delivering with jitter agree with each other and the oracle', () => {
    const FRAMES = 600;
    const inputs = chaosInputs(0xcc, 2, FRAMES);
    const oracle = oracleHashes(CFG2, inputs, FRAMES);
    const a = new RollbackSession(CFG2, 0, 8);
    const b = new RollbackSession(CFG2, 1, 8);
    let s = 0x77;
    const queueToB: { time: number; frame: number; mask: number }[] = [];
    const queueToA: { time: number; frame: number; mask: number }[] = [];
    for (let now = 0; now < FRAMES * 4 && (a.frame < FRAMES || b.frame < FRAMES); now++) {
      for (const q of [queueToA, queueToB]) {
        while (q.length > 0 && q[0]!.time <= now) {
          const d = q.shift()!;
          (q === queueToA ? a : b).addInput(q === queueToA ? 1 : 0, d.frame, d.mask);
        }
      }
      if (a.frame < FRAMES) {
        const f = a.frame;
        a.addLocalInput(inputs[0]![f]!);
        if (a.advance()) {
          s = rngNextState(s);
          queueToB.push({ time: now + (rngValue(s) % 7), frame: f, mask: inputs[0]![f]! });
          queueToB.sort((x, y) => x.time - y.time);
        }
      }
      if (b.frame < FRAMES) {
        const f = b.frame;
        b.addLocalInput(inputs[1]![f]!);
        if (b.advance()) {
          s = rngNextState(s);
          queueToA.push({ time: now + (rngValue(s) % 7), frame: f, mask: inputs[1]![f]! });
          queueToA.sort((x, y) => x.time - y.time);
        }
      }
    }
    for (const d of queueToA) a.addInput(1, d.frame, d.mask);
    for (const d of queueToB) b.addInput(0, d.frame, d.mask);
    a.applyCorrections();
    b.applyCorrections();
    expect(a.frame).toBe(FRAMES);
    expect(b.frame).toBe(FRAMES);
    expect(hashState(a.state)).toBe(oracle.get(FRAMES));
    expect(hashState(b.state)).toBe(oracle.get(FRAMES));
  });

  it('4-player session with random jitter matches the oracle', () => {
    const FRAMES = 600;
    const inputs = chaosInputs(0xdd, 4, FRAMES);
    const oracle = oracleHashes(CFG4, inputs, FRAMES);
    const sess = new RollbackSession(CFG4, 2, 8);
    let s = 0x1234;
    const deliveries: { time: number; p: number; frame: number; mask: number }[] = [];
    for (const p of [0, 1, 3]) {
      for (let f = 0; f < FRAMES; f++) {
        s = rngNextState(s);
        deliveries.push({ time: f + (rngValue(s) % 10), p, frame: f, mask: inputs[p]![f]! });
      }
    }
    deliveries.sort((x, y) => x.time - y.time || x.p - y.p);
    let di = 0;
    for (let now = 0; now < FRAMES * 3 && sess.frame < FRAMES; now++) {
      while (di < deliveries.length && deliveries[di]!.time <= now) {
        const d = deliveries[di]!;
        sess.addInput(d.p, d.frame, d.mask);
        di++;
      }
      if (sess.frame < FRAMES) {
        sess.addLocalInput(inputs[2]![sess.frame]!);
        sess.advance();
      }
    }
    while (di < deliveries.length) {
      const d = deliveries[di]!;
      sess.addInput(d.p, d.frame, d.mask);
      di++;
    }
    sess.applyCorrections();
    expect(sess.frame).toBe(FRAMES);
    expect(hashState(sess.state)).toBe(oracle.get(FRAMES));
  });

  it('converges on a track with boost pads and dirt (re-sim covers the new code paths)', () => {
    const FRAMES = 900; // past the countdown, well into racing over pads/dirt
    const CFGC: RaceConfig = { ...CFG2, trackId: 'canyon-sprint' };
    const inputs = chaosInputs(0xbc, 2, FRAMES);
    const oracle = oracleHashes(CFGC, inputs, FRAMES);
    const sess = new RollbackSession(CFGC, 0, 8);
    let s = 0x1ce;
    const deliveries: { time: number; frame: number; mask: number }[] = [];
    for (let f = 0; f < FRAMES; f++) {
      s = rngNextState(s);
      deliveries.push({ time: f + (rngValue(s) % 11), frame: f, mask: inputs[1]![f]! });
    }
    deliveries.sort((a, b) => a.time - b.time || a.frame - b.frame);
    let di = 0;
    for (let now = 0; now < FRAMES * 3 && sess.frame < FRAMES; now++) {
      while (di < deliveries.length && deliveries[di]!.time <= now) {
        sess.addInput(1, deliveries[di]!.frame, deliveries[di]!.mask);
        di++;
      }
      if (sess.frame < FRAMES) {
        sess.addLocalInput(inputs[0]![sess.frame]!);
        sess.advance();
      }
    }
    while (di < deliveries.length) {
      sess.addInput(1, deliveries[di]!.frame, deliveries[di]!.mask);
      di++;
    }
    sess.applyCorrections();
    expect(sess.frame).toBe(FRAMES);
    expect(sess.stats.rollbacks).toBeGreaterThan(0);
    expect(hashState(sess.state)).toBe(oracle.get(FRAMES));
  });

  it('a dropped player coasts deterministically (neutral from the drop frame)', () => {
    const FRAMES = 400;
    const DROP_AT = 150;
    const inputs = chaosInputs(0xee, 2, FRAMES);
    // oracle: player 1 inputs real until DROP_AT, neutral after
    const oracleInputs = [
      inputs[0]!,
      inputs[1]!.map((m, f) => (f >= DROP_AT ? INPUT_NEUTRAL : m)),
    ];
    const oracle = oracleHashes(CFG2, oracleInputs, FRAMES);

    const sess = new RollbackSession(CFG2, 0, 8);
    for (let f = 0; f < FRAMES; f++) {
      // remote inputs arrive 3 frames late, stop arriving at DROP_AT,
      // and the drop notice arrives at frame DROP_AT+10
      const lag = f - 3;
      if (lag >= 0 && lag < DROP_AT) sess.addInput(1, lag, inputs[1]![lag]!);
      if (f === DROP_AT + 10) sess.dropPlayer(1, DROP_AT);
      sess.addLocalInput(inputs[0]![sess.frame]!);
      sess.advance();
    }
    // deliver the remaining straggler confirmed inputs (frames DROP_AT-3..DROP_AT-1)
    for (let f = Math.max(0, DROP_AT - 3); f < DROP_AT; f++) sess.addInput(1, f, inputs[1]![f]!);
    // catch up the frames lost to stalling while the drop notice was in flight
    while (sess.frame < FRAMES) {
      sess.addLocalInput(inputs[0]![sess.frame]!);
      expect(sess.advance()).toBe(true);
    }
    sess.applyCorrections();
    expect(sess.frame).toBe(FRAMES);
    expect(hashState(sess.state)).toBe(oracle.get(FRAMES));
    // dropped player counts as confirmed forever -> no stall
    expect(sess.confirmedFrame()).toBeGreaterThanOrEqual(FRAMES - 1);
  });

  it('stalls rather than predicting past the window', () => {
    const sess = new RollbackSession(CFG2, 0, 8);
    let advanced = 0;
    for (let f = 0; f < 30; f++) {
      sess.addLocalInput(BTN_ACCEL);
      if (sess.advance()) advanced++;
    }
    // no remote inputs at all: we can predict 8 frames past frame -1... then stall
    expect(advanced).toBeLessThanOrEqual(9);
    expect(sess.stats.stalledFrames).toBeGreaterThan(0);
  });
});
