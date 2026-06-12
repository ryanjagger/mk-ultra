/**
 * Verified time-trial leaderboards. A submission is an input recording; the
 * server replays it through the deterministic sim (the one place the server
 * DOES simulate — offline verification, never live relay) and stores the
 * time the sim says, not the time the client claims. Cheat-proof by
 * determinism: a forged time would need a forged input stream that actually
 * drives that fast.
 *
 * Storage is one JSON file under DATA_DIR (mount a volume in production);
 * top N entries per (trackId, laps), best run per name.
 */
import {
  createGameState,
  stepSim,
  isTrackId,
  PHASE_FINISHED,
  COUNTDOWN_TICKS,
  MAX_RACE_TICKS,
  TICK_RATE,
} from '@mk/sim';
import { decodeRle, TT_SEED, type LeaderboardEntry } from '@mk/shared';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Rle = [number, number][];

interface StoredEntry {
  name: string;
  timeMs: number;
  rle: Rle;
}

const TOP_N = 10;

export class Leaderboards {
  private boards = new Map<string, StoredEntry[]>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'leaderboards.json');
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredEntry[]>;
        for (const [k, v] of Object.entries(raw)) this.boards.set(k, v);
        console.log(`leaderboards: loaded ${this.boards.size} boards from ${this.file}`);
      }
    } catch (err) {
      console.error('leaderboards: failed to load, starting empty', err);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.boards)));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('leaderboards: persist failed', err);
    }
  }

  /**
   * Re-simulate a run; the verified time in ms, or null if it never crossed
   * the line (or the inputs ran out long before it did).
   */
  verify(trackId: string, laps: number, rle: Rle): number | null {
    if (!isTrackId(trackId)) return null;
    const inputs = decodeRle(rle);
    if (inputs.length === 0 || inputs.length > COUNTDOWN_TICKS + MAX_RACE_TICKS) return null;
    const st = createGameState({ seed: TT_SEED, lapCount: laps, playerCount: 1, trackId });
    const maxTick = inputs.length + TICK_RATE; // small grace to coast over the line
    while (st.phase !== PHASE_FINISHED && st.tick < maxTick) {
      stepSim(st, [inputs[st.tick] ?? 0]);
    }
    const ft = st.karts[0]!.finishTick;
    if (st.phase !== PHASE_FINISHED || ft < 0) return null;
    return Math.round(((ft - COUNTDOWN_TICKS) / TICK_RATE) * 1000);
  }

  /**
   * Verify and record a run. Returns the rank (0-based) the run holds after
   * insertion, -1 if verified but off the board, or null if rejected.
   */
  submit(name: string, trackId: string, laps: number, rle: Rle): number | null {
    const timeMs = this.verify(trackId, laps, rle);
    if (timeMs === null) return null;
    const key = `${trackId}:${laps}`;
    const board = this.boards.get(key) ?? [];
    const mine = board.findIndex((e) => e.name === name);
    if (mine >= 0) {
      if (board[mine]!.timeMs <= timeMs) {
        // an equal or better run already stands — report where it sits
        return mine;
      }
      board.splice(mine, 1);
    }
    board.push({ name, timeMs, rle });
    board.sort((a, b) => a.timeMs - b.timeMs || a.name.localeCompare(b.name));
    const rank = board.findIndex((e) => e.name === name && e.timeMs === timeMs);
    if (board.length > TOP_N) board.length = TOP_N;
    this.boards.set(key, board);
    this.persist();
    return rank < TOP_N ? rank : -1;
  }

  top(trackId: string, laps: number): LeaderboardEntry[] {
    const board = this.boards.get(`${trackId}:${laps}`) ?? [];
    return board.map((e) => ({ name: e.name, timeMs: e.timeMs }));
  }

  ghost(trackId: string, laps: number, rank: number): StoredEntry | null {
    return this.boards.get(`${trackId}:${laps}`)?.[rank] ?? null;
  }
}
