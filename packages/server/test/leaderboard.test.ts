/**
 * Verified leaderboards: the server replays submitted inputs through the sim
 * and stores the time the sim computed. Legit runs (generated here by the
 * in-sim bot) verify; fabricated input streams that never finish are
 * rejected; boards keep the best run per name and persist to disk.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGameState,
  stepSim,
  botMask,
  PHASE_FINISHED,
  COUNTDOWN_TICKS,
  MAX_RACE_TICKS,
  TICK_RATE,
  BTN_ACCEL,
} from '@mk/sim';
import { encodeRle, DEFAULT_STYLE, TT_SEED, type ServerMsg } from '@mk/shared';
import { Leaderboards } from '../src/leaderboard.js';

type ReplayMsg = Extract<ServerMsg, { t: 'replay' }>;

/**
 * A legitimate finished run, as the client would submit it. `hesitate` drops
 * the throttle for that many ticks after GO — a genuinely slower run (input
 * streams are closed-loop recordings; they cannot simply be time-shifted).
 */
function botRun(trackId: string, hesitate = 0): { rle: [number, number][]; timeMs: number } {
  const st = createGameState({ seed: TT_SEED, lapCount: 1, playerCount: 1, trackId });
  const recorded: number[] = [];
  while (st.phase !== PHASE_FINISHED && st.tick < 60 * 240) {
    let mask = botMask(st, 0);
    if (st.tick >= COUNTDOWN_TICKS && st.tick < COUNTDOWN_TICKS + hesitate) mask &= ~BTN_ACCEL;
    recorded.push(mask);
    stepSim(st, [mask]);
  }
  const ft = st.karts[0]!.finishTick;
  expect(ft).toBeGreaterThan(0);
  return {
    rle: encodeRle(recorded.slice(0, ft)),
    timeMs: Math.round(((ft - COUNTDOWN_TICKS) / TICK_RATE) * 1000),
  };
}

/** Per-kart driving behaviour for the multi-kart race recording. */
type DriveMode = 'drive' | 'hesitate' | 'still';

/**
 * Drive a whole field together (the multi-kart generalization of botRun) and
 * return each kart's recorded input stream plus its finish tick. Karts interact
 * (collisions, items), so this is a real race — not N independent runs glued
 * together. A 'still' kart never accelerates and ends DNF; the race then closes
 * STRAGGLER_TICKS after the leader, exactly as a real relayed race would.
 */
function botRace(
  trackId: string,
  laps: number,
  modes: DriveMode[],
): { streams: number[][]; finishTicks: number[] } {
  const seed = 0xc0ffee;
  const st = createGameState({ seed, lapCount: laps, playerCount: modes.length, trackId });
  const streams: number[][] = modes.map(() => []);
  const cap = COUNTDOWN_TICKS + MAX_RACE_TICKS;
  while (st.phase !== PHASE_FINISHED && st.tick < cap) {
    const masks = modes.map((mode, k) => {
      if (mode === 'still') return 0; // sits on the grid forever → DNF
      let mask = botMask(st, k);
      if (mode === 'hesitate' && st.tick >= COUNTDOWN_TICKS && st.tick < COUNTDOWN_TICKS + 90) {
        mask &= ~BTN_ACCEL; // 1.5s of hesitation after GO — a slower legit run
      }
      return mask;
    });
    masks.forEach((m, k) => streams[k]!.push(m));
    stepSim(st, masks);
  }
  return { streams, finishTicks: st.karts.map((k) => k.finishTick) };
}

describe('race leaderboards', () => {
  it('records every human finisher from a replay, excluding bots and DNFs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mk-lb-'));
    const lb = new Leaderboards(dir);
    const trackId = 'sunny-circuit';
    const laps = 1;
    // seats: 2 racing humans, 1 racing bot, 1 human who never moves (DNF)
    const modes: DriveMode[] = ['drive', 'hesitate', 'drive', 'still'];
    const players = ['alice', 'bob', 'CPU 1', 'dave'];
    const bots = [false, false, true, false];
    const { streams, finishTicks } = botRace(trackId, laps, modes);

    // scenario sanity: the racers (incl. the bot) finished, the still kart DNF'd
    expect(finishTicks[0]).toBeGreaterThan(0);
    expect(finishTicks[1]).toBeGreaterThan(0);
    expect(finishTicks[2]).toBeGreaterThan(0); // the bot DID finish — but is excluded
    expect(finishTicks[3]).toBe(-1); // DNF

    const replay: ReplayMsg = {
      t: 'replay',
      seed: 0xc0ffee,
      laps,
      mode: 'race',
      trackId,
      players,
      styles: players.map(() => DEFAULT_STYLE),
      bots,
      inputs: streams.map((s) => encodeRle(s)),
    };
    lb.recordRace(replay);

    const board = lb.top(trackId, laps, 'race');
    // only the two racing humans land on the board — bot and DNF excluded
    expect(board.map((e) => e.name).sort()).toEqual(['alice', 'bob']);
    expect(board.every((e) => e.timeMs > 0)).toBe(true);
    // sorted fastest-first, and the times match the re-simulated finish ticks
    expect(board[0]!.timeMs).toBeLessThanOrEqual(board[1]!.timeMs);
    const human = (name: string, tick: number) =>
      expect(board.find((e) => e.name === name)!.timeMs).toBe(
        Math.round(((tick - COUNTDOWN_TICKS) / TICK_RATE) * 1000),
      );
    human('alice', finishTicks[0]!);
    human('bob', finishTicks[1]!);

    // the TT board for the same track/laps is untouched (separate key prefix)
    expect(lb.top(trackId, laps, 'tt')).toEqual([]);

    // persistence: a fresh instance reloads the race board from disk
    const lb2 = new Leaderboards(dir);
    expect(lb2.top(trackId, laps, 'race')).toEqual(board);
  });

  it('skips battles and unknown tracks', () => {
    const lb = new Leaderboards(mkdtempSync(join(tmpdir(), 'mk-lb-')));
    const { streams } = botRace('sunny-circuit', 1, ['drive']);
    const base: ReplayMsg = {
      t: 'replay',
      seed: 0xc0ffee,
      laps: 1,
      mode: 'race',
      trackId: 'sunny-circuit',
      players: ['alice'],
      styles: [DEFAULT_STYLE],
      bots: [false],
      inputs: streams.map((s) => encodeRle(s)),
    };
    lb.recordRace({ ...base, mode: 'battle' });
    lb.recordRace({ ...base, trackId: 'nope' });
    expect(lb.top('sunny-circuit', 1, 'race')).toEqual([]);
    expect(lb.top('nope', 1, 'race')).toEqual([]);
  });

  it("re-simulates server CPU seats via bot flags, recording the human's true time", () => {
    const lb = new Leaderboards(mkdtempSync(join(tmpdir(), 'mk-lb-')));
    const trackId = 'sunny-circuit';
    const laps = 1;
    const seed = 0xabcde;
    const bots = [false, true]; // seat 0 human, seat 1 server CPU
    // Drive the live race: the human via the greedy bot, the CPU driven by the
    // sim itself (bots[1]). The CPU's relayed input log is empty on the server,
    // so its replay stream is neutral — exactly what we reconstruct below.
    const st = createGameState({ seed, lapCount: laps, playerCount: 2, trackId, bots });
    const human: number[] = [];
    const cap = COUNTDOWN_TICKS + MAX_RACE_TICKS;
    while (st.phase !== PHASE_FINISHED && st.tick < cap) {
      const h = botMask(st, 0);
      human.push(h);
      stepSim(st, [h, 0]); // CPU input ignored (bots[1]); botMask drives it
    }
    const humanFinish = st.karts[0]!.finishTick;
    expect(humanFinish).toBeGreaterThan(0);
    expect(st.karts[1]!.finishTick).toBeGreaterThan(0); // the CPU finished too

    const replay: ReplayMsg = {
      t: 'replay',
      seed,
      laps,
      mode: 'race',
      trackId,
      players: ['alice', 'CPU 1'],
      styles: [DEFAULT_STYLE, DEFAULT_STYLE],
      bots,
      inputs: [encodeRle(human), encodeRle([])], // CPU log empty, as the server builds it
    };
    lb.recordRace(replay);

    const board = lb.top(trackId, laps, 'race');
    expect(board.map((e) => e.name)).toEqual(['alice']); // CPU excluded
    // the recorded time matches the bots-driven finish — proving the re-sim
    // reproduced the live race. Without passing `bots`, the CPU would sit still
    // and alice's interactions (and finish tick) would diverge.
    expect(board[0]!.timeMs).toBe(Math.round(((humanFinish - COUNTDOWN_TICKS) / TICK_RATE) * 1000));
  });

  it('excludes human seats a client declared automated (?bot)', () => {
    const lb = new Leaderboards(mkdtempSync(join(tmpdir(), 'mk-lb-')));
    const trackId = 'sunny-circuit';
    const laps = 1;
    const { streams, finishTicks } = botRace(trackId, laps, ['drive', 'drive']);
    expect(finishTicks[0]).toBeGreaterThan(0);
    expect(finishTicks[1]).toBeGreaterThan(0); // both real human seats finished

    const replay: ReplayMsg = {
      t: 'replay',
      seed: 0xc0ffee,
      laps,
      mode: 'race',
      trackId,
      players: ['alice', 'bot-bob'],
      styles: [DEFAULT_STYLE, DEFAULT_STYLE],
      bots: [false, false],
      inputs: streams.map((s) => encodeRle(s)),
    };
    // seat 1 declared itself automated — excluded even though it finished
    lb.recordRace(replay, [false, true]);
    expect(lb.top(trackId, laps, 'race').map((e) => e.name)).toEqual(['alice']);
  });
});

describe('verified leaderboards', () => {
  it('accepts a real run with the sim-computed time, rejects fabrications', () => {
    const lb = new Leaderboards(mkdtempSync(join(tmpdir(), 'mk-lb-')));
    const run = botRun('sunny-circuit');

    const rank = lb.submit('alice', 'sunny-circuit', 1, run.rle);
    expect(rank).toBe(0);
    const top = lb.top('sunny-circuit', 1);
    expect(top).toEqual([{ name: 'alice', timeMs: run.timeMs }]);

    // a forged stream that just holds accel into the first wall never finishes
    expect(lb.submit('mallory', 'sunny-circuit', 1, [[BTN_ACCEL, 600]])).toBeNull();
    // unknown tracks are rejected outright
    expect(lb.submit('mallory', 'nope', 1, run.rle)).toBeNull();
    // a run submitted for the wrong lap count fails verification
    expect(lb.submit('mallory', 'sunny-circuit', 3, run.rle)).toBeNull();
    expect(lb.top('sunny-circuit', 1)).toHaveLength(1);
  });

  it('keeps the best run per name and ranks rivals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mk-lb-'));
    const lb = new Leaderboards(dir);
    const run = botRun('sunny-circuit');
    // a slower legit run: sit still for 1.5s after GO, then drive
    const slow = botRun('sunny-circuit', 90);
    expect(slow.timeMs).toBeGreaterThan(run.timeMs);

    expect(lb.submit('alice', 'sunny-circuit', 1, slow.rle)).toBe(0);
    expect(lb.submit('bob', 'sunny-circuit', 1, run.rle)).toBe(0); // bob is faster
    expect(lb.top('sunny-circuit', 1).map((e) => e.name)).toEqual(['bob', 'alice']);

    // alice improves and retakes the lead
    expect(lb.submit('alice', 'sunny-circuit', 1, run.rle)).toBe(0);
    const top = lb.top('sunny-circuit', 1);
    expect(top[0]!.name).toBe('alice'); // ties break alphabetically
    expect(top).toHaveLength(2);

    // resubmitting a worse run does not regress the stored best
    expect(lb.submit('alice', 'sunny-circuit', 1, slow.rle)).toBe(0);
    expect(lb.top('sunny-circuit', 1)[0]!.timeMs).toBe(run.timeMs);

    // ghosts come back with the stored inputs
    const ghost = lb.ghost('sunny-circuit', 1, 0);
    expect(ghost?.name).toBe('alice');
    expect(ghost?.rle).toEqual(run.rle);

    // persistence: a fresh instance reads the same boards
    const lb2 = new Leaderboards(dir);
    expect(lb2.top('sunny-circuit', 1)).toEqual(lb.top('sunny-circuit', 1));
  });
});
