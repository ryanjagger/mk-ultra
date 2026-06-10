/**
 * Track elements: boost pads, off-track dirt, variable width. Uses synthetic
 * test tracks built directly with buildTrack (not in the registry), with
 * karts placed explicitly. No hashing here — registry tracks get the full
 * hash treatment in determinism/tracks tests.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTrack,
  createGameState,
  stepSim,
  onDirt,
  fxConst,
  fxToFloat,
  PAD_BOOST_TICKS,
  COUNTDOWN_TICKS,
  BTN_ACCEL,
  MAX_SPEED,
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

// CCW rectangle loop with a mid-vertex on each straight
function rectDef(partial: Partial<TrackDef>): TrackDef {
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
    ...partial,
  };
}

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

describe('boost pads', () => {
  const track = buildTrack(
    rectDef({ boostPads: [{ vert: 1, t: 0.5, halfLen: 2, halfWid: 4 }] }),
  );
  const pad = track.boostPads[0]!;

  it('grants a boost while driven over, none elsewhere', () => {
    const st = mkState(track);
    const kart = st.karts[0]!;
    kart.x = pad.cx;
    kart.y = pad.cy;
    stepSim(st, [BTN_ACCEL]);
    expect(kart.boostTicks).toBe(PAD_BOOST_TICKS);
    // re-applied every tick while on the pad (kart barely moves from rest)
    stepSim(st, [BTN_ACCEL]);
    expect(kart.boostTicks).toBe(PAD_BOOST_TICKS);

    const st2 = mkState(track);
    const kart2 = st2.karts[0]!;
    kart2.x = fxConst(-30); // far from the pad
    kart2.y = fxConst(-20);
    stepSim(st2, [BTN_ACCEL]);
    expect(kart2.boostTicks).toBe(0);
  });

  it('pad boost makes the kart measurably faster down the straight', () => {
    const run = (withPad: boolean) => {
      const st = mkState(track);
      const kart = st.karts[0]!;
      kart.x = fxConst(withPad ? -6 : -38); // pad sits at x=0; -38 start misses it... both drive east
      kart.y = pad.cy;
      const x0 = kart.x;
      for (let i = 0; i < 90; i++) stepSim(st, [BTN_ACCEL]);
      return fxToFloat(kart.x - x0);
    };
    // the run that crosses the pad covers more ground in the same ticks
    expect(run(true)).toBeGreaterThan(run(false) + 2);
  });

  it('is deterministic across identical runs', () => {
    const run = () => {
      const st = mkState(track);
      const kart = st.karts[0]!;
      kart.x = fxConst(-10);
      kart.y = pad.cy;
      for (let i = 0; i < 120; i++) stepSim(st, [BTN_ACCEL]);
      return [kart.x, kart.y, kart.vx, kart.vy, kart.boostTicks];
    };
    expect(run()).toEqual(run());
  });
});

describe('off-track dirt', () => {
  const track = buildTrack(
    rectDef({ verts: rectDef({}).verts.map((v) => ({ ...v, w: 6, dirt: 6 })) }),
  );

  it('onDirt distinguishes asphalt from dirt', () => {
    expect(onDirt(track, fxConst(0), fxConst(-20))).toBe(false); // centerline
    expect(onDirt(track, fxConst(0), fxConst(-15))).toBe(false); // 5 in, w=6
    expect(onDirt(track, fxConst(0), fxConst(-12.5))).toBe(true); // 7.5 off
    expect(onDirt(track, fxConst(0), fxConst(-27))).toBe(true); // outer dirt band
    expect(onDirt(track, fxConst(0), fxConst(-26))).toBe(false); // exactly on the edge: asphalt
  });

  it('dirt is slower; boost ignores dirt', () => {
    const run = (y: number, boost: number) => {
      const st = mkState(track);
      const kart = st.karts[0]!;
      kart.x = fxConst(-35);
      kart.y = fxConst(y);
      kart.boostTicks = boost;
      const x0 = kart.x;
      for (let i = 0; i < 120; i++) stepSim(st, [BTN_ACCEL]);
      return fxToFloat(kart.x - x0);
    };
    const asphalt = run(-20, 0);
    const dirt = run(-13, 0); // 7 units off-center: dirt band
    const dirtBoosted = run(-13, 300);
    expect(dirt).toBeLessThan(asphalt * 0.75);
    expect(dirtBoosted).toBeGreaterThan(asphalt);
  });

  it('dirt caps top speed', () => {
    const st = mkState(track);
    const kart = st.karts[0]!;
    kart.x = fxConst(-38);
    kart.y = fxConst(-13);
    for (let i = 0; i < 200; i++) stepSim(st, [BTN_ACCEL]);
    const speed = Math.hypot(fxToFloat(kart.vx), fxToFloat(kart.vy));
    expect(speed).toBeLessThan(fxToFloat(MAX_SPEED) * 0.6);
  });

  it('walls sit at the fence, not the asphalt edge', () => {
    // drivable out to ~12 units from the centerline (6 asphalt + 6 dirt)
    const st = mkState(track);
    const kart = st.karts[0]!;
    kart.x = fxConst(0);
    kart.y = fxConst(-20);
    kart.heading = 49152; // due south, straight into the outer dirt band
    for (let i = 0; i < 120; i++) stepSim(st, [BTN_ACCEL]);
    const y = fxToFloat(kart.y);
    expect(y).toBeLessThan(-27); // made it well past the asphalt edge at -26
    expect(y).toBeGreaterThan(-32.2); // but the fence (at -32, minus kart radius) stopped it
  });
});

describe('variable width', () => {
  // bottom straight narrows from w=8 at x=-40 to w=4 at x=0
  const track = buildTrack(
    rectDef({
      verts: [
        { x: -40, y: -20, w: 8 },
        { x: 0, y: -20, w: 4 },
        { x: 40, y: -20, w: 8 },
        { x: 40, y: 20, w: 8 },
        { x: 0, y: 20, w: 8 },
        { x: -40, y: 20, w: 8 },
      ].map((v) => ({ ...v, dirt: 8 })),
    }),
  );

  it('lerped half-width tracks the taper', () => {
    // 6 units left of centerline: inside at t=0.25 (w=7), outside at t=0.75 (w=5)
    expect(onDirt(track, fxConst(-30), fxConst(-14))).toBe(false);
    expect(onDirt(track, fxConst(-10), fxConst(-14))).toBe(true);
  });

  it('asphalt edges respect per-vertex width', () => {
    const wide = track.inner[0]!;
    const narrow = track.inner[1]!;
    // inner edge offset ~ vertex width (miter at these gentle corners ~1x)
    expect(Math.abs(fxToFloat(wide.y) - -12)).toBeLessThan(1.5);
    expect(Math.abs(fxToFloat(narrow.y) - -16)).toBeLessThan(0.5);
  });
});
