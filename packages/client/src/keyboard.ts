import { BTN_ACCEL, BTN_BRAKE, BTN_LEFT, BTN_RIGHT, BTN_DRIFT, BTN_ITEM } from '@mk/sim';

const KEYMAP: Record<string, number> = {
  ArrowUp: BTN_ACCEL,
  KeyW: BTN_ACCEL,
  ArrowDown: BTN_BRAKE,
  KeyS: BTN_BRAKE,
  ArrowLeft: BTN_LEFT,
  KeyA: BTN_LEFT,
  ArrowRight: BTN_RIGHT,
  KeyD: BTN_RIGHT,
  Space: BTN_DRIFT,
  ShiftLeft: BTN_DRIFT,
  ShiftRight: BTN_DRIFT,
  KeyE: BTN_ITEM,
  Enter: BTN_ITEM,
  ControlLeft: BTN_ITEM,
  ControlRight: BTN_ITEM,
};

/** Held look-behind keys — view-only, never part of the input mask. */
const LOOK_BACK = new Set(['KeyR', 'KeyC']);

/** Stick travel before steering registers. */
const PAD_DEADZONE = 0.35;

export class Keyboard {
  private mask = 0;
  /** swallow game keys (avoid page scroll) only while racing */
  captureGameKeys = false;
  /** rearview camera while held (render-only, never on the wire) */
  lookBack = false;
  onDebugToggle: (() => void) | null = null;
  onMuteToggle: (() => void) | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.onDebugToggle?.();
        return;
      }
      if (e.code === 'KeyM') {
        const target = e.target as HTMLElement | null;
        if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'SELECT')) {
          this.onMuteToggle?.();
        }
        return;
      }
      if (LOOK_BACK.has(e.code)) {
        const target = e.target as HTMLElement | null;
        if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'SELECT')) {
          if (this.captureGameKeys) e.preventDefault();
          this.lookBack = true;
        }
        return;
      }
      const bit = KEYMAP[e.code];
      if (bit === undefined) return;
      if (this.captureGameKeys) {
        const target = e.target as HTMLElement | null;
        if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'SELECT')) {
          e.preventDefault();
          this.mask |= bit;
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      if (LOOK_BACK.has(e.code)) this.lookBack = false;
      const bit = KEYMAP[e.code];
      if (bit !== undefined) this.mask &= ~bit;
    });
    window.addEventListener('blur', () => {
      this.mask = 0;
      this.lookBack = false;
    });
  }

  sample(): number {
    return this.mask | this.padMask();
  }

  /** Combined keyboard + gamepad look-behind (refreshes the pad poll). */
  lookingBack(): boolean {
    this.padMask();
    return this.lookBack || this.padLook;
  }

  private padLook = false;

  /**
   * OR-merge the first connected gamepad into the mask. The Gamepad API is
   * poll-based, so this runs on every sample. Standard mapping: A/RT accel,
   * B/LT brake, LB/RB drift, X/Y item, stick or dpad steers, right stick
   * pulled back = rearview.
   */
  private padMask(): number {
    this.padLook = false;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;
    for (const pad of navigator.getGamepads()) {
      if (!pad || !pad.connected) continue;
      const b = (i: number) => pad.buttons[i]?.pressed ?? false;
      const stickX = pad.axes[0] ?? 0;
      let mask = 0;
      if (b(0) || b(7) || b(12)) mask |= BTN_ACCEL;
      if (b(1) || b(6) || b(13)) mask |= BTN_BRAKE;
      if (b(4) || b(5)) mask |= BTN_DRIFT;
      if (b(2) || b(3)) mask |= BTN_ITEM;
      if (b(14) || stickX < -PAD_DEADZONE) mask |= BTN_LEFT;
      if (b(15) || stickX > PAD_DEADZONE) mask |= BTN_RIGHT;
      if ((pad.axes[3] ?? 0) > 0.6) this.padLook = true;
      return mask; // first connected pad wins
    }
    return 0;
  }
}
