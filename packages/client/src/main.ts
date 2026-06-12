import './style.css';
import {
  PHASE_FINISHED,
  PHASE_COUNTDOWN,
  COUNTDOWN_TICKS,
  DRIFT_TIER1_TICKS,
  DRIFT_TIER2_TICKS,
  ITEM_NONE,
  TRACKS,
  getTrack,
  fxToFloat,
  isItemActive,
  type GameState,
  type KartState,
  type TrackRuntime,
} from '@mk/sim';
import { RANDOM_TRACK, type ServerMsg, type PlayerStyle } from '@mk/shared';
import { Net } from './net.js';
import { ClockSync } from './clock.js';
import { Keyboard } from './keyboard.js';
import { RaceController, type RaceLike } from './game.js';
import { TimeTrialController } from './timetrial.js';
import { ReplayController, type ReplayData } from './replay.js';
import { GameScene, KART_COLORS, defaultLook, type KartLook } from './scene.js';
import { AudioEngine } from './audio.js';
import { getProfile, saveProfile, myStyle } from './profile.js';
import {
  LIVERIES,
  FLAMES,
  liveryById,
  flameById,
  liveryColor,
  levelProgress,
  levelFromXp,
} from './cosmetics.js';
import { FeatTracker, awardRace, type RaceAward } from './progression.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

// ------------------------------------------------------------- setup ----

const net = new Net();
const clock = new ClockSync();
const keyboard = new Keyboard();
const scene = new GameScene($<HTMLCanvasElement>('game-canvas'));
scene.setupIdleKarts();

const audio = new AudioEngine();
window.addEventListener('pointerdown', () => audio.unlock());
window.addEventListener('keydown', () => audio.unlock());
document.addEventListener('visibilitychange', () => audio.setHidden(document.hidden));

type Screen = 'home' | 'lobby' | 'race' | 'results';
let screen: Screen = 'home';
let controller: RaceLike | null = null;
let ttParams: { trackId: string; laps: number } | null = null;
/** the finished race's controller, parked while a replay is playing */
let finishedRace: RaceLike | null = null;
let lastRoom: Extract<ServerMsg, { t: 'room' }> | null = null;
let resultsShown = false;
let stallSince: number | null = null;
let debugVisible = false;
let toastTimer = 0;

const screens = {
  home: $('screen-home'),
  lobby: $('screen-lobby'),
  results: $('screen-results'),
};
const hud = $('hud');
const overlayDisconnect = $('overlay-disconnect');

function showScreen(next: Screen): void {
  screen = next;
  screens.home.classList.toggle('hidden', next !== 'home');
  screens.lobby.classList.toggle('hidden', next !== 'lobby');
  screens.results.classList.toggle('hidden', next !== 'results');
  hud.classList.toggle('hidden', next !== 'race' && next !== 'results');
  keyboard.captureGameKeys = next === 'race';
  if (next === 'home') {
    net.send({ t: 'listRooms' });
  }
}

function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 3000);
}

// -------------------------------------------------------------- home ----

const nameInput = $<HTMLInputElement>('name-input');
nameInput.value = localStorage.getItem('mk-name') ?? '';

function trackName(id: string): string {
  if (id === RANDOM_TRACK) return '🎲 Random';
  for (const t of TRACKS) if (t.def.id === id) return t.def.name;
  return id;
}

function fillTrackSelect(sel: HTMLSelectElement): void {
  sel.innerHTML = '';
  const rand = document.createElement('option');
  rand.value = RANDOM_TRACK;
  rand.textContent = '🎲 Random';
  sel.appendChild(rand);
  for (const t of TRACKS) {
    const opt = document.createElement('option');
    opt.value = t.def.id;
    opt.textContent = t.def.name;
    sel.appendChild(opt);
  }
}
const createTrackSel = $<HTMLSelectElement>('create-track');
const lobbyTrackSel = $<HTMLSelectElement>('lobby-track');
fillTrackSelect(createTrackSel);
fillTrackSelect(lobbyTrackSel);

/** Show a track as the menu backdrop (parks demo karts on its grid). */
function showBackdrop(trackChoice: string): void {
  const runtime = getTrack(trackChoice === RANDOM_TRACK ? undefined : trackChoice);
  if (scene.currentTrackId !== runtime.def.id) {
    scene.setTrack(runtime);
    scene.setupIdleKarts();
  }
}

function playerName(): string {
  const n = nameInput.value.trim().slice(0, 16) || 'Racer';
  localStorage.setItem('mk-name', n);
  return n;
}

// ------------------------------------------------------- garage/driver ----

function renderDriver(): void {
  const p = getProfile();
  const prog = levelProgress(p.xp);
  $('driver-level').textContent = `LV ${prog.level}`;
  $('driver-xpfill').style.width = `${(prog.into / prog.span) * 100}%`;
}

function garageItem(opts: {
  name: string;
  level: number;
  swatch: string | null;
  equipped: boolean;
  unlocked: boolean;
  onEquip: () => void;
}): HTMLElement {
  const el = document.createElement('div');
  el.className = `garage-item${opts.equipped ? ' equipped' : ''}${opts.unlocked ? '' : ' locked'}`;
  if (opts.swatch) {
    const sw = document.createElement('span');
    sw.className = 'garage-swatch';
    sw.style.background = opts.swatch;
    el.appendChild(sw);
  }
  const label = document.createElement('span');
  label.textContent = opts.unlocked ? opts.name : `🔒 ${opts.name} (LV ${opts.level})`;
  el.appendChild(label);
  if (opts.unlocked) {
    el.addEventListener('click', () => {
      opts.onEquip();
      renderGarage();
    });
  }
  return el;
}

function renderGarage(): void {
  const p = getProfile();
  const level = levelFromXp(p.xp);
  const liveries = $('garage-liveries');
  liveries.innerHTML = '';
  for (const l of LIVERIES) {
    liveries.appendChild(
      garageItem({
        name: l.name,
        level: l.level,
        swatch: l.primary ?? KART_COLORS[0]!,
        equipped: p.livery === l.id,
        unlocked: level >= l.level,
        onEquip: () => saveProfile({ ...getProfile(), livery: l.id }),
      }),
    );
  }
  const flames = $('garage-flames');
  flames.innerHTML = '';
  for (const f of FLAMES) {
    flames.appendChild(
      garageItem({
        name: f.name,
        level: f.level,
        swatch: f.color,
        equipped: p.flame === f.id,
        unlocked: level >= f.level,
        onEquip: () => saveProfile({ ...getProfile(), flame: f.id }),
      }),
    );
  }
}

$('btn-garage').addEventListener('click', () => {
  const panel = $('garage-panel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  if (opening) renderGarage();
});
renderDriver();

$('btn-quick').addEventListener('click', () =>
  net.send({ t: 'quickPlay', name: playerName(), style: myStyle() }),
);
$('btn-create').addEventListener('click', () =>
  net.send({
    t: 'createRoom',
    name: playerName(),
    isPublic: $<HTMLInputElement>('create-public').checked,
    laps: Number($<HTMLSelectElement>('create-laps').value),
    track: createTrackSel.value,
    style: myStyle(),
  }),
);
const joinCode = $<HTMLInputElement>('join-code');
const tryJoin = () => {
  const code = joinCode.value.trim().toUpperCase();
  if (code.length !== 4) {
    homeError('Room codes are 4 characters');
    return;
  }
  net.send({ t: 'joinRoom', name: playerName(), code, style: myStyle() });
};
$('btn-join').addEventListener('click', tryJoin);
joinCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryJoin();
});

function homeError(text: string | null): void {
  const el = $('home-error');
  el.classList.toggle('hidden', !text);
  el.textContent = text ?? '';
}

net.on('roomList', (msg) => {
  const ul = $('room-list');
  ul.innerHTML = '';
  if (msg.rooms.length === 0) {
    ul.innerHTML = '<li class="muted">No open rooms — create one!</li>';
    return;
  }
  for (const room of msg.rooms) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${room.hostName}'s race · ${trackName(room.track)} · ${room.playerCount}/4 · ${room.laps} laps`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = `Join ${room.code}`;
    btn.addEventListener('click', () =>
      net.send({ t: 'joinRoom', name: playerName(), code: room.code, style: myStyle() }),
    );
    li.append(label, btn);
    ul.appendChild(li);
  }
});

window.setInterval(() => {
  if (screen === 'home' && net.connected) net.send({ t: 'listRooms' });
}, 3000);

// ------------------------------------------------------------- lobby ----

net.on('room', (msg) => {
  lastRoom = msg;
  homeError(null);
  if (screen === 'race' || screen === 'results') {
    renderLobby(); // refresh in background; user returns via results button
    return;
  }
  showScreen('lobby');
  renderLobby();
});

net.on('leftRoom', () => {
  lastRoom = null;
  showScreen('home');
});

function renderLobby(): void {
  if (!lastRoom) return;
  $('lobby-code').textContent = lastRoom.code;
  $('lobby-meta').textContent = `${lastRoom.isPublic ? 'public' : 'private'} · ${lastRoom.laps} laps`;
  const isHostNow = lastRoom.you === 0;
  lobbyTrackSel.disabled = !isHostNow;
  if (document.activeElement !== lobbyTrackSel && lobbyTrackSel.value !== lastRoom.track) {
    lobbyTrackSel.value = lastRoom.track;
  }
  if (screen === 'lobby') showBackdrop(lastRoom.track);
  const ul = $('lobby-players');
  ul.innerHTML = '';
  lastRoom.players.forEach((p, i) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'kart-dot';
    dot.style.background = liveryColor(p.style.livery, i);
    const nm = document.createElement('span');
    nm.textContent = p.name + (i === lastRoom!.you ? ' (you)' : '');
    const lvl = document.createElement('span');
    lvl.className = 'lvl';
    lvl.textContent = `LV ${p.style.level}`;
    const tag = document.createElement('span');
    if (p.host) {
      tag.className = 'tag host';
      tag.textContent = '★ host';
    } else {
      tag.className = `tag ${p.ready ? 'ready' : 'waiting'}`;
      tag.textContent = p.ready ? '✓ ready' : 'waiting';
    }
    li.append(dot, nm, lvl, tag);
    ul.appendChild(li);
  });

  const isHost = lastRoom.you === 0;
  const others = lastRoom.players.filter((_, i) => i !== 0);
  const allReady = others.every((p) => p.ready);
  $('btn-ready').classList.toggle('hidden', isHost);
  $('btn-start').classList.toggle('hidden', !isHost);
  const startBtn = $<HTMLButtonElement>('btn-start');
  startBtn.disabled = !allReady;
  const me = lastRoom.players[lastRoom.you];
  $('btn-ready').textContent = me?.ready ? 'Not ready' : 'Ready up';
  $('lobby-hint').textContent = isHost
    ? allReady
      ? others.length === 0
        ? 'Solo run — or share the code and wait for friends.'
        : 'Everyone is ready — hit start!'
      : 'Waiting for players to ready up…'
    : me?.ready
      ? 'Waiting for the host to start…'
      : 'Ready up so the host can start.';
}

$('btn-ready').addEventListener('click', () => {
  const me = lastRoom?.players[lastRoom.you];
  net.send({ t: 'setReady', ready: !me?.ready });
});
lobbyTrackSel.addEventListener('change', () => {
  net.send({ t: 'setTrack', track: lobbyTrackSel.value });
});
$('btn-start').addEventListener('click', () => net.send({ t: 'startRace' }));
$('btn-leave').addEventListener('click', () => net.send({ t: 'leaveRoom' }));
$('lobby-code').addEventListener('click', () => {
  if (lastRoom) {
    void navigator.clipboard.writeText(lastRoom.code).then(() => toast('Room code copied'));
  }
});

// -------------------------------------------------------------- race ----

const botMode = new URLSearchParams(location.search).has('bot');
let feats: FeatTracker | null = null;
let raceAward: RaceAward | null = null;

function lookOf(style: PlayerStyle, seat: number): KartLook {
  const l = liveryById(style.livery);
  const primary = l.primary ?? defaultLook(seat).primary;
  return { primary, accent: l.accent ?? primary, flame: flameById(style.flame).color };
}

net.on('raceStart', (msg) => {
  ttParams = null;
  $('hud-best').classList.add('hidden');
  scene.setTrack(getTrack(msg.trackId)); // authoritative: server resolved 'random'
  controller = new RaceController(
    net,
    clock,
    keyboard,
    {
      seed: msg.seed,
      laps: msg.laps,
      trackId: msg.trackId,
      startAtMs: msg.startAtMs,
      you: msg.you,
      names: msg.players,
    },
    botMode,
  );
  // debug hook for E2E tests and console poking (read-only by convention)
  (window as { __mk?: unknown }).__mk = { controller };
  audio.reset();
  resetHudState();
  kartDotColors = msg.styles.map((s, i) => liveryColor(s.livery, i));
  feats = new FeatTracker();
  raceAward = null;
  resultsShown = false;
  stallSince = null;
  $('hud-desync').classList.add('hidden');
  $('hud-pos-of').textContent = `/${msg.players.length}`;
  scene.setupKarts(
    msg.players.map((n, i) => (i === msg.you ? null : n)),
    msg.styles.map((s, i) => lookOf(s, i)),
  );
  showScreen('race');
});

const netRace = (): RaceController | null =>
  controller instanceof RaceController ? controller : null;

// -------------------------------------------------------- time trial ----

function startTimeTrial(trackChoice: string, laps: number): void {
  const trackId =
    trackChoice === RANDOM_TRACK
      ? TRACKS[Math.floor(Math.random() * TRACKS.length)]!.def.id
      : trackChoice;
  ttParams = { trackId, laps };
  scene.setTrack(getTrack(trackId));
  const tt = new TimeTrialController(keyboard, { trackId, laps }, botMode);
  controller = tt;
  (window as { __mk?: unknown }).__mk = { controller };
  audio.reset();
  resetHudState();
  kartDotColors = [liveryColor(myStyle().livery, 0)];
  feats = null; // no XP for solo runs — progression stays a multiplayer reward
  raceAward = null;
  resultsShown = false;
  stallSince = null;
  $('hud-desync').classList.add('hidden');
  $('hud-pos-of').textContent = '/1';
  scene.setupKarts([null], [lookOf(myStyle(), 0)]);
  if (tt.hasGhost) scene.setupGhost(`BEST ${fmtTime(tt.bestSec!)}`);
  const best = $('hud-best');
  best.textContent = tt.bestSec !== null ? `BEST ${fmtTime(tt.bestSec)}` : 'first run — set a record';
  best.classList.remove('hidden');
  showScreen('race');
}

$('btn-timetrial').addEventListener('click', () =>
  startTimeTrial(createTrackSel.value, Number($<HTMLSelectElement>('create-laps').value)),
);

// ------------------------------------------------------------ replays ----

function startReplay(data: ReplayData): void {
  finishedRace = controller;
  const rc = new ReplayController(data);
  controller = rc;
  (window as { __mk?: unknown }).__mk = { controller };
  audio.reset();
  resetHudState();
  kartDotColors = data.styles.map((s, i) => liveryColor(s.livery, i));
  scene.setTrack(getTrack(data.trackId));
  scene.setupKarts(
    data.players, // every kart keeps its name tag — there is no "you" here
    data.styles.map((s, i) => lookOf(s, i)),
  );
  $('hud-pos-of').textContent = `/${data.players.length}`;
  $('hud-best').classList.add('hidden');
  $('hud-replay').classList.remove('hidden');
  showScreen('race');
}

function exitReplay(): void {
  if (!(controller instanceof ReplayController)) return;
  $('hud-replay').classList.add('hidden');
  controller = finishedRace;
  finishedRace = null;
  (window as { __mk?: unknown }).__mk = { controller };
  showScreen('results');
}

net.on('replay', (msg) => startReplay(msg));

window.addEventListener('keydown', (e) => {
  if (!(controller instanceof ReplayController)) return;
  if (e.key === 'Escape') exitReplay();
  const n = Number(e.key);
  if (n >= 1 && n <= controller.state.karts.length) controller.focus = n - 1;
});

net.on('input', (msg) => netRace()?.onRemoteInput(msg.p, msg.f, msg.m));
net.on('dropped', (msg) => {
  netRace()?.onDropped(msg.p, msg.fromFrame);
  const name = controller?.names[msg.p] ?? `player ${msg.p}`;
  toast(`${name} disconnected`);
});
net.on('desync', (msg) => {
  netRace()?.onDesync(msg.frame, msg.detail);
  const el = $('hud-desync');
  el.textContent = `⚠ DESYNC at frame ${msg.frame} — simulation diverged`;
  el.classList.remove('hidden');
});
net.on('error', (msg) => {
  if (screen === 'home') homeError(msg.message);
  else toast(msg.message);
});
net.on('pong', (msg) => clock.onPong(msg.pt, msg.now));

window.setInterval(() => {
  if (net.connected) net.send({ t: 'ping', pt: Date.now() });
}, 2000);

keyboard.onDebugToggle = () => {
  debugVisible = !debugVisible;
  $('hud-debug').classList.toggle('hidden', !debugVisible);
};

const muteBtn = $('hud-mute');
function renderMute(): void {
  muteBtn.textContent = audio.muted ? '🔇' : '🔊';
  muteBtn.title = audio.muted ? 'Unmute (M)' : 'Mute (M)';
}
renderMute();
muteBtn.addEventListener('click', () => {
  audio.toggleMute();
  renderMute();
});
keyboard.onMuteToggle = () => {
  audio.toggleMute();
  renderMute();
};

// ----------------------------------------------------------- results ----

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function showResults(): void {
  if (!controller) return;
  const tt = controller instanceof TimeTrialController ? controller : null;
  $('results-title').textContent = tt ? '⏱ Time trial' : '🏁 Race results';
  const ol = $('results-list');
  ol.innerHTML = '';
  for (const idx of controller.placements()) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'kart-dot';
    dot.style.background = KART_COLORS[idx % KART_COLORS.length]!;
    const nm = document.createElement('span');
    nm.textContent = (controller.names[idx] ?? `kart ${idx}`) + (idx === controller.you ? ' (you)' : '');
    const time = document.createElement('span');
    time.className = 'rtime';
    const ft = controller.finishTimeSec(idx);
    time.textContent = ft !== null ? fmtTime(ft) : 'DNF';
    li.append(dot, nm, time);
    ol.appendChild(li);
  }

  // time trial: record banner + previous best instead of the XP card
  $('tt-result').classList.toggle('hidden', !tt);
  $('results-xp').classList.toggle('hidden', !!tt);
  $('btn-back-lobby').classList.toggle('hidden', !!tt);
  $('btn-results-leave').classList.toggle('hidden', !!tt);
  $('btn-replay').classList.toggle('hidden', !!tt);
  $('btn-tt-retry').classList.toggle('hidden', !tt);
  $('btn-tt-home').classList.toggle('hidden', !tt);
  if (tt?.result) {
    $('tt-record').classList.toggle('hidden', !tt.result.isRecord);
    $('tt-best').textContent =
      tt.result.bestSec === null
        ? 'First record on this track — beat your ghost next run.'
        : tt.result.isRecord
          ? `Previous best ${fmtTime(tt.result.bestSec)} — your ghost just got faster.`
          : `Best ${fmtTime(tt.result.bestSec)} — the ghost lives another run.`;
  }

  if (feats && !raceAward && controller instanceof RaceController) {
    raceAward = awardRace(controller, feats);
    feats = null;
  }
  if (raceAward) renderXpAward(raceAward);
  renderDriver();
  showScreen('results');
}

$('btn-replay').addEventListener('click', () => net.send({ t: 'getReplay' }));
$('btn-tt-retry').addEventListener('click', () => {
  if (ttParams) startTimeTrial(ttParams.trackId, ttParams.laps);
});
$('btn-tt-home').addEventListener('click', () => {
  controller = null;
  ttParams = null;
  $('hud-best').classList.add('hidden');
  scene.setupIdleKarts();
  showScreen('home');
});

/** XP breakdown + animated bar fill on the results screen. */
function renderXpAward(award: RaceAward): void {
  const lines = $('xp-lines');
  lines.innerHTML = '';
  for (const l of award.lines) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = l.label;
    const xp = document.createElement('b');
    xp.textContent = `+${l.xp} XP`;
    li.append(label, xp);
    lines.appendChild(li);
  }
  const after = levelProgress(award.xpAfter);
  $('xp-level-tag').textContent = `LV ${after.level}`;
  $('xp-next').textContent = `${after.into}/${after.span}`;
  const leveled = award.levelAfter > award.levelBefore;
  $('xp-levelup').classList.toggle('hidden', !leveled);
  const unlocks = $('xp-unlocks');
  unlocks.innerHTML = '';
  for (const u of award.unlocked) {
    const li = document.createElement('li');
    li.textContent = `🔓 ${u} — equip it in the Garage`;
    unlocks.appendChild(li);
  }
  // animate the fill: start from the pre-race position (or 0 after a level-up)
  const before = levelProgress(award.xpBefore);
  const fill = $('xp-fill');
  fill.style.transition = 'none';
  fill.style.width = leveled ? '0%' : `${(before.into / before.span) * 100}%`;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      fill.style.transition = '';
      fill.style.width = `${(after.into / after.span) * 100}%`;
    }),
  );
}

$('btn-back-lobby').addEventListener('click', () => {
  controller = null;
  scene.setupIdleKarts();
  if (lastRoom) {
    showScreen('lobby');
    renderLobby();
  } else {
    showScreen('home');
  }
});
$('btn-results-leave').addEventListener('click', () => {
  controller = null;
  scene.setupIdleKarts();
  net.send({ t: 'leaveRoom' });
});

// --------------------------------------------------------- connection ----

net.onOpen(() => {
  overlayDisconnect.classList.add('hidden');
  net.send({ t: 'listRooms' });
  net.send({ t: 'ping', pt: Date.now() });
});
net.onClose(() => {
  overlayDisconnect.classList.remove('hidden');
  if (controller) {
    controller = null;
    scene.setupIdleKarts();
  }
  lastRoom = null;
  showScreen('home');
});
net.connect();

// ---------------------------------------------------------- HUD loop ----

// --- held-item badge: roulette on acquisition, bump when passing boxes full-handed
const ITEM_ICONS = ['🚀', '🐢', '🛢️']; // indexed by ITEM_BOOST/SHELL/OIL
let lastHeld = ITEM_NONE;
let rouletteUntil = 0;

function updateItemBadge(st: GameState, me: KartState): void {
  const itemEl = $('hud-item');
  itemEl.classList.toggle('hidden', me.heldItem === ITEM_NONE);
  if (me.heldItem !== ITEM_NONE && lastHeld === ITEM_NONE) {
    rouletteUntil = performance.now() + 700; // slot-machine reveal
  }
  lastHeld = me.heldItem;
  if (me.heldItem === ITEM_NONE) return;

  const now = performance.now();
  const icon =
    now < rouletteUntil
      ? ITEM_ICONS[Math.floor(now / 80) % ITEM_ICONS.length]!
      : (ITEM_ICONS[me.heldItem] ?? '❔');
  const iconEl = $('hud-item-icon');
  if (iconEl.textContent !== icon) iconEl.textContent = icon;

  // hands full: driving through a live box does nothing — say so visually
  let onBox = false;
  for (let i = 0; i < st.track.itemSpawns.length; i++) {
    if (!isItemActive(st, i)) continue;
    const sp = st.track.itemSpawns[i]!;
    const dx = fxToFloat(sp.x) - fxToFloat(me.x);
    const dy = fxToFloat(sp.y) - fxToFloat(me.y);
    if (dx * dx + dy * dy < 2.2 * 2.2) {
      onBox = true;
      break;
    }
  }
  itemEl.classList.toggle('bump', onBox);
}

// --- minimap: track outline cached per track, kart dots redrawn per frame
const minimap = $<HTMLCanvasElement>('hud-minimap');
const mmCtx = minimap.getContext('2d')!;
let mmTrackId: string | null = null;
let mmPath: Path2D | null = null;
let mmStart: [number, number, number, number] | null = null;
let mmProject: (x: number, y: number) => [number, number] = () => [0, 0];
let kartDotColors: string[] = [];

function buildMinimap(track: TrackRuntime): void {
  mmTrackId = track.def.id;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of track.fenceOuter) {
    const x = fxToFloat(p.x);
    const y = fxToFloat(p.y);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = 9;
  const scale = Math.min(
    (minimap.width - pad * 2) / (maxX - minX),
    (minimap.height - pad * 2) / (maxY - minY),
  );
  const ox = (minimap.width - (maxX - minX) * scale) / 2;
  const oy = (minimap.height - (maxY - minY) * scale) / 2;
  mmProject = (x, y) => [ox + (x - minX) * scale, oy + (maxY - y) * scale]; // sim y is north
  const path = new Path2D();
  for (const loop of [track.outer, track.inner]) {
    loop.forEach((p, i) => {
      const [px, py] = mmProject(fxToFloat(p.x), fxToFloat(p.y));
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    });
    path.closePath();
  }
  mmPath = path;
  const g0 = track.gates[0]!;
  mmStart = [
    ...mmProject(fxToFloat(g0.x0), fxToFloat(g0.y0)),
    ...mmProject(fxToFloat(g0.x1), fxToFloat(g0.y1)),
  ] as [number, number, number, number];
}

function drawMinimap(st: GameState): void {
  if (!controller) return;
  if (mmTrackId !== st.track.def.id) buildMinimap(st.track);
  mmCtx.clearRect(0, 0, minimap.width, minimap.height);
  mmCtx.fillStyle = 'rgba(8, 11, 20, 0.55)';
  mmCtx.fill(mmPath!, 'evenodd');
  mmCtx.strokeStyle = 'rgba(255,255,255,0.5)';
  mmCtx.lineWidth = 1.5;
  mmCtx.stroke(mmPath!);
  if (mmStart) {
    mmCtx.strokeStyle = 'rgba(255, 210, 63, 0.9)';
    mmCtx.beginPath();
    mmCtx.moveTo(mmStart[0], mmStart[1]);
    mmCtx.lineTo(mmStart[2], mmStart[3]);
    mmCtx.stroke();
  }
  if (controller instanceof TimeTrialController) {
    const g = controller.ghostRender();
    if (g) {
      const [px, py] = mmProject(g.x, -g.z); // three z back to sim y
      mmCtx.beginPath();
      mmCtx.arc(px, py, 3.5, 0, Math.PI * 2);
      mmCtx.fillStyle = 'rgba(220, 230, 245, 0.6)';
      mmCtx.fill();
    }
  }
  st.karts.forEach((k, i) => {
    const [px, py] = mmProject(fxToFloat(k.x), fxToFloat(k.y));
    const isYou = i === controller!.you;
    mmCtx.beginPath();
    mmCtx.arc(px, py, isYou ? 4.5 : 3.5, 0, Math.PI * 2);
    mmCtx.fillStyle = kartDotColors[i] ?? KART_COLORS[i % KART_COLORS.length]!;
    mmCtx.fill();
    if (isYou) {
      mmCtx.strokeStyle = '#fff';
      mmCtx.lineWidth = 1.5;
      mmCtx.stroke();
    }
  });
}

// --- final-lap flash + wrong-way warning
let prevLapLocal = 1;
let finalLapUntil = 0;
let wrongSince: number | null = null;

function resetHudState(): void {
  prevLapLocal = 1;
  finalLapUntil = 0;
  wrongSince = null;
  lastHeld = ITEM_NONE;
}

function updateHud(): void {
  if (!controller) return;
  const st = controller.state;
  const me = st.karts[controller.you]!;

  const placements = controller.placements();
  $('hud-pos-num').textContent = String(placements.indexOf(controller.you) + 1);
  $('hud-lap').textContent = `LAP ${Math.min(me.lap, st.cfg.lapCount)}/${st.cfg.lapCount}`;
  $('hud-time').textContent = fmtTime(controller.raceTimeSec());

  const kart = controller.renderKarts(0)[controller.you]!;
  $('hud-speed').textContent = String(Math.round(kart.speed * 60 * 3.6));

  const fill = $('hud-drift-fill');
  const pct = Math.min(1, me.driftCharge / DRIFT_TIER2_TICKS);
  fill.style.width = `${pct * 100}%`;
  fill.style.background =
    me.driftCharge >= DRIFT_TIER2_TICKS ? '#ff9b2f' : me.driftCharge >= DRIFT_TIER1_TICKS ? '#5ee1ff' : '#8b93a7';
  $('hud-boost').classList.toggle('hidden', me.boostTicks <= 0);
  updateItemBadge(st, me);

  const cd = $('hud-countdown');
  if (st.phase === PHASE_COUNTDOWN) {
    const n = Math.ceil((COUNTDOWN_TICKS - st.tick) / 60);
    cd.textContent = String(n);
    cd.classList.remove('hidden');
  } else if (st.tick < COUNTDOWN_TICKS + 50 && st.phase !== PHASE_FINISHED) {
    cd.textContent = 'GO!';
    cd.classList.remove('hidden');
  } else {
    cd.classList.add('hidden');
  }

  if (controller.stalled && st.phase !== PHASE_FINISHED) {
    stallSince = stallSince ?? performance.now();
  } else {
    stallSince = null;
  }
  $('hud-wait').classList.toggle('hidden', !(stallSince && performance.now() - stallSince > 400));

  // FINAL LAP flash on entering the last lap (multi-lap races only)
  if (st.cfg.lapCount > 1 && me.lap === st.cfg.lapCount && prevLapLocal === st.cfg.lapCount - 1) {
    finalLapUntil = performance.now() + 2300;
  }
  prevLapLocal = me.lap;
  $('hud-finallap').classList.toggle('hidden', performance.now() >= finalLapUntil);

  // wrong way: moving away from the next gate for a sustained beat
  const racing = st.phase !== PHASE_COUNTDOWN && st.phase !== PHASE_FINISHED && me.finishTick < 0;
  const gate = st.track.gates[me.nextCp]!;
  const vx = fxToFloat(me.vx);
  const vy = fxToFloat(me.vy);
  const away =
    racing &&
    Math.hypot(vx, vy) > 0.12 &&
    vx * (fxToFloat(gate.cx) - fxToFloat(me.x)) + vy * (fxToFloat(gate.cy) - fxToFloat(me.y)) < 0;
  wrongSince = away ? (wrongSince ?? performance.now()) : null;
  $('hud-wrongway').classList.toggle(
    'hidden',
    !(wrongSince && performance.now() - wrongSince > 900),
  );

  drawMinimap(st);

  if (debugVisible) $('hud-debug').textContent = controller.debugText(clock.rttMs);
}

// Background-tab fallback: RAF stops when a tab is hidden, which would make
// this client stop sending inputs and stall everyone else at the rollback
// window. Worker timers are not throttled, so a tiny worker heartbeat keeps
// the sim (not the renderer) advancing while hidden.
const heartbeatWorker = new Worker(
  URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 50);'], { type: 'text/javascript' })),
);
heartbeatWorker.onmessage = () => {
  if (document.hidden && controller) {
    controller.update();
    if (feats && controller instanceof RaceController) feats.track(controller);
    if (controller.state.phase === PHASE_FINISHED && !resultsShown) {
      resultsShown = true;
      showResults();
    }
  }
};

let lastT = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (controller && screen !== 'home' && screen !== 'lobby') {
    controller.update();
    const karts = controller.renderKarts(dt);
    scene.updateRace(karts, controller.state, controller.you, dt);
    if (controller instanceof TimeTrialController) scene.updateGhost(controller.ghostRender());
    audio.update(controller);
    if (feats && controller instanceof RaceController) feats.track(controller);
    updateHud();
    if (controller instanceof ReplayController && controller.done) exitReplay();
    else if (controller.state.phase === PHASE_FINISHED && !resultsShown) {
      resultsShown = true;
      window.setTimeout(() => showResults(), 1400);
    }
  } else {
    scene.updateIdle(dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
showScreen('home');
