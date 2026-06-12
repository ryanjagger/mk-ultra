/**
 * Headless bot fleet: N real clients over real WebSockets, each with its own
 * simulated link (lag/jitter), racing through the actual relay — local or
 * production. Turns "feels stuttery" into numbers: per-client stalls,
 * rollbacks and confirmation-lag percentiles, plus a cross-client
 * finish-tick identity check. Exits non-zero on desync, divergence, a dead
 * client or timeout, so it can gate CI.
 *
 *   pnpm --filter @mk/server fleet                                  # 2 clean clients, localhost
 *   pnpm --filter @mk/server fleet -- --lags 20,90,90,250 --jitters 0,30,30,60
 *   pnpm --filter @mk/server fleet -- --url wss://mk-ultra-production.up.railway.app --lags 0,180
 *
 * The pacing loop MIRRORS RaceController.update() in
 * packages/client/src/game.ts (wall-clock target, >120-frame rebase, slewed
 * catch-up, redundant input send, bounded stall pre-send) — keep them in
 * sync when the netcode pacing changes.
 */
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import {
  RollbackSession,
  TICK_RATE,
  COUNTDOWN_TICKS,
  PHASE_FINISHED,
  botMask,
  computePlacements,
  type RaceConfig,
} from '@mk/sim';
import {
  parseServerMsg,
  HASH_INTERVAL,
  INPUT_REDUNDANCY,
  type ClientMsg,
  type ServerMsg,
} from '@mk/shared';

const UPDATE_MS = 16; // ~browser RAF cadence, keeps stall counts comparable

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

/** Same shape as the browser ClockSync: median offset over ping/pong pairs. */
class Clock {
  private offsets: number[] = [];
  rttMs = 0;

  onPong(pt: number, serverNow: number): void {
    const now = Date.now();
    const rtt = now - pt;
    if (rtt < 0 || rtt > 5000) return;
    this.rttMs = rtt;
    this.offsets.push(serverNow + rtt / 2 - now);
    if (this.offsets.length > 9) this.offsets.shift();
  }

  serverNow(): number {
    if (this.offsets.length === 0) return Date.now();
    const sorted = [...this.offsets].sort((a, b) => a - b);
    return Date.now() + sorted[Math.floor(sorted.length / 2)]!;
  }
}

/**
 * FIFO link delay, half the configured RTT per direction. Deadlines are
 * monotonic per direction so a delayed message holds back those behind it
 * (TCP head-of-line behavior), never reorders.
 */
class DelayLink {
  private readonly lastAt = [0, 0];
  private readonly halfLagMs: number;
  private readonly halfJitterMs: number;

  // plain field assignment: parameter properties are not erasable syntax,
  // and this file runs under node --experimental-strip-types
  constructor(halfLagMs: number, halfJitterMs: number) {
    this.halfLagMs = halfLagMs;
    this.halfJitterMs = halfJitterMs;
  }

  delay(dir: 0 | 1, fn: () => void): void {
    if (this.halfLagMs <= 0 && this.halfJitterMs <= 0) {
      fn();
      return;
    }
    const jitter = (Math.random() * 2 - 1) * this.halfJitterMs;
    const at = Math.max(Date.now() + Math.max(0, this.halfLagMs + jitter), this.lastAt[dir]!);
    this.lastAt[dir] = at;
    setTimeout(fn, Math.max(0, at - Date.now()));
  }
}

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type RaceStartMsg = Extract<ServerMsg, { t: 'raceStart' }>;

class FleetClient {
  readonly name: string;
  readonly lagMs: number;
  readonly jitterMs: number;

  room: RoomMsg | null = null;
  raceStart: RaceStartMsg | null = null;
  session: RollbackSession | null = null;
  you = -1;
  desyncs: number[] = [];
  errors: string[] = [];
  dead = false;
  raceEnded = false;
  lagSamples: number[] = [];

  private ws: WebSocket;
  private link: DelayLink;
  private clock = new Clock();
  private startAtMs = 0;
  private prevTarget = 0;
  private lastInputFrame = -1;
  private recentMasks: number[] = [];
  private nextHashFrame = HASH_INTERVAL;
  private timers: NodeJS.Timeout[] = [];
  readonly opened: Promise<void>;

  constructor(url: string, name: string, lagMs: number, jitterMs: number) {
    this.name = name;
    this.lagMs = lagMs;
    this.jitterMs = jitterMs;
    this.link = new DelayLink(lagMs / 2, jitterMs / 2);
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => {
      const raw = data.toString();
      this.link.delay(0, () => this.handle(raw));
    });
    this.ws.on('close', () => {
      this.dead = this.dead || !this.raceEnded;
      this.stopTimers();
    });
    this.ws.on('error', () => {
      this.dead = true;
    });
    this.timers.push(
      setInterval(() => this.send({ t: 'ping', pt: Date.now() }), 2000),
    );
  }

  send(msg: ClientMsg): void {
    this.link.delay(1, () => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    });
  }

  rtt(): number {
    return this.clock.rttMs;
  }

  private handle(raw: string): void {
    const msg = parseServerMsg(raw);
    if (!msg) {
      this.errors.push(`invalid server message: ${raw.slice(0, 80)}`);
      return;
    }
    switch (msg.t) {
      case 'room':
        this.room = msg;
        break;
      case 'raceStart': {
        this.raceStart = msg;
        this.you = msg.you;
        this.startAtMs = msg.startAtMs;
        const cfg: RaceConfig = {
          seed: msg.seed,
          lapCount: msg.laps,
          playerCount: msg.players.length,
          trackId: msg.trackId,
          mode: msg.mode,
          bots: msg.bots,
        };
        this.session = new RollbackSession(cfg, msg.you);
        this.timers.push(setInterval(() => this.update(), UPDATE_MS));
        break;
      }
      case 'input': {
        const s = this.session;
        if (!s) {
          this.errors.push(`input for frame ${msg.f} arrived before raceStart`);
          break;
        }
        if (msg.p === this.you) break;
        s.addInput(msg.p, msg.f, msg.m);
        if (msg.r) {
          for (let i = 0; i < msg.r.length; i++) {
            const rf = msg.f - 1 - i;
            if (rf < 0) break;
            s.addInput(msg.p, rf, msg.r[i]!);
          }
        }
        break;
      }
      case 'dropped':
        this.session?.dropPlayer(msg.p, msg.fromFrame);
        break;
      case 'desync':
        this.desyncs.push(msg.frame);
        break;
      case 'pong':
        this.clock.onPong(msg.pt, msg.now);
        break;
      case 'error':
        this.errors.push(msg.message);
        break;
      default:
        break;
    }
  }

  /** Mirror of RaceController.update() — see the file header. */
  private update(): void {
    const s = this.session!;
    if (this.raceEnded) return;
    const elapsedMs = this.clock.serverNow() - this.startAtMs;
    if (elapsedMs < 0) return;
    let target = Math.floor((elapsedMs / 1000) * TICK_RATE);
    if (target - s.frame > 120) {
      const skip = target - s.frame - 30;
      this.startAtMs += (skip / TICK_RATE) * 1000;
      target = s.frame + 30;
    }
    const span = target - this.prevTarget;
    this.prevTarget = target;
    const maxAdvances = Math.min(30, Math.max(1, span) + 2);
    let advances = 0;
    while (s.frame < target && advances < maxAdvances) {
      const f = s.frame;
      if (f > this.lastInputFrame) this.sendInput(f, botMask(s.state, this.you));
      if (!s.advance()) {
        const limit = Math.min(target - 1, s.frame + s.maxPrediction);
        while (this.lastInputFrame < limit) {
          this.sendInput(this.lastInputFrame + 1, botMask(s.state, this.you));
        }
        break;
      }
      advances++;
    }
    s.applyCorrections();
    this.sendHashes();
    this.lagSamples.push(s.frame - Math.min(s.confirmedFrame(), s.frame));
    if (s.state.phase === PHASE_FINISHED && !this.raceEnded) {
      this.raceEnded = true;
      this.send({ t: 'raceEnded', placements: computePlacements(s.state) });
    }
  }

  private sendInput(f: number, mask: number): void {
    const s = this.session!;
    s.addInput(this.you, f, mask);
    if (this.recentMasks.length > 0) {
      this.send({ t: 'input', f, m: mask, r: this.recentMasks.slice() });
    } else {
      this.send({ t: 'input', f, m: mask });
    }
    this.recentMasks.unshift(mask);
    if (this.recentMasks.length > INPUT_REDUNDANCY) this.recentMasks.pop();
    this.lastInputFrame = f;
  }

  private sendHashes(): void {
    const s = this.session!;
    const confirmedState = Math.min(s.confirmedFrame() + 1, s.frame);
    while (this.nextHashFrame <= confirmedState) {
      const h = s.confirmedHash(this.nextHashFrame);
      if (h !== null) this.send({ t: 'hash', f: this.nextHashFrame, h });
      this.nextHashFrame += HASH_INTERVAL;
    }
  }

  stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  close(): void {
    this.stopTimers();
    this.ws.close();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function fmtTime(ticks: number): string {
  const sec = Math.max(0, ticks - COUNTDOWN_TICKS) / TICK_RATE;
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(2).padStart(5, '0')}`;
}

function normalizeUrl(url: string): string {
  let u = url.replace(/^http/, 'ws');
  if (!/^wss?:\/\//.test(u)) u = `ws://${u}`;
  if (!new URL(u).pathname.replace(/\/$/, '')) u = u.replace(/\/$/, '') + '/ws';
  return u;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift(); // pnpm forwards the separator itself
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string', default: 'ws://localhost:8080/ws' },
      lags: { type: 'string', default: '0,0' },
      jitters: { type: 'string', default: '' },
      laps: { type: 'string', default: '2' },
      track: { type: 'string', default: 'random' },
    },
  });
  const url = normalizeUrl(values.url!);
  const lags = values.lags!.split(',').map((s) => Math.max(0, Number(s) || 0));
  const jitters = values.jitters!
    .split(',')
    .map((s) => Math.max(0, Number(s) || 0));
  const laps = Math.max(1, Number(values.laps) || 2);
  if (lags.length < 2 || lags.length > 4) {
    console.error('need 2-4 clients (one --lags entry per client)');
    process.exit(2);
  }

  console.log(`fleet: ${lags.length} clients -> ${url}, ${laps} laps, track ${values.track}`);
  const clients = lags.map(
    (lag, i) => new FleetClient(url, `FLEET-${'ABCD'[i]}`, lag, jitters[i] ?? 0),
  );
  const fail = async (why: string) => {
    console.error(`\nFAIL: ${why}`);
    for (const c of clients) c.close();
    process.exit(1);
  };

  try {
    await Promise.all(clients.map((c) => c.opened));
    const [host, ...rest] = clients;
    host!.send({
      t: 'createRoom',
      name: host!.name,
      isPublic: false,
      laps,
      track: values.track,
    });
    await waitFor(() => host!.room !== null, 'room creation', 10_000);
    const code = host!.room!.code;
    for (const c of rest) {
      c.send({ t: 'joinRoom', name: c.name, code });
      await waitFor(() => c.room !== null, `${c.name} join`, 10_000);
      c.send({ t: 'setReady', ready: true });
    }
    await waitFor(
      () =>
        host!.room!.players.length === clients.length &&
        host!.room!.players.slice(1).every((p) => p.ready),
      'everyone ready',
      10_000,
    );
    host!.send({ t: 'startRace' });
    await waitFor(() => clients.every((c) => c.raceStart !== null), 'race start', 10_000);
    console.log(
      `race started: track ${host!.raceStart!.trackId}, seed ${host!.raceStart!.seed}\n`,
    );

    const t0 = Date.now();
    const progress = setInterval(() => {
      const line = clients
        .map((c) => {
          const s = c.session!;
          const lag = s.frame - Math.min(s.confirmedFrame(), s.frame);
          return `${c.name.slice(-1)} f=${s.frame} lag=${lag} stalls=${s.stats.stalledFrames}`;
        })
        .join('  |  ');
      console.log(`t=${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s  ${line}`);
    }, 5000);

    try {
      await waitFor(
        () => clients.every((c) => c.raceEnded || c.dead),
        'all clients to finish',
        laps * 150_000 + 60_000,
      );
    } finally {
      clearInterval(progress);
    }
    await sleep(1000); // drain in-flight hashes/desync verdicts

    if (clients.some((c) => c.dead)) return fail('a client died mid-race');

    console.log('\nclient   link        ping   frames  stalls  rollbk  resims  lag p50/p95/max');
    for (const c of clients) {
      const s = c.session!;
      const sorted = [...c.lagSamples].sort((a, b) => a - b);
      console.log(
        [
          c.name.padEnd(8),
          `${c.lagMs}±${c.jitterMs}ms`.padEnd(11),
          `${c.rtt().toFixed(0)}ms`.padEnd(6),
          String(s.frame).padEnd(7),
          String(s.stats.stalledFrames).padEnd(7),
          String(s.stats.rollbacks).padEnd(7),
          String(s.stats.rolledBackFrames).padEnd(7),
          `${percentile(sorted, 50)}/${percentile(sorted, 95)}/${sorted[sorted.length - 1] ?? 0}`,
        ].join(' '),
      );
      if (c.errors.length > 0) console.warn(`  ${c.name} errors: ${c.errors.join('; ')}`);
    }

    const finishes = clients.map((c) => c.session!.state.karts.map((k) => k.finishTick).join(','));
    if (new Set(finishes).size !== 1) {
      return fail(`finish ticks diverged across clients: ${finishes.join(' vs ')}`);
    }
    if (clients.some((c) => c.desyncs.length > 0)) {
      return fail(`server flagged desync at frames ${clients.flatMap((c) => c.desyncs).join(',')}`);
    }
    const placements = computePlacements(clients[0]!.session!.state);
    console.log(
      `\nresult: ${placements
        .map((k, pos) => `${pos + 1}. ${clients[k]?.name ?? `kart${k}`} ${fmtTime(
          clients[0]!.session!.state.karts[k]!.finishTick,
        )}`)
        .join('  ')}`,
    );
    console.log('OK: identical finishes on every client, no desync');
    for (const c of clients) c.close();
    process.exit(0);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

void main();
