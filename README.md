# MK ULTRA

Browser-based 4-player kart racer with **rollback netcode** over a
deterministic fixed-point simulation. Three.js rendering, WebSocket input
relay, zero local input delay.

**Play it live:** <https://mkultra.jagger.lol> — create a room, share the
code (or use the public room list), race. Solo Time Trial works without a
second player.

Modes: quick race, **Grand Prix cups** (multi-race points series),
**battle mode** (balloon arena), and **time trials** with ghost karts and
server-verified leaderboards (submissions are input recordings the server
re-simulates — times can't be forged). A local driver profile earns XP from
placement and in-race feats, levelling up a garage of liveries and flame
colors; progression is cosmetic only and never touches kart performance.

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
mini-boost; release to fire), **E / Enter / Ctrl** use item. Gamepads work
too (standard mapping: A/RT accel, B/LT brake, LB/RB drift, X/Y item,
stick or d-pad steers). **M** mutes,
**F3** toggles the netcode debug overlay. Append `?bot` to the URL for a
self-driving client (used by E2E tests); add `&lag=90&jitter=30` to
simulate that much RTT on the tab's link.

## Architecture

The short version: a deterministic, fixed-point `sim` core runs identically on
every client; clients exchange only inputs over a WebSocket relay and use
**rollback** (predict missing inputs, snapshot-restore + re-simulate on
correction) to stay bit-identical with zero local input delay. The server
relays inputs and cross-checks state hashes — it never simulates the live race.

```
packages/sim      deterministic core + rollback engine (zero deps, browser + Node)
packages/shared   Zod wire protocol, validated at both ends
packages/server   WebSocket room/relay server + desync detector + static hosting
packages/client   Vite + Three.js renderer (reads sim state, never writes it)
```

**See [ARCHITECTURE.md](ARCHITECTURE.md)** for the full design: the determinism
contract, the rollback model, the wire protocol, the track system, the client
layout, game modes, the decision record, and the milestone verification map.

## Deploy

Dockerfile builds the workspace and ships a single bundled `server.cjs` +
static client. Deployed on Railway: `railway up --service mk-ultra`.
The server listens on `$PORT` (default 8080) and serves `/healthz`.
Live at <https://mkultra.jagger.lol>. Server and client always deploy
together (single container), so the wire protocol and sim version can
never skew between peers.
