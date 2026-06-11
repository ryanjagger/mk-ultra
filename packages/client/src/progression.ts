/**
 * In-race feat tracking + XP awards. Feats are detected by diffing sim state
 * between render frames (the audio engine's pattern — read-only, no sim
 * hooks). Rollback corrections can in rare cases double-count a transition;
 * that costs a few XP of accuracy, never sim correctness.
 */
import { DRIFT_TIER2_TICKS, COUNTDOWN_TICKS, fxToFloat, type GameState } from '@mk/sim';
import type { RaceController } from './game.js';
import { getProfile, saveProfile, type Profile } from './profile.js';
import { levelFromXp, unlocksBetween } from './cosmetics.js';

const XP_FINISH = 50;
const XP_DNF = 15;
const XP_PLACEMENT = [100, 60, 40, 25]; // 1st..4th, multiplayer races only
const XP_TAKEDOWN = 15;
const TAKEDOWN_CAP = 6;
const XP_T2_DRIFT = 5;
const T2_DRIFT_CAP = 5;
/** how close a dying shell/oil of mine must be to a freshly spun kart */
const ATTRIBUTION_RANGE = 2.6;

interface ProjSnapshot {
  ttl: number;
  owner: number;
  x: number;
  y: number;
}

export interface AwardLine {
  label: string;
  xp: number;
}

export interface RaceAward {
  lines: AwardLine[];
  total: number;
  xpBefore: number;
  xpAfter: number;
  levelBefore: number;
  levelAfter: number;
  unlocked: string[];
}

export class FeatTracker {
  takedowns = 0;
  t2Drifts = 0;

  private prevSpin: number[] = [];
  private prevShells: ProjSnapshot[] = [];
  private prevOils: ProjSnapshot[] = [];
  private prevDriftDir = 0;
  private prevDriftCharge = 0;

  /** Call once per render frame during the race. */
  track(controller: RaceController): void {
    const st = controller.state;
    const you = controller.you;

    // takedowns: someone (not me) started spinning, and one of MY shells or
    // oils died next to them this frame — that's my hit landing
    st.karts.forEach((k, j) => {
      const was = this.prevSpin[j] ?? 0;
      if (j !== you && k.spinTicks > 0 && was === 0 && this.mineDiedNear(st, you, k)) {
        this.takedowns++;
      }
      this.prevSpin[j] = k.spinTicks;
    });

    // tier-2 drift release (a spin-out also clears drift state — exclude it)
    const me = st.karts[you]!;
    if (
      this.prevDriftDir !== 0 &&
      me.driftDir === 0 &&
      me.spinTicks === 0 &&
      this.prevDriftCharge >= DRIFT_TIER2_TICKS
    ) {
      this.t2Drifts++;
    }
    this.prevDriftDir = me.driftDir;
    this.prevDriftCharge = me.driftCharge;

    this.prevShells = st.shells.map((s) => ({ ttl: s.ttl, owner: s.owner, x: fxToFloat(s.x), y: fxToFloat(s.y) }));
    this.prevOils = st.oils.map((o) => ({ ttl: o.ttl, owner: o.owner, x: fxToFloat(o.x), y: fxToFloat(o.y) }));
  }

  private mineDiedNear(st: GameState, you: number, victim: { x: number; y: number }): boolean {
    const vx = fxToFloat(victim.x);
    const vy = fxToFloat(victim.y);
    const died = (prev: ProjSnapshot[], nowTtl: (i: number) => number): boolean =>
      prev.some(
        (p, i) =>
          p.owner === you &&
          p.ttl > 0 &&
          nowTtl(i) === 0 &&
          Math.hypot(p.x - vx, p.y - vy) < ATTRIBUTION_RANGE,
      );
    return (
      died(this.prevShells, (i) => st.shells[i]?.ttl ?? 0) ||
      died(this.prevOils, (i) => st.oils[i]?.ttl ?? 0)
    );
  }
}

/** Compute + persist the post-race award. Call exactly once per race. */
export function awardRace(controller: RaceController, feats: FeatTracker): RaceAward {
  const st = controller.state;
  const you = controller.you;
  const me = st.karts[you]!;
  const finished = me.finishTick >= 0;
  const lines: AwardLine[] = [];

  lines.push(finished ? { label: 'Race finished', xp: XP_FINISH } : { label: 'Race attempted', xp: XP_DNF });

  const multiplayer = st.cfg.playerCount >= 2;
  const place = controller.placements().indexOf(you);
  if (multiplayer && finished) {
    lines.push({ label: `Finished ${ordinal(place + 1)}`, xp: XP_PLACEMENT[place] ?? 25 });
  }
  const takedowns = Math.min(feats.takedowns, TAKEDOWN_CAP);
  if (takedowns > 0) lines.push({ label: `Takedowns ×${takedowns}`, xp: takedowns * XP_TAKEDOWN });
  const t2 = Math.min(feats.t2Drifts, T2_DRIFT_CAP);
  if (t2 > 0) lines.push({ label: `Tier-2 drifts ×${t2}`, xp: t2 * XP_T2_DRIFT });

  const total = lines.reduce((s, l) => s + l.xp, 0);
  const p: Profile = { ...getProfile() };
  const xpBefore = p.xp;
  p.xp += total;
  p.races += 1;
  if (multiplayer && finished && place === 0) p.wins += 1;
  if (multiplayer && finished && place <= 2) p.podiums += 1;
  p.takedowns += feats.takedowns;
  p.t2Drifts += feats.t2Drifts;
  if (finished) {
    const ticks = me.finishTick - COUNTDOWN_TICKS;
    const trackId = st.track.def.id;
    const best = p.bestRace[trackId];
    if (best === undefined || ticks < best) p.bestRace = { ...p.bestRace, [trackId]: ticks };
  }
  saveProfile(p);

  const levelBefore = levelFromXp(xpBefore);
  const levelAfter = levelFromXp(p.xp);
  return {
    lines,
    total,
    xpBefore,
    xpAfter: p.xp,
    levelBefore,
    levelAfter,
    unlocked: unlocksBetween(levelBefore, levelAfter),
  };
}

function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}
