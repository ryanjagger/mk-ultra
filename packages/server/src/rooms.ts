/**
 * Room management + input relay + desync detection.
 *
 * The server never runs the simulation: it relays input frames (the only
 * thing that crosses the wire, NFR-13), serializes them into a single
 * authoritative arrival order, and cross-checks the state hashes clients
 * report for fully-confirmed frames (NFR-17).
 */
import {
  RANDOM_TRACK,
  DEFAULT_STYLE,
  encodeRle,
  type ClientMsg,
  type ServerMsg,
  type RoomInfo,
  type PlayerStyle,
  type GameMode,
} from '@mk/shared';
import { MAX_PLAYERS, TRACKS, isTrackId } from '@mk/sim';
import { randomInt } from 'node:crypto';
import type { Leaderboards } from './leaderboard.js';

export interface Conn {
  send(msg: ServerMsg): void;
}

export interface PlayerCtx {
  conn: Conn;
  name: string;
  style: PlayerStyle;
  room: Room | null;
  /** last accepted leaderboard submission (rate limiting) */
  lastSubmitMs?: number;
}

interface Seat {
  ctx: PlayerCtx | null;
  name: string;
  style: PlayerStyle;
  ready: boolean;
  connected: boolean;
  bot: boolean;
  /** Grand Prix points; travels with the seat across races */
  points: number;
}

interface RaceState {
  seed: number;
  trackId: string;
  startAtMs: number;
  /** highest input frame received per kart (kart index == seat index) */
  lastFrame: number[];
  dropped: boolean[];
  /** canonical input record per kart, indexed by frame (replay source) */
  inputLog: number[][];
  /** frame -> per-kart reported hash */
  hashes: Map<number, (number | undefined)[]>;
  desyncAnnounced: boolean;
}

/** The last finished race of a room, replayable as (config + inputs). */
type ReplayMsg = Extract<ServerMsg, { t: 'replay' }>;

export interface Room {
  code: string;
  isPublic: boolean;
  laps: number;
  /** registry track id or 'random' (resolved at race start) */
  track: string;
  state: 'lobby' | 'racing';
  seats: Seat[];
  race: RaceState | null;
  lastReplay: ReplayMsg | null;
  /** Grand Prix length; 0 = single races */
  cupRaces: number;
  /** cup races completed */
  cupRaceIndex: number;
  mode: GameMode;
}

/** Cup points by finish position. */
const CUP_POINTS = [10, 7, 4, 2];

/** Registry id or 'random'; anything else falls back to 'random'. */
function sanitizeTrack(track: string | undefined): string {
  if (track !== undefined && (track === RANDOM_TRACK || isTrackId(track))) return track;
  return RANDOM_TRACK;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Drop hash bookkeeping older than this many frames behind the newest. */
const HASH_RETENTION_FRAMES = 3600;

export class GameLobby {
  readonly rooms = new Map<string, Room>();

  constructor(private readonly leaderboards: Leaderboards | null = null) {}

  private genCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  publicRooms(): RoomInfo[] {
    const out: RoomInfo[] = [];
    for (const room of this.rooms.values()) {
      if (!room.isPublic || room.state !== 'lobby' || room.seats.length >= MAX_PLAYERS) continue;
      out.push({
        code: room.code,
        hostName: room.seats[0]?.name ?? '?',
        playerCount: room.seats.length,
        laps: room.laps,
        track: room.track,
      });
      if (out.length >= 50) break;
    }
    return out;
  }

  handleMessage(ctx: PlayerCtx, msg: ClientMsg): void {
    switch (msg.t) {
      case 'ping':
        ctx.conn.send({ t: 'pong', pt: msg.pt, now: Date.now() });
        return;
      case 'listRooms':
        ctx.conn.send({ t: 'roomList', rooms: this.publicRooms() });
        return;
      case 'createRoom':
        this.leaveRoom(ctx);
        ctx.name = msg.name;
        ctx.style = msg.style ?? DEFAULT_STYLE;
        this.createRoom(ctx, msg.isPublic, msg.laps, sanitizeTrack(msg.track));
        return;
      case 'joinRoom': {
        this.leaveRoom(ctx);
        ctx.name = msg.name;
        ctx.style = msg.style ?? DEFAULT_STYLE;
        const room = this.rooms.get(msg.code.toUpperCase());
        if (!room) {
          ctx.conn.send({ t: 'error', message: 'Room not found' });
          return;
        }
        this.joinRoom(ctx, room);
        return;
      }
      case 'quickPlay': {
        this.leaveRoom(ctx);
        ctx.name = msg.name;
        ctx.style = msg.style ?? DEFAULT_STYLE;
        let target: Room | null = null;
        for (const room of this.rooms.values()) {
          if (room.isPublic && room.state === 'lobby' && room.seats.length < MAX_PLAYERS) {
            target = room;
            break;
          }
        }
        if (target) this.joinRoom(ctx, target);
        else this.createRoom(ctx, true, 3, RANDOM_TRACK);
        return;
      }
      case 'leaveRoom':
        this.leaveRoom(ctx);
        ctx.conn.send({ t: 'leftRoom' });
        return;
      case 'setReady': {
        const seat = this.seatOf(ctx);
        if (!seat || ctx.room!.state !== 'lobby') return;
        seat.ready = msg.ready;
        this.broadcastRoom(ctx.room!);
        return;
      }
      case 'setTrack': {
        const room = ctx.room;
        if (!room || room.state !== 'lobby') return;
        if (this.seatIndexOf(ctx) !== 0) {
          ctx.conn.send({ t: 'error', message: 'Only the host can change the track' });
          return;
        }
        room.track = sanitizeTrack(msg.track);
        this.broadcastRoom(room);
        return;
      }
      case 'setMode': {
        const room = ctx.room;
        if (!room || room.state !== 'lobby') return;
        if (this.seatIndexOf(ctx) !== 0) {
          ctx.conn.send({ t: 'error', message: 'Only the host can change the mode' });
          return;
        }
        room.mode = msg.mode;
        this.broadcastRoom(room);
        return;
      }
      case 'setCup': {
        const room = ctx.room;
        if (!room || room.state !== 'lobby') return;
        if (this.seatIndexOf(ctx) !== 0) {
          ctx.conn.send({ t: 'error', message: 'Only the host can change the mode' });
          return;
        }
        room.cupRaces = msg.races >= 2 ? msg.races : 0;
        room.cupRaceIndex = 0;
        for (const s of room.seats) s.points = 0;
        this.broadcastRoom(room);
        return;
      }
      case 'addBot': {
        const room = ctx.room;
        if (!room || room.state !== 'lobby') return;
        if (this.seatIndexOf(ctx) !== 0) {
          ctx.conn.send({ t: 'error', message: 'Only the host can add CPUs' });
          return;
        }
        if (room.seats.length >= MAX_PLAYERS) {
          ctx.conn.send({ t: 'error', message: 'Room is full' });
          return;
        }
        const n = room.seats.filter((s) => s.bot).length + 1;
        room.seats.push({
          ctx: null,
          name: `CPU ${n}`,
          style: DEFAULT_STYLE,
          ready: true,
          connected: true,
          bot: true,
          points: 0,
        });
        this.broadcastRoom(room);
        return;
      }
      case 'removeBot': {
        const room = ctx.room;
        if (!room || room.state !== 'lobby') return;
        if (this.seatIndexOf(ctx) !== 0) {
          ctx.conn.send({ t: 'error', message: 'Only the host can remove CPUs' });
          return;
        }
        for (let i = room.seats.length - 1; i >= 0; i--) {
          if (room.seats[i]!.bot) {
            room.seats.splice(i, 1);
            this.broadcastRoom(room);
            return;
          }
        }
        return;
      }
      case 'startRace':
        this.startRace(ctx);
        return;
      case 'input':
        this.relayInput(ctx, msg.f, msg.m);
        return;
      case 'hash':
        this.recordHash(ctx, msg.f, msg.h);
        return;
      case 'raceEnded': {
        const room = ctx.room;
        if (!room || room.state !== 'racing') return;
        this.endRace(room, msg.placements);
        return;
      }
      case 'submitTime': {
        if (!this.leaderboards) return;
        // verification replays a whole race — keep it off the hot path
        const now = Date.now();
        if (ctx.lastSubmitMs !== undefined && now - ctx.lastSubmitMs < 5000) {
          ctx.conn.send({ t: 'error', message: 'Easy — one submission every few seconds' });
          return;
        }
        ctx.lastSubmitMs = now;
        const rank = this.leaderboards.submit(msg.name, msg.trackId, msg.laps, msg.inputs);
        if (rank === null) {
          ctx.conn.send({ t: 'error', message: 'Run failed verification' });
          return;
        }
        ctx.conn.send({
          t: 'leaderboard',
          trackId: msg.trackId,
          laps: msg.laps,
          entries: this.leaderboards.top(msg.trackId, msg.laps),
          yourRank: rank,
        });
        return;
      }
      case 'getLeaderboard': {
        if (!this.leaderboards) return;
        ctx.conn.send({
          t: 'leaderboard',
          trackId: msg.trackId,
          laps: msg.laps,
          entries: this.leaderboards.top(msg.trackId, msg.laps),
        });
        return;
      }
      case 'getGhost': {
        if (!this.leaderboards) return;
        const entry = this.leaderboards.ghost(msg.trackId, msg.laps, msg.rank);
        if (!entry) {
          ctx.conn.send({ t: 'error', message: 'No ghost at that rank' });
          return;
        }
        ctx.conn.send({
          t: 'ghostData',
          trackId: msg.trackId,
          laps: msg.laps,
          name: entry.name,
          timeMs: entry.timeMs,
          inputs: entry.rle,
        });
        return;
      }
      case 'getReplay': {
        const room = ctx.room;
        if (!room) return;
        if (room.lastReplay) ctx.conn.send(room.lastReplay);
        else ctx.conn.send({ t: 'error', message: 'No replay available yet' });
        return;
      }
    }
  }

  handleDisconnect(ctx: PlayerCtx): void {
    this.leaveRoom(ctx);
  }

  private seatOf(ctx: PlayerCtx): Seat | null {
    if (!ctx.room) return null;
    return ctx.room.seats.find((s) => s.ctx === ctx) ?? null;
  }

  private seatIndexOf(ctx: PlayerCtx): number {
    if (!ctx.room) return -1;
    return ctx.room.seats.findIndex((s) => s.ctx === ctx);
  }

  private createRoom(ctx: PlayerCtx, isPublic: boolean, laps: number, track: string): void {
    const room: Room = {
      code: this.genCode(),
      isPublic,
      laps,
      track,
      state: 'lobby',
      seats: [
        {
          ctx,
          name: ctx.name,
          style: ctx.style,
          ready: false,
          connected: true,
          bot: false,
          points: 0,
        },
      ],
      race: null,
      lastReplay: null,
      cupRaces: 0,
      cupRaceIndex: 0,
      mode: 'race',
    };
    this.rooms.set(room.code, room);
    ctx.room = room;
    this.broadcastRoom(room);
  }

  private joinRoom(ctx: PlayerCtx, room: Room): void {
    if (room.state !== 'lobby') {
      ctx.conn.send({ t: 'error', message: 'Race in progress — try again soon' });
      return;
    }
    if (room.seats.length >= MAX_PLAYERS) {
      ctx.conn.send({ t: 'error', message: 'Room is full' });
      return;
    }
    room.seats.push({
      ctx,
      name: ctx.name,
      style: ctx.style,
      ready: false,
      connected: true,
      bot: false,
      points: 0,
    });
    ctx.room = room;
    // humans before bots: the host (seat 0) must always be a human
    room.seats.sort((a, b) => Number(a.bot) - Number(b.bot));
    this.broadcastRoom(room);
  }

  private leaveRoom(ctx: PlayerCtx): void {
    const room = ctx.room;
    if (!room) return;
    ctx.room = null;
    if (room.state === 'racing') {
      // keep the seat (kart indexes are locked); mark dropped
      const idx = room.seats.findIndex((s) => s.ctx === ctx);
      if (idx >= 0) this.dropRacer(room, idx);
    } else {
      const idx = room.seats.findIndex((s) => s.ctx === ctx);
      if (idx >= 0) room.seats.splice(idx, 1);
      if (!room.seats.some((s) => !s.bot)) {
        // bots don't keep rooms alive
        this.rooms.delete(room.code);
        return;
      }
      room.seats.sort((a, b) => Number(a.bot) - Number(b.bot)); // host stays human
      this.broadcastRoom(room);
    }
  }

  private dropRacer(room: Room, kartIdx: number): void {
    const seat = room.seats[kartIdx];
    const race = room.race;
    if (!seat || !race || race.dropped[kartIdx]) return;
    seat.ctx = null;
    seat.connected = false;
    race.dropped[kartIdx] = true;
    const fromFrame = race.lastFrame[kartIdx]! + 1;
    console.warn(`[room ${room.code}] kart ${kartIdx} (${seat.name}) dropped from frame ${fromFrame}`);
    this.broadcastToRace(room, { t: 'dropped', p: kartIdx, fromFrame });
    // a drop can complete pending hash rounds
    this.checkHashes(room);
    if (!room.seats.some((s) => s.connected)) {
      this.rooms.delete(room.code);
    }
  }

  private startRace(ctx: PlayerCtx): void {
    const room = ctx.room;
    if (!room || room.state !== 'lobby') return;
    if (this.seatIndexOf(ctx) !== 0) {
      ctx.conn.send({ t: 'error', message: 'Only the host can start' });
      return;
    }
    const others = room.seats.slice(1);
    if (!others.every((s) => s.ready || s.bot)) {
      ctx.conn.send({ t: 'error', message: 'Not everyone is ready' });
      return;
    }
    // starting fresh after a finished cup rewinds the standings
    if (room.cupRaces > 0 && room.cupRaceIndex >= room.cupRaces) {
      room.cupRaceIndex = 0;
      for (const s of room.seats) s.points = 0;
    }
    room.state = 'racing';
    const kartCount = room.seats.length;
    // random pool: battles draw arenas, races draw everything else
    const pool = TRACKS.filter((t) => !!t.def.arena === (room.mode === 'battle'));
    const fallback = pool.length > 0 ? pool : TRACKS;
    const trackId =
      room.track === RANDOM_TRACK ? fallback[randomInt(fallback.length)]!.def.id : room.track;
    room.race = {
      seed: randomInt(0, 0x7fffffff),
      trackId,
      startAtMs: Date.now() + 1500,
      lastFrame: new Array<number>(kartCount).fill(-1),
      dropped: new Array<boolean>(kartCount).fill(false),
      inputLog: Array.from({ length: kartCount }, () => []),
      hashes: new Map(),
      desyncAnnounced: false,
    };
    const names = room.seats.map((s) => s.name);
    const styles = room.seats.map((s) => s.style);
    console.log(
      `[room ${room.code}] race start: ${kartCount} karts, seed ${room.race.seed}, track ${trackId}`,
    );
    const bots = room.seats.map((s) => s.bot);
    room.seats.forEach((seat, i) => {
      seat.ctx?.conn.send({
        t: 'raceStart',
        seed: room.race!.seed,
        laps: room.laps,
        mode: room.mode,
        trackId,
        startAtMs: room.race!.startAtMs,
        you: i,
        players: names,
        styles,
        bots,
      });
    });
  }

  private endRace(room: Room, placements?: readonly number[]): void {
    if (room.race) room.lastReplay = this.buildReplay(room, room.race);
    // cup scoring: first reporter's deterministic placements stand
    if (room.cupRaces > 0 && placements) {
      const seen = new Set<number>();
      placements.forEach((kartIdx, pos) => {
        if (seen.has(kartIdx) || kartIdx >= room.seats.length) return;
        seen.add(kartIdx);
        room.seats[kartIdx]!.points += CUP_POINTS[pos] ?? 0;
      });
      room.cupRaceIndex += 1;
    }
    room.state = 'lobby';
    room.race = null;
    // disconnected racers vacate their seats now; bots stay for the next race
    room.seats = room.seats.filter((s) => s.bot || (s.connected && s.ctx));
    if (!room.seats.some((s) => !s.bot)) {
      this.rooms.delete(room.code);
      return;
    }
    room.seats.sort((a, b) => Number(a.bot) - Number(b.bot)); // host stays human
    for (const s of room.seats) {
      if (!s.bot) s.ready = false;
    }
    this.broadcastRoom(room);
  }

  private relayInput(ctx: PlayerCtx, frame: number, mask: number): void {
    const room = ctx.room;
    if (!room || room.state !== 'racing' || !room.race) return;
    const k = this.seatIndexOf(ctx);
    if (k < 0) return;
    const race = room.race;
    // single serialization point: enforce strictly-increasing frames per kart,
    // so every peer sees one consistent first-write-wins input stream
    if (frame <= race.lastFrame[k]!) return;
    race.lastFrame[k] = frame;
    race.inputLog[k]![frame] = mask; // canonical record — the replay source
    const out: ServerMsg = { t: 'input', p: k, f: frame, m: mask };
    for (let i = 0; i < room.seats.length; i++) {
      if (i === k) continue;
      room.seats[i]!.ctx?.conn.send(out);
    }
  }

  private recordHash(ctx: PlayerCtx, frame: number, hash: number): void {
    const room = ctx.room;
    if (!room || room.state !== 'racing' || !room.race) return;
    const k = this.seatIndexOf(ctx);
    if (k < 0) return;
    const race = room.race;
    let row = race.hashes.get(frame);
    if (!row) {
      row = new Array<number | undefined>(room.seats.length).fill(undefined);
      race.hashes.set(frame, row);
    }
    if (row[k] === undefined) row[k] = hash;
    this.checkHashes(room);
  }

  /** Compare hash rows for frames where every live kart has reported. */
  private checkHashes(room: Room): void {
    const race = room.race;
    if (!race) return;
    let newest = 0;
    for (const f of race.hashes.keys()) if (f > newest) newest = f;
    for (const [frame, row] of [...race.hashes.entries()].sort((a, b) => a[0] - b[0])) {
      if (frame < newest - HASH_RETENTION_FRAMES) {
        race.hashes.delete(frame);
        continue;
      }
      let complete = true;
      for (let k = 0; k < row.length; k++) {
        // bot seats never report hashes — their state is part of every
        // human client's hash, so cross-checking humans covers them
        if (!race.dropped[k] && !room.seats[k]?.bot && row[k] === undefined) complete = false;
      }
      if (!complete) continue;
      const reported = row.filter((h): h is number => h !== undefined);
      const mismatch = reported.some((h) => h !== reported[0]);
      if (mismatch && !race.desyncAnnounced) {
        race.desyncAnnounced = true;
        const detail = row.map((h, k) => `k${k}=${h === undefined ? '-' : h.toString(16)}`).join(' ');
        console.error(`[room ${room.code}] !!! DESYNC at frame ${frame}: ${detail}`);
        this.broadcastToRace(room, { t: 'desync', frame, detail });
      }
      race.hashes.delete(frame);
    }
  }

  /** Snapshot the finished race as data. Called before seats are filtered. */
  private buildReplay(room: Room, race: RaceState): ReplayMsg {
    const inputs = race.inputLog.map((log) => {
      // fill holes with the previous mask (matches what clients converged on);
      // a dropped kart's log just ends — the replay feeds neutral past the end
      const dense: number[] = new Array<number>(log.length);
      let last = 0;
      for (let f = 0; f < log.length; f++) {
        const m = log[f];
        if (m !== undefined) last = m;
        dense[f] = last;
      }
      return encodeRle(dense);
    });
    return {
      t: 'replay',
      seed: race.seed,
      laps: room.laps,
      mode: room.mode,
      trackId: race.trackId,
      players: room.seats.map((s) => s.name),
      styles: room.seats.map((s) => s.style),
      bots: room.seats.map((s) => s.bot),
      inputs,
    };
  }

  private broadcastToRace(room: Room, msg: ServerMsg): void {
    for (const seat of room.seats) seat.ctx?.conn.send(msg);
  }

  broadcastRoom(room: Room): void {
    const players = room.seats.map((s, i) => ({
      name: s.name,
      ready: s.ready,
      host: i === 0,
      connected: s.connected,
      bot: s.bot,
      style: s.style,
    }));
    const cup =
      room.cupRaces > 0
        ? {
            raceIndex: Math.min(room.cupRaceIndex, room.cupRaces),
            totalRaces: room.cupRaces,
            points: room.seats.map((s) => s.points),
            done: room.cupRaceIndex >= room.cupRaces,
          }
        : undefined;
    room.seats.forEach((seat, i) => {
      seat.ctx?.conn.send({
        t: 'room',
        code: room.code,
        isPublic: room.isPublic,
        laps: room.laps,
        track: room.track,
        state: room.state,
        mode: room.mode,
        you: i,
        players,
        cup,
      });
    });
  }
}
