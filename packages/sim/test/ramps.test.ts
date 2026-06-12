/**
 * Ramp jumps: launch, ballistic flight, landing, and what airtime clears.
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
  ITEM_OIL,
  OIL_ARM_TICKS,
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

// vert 1 (0,-20) carries a ramp across most of the bottom straight
const DEF: TrackDef = {
  id: 'test-ramps',
  name: 'Test Ramps',
  verts: [
    { x: -60, y: -20, w: 9 },
    { x: 0, y: -20, w: 9 },
    { x: 60, y: -20, w: 9 },
    { x: 60, y: 20, w: 9 },
    { x: 0, y: 20, w: 9 },
    { x: -60, y: 20, w: 9 },
  ],
  checkpointVerts: [0, 2, 3, 5],
  itemVerts: [],
  boostPads: [],
  ramps: [{ vert: 1, t: 0.5, halfLen: 1.7, halfWid: 6 }],
  spawns: [
    [-50, -22, 0],
    [-50, -18, 0],
    [-54, -22, 0],
    [-54, -18, 0],
  ],
  theme: THEME,
};

const TRACK = buildTrack(DEF);

function mkState(players = 1): GameState {
  const base = createGameState({ seed: 7, lapCount: 3, playerCount: players });
  const st: GameState = { ...base, track: TRACK, items: TRACK.itemSpawns.map(() => 0) };
  st.tick = COUNTDOWN_TICKS;
  for (let i = 0; i < players; i++) {
    const kart = st.karts[i]!;
    const spawn = TRACK.spawns[i]!;
    kart.x = spawn.x;
    kart.y = spawn.y;
    kart.heading = spawn.heading;
  }
  return st;
}

/** Drive kart 0 east at pace toward the ramp at x=0; returns the state. */
function approach(st: GameState): void {
  const kart = st.karts[0]!;
  kart.x = fxConst(-20);
  kart.y = fxConst(-20);
  kart.vx = fxConst(0.4);
}

describe('ramp jumps', () => {
  it('launches at the ramp, flies, and lands back at z=0', () => {
    const st = mkState();
    approach(st);
    const kart = st.karts[0]!;
    let apex = 0;
    let launched = -1;
    let landed = -1;
    for (let i = 0; i < 200; i++) {
      stepSim(st, [BTN_ACCEL]);
      const z = fxToFloat(kart.z);
      if (z > 0 && launched < 0) launched = i;
      if (z > apex) apex = z;
      if (launched >= 0 && landed < 0 && z === 0) landed = i;
    }
    expect(launched).toBeGreaterThan(-1);
    expect(apex).toBeGreaterThan(1);
    expect(landed).toBeGreaterThan(launched + 20);
    expect(kart.vz).toBe(0);
  });

  it('a slow roll barely hops, full pace flies far', () => {
    const fly = (vx: number) => {
      const st = mkState();
      const kart = st.karts[0]!;
      kart.x = fxConst(-3);
      kart.y = fxConst(-20);
      kart.vx = fxConst(vx);
      let apex = 0;
      for (let i = 0; i < 120; i++) {
        stepSim(st, [INPUT_NEUTRAL]);
        apex = Math.max(apex, fxToFloat(kart.z));
      }
      return apex;
    };
    expect(fly(0.42)).toBeGreaterThan(fly(0.15) * 1.5);
  });

  it('airtime clears an armed oil slick under the flight path', () => {
    const st = mkState(2);
    // kart 1 parks far away and pre-drops conceptually: place oil directly
    const oil = st.oils[0]!;
    oil.ttl = 720 - OIL_ARM_TICKS - 1; // armed
    oil.x = fxConst(6); // a few units past the ramp — mid-flight
    oil.y = fxConst(-20);
    oil.owner = 1;
    st.karts[1]!.x = fxConst(50);
    st.karts[1]!.y = fxConst(20);
    approach(st);
    const kart = st.karts[0]!;
    for (let i = 0; i < 90; i++) stepSim(st, [BTN_ACCEL, INPUT_NEUTRAL]);
    expect(kart.spinTicks).toBe(0); // flew right over it
    expect(fxToFloat(kart.x)).toBeGreaterThan(10);

    // control: same approach with no ramp in the way hits the oil
    const flat = mkState(2);
    const oil2 = flat.oils[0]!;
    oil2.ttl = 720 - OIL_ARM_TICKS - 1;
    oil2.x = fxConst(-10); // before the ramp
    oil2.y = fxConst(-20);
    oil2.owner = 1;
    flat.karts[1]!.x = fxConst(50);
    flat.karts[1]!.y = fxConst(20);
    approach(flat);
    let spun = false;
    for (let i = 0; i < 90 && !spun; i++) {
      stepSim(flat, [BTN_ACCEL, INPUT_NEUTRAL]);
      spun = flat.karts[0]!.spinTicks > 0;
    }
    expect(spun).toBe(true);
  });

  it('is deterministic across identical runs', () => {
    const run = () => {
      const st = mkState();
      approach(st);
      for (let i = 0; i < 300; i++) stepSim(st, [BTN_ACCEL]);
      const k = st.karts[0]!;
      return [k.x, k.y, k.z, k.vz, k.heading];
    };
    expect(run()).toEqual(run());
  });
});
