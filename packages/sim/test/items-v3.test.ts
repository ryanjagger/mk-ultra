/**
 * Items v3: lightning, multi-charge boost, homing shells, item-use cooldown.
 * Same synthetic-track pattern as items.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTrack,
  createGameState,
  stepSim,
  fxConst,
  fxToFloat,
  COUNTDOWN_TICKS,
  BTN_ITEM,
  BTN_ACCEL,
  INPUT_NEUTRAL,
  ITEM_NONE,
  ITEM_BOOST,
  ITEM_SHELL,
  ITEM_LIGHTNING,
  ITEM_TRIPLE_BOOST,
  ITEM_DOUBLE_BOOST,
  ITEM_HOMING_SHELL,
  ITEM_REUSE_TICKS,
  SPIN_OUT_TICKS,
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

const DEF: TrackDef = {
  id: 'test-items-v3',
  name: 'Test Items V3',
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
  spawns: [
    [-40, -22, 0],
    [-40, -18, 0],
    [-44, -22, 0],
    [-44, -18, 0],
  ],
  theme: THEME,
};

const TRACK = buildTrack(DEF);

function mkState(players: number): GameState {
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

describe('lightning', () => {
  it('spins out every other kart, not the user', () => {
    const st = mkState(4);
    st.karts[3]!.heldItem = ITEM_LIGHTNING;
    stepSim(st, [0, 0, 0, BTN_ITEM]);
    expect(st.karts[3]!.spinTicks).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(st.karts[i]!.spinTicks).toBe(SPIN_OUT_TICKS - (i === 0 ? 0 : 0));
    }
    expect(st.karts[3]!.heldItem).toBe(ITEM_NONE);
  });

  it('skips karts that already finished', () => {
    const st = mkState(2);
    st.karts[0]!.finishTick = 100;
    st.karts[1]!.heldItem = ITEM_LIGHTNING;
    stepSim(st, [0, BTN_ITEM]);
    expect(st.karts[0]!.spinTicks).toBe(0);
  });
});

describe('triple boost', () => {
  it('grants three separate boosts across distinct presses', () => {
    const st = mkState(1);
    const kart = st.karts[0]!;
    kart.heldItem = ITEM_TRIPLE_BOOST;
    stepSim(st, [BTN_ITEM]);
    expect(kart.heldItem).toBe(ITEM_DOUBLE_BOOST);
    expect(kart.boostTicks).toBeGreaterThan(0);
    // holding the button does nothing while the cooldown drains
    for (let i = 0; i < ITEM_REUSE_TICKS; i++) stepSim(st, [BTN_ITEM]);
    expect(kart.heldItem).toBe(ITEM_DOUBLE_BOOST);
    stepSim(st, [BTN_ITEM]);
    expect(kart.heldItem).toBe(ITEM_BOOST);
    for (let i = 0; i < ITEM_REUSE_TICKS; i++) stepSim(st, [BTN_ITEM]);
    stepSim(st, [BTN_ITEM]);
    expect(kart.heldItem).toBe(ITEM_NONE);
  });
});

describe('homing shell', () => {
  it('curves into an offset target that a plain shell misses', () => {
    const run = (item: number) => {
      const st = mkState(2);
      const shooter = st.karts[0]!;
      const target = st.karts[1]!;
      shooter.x = fxConst(-40);
      shooter.y = fxConst(-20);
      shooter.heading = 0;
      shooter.heldItem = item;
      // target ahead but offset ~4 units laterally — off the straight line
      target.x = fxConst(-20);
      target.y = fxConst(-16);
      let hitAt = -1;
      for (let i = 0; i < 240 && hitAt < 0; i++) {
        stepSim(st, [i === 0 ? BTN_ITEM : INPUT_NEUTRAL, INPUT_NEUTRAL]);
        if (target.spinTicks > 0) hitAt = i;
      }
      return hitAt;
    };
    expect(run(ITEM_HOMING_SHELL)).toBeGreaterThan(-1);
    expect(run(ITEM_SHELL)).toBe(-1);
  });

  it('keeps shell speed constant while steering', () => {
    const st = mkState(2);
    const shooter = st.karts[0]!;
    st.karts[1]!.x = fxConst(-10);
    st.karts[1]!.y = fxConst(-14);
    shooter.x = fxConst(-40);
    shooter.y = fxConst(-20);
    shooter.heading = 0;
    shooter.heldItem = ITEM_HOMING_SHELL;
    stepSim(st, [BTN_ITEM, INPUT_NEUTRAL]);
    const live = st.shells.find((s) => s.ttl > 0)!;
    for (let i = 0; i < 20; i++) stepSim(st, [INPUT_NEUTRAL, INPUT_NEUTRAL]);
    if (live.ttl > 0) {
      const speed = Math.hypot(fxToFloat(live.vx), fxToFloat(live.vy));
      expect(speed).toBeCloseTo(0.7, 1);
    }
  });

  it('is deterministic across identical runs', () => {
    const run = () => {
      const st = mkState(2);
      st.karts[0]!.heldItem = ITEM_HOMING_SHELL;
      for (let i = 0; i < 200; i++) {
        stepSim(st, [i === 0 ? BTN_ITEM | BTN_ACCEL : BTN_ACCEL, BTN_ACCEL]);
      }
      return st.karts.map((k) => [k.x, k.y, k.spinTicks]).flat();
    };
    expect(run()).toEqual(run());
  });
});
