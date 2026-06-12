/**
 * Track definitions — pure data, all coordinates on an integer-ish grid so
 * fxConst conversion is exact. Themes are render-only.
 *
 * Authoring rules (enforced by sim/test/tracks.test.ts):
 *  - centerline is a CCW closed loop; interior on the left of travel
 *  - no fence self-intersection (mind wide dirt at sharp corners)
 *  - >= 2 checkpoint verts, first one is the start/finish line
 *  - 4 spawn poses behind the start line, on the asphalt
 *  - the greedy gate-seeking bot must be able to finish (gates visible
 *    around corners — add intermediate gates on tight sections)
 *  - coordinates within +-400 units (wide-math exactness bound)
 */
import type { TrackDef } from './track.js';

const SUNNY_CIRCUIT: TrackDef = {
  id: 'sunny-circuit',
  name: 'Sunny Circuit',
  verts: [
    { x: -20, y: -40 }, // 0: start/finish
    { x: 20, y: -40 },
    { x: 52, y: -34 },
    { x: 70, y: -14 },
    { x: 70, y: 16 },
    { x: 56, y: 38 },
    { x: 32, y: 48 },
    { x: 8, y: 46 },
    { x: -12, y: 30 }, // 8: chicane dip
    { x: -32, y: 40 },
    { x: -52, y: 48 },
    { x: -72, y: 38 },
    { x: -82, y: 14 },
    { x: -82, y: -14 },
    { x: -68, y: -36 },
    { x: -46, y: -40 },
  ],
  checkpointVerts: [0, 2, 4, 6, 8, 10, 12, 14],
  itemVerts: [1, 6, 13],
  boostPads: [],
  spawns: [
    [-25, -42.4, 0],
    [-25, -37.6, 0],
    [-29, -42.4, 0],
    [-29, -37.6, 0],
  ],
  theme: {
    sky: '#7eb6e8',
    fog: '#7eb6e8',
    ground: '#58a05c',
    asphalt: '#3b3e47',
    dirt: '#9a8a58',
    wallA: '#e74a4a',
    wallB: '#f3efe6',
    decor: 'trees',
  },
};

/**
 * Canyon Sprint — fast desert sweepers with sandy runoff, pinching into a
 * tight walled hairpin. Risk the wide dirt lines or thread the asphalt.
 */
const CANYON_SPRINT: TrackDef = {
  id: 'canyon-sprint',
  name: 'Canyon Sprint',
  verts: [
    { x: -30, y: -60, w: 7, dirt: 6 }, // 0: start, bottom straight
    { x: 20, y: -60, w: 7, dirt: 6 },
    { x: 60, y: -52, w: 8, dirt: 7 },
    { x: 90, y: -30, w: 9, dirt: 8 }, // fast right-hand sweep
    { x: 100, y: 0, w: 9, dirt: 8 },
    { x: 95, y: 30, w: 9, dirt: 8 },
    { x: 75, y: 50, w: 8, dirt: 5 },
    { x: 45, y: 56, w: 7 },
    { x: 15, y: 50, w: 7 }, // hairpin approach
    { x: -5, y: 30, w: 6 },
    { x: -15, y: 5, w: 5 }, // hairpin: narrow, hard walls
    { x: -45, y: 2, w: 5 },
    { x: -55, y: 28, w: 6 }, // hairpin exit
    { x: -70, y: 45, w: 7 },
    { x: -95, y: 38, w: 7, dirt: 4 },
    { x: -108, y: 12, w: 7, dirt: 5 }, // left sweeper, sandy runoff
    { x: -106, y: -20, w: 7, dirt: 5 },
    { x: -90, y: -45, w: 7, dirt: 4 },
    { x: -60, y: -60, w: 7, dirt: 5 },
  ],
  checkpointVerts: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
  itemVerts: [1, 7, 14],
  boostPads: [
    { vert: 12, t: 0.5 }, // hairpin exit reward
    { vert: 1, t: 0.3 },
    { vert: 1, t: 0.7 },
  ],
  spawns: [
    [-35, -62.4, 0],
    [-35, -57.6, 0],
    [-39, -62.4, 0],
    [-39, -57.6, 0],
  ],
  theme: {
    sky: '#f4c98a',
    fog: '#eebd7d',
    ground: '#c9a55f',
    asphalt: '#4a4038',
    dirt: '#d9b36c',
    wallA: '#b4502e',
    wallB: '#e8d7b0',
    decor: 'cacti',
    weather: 'dust',
  },
};

/**
 * Neon Gauntlet — tight night-city snake with unforgiving walls, two
 * pinch points and boost pads that reward clean lines.
 */
const NEON_GAUNTLET: TrackDef = {
  id: 'neon-gauntlet',
  name: 'Neon Gauntlet',
  verts: [
    { x: -70, y: -40, w: 5.5 }, // 0
    { x: -30, y: -40, w: 5.5 }, // 1: start (bottom straight)
    { x: 10, y: -40, w: 5.5 },
    { x: 40, y: -34, w: 5.5 },
    { x: 58, y: -12, w: 5.5 },
    { x: 50, y: 12, w: 5.5 },
    { x: 28, y: 22, w: 4 }, // 6: pinch one
    { x: 6, y: 14, w: 5 },
    { x: -8, y: 28, w: 5 }, // snake back up
    { x: 2, y: 46, w: 5 },
    { x: 28, y: 58, w: 5.5 },
    { x: -6, y: 64, w: 5.5 }, // top run, heading west
    { x: -40, y: 58, w: 4.5 }, // 12: pinch two
    { x: -64, y: 38, w: 5.5 },
    { x: -76, y: 12, w: 5.5 },
    { x: -76, y: -16, w: 5.5 },
  ],
  checkpointVerts: [1, 3, 5, 7, 9, 11, 13, 15],
  itemVerts: [2, 9, 14],
  boostPads: [
    { vert: 1, t: 0.5 },
    { vert: 4, t: 0.5 },
    { vert: 7, t: 0.5 }, // pinch-one exit
    { vert: 13, t: 0.5 }, // pinch-two exit
  ],
  spawns: [
    [-35, -42.2, 0],
    [-35, -37.8, 0],
    [-39, -42.2, 0],
    [-39, -37.8, 0],
  ],
  theme: {
    sky: '#0b0e1f',
    fog: '#141833',
    ground: '#0d1022',
    asphalt: '#323a5e',
    dirt: '#1c2033',
    wallA: '#ff2e88',
    wallB: '#21e6c1',
    decor: 'neon',
    night: true,
    weather: 'fireflies',
  },
};

/**
 * Glacier GP — huge, wide and fast with long drift corners and deep snow
 * margins everywhere. Hold your drift or get swallowed by the powder.
 */
const GLACIER_GP: TrackDef = {
  id: 'glacier-gp',
  name: 'Glacier GP',
  verts: [
    { x: -40, y: -70, w: 9, dirt: 7 }, // 0: start
    { x: 10, y: -70, w: 9, dirt: 7 },
    { x: 55, y: -62, w: 9, dirt: 7 },
    { x: 90, y: -40, w: 9, dirt: 7 },
    { x: 105, y: -5, w: 9, dirt: 7 },
    { x: 95, y: 30, w: 9, dirt: 7 },
    { x: 70, y: 52, w: 9, dirt: 7 },
    { x: 38, y: 60, w: 8, dirt: 6 },
    { x: 5, y: 55, w: 8, dirt: 6 }, // gentle waist
    { x: -28, y: 58, w: 8, dirt: 6 },
    { x: -60, y: 52, w: 9, dirt: 7 },
    { x: -88, y: 32, w: 9, dirt: 7 },
    { x: -100, y: 0, w: 9, dirt: 7 },
    { x: -95, y: -32, w: 9, dirt: 7 },
    { x: -85, y: -50, w: 9, dirt: 7 },
    { x: -70, y: -70, w: 9, dirt: 7 },
  ],
  checkpointVerts: [0, 2, 4, 6, 8, 10, 12, 14],
  itemVerts: [1, 7, 12],
  boostPads: [{ vert: 9, t: 0.5 }],
  spawns: [
    [-45, -72.4, 0],
    [-45, -67.6, 0],
    [-49, -72.4, 0],
    [-49, -67.6, 0],
  ],
  theme: {
    sky: '#cfe3f5',
    fog: '#dbe9f7',
    ground: '#eef4fb',
    asphalt: '#46505e',
    dirt: '#f7fafd',
    wallA: '#3a76c4',
    wallB: '#ffffff',
    decor: 'snow',
    weather: 'snow',
  },
};

/**
 * Summit Pass — the hill track. A long climb up the eastern sweepers to a
 * narrow crest, then a fast plunging descent through walled esses back to
 * the valley floor. Heights stay gentle (|slope| <= ~0.12) so the greedy
 * bot can always power up; the start straight is flat so nobody creeps
 * downhill during the countdown.
 */
const SUMMIT_PASS: TrackDef = {
  id: 'summit-pass',
  name: 'Summit Pass',
  verts: [
    { x: -30, y: -55, w: 7, dirt: 4 }, // 0: start, valley straight (flat)
    { x: 15, y: -55, w: 7, dirt: 4 },
    { x: 55, y: -48, w: 7, dirt: 3 }, // 2: turn one, the climb begins
    { x: 85, y: -28, w: 7, dirt: 3, h: 2.5 },
    { x: 98, y: 2, w: 8, dirt: 3, h: 6 }, // climbing right-hand sweep
    { x: 92, y: 32, w: 8, dirt: 3, h: 9.5 },
    { x: 68, y: 52, w: 7, h: 12 }, // 6: summit approach
    { x: 38, y: 62, w: 6, h: 13.5 }, // 7: the crest — narrow, no runoff
    { x: 5, y: 58, w: 7, h: 13 }, // 8: over the top, descent begins
    { x: -25, y: 45, w: 8, dirt: 4, h: 10 },
    { x: -45, y: 20, w: 6, h: 6.5 }, // 10: walled downhill ess
    { x: -75, y: 30, w: 6, h: 7.5 }, // 11: counter-rise kicker
    { x: -98, y: 12, w: 7, dirt: 3, h: 5 },
    { x: -105, y: -18, w: 7, dirt: 3, h: 2.5 }, // final drop
    { x: -88, y: -44, w: 7, dirt: 4, h: 0.5 },
    { x: -60, y: -55, w: 7, dirt: 4 },
  ],
  checkpointVerts: [0, 2, 4, 6, 8, 10, 12, 14],
  itemVerts: [1, 6, 12],
  boostPads: [
    { vert: 8, t: 0.5 }, // crest exit: launch the descent
    { vert: 15, t: 0.5 },
  ],
  spawns: [
    [-35, -57.4, 0],
    [-35, -52.6, 0],
    [-39, -57.4, 0],
    [-39, -52.6, 0],
  ],
  theme: {
    sky: '#8fc1e3',
    fog: '#a9cfe8',
    ground: '#5c8a50',
    asphalt: '#41454f',
    dirt: '#8c7a4e',
    wallA: '#d94f3d',
    wallB: '#f2efe4',
    decor: 'trees',
  },
};

/**
 * Mesa Drop — desert night. A long climb to the mesa top, then a launch
 * ramp fires you down the descent: the road falls away beneath the jump.
 * A second hop on the start straight clears the oil-bait pinch.
 */
const MESA_DROP: TrackDef = {
  id: 'mesa-drop',
  name: 'Mesa Drop',
  verts: [
    { x: -40, y: -70, w: 8, dirt: 5 }, // 0: start, valley floor (flat)
    { x: 10, y: -70, w: 8, dirt: 5 },
    { x: 55, y: -62, w: 8, dirt: 4 }, // 2: turn one, the climb begins
    { x: 88, y: -38, w: 8, dirt: 3, h: 3 },
    { x: 102, y: -5, w: 8, h: 6.5 }, // walled climbing sweep
    { x: 95, y: 28, w: 7, dirt: 3, h: 10 },
    { x: 70, y: 50, w: 7, h: 12.5 }, // 6: mesa rim
    { x: 38, y: 60, w: 7, h: 14 }, // 7: mesa top — the big ramp
    { x: 4, y: 56, w: 8, dirt: 4, h: 12 }, // landing zone, descent begins
    { x: -28, y: 44, w: 8, dirt: 4, h: 8 },
    { x: -52, y: 24, w: 6, h: 5 }, // 10: walled downhill ess
    { x: -80, y: 30, w: 6, h: 6 }, // counter-rise kicker
    { x: -100, y: 8, w: 7, dirt: 3, h: 4 },
    { x: -106, y: -24, w: 7, dirt: 3, h: 1.5 },
    { x: -86, y: -50, w: 8, dirt: 4 }, // back on the valley floor
    { x: -58, y: -66, w: 8, dirt: 5 },
  ],
  checkpointVerts: [0, 2, 4, 6, 8, 10, 12, 14],
  itemVerts: [1, 8, 12],
  boostPads: [
    { vert: 6, t: 0.5 }, // rim run-up: hit the big ramp flat out
    { vert: 15, t: 0.5 },
  ],
  ramps: [
    { vert: 7, t: 0.5, halfLen: 1.7, halfWid: 3, power: 0.2 }, // the drop
    { vert: 1, t: 0.35, halfLen: 1.6, halfWid: 1.6 }, // optional valley hop
  ],
  spawns: [
    [-45, -72.4, 0],
    [-45, -67.6, 0],
    [-49, -72.4, 0],
    [-49, -67.6, 0],
  ],
  theme: {
    sky: '#1a1430',
    fog: '#241c3e',
    ground: '#7a5c3e',
    asphalt: '#3a3f4a',
    dirt: '#9c7a4d',
    wallA: '#e0762e',
    wallB: '#f0e4d0',
    decor: 'cacti',
    night: true,
    weather: 'dust',
  },
};

/**
 * The Colosseum — battle arena. A fat octagonal ring under the lights:
 * item boxes everywhere, two ramps for shell-dodging jumps, nowhere to
 * hide. Races run on it as a plain oval, but it's built for balloons.
 */
const COLOSSEUM: TrackDef = {
  id: 'colosseum',
  name: 'The Colosseum',
  arena: true,
  verts: [
    { x: 55, y: 0, w: 14 }, // 0
    { x: 39, y: 39, w: 14 },
    { x: 0, y: 55, w: 14 },
    { x: -39, y: 39, w: 14 },
    { x: -55, y: 0, w: 14 },
    { x: -39, y: -39, w: 14 },
    { x: 0, y: -55, w: 14 },
    { x: 39, y: -39, w: 14 },
  ],
  checkpointVerts: [0, 2, 4, 6],
  itemVerts: [1, 3, 5, 7],
  boostPads: [
    { vert: 0, t: 0.5 },
    { vert: 4, t: 0.5 },
  ],
  ramps: [
    { vert: 2, t: 0.5, halfLen: 1.6, halfWid: 2.4 },
    { vert: 6, t: 0.5, halfLen: 1.6, halfWid: 2.4 },
  ],
  spawns: [
    [55, -8, 16384],
    [50, -8, 16384],
    [60, -8, 16384],
    [55, -14, 16384],
  ],
  theme: {
    sky: '#101022',
    fog: '#181830',
    ground: '#23253c',
    asphalt: '#3c4254',
    dirt: '#2a2d44',
    wallA: '#ffd23f',
    wallB: '#e84a5f',
    decor: 'neon',
    night: true,
  },
};

export const TRACK_DEFS: readonly TrackDef[] = [
  SUNNY_CIRCUIT,
  CANYON_SPRINT,
  NEON_GAUNTLET,
  GLACIER_GP,
  SUMMIT_PASS,
  MESA_DROP,
  COLOSSEUM,
];
