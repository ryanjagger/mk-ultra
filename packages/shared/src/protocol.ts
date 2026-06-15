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
/**
 * Max redundant input masks piggybacked on an input message (`r[i]` = the
 * mask for frame `f-1-i`). Receivers fill holes first-write-wins, so a
 * message that never made it (or arrived while the receiver had no session)
 * heals on the next one instead of freezing the sender's confirmed frontier.
 */
export const INPUT_REDUNDANCY = 10;

const name = z.string().min(1).max(MAX_NAME_LEN);
const roomCode = z.string().length(ROOM_CODE_LEN);
const frame = z.number().int().min(0).max(MAX_FRAME);
const inputMask = z.number().int().min(0).max(1023); // @mk/sim INPUT_MASK_ALL (incl. 4-bit steer magnitude)
/** Redundant masks for the frames before `f`, newest first. */
const redundant = z.array(inputMask).max(INPUT_REDUNDANCY);
const hash32 = z.number().int().min(0).max(0xffffffff);
/**
 * Track id, or 'random'. Shared cannot depend on the sim registry, so this is
 * shape-only — both server and client validate ids against @mk/sim's registry.
 */
const trackChoice = z.string().min(1).max(32);
export const RANDOM_TRACK = 'random';

/** Room game mode; battle = balloons in an arena. */
const gameMode = z.enum(['race', 'battle']);
export type GameMode = z.infer<typeof gameMode>;

/**
 * Fixed time-trial seed: every run of a track sees identical item rolls, so
 * leaderboard times are comparable — and the server can re-simulate any
 * submitted input stream to verify the claimed time (cheat-proof by
 * determinism).
 */
export const TT_SEED = 0x77575;

/** RLE input stream: [mask, runLength] pairs from tick 0. */
const rleInputs = z
  .array(z.tuple([inputMask, z.number().int().min(1).max(MAX_FRAME)]))
  .max(20_000);

export const LeaderboardEntrySchema = z.object({
  name,
  timeMs: z.number().int().min(0),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

export const MAX_LEVEL = 99;
/**
 * Cosmetic identity a player carries into rooms. Ids are shape-only here
 * (shared cannot depend on the client catalog); clients fall back to defaults
 * for ids they don't recognize. Self-reported level — no server-side trust.
 */
export const PlayerStyleSchema = z.object({
  level: z.number().int().min(0).max(MAX_LEVEL),
  livery: z.string().min(1).max(16),
  flame: z.string().min(1).max(16),
});
export type PlayerStyle = z.infer<typeof PlayerStyleSchema>;
export const DEFAULT_STYLE: PlayerStyle = { level: 0, livery: 'seat', flame: 'classic' };

// ---------------------------------------------------------------- C2S ----

export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('listRooms') }),
  // `bot` (optional, default false): a self-driving `?bot` client declaring
  // itself automated, so the server excludes its seat from leaderboards.
  z.object({
    t: z.literal('createRoom'),
    name,
    isPublic: z.boolean(),
    laps: z.number().int().min(1).max(MAX_LAPS),
    track: trackChoice.optional(), // default: 'random'
    style: PlayerStyleSchema.optional(),
    bot: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('joinRoom'),
    name,
    code: roomCode,
    style: PlayerStyleSchema.optional(),
    bot: z.boolean().optional(),
  }),
  z.object({ t: z.literal('quickPlay'), name, style: PlayerStyleSchema.optional(), bot: z.boolean().optional() }),
  z.object({ t: z.literal('leaveRoom') }),
  z.object({ t: z.literal('setReady'), ready: z.boolean() }),
  z.object({ t: z.literal('setTrack'), track: trackChoice }), // host-only, lobby-only
  z.object({ t: z.literal('setLaps'), laps: z.number().int().min(1).max(MAX_LAPS) }), // host-only, lobby-only
  z.object({ t: z.literal('setPublic'), isPublic: z.boolean() }), // host-only, lobby-only
  // host-only, lobby-only: 0 = single races, N>=2 = Grand Prix of N races
  z.object({ t: z.literal('setCup'), races: z.number().int().min(0).max(8) }),
  z.object({ t: z.literal('setMode'), mode: gameMode }), // host-only, lobby-only
  z.object({ t: z.literal('addBot') }), // host-only, lobby-only
  z.object({ t: z.literal('removeBot') }), // host-only, lobby-only (removes the last bot)
  z.object({ t: z.literal('startRace') }),
  z.object({ t: z.literal('input'), f: frame, m: inputMask, r: redundant.optional() }),
  z.object({ t: z.literal('hash'), f: frame, h: hash32 }),
  z.object({
    t: z.literal('raceEnded'),
    /**
     * Kart indices in finish order, computed from the deterministic sim.
     * First reporter wins (all clients agree when in sync); the server
     * never simulates, so this is how cup points learn the results.
     */
    placements: z.array(z.number().int().min(0).max(3)).max(4).optional(),
  }),
  z.object({ t: z.literal('getReplay') }), // last finished race of my room
  // time-trial leaderboards: submissions are input recordings the server
  // re-simulates before accepting (seed is always TT_SEED)
  z.object({
    t: z.literal('submitTime'),
    name,
    trackId: trackChoice,
    laps: z.number().int().min(1).max(MAX_LAPS),
    inputs: rleInputs,
  }),
  z.object({
    t: z.literal('getLeaderboard'),
    trackId: trackChoice,
    laps: z.number().int().min(1).max(MAX_LAPS),
    // absent = time-trial board (the original); 'race' = online-race board
    kind: z.enum(['tt', 'race']).optional(),
  }),
  z.object({
    t: z.literal('getGhost'),
    trackId: trackChoice,
    laps: z.number().int().min(1).max(MAX_LAPS),
    rank: z.number().int().min(0).max(9),
  }),
  z.object({ t: z.literal('ping'), pt: z.number() }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// ---------------------------------------------------------------- S2C ----

export const RoomPlayerSchema = z.object({
  name,
  ready: z.boolean(),
  host: z.boolean(),
  connected: z.boolean(),
  bot: z.boolean(),
  style: PlayerStyleSchema,
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
    mode: gameMode.optional(), // absent = race
    you: z.number().int().min(0).max(3),
    players: z.array(RoomPlayerSchema).max(4),
    /** present while a Grand Prix is configured; points align with players */
    cup: z
      .object({
        raceIndex: z.number().int().min(0).max(8), // races completed
        totalRaces: z.number().int().min(2).max(8),
        points: z.array(z.number().int().min(0).max(999)).max(4),
        done: z.boolean(),
      })
      .optional(),
  }),
  z.object({ t: z.literal('leftRoom') }),
  z.object({
    t: z.literal('raceStart'),
    seed: z.number().int(),
    laps: z.number().int().min(1).max(MAX_LAPS),
    mode: gameMode.optional(), // absent = race
    trackId: trackChoice, // always a concrete registry id ('random' resolved server-side)
    startAtMs: z.number(),
    you: z.number().int().min(0).max(3),
    players: z.array(name).min(1).max(4),
    styles: z.array(PlayerStyleSchema).min(1).max(4),
    bots: z.array(z.boolean()).min(1).max(4),
  }),
  z.object({
    t: z.literal('input'),
    p: z.number().int().min(0).max(3),
    f: frame,
    m: inputMask,
    r: redundant.optional(),
  }),
  z.object({
    // the last finished race as data: deterministic sim + inputs = the race
    t: z.literal('replay'),
    seed: z.number().int(),
    laps: z.number().int().min(1).max(MAX_LAPS),
    mode: gameMode.optional(),
    trackId: trackChoice,
    players: z.array(name).min(1).max(4),
    styles: z.array(PlayerStyleSchema).min(1).max(4),
    bots: z.array(z.boolean()).min(1).max(4),
    /** per kart: RLE [mask, runLength] pairs from tick 0 */
    inputs: z
      .array(z.array(z.tuple([inputMask, z.number().int().min(1).max(MAX_FRAME)])).max(100_000))
      .min(1)
      .max(4),
  }),
  z.object({
    t: z.literal('leaderboard'),
    trackId: trackChoice,
    laps: z.number().int().min(1).max(MAX_LAPS),
    entries: z.array(LeaderboardEntrySchema).max(10),
    /** present when answering a submission: your rank, or -1 if off the board */
    yourRank: z.number().int().min(-1).max(9).optional(),
    // echoes the requested board so the client routes the response correctly
    kind: z.enum(['tt', 'race']).optional(),
  }),
  z.object({
    t: z.literal('ghostData'),
    trackId: trackChoice,
    laps: z.number().int().min(1).max(MAX_LAPS),
    name,
    timeMs: z.number().int().min(0),
    inputs: rleInputs,
  }),
  z.object({ t: z.literal('dropped'), p: z.number().int().min(0).max(3), fromFrame: frame }),
  z.object({ t: z.literal('desync'), frame, detail: z.string().max(200) }),
  z.object({ t: z.literal('pong'), pt: z.number(), now: z.number() }),
  z.object({ t: z.literal('error'), message: z.string().max(200) }),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;

/** Parse + validate an inbound client->server message; null if invalid. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  // generous cap: leaderboard submissions carry a whole run's RLE inputs
  if (typeof raw !== 'string' || raw.length > 262_144) return null;
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
  // generous cap: replay payloads carry a whole race's RLE input streams
  if (typeof raw !== 'string' || raw.length > 1_048_576) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const res = ServerMsgSchema.safeParse(json);
  return res.success ? res.data : null;
}
