// First-person weapon rendering: sway, bob, recoil springs, ADS, sprint carry,
// and the scripted reload/draw animations. Everything is procedural.

import { Builder, boxGeo, capsuleGeo, sphereGeo } from '../render/geometry.js';
import { MAT } from '../render/textures.js';
import { defaultMaterial } from '../render/renderer.js';
import { M4, V3, m4, v3, clamp, lerp, damp, smoothstep, rand } from '../core/math.js';

/* ------------------------------------------------------------------ hands */

export function buildHands(gl) {
  const mk = (fn, matInit) => {
    const b = new Builder();
    fn(b);
    const mat = defaultMaterial();
    Object.assign(mat, matInit);
    return { mesh: b.build(gl), mat };
  };
  const t = m4();
  const glove = mk((b) => {
    M4.compose(t, 0, 0, 0.012, 0, 0, 0);
    b.add(boxGeo(0.072, 0.098, 0.072), t, 3.0);
    M4.compose(t, 0, -0.052, -0.020, 0.35, 0, 0);
    b.add(boxGeo(0.070, 0.062, 0.052), t, 3.4);         // fingers wrapping
    M4.compose(t, 0.038, 0.010, -0.026, 0, 0, -0.5);
    b.add(boxGeo(0.026, 0.052, 0.030), t, 3.4);         // thumb
  }, { layer: MAT.POLYMER, uvScale: [4.5, 4.5], tint: [0.75, 0.72, 0.70], rough: 1, metal: 1 });

  const forearm = mk((b) => {
    M4.compose(t, 0, -0.13, 0, 0, 0, 0);
    b.add(capsuleGeo(0.052, 0.17, 12, 8), t, 1);
    M4.compose(t, 0, -0.028, 0, 0, 0, 0);
    b.add(boxGeo(0.098, 0.055, 0.098), t, 3.0);          // cuff
  }, { layer: MAT.FATIGUES, uvScale: [2.6, 2.6], rough: 1, metal: 1 });

  return { glove, forearm };
}

/* ------------------------------------------------------------- viewmodel */

const SPRING = 46, DAMP = 11;

export class Viewmodel {
  constructor(hands) {
    this.hands = hands;
    this.ads = 0; this.adsTarget = 0;
    this.sprint = 0; this.sprintTarget = 0;
    this.swayX = 0; this.swayY = 0;
    this.bobPhase = 0; this.bobAmt = 0;
    this.kick = v3(0, 0, 0);       // positional recoil
    this.kickVel = v3(0, 0, 0);
    this.rkick = v3(0, 0, 0);      // rotational recoil (pitch, yaw, roll)
    this.rkickVel = v3(0, 0, 0);
    this.reloadT = -1; this.reloadDur = 1; this.reloadEmpty = false;
    this.switchT = -1; this.switchDur = 0.5; this.switchOut = false;
    this.jumpOff = 0; this.jumpVel = 0;
    this.inspectT = -1;
    this.lowered = 0;              // weapon pushed back near geometry
    // Hip-fire anchor (camera space). Tuned so the receiver sits low-right and
    // the muzzle points just inside the crosshair.
    this.hipPos = [0.170, -0.152, -0.292];
    this.hipRot = [0.028, 0.052, 0.052];
    this.local = m4();
    this.world = m4();
    this._t = m4();
    this._muzzle = v3();
    this._muzzleDir = v3();
  }

  fire(w) {
    const r = w.recoil;
    this.kickVel[2] += r.kickBack * 46 * (1 - this.ads * 0.32);
    this.kickVel[1] += r.kickBack * 9;
    this.kickVel[0] += rand(-1, 1) * r.kickBack * 12;
    this.rkickVel[0] -= r.kickRot * 46 * (1 - this.ads * 0.28);
    this.rkickVel[1] += rand(-1, 1) * r.kickRot * 20;
    this.rkickVel[2] += rand(-1, 1) * r.kickRot * 26;
  }

  startReload(dur, empty) { this.reloadT = 0; this.reloadDur = dur; this.reloadEmpty = empty; }
  cancelReload() { this.reloadT = -1; }
  startSwitch(dur) { this.switchT = 0; this.switchDur = dur; this.switchOut = true; }
  jumpImpulse(v) { this.jumpVel += v; }

  update(dt, st) {
    // st: {adsTarget, sprintTarget, moveSpeed, grounded, lookDX, lookDY, weapon}
    const adsRate = 1 / Math.max(0.05, st.adsTime);
    this.ads = clamp(this.ads + Math.sign(st.adsTarget - this.ads) * dt * adsRate, 0, 1);
    if (Math.abs(st.adsTarget - this.ads) < dt * adsRate) this.ads = st.adsTarget;
    this.sprint = damp(this.sprint, st.sprintTarget, 11, dt);

    // Sway lags the look input and settles back.
    const swayScale = (1 - this.ads * 0.72);
    this.swayX = damp(this.swayX, clamp(-st.lookDX * 0.30, -0.055, 0.055) * swayScale, 9, dt);
    this.swayY = damp(this.swayY, clamp(-st.lookDY * 0.30, -0.055, 0.055) * swayScale, 9, dt);

    // Weapon bob follows the footstep cadence.
    const spd = st.moveSpeed;
    this.bobAmt = damp(this.bobAmt, st.grounded ? Math.min(1, spd / 6.0) : 0, 7, dt);
    this.bobPhase += dt * (5.2 + spd * 1.15);

    // Springs.
    for (let i = 0; i < 3; i++) {
      this.kickVel[i] += (-this.kick[i] * SPRING - this.kickVel[i] * DAMP) * dt;
      this.kick[i] += this.kickVel[i] * dt;
      this.rkickVel[i] += (-this.rkick[i] * SPRING * 0.8 - this.rkickVel[i] * (DAMP * 0.85)) * dt;
      this.rkick[i] += this.rkickVel[i] * dt;
    }

    // Landing dip.
    this.jumpVel += (-this.jumpOff * 90 - this.jumpVel * 13) * dt;
    this.jumpOff += this.jumpVel * dt;

    if (this.reloadT >= 0) {
      this.reloadT += dt;
      if (this.reloadT >= this.reloadDur) this.reloadT = -1;
    }
    if (this.switchT >= 0) {
      this.switchT += dt;
      if (this.switchT >= this.switchDur) this.switchT = -1;
    }
    if (this.inspectT >= 0) {
      this.inspectT += dt;
      if (this.inspectT >= 2.6) this.inspectT = -1;
    }
    this.lowered = damp(this.lowered, st.lowerTarget || 0, 14, dt);
  }

  /** Builds the camera-space transform. Returns the local matrix. */
  compose(model) {
    const ads = smoothstep(0, 1, this.ads);
    const sprint = this.sprint * (1 - ads);

    // Hip vs ADS anchor.
    let px = lerp(this.hipPos[0], 0.0, ads);
    let py = lerp(this.hipPos[1], -model.sightY, ads);
    let pz = lerp(this.hipPos[2], model.sightZ - 0.128, ads);
    let rx = lerp(this.hipRot[0], 0, ads);
    let ry = lerp(this.hipRot[1], 0, ads);
    let rz = lerp(this.hipRot[2], 0, ads);

    // Bob — figure-eight, damped hard while aiming.
    const b = this.bobAmt * (1 - ads * 0.85);
    px += Math.sin(this.bobPhase) * 0.020 * b;
    py += Math.abs(Math.cos(this.bobPhase)) * -0.017 * b;
    pz += Math.sin(this.bobPhase * 2) * 0.010 * b;
    rz += Math.sin(this.bobPhase) * 0.030 * b;
    rx += Math.abs(Math.cos(this.bobPhase)) * 0.014 * b;

    // Sway.
    px += this.swayX;
    py += this.swayY;
    ry += this.swayX * 1.5;
    rx += -this.swayY * 1.5;

    // Sprint carry: the weapon cants across the body and drops, but stays in
    // frame — swinging it fully off-screen loses the sense of holding it.
    px += sprint * 0.022;
    py += sprint * -0.052;
    pz += sprint * 0.048;
    rx += sprint * 0.30;
    ry += sprint * -0.42;
    rz += sprint * 0.40;

    // Jump / land.
    py += this.jumpOff;

    // Recoil springs.
    px += this.kick[0]; py += this.kick[1]; pz += this.kick[2];
    rx += this.rkick[0]; ry += this.rkick[1]; rz += this.rkick[2];

    // Reload choreography.
    if (this.reloadT >= 0) {
      const t = this.reloadT / this.reloadDur;
      const tilt = smoothstep(0, 0.18, t) * (1 - smoothstep(0.80, 1.0, t));
      const dip = smoothstep(0, 0.22, t) * (1 - smoothstep(0.78, 1.0, t));
      rz += tilt * 0.62;
      ry += tilt * 0.40;
      rx += tilt * 0.16;
      py += dip * -0.115;
      px += dip * -0.045;
      pz += dip * 0.055;
      // Magazine seat jolt.
      const seat = Math.exp(-Math.pow((t - 0.62) * 16, 2));
      py += seat * -0.035;
      rx += seat * 0.10;
      if (this.reloadEmpty) {
        const bolt = Math.exp(-Math.pow((t - 0.88) * 20, 2));
        pz += bolt * 0.030;
        rz += bolt * 0.09;
      }
    }

    // Draw / holster.
    if (this.switchT >= 0) {
      const t = this.switchT / this.switchDur;
      const d = 1 - smoothstep(0, 1, t);
      py += d * -0.30;
      rx += d * 0.85;
      rz += d * 0.30;
    }

    // Inspect.
    if (this.inspectT >= 0) {
      const t = this.inspectT / 2.6;
      const e = Math.sin(Math.PI * smoothstep(0, 1, Math.min(1, t * 1.15)));
      ry += e * 1.15; rz += e * 0.55; rx += e * 0.20;
      px += e * -0.075; pz += e * 0.075;
    }

    // Pull the weapon back when it's about to clip a wall.
    pz += this.lowered * 0.20;
    rx += this.lowered * 0.55;
    py += this.lowered * -0.05;

    M4.compose(this.local, px, py, pz, rx, ry, rz);
    return this.local;
  }

  /**
   * Emits all viewmodel draw calls. camWorld = inverse(view).
   * Returns the world-space muzzle position and direction.
   */
  render(renderer, camWorld, weapon, out) {
    const model = weapon.model;
    this.compose(model);
    M4.mul(this.world, camWorld, this.local);

    for (const part of model.parts) renderer.draw(part.mesh, this.world, part.mat, true);

    // Hands: trigger hand at the grip, support hand at the handguard.
    const t = this._t;
    const place = (anchor, rx, ry, rz, armPitch, armYaw) => {
      M4.compose(t, anchor[0], anchor[1], anchor[2], rx, ry, rz);
      const gm = m4();
      M4.mul(gm, this.world, t);
      renderer.draw(this.hands.glove.mesh, gm, this.hands.glove.mat, false);
      M4.compose(t, anchor[0], anchor[1] - 0.045, anchor[2] + 0.02, armPitch, armYaw, 0);
      const am = m4();
      M4.mul(am, this.world, t);
      renderer.draw(this.hands.forearm.mesh, am, this.hands.forearm.mat, false);
    };
    place(model.grip, 0.10, 0, 0.10, -0.62, 0.30);
    if (this.reloadT < 0) {
      place(model.support, 0.05, 0, -0.18, -0.95, -0.35);
    } else {
      // Support hand drops to the magwell and comes back up.
      const tt = this.reloadT / this.reloadDur;
      const drop = Math.sin(Math.PI * clamp(tt * 1.05, 0, 1));
      const a = [
        lerp(model.support[0], model.mag[0], drop),
        lerp(model.support[1], model.mag[1] - 0.12 * Math.sin(Math.PI * tt), drop),
        lerp(model.support[2], model.mag[2], drop),
      ];
      place(a, 0.05 + drop * 0.5, 0, -0.18 + drop * 0.4, -0.95 + drop * 0.7, -0.35);
    }

    // Muzzle in world space.
    const m = model.muzzle;
    const wm = this.world;
    out.mx = wm[0] * m[0] + wm[4] * m[1] + wm[8] * m[2] + wm[12];
    out.my = wm[1] * m[0] + wm[5] * m[1] + wm[9] * m[2] + wm[13];
    out.mz = wm[2] * m[0] + wm[6] * m[1] + wm[10] * m[2] + wm[14];
    // -Z of the gun's own basis.
    out.dx = -wm[8]; out.dy = -wm[9]; out.dz = -wm[10];
    const e = model.eject;
    out.ex = wm[0] * e[0] + wm[4] * e[1] + wm[8] * e[2] + wm[12];
    out.ey = wm[1] * e[0] + wm[5] * e[1] + wm[9] * e[2] + wm[13];
    out.ez = wm[2] * e[0] + wm[6] * e[1] + wm[10] * e[2] + wm[14];
    out.rx = wm[0]; out.ry = wm[1]; out.rz = wm[2];
    return out;
  }
}
