/**
 * Analog steer encoding. The load-bearing invariant: every legacy mask (bare
 * direction bits, magnitude 0) decodes to FULL lock and produces byte-identical
 * physics to today — that is what protects the M2/M4 golden hashes. Only the
 * mobile joystick ever writes a non-zero magnitude (partial deflection).
 */
import { describe, it, expect } from 'vitest';
import {
  buildTrack,
  createGameState,
  stepSim,
  hashState,
  COUNTDOWN_TICKS,
  BTN_ACCEL,
  BTN_LEFT,
  BTN_RIGHT,
  INPUT_NEUTRAL,
  INPUT_MASK_ALL,
  STEER_MAG_MAX,
  STEER_MAG_SHIFT,
  steerOf,
  steerMagOf,
  steerMagRaw,
  packSteer,
  type TrackDef,
  type TrackRuntime,
  type GameState,
  type TrackTheme,
} from '../src/index.js';

const THEME: TrackTheme = {
  sky: '#000',
  fog: '#000',
  ground: '#000',
  asphalt: '#000',
  dirt: '#000',
  wallA: '#000',
  wallB: '#000',
  decor: 'trees',
};

function rectDef(): TrackDef {
  return {
    id: 'test-rect',
    name: 'Test Rect',
    verts: [
      { x: -40, y: -20 },
      { x: 0, y: -20 },
      { x: 40, y: -20 },
      { x: 40, y: 20 },
      { x: 0, y: 20 },
      { x: -40, y: 20 },
    ],
    checkpointVerts: [0, 2, 3, 5],
    itemVerts: [],
    boostPads: [],
    spawns: [
      [-30, -22, 0],
      [-30, -18, 0],
      [-34, -22, 0],
      [-34, -18, 0],
    ],
    theme: THEME,
  };
}

/** Racing-phase state on a synthetic track, kart on its spawn. */
function mkState(track: TrackRuntime): GameState {
  const base = createGameState({ seed: 7, lapCount: 3, playerCount: 1 });
  const st: GameState = { ...base, track, items: track.itemSpawns.map(() => 0) };
  st.tick = COUNTDOWN_TICKS; // skip straight to racing
  const kart = st.karts[0]!;
  const spawn = track.spawns[0]!;
  kart.x = spawn.x;
  kart.y = spawn.y;
  kart.heading = spawn.heading;
  return st;
}

const TRACK = buildTrack(rectDef());

/** Build speed, then apply one steering tick; return the signed heading delta. */
function headingDeltaAfterSteer(steerMask: number): number {
  const st = mkState(TRACK);
  const kart = st.karts[0]!;
  for (let i = 0; i < 120; i++) stepSim(st, [BTN_ACCEL]); // reach cruising speed
  const before = kart.heading;
  stepSim(st, [BTN_ACCEL | steerMask]);
  let d = (kart.heading - before) & 0xffff;
  if (d > 32768) d -= 65536;
  return d;
}

describe('analog steer encoding', () => {
  it('INPUT_MASK_ALL widened to include the magnitude field', () => {
    expect(INPUT_MASK_ALL).toBe(1023);
    expect(STEER_MAG_MAX << STEER_MAG_SHIFT).toBe(960);
  });

  it('legacy masks (raw magnitude 0) decode to full lock', () => {
    expect(steerMagRaw(BTN_LEFT)).toBe(0);
    expect(steerMagOf(BTN_LEFT)).toBe(STEER_MAG_MAX);
    expect(steerMagOf(BTN_RIGHT)).toBe(STEER_MAG_MAX);
    expect(steerMagOf(BTN_ACCEL | BTN_LEFT)).toBe(STEER_MAG_MAX);
  });

  it('no direction => no magnitude', () => {
    expect(steerMagOf(INPUT_NEUTRAL)).toBe(0);
    expect(steerMagOf(BTN_ACCEL)).toBe(0);
  });

  it('packSteer / steerMagOf round-trip at levels 1, 8, 15', () => {
    for (const lv of [1, 8, 15]) {
      const left = packSteer(1, lv);
      expect(steerOf(left)).toBe(1);
      expect(steerMagOf(left)).toBe(lv);
      const right = packSteer(-1, lv);
      expect(steerOf(right)).toBe(-1);
      expect(steerMagOf(right)).toBe(lv);
    }
  });

  it('packSteer clamps level to 1..15 and zeroes a neutral sign', () => {
    expect(packSteer(0, 9)).toBe(0);
    expect(steerMagOf(packSteer(1, 0))).toBe(1); // below range -> 1
    expect(steerMagOf(packSteer(1, 99))).toBe(STEER_MAG_MAX); // above range -> 15
    // a packed mask never exceeds the protocol bound
    expect(packSteer(-1, 15)).toBeLessThanOrEqual(INPUT_MASK_ALL);
  });

  it('full-magnitude steer is byte-identical to a bare direction bit', () => {
    // the whole point: full lock short-circuits to the literal fx(steer)
    const a = mkState(TRACK);
    const b = mkState(TRACK);
    for (let i = 0; i < 120; i++) {
      stepSim(a, [BTN_ACCEL]);
      stepSim(b, [BTN_ACCEL]);
    }
    stepSim(a, [BTN_ACCEL | BTN_LEFT]);
    stepSim(b, [BTN_ACCEL | packSteer(1, STEER_MAG_MAX)]);
    expect(hashState(b)).toBe(hashState(a));
  });

  it('partial deflection turns less than full, same direction', () => {
    const full = headingDeltaAfterSteer(BTN_LEFT); // legacy == full lock
    const half = headingDeltaAfterSteer(packSteer(1, 8));
    const lightest = headingDeltaAfterSteer(packSteer(1, 1));
    expect(full).toBeGreaterThan(0); // CCW for a left turn
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
    expect(lightest).toBeGreaterThan(0);
    expect(lightest).toBeLessThan(half);
    // right mirrors left: a full right turn matches the legacy bare bit
    expect(headingDeltaAfterSteer(BTN_RIGHT)).toBe(-full);
  });
});
