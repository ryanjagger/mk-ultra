/**
 * Item system: mystery-box pickups, placement-weighted rolls, held-item use,
 * shell flight/bounce/hits, oil slicks and spin-outs. Synthetic rect track
 * (same pattern as elements.test.ts); no hashing on synthetic-track states —
 * registry tracks get the hash treatment in the determinism gate.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTrack,
  createGameState,
  stepSim,
  isItemActive,
  fxConst,
  fxToFloat,
  writeSnapshot,
  readSnapshot,
  snapshotInts,
  hashState,
  COUNTDOWN_TICKS,
  BTN_ACCEL,
  BTN_ITEM,
  ITEM_NONE,
  ITEM_BOOST,
  ITEM_SHELL,
  ITEM_OIL,
  OIL_TTL,
  OIL_ARM_TICKS,
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

// CCW rectangle loop; vert 1 (0,-20) carries the item boxes at y -17/-20/-23
const DEF: TrackDef = {
  id: 'test-items',
  name: 'Test Items',
  verts: [
    { x: -40, y: -20 },
    { x: 0, y: -20 },
    { x: 40, y: -20 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
    { x: -40, y: 20 },
  ],
  checkpointVerts: [0, 2, 3, 5],
  itemVerts: [1],
  boostPads: [],
  spawns: [
    [-30, -22, 0],
    [-30, -18, 0],
    [-34, -22, 0],
    [-34, -18, 0],
  ],
  theme: THEME,
};

function mkState(track: TrackRuntime, players = 1, seed = 7): GameState {
  const base = createGameState({ seed, lapCount: 3, playerCount: players });
  const st: GameState = { ...base, track, items: track.itemSpawns.map(() => 0) };
  st.tick = COUNTDOWN_TICKS; // skip straight to racing
  for (let i = 0; i < players; i++) {
    const kart = st.karts[i]!;
    const spawn = track.spawns[i]!;
    kart.x = spawn.x;
    kart.y = spawn.y;
    kart.heading = spawn.heading;
  }
  return st;
}

const TRACK = buildTrack(DEF);
// boxes run inner->outer at t=0.25/0.5/0.75: (0,-17), (0,-20), (0,-23)
const BOX_MID = 1;

describe('mystery boxes', () => {
  it('grants a held item, deactivates the box, and respawns it later', () => {
    const st = mkState(TRACK);
    const kart = st.karts[0]!;
    kart.x = TRACK.itemSpawns[BOX_MID]!.x;
    kart.y = TRACK.itemSpawns[BOX_MID]!.y;
    stepSim(st, [0]);
    expect(kart.heldItem).not.toBe(ITEM_NONE);
    expect([ITEM_BOOST, ITEM_SHELL, ITEM_OIL]).toContain(kart.heldItem);
    expect(isItemActive(st, BOX_MID)).toBe(false);
    expect(st.items[BOX_MID]!).toBeGreaterThan(st.tick);
    // sitting on the (inactive) box must not re-grant once the item is used later
    expect(st.items[BOX_MID]!).toBeLessThan(st.tick + 300 + 120 + 1);
  });

  it('a kart already holding an item drives through without consuming the box', () => {
    const st = mkState(TRACK);
    const kart = st.karts[0]!;
    kart.heldItem = ITEM_BOOST;
    kart.x = TRACK.itemSpawns[BOX_MID]!.x;
    kart.y = TRACK.itemSpawns[BOX_MID]!.y;
    stepSim(st, [0]);
    expect(kart.heldItem).toBe(ITEM_BOOST);
    expect(isItemActive(st, BOX_MID)).toBe(true);
  });

  it('weights rolls by placement: last place never draws oil, the leader can', () => {
    const draw = (leaderPicks: boolean, seed: number) => {
      const st = mkState(TRACK, 2, seed);
      st.karts[0]!.lap = 3; // kart 0 leads on laps
      st.karts[1]!.lap = 1;
      const picker = st.karts[leaderPicks ? 0 : 1]!;
      picker.x = TRACK.itemSpawns[BOX_MID]!.x;
      picker.y = TRACK.itemSpawns[BOX_MID]!.y;
      const other = st.karts[leaderPicks ? 1 : 0]!;
      other.x = fxConst(-30); // far from every box
      other.y = fxConst(20);
      stepSim(st, [0, 0]);
      expect(picker.heldItem).not.toBe(ITEM_NONE);
      return picker.heldItem;
    };
    const leaderDraws: number[] = [];
    const lastDraws: number[] = [];
    for (let seed = 1; seed <= 24; seed++) {
      leaderDraws.push(draw(true, seed));
      lastDraws.push(draw(false, seed));
    }
    expect(lastDraws).not.toContain(ITEM_OIL); // tail band is catch-up only
    expect(lastDraws).toContain(ITEM_BOOST);
    expect(leaderDraws).toContain(ITEM_OIL); // leader band is defense-heavy
  });
});

describe('held item use', () => {
  it('boost applies immediately and clears the held slot', () => {
    const st = mkState(TRACK);
    const kart = st.karts[0]!;
    kart.heldItem = ITEM_BOOST;
    stepSim(st, [BTN_ITEM]);
    expect(kart.boostTicks).toBeGreaterThan(0);
    expect(kart.heldItem).toBe(ITEM_NONE);
  });

  it('does nothing when empty-handed', () => {
    const st = mkState(TRACK);
    stepSim(st, [BTN_ITEM | BTN_ACCEL]);
    expect(st.karts[0]!.boostTicks).toBe(0);
    expect(st.shells.every((s) => s.ttl === 0)).toBe(true);
    expect(st.oils.every((o) => o.ttl === 0)).toBe(true);
  });
});

describe('shells', () => {
  it('flies forward and spins out the kart it hits', () => {
    const st = mkState(TRACK, 2);
    const a = st.karts[0]!;
    const b = st.karts[1]!;
    a.x = fxConst(-30);
    a.y = fxConst(-20);
    a.heading = 0; // east
    a.heldItem = ITEM_SHELL;
    b.x = fxConst(-20);
    b.y = fxConst(-20);
    b.boostTicks = 100;
    stepSim(st, [BTN_ITEM, 0]);
    const shell = st.shells[0]!;
    expect(shell.ttl).toBeGreaterThan(0);
    expect(shell.owner).toBe(0);
    expect(shell.vx).toBeGreaterThan(0);

    let spunAt = -1;
    for (let i = 0; i < 30 && spunAt < 0; i++) {
      stepSim(st, [0, 0]);
      if (b.spinTicks > 0) spunAt = i;
    }
    expect(spunAt).toBeGreaterThanOrEqual(0);
    expect(st.shells[0]!.ttl).toBe(0); // consumed on hit
    expect(b.boostTicks).toBe(0); // spin-out kills the boost
  });

  it('cannot hit its owner before bouncing, but can after', () => {
    // chase: owner accelerates straight after its own shell and never catches it
    const chase = mkState(TRACK);
    const kart = chase.karts[0]!;
    kart.x = fxConst(-35);
    kart.y = fxConst(-20);
    kart.heading = 0;
    kart.heldItem = ITEM_SHELL;
    stepSim(chase, [BTN_ITEM | BTN_ACCEL]);
    for (let i = 0; i < 60; i++) stepSim(chase, [BTN_ACCEL]);
    expect(kart.spinTicks).toBe(0);

    // point-blank wall shot: the shell bounces straight back into the owner
    const wall = mkState(TRACK);
    const k2 = wall.karts[0]!;
    k2.x = fxConst(0);
    k2.y = fxConst(-20);
    k2.heading = 16384; // north, into the inner fence at y=-14
    k2.heldItem = ITEM_SHELL;
    stepSim(wall, [BTN_ITEM]);
    let spun = false;
    for (let i = 0; i < 40 && !spun; i++) {
      stepSim(wall, [0]);
      spun = k2.spinTicks > 0;
    }
    expect(spun).toBe(true);
    expect(wall.shells[0]!.bounces).toBeGreaterThan(0);
  });

  it('expires after its third wall bounce', () => {
    const st = mkState(TRACK);
    const kart = st.karts[0]!;
    kart.x = fxConst(0);
    kart.y = fxConst(-20);
    kart.heading = 16384; // north: ping-pongs between the corridor fences
    kart.heldItem = ITEM_SHELL;
    stepSim(st, [BTN_ITEM]);
    kart.x = fxConst(-30); // step out of the firing line
    let maxBounces = 0;
    let died = -1;
    for (let i = 0; i < 120 && died < 0; i++) {
      stepSim(st, [0]);
      const s = st.shells[0]!;
      if (s.bounces > maxBounces) maxBounces = s.bounces;
      if (s.ttl === 0) died = i;
    }
    expect(maxBounces).toBe(4); // 4th bounce is the killing one
    expect(died).toBeGreaterThanOrEqual(0); // long before the 360-tick ttl
    expect(kart.spinTicks).toBe(0);
  });
});

describe('oil slicks', () => {
  it('drops behind the kart, arms after the grace period, and spins the victim', () => {
    const st = mkState(TRACK, 2);
    const a = st.karts[0]!;
    const b = st.karts[1]!;
    a.x = fxConst(-20);
    a.y = fxConst(-20);
    a.heading = 0; // east -> oil lands ~2 units west
    a.heldItem = ITEM_OIL;
    b.x = fxConst(-22);
    b.y = fxConst(-20);
    stepSim(st, [BTN_ITEM, 0]);
    const oil = st.oils[0]!;
    expect(oil.ttl).toBeGreaterThan(0);
    expect(fxToFloat(oil.x)).toBeLessThan(-21); // behind the dropper
    // B sits on the slick through the arm window without triggering it
    for (let i = 0; i < OIL_ARM_TICKS - 2; i++) stepSim(st, [0, 0]);
    expect(b.spinTicks).toBe(0);
    expect(st.oils[0]!.ttl).toBeGreaterThan(0);
    // ...and is the first hit once it arms
    for (let i = 0; i < 4 && b.spinTicks === 0; i++) stepSim(st, [0, 0]);
    expect(b.spinTicks).toBeGreaterThan(0);
    expect(st.oils[0]!.ttl).toBe(0); // consumed
  });

  it('expires unused after its ttl', () => {
    const st = mkState(TRACK);
    const kart = st.karts[0]!;
    kart.x = fxConst(-20);
    kart.y = fxConst(-20);
    kart.heading = 16384; // drop it away from the spawn, then stay clear
    kart.heldItem = ITEM_OIL;
    stepSim(st, [BTN_ITEM]);
    kart.x = fxConst(30);
    for (let i = 0; i < OIL_TTL + 2; i++) stepSim(st, [0]);
    expect(st.oils[0]!.ttl).toBe(0);
    expect(kart.spinTicks).toBe(0);
  });
});

describe('spin-out', () => {
  it('locks controls while spinning, then control returns', () => {
    const spun = mkState(TRACK);
    spun.karts[0]!.spinTicks = SPIN_OUT_TICKS;
    const clean = mkState(TRACK);
    for (let i = 0; i < SPIN_OUT_TICKS; i++) {
      stepSim(spun, [BTN_ACCEL]);
      stepSim(clean, [BTN_ACCEL]);
    }
    const speedOf = (st: GameState) =>
      Math.hypot(fxToFloat(st.karts[0]!.vx), fxToFloat(st.karts[0]!.vy));
    expect(spun.karts[0]!.spinTicks).toBe(0);
    expect(speedOf(spun)).toBeLessThan(speedOf(clean) * 0.2);
    // control is back: both accelerate equally from here
    const v0 = speedOf(spun);
    for (let i = 0; i < 60; i++) stepSim(spun, [BTN_ACCEL]);
    expect(speedOf(spun)).toBeGreaterThan(v0 + 0.1);
  });
});

describe('snapshots', () => {
  it('round-trips live shells and oils bit-identically (registry track)', () => {
    const cfg = { seed: 0xabcd, lapCount: 3, playerCount: 2 };
    const st = createGameState(cfg);
    st.tick = COUNTDOWN_TICKS;
    st.karts[0]!.heldItem = ITEM_SHELL;
    st.karts[1]!.heldItem = ITEM_OIL;
    stepSim(st, [BTN_ITEM, BTN_ITEM]);
    for (let i = 0; i < 10; i++) stepSim(st, [BTN_ACCEL, BTN_ACCEL]);
    expect(st.shells[0]!.ttl).toBeGreaterThan(0);
    expect(st.oils[0]!.ttl).toBeGreaterThan(0);

    const snap = new Int32Array(snapshotInts(cfg));
    writeSnapshot(st, snap);
    const st2 = createGameState(cfg);
    readSnapshot(st2, snap);
    expect(hashState(st2)).toBe(hashState(st));
    for (let i = 0; i < 120; i++) {
      stepSim(st, [BTN_ACCEL, 0]);
      stepSim(st2, [BTN_ACCEL, 0]);
    }
    expect(hashState(st2)).toBe(hashState(st));
  });
});
