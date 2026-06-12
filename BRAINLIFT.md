# BrainLift — mk-ultra

A running learning log for this project. One entry per working day, newest
first. Each entry has three sections:

- **Progress** — what actually shipped, anchored to commits/deploys.
- **AI interactions that accelerated learning** — the prompts, techniques and
  workflows with an AI pair that paid off (and the ones that didn't).
- **Challenges → solutions** — problem, root cause, fix. Written so future-me
  can pattern-match the failure, not just admire the fix.

Update it with the `/brainlift` slash command at the end of a session, or by
hand. Keep entries honest and specific — a short true entry beats a long
padded one.

---

## 2026-06-11

### Progress

- Graphics overhaul shipped and deployed (`f31067c`, deploy `0bac9c26`):
  item cubes became extruded shield badges (modeled from a reference image),
  a bloom pipeline (EffectComposer → UnrealBloomPass → OutputPass), pooled
  particle systems (tier-colored drift spark spray, boost ember trail, dirt
  dust), skid-mark decals, a radial speed-lines shader pass, spin-out camera
  shake, real per-track PCF shadows (fake blob shadow deleted), and ambient
  weather per theme — snow on Glacier, wind dust on Canyon, HDR fireflies +
  breathing neon pylons on Neon Gauntlet. All render-layer; the only sim
  edit is an optional render-only `TrackTheme.weather` string.
- Small UX fixes: menu screens no longer text-selectable (`45823aa`),
  morning session fixed password managers grabbing the room-code field and
  the drivetrain droning past the finish line.
- Verified the way items v2 was: bot races on all four tracks locally, then
  a production smoke race after each deploy.
- Hills (uncommitted, evening session): per-vertex track elevation with real
  slope physics — gravity along the height gradient, slope-shifted speed
  caps (climbs slow, descents fast, boost overrides) — plus a fifth track,
  Summit Pass, built to show it off. Renderer grew a float-side `Terrain`
  sampler, elevation-following ribbon meshes with cosine falloff aprons,
  slope-pitched walls/karts/pads, and a terrain-aware chase camera. Key
  design call: height is a *pure function of 2D position*, so no new
  snapshot fields, no protocol change, and the four flat tracks keep their
  v1 hashes (verified bit-identical before/after). 110 sim tests green;
  bot completes Summit Pass in 1:23 solo.

### AI interactions that accelerated learning

- **Bloom without re-tuning the art: threshold 1.0 + overdrive.** Setting the
  bloom threshold to exactly 1.0 means no normally-lit pixel can ever bloom —
  day tracks render identically to before — and anything that *should* glow
  is pushed into HDR (`color.multiplyScalar(2.2)`, emissive intensity > 2).
  One principle replaced what would have been per-material tuning across
  four themes.
- **The debug hook is a test harness.** TS `private` is compile-time only,
  so `window.__mk.controller.keyboard.sample = () => mask` drives the real
  kart through the real input path from the browser console. Drift sparks,
  skids and speed lines were all verified this way — no test scaffolding
  built, nothing committed.
- **Poll state, don't screenshot-roulette.** Timing screenshots against a
  racing kart wasted several rounds; polling `__mk` sim state (boostTicks,
  driftDir) from a shell loop and screenshotting on the transition caught
  the effect every time.
- **Flash lives in data, not code.** Weather became one optional render-only
  field on `TrackTheme` — the determinism lint, sim gates and protocol are
  untouched, and the next track gets atmosphere by adding one word.
- **Golden hashes before touching shared code paths.** Before refactoring
  `onDirt` into the shared surface probe, a throwaway test logged final
  state hashes for a bot race + chaos run per track; re-running after the
  refactor proved the existing tracks bit-identical. Cheap (20 lines,
  deleted afterwards) and it converts "should be equivalent" into "is".
- **Derive, don't store.** Asking "can hills avoid touching the snapshot?"
  up front led to the whole design: height as a function of (x, y) means
  rollback, the wire protocol and `state.ts` never learn hills exist. The
  feature that looked protocol-shaped turned out to be two functions in
  `physics.ts` plus data.

### Challenges → solutions

- **"I don't see the shield" — wrong artifact, not wrong code.** The change
  was verified on the Vite dev server, but the user was on `:8080`, which
  serves the last `pnpm build` — bundle mtime 17:09, source edit 17:26,
  server start 17:31 told the whole story. Fix: rebuild (the running server
  serves from disk, no restart needed). Lesson: with three copies of the
  client (dev :5173, built :8080, prod), check *which one* is being looked
  at before debugging the code.
- **Per-frame color writes clobber HDR setup.** The drift sparks were given
  an HDR color at construction, but the update loop re-`set()` the tier
  color every frame, silently dropping the multiplier. Caught only by
  reading the update path after editing the constructor. Lesson: an
  overdriven color must be applied at the *last* write site, not the first.
- **Effects the bot can't trigger are hard to verify.** The greedy autodriver
  never drifts, and open-loop scripted input (timed drift masks) kept
  pinning the kart on walls below `DRIFT_MIN_SPEED`, so nothing fired. What
  worked: a closed-loop sampler reading live sim state (auto-reverse when
  stuck), and finally just forcing `boostTicks` in local state — safe in a
  solo room because with no peers there are no rollbacks and no hash
  cross-checks. Lesson: solo-room state is freely pokeable for render-layer
  verification; multiplayer determinism rules don't apply to an audience of
  one.
- **Accel-based slope physics has a stall cliff; cap-based doesn't.** First
  hills model applied gravity only as an acceleration term. Because rolling
  resistance is tiny (0.8%/tick), the full-throttle equilibrium speed sits
  far above `MAX_SPEED` — so gentle climbs changed nothing at all, and the
  gravity needed to make them matter put steeper climbs within a hair of
  stalling. Root cause: with near-zero linear drag, equilibrium speed is
  hypersensitive to net accel. Fix: keep a mild gravity accel for coast and
  slide feel, but express the main effect as a slope-scaled *speed cap*
  (`SPEED_BLEED` already eases karts toward a moved cap smoothly) with a 60%
  floor so no slope can stall a kart — which is also what keeps the
  lookahead-free greedy bot finishing the new track.

## 2026-06-10

### Progress

- Progression: local driver profile (localStorage, no accounts) with XP,
  levels and a garage of level-gated liveries + flame colors. XP comes from
  placement plus in-race feats — takedowns (attributed via shell/oil `owner`)
  and tier-2 drifts — detected by state-diffing, awarded with an animated
  XP-bar + LEVEL UP moment on the results screen. Cosmetics travel in a new
  `PlayerStyle` protocol object so other players see your livery and level;
  the only sim change was adding `owner` to oil slicks for attribution.
  Design rule that shaped it all: progression never touches kart performance
  — fairness and the deterministic sim stay untouched.
- Audio: fully synthesized Web Audio engine (`client/src/audio.ts`) — engine
  pitch tracks speed, drift squeal scales with charge, one-shot synths for
  pickups, boosts, drift tiers, shells (fire/bounce), oil drops, spin-outs,
  countdown and finish fanfare. Distance-attenuated for remote events,
  mute on M with persistence, ducked in hidden tabs. No asset files; the
  whole soundscape is oscillators and filtered noise.
- Full v1 shipped in one arc: pnpm monorepo scaffold → deterministic Q16.16
  sim core → Zod wire protocol → WebSocket input-relay server with desync
  detection → Three.js client with rollback netcode → CI gates → Docker →
  live on Railway (`mk-ultra-production.up.railway.app`).
- Levels v2: four tracks as pure data (`track-defs.ts`) with variable
  asphalt width, dirt margins, boost pads, themes; host track selection +
  Random in the lobby.
- Items v2 (`53e2598`): mystery boxes grant held items weighted by race
  placement; shells (wall-ricochet projectiles), oil slicks (armed hazards),
  spin-outs. 90 sim tests green; verified live with two bot clients racing
  in production — bit-identical finish ticks, zero desyncs across ~1,500
  real-latency rollbacks per client.

### AI interactions that accelerated learning

- **One-shots from state diffs, not callbacks.** The audio engine needed no
  hooks in the sim or netcode: it diffs the previous frame's state (held
  items, boost ticks, shell ttls) and plays sounds on transitions — the same
  read-only pattern the renderer uses. Rollback corrections just work; a
  re-simulated pickup is still a transition.
- **Reproduce the player, not the test.** "Kart goes through the gold cube"
  reproduced nowhere in the test suite — pickups passed at every level. The
  unlock was driving the real client with synthesized `KeyboardEvent`s (the
  exact human input path) and watching live sim state: the kart *was*
  picking up. The first screenshot then told the story instantly — the kart
  was already holding 🚀, so every later box was a correct pass-through that
  *looked* broken. Lesson: when "X doesn't work" survives passing tests,
  reproduce the user's perception, not the mechanic.

- **Asking for enforcement, not discipline.** The determinism rules
  (no floats, no `Math.sin`, no `Map`/`Set`, fixed iteration order) became a
  lint *test* that scans sim sources for banned constructs. One prompt about
  "how do we make this impossible to violate" beat any amount of code review.
- **Debug by trajectory dump, not by staring.** The shell-tunneling bug was
  invisible in test assertions ("expected 4 bounces, got 2"). A throwaway
  script logging per-tick `y/vy/bounces` made it obvious in one read: the
  shell stepped from 0.52 before the wall to 0.17 past it and got reflected
  to the wrong side.
- **Fuzz with the sim's own PRNG.** Test input streams are generated from
  the deterministic PRNG, so the tests themselves are cross-engine
  deterministic. Widening the fuzz mask by one bit (`& 63`) made every
  existing chaos test exercise the new item button for free.
- **Verify in the real app, not just tests.** Browser automation drove two
  `?bot` clients through a real lobby→race→finish flow (locally, then against
  production), polling `window.__mk` live sim state for held items, spins and
  desync frames — proof the feature works over the wire, not just in vitest.
- **Placement-weighted item tables as data.** Asking for "Mario Kart rubber
  banding, deterministically" landed on three d6 tables indexed by placement
  band — trivially testable (last place can never roll oil) and tunable
  without touching logic.

### Challenges → solutions

- **"Item boxes are broken" — but they weren't.** Pickups worked; there was
  zero feedback. The box vanished silently *behind* the kart at speed, and
  driving through a box while already holding an item (correct can't-carry-two
  rule) looked identical to a bug. Fix was all presentation (`27163b7`):
  box-break shard burst at the pickup point, a slot-machine roulette on the
  HUD badge at acquisition, and a badge bump when passing boxes full-handed.
  Lesson: a mechanic without feedback reads as a defect — silence is a bug
  report waiting to happen.

- **Cross-engine float drift would desync everything.** Rollback netcode
  needs bit-identical sims on every machine. Solution: hand-rolled Q16.16
  fixed point where every op is exactly specified by ECMAScript (integer
  ops, exact-integer division, fix-up integer sqrt), enforced mechanically
  by the lint test.
- **Rollback silently corrupts on unsnapshotted state.** Any mutable field
  outside the `Int32Array` snapshot survives restores and diverges clients.
  Rule of thumb that stuck: *"if it isn't snapshotted, it doesn't exist."*
  New item state (held items, spin ticks, shell/oil pools) went into the
  snapshot layout on day one of the feature, not as a retrofit.
- **Shells tunneled through walls.** 0.7 units/tick of speed vs a 0.45
  radius let a shell cross a wall's centerline between collision checks; the
  contact normal then pointed the wrong way and "reflected" it through the
  wall. Fix: move shells in two half-steps per tick so per-check travel
  (0.35) stays under the radius. General lesson: discrete collision needs
  `step < radius`, or substeps.
- **A kart could outrun (and rear-end) its own shell.** Boosted top speed is
  0.596 u/tick; a 0.55 shell would get caught by its owner. Fix: shell speed
  0.7 *plus* owner-immunity until the first wall bounce — after a bounce,
  hitting yourself is legitimate (and classic).
- **Hidden browser tabs stall every peer.** `requestAnimationFrame` stops in
  hidden tabs, so that client stops sending inputs and everyone else hits the
  8-frame prediction wall. Fix: a tiny Web Worker heartbeat (worker timers
  aren't throttled) keeps the sim advancing while hidden.
- **Direct push to main blocked by policy.** The permission classifier
  denied `git push` to the default branch mid-session. Acceptable: deploys go
  through `railway up` from the working tree; the push waits for a human.
