/**
 * Enforces the determinism checklist (NFR-6) mechanically: scans every sim
 * source file for constructs that could introduce cross-engine divergence.
 * fixed.ts is the single vetted exception for Math.sqrt/floor/trunc/round
 * and the `/` operator.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const BANNED_EVERYWHERE: [RegExp, string][] = [
  [/Math\.random/, 'Math.random is non-deterministic (NFR-3)'],
  [/Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|pow|hypot|cbrt|sinh|cosh|tanh)\b/, 'float transcendental — not identical across engines (NFR-1)'],
  [/\bnew Date\b|\bDate\.now\b/, 'wall-clock time in the sim (NFR-2)'],
  [/\bperformance\./, 'wall-clock time in the sim (NFR-2)'],
  [/\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b/, 'scheduling in the sim (NFR-2)'],
  [/\bdocument\b|\bwindow\b|\bnavigator\b/, 'DOM dependency in the sim (NFR-2)'],
  [/\bparseFloat\b|\btoFixed\b|\bNumber\.parseFloat\b/, 'float formatting round-trips'],
  [/\.sort\(\s*\)/, 'default sort is lexicographic — always pass a total-order comparator (NFR-4)'],
  [/\bfor\s*\(\s*const\s+\w+\s+of\s+\w+\.(keys|values|entries)\(\)/, 'Map/Set iteration order (NFR-4)'],
  [/\bnew\s+(Map|Set)\b/, 'avoid Map/Set in sim state; iteration order risk (NFR-4)'],
];

const BANNED_OUTSIDE_FIXED: [RegExp, string][] = [
  [/Math\.sqrt/, 'use fixed.ts sqrt/isqrt (exact by construction)'],
  [/Math\.(floor|round|trunc|ceil)\b/, 'use fixed.ts helpers'],
];

describe('determinism checklist lint (sim sources)', () => {
  // recursive: a sim source file in a subdirectory must not escape the scan
  const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) =>
    f.endsWith('.ts'),
  );

  it('scans a sane number of files', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(`${file} obeys the checklist`, () => {
      const text = readFileSync(join(SRC, file), 'utf8');
      // strip comments so prose mentioning banned tokens doesn't trip the scan
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const [re, why] of BANNED_EVERYWHERE) {
        expect(re.test(code), `${file}: ${re} — ${why}`).toBe(false);
      }
      if (file !== 'fixed.ts') {
        for (const [re, why] of BANNED_OUTSIDE_FIXED) {
          expect(re.test(code), `${file}: ${re} — ${why}`).toBe(false);
        }
      }
    });
  }
});
