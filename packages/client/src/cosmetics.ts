/**
 * Cosmetic catalog + XP curve. Everything here is render-only — liveries and
 * flames never touch the sim. Ids travel over the wire (PlayerStyle); unknown
 * ids fall back to defaults so old/new clients stay compatible.
 */
import { KART_COLORS } from './scene.js';

export interface Livery {
  id: string;
  name: string;
  level: number; // unlock level
  /** null = use the seat color (the classic look) */
  primary: string | null;
  /** null = same as primary (the classic single-tone kart) */
  accent: string | null;
}

export interface Flame {
  id: string;
  name: string;
  level: number;
  color: string;
}

export const LIVERIES: readonly Livery[] = [
  { id: 'seat', name: 'Classic', level: 0, primary: null, accent: null },
  { id: 'midnight', name: 'Midnight', level: 1, primary: '#34495e', accent: '#5dade2' },
  { id: 'sunset', name: 'Sunset', level: 2, primary: '#ff7e5f', accent: '#ffd23f' },
  { id: 'toxic', name: 'Toxic', level: 3, primary: '#27ae60', accent: '#b8ff3d' },
  { id: 'ice', name: 'Ice', level: 4, primary: '#aee6ff', accent: '#ffffff' },
  { id: 'royal', name: 'Royal', level: 6, primary: '#5b2c98', accent: '#f1c40f' },
  { id: 'gold', name: 'Gold Chrome', level: 8, primary: '#f5c518', accent: '#fff8d6' },
];

export const FLAMES: readonly Flame[] = [
  { id: 'classic', name: 'Classic', level: 0, color: '#ff9b2f' },
  { id: 'azure', name: 'Azure', level: 3, color: '#41c7ff' },
  { id: 'violet', name: 'Violet', level: 5, color: '#b06bff' },
  { id: 'emerald', name: 'Emerald', level: 7, color: '#3fffa8' },
];

export function liveryById(id: string): Livery {
  return LIVERIES.find((l) => l.id === id) ?? LIVERIES[0]!;
}

export function flameById(id: string): Flame {
  return FLAMES.find((f) => f.id === id) ?? FLAMES[0]!;
}

/** Resolve a livery to a concrete body color for a given seat. */
export function liveryColor(id: string, seat: number): string {
  const l = liveryById(id);
  return l.primary ?? KART_COLORS[seat % KART_COLORS.length]!;
}

// --- XP curve: cumulative XP needed to *reach* level l (quadratic ramp) ----

export function xpForLevel(level: number): number {
  return 50 * level * (level + 1); // L1=100, L2=300, L3=600, L4=1000, ...
}

export function levelFromXp(xp: number): number {
  let l = 0;
  while (xpForLevel(l + 1) <= xp) l++;
  return l;
}

/** Progress within the current level, 0..1, for XP bars. */
export function levelProgress(xp: number): { level: number; into: number; span: number } {
  const level = levelFromXp(xp);
  const base = xpForLevel(level);
  return { level, into: xp - base, span: xpForLevel(level + 1) - base };
}

/** Everything newly unlocked when leveling from `before` to `after`. */
export function unlocksBetween(before: number, after: number): string[] {
  const out: string[] = [];
  for (const l of LIVERIES) if (l.level > before && l.level <= after) out.push(`Livery: ${l.name}`);
  for (const f of FLAMES) if (f.level > before && f.level <= after) out.push(`Flame: ${f.name}`);
  return out;
}
