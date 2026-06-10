# MK Ultra Racer — Product Requirements Document

**Status:** Draft (v1 scope)
**Owner:** Ryan
**Last updated:** 2026-06-08

---

## 1. Overview

A browser-based multiplayer kart racer with an arcade, Mario Kart–style feel, synchronized with **rollback netcode**. Up to 4 players race in real time, rendered in 3D, using original assets only.

## 2. Motivation

Browser multiplayer racers almost universally use server-authoritative snapshot interpolation. That model is forgiving but puts remote players slightly in the past and adds input delay. Rollback instead gives zero input delay for the local player and the crispest competitive feel, at the cost of a hard determinism requirement across the entire simulation.

## 3. Users & context

A small-scale, friends-in-a-room product: players create or join a private room by code and race. Public matchmaking on home screen. Desktop browser, keyboard input (v1).

## 4. Goals

- Deterministic fixed-point simulation producing bit-identical results from identical inputs, across machines and in Node.
- Working rollback: zero input delay locally, prediction + correction for remote players, recovery from delayed/reordered inputs.
- 2–4 players racing one track in real time from separate tabs/machines, staying in sync for a full race.
- Hard architectural separation between the deterministic sim and the (float-based) rendering layer.
- Every milestone independently runnable and testable.

## 5. Non-goals (v1)

- More than 4 players.
- Mobile, touch, or gamepad input.
- User accounts.
- Anti-cheat hardening beyond what the chosen topology naturally provides.

## 6. Functional requirements

### Gameplay & physics
- **FR-1** Arcade kart control: acceleration, brake/reverse, steering.
- **FR-2** Drift with a mini-boost: charge while drifting, release for a speed burst.
- **FR-3** Collision resolution for kart↔wall and kart↔kart. Simple, arcade-style.
- **FR-4** All physics, collision, and movement computed in fixed-point in the sim layer.

### Race structure
- **FR-5** One 3D track, geometrically simple, with walls and several turns.
- **FR-6** Checkpoint system validating that a player followed the route (can't skip/shortcut).
- **FR-7** Lap counting with a configurable lap count.
- **FR-8** Finish detection and final placement ordering.

### Session & lobby
- **FR-9** Create a room and receive a join code.
- **FR-10** Join a room by code.
- **FR-11** Ready-up flow; race starts when all players ready (or host starts).
- **FR-12** Deterministic, seeded countdown synchronized across clients.
- **FR-13** Results screen showing finishing order.

### Items
- **FR-14** One pickup type (speed boost) that spawns on the track.
- **FR-15** Pickup spawning and all randomness driven by the seeded deterministic PRNG.
- **FR-16** Item system structured so additional item types can be added later without rework.

## 7. Non-functional / technical requirements

### Determinism (the dominant constraint)
- **NFR-1** No native floating point in the sim. Fixed-point integer math for all physics, collision, and state. (Specific approach is an open question — see §11.)
- **NFR-2** Sim layer has zero dependency on DOM, Three.js, Node-specific globals, wall-clock time, or `Date`.
- **NFR-3** No `Math.random()` in the sim — seeded deterministic PRNG only.
- **NFR-4** No dependence on `Map`/`Set` iteration order; deterministic ordering everywhere.
- **NFR-5** Sim runs bit-identically in the browser and in Node, so tests run in Node/CI.
- **NFR-6** A determinism checklist the sim must obey, documented in the repo.

### Rendering separation
- **NFR-7** Rendering reads from sim state and never writes to it. Floats are fine for display and interpolation.

### Rollback engine
- **NFR-8** Fixed timestep at a defined tick rate (open question — likely ~60Hz).
- **NFR-9** Input prediction (repeat last input) when a remote input hasn't arrived; no local input delay.
- **NFR-10** Ring buffer of saved states + inputs spanning the max rollback window (window size is an open question).
- **NFR-11** On a corrected input: restore the saved state at that frame, re-apply correct inputs, re-sim to the present within one frame budget.
- **NFR-12** Full sim state serializable to a compact snapshot; save/restore must be cheap.
- **NFR-13** Only inputs go over the wire — never world state.

### Networking & transport
- **NFR-14** Topology is an open decision (P2P GGPO-style lockstep vs. a server relaying inputs), to be recommended with reasoning given 4 players + anti-cheat tractability.
- **NFR-15** Input frame format and sync/handshake messages defined in `shared/` as typed messages.
- **NFR-16** All inbound network messages validated at the boundary (Zod) before the sim trusts them.

### Observability & debug
- **NFR-17** Desync detector built early: clients periodically exchange state hashes; mismatches log loudly with the diverging frame.

### Stack & repo
- **NFR-18** TypeScript `strict: true` everywhere.
- **NFR-19** pnpm monorepo — suggested packages `sim/`, `client/`, `server/`, `shared/` (adjust per topology choice).
- **NFR-20** Vite for the client build.
- **NFR-21** Three.js for 3D rendering.

## 8. Milestones

Each milestone is independently runnable, and the listed exit criterion must hold before moving on.

| # | Milestone | Scope | Done when |
|---|-----------|-------|-----------|
| **M1** | Foundations | `sim/` skeleton, fixed-point type + unit tests, deterministic PRNG, determinism checklist in README | Fixed-point math tested; fixed-point approach, tick rate, and topology decided |
| **M2** | Deterministic sim | One kart, arcade physics, one track, advanced by input frames | **Determinism test passes**: same seed + input sequence run twice (and in Node) → bit-identical state hashes. Hard gate — nothing proceeds until green |
| **M3** | Rendering | Three.js scene reads sim state, renders kart on track, local input drives sim (single-player, no net) | Drivable locally; sim/render separation verified |
| **M4** | Rollback core | Ring buffer, prediction, rollback/re-sim loop, locally | A test that delays/reorders inputs converges to the same hashes as the no-delay run |
| **M5** | Two players | Chosen topology, input exchange, real rollback across two tabs | Two clients stay in sync over a race; induced desyncs are caught by the detector |
| **M6** | Four players + race structure | Scale to 4, lobby/rooms, checkpoints + laps, countdown, results | 4-player race start→finish with correct placements, staying in sync |
| **M7** | Items | Pickup + boost via deterministic RNG | Item spawn/pickup deterministic; re-sims identical |

## 9. Acceptance criteria

- Determinism test green in CI (the M2 gate).
- Delayed/reordered-input test converges to identical hashes (M4).
- Two and four browser clients complete a full race without desync; induced desyncs are detected and logged with frame numbers.
- Local input has no artificial delay — this is rollback, not delay-based netcode.
- Rollback re-simulation stays within one frame budget at 4 players on target hardware.
- No floats in the sim (enforced by review/lint), strict TS passes, all inbound network input is Zod-validated.

## 10. Risks & mitigations

- **R1 — JS/floating-point determinism is genuinely hard.** Fixed-point from day one; the determinism test is a hard gate (M2) before any netcode is written.
- **R2 — Rollback frame budget blows up at 4 players** (re-simming N frames every frame). Keep the sim cheap, cap the rollback window, and measure early; snapshot cost matters.
- **R3 — Fixed-point precision artifacts** (jerky movement, physics drift). Choose the scale factor carefully, unit-test the math, and tune.
- **R4 — Desyncs are brutal to debug without tooling.** Build the desync detector + state hashing early (M2/M5) with loud, frame-numbered logging.
- **R5 — Topology has anti-cheat and NAT implications.** Decide in M1 with explicit reasoning: P2P needs NAT traversal/signaling; a server relay centralizes that and helps anti-cheat.
- **R6 — 3D + rollback is the hardest combination of the choices made.** Keep track geometry simple in v1 so complexity lives in the netcode, not the track.

## 11. Decisions & recommendations (confirm in M1)

These are the expensive-to-reverse calls. Each has a recommended default plus rationale — treat them as the M1 starting position to confirm or override.

### Fixed-point approach — recommend: roll your own Q16.16 in pure TS

Store values as 32-bit integers with 16 fractional bits (Q16.16) — the de-facto standard for deterministic JS sims and the format GGPO-style ports and fixed-point 2D physics engines use. Own it rather than depend on a library because:

- The available JS/TS fixed-point libraries are mostly solo/hobby projects with thin track records — risky as the foundation for the one thing that must never drift.
- A kart sim's math surface is small (vectors, a handful of ops, sin/cos/sqrt) and worth controlling end to end, so snapshots are just plain integer state.

Two gotchas to design around:

- **Multiplication overflow.** Q16.16 × Q16.16 yields a 32.32 intermediate that exceeds the 2^53 safe-integer range before you shift back. Keep fractional bits modest, split the multiply, or use BigInt for the few wide ops (BigInt is slow — use sparingly).
- **Trig must be deterministic.** No `Math.sin`/`cos` (not guaranteed identical across engines). Use integer lookup tables at fixed angular resolution or a fixed-point CORDIC. `Math.sqrt` is safe — IEEE 754 requires it correctly rounded — but verify before relying on it.

**Alternative worth knowing about:** `@dimforge/rapier3d-deterministic`. Rapier ships a WASM build with documented bit-level cross-platform determinism and a built-in `world.createSnapshot()` (ideal for rollback save/restore), which works because WASM float ops are spec-required to be cross-platform deterministic. The catch: Rapier is a *rigid-body* engine, and arcade kart feel (snappy drift, not a sliding brick) tends to fight general rigid-body physics — which is why most kart games use custom arcade physics. Choosing it would revise **NFR-1** (deterministic floats in WASM, not fixed-point), and your own game logic (RNG, laps, items) still has to be deterministic regardless. Reach for it only if collision/physics turns out harder than the arcade scope suggests.

### Tick rate & rollback window — recommend: 60Hz sim, render decoupled, ~8-frame window

- **Sim at 60Hz**, fixed timestep, fully decoupled from render (render interpolates between the two latest sim states). 60Hz is the rollback norm and keeps collision integration fine enough that fast karts don't tunnel through walls.
- **Max rollback window ~8 frames (~130ms).** Beyond that, slow/stall rather than predict further — corrections past ~130ms feel bad anyway.
- **Tuning lever:** 1–2 frames (~16–33ms) of input delay sharply cuts rollback frequency and is essentially imperceptible. Standard GGPO practice, but it nuances **NFR-9** ("no local input delay") — pure-zero maximizes rollbacks. Start at zero, add a frame if rollbacks are visibly frequent.
- **Cheaper alternative:** 30Hz sim halves re-sim cost (fewer frames per rollback) and is viable since racing isn't frame-precise like fighting games — but you'll need swept/substepped collision to stop fast karts tunneling. Only worth it if the 60Hz re-sim budget at 4 players becomes a problem.

### Topology — recommend: server-relayed inputs (not P2P)

Clients send inputs to a small server; it timestamps/orders and fans them out; every client still runs the deterministic sim + rollback locally. Inputs only over the wire, never state.

Why over classic P2P/WebRTC:

- **Anti-cheat nearly for free.** Because the sim is deterministic and snapshot-able, the server can run it too and hash-check clients — desyncs/cheats are detectable centrally. P2P has no authority to do this.
- **Simpler connections.** One socket per client vs. a WebRTC mesh that needs signaling + STUN/TURN anyway (so "P2P = no server" is mostly false).
- **The latency cost is the thing rollback exists to hide.** The extra client→server→client hop is exactly what prediction/rollback absorbs.
- Easier reconnection, late-join spectators, and server-side replay recording later.

**Transport:** start on **WebSockets** (TCP) — universal and simple. Upgrade path if latency-under-loss bites is WebTransport (HTTP/3 / QUIC unreliable datagrams, no head-of-line blocking) with input redundancy — each packet re-sends the last few inputs so loss self-heals. WebTransport's browser support is still less universal than WebSocket, so don't lead with it.

**Honest alternative:** pure P2P is genuinely lower-latency and has off-the-shelf TS support (netplayjs, telegraph — both GGPO ports over WebRTC). If you don't care about server-side anti-cheat and want minimal infra, it's defensible. I'd still pick the relay for the anti-cheat property and simpler connections.

### Input scope — recommend: keyboard only for v1

Keyboard only, captured into the input frame. Gamepad (Gamepad API) is a small, clean post-v1 addition — just another source feeding the same input frame, so leaving room for it costs nothing now.

### Lap count — recommend: 3 (configurable)

3 laps is the genre default and a good demo length. FR-7 already makes it configurable; set 3 as the default and expose it in room settings.
