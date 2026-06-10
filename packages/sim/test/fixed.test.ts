import { describe, it, expect } from 'vitest';
import {
  fx,
  fxConst,
  FX_ONE,
  add,
  sub,
  mul,
  div,
  sqrt,
  isqrt,
  len,
  lerp,
  clamp,
  abs,
  ratioFx,
  wideCross,
  wideDot,
} from '../src/fixed.js';

describe('Q16.16 fixed point', () => {
  it('converts small integers exactly', () => {
    expect(fx(1)).toBe(65536);
    expect(fx(-3)).toBe(-196608);
    expect(fxConst(0.5)).toBe(32768);
    expect(fxConst(-0.25)).toBe(-16384);
  });

  it('multiplies exactly on representable products', () => {
    expect(mul(fx(3), fx(4))).toBe(fx(12));
    expect(mul(fx(-3), fx(4))).toBe(fx(-12));
    expect(mul(fxConst(0.5), fxConst(0.5))).toBe(fxConst(0.25));
    expect(mul(fxConst(1.5), fx(2))).toBe(fx(3));
    expect(mul(fx(0), fx(123))).toBe(0);
  });

  it('mul matches BigInt floor reference across a sweep', () => {
    // golden reference: floor((a*b) / 2^16) using BigInt
    let s = 12345 | 0;
    for (let i = 0; i < 5000; i++) {
      s = (Math.imul(s, 1103515245) + 12345) | 0;
      const a = s % (1 << 26);
      s = (Math.imul(s, 1103515245) + 12345) | 0;
      const b = s % (1 << 22);
      const ref = Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
      expect(mul(a, b)).toBe(ref);
    }
  });

  it('divides with truncation toward zero', () => {
    expect(div(fx(12), fx(4))).toBe(fx(3));
    expect(div(fx(1), fx(2))).toBe(fxConst(0.5));
    expect(div(fx(-12), fx(4))).toBe(fx(-3));
    expect(abs(div(fx(1), fx(3)) - 21845)).toBeLessThanOrEqual(1);
  });

  it('isqrt is the exact integer floor sqrt', () => {
    expect(isqrt(0)).toBe(0);
    expect(isqrt(1)).toBe(1);
    expect(isqrt(3)).toBe(1);
    expect(isqrt(4)).toBe(2);
    expect(isqrt(2 ** 46)).toBe(2 ** 23);
    expect(isqrt(2 ** 46 - 1)).toBe(2 ** 23 - 1);
    for (let v = 0; v < 2000; v++) {
      const r = isqrt(v);
      expect(r * r).toBeLessThanOrEqual(v);
      expect((r + 1) * (r + 1)).toBeGreaterThan(v);
    }
  });

  it('fx sqrt and len behave', () => {
    expect(sqrt(fx(4))).toBe(fx(2));
    expect(sqrt(fx(9))).toBe(fx(3));
    expect(len(fx(3), fx(4))).toBe(fx(5));
    expect(len(fx(-3), fx(4))).toBe(fx(5));
    expect(len(0, 0)).toBe(0);
  });

  it('helpers: add/sub/lerp/clamp wrap to int32', () => {
    expect(add(fx(1), fx(2))).toBe(fx(3));
    expect(sub(fx(1), fx(2))).toBe(fx(-1));
    expect(lerp(fx(0), fx(10), fxConst(0.5))).toBe(fx(5));
    expect(clamp(fx(5), fx(0), fx(3))).toBe(fx(3));
    expect(clamp(fx(-5), fx(0), fx(3))).toBe(0);
  });

  it('wide ops are exact within the world bound', () => {
    const a = fx(400);
    const b = fx(-399);
    expect(wideCross(a, b, b, a)).toBe(a * a - b * b);
    expect(wideDot(a, b, a, b)).toBe(a * a + b * b);
    expect(ratioFx(1, 2)).toBe(32768);
    expect(ratioFx(wideDot(fx(2), 0, fx(4), 0), wideDot(fx(4), 0, fx(4), 0))).toBe(32768);
  });
});
