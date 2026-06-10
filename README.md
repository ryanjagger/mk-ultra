# MK ULTRA

Browser-based 4-player kart racer with **rollback netcode** over a
deterministic fixed-point simulation. Three.js rendering, WebSocket input
relay, zero local input delay.

## Quick start

```bash
pnpm install
pnpm build          # builds client (vite) + server (esbuild bundle)
pnpm start          # serves the game on :8080
```

Open `http://localhost:8080` in two browser tabs (or machines), create a room
in one, join by code (or the public list) in the other, ready up, race.

Dev mode (client HMR on :5173 proxying /ws to the server on :8080):

```bash
pnpm --filter @mk/server dev   # terminal 1
pnpm --filter @mk/client dev   # terminal 2
```

Tests (the determinism + rollback gates run headless in Node):

```bash
pnpm test
```

Controls: **WASD / arrows** drive, **Space/Shift** drift (hold to charge a
mini-boost; release to fire). **F3** toggles the netcode debug overlay.
Append `?bot` to the URL for a self-driving client (used by E2E tests).

## Architecture

```
packages/
  sim/      deterministic core: Q16.16 fixed point, table trig, PRNG,
            physics, the track registry (4 tracks: variable width, dirt
            margins, boost pads, themes), checkpoints/laps, items,
            snapshots/hashing, and the rollback engine. Zero DOM/Node deps.
            All game rules live here and run bit-identically in browser + Node.
  shared/   wire protocol (Zod-validated on both ends)
  server/   WebSocket room/relay server + desync detector + static hosting.
            Relays inputs only — never world state. Resolves 'random' track
            picks and enforces host-only track changes.
  client/   Vite + Three.js renderer (reads sim state, never writes it),
            themed per-track scenes, lobby/HUD UI, clock sync, input capture.
```

**Tracks** are pure data (`sim/src/track-defs.ts`): a CCW centerline with
per-vertex asphalt half-width and dirt margin, checkpoint/item vertices,
boost pads and a render-only theme. `buildTrack` derives asphalt edges, the
dirt fence (walls + full-corridor checkpoint gates), item/pad placements —
all in fx math, so geometry is bit-identical everywhere. Driving on dirt is
slow (unless boosting); `sim/test/tracks.test.ts` rejects self-intersecting
or unfinishable layouts at build time.

**Topology:** server-relayed inputs (one socket per client, server is the
single serialization point for input order and the hash cross-checker).
**Tick rate:** 60Hz fixed timestep, render decoupled & interpolated.
**Rollback window:** 8 frames (~133ms); beyond that the sim stalls rather
than mispredict further. Local input is applied the frame it happens
(no input delay); remote gaps are predicted by repeating the last input
and corrected by snapshot restore + re-simulation.

**Desync detection (NFR-17):** every 30 confirmed frames each client sends an
FNV-1a hash of its full state snapshot; the server compares and broadcasts a
frame-numbered desync alert on mismatch (loud red banner + console).

## Determinism checklist (NFR-6)

The sim package must obey all of these — enforced mechanically by
`packages/sim/test/determinism-lint.test.ts` plus the M2 gate tests:

1. **No floats in sim state or sim math.** Everything is Q16.16 fixed point
   (`fixed.ts`); float conversion exists only at the render boundary
   (`fxToFloat`) and for compile-time constants (`fxConst`).
2. **No `Math.sin/cos/tan/pow/exp/...`** — trig is a committed integer
   lookup table (`trig.ts`); `Math.sqrt` only seeds an exact integer sqrt
   whose fix-up loops make the result exact regardless of rounding.
3. **No `Math.random()`** — only the seeded mulberry32 PRNG, whose state is
   part of the snapshot (NFR-3).
4. **No wall-clock anything**: no `Date`, `performance`, timers (NFR-2).
5. **No DOM/Node globals** in sim (`types: []` in its tsconfig enforces it).
6. **No `Map`/`Set` in sim state, no default `.sort()`** — all iteration is
   over arrays in fixed index order; sorts pass total-order comparators
   (NFR-4).
7. **Magnitude contract:** world coords stay within ±400 units so wide
   integer products stay below 2^53 and are exact in doubles (positions are
   clamped to this).
8. **Fixed evaluation order** inside a tick: karts by index → kart pairs
   (i<j) → walls by index → boost pads (kart-major, pads by index) →
   checkpoints → items → phase. PRNG consumption order is part of the
   protocol.
9. **Snapshot completeness:** every mutable sim variable lives in the
   fixed-layout `Int32Array` snapshot (if it isn't snapshotted, it doesn't
   exist). Save/restore is a flat copy; hashes are FNV-1a over those bytes.
10. **Inputs are the only inter-client data.** World state never crosses the
    wire (NFR-13); first server arrival wins for any (player, frame) input.

## Decision record (M1)

- **Fixed point:** hand-rolled Q16.16 (no library dependency for the one
  thing that must never drift). Multiplication splits into 16-bit halves so
  partials stay exact; division uses IEEE `/` on exact integers (exactly
  specified by ES); sqrt is exact integer fix-up; one BigInt ratio
  helper for collision projections.
- **Tick rate / window:** 60Hz, 8-frame rollback window, zero added input
  delay (the PRD tuning lever of +1-2 frames is left at zero).
- **Topology:** server-relayed inputs over WebSockets — anti-cheat-friendly
  (central hash check), one socket per client, no STUN/TURN. The relay hop
  latency is exactly what rollback hides. WebTransport is the upgrade path
  if TCP head-of-line blocking ever bites.
- **Input:** keyboard only (v1); input frames are 5-bit masks, so gamepad is
  just another mask source later.
- **Laps:** 3 by default, configurable 1–9 in room creation.

## Milestone verification map

| Milestone | Verified by |
|---|---|
| M1 fixed point/PRNG | `sim/test/fixed|trig|prng.test.ts` |
| M2 determinism gate | `sim/test/determinism.test.ts` (identical hash streams, snapshot round-trip, full bot race ×2) |
| M3 rendering separation | renderer only reads state; `?bot` E2E drives the real UI |
| M4 rollback | `sim/test/rollback.test.ts` (delayed/reordered → oracle-identical hashes, stalls, drops) |
| M5 two players | `server/test/integration.test.ts` (real WS server, bit-identical finish, induced desync detected with frame number) |
| M6 four players + race structure | 4-player jitter test + bot race placements + lobby/rooms/countdown/results in client |
| M7 items | deterministic PRNG-jittered respawns; covered by the determinism gate (seeds diverge) |

## Deploy

Dockerfile builds the workspace and ships a single bundled `server.cjs` +
static client. Deployed on Railway: `railway up --service mk-ultra`.
The server listens on `$PORT` (default 8080) and serves `/healthz`.
