/**
 * Wire protocol: typed messages, validated with Zod at BOTH boundaries
 * (server validates client messages, client validates server messages —
 * NFR-16). Only inputs and metadata ever cross the wire, never world state
 * (NFR-13).
 */
import { z } from 'zod';

export const MAX_NAME_LEN = 16;
export const MAX_LAPS = 9;
export const MAX_FRAME = 10_000_000;
export const ROOM_CODE_LEN = 4;
/** Confirmed-state hash exchange cadence, in frames (NFR-17). */
export const HASH_INTERVAL = 30;

const name = z.string().min(1).max(MAX_NAME_LEN);
const roomCode = z.string().length(ROOM_CODE_LEN);
const frame = z.number().int().min(0).max(MAX_FRAME);
const inputMask = z.number().int().min(0).max(63); // @mk/sim INPUT_MASK_ALL
const hash32 = z.number().int().min(0).max(0xffffffff);
/**
 * Track id, or 'random'. Shared cannot depend on the sim registry, so this is
 * shape-only — both server and client validate ids against @mk/sim's registry.
 */
const trackChoice = z.string().min(1).max(32);
export const RANDOM_TRACK = 'random';

// ---------------------------------------------------------------- C2S ----

export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('listRooms') }),
  z.object({
    t: z.literal('createRoom'),
    name,
    isPublic: z.boolean(),
    laps: z.number().int().min(1).max(MAX_LAPS),
    track: trackChoice.optional(), // default: 'random'
  }),
  z.object({ t: z.literal('joinRoom'), name, code: roomCode }),
  z.object({ t: z.literal('quickPlay'), name }),
  z.object({ t: z.literal('leaveRoom') }),
  z.object({ t: z.literal('setReady'), ready: z.boolean() }),
  z.object({ t: z.literal('setTrack'), track: trackChoice }), // host-only, lobby-only
  z.object({ t: z.literal('startRace') }),
  z.object({ t: z.literal('input'), f: frame, m: inputMask }),
  z.object({ t: z.literal('hash'), f: frame, h: hash32 }),
  z.object({ t: z.literal('raceEnded') }),
  z.object({ t: z.literal('ping'), pt: z.number() }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// ---------------------------------------------------------------- S2C ----

export const RoomPlayerSchema = z.object({
  name,
  ready: z.boolean(),
  host: z.boolean(),
  connected: z.boolean(),
});
export type RoomPlayer = z.infer<typeof RoomPlayerSchema>;

export const RoomInfoSchema = z.object({
  code: roomCode,
  hostName: name,
  playerCount: z.number().int().min(0).max(4),
  laps: z.number().int().min(1).max(MAX_LAPS),
  track: trackChoice,
});
export type RoomInfo = z.infer<typeof RoomInfoSchema>;

export const ServerMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('roomList'), rooms: z.array(RoomInfoSchema).max(50) }),
  z.object({
    t: z.literal('room'),
    code: roomCode,
    isPublic: z.boolean(),
    laps: z.number().int().min(1).max(MAX_LAPS),
    track: trackChoice,
    state: z.enum(['lobby', 'racing']),
    you: z.number().int().min(0).max(3),
    players: z.array(RoomPlayerSchema).max(4),
  }),
  z.object({ t: z.literal('leftRoom') }),
  z.object({
    t: z.literal('raceStart'),
    seed: z.number().int(),
    laps: z.number().int().min(1).max(MAX_LAPS),
    trackId: trackChoice, // always a concrete registry id ('random' resolved server-side)
    startAtMs: z.number(),
    you: z.number().int().min(0).max(3),
    players: z.array(name).min(1).max(4),
  }),
  z.object({ t: z.literal('input'), p: z.number().int().min(0).max(3), f: frame, m: inputMask }),
  z.object({ t: z.literal('dropped'), p: z.number().int().min(0).max(3), fromFrame: frame }),
  z.object({ t: z.literal('desync'), frame, detail: z.string().max(200) }),
  z.object({ t: z.literal('pong'), pt: z.number(), now: z.number() }),
  z.object({ t: z.literal('error'), message: z.string().max(200) }),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;

/** Parse + validate an inbound client->server message; null if invalid. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = ClientMsgSchema.safeParse(json);
  return res.success ? res.data : null;
}

/** Parse + validate an inbound server->client message; null if invalid. */
export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (typeof raw !== 'string' || raw.length > 16384) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = ServerMsgSchema.safeParse(json);
  return res.success ? res.data : null;
}
