/**
 * Verified leaderboards. Two kinds share one store:
 *
 *  - Time trial: a submission is an input recording; the server replays it
 *    through the deterministic sim (the one place the server DOES simulate —
 *    offline verification, never live relay) and stores the time the sim says,
 *    not the time the client claims. Cheat-proof by determinism: a forged time
 *    would need a forged input stream that actually drives that fast.
 *  - Online race: nobody submits anything. The server already builds a
 *    canonical replay of each finished race from its own first-write-wins input
 *    logs, so it re-simulates that replay itself and reads each human's
 *    finishTick — same no-client-trust property, no new wire surface, no sim
 *    changes. Race seeds are random per race, so race times include item luck;
 *    that is inherent to a race board.
 *
 * Storage is one JSON file under DATA_DIR (mount a volume in production);
 * top N entries per board, best run per name. Race boards live under a
 * `race:` key prefix in the same Map/file — TT keys load unchanged.
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
import { decodeRle, TT_SEED, type LeaderboardEntry, type ServerMsg } from '@mk/shared';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Rle = [number, number][];

/** The canonical replay the server builds at endRace (config + per-kart inputs). */
type ReplayMsg = Extract<ServerMsg, { t: 'replay' }>;

/** Which board: time-trial (the original) or online-race. */
export type BoardKind = 'tt' | 'race';

interface StoredEntry {
  name: string;
  timeMs: number;
  /** TT ghost recording; race entries have no single-kart stream, so optional */
  rle?: Rle;
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
   * Insert a finished time into a board, keeping the best run per name. Returns
   * the rank (0-based) the run holds after insertion, or -1 if it landed off
   * the board (beyond TOP_N).
   */
  private insert(key: string, name: string, timeMs: number, rle?: Rle): number {
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

  /**
   * Verify and record a time-trial run. Returns the rank (0-based) the run
   * holds after insertion, -1 if verified but off the board, or null if
   * rejected (failed verification).
   */
  submit(name: string, trackId: string, laps: number, rle: Rle): number | null {
    const timeMs = this.verify(trackId, laps, rle);
    if (timeMs === null) return null;
    return this.insert(`${trackId}:${laps}`, name, timeMs, rle);
  }

  /**
   * Record an online race from the server's own canonical replay. Re-simulates
   * the whole field (this is the generalization of single-kart verify() to N
   * karts) and records the verified finish time of every human who crossed the
   * line. Bots and DNFs are skipped. No-op for battles or unknown tracks.
   *
   * The re-sim MUST carry the replay's `bots` flags: server-built replays have
   * empty input logs for CPU seats (bots never relay input), so the sim drives
   * those karts from `cfg.bots` via botMask — exactly as every live client did.
   * Omitting them would replay CPUs as stationary and corrupt human finish ticks.
   *
   * `automated[i]` marks a *human* seat a client declared as self-driving
   * (`?bot` mode); those are excluded too. This only stops clients that honestly
   * identify — a relay carrying only inputs can't tell a scripted human from a
   * real one, the same inherent limit the TT board has.
   */
  recordRace(replay: ReplayMsg, automated: readonly boolean[] = []): void {
    const { seed, laps, trackId, mode, players, bots, inputs } = replay;
    if (mode === 'battle' || !isTrackId(trackId)) return;
    const kartCount = inputs.length;
    const streams = inputs.map((rle) => decodeRle(rle));
    const st = createGameState({ seed, lapCount: laps, playerCount: kartCount, trackId, mode, bots });
    const longest = streams.reduce((m, s) => Math.max(m, s.length), 0);
    // small grace to coast over the line, hard-bounded like verify()
    const maxTick = Math.min(longest + TICK_RATE, COUNTDOWN_TICKS + MAX_RACE_TICKS);
    while (st.phase !== PHASE_FINISHED && st.tick < maxTick) {
      stepSim(st, streams.map((s) => s[st.tick] ?? 0));
    }
    for (let i = 0; i < kartCount; i++) {
      if (bots[i] || automated[i]) continue;
      const ft = st.karts[i]!.finishTick;
      if (ft < 0) continue; // DNF
      const timeMs = Math.round(((ft - COUNTDOWN_TICKS) / TICK_RATE) * 1000);
      this.insert(`race:${trackId}:${laps}`, players[i]!, timeMs);
    }
  }

  top(trackId: string, laps: number, kind: BoardKind = 'tt'): LeaderboardEntry[] {
    const key = kind === 'race' ? `race:${trackId}:${laps}` : `${trackId}:${laps}`;
    const board = this.boards.get(key) ?? [];
    return board.map((e) => ({ name: e.name, timeMs: e.timeMs }));
  }

  ghost(trackId: string, laps: number, rank: number): StoredEntry | null {
    return this.boards.get(`${trackId}:${laps}`)?.[rank] ?? null;
  }
}
