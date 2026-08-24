// Touch controls for phones and tablets.
//
// The layout follows the mobile-shooter convention: a floating stick under the
// left thumb, look-by-drag on the right, and an action cluster the right thumb
// can reach. Critically, the FIRE and ADS buttons are *draggable* — once your
// thumb is down on them it keeps aiming as it moves, so you can shoot and look
// with a single thumb instead of needing a third one.
//
// Everything is fed into the existing Input object using the same key codes and
// mouse buttons the desktop build uses, so the game logic needs no branching.

import { clamp } from './math.js';

const BTN = [
  // id        key/button        label   glyph  drag  size
  ['fire', 'M0', 'FIRE', '●', true, 50],
  ['ads', 'M2', 'ADS', '◎', true, 33],
  ['jump', 'Space', 'JUMP', '⭱', false, 33],
  ['crouch', 'KeyC', 'CROUCH', '⭳', false, 31],
  ['reload', 'KeyR', 'RELOAD', '↻', false, 28],
  ['nade', 'KeyG', 'FRAG', '◆', false, 26],
  ['swap', 'KeyQ', 'SWAP', '⇄', false, 26],
  ['uav', 'Digit4', 'UAV', '▲', false, 22],
  ['strike', 'Digit5', 'STRIKE', '✈', false, 22],
  ['pause', null, 'MENU', '⏸', false, 20],
];

export class TouchControls {
  constructor(input, canvas) {
    this.input = input;
    this.canvas = canvas;
    this.enabled = false;
    this.w = 1; this.h = 1;
    this.safe = { l: 0, r: 0, t: 0, b: 0 };
    this.scale = 1;
    // Pixels of drag -> units fed to Input.mouse, which the game then scales by
    // Input.sensitivity. 2.8 lands at roughly 0.35 deg/px at the default slider.
    this.lookGain = 2.8;

    this.buttons = BTN.map(([id, key, label, glyph, drag, size]) =>
      ({ id, key, label, glyph, drag, size, x: 0, y: 0, r: 0, down: false, ptr: -1 }));
    this.byId = Object.fromEntries(this.buttons.map((b) => [b.id, b]));

    this.stick = { active: false, ox: 0, oy: 0, x: 0, y: 0, dx: 0, dy: 0, ptr: -1, max: 70 };
    this.pointers = new Map();   // pointerId -> {role, btn, lx, ly}
    this.onPause = null;

    this.autoSprint = false;
    this._sprintHold = 0;

    const opts = { passive: false };
    canvas.addEventListener('pointerdown', (e) => this._down(e), opts);
    canvas.addEventListener('pointermove', (e) => this._move(e), opts);
    canvas.addEventListener('pointerup', (e) => this._up(e), opts);
    canvas.addEventListener('pointercancel', (e) => this._up(e), opts);
    canvas.addEventListener('pointerleave', (e) => this._up(e), opts);
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), opts);
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), opts);
  }

  /** @param safe CSS safe-area insets in px, for notches and home indicators. */
  layout(w, h, safe) {
    this.w = w; this.h = h;
    if (safe) this.safe = safe;
    const s = clamp(Math.min(w, h) / 430, 0.70, 1.20);
    this.scale = s;
    this.stick.max = 72 * s;

    const L = this.safe.l, R = this.safe.r, T = this.safe.t, B = this.safe.b;
    const rx = w - R, by = h - B;
    const P = (b, x, y) => { const t = this.byId[b]; t.x = x; t.y = y; t.r = t.size * s; };

    // Right thumb cluster.
    P('fire', rx - 86 * s, by - 84 * s);
    P('ads', rx - 188 * s, by - 60 * s);
    P('jump', rx - 88 * s, by - 188 * s);
    P('crouch', rx - 184 * s, by - 152 * s);
    P('reload', rx - 262 * s, by - 90 * s);
    P('nade', rx - 256 * s, by - 178 * s);
    P('swap', rx - 330 * s, by - 148 * s);
    // Top-right utility row, clear of the killfeed below it.
    P('pause', rx - 40 * s, T + 38 * s);
    P('strike', rx - 96 * s, T + 38 * s);
    P('uav', rx - 150 * s, T + 38 * s);

    // The stick owns the lower-left quadrant; look owns everything else.
    this.stickZone = { x0: L, x1: L + (w - L - R) * 0.46, y0: T + (h - T - B) * 0.30, y1: by };
  }

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _hitButton(x, y) {
    // Generous hit radius — thumbs are imprecise.
    for (const b of this.buttons) {
      if (b.r <= 0) continue;
      const dx = x - b.x, dy = y - b.y;
      if (dx * dx + dy * dy <= (b.r * 1.28) * (b.r * 1.28)) return b;
    }
    return null;
  }

  _press(b, on) {
    b.down = on;
    if (!b.key) return;
    const I = this.input;
    if (b.key === 'M0') { I.buttons[0] = on; if (on) I.btnPressed[0] = true; return; }
    if (b.key === 'M2') { I.buttons[2] = on; if (on) I.btnPressed[2] = true; return; }
    if (on) { if (!I.keys.has(b.key)) I.pressed.add(b.key); I.keys.add(b.key); }
    else I.keys.delete(b.key);
  }

  _down(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const [x, y] = this._local(e);
    const b = this._hitButton(x, y);
    if (b) {
      if (b.id === 'pause') { if (this.onPause) this.onPause(); return; }
      this._press(b, true);
      b.ptr = e.pointerId;
      // Fire/ADS keep steering the view as the thumb slides off them.
      this.pointers.set(e.pointerId, { role: b.drag ? 'look' : 'button', btn: b, lx: x, ly: y });
      return;
    }
    const z = this.stickZone;
    if (!this.stick.active && x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) {
      this.stick.active = true;
      this.stick.ptr = e.pointerId;
      this.stick.ox = x; this.stick.oy = y;
      this.stick.x = x; this.stick.y = y;
      this.pointers.set(e.pointerId, { role: 'stick', lx: x, ly: y });
      return;
    }
    this.pointers.set(e.pointerId, { role: 'look', lx: x, ly: y });
  }

  _move(e) {
    if (!this.enabled) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const [x, y] = this._local(e);
    if (p.role === 'stick') {
      this.stick.x = x; this.stick.y = y;
      // Drag the origin along if the thumb travels past the ring.
      const dx = x - this.stick.ox, dy = y - this.stick.oy;
      const d = Math.hypot(dx, dy);
      if (d > this.stick.max) {
        this.stick.ox = x - (dx / d) * this.stick.max;
        this.stick.oy = y - (dy / d) * this.stick.max;
      }
    } else if (p.role === 'look') {
      this.input.mouse.dx += (x - p.lx) * this.lookGain;
      this.input.mouse.dy += (y - p.ly) * this.lookGain;
    }
    p.lx = x; p.ly = y;
  }

  _up(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.role === 'stick' || this.stick.ptr === e.pointerId) {
      this.stick.active = false; this.stick.ptr = -1;
      this.stick.dx = 0; this.stick.dy = 0;
    }
    if (p.btn) { this._press(p.btn, false); p.btn.ptr = -1; }
    // A pointer that started on a drag-button also released that button above.
    for (const b of this.buttons) if (b.ptr === e.pointerId) { this._press(b, false); b.ptr = -1; }
  }

  releaseAll() {
    for (const b of this.buttons) if (b.down) { this._press(b, false); b.ptr = -1; }
    this.pointers.clear();
    this.stick.active = false; this.stick.dx = 0; this.stick.dy = 0;
    this.input.axis.x = 0; this.input.axis.y = 0;
    this._setSprint(false);
  }

  _setSprint(on) {
    if (on === this.autoSprint) return;
    this.autoSprint = on;
    const I = this.input;
    if (on) { if (!I.keys.has('ShiftLeft')) I.pressed.add('ShiftLeft'); I.keys.add('ShiftLeft'); }
    else I.keys.delete('ShiftLeft');
  }

  /** Writes the analog stick into the shared input axis, and auto-sprints. */
  update(dt) {
    if (!this.enabled) return;
    const st = this.stick;
    if (!st.active) {
      this.input.axis.x = 0; this.input.axis.y = 0;
      this._sprintHold = 0;
      this._setSprint(false);
      return;
    }
    let dx = (st.x - st.ox) / st.max;
    let dy = (st.y - st.oy) / st.max;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    // Dead zone, then rescale so the usable range still reaches full tilt.
    const dead = 0.16;
    const mag = Math.hypot(dx, dy);
    if (mag < dead) { dx = 0; dy = 0; }
    else {
      const k = ((mag - dead) / (1 - dead)) / mag;
      dx *= k; dy *= k;
    }
    st.dx = dx; st.dy = dy;
    this.input.axis.x = dx;
    this.input.axis.y = -dy;      // screen-down is backwards

    // Push the stick fully forward for a moment and you break into a run.
    const runningForward = -dy > 0.82 && Math.hypot(dx, dy) > 0.88;
    if (runningForward) this._sprintHold += dt; else this._sprintHold = 0;
    this._setSprint(this._sprintHold > 0.18);
  }
}
