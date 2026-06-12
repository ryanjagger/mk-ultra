/**
 * Track authoring gate: every registered track must be geometrically sound
 * (no self-intersecting walls, everything in bounds, spawns/items/pads on
 * asphalt) — a bad track def fails the build, not the players.
 * Completability is covered by the all-tracks bot race in determinism.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  TRACKS,
  MAX_PLAYERS,
  WORLD_BOUND,
  onDirt,
  fxToFloat,
  createGameState,
  hashState,
  snapshotInts,
  type Vec2Fx,
  type TrackRuntime,
} from '../src/index.js';

type Pt = { x: number; y: number };
const toF = (p: Vec2Fx): Pt => ({ x: fxToFloat(p.x), y: fxToFloat(p.y) });

function segsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** All non-adjacent segment pairs within a loop, plus every pair across loops. */
function loopSelfIntersects(loop: Pt[]): boolean {
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // skip adjacent segments (they share an endpoint)
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (
        segsIntersect(loop[i]!, loop[(i + 1) % n]!, loop[j]!, loop[(j + 1) % n]!)
      ) {
        return true;
      }
    }
  }
  return false;
}

function loopsCross(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segsIntersect(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) {
        return true;
      }
    }
  }
  return false;
}

describe.each(TRACKS.map((t) => [t.def.id, t] as [string, TrackRuntime]))(
  'track %s',
  (_id, track) => {
    it('has sane structure', () => {
      expect(track.gates.length).toBeGreaterThanOrEqual(2);
      expect(track.spawns.length).toBeGreaterThanOrEqual(MAX_PLAYERS);
      expect(track.itemSpawns.length).toBeGreaterThan(0);
      expect(track.itemSpawns.length).toBeLessThanOrEqual(64);
      expect(track.def.verts.length).toBeGreaterThanOrEqual(8);
    });

    it('stays inside the wide-math world bound', () => {
      const bound = fxToFloat(WORLD_BOUND);
      for (const loop of [track.centerline, track.inner, track.outer, track.fenceInner, track.fenceOuter]) {
        for (const p of loop) {
          expect(Math.abs(fxToFloat(p.x))).toBeLessThanOrEqual(bound);
          expect(Math.abs(fxToFloat(p.y))).toBeLessThanOrEqual(bound);
        }
      }
    });

    it('has no self-intersecting or crossing corridor loops', () => {
      const fi = track.fenceInner.map(toF);
      const fo = track.fenceOuter.map(toF);
      const ai = track.inner.map(toF);
      const ao = track.outer.map(toF);
      expect(loopSelfIntersects(fi), 'fenceInner self-intersects').toBe(false);
      expect(loopSelfIntersects(fo), 'fenceOuter self-intersects').toBe(false);
      expect(loopSelfIntersects(ai), 'inner self-intersects').toBe(false);
      expect(loopSelfIntersects(ao), 'outer self-intersects').toBe(false);
      expect(loopsCross(fi, fo), 'fence loops cross each other').toBe(false);
    });

    it('keeps spawns, items and pads on the asphalt', () => {
      for (const s of track.spawns) {
        expect(onDirt(track, s.x, s.y), 'spawn off asphalt').toBe(false);
      }
      for (const i of track.itemSpawns) {
        expect(onDirt(track, i.x, i.y), 'item off asphalt').toBe(false);
      }
      for (const p of track.boostPads) {
        expect(onDirt(track, p.cx, p.cy), 'pad off asphalt').toBe(false);
      }
    });

    it('has forward-facing, non-degenerate gates', () => {
      for (const g of track.gates) {
        const lenSq =
          (fxToFloat(g.x1) - fxToFloat(g.x0)) ** 2 + (fxToFloat(g.y1) - fxToFloat(g.y0)) ** 2;
        expect(lenSq).toBeGreaterThan(4);
        expect(Math.hypot(fxToFloat(g.nx), fxToFloat(g.ny))).toBeCloseTo(1, 1);
      }
    });

    it('creates and hashes race state', () => {
      const cfg = { seed: 1, lapCount: 3, playerCount: 4, trackId: track.def.id };
      const st = createGameState(cfg);
      expect(st.items.length).toBe(track.itemSpawns.length);
      // globals + karts + boxes + shell pool (8x7) + oil pool (12x4)
      expect(snapshotInts(cfg)).toBe(4 + 4 * 14 + track.itemSpawns.length + 8 * 7 + 12 * 4);
      expect(hashState(st)).toBeGreaterThan(0);
    });
  },
);
