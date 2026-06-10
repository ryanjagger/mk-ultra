/**
 * The M2 hard gate: same seed + same input sequence => bit-identical state,
 * verified via state hashes at every step. Runs in Node, which together with
 * the no-float construction is what makes the cross-platform claim testable
 * in CI (NFR-5).
 */
import { describe, it, expect } from 'vitest';
import {
  createGameState,
  stepSim,
  hashState,
  writeSnapshot,
  readSnapshot,
  snapshotInts,
  computePlacements,
  type RaceConfig,
  type GameState,
  PHASE_FINISHED,
  COUNTDOWN_TICKS,
  WORLD_BOUND,
  TRACKS,
  sub,
  wideCross,
  wideDot,
  cosB,
  sinB,
  BTN_ACCEL,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_DRIFT,
  BTN_BRAKE,
  BTN_ITEM,
  ITEM_NONE,
  rngNextState,
  rngValue,
} from '../src/index.js';

const CFG: RaceConfig = { seed: 0xc0ffee, lapCount: 3, playerCount: 4 };

/** Deterministic chaotic input stream per player (PRNG-driven, integer only). */
function chaosInputs(seed: number, players: number, frames: number): number[][] {
  const out: number[][] = [];
  let s = seed | 0;
  for (let p = 0; p < players; p++) {
    const row: number[] = [];
    let mask = BTN_ACCEL;
    for (let f = 0; f < frames; f++) {
      s = rngNextState(s);
      const v = rngValue(s);
      if (v % 7 === 0) {
        // re-roll the held mask every so often, like a human mashing keys
        // (includes BTN_ITEM, so pickups/shells/oils/spin-outs get exercised)
        mask = (v >>> 8) & 63;
      }
      row.push(mask);
    }
    out.push(row);
  }
  return out;
}

/**
 * Integer-only driver bot: steer by the sign of cross(forward, toNextGate).
 * Uses only fx/wide ops, so the input sequence it generates is itself
 * deterministic across engines.
 */
function botInput(st: GameState, k: number): number {
  const kart = st.karts[k]!;
  if (kart.finishTick >= 0) return 0;
  const g = st.track.gates[kart.nextCp]!;
  const fwdX = cosB(kart.heading);
  const fwdY = sinB(kart.heading);
  const tx = sub(g.cx, kart.x);
  const ty = sub(g.cy, kart.y);
  const crossV = wideCross(fwdX, fwdY, tx, ty);
  const dotV = wideDot(fwdX, fwdY, tx, ty);
  let mask = BTN_ACCEL;
  if (crossV > 0) mask |= BTN_LEFT;
  else if (crossV < 0) mask |= BTN_RIGHT;
  // target way off axis: drift through the turn (also exercises mini-boosts)
  if (dotV > 0 && (crossV > dotV || -crossV > dotV)) mask |= BTN_DRIFT;
  // target behind: slow down while turning
  if (dotV < 0) mask = (mask & ~BTN_ACCEL) | BTN_BRAKE;
  // fire held items so full-race runs exercise shells/oils/spin-outs
  if (kart.heldItem !== ITEM_NONE && st.tick % 45 === 0) mask |= BTN_ITEM;
  return mask;
}

describe('M2 determinism gate', () => {
  it('two identical chaos runs produce identical hashes every 60 ticks', () => {
    const FRAMES = 5400; // 90s of chaos driving incl. wall/kart collisions
    const inputs = chaosInputs(0xfeed, 4, FRAMES);
    const hashesOf = () => {
      const st = createGameState(CFG);
      const hashes: number[] = [];
      for (let f = 0; f < FRAMES; f++) {
        stepSim(st, [inputs[0]![f]!, inputs[1]![f]!, inputs[2]![f]!, inputs[3]![f]!]);
        if (f % 60 === 0) hashes.push(hashState(st));
      }
      hashes.push(hashState(st));
      return hashes;
    };
    const a = hashesOf();
    const b = hashesOf();
    expect(a).toEqual(b);
  });

  it('snapshot round-trip resumes bit-identically mid-race', () => {
    const FRAMES = 2000;
    const SPLIT = 777;
    const inputs = chaosInputs(0xbead, 4, FRAMES);
    const masksAt = (f: number) => [inputs[0]![f]!, inputs[1]![f]!, inputs[2]![f]!, inputs[3]![f]!];

    const a = createGameState(CFG);
    for (let f = 0; f < FRAMES; f++) stepSim(a, masksAt(f));

    const b = createGameState(CFG);
    for (let f = 0; f < SPLIT; f++) stepSim(b, masksAt(f));
    const snap = new Int32Array(snapshotInts(CFG));
    writeSnapshot(b, snap);
    const c = createGameState(CFG);
    readSnapshot(c, snap);
    expect(hashState(c)).toBe(hashState(b));
    for (let f = SPLIT; f < FRAMES; f++) stepSim(c, masksAt(f));

    expect(hashState(c)).toBe(hashState(a));
  });

  it('karts stay inside the world bound under chaos input', () => {
    const FRAMES = 3000;
    const inputs = chaosInputs(0xdead, 4, FRAMES);
    const st = createGameState(CFG);
    for (let f = 0; f < FRAMES; f++) {
      stepSim(st, [inputs[0]![f]!, inputs[1]![f]!, inputs[2]![f]!, inputs[3]![f]!]);
    }
    for (const k of st.karts) {
      expect(Math.abs(k.x)).toBeLessThanOrEqual(WORLD_BOUND);
      expect(Math.abs(k.y)).toBeLessThanOrEqual(WORLD_BOUND);
    }
  });

  it.each(TRACKS.map((t) => [t.def.id]))(
    'bot-driven full race on %s finishes with valid laps, placements and identical re-run',
    (trackId) => {
    const MAX_FRAMES = COUNTDOWN_TICKS + 60 * 240;
    const TCFG: RaceConfig = { ...CFG, trackId };
    const run = () => {
      const st = createGameState(TCFG);
      const recorded: number[][] = [];
      const hashes: number[] = [];
      while (st.phase !== PHASE_FINISHED && st.tick < MAX_FRAMES) {
        const masks = st.karts.map((_, i) => botInput(st, i));
        recorded.push(masks);
        stepSim(st, masks);
        if (st.tick % 60 === 0) hashes.push(hashState(st));
      }
      return { st, recorded, hashes, final: hashState(st) };
    };

    const r1 = run();
    expect(r1.st.phase).toBe(PHASE_FINISHED);
    for (const k of r1.st.karts) {
      expect(k.finishTick).toBeGreaterThan(COUNTDOWN_TICKS);
      expect(k.lap).toBe(CFG.lapCount + 1);
    }
    const placements = computePlacements(r1.st);
    expect([...placements].sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
    // finishing order matches finish ticks
    for (let i = 1; i < placements.length; i++) {
      const prev = r1.st.karts[placements[i - 1]!]!;
      const cur = r1.st.karts[placements[i]!]!;
      expect(prev.finishTick).toBeLessThanOrEqual(cur.finishTick);
    }

    // replaying the recorded inputs reproduces the run hash-for-hash
    const st2 = createGameState(TCFG);
    const hashes2: number[] = [];
    for (const masks of r1.recorded) {
      stepSim(st2, masks);
      if (st2.tick % 60 === 0) hashes2.push(hashState(st2));
    }
    expect(hashes2).toEqual(r1.hashes);
    expect(hashState(st2)).toBe(r1.final);
  });

  it('different seeds diverge (items/PRNG actually affect state)', () => {
    // drive a kart through the bottom item cluster so the PRNG is consumed
    const FRAMES = COUNTDOWN_TICKS + 1200;
    const run = (seed: number) => {
      const st = createGameState({ ...CFG, seed });
      while (st.tick < FRAMES && st.phase !== PHASE_FINISHED) {
        const masks = st.karts.map((_, i) => botInput(st, i));
        stepSim(st, masks);
      }
      return st;
    };
    const a = run(1);
    const b = run(2);
    // PRNG state must differ; positions may or may not by now
    expect(a.rng).not.toBe(b.rng);
  });
});
