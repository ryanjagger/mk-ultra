/**
 * Track model and derived geometry. A TrackDef is pure data on an integer-ish
 * grid (exact in Q16.16 via fxConst); buildTrack derives asphalt edges, dirt
 * fence, walls, checkpoint gates, item spawns and boost pads once at module
 * init using only fx ops, so the derived geometry is bit-identical everywhere.
 *
 * Two corridors per track:
 *   - asphalt: centerline ± halfWidth[v]  (inner/outer loops)
 *   - fence:   centerline ± (halfWidth[v] + dirt[v])  (fenceInner/fenceOuter)
 * Walls and checkpoint gates live on the FENCE (dirt cannot bypass either);
 * items and boost pads live on the asphalt. dirt[v] = 0 makes both corridors
 * identical (the v1 classic track is exactly this, preserving v1 hashes).
 */
import {
  type Fx,
  fxConst,
  FX_ONE,
  add,
  sub,
  mul,
  div,
  len,
  clamp,
  max,
} from './fixed.js';
import { TRACK_DEFS } from './track-defs.js';

export interface Vec2Fx {
  x: Fx;
  y: Fx;
}

/** Render-only color/decor data; the sim never reads it. */
export interface TrackTheme {
  sky: string;
  fog: string;
  ground: string;
  asphalt: string;
  dirt: string;
  wallA: string;
  wallB: string;
  decor: 'trees' | 'cacti' | 'neon' | 'snow';
  night?: boolean;
}

export interface TrackDefVertex {
  x: number;
  y: number;
  /** asphalt half-width in units (default DEFAULT_HALF_WIDTH) */
  w?: number;
  /** dirt margin beyond the asphalt, in units (default 0 = wall at asphalt) */
  dirt?: number;
}

export interface TrackDefPad {
  /** centerline vertex the pad sits at */
  vert: number;
  /** lateral position across the asphalt: 0 = inner edge, 1 = outer edge */
  t: number;
  /** half-length along the direction of travel, units (default 1.6) */
  halfLen?: number;
  /** half-width across the track, units (default 1.1) */
  halfWid?: number;
}

export interface TrackDef {
  id: string;
  name: string;
  verts: readonly TrackDefVertex[];
  checkpointVerts: readonly number[];
  itemVerts: readonly number[];
  boostPads: readonly TrackDefPad[];
  /** [x, y, headingBrads] per grid slot, front to back */
  spawns: ReadonlyArray<readonly [number, number, number]>;
  laps?: number;
  theme: TrackTheme;
}

export interface WallSeg {
  x0: Fx;
  y0: Fx;
  x1: Fx;
  y1: Fx;
  // AABB expanded by kart radius + margin, for the cheap pre-filter
  minX: Fx;
  minY: Fx;
  maxX: Fx;
  maxY: Fx;
}

export interface Gate {
  x0: Fx;
  y0: Fx;
  x1: Fx;
  y1: Fx;
  cx: Fx;
  cy: Fx;
  // unit forward normal (direction of travel through the gate)
  nx: Fx;
  ny: Fx;
}

/** A mystery item box; what it grants is rolled on pickup (see items.ts). */
export interface ItemSpawn {
  x: Fx;
  y: Fx;
}

export interface BoostPad {
  cx: Fx;
  cy: Fx;
  /** unit direction of travel */
  dx: Fx;
  dy: Fx;
  halfLen: Fx;
  halfWid: Fx;
}

export interface SpawnPose {
  x: Fx;
  y: Fx;
  heading: number; // brads
}

export interface TrackRuntime {
  def: TrackDef;
  centerline: Vec2Fx[];
  /** asphalt edges */
  inner: Vec2Fx[];
  outer: Vec2Fx[];
  /** wall fence (asphalt + dirt margin) */
  fenceInner: Vec2Fx[];
  fenceOuter: Vec2Fx[];
  /** per-vertex asphalt half-width (fx) */
  halfWidths: Fx[];
  /** does any vertex have a dirt margin? (skip surface checks when not) */
  hasDirt: boolean;
  walls: WallSeg[];
  gates: Gate[];
  itemSpawns: ItemSpawn[];
  boostPads: BoostPad[];
  spawns: SpawnPose[];
}

export const DEFAULT_HALF_WIDTH = 6;
const MITER_MIN_COS: Fx = fxConst(0.5); // caps miter length at 2x half-width

export const KART_RADIUS: Fx = fxConst(0.8);

function normalize(dx: Fx, dy: Fx): Vec2Fx {
  const l = len(dx, dy);
  if (l === 0) return { x: FX_ONE, y: 0 };
  return { x: div(dx, l), y: div(dy, l) };
}

export function buildTrack(def: TrackDef): TrackRuntime {
  const n = def.verts.length;
  const pts: Vec2Fx[] = def.verts.map((v) => ({ x: fxConst(v.x), y: fxConst(v.y) }));
  const halfWidths: Fx[] = def.verts.map((v) => fxConst(v.w ?? DEFAULT_HALF_WIDTH));
  const fenceWidths: Fx[] = def.verts.map((v) =>
    fxConst((v.w ?? DEFAULT_HALF_WIDTH) + (v.dirt ?? 0)),
  );
  const hasDirt = def.verts.some((v) => (v.dirt ?? 0) > 0);

  const inner: Vec2Fx[] = [];
  const outer: Vec2Fx[] = [];
  const fenceInner: Vec2Fx[] = [];
  const fenceOuter: Vec2Fx[] = [];
  const tangents: Vec2Fx[] = [];

  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const d1 = normalize(sub(cur.x, prev.x), sub(cur.y, prev.y));
    const d2 = normalize(sub(next.x, cur.x), sub(next.y, cur.y));
    // left normals (interior side for a CCW loop)
    const n1 = { x: -d1.y | 0, y: d1.x };
    const n2 = { x: -d2.y | 0, y: d2.x };
    const m = normalize(add(n1.x, n2.x), add(n1.y, n2.y));
    const cosHalf = max(add(mul(m.x, n1.x), mul(m.y, n1.y)), MITER_MIN_COS);
    const scale = div(halfWidths[i]!, cosHalf);
    inner.push({ x: add(cur.x, mul(m.x, scale)), y: add(cur.y, mul(m.y, scale)) });
    outer.push({ x: sub(cur.x, mul(m.x, scale)), y: sub(cur.y, mul(m.y, scale)) });
    const fScale = div(fenceWidths[i]!, cosHalf);
    fenceInner.push({ x: add(cur.x, mul(m.x, fScale)), y: add(cur.y, mul(m.y, fScale)) });
    fenceOuter.push({ x: sub(cur.x, mul(m.x, fScale)), y: sub(cur.y, mul(m.y, fScale)) });
    tangents.push(normalize(add(d1.x, d2.x), add(d1.y, d2.y)));
  }

  const margin = add(KART_RADIUS, fxConst(0.2));
  const mkWall = (a: Vec2Fx, b: Vec2Fx): WallSeg => ({
    x0: a.x,
    y0: a.y,
    x1: b.x,
    y1: b.y,
    minX: sub(a.x < b.x ? a.x : b.x, margin),
    minY: sub(a.y < b.y ? a.y : b.y, margin),
    maxX: add(a.x > b.x ? a.x : b.x, margin),
    maxY: add(a.y > b.y ? a.y : b.y, margin),
  });

  const walls: WallSeg[] = [];
  for (let i = 0; i < n; i++) {
    walls.push(mkWall(fenceInner[i]!, fenceInner[(i + 1) % n]!));
  }
  for (let i = 0; i < n; i++) {
    walls.push(mkWall(fenceOuter[i]!, fenceOuter[(i + 1) % n]!));
  }

  // gates span the FULL corridor (fence to fence): dirt cannot skip checkpoints
  const gates: Gate[] = def.checkpointVerts.map((v) => {
    const a = fenceInner[v]!;
    const b = fenceOuter[v]!;
    const t = tangents[v]!;
    const c = pts[v]!;
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, cx: c.x, cy: c.y, nx: t.x, ny: t.y };
  });

  // items sit on the asphalt
  const itemSpawns: ItemSpawn[] = [];
  for (const v of def.itemVerts) {
    const a = inner[v]!;
    const b = outer[v]!;
    for (const tQ of [fxConst(0.25), fxConst(0.5), fxConst(0.75)]) {
      itemSpawns.push({
        x: add(a.x, mul(sub(b.x, a.x), tQ)),
        y: add(a.y, mul(sub(b.y, a.y), tQ)),
      });
    }
  }

  const boostPads: BoostPad[] = def.boostPads.map((p) => {
    const a = inner[p.vert]!;
    const b = outer[p.vert]!;
    const tQ = fxConst(p.t);
    const tan = tangents[p.vert]!;
    return {
      cx: add(a.x, mul(sub(b.x, a.x), tQ)),
      cy: add(a.y, mul(sub(b.y, a.y), tQ)),
      dx: tan.x,
      dy: tan.y,
      halfLen: fxConst(p.halfLen ?? 1.6),
      halfWid: fxConst(p.halfWid ?? 1.1),
    };
  });

  const spawns: SpawnPose[] = def.spawns.map(([x, y, heading]) => ({
    x: fxConst(x),
    y: fxConst(y),
    heading,
  }));

  return {
    def,
    centerline: pts,
    inner,
    outer,
    fenceInner,
    fenceOuter,
    halfWidths,
    hasDirt,
    walls,
    gates,
    itemSpawns,
    boostPads,
    spawns,
  };
}

/** All tracks, built eagerly and deterministically at module init. */
export const TRACKS: readonly TrackRuntime[] = TRACK_DEFS.map(buildTrack);

export const DEFAULT_TRACK_ID = TRACK_DEFS[0]!.id;

/** Look up a built track; undefined id falls back to the classic track. */
export function getTrack(id: string | undefined): TrackRuntime {
  if (id === undefined) return TRACKS[0]!;
  for (const t of TRACKS) {
    if (t.def.id === id) return t;
  }
  throw new Error(`unknown track id: ${id}`);
}

export function isTrackId(id: string): boolean {
  for (const t of TRACKS) {
    if (t.def.id === id) return true;
  }
  return false;
}

/** World bound (units) — keeps wide-math products exact; positions are clamped to it. */
export const WORLD_BOUND: Fx = fxConst(400);

export function clampWorld(v: Fx): Fx {
  return clamp(v, -WORLD_BOUND | 0, WORLD_BOUND);
}
