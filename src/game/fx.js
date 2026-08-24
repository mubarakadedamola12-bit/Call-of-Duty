// Particles, tracers, decals, muzzle flashes, explosions.
// All FX are pooled; nothing allocates during steady-state play.

import { rand, randSign, clamp, lerp } from '../core/math.js';

const KIND = { SMOKE: 0, SPARK: 1, FLASH: 2, DEBRIS: 3, BLOOD: 4, RING: 5 };
export { KIND };

class Particle {
  constructor() { this.alive = false; }
  reset(o) {
    this.alive = true;
    this.x = o.x; this.y = o.y; this.z = o.z;
    this.vx = o.vx || 0; this.vy = o.vy || 0; this.vz = o.vz || 0;
    this.t = 0; this.life = o.life;
    this.s0 = o.s0; this.s1 = o.s1 === undefined ? o.s0 : o.s1;
    this.r = o.r; this.g = o.g; this.b = o.b;
    this.r1 = o.r1 === undefined ? o.r : o.r1;
    this.g1 = o.g1 === undefined ? o.g : o.g1;
    this.b1 = o.b1 === undefined ? o.b : o.b1;
    this.a0 = o.a0 === undefined ? 1 : o.a0;
    this.a1 = o.a1 === undefined ? 0 : o.a1;
    this.kind = o.kind;
    this.rot = o.rot === undefined ? rand(0, 6.28) : o.rot;
    this.rotVel = o.rotVel || 0;
    this.drag = o.drag === undefined ? 1.4 : o.drag;
    this.grav = o.grav === undefined ? 0 : o.grav;
    this.stretch = o.stretch === undefined ? 1 : o.stretch;
    this.glow = o.glow === undefined ? Math.random() : o.glow;
    this.bounce = o.bounce || 0;
    this.light = o.light || 0;
    this.lightR = o.lightR || 4;
  }
}

export class FX {
  constructor(world) {
    this.world = world;
    this.pool = [];
    this.max = 2600;
    for (let i = 0; i < this.max; i++) this.pool.push(new Particle());
    this.cursor = 0;
    this.tracers = [];
    this.decalQueue = [];
    this.explosions = [];
    this.time = 0;
  }

  _spawn(o) {
    // Ring-buffer allocation: newest FX always wins.
    for (let tries = 0; tries < 24; tries++) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.max;
      if (!p.alive) { p.reset(o); return p; }
    }
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    p.reset(o);
    return p;
  }

  /* ------------------------------------------------------------- impacts */

  impact(x, y, z, nx, ny, nz, kind, scale = 1) {
    const surf = kind || 'hard';
    const dust = surf === 'sand' ? [0.62, 0.50, 0.34]
      : surf === 'wood' ? [0.45, 0.33, 0.20]
        : surf === 'metal' ? [0.55, 0.55, 0.58] : [0.60, 0.58, 0.55];

    // Puff of surface dust.
    const nPuff = surf === 'sand' ? 7 : 5;
    for (let i = 0; i < nPuff; i++) {
      const sp = rand(0.6, 2.6) * scale;
      this._spawn({
        x, y, z,
        vx: nx * sp + rand(-0.9, 0.9), vy: ny * sp + rand(-0.2, 1.3), vz: nz * sp + rand(-0.9, 0.9),
        life: rand(0.45, 0.95), s0: rand(0.05, 0.10) * scale, s1: rand(0.30, 0.60) * scale,
        r: dust[0], g: dust[1], b: dust[2],
        r1: dust[0] * 0.55, g1: dust[1] * 0.55, b1: dust[2] * 0.55,
        a0: 0.62, a1: 0, kind: KIND.SMOKE, drag: 2.2, grav: -1.2, rotVel: rand(-2, 2),
      });
    }
    // Debris flecks.
    for (let i = 0; i < 6; i++) {
      const sp = rand(2, 7) * scale;
      this._spawn({
        x, y, z,
        vx: nx * sp + rand(-2.5, 2.5), vy: ny * sp + rand(0, 3.2), vz: nz * sp + rand(-2.5, 2.5),
        life: rand(0.5, 1.2), s0: rand(0.010, 0.026) * scale, s1: rand(0.008, 0.018) * scale,
        r: dust[0] * 0.7, g: dust[1] * 0.7, b: dust[2] * 0.7,
        a0: 1, a1: 0.5, kind: KIND.DEBRIS, drag: 0.5, grav: -13, bounce: 0.32,
      });
    }
    // Sparks — only off hard/metal surfaces.
    if (surf === 'metal' || surf === 'hard') {
      const n = surf === 'metal' ? 12 : 6;
      for (let i = 0; i < n; i++) {
        const sp = rand(3, 11) * scale;
        this._spawn({
          x: x + nx * 0.02, y: y + ny * 0.02, z: z + nz * 0.02,
          vx: nx * sp + rand(-4, 4), vy: ny * sp + rand(0, 4), vz: nz * sp + rand(-4, 4),
          life: rand(0.20, 0.55), s0: rand(0.016, 0.034) * scale, s1: 0.004,
          r: 3.4, g: 1.7, b: 0.55, r1: 1.6, g1: 0.35, b1: 0.06,
          a0: 1, a1: 0, kind: KIND.SPARK, drag: 0.7, grav: -12, stretch: 2.4, bounce: 0.25,
        });
      }
      this._spawn({
        x: x + nx * 0.03, y: y + ny * 0.03, z: z + nz * 0.03,
        life: 0.075, s0: 0.20 * scale, s1: 0.05,
        r: 4.0, g: 2.2, b: 0.9, a0: 1, a1: 0,
        kind: KIND.FLASH, light: 1.2, lightR: 3.0,
      });
    }
    this.decalQueue.push({ x: x + nx * 0.012, y: y + ny * 0.012, z: z + nz * 0.012, nx, ny, nz, size: rand(0.055, 0.10) * scale, kind: 0, alpha: 1 });
  }

  bloodImpact(x, y, z, dx, dy, dz, scale = 1) {
    // Deliberately tight and short-lived: a wide, slow mist reads as red fog.
    for (let i = 0; i < 5; i++) {
      const sp = rand(1.5, 5.0) * scale;
      this._spawn({
        x, y, z,
        vx: dx * sp + rand(-1.4, 1.4), vy: dy * sp + rand(-0.4, 1.6), vz: dz * sp + rand(-1.4, 1.4),
        life: rand(0.16, 0.34), s0: rand(0.025, 0.055) * scale, s1: rand(0.07, 0.13) * scale,
        r: 0.34, g: 0.024, b: 0.018, r1: 0.10, g1: 0.008, b1: 0.006,
        a0: 0.62, a1: 0, kind: KIND.BLOOD, drag: 3.4, grav: -6.5,
      });
    }
    for (let i = 0; i < 5; i++) {
      const sp = rand(2, 7);
      this._spawn({
        x, y, z,
        vx: dx * sp + rand(-2, 2), vy: rand(0.5, 3.5), vz: dz * sp + rand(-2, 2),
        life: rand(0.5, 1.0), s0: 0.016, s1: 0.010,
        r: 0.30, g: 0.02, b: 0.015, a0: 1, a1: 0.4,
        kind: KIND.DEBRIS, drag: 0.6, grav: -13,
      });
    }
  }

  /* ------------------------------------------------------------- weapons */

  muzzleFlash(x, y, z, dx, dy, dz, scale = 1, seed = 0) {
    const s = scale;
    this._spawn({
      x: x + dx * 0.06, y: y + dy * 0.06, z: z + dz * 0.06,
      life: 0.055, s0: 0.30 * s, s1: 0.14 * s,
      r: 5.5, g: 3.2, b: 1.5, a0: 1, a1: 0,
      kind: KIND.FLASH, rot: seed * 7.7, glow: seed,
      light: 1, lightR: 9 * s,
    });
    this._spawn({
      x: x + dx * 0.16, y: y + dy * 0.16, z: z + dz * 0.16,
      life: 0.042, s0: 0.16 * s, s1: 0.07 * s,
      r: 7.0, g: 5.2, b: 3.2, a0: 1, a1: 0, kind: KIND.FLASH, rot: seed * 3.1, glow: seed * 0.7,
    });
    // Sparks and unburnt powder out of the muzzle.
    for (let i = 0; i < 5; i++) {
      const sp = rand(3, 12) * s;
      this._spawn({
        x: x + dx * 0.1, y: y + dy * 0.1, z: z + dz * 0.1,
        vx: dx * sp + rand(-1.6, 1.6), vy: dy * sp + rand(-1, 1.6), vz: dz * sp + rand(-1.6, 1.6),
        life: rand(0.10, 0.32), s0: rand(0.010, 0.022) * s, s1: 0.003,
        r: 3.2, g: 1.5, b: 0.4, r1: 1.2, g1: 0.25, b1: 0.05,
        a0: 1, a1: 0, kind: KIND.SPARK, drag: 1.4, grav: -8, stretch: 2.0,
      });
    }
    // Barrel smoke.
    for (let i = 0; i < 2; i++) {
      this._spawn({
        x: x + dx * 0.12, y: y + dy * 0.12, z: z + dz * 0.12,
        vx: dx * rand(0.6, 2.0) + rand(-0.3, 0.3), vy: rand(0.15, 0.6), vz: dz * rand(0.6, 2.0) + rand(-0.3, 0.3),
        life: rand(0.45, 0.90), s0: 0.055 * s, s1: rand(0.30, 0.55) * s,
        r: 0.62, g: 0.60, b: 0.58, r1: 0.30, g1: 0.30, b1: 0.31,
        a0: 0.20, a1: 0, kind: KIND.SMOKE, drag: 1.8, grav: 0.55, rotVel: rand(-1.2, 1.2),
      });
    }
  }

  tracer(x, y, z, dx, dy, dz, dist, speed = 420, color = [1.9, 1.05, 0.42]) {
    this.tracers.push({
      x, y, z, dx, dy, dz, travelled: 0.6, dist, speed,
      r: color[0], g: color[1], b: color[2], len: rand(2.6, 4.2), a: 1,
    });
  }

  shellCasing(x, y, z, rx, ry, rz, up = 1) {
    this._spawn({
      x, y, z,
      vx: rx * rand(1.6, 3.2) + rand(-0.4, 0.4), vy: rand(1.2, 2.4) * up, vz: rz * rand(1.6, 3.2) + rand(-0.4, 0.4),
      life: 2.6, s0: 0.017, s1: 0.017,
      r: 1.25, g: 0.82, b: 0.30, a0: 1, a1: 1,
      kind: KIND.DEBRIS, drag: 0.25, grav: -13.5, bounce: 0.42, rotVel: rand(-14, 14), stretch: 2.2,
    });
  }

  /* ---------------------------------------------------------- explosions */

  explosion(x, y, z, scale = 1) {
    this.explosions.push({ x, y, z, t: 0, life: 0.85, scale });
    // Core fireball.
    for (let i = 0; i < 16; i++) {
      const a = rand(0, 6.283), e = rand(-0.35, 1.0);
      const sp = rand(2, 11) * scale;
      this._spawn({
        x, y, z,
        vx: Math.cos(a) * sp, vy: e * sp * 0.85 + 2, vz: Math.sin(a) * sp,
        life: rand(0.30, 0.62), s0: rand(0.35, 0.85) * scale, s1: rand(1.0, 2.2) * scale,
        r: 6.0, g: 2.4, b: 0.55, r1: 0.9, g1: 0.18, b1: 0.05,
        a0: 1, a1: 0, kind: KIND.SMOKE, drag: 1.9, grav: 1.6, rotVel: rand(-2, 2),
      });
    }
    // Smoke shell that lingers.
    for (let i = 0; i < 20; i++) {
      const a = rand(0, 6.283);
      const sp = rand(1.5, 7) * scale;
      this._spawn({
        x, y: y + rand(-0.2, 0.5), z,
        vx: Math.cos(a) * sp, vy: rand(0.4, 3.4), vz: Math.sin(a) * sp,
        life: rand(1.4, 3.0), s0: rand(0.4, 0.9) * scale, s1: rand(2.0, 4.0) * scale,
        r: 0.30, g: 0.27, b: 0.25, r1: 0.10, g1: 0.095, b1: 0.09,
        a0: 0.55, a1: 0, kind: KIND.SMOKE, drag: 1.1, grav: 0.65, rotVel: rand(-0.8, 0.8),
      });
    }
    // Radial sparks + ground dust.
    for (let i = 0; i < 30; i++) {
      const a = rand(0, 6.283);
      const sp = rand(6, 24) * scale;
      this._spawn({
        x, y, z,
        vx: Math.cos(a) * sp, vy: rand(0.5, 9), vz: Math.sin(a) * sp,
        life: rand(0.35, 1.0), s0: rand(0.02, 0.05) * scale, s1: 0.006,
        r: 4.5, g: 2.0, b: 0.5, r1: 1.4, g1: 0.28, b1: 0.05,
        a0: 1, a1: 0, kind: KIND.SPARK, drag: 0.55, grav: -14, stretch: 3.0, bounce: 0.3,
      });
    }
    for (let i = 0; i < 14; i++) {
      const a = rand(0, 6.283);
      const sp = rand(4, 14) * scale;
      this._spawn({
        x, y: y - 0.2, z,
        vx: Math.cos(a) * sp, vy: rand(0.1, 1.4), vz: Math.sin(a) * sp,
        life: rand(0.8, 1.7), s0: rand(0.25, 0.55) * scale, s1: rand(1.4, 2.6) * scale,
        r: 0.66, g: 0.54, b: 0.38, r1: 0.28, g1: 0.23, b1: 0.17,
        a0: 0.55, a1: 0, kind: KIND.SMOKE, drag: 2.2, grav: -0.4, rotVel: rand(-1.5, 1.5),
      });
    }
    // Shock ring.
    this._spawn({
      x, y: y + 0.1, z, life: 0.30, s0: 0.5 * scale, s1: 6.0 * scale,
      r: 3.0, g: 2.0, b: 1.2, a0: 0.8, a1: 0, kind: KIND.RING,
    });
    this.decalQueue.push({ x, y: 0.02, z, nx: 0, ny: 1, nz: 0, size: 2.2 * scale, kind: 1, alpha: 0.9 });
  }

  /* ------------------------------------------------------- ambient emitters */

  fireEmbers(x, y, z, dt) {
    if (Math.random() > dt * 22) return;
    this._spawn({
      x: x + rand(-0.18, 0.18), y: y + rand(0, 0.2), z: z + rand(-0.18, 0.18),
      vx: rand(-0.35, 0.35), vy: rand(1.0, 2.6), vz: rand(-0.35, 0.35),
      life: rand(0.8, 1.9), s0: rand(0.012, 0.030), s1: 0.004,
      r: 3.4, g: 1.3, b: 0.30, r1: 1.1, g1: 0.20, b1: 0.03,
      a0: 1, a1: 0, kind: KIND.SPARK, drag: 0.55, grav: 1.4, stretch: 1.6,
    });
    if (Math.random() < dt * 9) {
      this._spawn({
        x: x + rand(-0.2, 0.2), y: y + 0.25, z: z + rand(-0.2, 0.2),
        vx: rand(-0.25, 0.25), vy: rand(0.7, 1.5), vz: rand(-0.25, 0.25),
        life: rand(1.4, 2.6), s0: 0.22, s1: 1.1,
        r: 0.24, g: 0.21, b: 0.19, r1: 0.08, g1: 0.075, b1: 0.07,
        a0: 0.28, a1: 0, kind: KIND.SMOKE, drag: 1.0, grav: 0.5, rotVel: rand(-0.6, 0.6),
      });
    }
    // The flame itself.
    this._spawn({
      x: x + rand(-0.12, 0.12), y: y + rand(0, 0.1), z: z + rand(-0.12, 0.12),
      vx: rand(-0.2, 0.2), vy: rand(1.4, 2.6), vz: rand(-0.2, 0.2),
      life: rand(0.22, 0.45), s0: rand(0.16, 0.30), s1: rand(0.05, 0.12),
      r: 5.0, g: 1.9, b: 0.40, r1: 1.6, g1: 0.30, b1: 0.04,
      a0: 0.9, a1: 0, kind: KIND.SMOKE, drag: 1.4, grav: 1.6,
    });
  }

  dustDevil(x, z, dt) {
    if (Math.random() > dt * 2.4) return;
    this._spawn({
      x: x + rand(-8, 8), y: rand(0.1, 1.4), z: z + rand(-8, 8),
      vx: rand(0.6, 2.2), vy: rand(0.02, 0.28), vz: rand(-0.5, 0.9),
      life: rand(2.4, 5.0), s0: rand(0.3, 0.9), s1: rand(1.4, 3.2),
      r: 0.55, g: 0.44, b: 0.30, r1: 0.30, g1: 0.24, b1: 0.17,
      a0: 0.055, a1: 0, kind: KIND.SMOKE, drag: 0.35, grav: 0.03, rotVel: rand(-0.4, 0.4),
    });
  }

  /* ---------------------------------------------------------------- tick */

  update(dt, renderer) {
    this.time += dt;
    const world = this.world;

    // Flush decals into the renderer's persistent ring buffer.
    for (const d of this.decalQueue) {
      renderer.addDecal(d.x, d.y, d.z, d.nx, d.ny, d.nz, d.size, rand(0, 6.28), d.kind, d.alpha);
    }
    this.decalQueue.length = 0;

    // Tracers.
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.travelled += t.speed * dt;
      if (t.travelled >= t.dist) { this.tracers.splice(i, 1); continue; }
      const head = t.travelled;
      const tail = Math.max(0, head - t.len);
      const fade = 1 - clamp((head / t.dist) * 0.35, 0, 0.35);
      renderer.addBeam(
        t.x + t.dx * tail, t.y + t.dy * tail, t.z + t.dz * tail,
        t.x + t.dx * head, t.y + t.dy * head, t.z + t.dz * head,
        0.030, t.r, t.g, t.b, fade,
      );
      renderer.addLight(t.x + t.dx * head, t.y + t.dy * head, t.z + t.dz * head,
        3.0, t.r, t.g, t.b, 0.7);
    }

    // Explosion lights.
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.t += dt;
      if (e.t >= e.life) { this.explosions.splice(i, 1); continue; }
      const k = e.t / e.life;
      const inten = (1 - k) * (1 - k) * 90 * e.scale;
      renderer.addLight(e.x, e.y + 0.6, e.z, 22 * e.scale, 1.0, 0.45 - k * 0.28, 0.14, inten);
    }

    // Particles.
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (!p.alive) continue;
      p.t += dt;
      if (p.t >= p.life) { p.alive = false; continue; }

      p.vy += p.grav * dt;
      const dg = Math.exp(-p.drag * dt);
      p.vx *= dg; p.vy *= dg; p.vz *= dg;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.rotVel * dt;

      if (p.bounce > 0 && p.y < 0.012 && p.vy < 0) {
        p.y = 0.012;
        p.vy = -p.vy * p.bounce;
        p.vx *= 0.62; p.vz *= 0.62;
        p.rotVel *= 0.5;
        if (Math.abs(p.vy) < 0.35) { p.vy = 0; p.grav = 0; p.bounce = 0; p.drag = 8; }
      }

      const k = p.t / p.life;
      const size = lerp(p.s0, p.s1, p.kind === KIND.SMOKE ? Math.sqrt(k) : k);
      const alpha = lerp(p.a0, p.a1, p.kind === KIND.SPARK ? k * k : k);
      const r = lerp(p.r, p.r1, k), g = lerp(p.g, p.g1, k), b = lerp(p.b, p.b1, k);

      // Sparks stretch along their velocity direction.
      let rot = p.rot, stretch = p.stretch;
      if (p.stretch > 1) {
        const sp = Math.hypot(p.vx, p.vy, p.vz);
        stretch = 1 + Math.min(p.stretch, sp * 0.14);
      }
      renderer.addParticle(p.x, p.y, p.z, size, r, g, b, alpha, rot, stretch, p.kind, p.glow);

      if (p.light > 0) {
        renderer.addLight(p.x, p.y, p.z, p.lightR, r, g, b, p.light * (1 - k) * 40);
      }
    }
  }
}
