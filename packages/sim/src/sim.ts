/**
 * One sim tick. Everything in here runs in a strict fixed order:
 * karts step (item use then physics, by index) -> kart collisions (i<j)
 * -> wall collisions (by index) -> boost pads (kart-major, pads by index)
 * -> checkpoints -> item pickups -> shells -> oil slicks
 * -> phase transition -> tick++.
 *
 * The world freezes once the race is over so the results screen is stable.
 */
import { sub, wideDot, wideCross } from './fixed.js';
import { BTN_ACCEL, BTN_ITEM, INPUT_NEUTRAL } from './input.js';
import { stepKart, collideKarts, collideWalls, updateDraft } from './physics.js';
import { stepCheckpoints, stepRacePhase } from './race.js';
import { stepItems, stepShells, stepOils, useHeldItem } from './items.js';
import { botMask } from './bots.js';
import {
  type GameState,
  PHASE_COUNTDOWN,
  PHASE_RACING,
  PHASE_FINISHED,
  COUNTDOWN_TICKS,
  MAX_PLAYERS,
} from './state.js';

/** Boost ticks granted while driving over a pad (re-applied every tick on it). */
export const PAD_BOOST_TICKS = 55;

// Rev the engine into GO: hold accel for the last <=REV_PERFECT countdown
// ticks for a big launch, <=REV_OK for a modest one; any longer floods the
// engine and the launch is lost.
export const REV_PERFECT_TICKS = 45;
export const REV_OK_TICKS = 90;
export const REV_BOOST_PERFECT = 60;
export const REV_BOOST_OK = 28;

/**
 * Stateless boost pads: oriented-rectangle containment via exact wide math.
 * Both sides of each compare are real-values scaled by 2^32 (fx*fx products
 * vs fx * 65536), exact in doubles within the world bound.
 */
function stepBoostPads(st: GameState): void {
  const pads = st.track.boostPads;
  if (pads.length === 0) return;
  for (const kart of st.karts) {
    if (kart.finishTick >= 0) continue;
    for (const p of pads) {
      const rx = sub(kart.x, p.cx);
      const ry = sub(kart.y, p.cy);
      const along = wideDot(rx, ry, p.dx, p.dy);
      const lat = wideCross(p.dx, p.dy, rx, ry);
      if (
        (along < 0 ? -along : along) <= p.halfLen * 65536 &&
        (lat < 0 ? -lat : lat) <= p.halfWid * 65536
      ) {
        if (kart.boostTicks < PAD_BOOST_TICKS) kart.boostTicks = PAD_BOOST_TICKS;
      }
    }
  }
}

/**
 * Advance the state by one tick. `inputs` is indexed by kart; entries beyond
 * cfg.playerCount are ignored. Inputs only take effect while racing.
 */
export function stepSim(st: GameState, inputs: readonly number[]): void {
  if (st.phase === PHASE_FINISHED) {
    st.tick += 1;
    return;
  }

  st.phase = st.tick < COUNTDOWN_TICKS ? PHASE_COUNTDOWN : PHASE_RACING;

  // CPU seats ignore wire inputs: their masks are derived from the pre-tick
  // state itself, so every client (and rollback re-sim) computes the same race
  const bots = st.cfg.bots;
  const masks: number[] = [];
  for (let i = 0; i < st.karts.length; i++) {
    masks.push(bots?.[i] ? botMask(st, i) : (inputs[i] ?? INPUT_NEUTRAL));
  }

  // countdown rev: time the throttle into GO for a launch boost
  if (st.phase === PHASE_COUNTDOWN) {
    for (let i = 0; i < st.karts.length; i++) {
      const k = st.karts[i]!;
      k.revTicks = (masks[i]! & BTN_ACCEL) !== 0 ? k.revTicks + 1 : 0;
    }
  } else if (st.tick === COUNTDOWN_TICKS) {
    for (const k of st.karts) {
      if (k.revTicks > 0 && k.revTicks <= REV_PERFECT_TICKS) k.boostTicks = REV_BOOST_PERFECT;
      else if (k.revTicks > 0 && k.revTicks <= REV_OK_TICKS) k.boostTicks = REV_BOOST_OK;
      k.revTicks = 0;
    }
  }

  // slipstream charges/slingshots on pre-move positions (symmetric pass)
  if (st.phase === PHASE_RACING) updateDraft(st);

  const prevX: number[] = [];
  const prevY: number[] = [];
  for (let i = 0; i < st.karts.length; i++) {
    const kart = st.karts[i]!;
    prevX.push(kart.x);
    prevY.push(kart.y);
    const mask = st.phase === PHASE_RACING && kart.finishTick < 0 ? masks[i]! : INPUT_NEUTRAL;
    if (kart.itemCooldown > 0) kart.itemCooldown -= 1;
    else if ((mask & BTN_ITEM) !== 0 && kart.spinTicks === 0) useHeldItem(st, i);
    stepKart(st, kart, mask);
  }

  collideKarts(st);
  collideWalls(st);

  if (st.phase === PHASE_RACING) {
    stepBoostPads(st);
    for (let i = 0; i < st.karts.length; i++) {
      stepCheckpoints(st, st.karts[i]!, prevX[i]!, prevY[i]!);
    }
    stepItems(st);
    stepShells(st);
    stepOils(st);
  }

  stepRacePhase(st);
  st.tick += 1;
}

export { MAX_PLAYERS };
