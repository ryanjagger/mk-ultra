import { describe, it, expect } from 'vitest';
import { rngNextState, rngValue, rngRange } from '../src/prng.js';

describe('mulberry32 prng', () => {
  it('is reproducible from a seed', () => {
    const run = (seed: number, n: number) => {
      let s = seed | 0;
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        s = rngNextState(s);
        out.push(rngValue(s));
      }
      return out;
    };
    expect(run(42, 50)).toEqual(run(42, 50));
    expect(run(42, 5)).not.toEqual(run(43, 5));
  });

  it('produces uint32 values with a sane spread', () => {
    let s = 7;
    const buckets = new Array<number>(8).fill(0);
    for (let i = 0; i < 8000; i++) {
      s = rngNextState(s);
      const v = rngValue(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      buckets[v >>> 29] = (buckets[v >>> 29] ?? 0) + 1;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(700);
  });

  it('rngRange stays in range', () => {
    let s = 99;
    for (let i = 0; i < 1000; i++) {
      s = rngNextState(s);
      const r = rngRange(rngValue(s), 120);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(120);
    }
  });
});
