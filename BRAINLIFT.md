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

## 2026-06-10

### Progress

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
