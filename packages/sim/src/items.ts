/**
 * Item system. v1 has one item type (speed boost) but pickup/effect are
 * separated so new types slot in without rework (FR-16): add an entry to
 * ITEM_EFFECTS and give spawns a different itemType.
 */
import { sub, len, fxConst, type Fx } from './fixed.js';
import { rngNextState, rngValue, rngRange } from './prng.js';
import type { GameState, KartState } from './state.js';
import { BOOST_CAP } from './physics.js';

export const ITEM_TYPE_BOOST = 0;

const ITEM_PICKUP_RADIUS: Fx = fxConst(1.4);
const ITEM_RESPAWN_BASE = 300; // 5s
const ITEM_RESPAWN_JITTER = 120; // + rng in [0, 2s)
const ITEM_BOOST_TICKS = 90;

type ItemEffect = (st: GameState, kart: KartState) => void;

const ITEM_EFFECTS: readonly ItemEffect[] = [
  // ITEM_TYPE_BOOST
  (_st, kart) => {
    kart.boostTicks = Math.min(kart.boostTicks + ITEM_BOOST_TICKS, BOOST_CAP);
  },
];

export function isItemActive(st: GameState, index: number): boolean {
  return st.tick >= st.items[index]!;
}

/**
 * Pickups, in fixed (item, kart) order so PRNG consumption is deterministic.
 * Respawn delay is PRNG-jittered (FR-15).
 */
export function stepItems(st: GameState): void {
  for (let i = 0; i < st.track.itemSpawns.length; i++) {
    if (!isItemActive(st, i)) continue;
    const spawn = st.track.itemSpawns[i]!;
    for (let p = 0; p < st.karts.length; p++) {
      const kart = st.karts[p]!;
      if (kart.finishTick >= 0) continue;
      const d = len(sub(kart.x, spawn.x), sub(kart.y, spawn.y));
      if (d >= ITEM_PICKUP_RADIUS) continue;
      ITEM_EFFECTS[spawn.itemType]!(st, kart);
      st.rng = rngNextState(st.rng);
      const jitter = rngRange(rngValue(st.rng), ITEM_RESPAWN_JITTER);
      st.items[i] = st.tick + ITEM_RESPAWN_BASE + jitter;
      break; // one pickup per box
    }
  }
}
