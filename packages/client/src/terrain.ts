/**
 * Float-side terrain sampling for the renderer. Mirrors the sim's height
 * field — piecewise-linear along the centerline, constant across the track
 * width (physics.ts probeSurface/slopeGradient) — and adds a smooth cosine
 * falloff apron beyond the fence so scenery sits on believable ground.
 * World coords throughout: x = sim x, z = -sim y. Float math is fine here:
 * heights are render-only and never fed back into the sim.
 */
import { fxToFloat, type TrackRuntime } from '@mk/sim';

/** Ground falloff distance beyond the fence (matches the apron meshes). */
export const APRON_REACH = 26;

export class Terrain {
  readonly hasHills: boolean;
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly hs: number[] = [];
  private readonly fences: number[] = [];
  // nearest() scratch
  private nh = 0; // lerped height
  private nd = 0; // distance to the centerline
  private nf = 0; // lerped fence half-width

  constructor(track: TrackRuntime) {
    this.hasHills = track.hasHills;
    const n = track.centerline.length;
    for (let i = 0; i < n; i++) {
      const c = track.centerline[i]!;
      const f = track.fenceOuter[i]!;
      const x = fxToFloat(c.x);
      const z = -fxToFloat(c.y);
      this.xs.push(x);
      this.zs.push(z);
      this.hs.push(fxToFloat(track.heights[i]!));
      this.fences.push(Math.hypot(fxToFloat(f.x) - x, -fxToFloat(f.y) - z));
    }
  }

  private nearest(x: number, z: number): void {
    const n = this.xs.length;
    let bestD = Infinity;
    let bestH = 0;
    let bestF = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = this.xs[i]!;
      const az = this.zs[i]!;
      const abx = this.xs[j]! - ax;
      const abz = this.zs[j]! - az;
      const den = abx * abx + abz * abz;
      if (den === 0) continue;
      let t = ((x - ax) * abx + (z - az) * abz) / den;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + abx * t);
      const dz = z - (az + abz * t);
      const d = Math.hypot(dx, dz);
      if (d < bestD) {
        bestD = d;
        bestH = this.hs[i]! + (this.hs[j]! - this.hs[i]!) * t;
        bestF = this.fences[i]! + (this.fences[j]! - this.fences[i]!) * t;
      }
    }
    this.nd = bestD;
    this.nh = bestH;
    this.nf = bestF;
  }

  /** Track-surface height at world (x, z) — what karts and the camera ride on. */
  heightAt(x: number, z: number): number {
    if (!this.hasHills) return 0;
    this.nearest(x, z);
    return this.nh;
  }

  /** Ground height for scenery: track height fading to the valley floor beyond the fence. */
  groundHeightAt(x: number, z: number): number {
    if (!this.hasHills) return 0;
    this.nearest(x, z);
    const over = this.nd - this.nf;
    if (over <= 0) return this.nh;
    const u = over / APRON_REACH;
    if (u >= 1) return 0;
    return (this.nh * (Math.cos(Math.PI * u) + 1)) / 2;
  }

  /** dh per unit of travel at (x, z) along a world yaw (kart headingRad). */
  slopeAlong(x: number, z: number, yaw: number): number {
    if (!this.hasHills) return 0;
    const d = 1.1;
    const fx = Math.cos(yaw) * d;
    const fz = -Math.sin(yaw) * d;
    return (this.heightAt(x + fx, z + fz) - this.heightAt(x - fx, z - fz)) / (2 * d);
  }
}
