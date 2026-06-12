/**
 * Battle mode: balloons, elimination via finishTick, last-kart-standing
 * phase end, balloon-ranked placements, and laps staying out of it.
 */
import { describe, it, expect } from 'vitest';
import {
  createGameState,
  stepSim,
  computePlacements,
  COUNTDOWN_TICKS,
  PHASE_FINISHED,
  BATTLE_BALLOONS,
  INPUT_NEUTRAL,
  type GameState,
} from '../src/index.js';
import { spinOut } from '../src/items.js';

function mkBattle(players: number): GameState {
  const st = createGameState({
    seed: 9,
    lapCount: 3,
    playerCount: players,
    trackId: 'colosseum',
    mode: 'battle',
  });
  st.tick = COUNTDOWN_TICKS; // straight to the brawl
  return st;
}

describe('battle mode', () => {
  it('karts start with balloons; race mode karts have none', () => {
    const battle = mkBattle(4);
    for (const k of battle.karts) expect(k.balloons).toBe(BATTLE_BALLOONS);
    const race = createGameState({ seed: 9, lapCount: 3, playerCount: 4 });
    for (const k of race.karts) expect(k.balloons).toBe(0);
  });

  it('each spin pops a balloon; the last one eliminates', () => {
    const st = mkBattle(2);
    const kart = st.karts[1]!;
    for (let hit = 1; hit <= BATTLE_BALLOONS; hit++) {
      kart.spinTicks = 0; // hits land between recoveries
      spinOut(st, kart);
      expect(kart.balloons).toBe(BATTLE_BALLOONS - hit);
    }
    expect(kart.finishTick).toBe(st.tick);
    // further spins don't underflow
    kart.spinTicks = 0;
    spinOut(st, kart);
    expect(kart.balloons).toBe(0);
  });

  it('race-mode spins never touch finishTick', () => {
    const st = createGameState({ seed: 9, lapCount: 3, playerCount: 2 });
    st.tick = COUNTDOWN_TICKS;
    const kart = st.karts[1]!;
    for (let i = 0; i < 5; i++) {
      kart.spinTicks = 0;
      spinOut(st, kart);
    }
    expect(kart.finishTick).toBe(-1);
  });

  it('last kart standing ends the battle and places first', () => {
    const st = mkBattle(3);
    for (const idx of [1, 2]) {
      const kart = st.karts[idx]!;
      for (let hit = 0; hit < BATTLE_BALLOONS; hit++) {
        kart.spinTicks = 0;
        spinOut(st, kart);
      }
    }
    stepSim(st, [INPUT_NEUTRAL, INPUT_NEUTRAL, INPUT_NEUTRAL]);
    expect(st.phase).toBe(PHASE_FINISHED);
    const placements = computePlacements(st);
    expect(placements[0]).toBe(0); // the survivor
  });

  it('placements rank by balloons, then survival time', () => {
    const st = mkBattle(4);
    st.karts[0]!.balloons = 3;
    st.karts[1]!.balloons = 1;
    // 2 and 3 eliminated; 3 lasted longer
    st.karts[2]!.balloons = 0;
    st.karts[2]!.finishTick = 500;
    st.karts[3]!.balloons = 0;
    st.karts[3]!.finishTick = 900;
    expect(computePlacements(st)).toEqual([0, 1, 3, 2]);
  });

  it('battle bots hunt and the brawl resolves before the time cap', () => {
    const st = createGameState({
      seed: 123,
      lapCount: 3,
      playerCount: 4,
      trackId: 'mesa-drop',
      mode: 'battle',
      bots: [true, true, true, true],
    });
    let spins = 0;
    const prevSpin = [0, 0, 0, 0];
    for (let t = 0; t < COUNTDOWN_TICKS + 9000 && st.phase !== PHASE_FINISHED; t++) {
      stepSim(st, [0, 0, 0, 0]); // bot masks come from state, not the wire
      st.karts.forEach((k, i) => {
        if (k.spinTicks > 0 && prevSpin[i] === 0) spins += 1;
        prevSpin[i] = k.spinTicks;
      });
    }
    expect(st.phase).toBe(PHASE_FINISHED);
    expect(spins).toBeGreaterThan(3); // an actual fight happened
    const alive = st.karts.filter((k) => k.finishTick < 0);
    expect(alive.length).toBeLessThanOrEqual(1); // last kart standing, not timeout
  });

  it('gates do not count laps in battle', () => {
    const st = mkBattle(1);
    const kart = st.karts[0]!;
    // park right before the start gate and drive through it
    kart.x = st.track.gates[1]!.cx;
    kart.y = st.track.gates[1]!.cy;
    const lap0 = kart.lap;
    const cp0 = kart.nextCp;
    for (let i = 0; i < 120; i++) stepSim(st, [1]); // accel forward
    expect(kart.lap).toBe(lap0);
    expect(kart.nextCp).toBe(cp0);
  });
});
