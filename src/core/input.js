// Pointer-lock mouse look + keyboard state.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();     // edge-triggered, cleared each frame
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = [false, false, false];
    this.btnPressed = [false, false, false];
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.onLockChange = null;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const c = e.code;
      this.keys.add(c);
      this.pressed.add(c);
      // Arrows double as movement keys, so stop them scrolling the page.
      if (c.startsWith('Arrow')) e.preventDefault();
      if (this.locked && ['Tab', 'Space', 'F1', 'F5', 'Slash', 'Quote'].includes(c)) e.preventDefault();
      if (this.locked && c.startsWith('Digit')) e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); this.released.add(e.code); });
    addEventListener('blur', () => { this.keys.clear(); this.buttons = [false, false, false]; });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });

    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      if (e.button < 3) { this.buttons[e.button] = true; this.btnPressed[e.button] = true; }
    });
    addEventListener('mouseup', (e) => { if (e.button < 3) this.buttons[e.button] = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.mouse.wheel += Math.sign(e.deltaY);
    }, { passive: false });
  }

  requestLock() {
    const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
  }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }
  /** Consume per-frame edge state. Call at the end of each update. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
    this.btnPressed[0] = this.btnPressed[1] = this.btnPressed[2] = false;
  }
}
