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

export class Keyboard {
  private mask = 0;
  /** swallow game keys (avoid page scroll) only while racing */
  captureGameKeys = false;
  onDebugToggle: (() => void) | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.onDebugToggle?.();
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
      const bit = KEYMAP[e.code];
      if (bit !== undefined) this.mask &= ~bit;
    });
    window.addEventListener('blur', () => {
      this.mask = 0;
    });
  }

  sample(): number {
    return this.mask;
  }
}
