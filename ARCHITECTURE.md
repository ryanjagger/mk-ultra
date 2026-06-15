# Architecture

MK ULTRA is a browser-based 4-player kart racer built on **rollback netcode**
over a **deterministic fixed-point simulation**. Every client runs the same
race locally and stays bit-identical; only player inputs cross the wire. This
document explains how the pieces fit together and why.

> For build/run commands and controls, see [README.md](README.md). For the
> rules of working inside the deterministic core, see [CLAUDE.md](CLAUDE.md).

## The idea in one paragraph

There is no authoritative game server. Each client owns a full copy of the
simulation and advances it at a fixed 60Hz. Local input is applied the instant
it happens (zero input delay); inputs from other players arrive over a
WebSocket relay a fraction of a second late, so the client *predicts* them by
repeating each player's last known input. When the real inputs arrive and
contradict a prediction, the client restores a snapshot from that frame and
re-simulates forward to the present — fast enough that the player only sees a
small visual correction, absorbed by render interpolation. Because the
simulation is deterministic, every client that feeds in the same inputs lands
on the exact same state, frame for frame. The server's only jobs are to relay
inputs in a single agreed order and to cross-check state hashes for desync.

## Package layout

A pnpm workspace of four packages with a strict dependency direction:

```
packages/
  sim/      deterministic core + rollback engine. Zero dependencies, zero
            DOM/Node globals (tsconfig `types: []` enforces it). All game
            rules live here and run bit-identically in browser and Node.
  shared/   Zod wire protocol, validated at BOTH ends. Depends on nothing
            (notably NOT on sim — track ids are validated shape-only here and
            checked against the sim registry by each end).
  server/   ws room/relay server + desync detector + verified leaderboards +
            static client hosting. Relays inputs only; never simulates live.
  client/   Vite + Three.js. Renderer/audio READ sim state, never write it.
            Owns the RollbackSession, clock sync, input capture, and UI.
```

```
        ┌─────────┐
        │   sim   │  (no deps)
        └────┬────┘
   ┌─────────┼──────────┐
   │         │          │
client    server     (tests)        shared  (no deps, no sim)
   │         │                          ▲
   └─────────┴──────────────────────────┘
        both validate every message with shared's Zod schemas
```

`sim` is the trunk: both `client` and `server` import game constants and the
simulation from it. `shared` is deliberately sim-free so the wire protocol can
be validated without pulling in the engine; track ids are typed as opaque
strings there and resolved against `sim`'s registry by whoever received them.

## The one constraint that dominates everything: determinism

Because clients exchange only inputs and each re-simulates independently, the
simulation must be **bit-identical** across machines, browsers, and Node. A
single divergent bit anywhere compounds into a different race. The entire `sim`
package is written to a determinism contract, enforced mechanically by
`packages/sim/test/determinism-lint.test.ts` (which scans sim sources for
banned constructs) plus the M2/M4 gate tests.

### Determinism checklist (NFR-6)

1. **No floats in sim state or sim math.** Everything is Q16.16 fixed point
   (`fixed.ts`); float conversion exists only at the render boundary
   (`fxToFloat`) and for compile-time constants (`fxConst`). `fxConst()` is for
   literals only, never runtime data.
2. **No `Math.sin/cos/tan/pow/exp/...`** — trig is a committed integer lookup
   table (`trig.ts`); `Math.sqrt` only seeds an exact integer sqrt whose fix-up
   loops make the result exact regardless of rounding. `fixed.ts` is the single
   vetted exception that may call `Math.sqrt/floor/round/trunc` and `/`.
3. **No `Math.random()`** — only the seeded mulberry32 PRNG (`prng.ts`), whose
   state is part of the snapshot (NFR-3).
4. **No wall-clock anything**: no `Date`, `performance`, or timers (NFR-2).
5. **No DOM/Node globals** in sim (`types: []` in its tsconfig enforces it).
6. **No `Map`/`Set` in sim state, no default `.sort()`** — all iteration is
   over arrays in fixed index order; sorts pass total-order comparators (NFR-4).
7. **Magnitude contract:** world coords stay within ±400 units so wide integer
   products stay below 2^53 and are exact in doubles (positions are clamped to
   this). `wideDot`/`wideCross` and raw products are exact only because of this.
8. **Fixed evaluation order** inside a tick: karts by index (item use, then
   physics) → kart pairs (i<j) → walls by index → boost pads (kart-major, pads
   by index) → checkpoints → item pickups → shells → oil slicks → phase. PRNG
   consumption order is part of the protocol — changing it is a sim change.
9. **Snapshot completeness:** every mutable sim variable lives in the
   fixed-layout `Int32Array` snapshot. "If it isn't snapshotted, it doesn't
   exist." Save/restore is a flat copy; hashes are FNV-1a over those bytes.
10. **Inputs are the only inter-client data.** World state never crosses the
    wire (NFR-13); first server arrival wins for any (player, frame) input.

### The deterministic core (`sim`)

| Module | Responsibility |
|---|---|
| `fixed.ts` | Q16.16 fixed-point arithmetic. The single vetted exception for `Math.*` and `/`. |
| `trig.ts` | Committed integer trig lookup table (no `Math.sin/cos`). |
| `prng.ts` | Seeded mulberry32; its state lives in the snapshot. |
| `input.ts` | 6-bit input masks (drive bits + `BTN_ITEM`). |
| `state.ts` | `GameState`, the flat `Int32Array` snapshot, write/read/`hashSnapshot` (FNV-1a). |
| `physics.ts` | Kart physics: steering, drift/mini-boost, slopes & ramp jumps, dirt, drafting, collisions. |
| `items.ts` | Mystery boxes, placement-weighted rolls, shells, oil slicks, lightning, boosts, spin-outs. |
| `track.ts` / `track-defs.ts` | Track registry: data-only `TrackDef`s, `buildTrack()` derives geometry in fx math. |
| `race.ts` | Lap/checkpoint progress, placements (`computePlacements`). |
| `bots.ts` | Greedy CPU steering (`botMask`), computed from state — identical on every client, never on the wire. |
| `sim.ts` | `stepSim`: one tick. Owns the protocol-defining evaluation order. |
| `rollback.ts` | `RollbackSession`: prediction, snapshot ring, rollback/re-simulate, stall. |

All mutable state is plain int32 fields serialized into a fixed-layout
`Int32Array`. A snapshot is a flat copy (cheap to take every frame); the state
hash is FNV-1a over those bytes.

## Netcode model (`sim/src/rollback.ts`)

`RollbackSession` is a GGPO-style rollback engine — transport-agnostic and
Node-testable (the netcode tests run headless, no sockets).

- **Local input** applies at the current frame with **zero delay** (NFR-9). The
  PRD's optional +1–2 frame input-delay tuning lever is left at zero.
- **Missing remote inputs** are predicted by repeating that player's last
  confirmed input.
- **Corrections**: when a real input arrives for a past frame that contradicts
  the prediction, the session restores the snapshot at that frame and
  re-simulates to the present (NFR-11). Snapshots live in a ring of 512.
- **Prediction cap**: 16 frames (~266ms) past the oldest unconfirmed remote
  input (`DEFAULT_MAX_PREDICTION`). Beyond that the client **stalls** rather
  than mispredict further (NFR-10) — while still broadcasting bounded
  look-ahead inputs so the stall doesn't cascade to peers.

Why 16 frames: the steady-state demand is the full input path (sender half-RTT
+ relay + receiver half-RTT + batching) in ticks — ~9 frames at 90ms pings —
and the sim rides the stall wall whenever demand exceeds the cap, so the cap
needs real headroom over a typical path. Corrections that deep are still cheap
to re-simulate and are visually absorbed by render smoothing.

**Tick rate**: 60Hz fixed timestep; rendering is decoupled and interpolated.

## Wire protocol & topology (`shared`, `server`)

**Only inputs cross the wire** (NFR-13). The topology is server-relayed inputs:
one WebSocket per client, and the **server is the single serialization point**
for input order. The server **never runs the live simulation** and never sends
world state.

- **Input relay**: clients send `{t:'input', f, m, r}` — frame, 6-bit mask, and
  up to `INPUT_REDUNDANCY` (10) redundant prior masks newest-first. The server
  applies **first-write-wins** per `(player, frame)` and rebroadcasts. Redundant
  masks let a dropped message heal on the next one instead of freezing the
  sender's confirmed frontier.
- **Desync detection (NFR-17)**: every `HASH_INTERVAL` (30) fully-confirmed
  frames, each client sends an FNV-1a hash of its full snapshot. The server
  compares and broadcasts a frame-numbered `desync` alert on mismatch (loud red
  banner + console). This is the only thing the server inspects about game
  state — it can't read it, only compare hashes.
- **Validation at both ends (NFR-16)**: `shared/src/protocol.ts` defines Zod
  schemas for every client→server and server→client message. The server
  validates inbound client messages; the client validates inbound server
  messages. `parseClientMsg` / `parseServerMsg` reject malformed or oversized
  payloads.
- **Room/lobby control** (`server/src/rooms.ts`): create/join by 4-char code or
  public list, ready-up, host-only track/laps/mode/cup/public changes, bots,
  start, and disconnect handling. Kart index == seat index, locked at race
  start. A mid-race disconnect becomes neutral-confirmed inputs from a
  server-chosen frame (`dropped` message) so every client agrees on the gap.
- **'random' track resolution**: the server picks the concrete track id at race
  start so `raceStart.trackId` is always a real registry id, never lobby state.

The server **does** run the simulation in exactly one place: **offline
verification of time-trial submissions** (`server/src/leaderboard.ts`), never
the live race relay. See [Game modes](#game-modes--meta-features) below.

## Track system

Tracks are **pure data** in `sim/src/track-defs.ts` (7 tracks): a CCW
integer-grid centerline with per-vertex asphalt half-width and dirt margin,
checkpoint/item vertices, boost pads, optional elevation, and a render-only
theme. `buildTrack()` derives everything in fx ops at module init, so geometry
is bit-identical everywhere.

Each track has **two corridors**:

- **asphalt** (`inner`/`outer`) — item boxes, boost pads, start-line rendering.
- **fence** (`fenceInner`/`fenceOuter`) — walls and checkpoint gates, so a kart
  cutting across dirt still can't bypass a checkpoint.

Driving on dirt slows karts unless boosting; boost pads are stateless.
`RaceConfig.trackId` is optional and defaults to the classic track (keeps test
fixtures simple).

**Adding a track**: add a `TrackDef` and nothing else. Two gates must pass —
`tracks.test.ts` (no self-intersecting loops; spawns/items/pads on asphalt;
world bound) and the all-tracks bot race in `determinism.test.ts`. The greedy
bot steers at the next gate center with no lookahead, so every layout must be
completable that way — add intermediate gates on tight sections. Watch wide
dirt at sharp corners, since miter offsets fold.

## Client architecture (`client`)

The renderer and audio **only read** sim state (NFR-7); they never mutate it.

- **`game.ts` — `RaceController`** owns the `RollbackSession`, paces the sim
  against ping-synced server time, feeds local input with zero delay, relays
  inputs + confirmed-state hashes, and exposes interpolated `KartRender` state.
  It implements a `RaceLike` interface shared with the offline
  `TimeTrialController` so the HUD/renderer/audio consume one surface.
- **`clock.ts` — `ClockSync`** ping-syncs to server time so all clients agree on
  the race start instant and the current frame.
- **`net.ts`** is the WebSocket transport; **`keyboard.ts`** captures keyboard +
  gamepad into a single OR-merged input mask per frame.
- **`scene.ts`** is the Three.js renderer. The world is a swappable, fully
  disposed `THREE.Group` per track; the authoritative track is always
  `raceStart.trackId`, never lobby state.
- **`audio.ts`** is fully synthesized Web Audio — it reads sim state like the
  renderer (one-shots fire on per-frame state transitions diffed each frame),
  unlocks lazily on the first user gesture, and mutes via M / the HUD speaker.
- **`main.ts`** wires everything together and runs a **Web Worker heartbeat**
  that keeps the sim advancing in hidden tabs. `requestAnimationFrame` stops in
  background tabs; without the heartbeat a hidden tab would stall every peer at
  the prediction window. Do not remove it.

Render-only client features layer on top: `terrain.ts`, `sponsors.ts`,
`icons.ts` (Phosphor UI chrome), `cosmetics.ts`/`profile.ts`/`progression.ts`
(local XP, liveries, flame colors — cosmetic only, never affects kart
performance), `ghosts.ts`/`timetrial.ts`/`replay.ts`.

Append `?bot` to the URL for a self-driving client (used by E2E tests); add
`&lag=90&jitter=30` to simulate RTT/jitter per-tab. `window.__mk = { controller }`
is a debug hook set during races; **F3** toggles the netcode overlay.

## Game modes & meta features

- **Quick race / rooms** — create or join a room, race, results, rematch.
- **Grand Prix cups** — a multi-race points series. Points travel with the seat
  across races; the server learns results from the first client to report
  `raceEnded` placements (all clients agree when in sync; the server never
  simulates the race to find out).
- **Battle mode** — no laps; every kart carries balloons, hits pop them, last
  kart flying wins (`BATTLE_BALLOONS`, `BATTLE_TICKS`).
- **Time trials + verified leaderboards** — a leaderboard submission is the
  *input recording* (RLE-encoded), not a claimed time. The server re-simulates
  it through `stepSim` under the fixed `TT_SEED` and stores the time the sim
  computes, not the time the client claims. **Cheat-proof by determinism**: a
  forged time would require a forged input stream that actually drives that
  fast. Storage is one JSON file under `DATA_DIR` (mount a volume in prod), top
  10 per `(trackId, laps)`, best run per name. Ghost karts replay top entries.
- **Replays** — `getReplay` returns the last finished race as data: seed + track
  + per-kart RLE input streams. Deterministic sim + inputs = the exact race,
  re-rendered with no stored world state.

## Decision record (M1)

- **Fixed point**: hand-rolled Q16.16 (no library dependency for the one thing
  that must never drift). Multiplication splits into 16-bit halves so partials
  stay exact; division uses IEEE `/` on exact integers (exactly specified by
  ES); sqrt is exact integer fix-up; one BigInt ratio helper for collision
  projections.
- **Tick rate / window**: 60Hz, 16-frame rollback window, zero added input
  delay.
- **Topology**: server-relayed inputs over WebSockets — anti-cheat-friendly
  (central hash check), one socket per client, no STUN/TURN. The relay hop
  latency is exactly what rollback hides. WebTransport is the upgrade path if
  TCP head-of-line blocking ever bites.
- **Input**: input frames are 6-bit masks (drive bits + `BTN_ITEM`), so keyboard
  and gamepad are just two mask sources OR-merged per frame — adding gamepad
  support (v2) touched zero sim or protocol code.
- **Laps**: 3 by default, configurable 1–9 in room creation.

## Milestone verification map

| Milestone | Verified by |
|---|---|
| M1 fixed point/PRNG | `sim/test/fixed\|trig\|prng.test.ts` |
| M2 determinism gate | `sim/test/determinism.test.ts` (identical hash streams, snapshot round-trip, full bot race ×2) |
| M3 rendering separation | renderer only reads state; `?bot` E2E drives the real UI |
| M4 rollback | `sim/test/rollback.test.ts` (delayed/reordered → oracle-identical hashes, stalls, drops) |
| M5 two players | `server/test/integration.test.ts` (real WS server, bit-identical finish, induced desync detected with frame number) |
| M6 four players + race structure | 4-player jitter test + bot race placements + lobby/rooms/countdown/results in client |
| M7 items | `sim/test/items.test.ts` (mystery boxes, placement-weighted rolls, shells, oil slicks, spin-outs) + PRNG-jittered respawns covered by the determinism gate |

## Build & deploy

The Dockerfile builds the whole workspace and ships a single bundled
`server.cjs` (esbuild) plus the static client (vite). Deployed on Railway:
`railway up --service mk-ultra`. The server listens on `$PORT` (default 8080)
and serves `/healthz`. Live at <https://mkultra.jagger.lol>.

**Server and client always deploy together** in the single container, so the
wire protocol and sim version can never skew between peers. This matters
because run-vs-run determinism is covered by the test suite but
*version-vs-version* is not — two peers on different builds could diverge, and
the single-container coupling makes that impossible in production.
