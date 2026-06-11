/**
 * Local driver profile — XP, lifetime stats, equipped cosmetics. Lives in
 * localStorage (no accounts in v1): per-browser, honest-player persistence.
 */
import type { PlayerStyle } from '@mk/shared';
import { levelFromXp, liveryById, flameById } from './cosmetics.js';

export interface Profile {
  xp: number;
  races: number;
  wins: number;
  podiums: number;
  takedowns: number; // opponents spun by my shells/oils
  t2Drifts: number;
  /** per-track best full-race time, in ticks (post-countdown) */
  bestRace: Record<string, number>;
  livery: string;
  flame: string;
}

const KEY = 'mk-profile';

const FRESH: Profile = {
  xp: 0,
  races: 0,
  wins: 0,
  podiums: 0,
  takedowns: 0,
  t2Drifts: 0,
  bestRace: {},
  livery: 'seat',
  flame: 'classic',
};

let cached: Profile | null = null;

export function getProfile(): Profile {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = raw ? { ...FRESH, ...(JSON.parse(raw) as Partial<Profile>) } : { ...FRESH };
  } catch {
    cached = { ...FRESH };
  }
  return cached;
}

export function saveProfile(p: Profile): void {
  cached = p;
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage full/blocked: progression just won't persist this session
  }
}

export function profileLevel(): number {
  return levelFromXp(getProfile().xp);
}

/** The wire-format style other players see (equips validated to known ids). */
export function myStyle(): PlayerStyle {
  const p = getProfile();
  return { level: profileLevel(), livery: liveryById(p.livery).id, flame: flameById(p.flame).id };
}
