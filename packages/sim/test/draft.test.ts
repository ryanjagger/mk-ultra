/**
 * Slipstream: charge a tow in a leader's wake, slingshot on swinging out.
 * Synthetic rect track, two karts placed in line on the bottom straight.
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
  BTN_LEFT,
  DRAFT_CHARGE_TICKS,
  DRAFT_BURST_TICKS,
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

// long, wide rectangle so two karts can run a straight side by side or in line
const DEF: TrackDef = {
  id: 'test-draft',
  name: 'Test Draft',
  verts: [
    { x: -120, y: -20, w: 9 },
    { x: 0, y: -20, w: 9 },
    { x: 120, y: -20, w: 9 },
    { x: 120, y: 20, w: 9 },
    { x: 0, y: 20, w: 9 },
    { x: -120, y: 20, w: 9 },
  ],
  checkpointVerts: [0, 2, 3, 5],
  itemVerts: [],
  boostPads: [],
  spawns: [
    [-100, -22, 0],
    [-100, -18, 0],
    [-104, -22, 0],
    [-104, -18, 0],
  ],
  theme: THEME,
};

function mkState(track: TrackRuntime, players: number): GameState {
  const base = createGameState({ seed: 7, lapCount: 3, playerCount: players });
  const st: GameState = { ...base, track, items: track.itemSpawns.map(() => 0) };
  st.tick = COUNTDOWN_TICKS;
  return st;
}

const track = buildTrack(DEF);

/** Two karts eastbound on the straight; follower offset (dx behind, dy lateral). */
function pair(dx: number, dy: number): GameState {
  const st = mkState(track, 2);
  const lead = st.karts[0]!;
  lead.x = fxConst(-80);
  lead.y = fxConst(-20);
  lead.heading = 0;
  const tail = st.karts[1]!;
  tail.x = fxConst(-80 - dx);
  tail.y = fxConst(-20 + dy);
  tail.heading = 0;
  return st;
}

describe('slipstream', () => {
  it('charges in the wake, not when offset laterally', () => {
    const inline = pair(3, 0);
    const offset = pair(3, 3);
    // ~55 ticks to reach drafting speed from rest, then the wake charges
    for (let i = 0; i < 150; i++) {
      stepSim(inline, [BTN_ACCEL, BTN_ACCEL]);
      stepSim(offset, [BTN_ACCEL, BTN_ACCEL]);
    }
    expect(inline.karts[1]!.draftTicks).toBeGreaterThan(DRAFT_CHARGE_TICKS);
    expect(offset.karts[1]!.draftTicks).toBe(0);
  });

  it('a towing kart closes the gap on an identical leader', () => {
    const st = pair(3, 0);
    const gap0 = fxToFloat(st.karts[0]!.x) - fxToFloat(st.karts[1]!.x);
    for (let i = 0; i < 240; i++) stepSim(st, [BTN_ACCEL, BTN_ACCEL]);
    const gap1 = fxToFloat(st.karts[0]!.x) - fxToFloat(st.karts[1]!.x);
    expect(gap1).toBeLessThan(gap0 - 0.5);
  });

  it('swinging out of a charged wake fires the slingshot burst', () => {
    const st = pair(3, 0);
    for (let i = 0; i < 150; i++) stepSim(st, [BTN_ACCEL, BTN_ACCEL]);
    expect(st.karts[1]!.draftTicks).toBeGreaterThan(DRAFT_CHARGE_TICKS);
    // steer hard left until the wake is lost
    let burst = 0;
    for (let i = 0; i < 40 && burst === 0; i++) {
      stepSim(st, [BTN_ACCEL, BTN_ACCEL | BTN_LEFT]);
      burst = st.karts[1]!.draftTicks === 0 ? st.karts[1]!.boostTicks : 0;
    }
    expect(burst).toBeGreaterThan(DRAFT_BURST_TICKS - 10);
  });

  it('is deterministic across identical runs', () => {
    const run = () => {
      const st = pair(2.5, 0.5);
      for (let i = 0; i < 300; i++) stepSim(st, [BTN_ACCEL, BTN_ACCEL]);
      return st.karts.map((k) => [k.x, k.y, k.vx, k.vy, k.draftTicks, k.boostTicks]).flat();
    };
    expect(run()).toEqual(run());
  });
});
