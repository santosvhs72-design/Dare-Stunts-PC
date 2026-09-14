import { keyName } from '../ui/keys.js';
import { activePad } from '../ui/pads.js';

// The wrapper forwards a controller's buttons as keys, because a television's
// WebView does not always expose the Gamepad API (see TV_KEYS in
// MainActivity): A arrives as Enter, X as KeyX, B as KeyB. Driving has to read
// those names as well as the pad itself, or the whole controller steers and
// accelerates but never brakes.
const KEYS = {
  throttle: ['ArrowUp', 'KeyW', 'Enter'],
  brake: ['ArrowDown', 'KeyS', 'KeyX'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  handbrake: ['Space', 'KeyB'],
};

const DEADZONE = 0.14;

// True while focus sits on a control that owns arrow keys itself (a button, a
// menu card, a slider, a text field). Driving must not steal them there, or a
// focused menu button becomes unusable the moment this fires on every keydown.
const onControl = () => {
  const el = document.activeElement;
  return !!(el && el !== document.body && el.closest
    && el.closest('button, a, input, textarea, select, [tabindex]'));
};

export class Input {
  constructor() {
    this.down = new Set();
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = false;
    this.padConnected = false;
    this.padName = '';
    this._events = [];
    this._prevPad = {};

    // Pause and restart keys are handled by the UI layer directly; only the
    // gamepad routes them through _events.
    addEventListener('keydown', e => {
      if (onControl()) return;
      const k = keyName(e);
      if (Object.values(KEYS).some(l => l.includes(k))) e.preventDefault();
      this.down.add(k);
    });
    addEventListener('keyup', e => this.down.delete(keyName(e)));
    addEventListener('blur', () => this.down.clear());
    addEventListener('gamepadconnected', e => {
      this.padConnected = true;
      this.padName = e.gamepad.id;
    });
    addEventListener('gamepaddisconnected', () => { this.padConnected = false; });
  }

  takeEvents() { const e = this._events; this._events = []; return e; }

  poll() {
    const has = list => list.some(k => this.down.has(k));
    let throttle = has(KEYS.throttle) ? 1 : 0;
    let brake = has(KEYS.brake) ? 1 : 0;
    let steer = (has(KEYS.right) ? 1 : 0) - (has(KEYS.left) ? 1 : 0);
    let handbrake = has(KEYS.handbrake);

    const p = activePad();
    if (p) {
      this.padConnected = true;
      this.padName = p.id;

      const ax = p.axes[0] || 0;
      if (Math.abs(ax) > DEADZONE) {
        const t = (Math.abs(ax) - DEADZONE) / (1 - DEADZONE);
        steer = Math.sign(ax) * (t * 0.35 + t * t * 0.65);
      }

      const btn = i => p.buttons[i] ? (p.buttons[i].value || (p.buttons[i].pressed ? 1 : 0)) : 0;
      throttle = Math.max(throttle, btn(7), btn(0), btn(12) ? 1 : 0);
      brake = Math.max(brake, btn(6), btn(2), btn(13) ? 1 : 0);
      if (btn(1) > 0.5) handbrake = true;
      if (btn(14) > 0.5) steer = -1;
      if (btn(15) > 0.5) steer = 1;

      const start = btn(9) > 0.5;
      if (start && !this._prevPad.start) this._events.push('pause');
      this._prevPad.start = start;
      const back = btn(8) > 0.5;
      if (back && !this._prevPad.back) this._events.push('restart');
      this._prevPad.back = back;
    }

    this.throttle = throttle;
    this.brake = brake;
    this.steer = Math.max(-1, Math.min(1, steer));
    this.handbrake = handbrake;
    return this;
  }
}
