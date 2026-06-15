/**
 * Mobile touch driving: a single floating thumb-joystick, no on-screen buttons.
 *
 * Just another input source: Keyboard OR-merges sample() into the mask exactly
 * like the gamepad path. Output is a plain input mask — horizontal thumb
 * deflection packs an analog steer level (packSteer), pulling the thumb down
 * brakes, throttle is automatic (you always coast forward), and a second finger
 * taps to use an item or holds to drift.
 *
 * Decoupled from the sim like the renderer: it reads only pointer events and
 * emits a mask; it never sees game state. performance.now() is fine here — this
 * is client glue, not the deterministic core.
 */
import { BTN_ACCEL, BTN_BRAKE, BTN_DRIFT, BTN_ITEM, STEER_MAG_MAX, packSteer } from '@mk/sim';

// All distances are CSS px; every threshold is a feel knob, safe to retune.
const DEADZONE = 12; // thumb travel before any steering registers
const STEER_RANGE = 70; // travel from the anchor that reaches full lock (level 15)
const BRAKE_TRAVEL = 60; // downward travel before throttle flips to brake
const JOY_RADIUS = 88; // anchor trails the thumb so it never gets further than this
const TAP_MS = 160; // action finger: shorter press = item tap, longer = drift hold
const TAP_MOVE = 26; // a tap must stay within this radius to count (else it's a drag)
const ITEM_PULSE_MS = 100; // BTN_ITEM held this long on a tap (< the 18-tick item cooldown)

interface DrivePtr {
  id: number;
  ax: number; // floating anchor (re-centres as the thumb roams)
  ay: number;
  x: number; // current thumb position
  y: number;
}
interface ActionPtr {
  id: number;
  down: number; // performance.now() at press
  x0: number; // press position (tap-vs-drag guard)
  y0: number;
  x: number;
  y: number;
}

export class TouchControls {
  private active = false;
  private drive: DrivePtr | null = null;
  private action: ActionPtr | null = null;
  private itemPulseUntil = 0;

  private readonly overlay: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly knob: HTMLElement;

  constructor() {
    this.overlay = document.getElementById('touch-overlay')!;
    this.ring = document.getElementById('touch-ring')!;
    this.knob = document.getElementById('touch-knob')!;
    this.overlay.addEventListener('pointerdown', this.onDown);
    this.overlay.addEventListener('pointermove', this.onMove);
    this.overlay.addEventListener('pointerup', this.onUp);
    this.overlay.addEventListener('pointercancel', this.onUp);
  }

  /** Toggle capture + visuals. Off during menus so DOM buttons work natively. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.overlay.classList.toggle('active', active);
    if (!active) this.reset();
  }

  private reset(): void {
    this.drive = null;
    this.action = null;
    this.itemPulseUntil = 0;
    this.ring.classList.add('hidden');
    this.knob.classList.add('hidden');
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.active) return;
    // capture so a finger that slides off its start still reports to us;
    // tolerate a throw (e.g. the pointer already lifted) — input must not drop
    try {
      this.overlay.setPointerCapture(e.pointerId);
    } catch {
      /* non-fatal */
    }
    if (this.drive === null) {
      this.drive = { id: e.pointerId, ax: e.clientX, ay: e.clientY, x: e.clientX, y: e.clientY };
      this.showJoystick();
    } else if (this.action === null) {
      this.action = {
        id: e.pointerId,
        down: performance.now(),
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
      };
    }
    // third+ fingers are ignored
  };

  private onMove = (e: PointerEvent): void => {
    if (this.drive && e.pointerId === this.drive.id) {
      // dynamic re-centre: let the anchor trail so the stick stays responsive
      // even if the thumb wanders far from where it first landed
      const dx = e.clientX - this.drive.ax;
      const dy = e.clientY - this.drive.ay;
      const dist = Math.hypot(dx, dy);
      if (dist > JOY_RADIUS) {
        const k = (dist - JOY_RADIUS) / dist;
        this.drive.ax += dx * k;
        this.drive.ay += dy * k;
      }
      this.drive.x = e.clientX;
      this.drive.y = e.clientY;
      this.showJoystick();
    } else if (this.action && e.pointerId === this.action.id) {
      this.action.x = e.clientX;
      this.action.y = e.clientY;
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (this.drive && e.pointerId === this.drive.id) {
      this.drive = null;
      this.ring.classList.add('hidden');
      this.knob.classList.add('hidden');
    } else if (this.action && e.pointerId === this.action.id) {
      const a = this.action;
      const moved = Math.hypot(a.x - a.x0, a.y - a.y0);
      // quick + still press => item tap (a longer hold was a drift, already live)
      if (performance.now() - a.down < TAP_MS && moved < TAP_MOVE) {
        this.itemPulseUntil = performance.now() + ITEM_PULSE_MS;
      }
      this.action = null;
    }
  };

  private showJoystick(): void {
    const d = this.drive!;
    // translate to the point, then -50% to centre the element on it
    this.ring.style.transform = `translate(${d.ax}px, ${d.ay}px) translate(-50%, -50%)`;
    this.knob.style.transform = `translate(${d.x}px, ${d.y}px) translate(-50%, -50%)`;
    this.ring.classList.remove('hidden');
    this.knob.classList.remove('hidden');
  }

  /** Current input mask, OR-merged by Keyboard.sample(). 0 when inactive. */
  sample(): number {
    if (!this.active) return 0;
    let mask = 0;
    let braking = false;
    if (this.drive) {
      const dx = this.drive.x - this.drive.ax;
      const dy = this.drive.y - this.drive.ay;
      const adx = dx < 0 ? -dx : dx;
      if (adx > DEADZONE) {
        const frac = Math.min(1, (adx - DEADZONE) / (STEER_RANGE - DEADZONE));
        const level = Math.max(1, Math.round(frac * STEER_MAG_MAX));
        mask |= packSteer(dx < 0 ? 1 : -1, level); // drag left => steer left (BTN_LEFT)
      }
      if (dy > BRAKE_TRAVEL) braking = true;
    }
    mask |= braking ? BTN_BRAKE : BTN_ACCEL; // auto-throttle unless the thumb pulls down
    const now = performance.now();
    if (this.action && now - this.action.down >= TAP_MS) mask |= BTN_DRIFT;
    if (now < this.itemPulseUntil) mask |= BTN_ITEM;
    return mask;
  }
}
