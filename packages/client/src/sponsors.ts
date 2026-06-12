/**
 * Track sponsorships. One list feeds every branded surface in the world:
 * barrier panels on the straights, billboards, the start-gantry strip, the
 * painted road logo and the grandstand fascia. Surfaces pick sponsors
 * deterministically per track, so every circuit has a stable sponsor mix.
 *
 * To change sponsors, edit this array — names render as procedural
 * canvas-text logos (no image assets needed). `color` is the panel
 * background, `accent` the text/border.
 */
export interface Sponsor {
  name: string;
  color: string;
  accent: string;
  /** small secondary line (a domain, a slogan) shown on tall surfaces */
  tagline?: string;
}

/** First entry is the TITLE sponsor: it owns the start-gantry strip on every track. */
export const SPONSORS: Sponsor[] = [
  { name: 'GAUNTLET AI', color: '#150a0c', accent: '#ff4438', tagline: 'gauntletai.com' },
  { name: 'GHOST COLA', color: '#10282e', accent: '#7df0d8' },
  { name: 'TURBO+', color: '#231330', accent: '#ff9b2f' },
  { name: 'NITRO BANK', color: '#101a2e', accent: '#5ea2ef' },
  { name: 'KART MART', color: '#2e1112', accent: '#ffd23f' },
  { name: 'DRIFT KING', color: '#161a26', accent: '#ff4757' },
  { name: 'SHELL & CO', color: '#13240f', accent: '#9be86f' },
];

export function titleSponsor(): Sponsor {
  return SPONSORS[0]!;
}

/** Stable per-track, per-surface sponsor pick. */
export function sponsorFor(trackId: string, slot: number): Sponsor {
  let h = 0;
  for (const ch of trackId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return SPONSORS[Math.abs(h + slot * 13) % SPONSORS.length]!;
}
