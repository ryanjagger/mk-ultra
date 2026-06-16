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

## 2026-06-16

### Progress

- **Premium visual overhaul (PR #11) merged → `main`** at 11:16 (`4de8220`),
  which auto-deploys — the render-only work logged yesterday is now live.
- **ElevenLabs sound effects, shipped as PR #12** (merged 17:52):
  - `5475814` add and wire real ElevenLabs SFX; `60145f4` rip out the old
    synthesized crowd voice it replaces.
  - Countdown audio polish: `74b424a` hold the countdown at "GET READY" through
    the start buffer instead of advancing early; `9fae777` sync the chime to the
    on-screen digits so sound and visuals line up.
- **Battle mode: swap balloons for shields, shipped as PR #13** (`0a45e28`,
  merged 17:57).
- **Home / lobby UI:** `327f706` make the lobby card work in landscape;
  `17fc632` give the leaderboards card its own flex column on wide home screens
  (wraps below on narrow) and promote the driver card's title to an `<h3>` so it
  matches the other cards' headers.

### AI interactions that accelerated learning

- **"I don't see my changes" diagnosed by evidence, not guesswork.** Instead of
  assuming, checked `lsof` for listening ports (both :5173 vite-dev and :8080
  built-server were up) and grepped the built `dist/index.html` for the new
  markup. That pinned it to a *stale build artifact on :8080* rather than a
  caching/refresh issue, and the fix (rebuild client) fell straight out of the
  evidence.

### Challenges → solutions

- **Edited source, changes invisible in the browser → stale `dist/` served on
  :8080.** Root cause: `pnpm start` serves the built bundle from
  `packages/client/dist/` (a gitignored artifact), and editing source never
  rebuilds it — so :8080 kept serving the old `index.html`. Fix:
  `pnpm --filter @mk/client build`; the static server picks up the new file on
  the next request, no restart needed. Lesson: on :8080 you're looking at a
  *build*; iterate on the :5173 dev tab where HMR reflects source directly.

## 2026-06-15

### Progress

- **Premium visual overhaul — render-only, shipped as PR #11** (merged → `main`
  the next morning, auto-deploys). Six commits, all in
  `packages/client/src/scene.ts` + new tiling/sprite textures; `sim` untouched,
  suite green throughout (157 sim / 11 client / 16 server).
  - **Karts** (`0f79326`): remodeled geometry (lower/wider stance, side pods,
    rear wing, spoked wheels) + clearcoat `MeshPhysicalMaterial` paint + PMREM
    studio reflections applied *per-material* (never `scene.environment`) +
    carbon/livery decals.
  - **Surfaces + decor** (`e45cb1f`): tiling asphalt/dirt albedo with
    in-canvas-derived normal maps; trees/cacti/rocks remodeled + AI
    bark/foliage/cactus/rock textures.
  - **Walls** (`8362d23`): concrete-barrier texture + normal, tinted per theme
    via `wallA`/`wallB`; night themes keep their emissive glow.
  - **Ground + hardening** (`ff88524`): grass/sand/snow biome detail tinted by
    `th.ground`, picked by decor type; ground circle re-UV'd to world coords so
    it tiles at the apron scale.
  - **Sky** (`3d17e1a`): soft cumulus sprite (white-on-black render keyed to
    alpha by brightness) replacing the procedural cloud blobs.
  - **Env-map scope fix** (`73954bd`): PR-review follow-up (below).
- Filed **#10** (desert road renders dark) as a known follow-up after it
  resisted every fix.

### AI interactions that accelerated learning

- **Higgsfield MCP as a parallel texture factory.** Fired all 6 tiling textures
  in one batch, polled, then resized + `pngquant`'d (6 MB → 1.6 MB). The
  repeatable pipeline — generate a grayscale albedo → derive a tangent-space
  normal in-canvas (Sobel on luminance) → lift the albedo mean so a theme tint
  survives the multiply — let geometry + one texture carry every theme without
  hand-authoring per-biome art.
- **Debug rendered *pixels*, not impressions, via `window.__mkScene`.** Bright
  sand next to a dark road fooled the eye; dumping the framebuffer to BMP and
  reading medians over a sample grid — plus reading the live material's
  color/map-canvas pixels/normals through the debug hook — turned "looks dark"
  into hard numbers and proved the asphalt material was healthy.
- **Time-wasters worth recording:** (1) chasing the desert-road darkness through
  remote screenshot→rebuild→measure loops — each lighting hypothesis cost a full
  build+browser cycle, and remote poking fundamentally can't root-cause a shader
  interaction; (2) repeatedly sampling the kart's *own* cast shadow in the
  lower-center of frames and misreading it as "black road." Both say: pick the
  right tool (local frame capture) and confirm *what* a pixel is before
  measuring it.

### Challenges → solutions

- **Tree canopies rendered black → inverted normal-map green channel.**
  Flat-color grass stayed bright under the same sun. Root cause: the in-canvas
  Sobel encoded `+∂h/∂V`, but THREE's OpenGL tangent convention wants `−∂h/∂V`,
  so canopy-top normals tilted *away* from the sun. Fix: negate the row
  difference (`dy`). The grass-bright / trees-dark contrast under identical light
  is what isolated the normal map as the culprit.
- **Roads crushed to near-black by the tint multiply → lift the albedo.** A dark
  photographic albedo × theme color = near-black on every track. Fix: lift the
  albedo mean toward white in-canvas so `themeColor × map ≈ themeColor`, and let
  the normal map carry the relief — one texture then serves all 6 palettes.
- **Desert road renders *pure* black, immune to lighting → #10.** The asphalt
  material is provably healthy (light-grey map canvas, up-facing normals,
  `metalness 0`, glows green when forced emissive) yet its lit diffuse is ~0 on
  the desert theme only. Pixel-measured ruling-out: base color, sun elevation
  (22→52°), a 4.0 hemi flood (blew out the sand, not the road), directional
  shadows — none moved it. The one lever that did: forcing a GPU texture
  re-upload (`needsUpdate`) lifted it off black, pointing at a
  texture-upload/shader interaction, not the lighting model. Couldn't root-cause
  through the remote loop; filed #10 with that lead. Lesson: a shader-level
  render bug needs local frame-capture tooling — recognize the wrong tool sooner.
- **`surfaceMaps` could flash black during load → neutral placeholder.** A
  `CanvasTexture` built from an empty default canvas samples transparent-black,
  zeroing albedo until `onload` lands. Hardened by seeding both canvases with
  mid-grey / flat-normal before the async image load (also de-risked the desert
  ground, which renders fine).
- **PR review (Codex): env patch hit unintended materials.**
  `applyEnvToKarts` set `envMap` on *every* `MeshStandardMaterial` on a cold
  load, but `buildKart` only opts paint/accent/chrome/carbon in — so on a slow
  env load, rubber/skin/balloons got reflections that warm-loaded karts never
  get. Fix: tag the eligible set with `userData.env` and patch only tagged
  materials, making both build paths consistent.

## 2026-06-14

### Progress

- **Chase-camera yaw smoothing** (`f838670`, `fix/bot-camera-jitter`
  ff-merged to `main` and pushed → auto-deploys). Render-only: low-pass the
  yaw the camera is built from so the greedy `?bot`'s per-tick bang-bang
  steering stops shimmying the whole view. Reuses the position lerp's own
  `0.0008^dt` constant so position and orientation share one filter; the kart
  mesh still renders at its exact zero-latency heading. Typecheck clean,
  150 sim + 11 server tests green (no sim/shared touched).
- **Docs split out** (staged, uncommitted): new `ARCHITECTURE.md`
  consolidating the determinism contract, rollback model, wire protocol, track
  system, decision record and milestone map out of the README (README trimmed
  to a short summary + pointer); new `DEMO.md` of demo talking points (the
  netcode war story, bug hunts, and a BrainLift section).

### AI interactions that accelerated learning

- **Three parallel Explore agents converged on a root cause.** For the `?bot`
  jitter, one agent traced the bot steering, one the renderer/camera, one the
  sim pacing — concurrently, read-only. They independently landed on the same
  story (bang-bang steering dither + camera amplification, and *not* netcode),
  faster and cheaper than a serial dig through the same files myself.
- **Diagnose by reasoning about the controller, not by watching pixels.**
  Jitter is temporal — a screenshot can't show it. Establishing from the code
  that steering is a discrete L/R bit recomputed each tick (sign flips at the
  gate center) and that a solo `?bot` race *can't* roll back (`players > 1`
  guard) proved it was the bot+camera before changing anything. A screenshot
  would have been useless here.
- **Reuse the existing time constant instead of inventing one.** Routing the
  new yaw low-pass through the camera's existing `0.0008^dt` means one knob to
  tune and position/orientation stay coherent by construction — no new magic
  number to justify.

### Challenges → solutions

- **"Is the `?bot` jitter a bug?" — no, and the camera was the amplifier.**
  The chase camera derived *both* its position offset and its `lookAt` target
  from the kart's *instantaneous* heading, and the greedy bot's heading dithers
  ±a small angle every tick as the cross-product sign flips near a gate. The
  dither was real but tiny; the unsmoothed `lookAt` swung the entire view. Fix:
  low-pass only the camera yaw, leave the kart mesh exact — smooth the *view*
  without delaying the *kart*. Render-only, so determinism gates never moved.
  Lesson: when only the bot exhibits a "bug," suspect the test driver and the
  thing that follows it, not the sim.
- **Wrong deploy model, corrected by the user.** I told the user a push to
  `main` doesn't deploy and they'd need `railway up`. Railway is
  GitHub-connected here, so `git push origin main` *is* the deploy. Root cause:
  I trusted the `railway up` line in README/CLAUDE.md as the only path. Fix:
  updated project memory so future sessions treat the push as the deploy and
  `railway up` as a separate manual fallback.
- **`import type` can't carry a runtime value.** `scene.ts` imported
  `import type { KartRender }`; reusing `lerpAngle` (a function) needed a value
  import. Switched to `import { lerpAngle, type KartRender }`. Small, but a
  clean reminder that type-only imports erase at runtime.

## 2026-06-13

### Progress

- UI overhaul on `feat/menu-chrome-redesign` (`4df8129..37e7d08`, 7
  commits), driven by an `/impeccable:critique` of the menu + HUD;
  fast-forward-merged to `main` and pushed. Gates green at merge:
  typecheck clean, 11/11 server tests, build.
- **Chrome identity** (`4df8129`): self-hosted Anton + Saira variable
  woff2 (no CDN), killing the three AI-slop tells the critique named —
  gradient clip-text wordmark, glassmorphic blur cards, OS system-font.
  Opaque panels with a gold racing-stripe edge + hard offset shadow,
  drifting speed-streak backdrop, extruded wordmark + checkered underline.
  Saira cascades to the HUD too, so chrome and HUD finally share one type
  system (the unification the critique asked for).
- **Home IA + a wire-protocol move** (`8fa3e6f`): home split into a Quick
  Play hero / friends / solo hierarchy, profile + rooms to a side column.
  Bigger change — room config (track/laps/visibility) pulled off the home
  screen into the lobby, which already edited the track: added host-only
  `setLaps`/`setPublic` messages across `shared` + `server`, modelled on
  `setCup`/`setMode`. The `room` broadcast already carried laps/isPublic,
  so no broadcast change. Time Trial got its own inline track/laps picker.
- **HUD colour + motion** (`ce4ba6e`): gold reserved for "your standing";
  BOOST moved to its own `--boost` orange (ties to the drift-charge max
  tier); the single `pulse` keyframe — five events animating identically —
  split into meaning: lateral shake = WRONG WAY, throb = FINAL LAP, pump =
  BOOST, one-shot pops = NEW RECORD / LEVEL UP. Staggered menu entrance,
  all `prefers-reduced-motion`-gated.
- **Phosphor icons** (`6030c7a`): 20 chrome emoji → inlined Phosphor bold
  SVGs via a registry (`icons.ts`, `applyIcons()` for static
  `[data-icon]`, `iconHTML()` for JS), currentColor-tinted, no font load.
  Kept colourful emoji for game items, balloons, brand and `<select>`
  options.
- **Clarity passes** (`c488fad`, `4ac504a`, `37e7d08`): every play action
  is now button + one-line caption; an "or" divider forks create/join; the
  code field shows a sample-code placeholder (`4F2K`). Lobby rebuilt as a
  setup hub — a big copyable room code as the headline, a labelled 2×2
  race-setup grid (Track/Laps/Mode/Format), a "Players · N/4" header.
  Dropped "rollback" from the menu tagline.
- **Escape-to-menu** (`f1a9a94`, fast-forward-merged to `main` and pushed):
  Escape returns to the home menu from lobby / race / results.
  Mid-race (incl. solo time trials) it raises a confirm overlay first so a
  stray Escape doesn't drop you — and in multiplayer your peers — out of the
  race; lobby/results leave immediately, replay's Escape (back to results)
  is untouched. Reuses the existing leave-button teardown (`controller =
  null` + `setupIdleKarts` + `leaveRoom`) rather than inventing one;
  typecheck clean.

### AI interactions that accelerated learning

- **A critique became the roadmap.** `/impeccable:critique` returned a
  split decision — HUD already good, menus textbook AI-slop — which turned
  a vague "make it nicer" into a ranked punch-list (chrome / IA / font /
  gold / motion / emoji) worked top-down over the session.
- **Force-show hidden UI to verify it.** The HUD and results only appear
  mid-race; `agent-browser eval` to strip `.hidden` and inject sample
  values (position, BOOST, FINAL LAP, a fake record) let me screenshot and
  check colour/motion in one shot instead of driving a full race each time.
  A 2× viewport made type and icons legible in captures.
- **Verify the protocol through its own rebroadcast.** Proved the new
  `setLaps`/`setPublic` end-to-end by dispatching change events and reading
  the values the server echoed back (`laps=5 public=true`) — no second
  client; the rebroadcast is the assertion.
- **Self-host instead of CDN-ing.** Pulled Google Fonts' variable woff2 (3
  files) and Phosphor core SVGs (unpkg) directly and bundled/inlined them,
  matching the project's no-runtime-CDN, deterministic-offline ethos rather
  than adding a font `<link>` or icon-font dependency.
- **Time wasted, logged.** zsh doesn't word-split unquoted `$VARS`, so a
  `for ic in $ICONS` batch curl fetched one file named the whole string
  (literal list fixed it); and the agent-browser daemon wedged (`os error
  35`) after I stacked screenshot calls behind a `pnpm start &` that held
  the shell open — kill + reopen fixed it. Don't chain CLI calls after a
  `&` long-runner in one Bash invocation.
- **Map the state machine before editing it.** A read-only Explore subagent
  traced the screen flow, the per-screen teardown each leave-button already
  runs, and where keydown is handled — so the new Escape path could *mirror*
  the established teardown contract instead of being reverse-engineered
  edit-by-edit. One investigation pass up front, then a single-edit feature.

### Challenges → solutions

- **Splitting interleaved changes into separate commits without
  `git add -p`.** Interactive staging is blocked here, and two features
  lived in different regions of the same `style.css`/`index.html`. Fix:
  Edit-revert the smaller block, commit the larger feature, restore the
  block, commit it — a deterministic split with no partial staging. Used
  twice (the `.ico` CSS block; the tagline word).
- **`<option>` can't hold an SVG.** The emoji→Phosphor sweep dead-ended at
  the `<select>` dropdowns — option elements render text only. Left those
  as emoji (game/brand marks anyway: 🏁 🎈 🎲) and documented why, instead
  of forcing an icon-font into options.
- **Two cascade gotchas restructuring the lobby code.** The room-code chip
  used `font: inherit`, so switching the card heading to Anton rendered the
  code in a display face — pinned it to Saira. And wrapping the code as
  `text span + copy icon` meant `renderLobby`'s `textContent` would wipe
  the icon; moved the text to a `lobby-code-text` child. The copy handler
  reads `lastRoom.code` (source of truth), so it stayed correct throughout.
- **"Changes not showing on :8080" was browser cache, not a stale build.**
  Confirmed by curling the *served* HTML + asset hashes and matching them
  to disk (the server reads `dist` fresh per request) — the open tab had
  cached the old `index.html`. Hard refresh, not a rebuild. Diagnosed by
  comparison, not guesswork.
- **A quit confirm can't be a `confirm()` in a rollback game.** Native
  `confirm()` blocks the JS main thread — including the Web Worker heartbeat
  that keeps the sim advancing when RAF stalls — so every peer would freeze
  at the prediction cap until the dialog is dismissed. Root cause: rollback
  has no pause; the sim must keep ticking or look-ahead inputs stop flowing.
  Fix: a DOM overlay (`#overlay-quit`) that leaves the RAF/heartbeat loop
  running, so the race keeps simulating behind the prompt. Bonus gotcha: a
  focused `<select>` already uses Escape to close its own popup, so the quit
  handler guards on `INPUT`/`SELECT` targets — the same check `keyboard.ts`
  uses for game keys.

## 2026-06-12

### Progress

- The v2 batch, ten commits on `feat/v2-features` (`ccdd38e..a8383bc`),
  every feature gated by tests before its commit: gamepad support,
  countdown rev-boost, slipstream with a slingshot exit, items v3
  (lightning / triple boost / homing shells on the placement-weighted
  tables), ramp jumps with airborne physics, two new tracks (Mesa Drop —
  hills + the big jump; The Colosseum — battle arena), Grand Prix cups,
  battle mode with balloons, and verified ghost leaderboards. Suite grew
  97 → 160 tests; sim snapshot went KART_INTS 13 → 19 across five
  features without touching rollback or the relay model.
- Leaderboards are the architecture payoff: submissions are input
  recordings, the server replays them through the sim in Node (its one,
  offline simulation) and stores the time the sim computed. Verified
  end-to-end against the live server: a real run accepted with the exact
  sim time, a truncated forgery rejected, the board rendered in the
  results screen, and the #1 ghost downloaded and raced.
- Afternoon polish batch, four client commits (`d09e3bf..5fbdcb7`): a UI
  clarity pass (garage panel no longer shoves Quick Play off screen,
  in-race controls key because players kept missing the item button,
  drift meter shown only while charging), ACES tone mapping with
  per-theme exposure and sky domes (gradient dome whose horizon is the
  fog color, HDR sun/moon discs that bloom, day cumulus, deterministic
  420-star nights) so every track gets a time of day, then kerbs/road
  detail/trackside life (striped apex kerbs that follow hill heights,
  asphalt grain, grid slots, grandstand of deterministic spectators,
  billboards, floodlights, finish-line confetti), and a game-feel pass
  (wheels roll at true speed and steer, chassis lean, landing squash,
  camera that banks into drifts and kicks on landing; crowd and
  shell-flyby doppler voices in the synth chain).
- Sponsorship surfaces: one registry (`sponsors.ts`) feeds barrier
  panels, billboards, the gantry title strip, a painted asphalt wordmark
  and the grandstand fascia, with hash-stable slot assignment per track;
  Gauntlet AI ships as title sponsor. Whole afternoon's sim footprint:
  render-only `TrackTheme` lighting fields, same precedent as `weather`.
- Evening netcode arc, three commits, all live: a real 4-player session
  was "very stuttery but playable" → input redundancy + bounded
  look-ahead inputs while stalled + `TCP_NODELAY` (`3a47548`); a
  production F3 screenshot then showed lag 9 against the 8-frame cap →
  prediction window 8→16 and slewed catch-up (`5771876`); finally the
  diagnostics to stop guessing — a `?lag=&jitter=` per-tab link
  simulator and a headless bot fleet (`pnpm --filter @mk/server fleet`)
  that races 2-4 synthetic-link clients through the real relay and
  prints stalls/rollbacks/lag percentiles (`a271033`). Fleet measured
  the new ceiling (~250ms worst-pair RTT, lag p95 14-15 of 16) and
  reproduces the original pathology on demand; issue #1 files the
  adaptive cap / adaptive input-delay follow-up. Side find: the server
  dev script had been broken by Node 25 strip-types — moved to tsx.

### AI interactions that accelerated learning

- **Reproduce in the sim, not the browser.** The battle smoke test showed
  zero balloon pops; a 20-line scratch vitest with counters (pickups,
  uses, spins) reproduced it headlessly in seconds and made the cause
  obvious. Browser-side that would have been an hour of squinting.
- **When pixels die, verify through state.** The headless browser's
  GPU/RAF stack wedged mid-session and screenshots hung forever; the
  `window.__mk` debug hook over `agent-browser eval` verified everything
  pixel-free — battle resolution, arena pool, jump airtime, leaderboard
  DOM — and was faster than screenshot-reading anyway.
- **Feature-per-commit with gates between** kept ten sim-touching changes
  honest: each one ran the full suite before committing, so the one real
  regression (battle bots) surfaced inside its own feature, not three
  features later.
- **One overlay screenshot was the whole diagnosis.** The F3 readout
  (frame 1555, lag 9, stalls 1721) identified the bug arithmetically:
  stalls ≈ one per RAF means the sim was pinned to the prediction wall
  every frame, and lag 9 vs cap 8 says exactly why. No repro, no packet
  capture — the overlay built on day one paid for itself in one image.
- **Transport semantics before netcode folklore.** Input redundancy was
  proposed from GGPO instinct ("heals packet loss") and only while
  implementing it did the obvious surface: TCP delivers in order, so
  redundant copies can never arrive before the delayed original on the
  same stream. Kept (it heals app-level holes), but the honest value
  re-scope went into the commit message. UDP patterns don't transfer to
  WebSockets unexamined.
- **"Can't reproduce" is a tooling gap, not a mystery.** Localhost has
  no latency, so 4 local tabs can't exhibit a 90ms bug. The fix was to
  build the missing variable: a FIFO link simulator in the client and a
  fleet that turns "feels stuttery" into lag percentiles — then prove
  both directions (180ms RTT: 0 stalls; 600ms: pinned at 17, the
  production screenshot recreated at will).

- **Battle bots orbited a dead gate.** Battles skip checkpoint advancement,
  so `nextCp` froze at 1 and the greedy gate-chaser circled one point for
  the whole round — one item pickup in 150s, zero fights. Root cause: the
  racing bot's goal signal doesn't exist in battle. Fix: a battle brain —
  chase the nearest live item box when empty-handed, the nearest surviving
  rival when armed, fire in the forward half-plane. A 4-bot brawl now
  resolves by elimination in ~70s. Lesson: reusing an AI across modes
  means re-checking what its objective function still means.
- **`document.hidden` is not "RAF is running".** The worker heartbeat only
  advanced the sim when the tab was hidden; an occluded/never-painted
  window reports `visibilityState: 'visible'` while RAF never fires, so
  the sim froze at tick 0. Fix: heartbeat advances whenever RAF has
  stalled >250ms, regardless of visibility. Found because the headless
  browser hit exactly that state; real players behind a fullscreen app
  would have too.
- **Input recordings are closed-loop — they don't time-shift.** A
  leaderboard test prepended 60 idle ticks to a recorded run to fake a
  "slower" entry; the steering masks then arrived 60 ticks late relative
  to the kart's actual position and the run never finished. Fix: generate
  slower runs by re-recording with a handicap (throttle drop after GO),
  not by editing streams. Same property that makes the verification
  cheat-proof is what makes splicing impossible.
- **Test waited on a stale broadcast.** The cup integration test asserted
  points right after `raceEnded`, but `a.room` still held the pre-race
  lobby message, so `until(state === 'lobby')` passed instantly with old
  data. Fix: null the cached message before acting, wait for the *next*
  broadcast. Lesson for event-driven tests: clear the slot you're about
  to wait on.
- **Stalls were contagious by design.** Local inputs were sampled and
  sent only inside the sim-advance loop, so a client stalled on one slow
  peer stopped feeding everyone else, who then stalled on *it* ~8 frames
  later — one bad link froze the room. Fix: while stalled, keep
  committing a bounded run of upcoming inputs (≤ maxPrediction ahead).
  The bound matters twice: the masks are pledged before their frames
  simulate (first-write-wins means they must match what was broadcast),
  and a long pledge would replay stale controls after recovery.
- **The prediction window was sized for a LAN nobody plays on.** Budget
  per peer = sender half-RTT + relay + receiver half-RTT + ~3 frames of
  batching — ~9 frames at 90ms pings, against a cap of 8: permanently
  pinned, micro freeze-burst every frame. The fleet showed demand scales
  with the *worst pair* in the room, not your own ping. Cap to 16, and
  catch-up slewed to realtime+2 frames per update so recovery is a brief
  fast-forward instead of a teleport (a flat advance cap would starve
  the hidden-tab heartbeat path — the slew must scale with elapsed
  wall-clock span).
- **Two faithful-simulation traps in the lag tools.** Per-message random
  delays would reorder messages — simulating UDP on a transport that
  can't reorder — so the fake links enforce monotonic FIFO deadlines per
  direction (which also reproduces real head-of-line blocking). And
  `setTimeout` pumping would be throttled to ≥1s in hidden tabs, so the
  browser link sim pumps from a Web Worker, same as the sim heartbeat.
- **Node 25 strip-types is not a TS runner.** It rejects parameter
  properties (non-erasable syntax) and won't resolve the `.js`-suffixed
  imports TS convention uses — the fleet failed on both, and the same
  failure had already silently broken `pnpm --filter @mk/server dev`.
  Fix: tsx for dev/fleet; the production build was never affected
  (esbuild bundles).

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
