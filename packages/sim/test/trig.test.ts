import { describe, it, expect } from 'vitest';
import { sinB, cosB, BRAD_QUARTER, BRAD_HALF } from '../src/trig.js';
import { FX_ONE } from '../src/fixed.js';

describe('table trig', () => {
  it('hits exact cardinal values', () => {
    expect(sinB(0)).toBe(0);
    expect(sinB(BRAD_QUARTER)).toBe(FX_ONE);
    expect(sinB(BRAD_HALF)).toBe(0);
    expect(sinB(BRAD_HALF + BRAD_QUARTER)).toBe(-FX_ONE);
    expect(cosB(0)).toBe(FX_ONE);
    expect(cosB(BRAD_QUARTER)).toBe(0);
    expect(cosB(BRAD_HALF)).toBe(-FX_ONE);
  });

  it('wraps angles', () => {
    expect(sinB(65536)).toBe(sinB(0));
    expect(sinB(-16384)).toBe(sinB(65536 - 16384));
    expect(cosB(70000)).toBe(cosB(70000 - 65536));
  });

  it('stays within +-1 and close to real sin', () => {
    for (let a = 0; a < 65536; a += 37) {
      const s = sinB(a);
      expect(s).toBeGreaterThanOrEqual(-FX_ONE);
      expect(s).toBeLessThanOrEqual(FX_ONE);
      // test-side float reference is fine — the sim never does this
      const ref = Math.sin((a / 65536) * 2 * Math.PI) * 65536;
      expect(Math.abs(s - ref)).toBeLessThan(16);
    }
  });

  it('sin^2 + cos^2 ~= 1', () => {
    for (let a = 0; a < 65536; a += 101) {
      const s = sinB(a) / 65536;
      const c = cosB(a) / 65536;
      expect(Math.abs(s * s + c * c - 1)).toBeLessThan(0.001);
    }
  });

  it('is odd-symmetric-ish and monotone on the first quarter', () => {
    let prev = -1;
    for (let a = 0; a <= 16384; a += 64) {
      const s = sinB(a);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});
