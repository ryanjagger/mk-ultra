/**
 * Hill physics: per-vertex elevation lerped along the centerline, gravity
 * along the gradient, slope-shifted speed caps. Synthetic tracks via
 * buildTrack, karts placed explicitly — same pattern as elements.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTrack,
  createGameState,
  stepSim,
  fxConst,
  fxToFloat,
  COUNTDOWN_TICKS,
  BTN_ACCEL,
  INPUT_NEUTRAL,
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

/**
 * CCW rectangle loop. Bottom straight climbs west-to-east (slope 0.1),
 * right side sits flat on the plateau, top straight descends back to the
 * valley, left side is flat at h=0.
 */
function hillDef(hs: [number, number, number, number, number, number]): TrackDef {
  return {
    id: 'test-hill',
    name: 'Test Hill',
    verts: [
      { x: -40, y: -20, h: hs[0] },
      { x: 0, y: -20, h: hs[1] },
      { x: 40, y: -20, h: hs[2] },
      { x: 40, y: 20, h: hs[3] },
      { x: 0, y: 20, h: hs[4] },
      { x: -40, y: 20, h: hs[5] },
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

const hilly = buildTrack(hillDef([0, 4, 8, 8, 4, 0]));
const flat = buildTrack(hillDef([0, 0, 0, 0, 0, 0]));

/** Game state running on a synthetic (non-registry) track. */
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

/** Full-throttle run from (x, y) at `heading` for `ticks`; distance covered. */
function sprint(track: TrackRuntime, x: number, y: number, heading: number, ticks: number): number {
  const st = mkState(track);
  const kart = st.karts[0]!;
  kart.x = fxConst(x);
  kart.y = fxConst(y);
  kart.heading = heading;
  const x0 = kart.x;
  const y0 = kart.y;
  for (let i = 0; i < ticks; i++) stepSim(st, [BTN_ACCEL]);
  return Math.hypot(fxToFloat(kart.x - x0), fxToFloat(kart.y - y0));
}

describe('hills', () => {
  it('flat track derives no heights and skips slope physics', () => {
    expect(flat.hasHills).toBe(false);
    expect(hilly.hasHills).toBe(true);
    expect(fxToFloat(hilly.heights[2]!)).toBe(8);
  });

  it('climbing is slower, descending is faster than flat ground', () => {
    // bottom straight eastbound: uphill at slope 0.1
    const up = sprint(hilly, -35, -20, 0, 160);
    // top straight westbound: downhill at slope 0.1
    const down = sprint(hilly, 35, 20, 32768, 160);
    const ref = sprint(flat, -35, -20, 0, 160);
    expect(up).toBeLessThan(ref * 0.93);
    expect(up).toBeGreaterThan(ref * 0.5); // gentle slopes never stall a kart
    expect(down).toBeGreaterThan(ref * 1.04);
  });

  it('gravity rolls an idle kart back down the slope', () => {
    const st = mkState(hilly);
    const kart = st.karts[0]!;
    kart.x = fxConst(0); // mid-climb, facing uphill, no throttle
    kart.y = fxConst(-20);
    kart.heading = 0;
    for (let i = 0; i < 120; i++) stepSim(st, [INPUT_NEUTRAL]);
    expect(fxToFloat(kart.x)).toBeLessThan(-8); // rolled well back downhill
    const stFlat = mkState(flat);
    const kf = stFlat.karts[0]!;
    kf.x = fxConst(0);
    kf.y = fxConst(-20);
    kf.heading = 0;
    for (let i = 0; i < 120; i++) stepSim(stFlat, [INPUT_NEUTRAL]);
    expect(kf.x).toBe(fxConst(0)); // flat ground: stays put
  });

  it('flat stretches of a hilly track match the flat track bit-for-bit', () => {
    // left straight southbound is at h=0 with flat neighbours at both ends
    const run = (track: TrackRuntime) => {
      const st = mkState(track);
      const kart = st.karts[0]!;
      kart.x = fxConst(-40);
      kart.y = fxConst(10);
      kart.heading = 49152; // due south
      for (let i = 0; i < 60; i++) stepSim(st, [BTN_ACCEL]);
      return [kart.x, kart.y, kart.vx, kart.vy, kart.heading];
    };
    expect(run(hilly)).toEqual(run(flat));
  });

  it('is deterministic across identical runs', () => {
    const run = () => {
      const st = mkState(hilly);
      const kart = st.karts[0]!;
      for (let i = 0; i < 400; i++) stepSim(st, [BTN_ACCEL]);
      return [kart.x, kart.y, kart.vx, kart.vy, kart.heading];
    };
    expect(run()).toEqual(run());
  });
});
