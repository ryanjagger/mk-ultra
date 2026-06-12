# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install                 # workspace install (pnpm monorepo)
pnpm build                   # client (vite) + server (esbuild → dist/index.cjs)
pnpm test                    # all tests (vitest; sim + server packages)
pnpm typecheck               # strict tsc across all packages
pnpm start                   # run built server on :8080 (serves client + WS)

# single package / single test
pnpm --filter @mk/sim test
cd packages/sim && pnpm exec vitest run test/rollback.test.ts
cd packages/sim && pnpm exec vitest run test/fixed.test.ts -t 'divides'

# dev mode (client HMR on :5173, /ws proxied to the server on :8080)
pnpm --filter @mk/server dev     # terminal 1
pnpm --filter @mk/client dev     # terminal 2

# deploy (Railway service "mk-ultra", Dockerfile build; repo is railway-linked)
railway up --service mk-ultra --detach -m "<summary>"
```

Browser E2E: append `?bot` to the URL for a self-driving client; create/join rooms in two tabs and the race runs itself. The `window.__mk = { controller }` debug hook is set during races. F3 toggles the netcode overlay.

## The one constraint that dominates everything

This is a rollback-netcode game: every client simulates the same race and must stay **bit-identical**. The `sim` package is the deterministic core — Q16.16 fixed-point integers only, no floats, no `Math.sin/cos/random`, no `Date`/timers/DOM, no `Map`/`Set` in state, fixed iteration order everywhere. This is enforced mechanically by `packages/sim/test/determinism-lint.test.ts`, which scans sim sources for banned constructs (`fixed.ts` is the single vetted exception for `Math.sqrt/floor/round/trunc` and `/`). The full checklist is in README.md.

Practical consequences when touching sim code:

- All mutable state lives in the fixed-layout `Int32Array` snapshot (`state.ts` write/read/hash). If you add a state field and don't snapshot it, rollback silently corrupts — "if it isn't snapshotted, it doesn't exist."
- The per-tick evaluation order in `sim.ts` (karts by index, item use then physics → kart pairs i<j → walls → boost pads → checkpoints → item pickups → shells → oil slicks → phase) and the PRNG consumption order are part of the protocol. Changing them is a sim change, not a refactor.
- `fxConst()` is for compile-time numeric literals only, never runtime data. Render code converts with `fxToFloat()` and never feeds floats back.
- Wide integer math (`wideDot`/`wideCross`, raw products) is exact only because world coords are clamped to ±400 units (< 2^26 raw). Keep track geometry inside that bound.
- The M2/M4 gates (`determinism.test.ts`, `rollback.test.ts`) are hard gates; they run headless in Node, which is the cross-platform claim.

## Architecture

```
packages/sim     deterministic core + rollback engine. Zero deps, zero DOM/Node
                 globals (tsconfig types:[] enforces). Runs identically in
                 browser and Node — all game rules live here.
packages/shared  Zod wire protocol. Validated at BOTH ends (server validates
                 client msgs, client validates server msgs). Cannot depend on sim.
packages/server  ws room/relay server. NEVER simulates and NEVER sends world
                 state — it relays input frames (first-write-wins per
                 player+frame, single serialization point), resolves 'random'
                 track picks, and cross-checks client state hashes (desync
                 detector, broadcasts frame-numbered alerts). Also serves the
                 built client. Bundles to one CJS file via esbuild.
packages/client  Vite + Three.js. Renderer READS sim state only. RaceController
                 (game.ts) owns the RollbackSession, paces the sim against
                 ping-synced server time, sends inputs + confirmed hashes.
```

**Netcode model** (`sim/src/rollback.ts`): local input applies the same frame with zero delay; missing remote inputs are predicted by repeating that player's last known input; corrections restore a snapshot and re-simulate. Prediction is capped at 16 frames — beyond that the client stalls (while still broadcasting bounded look-ahead inputs so the stall doesn't cascade to peers). Only inputs cross the wire. Clients hash fully-confirmed frames every 30 frames (`HASH_INTERVAL`) for the server to compare.

**Track system**: tracks are pure data in `sim/src/track-defs.ts` (CCW integer-grid centerline with per-vertex asphalt half-width + dirt margin, checkpoint/item verts, boost pads, render-only theme). `buildTrack()` derives everything in fx ops at module init. Two corridors per track: **asphalt** (`inner`/`outer` — items, pads, start-line rendering) and **fence** (`fenceInner`/`fenceOuter` — walls and checkpoint gates, so dirt can't bypass checkpoints). Dirt slows karts unless boosting; boost pads are stateless. `RaceConfig.trackId` is optional and defaults to the classic track (keeps test fixtures simple).

**Adding a track**: add a `TrackDef` to `track-defs.ts`, nothing else. Two test gates must pass: `tracks.test.ts` (no self-intersecting loops — watch wide dirt at sharp corners, since miter offsets fold; spawns/items/pads on asphalt; world bound) and the all-tracks bot race in `determinism.test.ts` — the greedy bot steers at the *next gate center* with no lookahead, so every layout must be completable that way (add intermediate gates on tight sections).

**Client subtleties**: audio is fully synthesized Web Audio (`audio.ts`) — it reads sim state like the renderer (one-shots fire on state transitions diffed per frame) and is unlocked lazily on the first user gesture; M or the HUD speaker mutes. A Web Worker heartbeat in `main.ts` keeps the sim advancing in hidden tabs (RAF stops there; without it, hidden tabs stall every peer at the prediction window — do not remove). The scene world is a swappable, fully-disposed THREE.Group per track; the authoritative race track is always `raceStart.trackId` (server resolves 'random'), never lobby state. Kart index == seat index, locked at race start; mid-race disconnects become neutral-confirmed inputs from a server-chosen frame so all clients agree.

## Testing patterns

- Sim tests construct synthetic tracks with `buildTrack(def)` directly (not via the registry) and assemble states by spreading `createGameState` — see `elements.test.ts`.
- Input streams for determinism tests are generated from the sim's own PRNG so the tests themselves are cross-engine deterministic; test-side float math is fine, sim-side is not.
- `server/test/integration.test.ts` runs real WebSocket clients (headless `RollbackSession`s) against the actual server — use its `TestClient` as the template for new protocol tests.
- Bit-identity across refactors: capture a golden hash before (run a chaos sim, log `hashState`), compare after. Run-vs-run determinism is already covered by the suite; version-vs-version is not, so server+client must always deploy together (they do — single container).

## BrainLift (learning log)

`BRAINLIFT.md` is a daily learning log: per-day entries with **Progress**,
**AI interactions that accelerated learning**, and **Challenges → solutions**.
At the end of a working session (or when the user asks), update today's entry
via the `/brainlift` command — anchor Progress to real commits, write
root-cause (not symptom) for challenges, and never pad. Bug hunts with a
non-obvious root cause (e.g. the shell wall-tunneling fix) belong here.

## Commit Conventions

- Use Conventional Commits: `<type>(<scope>): <subject>`
- Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `style`, `build`, `ci`
- Scope is the package or area touched (e.g. `api`, `web`, `shared`)
- Subject: imperative mood ("add", not "added"), ≤50 chars, no trailing period
- Body (when needed): blank line after subject, wrap at 72 chars, explain *why* not *what*
- Breaking changes: add `!` after type/scope and a `BREAKING CHANGE:` footer
- Skip the body for small, obvious changes; reserve prose for non-obvious decisions

## Branch & PR Practices

- Keep PRs small and reviewable; split mechanical changes (renames, moves) from logic changes
- Branch naming mirrors commit types: `feat/oauth-consent-screen`, `fix/token-double-submit`
- Keep branches short-lived; sync with main frequently to avoid drift
- Break large features into incrementally-mergeable pieces rather than one long-lived branch
