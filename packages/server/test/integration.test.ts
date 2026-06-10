/**
 * M5 gate, automated: two real clients (headless RollbackSessions) connect
 * through the actual WebSocket server, race with live input relay, and stay
 * bit-identical. Also: an induced desync is detected and broadcast with a
 * frame number, and a mid-race disconnect produces a deterministic drop.
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '../src/server.js';
import {
  RollbackSession,
  hashState,
  rngNextState,
  rngValue,
  BTN_ACCEL,
  isTrackId,
  type RaceConfig,
} from '@mk/sim';
import { parseServerMsg, HASH_INTERVAL, type ClientMsg, type ServerMsg } from '@mk/shared';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(5);
  }
}

function maskStream(seed: number): (f: number) => number {
  const cache: number[] = [];
  let s = seed | 0;
  let mask = BTN_ACCEL;
  return (f: number) => {
    while (cache.length <= f) {
      s = rngNextState(s);
      const v = rngValue(s);
      if (v % 6 === 0) mask = (v >>> 8) & 31;
      cache.push(mask);
    }
    return cache[f]!;
  };
}

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type RaceStartMsg = Extract<ServerMsg, { t: 'raceStart' }>;
type DesyncMsg = Extract<ServerMsg, { t: 'desync' }>;
type DroppedMsg = Extract<ServerMsg, { t: 'dropped' }>;

class TestClient {
  ws: WebSocket;
  opened: Promise<void>;
  room: RoomMsg | null = null;
  raceStart: RaceStartMsg | null = null;
  session: RollbackSession | null = null;
  desyncs: DesyncMsg[] = [];
  drops: DroppedMsg[] = [];
  errors: string[] = [];
  /** apply a different input locally than what we send (desync inducer) */
  lie = false;
  private lastInputFrame = -1;
  private nextHashFrame = HASH_INTERVAL;
  private pendingInputs: { p: number; f: number; m: number }[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => {
      const msg = parseServerMsg(data.toString());
      if (!msg) throw new Error(`client received invalid server message: ${data.toString()}`);
      switch (msg.t) {
        case 'room':
          this.room = msg;
          break;
        case 'raceStart':
          this.raceStart = msg;
          break;
        case 'input':
          if (this.session) this.session.addInput(msg.p, msg.f, msg.m);
          else this.pendingInputs.push({ p: msg.p, f: msg.f, m: msg.m });
          break;
        case 'dropped':
          this.drops.push(msg);
          this.session?.dropPlayer(msg.p, msg.fromFrame);
          break;
        case 'desync':
          this.desyncs.push(msg);
          break;
        case 'error':
          this.errors.push(msg.message);
          break;
        default:
          break;
      }
    });
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  startSession(): void {
    const rs = this.raceStart!;
    const cfg: RaceConfig = {
      seed: rs.seed,
      lapCount: rs.laps,
      playerCount: rs.players.length,
      trackId: rs.trackId,
    };
    this.session = new RollbackSession(cfg, rs.you);
    for (const i of this.pendingInputs) this.session.addInput(i.p, i.f, i.m);
    this.pendingInputs = [];
  }

  /** One client main-loop step: record + send local input, try to advance, report hashes. */
  tick(mask: number): void {
    const s = this.session!;
    const f = s.frame;
    if (f > this.lastInputFrame) {
      s.addLocalInput(this.lie ? mask ^ BTN_ACCEL : mask);
      this.send({ t: 'input', f, m: mask });
      this.lastInputFrame = f;
    }
    s.advance();
    const confirmedState = Math.min(s.confirmedFrame() + 1, s.frame);
    while (this.nextHashFrame <= confirmedState) {
      const h = s.confirmedHash(this.nextHashFrame);
      if (h !== null) this.send({ t: 'hash', f: this.nextHashFrame, h });
      this.nextHashFrame += HASH_INTERVAL;
    }
  }

  close(): void {
    this.ws.close();
  }
}

describe('server integration (M5)', () => {
  let srv: GameServer | null = null;
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await srv?.close();
    srv = null;
  });

  async function setupRace(): Promise<{ a: TestClient; b: TestClient }> {
    srv = await createGameServer(0);
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const a = new TestClient(url);
    const b = new TestClient(url);
    clients.push(a, b);
    await a.opened;
    await b.opened;
    a.send({ t: 'createRoom', name: 'alice', isPublic: false, laps: 3 });
    await until(() => a.room !== null, 'room created');
    b.send({ t: 'joinRoom', name: 'bob', code: a.room!.code });
    await until(() => b.room !== null, 'room joined');
    b.send({ t: 'setReady', ready: true });
    await until(() => a.room!.players[1]?.ready === true, 'bob ready');
    a.send({ t: 'startRace' });
    await until(() => a.raceStart !== null && b.raceStart !== null, 'race start');
    expect(a.raceStart!.seed).toBe(b.raceStart!.seed);
    expect(a.raceStart!.you).toBe(0);
    expect(b.raceStart!.you).toBe(1);
    // default room track is 'random' — must resolve to a concrete registry id
    expect(a.raceStart!.trackId).toBe(b.raceStart!.trackId);
    expect(isTrackId(a.raceStart!.trackId)).toBe(true);
    a.startSession();
    b.startSession();
    return { a, b };
  }

  it('two clients stay bit-identical over a relayed race', { timeout: 30000 }, async () => {
    const { a, b } = await setupRace();
    const FRAMES = 600; // 10s of sim incl. countdown -> racing transition
    const mA = maskStream(0x111);
    const mB = maskStream(0x222);
    for (
      let i = 0;
      i < FRAMES * 6 && (a.session!.frame < FRAMES || b.session!.frame < FRAMES);
      i++
    ) {
      if (a.session!.frame < FRAMES) a.tick(mA(a.session!.frame));
      if (b.session!.frame < FRAMES) b.tick(mB(b.session!.frame));
      await sleep(0);
    }
    await sleep(100); // drain in-flight messages
    a.session!.applyCorrections();
    b.session!.applyCorrections();
    expect(a.session!.frame).toBe(FRAMES);
    expect(b.session!.frame).toBe(FRAMES);
    expect(hashState(a.session!.state)).toBe(hashState(b.session!.state));
    expect(a.desyncs).toHaveLength(0);
    expect(b.desyncs).toHaveLength(0);
    expect(a.errors).toHaveLength(0);
  });

  it('an induced desync is detected and broadcast with its frame number', { timeout: 30000 }, async () => {
    const { a, b } = await setupRace();
    b.lie = true; // b applies different inputs locally than it sends
    const FRAMES = 1200;
    const mA = maskStream(0x333);
    const mB = maskStream(0x444);
    for (let i = 0; i < FRAMES * 6 && a.desyncs.length === 0; i++) {
      if (a.session!.frame < FRAMES) a.tick(mA(a.session!.frame));
      if (b.session!.frame < FRAMES) b.tick(mB(b.session!.frame));
      await sleep(0);
    }
    await until(() => a.desyncs.length > 0 && b.desyncs.length > 0, 'desync broadcast');
    const d = a.desyncs[0]!;
    expect(d.frame).toBeGreaterThan(0);
    expect(d.frame % HASH_INTERVAL).toBe(0);
    expect(d.detail).toContain('k0=');
  });

  it('host picks the track; non-hosts cannot; raceStart carries it', { timeout: 30000 }, async () => {
    srv = await createGameServer(0);
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const a = new TestClient(url);
    const b = new TestClient(url);
    clients.push(a, b);
    await a.opened;
    await b.opened;
    a.send({ t: 'createRoom', name: 'alice', isPublic: false, laps: 2, track: 'glacier-gp' });
    await until(() => a.room !== null, 'room created');
    expect(a.room!.track).toBe('glacier-gp');
    b.send({ t: 'joinRoom', name: 'bob', code: a.room!.code });
    await until(() => b.room !== null, 'room joined');

    // non-host setTrack is rejected and changes nothing
    b.send({ t: 'setTrack', track: 'neon-gauntlet' });
    await until(() => b.errors.length > 0, 'non-host rejection');
    expect(b.errors[0]).toContain('host');
    expect(b.room!.track).toBe('glacier-gp');

    // host changes the track; everyone sees it
    a.send({ t: 'setTrack', track: 'neon-gauntlet' });
    await until(() => a.room!.track === 'neon-gauntlet' && b.room!.track === 'neon-gauntlet', 'track update');

    // an invalid id falls back to random rather than poisoning the room
    a.send({ t: 'setTrack', track: 'no-such-track' });
    await until(() => a.room!.track === 'random', 'invalid track sanitized');
    a.send({ t: 'setTrack', track: 'neon-gauntlet' });
    await until(() => a.room!.track === 'neon-gauntlet', 'track restored');

    b.send({ t: 'setReady', ready: true });
    await until(() => a.room!.players[1]?.ready === true, 'bob ready');
    a.send({ t: 'startRace' });
    await until(() => a.raceStart !== null && b.raceStart !== null, 'race start');
    expect(a.raceStart!.trackId).toBe('neon-gauntlet');
    expect(b.raceStart!.trackId).toBe('neon-gauntlet');

    // a short relayed stretch on the selected track stays bit-identical
    a.startSession();
    b.startSession();
    const FRAMES = 300;
    const mA = maskStream(0x777);
    const mB = maskStream(0x888);
    for (let i = 0; i < FRAMES * 6 && (a.session!.frame < FRAMES || b.session!.frame < FRAMES); i++) {
      if (a.session!.frame < FRAMES) a.tick(mA(a.session!.frame));
      if (b.session!.frame < FRAMES) b.tick(mB(b.session!.frame));
      await sleep(0);
    }
    await sleep(100);
    a.session!.applyCorrections();
    b.session!.applyCorrections();
    expect(hashState(a.session!.state)).toBe(hashState(b.session!.state));
    expect(a.desyncs).toHaveLength(0);
  });

  it('a mid-race disconnect is broadcast and the survivor keeps simulating', { timeout: 30000 }, async () => {
    const { a, b } = await setupRace();
    const FRAMES = 400;
    const mA = maskStream(0x555);
    const mB = maskStream(0x666);
    for (let i = 0; i < FRAMES * 6 && a.session!.frame < 100; i++) {
      a.tick(mA(a.session!.frame));
      if (b.session!.frame < FRAMES) b.tick(mB(b.session!.frame));
      await sleep(0);
    }
    b.close();
    await until(() => a.drops.length === 1, 'drop notification');
    expect(a.drops[0]!.p).toBe(1);
    expect(a.drops[0]!.fromFrame).toBeGreaterThan(0);
    // survivor must be able to reach FRAMES without stalling forever
    for (let i = 0; i < FRAMES * 6 && a.session!.frame < FRAMES; i++) {
      a.tick(mA(a.session!.frame));
      await sleep(0);
    }
    expect(a.session!.frame).toBe(FRAMES);
  });
});
