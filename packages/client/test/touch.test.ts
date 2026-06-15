/**
 * TouchControls: the floating thumb-joystick that emits a plain input mask.
 *
 * Runs in the Node test env (like the other client tests), so it stubs the few
 * DOM hooks TouchControls touches (getElementById + the overlay's pointer
 * listeners) and a controllable `performance.now()` to drive the tap-vs-hold
 * timing deterministically. Everything else is the real class.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BTN_ACCEL,
  BTN_BRAKE,
  BTN_DRIFT,
  BTN_ITEM,
  steerOf,
  steerMagOf,
  STEER_MAG_MAX,
} from '@mk/sim';
import { TouchControls } from '../src/touch.js';

type Handler = (e: { pointerId: number; clientX: number; clientY: number }) => void;

function fakeEl() {
  const set = new Set<string>();
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => set.add(c),
      remove: (c: string) => set.delete(c),
      contains: (c: string) => set.has(c),
      toggle: (c: string, on?: boolean) => {
        const next = on === undefined ? !set.has(c) : on;
        if (next) set.add(c);
        else set.delete(c);
        return next;
      },
    },
    setPointerCapture: () => {},
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
  };
}

let overlay: ReturnType<typeof fakeEl>;
let now = 1000;
const ANCHOR = { x: 200, y: 400 };
const realPerf = globalThis.performance;

beforeEach(() => {
  overlay = fakeEl();
  const ring = fakeEl();
  const knob = fakeEl();
  const byId: Record<string, unknown> = {
    'touch-overlay': overlay,
    'touch-ring': ring,
    'touch-knob': knob,
  };
  now = 1000;
  (globalThis as { document?: unknown }).document = { getElementById: (id: string) => byId[id] };
  (globalThis as { performance?: unknown }).performance = { now: () => now };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  (globalThis as { performance?: unknown }).performance = realPerf;
});

/** Press the drive thumb at the anchor, then slide to (x, y). */
function drive(tc: TouchControls, x: number, y: number): void {
  overlay.handlers.pointerdown!({ pointerId: 1, clientX: ANCHOR.x, clientY: ANCHOR.y });
  overlay.handlers.pointermove!({ pointerId: 1, clientX: x, clientY: y });
}

describe('TouchControls', () => {
  it('emits nothing while inactive (no bit conflict with keyboard on desktop)', () => {
    const tc = new TouchControls();
    drive(tc, 120, 400);
    expect(tc.sample()).toBe(0);
  });

  it('auto-accelerates with no finger down once active', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    expect(tc.sample()).toBe(BTN_ACCEL);
  });

  it('full left/right deflection packs full lock, plus auto-accel', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    drive(tc, ANCHOR.x - 70, ANCHOR.y); // hard left
    let m = tc.sample();
    expect(m & BTN_ACCEL).toBe(BTN_ACCEL);
    expect(steerOf(m)).toBe(1); // left is CCW-positive
    expect(steerMagOf(m)).toBe(STEER_MAG_MAX);

    drive(tc, ANCHOR.x + 70, ANCHOR.y); // hard right
    m = tc.sample();
    expect(steerOf(m)).toBe(-1);
    expect(steerMagOf(m)).toBe(STEER_MAG_MAX);
  });

  it('partial deflection packs an intermediate analog level', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    drive(tc, ANCHOR.x - 41, ANCHOR.y); // ~half travel past the deadzone
    const m = tc.sample();
    expect(steerOf(m)).toBe(1);
    const lv = steerMagOf(m);
    expect(lv).toBeGreaterThan(1);
    expect(lv).toBeLessThan(STEER_MAG_MAX);
  });

  it('a tiny nudge inside the deadzone does not steer', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    drive(tc, ANCHOR.x - 6, ANCHOR.y);
    expect(steerOf(tc.sample())).toBe(0);
  });

  it('pulling the thumb down brakes instead of accelerating', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    drive(tc, ANCHOR.x, ANCHOR.y + 80); // straight down past the brake travel
    const m = tc.sample();
    expect(m & BTN_BRAKE).toBe(BTN_BRAKE);
    expect(m & BTN_ACCEL).toBe(0);
  });

  it('second finger held past the tap window drifts', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    drive(tc, ANCHOR.x - 70, ANCHOR.y); // steering with the thumb
    overlay.handlers.pointerdown!({ pointerId: 2, clientX: 600, clientY: 700 }); // action finger down
    expect(tc.sample() & BTN_DRIFT).toBe(0); // not yet — still within the tap window
    now += 200; // hold past TAP_MS
    expect(tc.sample() & BTN_DRIFT).toBe(BTN_DRIFT);
  });

  it('second finger quick tap pulses the item, then clears', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    drive(tc, ANCHOR.x, ANCHOR.y); // drive thumb down first (the action finger is the 2nd)
    overlay.handlers.pointerdown!({ pointerId: 2, clientX: 600, clientY: 700 });
    now += 60; // quick — under the tap window
    overlay.handlers.pointerup!({ pointerId: 2, clientX: 602, clientY: 701 }); // barely moved
    expect(tc.sample() & BTN_ITEM).toBe(BTN_ITEM); // pulsing
    now += 200; // pulse window elapses
    expect(tc.sample() & BTN_ITEM).toBe(0);
  });

  it('a slow second-finger hold-release is a drift, not an item tap', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    drive(tc, ANCHOR.x, ANCHOR.y); // drive thumb down first
    overlay.handlers.pointerdown!({ pointerId: 2, clientX: 600, clientY: 700 });
    now += 300; // held well past the tap window
    overlay.handlers.pointerup!({ pointerId: 2, clientX: 600, clientY: 700 });
    expect(tc.sample() & BTN_ITEM).toBe(0); // a hold never fires the item on release
  });

  it('deactivating releases all inputs', () => {
    const tc = new TouchControls();
    tc.setActive(true);
    drive(tc, ANCHOR.x - 70, ANCHOR.y);
    expect(tc.sample()).not.toBe(0);
    tc.setActive(false);
    expect(tc.sample()).toBe(0);
  });
});
