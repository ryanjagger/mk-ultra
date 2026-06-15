/**
 * Adaptive render-resolution controller. Watches smoothed frame time and steps
 * the effective device-pixel-ratio down toward 1× under sustained frame
 * pressure, back up toward the display cap when there's sustained headroom.
 *
 * DPR is the dominant GPU-cost lever — fillrate scales with pixel count, so
 * 2×→1× is roughly a 4× reduction in fragment work — and it adapts smoothly
 * with no shader recompiles, no render-target reallocation, and no feature
 * pop-in. Pure client render concern; nothing here touches the sim.
 */
export class AdaptiveDpr {
  private ema = 16.7; // ms, seeded at 60fps
  private level: number; // index into ladder
  private aboveSince = 0; // ms accumulated over the down-threshold
  private belowSince = 0; // ms accumulated under the up-threshold
  private readonly ladder: number[];

  // cap = the display's native DPR clamped to 2 (== today's hardcoded value at
  // scene.ts setPixelRatio). On a 1× display cap is 1, the ladder has a single
  // rung, and adaptation is a no-op (correct: there's no resolution headroom to
  // give back on a non-HiDPI monitor).
  constructor(private readonly cap: number) {
    this.ladder = [1, 1.5, cap].filter((v, i, a) => v <= cap + 1e-3 && a.indexOf(v) === i);
    this.level = this.ladder.length - 1; // start at full resolution
  }

  current(): number {
    return this.ladder[this.level]!;
  }

  degraded(): boolean {
    return this.current() < this.cap - 1e-3;
  }

  fps(): number {
    return Math.round(1000 / Math.max(1, this.ema));
  }

  /** Feed per-frame dt (seconds). Returns the new DPR if it changed this frame, else null. */
  tick(dtSec: number): number | null {
    const ms = dtSec * 1000;
    this.ema += (ms - this.ema) * 0.1; // ~7-frame half-life: ignores single-frame GC spikes
    const prev = this.current();
    if (this.ema > 22 && this.level > 0) {
      // sustained < ~45fps -> step DOWN after ~1s
      this.aboveSince += ms;
      this.belowSince = 0;
      if (this.aboveSince > 1000) {
        this.level--;
        this.aboveSince = 0;
      }
    } else if (this.ema < 17 && this.level < this.ladder.length - 1) {
      // sustained > ~59fps -> step UP after ~2s
      this.belowSince += ms;
      this.aboveSince = 0;
      if (this.belowSince > 2000) {
        this.level++;
        this.belowSince = 0;
      }
    } else {
      // 17–22ms dead-band: bleed both timers
      this.aboveSince = Math.max(0, this.aboveSince - ms);
      this.belowSince = Math.max(0, this.belowSince - ms);
    }
    const now = this.current();
    return now !== prev ? now : null;
  }
}
