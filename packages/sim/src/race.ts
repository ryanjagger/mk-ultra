/**
 * Race structure: checkpoint gates, lap counting, finish detection and
 * placement ordering. Gates span the full track width, so the route cannot
 * be skipped (FR-6); a gate only counts when it is the kart's `nextCp` and
 * is crossed in the forward direction.
 */
import { type Fx, sub, len, wideCross, wideDot } from './fixed.js';
import {
  type GameState,
  type KartState,
  PHASE_FINISHED,
  PHASE_RACING,
  STRAGGLER_TICKS,
  MAX_RACE_TICKS,
  COUNTDOWN_TICKS,
} from './state.js';
import type { Gate } from './track.js';

/** Did the move p0->p1 cross the gate segment, travelling forward through it? */
function crossedGate(g: Gate, x0: Fx, y0: Fx, x1: Fx, y1: Fx): boolean {
  const gx = sub(g.x1, g.x0);
  const gy = sub(g.y1, g.y0);
  // sides of the gate line before/after the move
  const s0 = wideCross(gx, gy, sub(x0, g.x0), sub(y0, g.y0));
  const s1 = wideCross(gx, gy, sub(x1, g.x0), sub(y1, g.y0));
  if (s0 >= 0 === s1 >= 0) return false;
  // movement segment must straddle the gate's endpoints too
  const mx = sub(x1, x0);
  const my = sub(y1, y0);
  const t0 = wideCross(mx, my, sub(g.x0, x0), sub(g.y0, y0));
  const t1 = wideCross(mx, my, sub(g.x1, x0), sub(g.y1, y0));
  if (t0 >= 0 === t1 >= 0) return false;
  // and the crossing must be in the gate's forward direction
  return wideDot(mx, my, g.nx, g.ny) > 0;
}

/** Called per kart per tick with the pre-move position. */
export function stepCheckpoints(st: GameState, kart: KartState, prevX: Fx, prevY: Fx): void {
  if (kart.finishTick >= 0) return;
  const gate = st.track.gates[kart.nextCp]!;
  if (!crossedGate(gate, prevX, prevY, kart.x, kart.y)) return;
  if (kart.nextCp === 0) {
    kart.lap += 1;
    kart.nextCp = 1;
    if (kart.lap > st.cfg.lapCount) {
      kart.finishTick = st.tick;
    }
  } else {
    kart.nextCp = kart.nextCp + 1 === st.track.gates.length ? 0 : kart.nextCp + 1;
  }
}

/** Gates passed this lap, monotone within a lap (nextCp 0 means all passed). */
function progressOrd(st: GameState, kart: KartState): number {
  return kart.nextCp === 0 ? st.track.gates.length : kart.nextCp;
}

function distToNextGate(st: GameState, kart: KartState): Fx {
  const g = st.track.gates[kart.nextCp]!;
  return len(sub(g.cx, kart.x), sub(g.cy, kart.y));
}

/**
 * Current placement order: finished karts by finish tick, then by race
 * progress. Total order (kart index as final tiebreak) -> deterministic.
 */
export function computePlacements(st: GameState): number[] {
  const idx = st.karts.map((_, i) => i);
  const key = idx.map((i) => {
    const k = st.karts[i]!;
    return {
      finished: k.finishTick >= 0 ? 1 : 0,
      finishTick: k.finishTick >= 0 ? k.finishTick : 0x7fffffff,
      lap: k.lap,
      ord: progressOrd(st, k),
      dist: distToNextGate(st, k),
    };
  });
  idx.sort((a, b) => {
    const ka = key[a]!;
    const kb = key[b]!;
    if (ka.finished !== kb.finished) return kb.finished - ka.finished;
    if (ka.finishTick !== kb.finishTick) return ka.finishTick - kb.finishTick;
    if (ka.lap !== kb.lap) return kb.lap - ka.lap;
    if (ka.ord !== kb.ord) return kb.ord - ka.ord;
    if (ka.dist !== kb.dist) return ka.dist - kb.dist;
    return a - b;
  });
  return idx;
}

/** Phase transitions; call once per tick after movement/checkpoints. */
export function stepRacePhase(st: GameState): void {
  if (st.phase === PHASE_FINISHED) return;
  if (st.phase === PHASE_RACING) {
    let allDone = true;
    let firstFinish = -1;
    for (const k of st.karts) {
      if (k.finishTick < 0) allDone = false;
      else if (firstFinish < 0 || k.finishTick < firstFinish) firstFinish = k.finishTick;
    }
    const stragglerCut = firstFinish >= 0 && st.tick > firstFinish + STRAGGLER_TICKS;
    const hardCap = st.tick > COUNTDOWN_TICKS + MAX_RACE_TICKS;
    if (allDone || stragglerCut || hardCap) {
      st.phase = PHASE_FINISHED;
      st.endTick = st.tick;
    }
  }
}
