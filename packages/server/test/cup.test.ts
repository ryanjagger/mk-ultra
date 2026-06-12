/**
 * Grand Prix cups: host configures a cup, placements reported at race end
 * accumulate points across races, standings broadcast with the room.
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '../src/server.js';
import { parseServerMsg, type ClientMsg, type ServerMsg } from '@mk/shared';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(5);
  }
}

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;

class MiniClient {
  ws: WebSocket;
  opened: Promise<void>;
  room: RoomMsg | null = null;
  raceStarted = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => {
      const msg = parseServerMsg(data.toString());
      if (!msg) throw new Error(`invalid server message: ${data.toString()}`);
      if (msg.t === 'room') this.room = msg;
      if (msg.t === 'raceStart') this.raceStarted = true;
    });
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

describe('grand prix cups', () => {
  let srv: GameServer | null = null;
  const clients: MiniClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await srv?.close();
    srv = null;
  });

  it('accumulates points across races and crowns a winner', { timeout: 15000 }, async () => {
    srv = await createGameServer(0);
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const a = new MiniClient(url);
    const b = new MiniClient(url);
    clients.push(a, b);
    await a.opened;
    await b.opened;

    a.send({ t: 'createRoom', name: 'alice', isPublic: false, laps: 1 });
    await until(() => a.room !== null, 'room created');
    b.send({ t: 'joinRoom', name: 'bob', code: a.room!.code });
    await until(() => b.room !== null, 'room joined');

    a.send({ t: 'setCup', races: 3 });
    await until(() => a.room?.cup?.totalRaces === 3, 'cup configured');
    expect(a.room!.cup!.points).toEqual([0, 0]);
    expect(a.room!.cup!.done).toBe(false);

    // non-hosts cannot change the mode
    b.send({ t: 'setCup', races: 4 });
    await sleep(50);
    expect(a.room!.cup!.totalRaces).toBe(3);

    const runRace = async (placements: number[]) => {
      b.send({ t: 'setReady', ready: true });
      await until(() => a.room?.players[1]?.ready === true, 'bob ready');
      a.send({ t: 'startRace' });
      await until(() => a.raceStarted, 'race started');
      a.raceStarted = false;
      a.room = null; // the next room broadcast carries the post-race standings
      a.send({ t: 'raceEnded', placements });
      await until(() => a.room?.state === 'lobby', 'back to lobby');
    };

    await runRace([0, 1]); // alice wins race 1: 10 / 7
    expect(a.room!.cup!.points).toEqual([10, 7]);
    expect(a.room!.cup!.raceIndex).toBe(1);

    await runRace([1, 0]); // bob wins race 2: 17 / 17
    expect(a.room!.cup!.points).toEqual([17, 17]);

    await runRace([1, 0]); // bob takes the cup
    expect(a.room!.cup!.points).toEqual([24, 27]);
    expect(a.room!.cup!.done).toBe(true);

    // starting again rewinds the standings
    b.send({ t: 'setReady', ready: true });
    await until(() => a.room?.players[1]?.ready === true, 'bob ready again');
    a.send({ t: 'startRace' });
    await until(() => a.raceStarted, 'race 4 started');
    a.room = null;
    a.send({ t: 'raceEnded', placements: [0, 1] });
    await until(() => a.room?.state === 'lobby', 'lobby again');
    expect(a.room!.cup!.points).toEqual([10, 7]);
    expect(a.room!.cup!.raceIndex).toBe(1);
    expect(a.room!.cup!.done).toBe(false);
  });

  it('ignores duplicate kart indices in reported placements', { timeout: 15000 }, async () => {
    srv = await createGameServer(0);
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const a = new MiniClient(url);
    clients.push(a);
    await a.opened;
    a.send({ t: 'createRoom', name: 'mallory', isPublic: false, laps: 1 });
    await until(() => a.room !== null, 'room created');
    a.send({ t: 'setCup', races: 2 });
    await until(() => a.room?.cup !== undefined, 'cup set');
    a.send({ t: 'startRace' });
    await until(() => a.raceStarted, 'race started');
    a.room = null;
    a.send({ t: 'raceEnded', placements: [0, 0, 0, 0] });
    await until(() => a.room?.state === 'lobby', 'lobby');
    expect(a.room!.cup!.points).toEqual([10]); // first mention only
  });
});
