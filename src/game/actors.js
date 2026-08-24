// Character model, movement/collision, and bot AI.

import { Builder, boxGeo, cylinderGeo, sphereGeo, capsuleGeo } from '../render/geometry.js';
import { MAT } from '../render/textures.js';
import { defaultMaterial } from '../render/renderer.js';
import { M4, V3, m4, v3, clamp, lerp, damp, rand, smoothstep } from '../core/math.js';
import { ARENA } from './world.js';

/* --------------------------------------------------------- soldier model */

const PARTMAT = {
  camo: { layer: MAT.FATIGUES, uvScale: [2.2, 2.2], rough: 1, metal: 1 },
  gear: { layer: MAT.POLYMER, uvScale: [4.0, 4.0], tint: [0.85, 0.88, 0.92], rough: 1, metal: 1 },
  gearTan: { layer: MAT.POLYMER, uvScale: [4.0, 4.0], tint: [2.6, 2.1, 1.35], rough: 1, metal: 1 },
  metal: { layer: MAT.GUNMETAL, uvScale: [3, 3], rough: 1, metal: 1 },
  glass: { layer: MAT.GLASSDIRT, uvScale: [2, 2], tint: [1.6, 1.4, 1.0], rough: 0.30, metal: 1 },
};

/**
 * Builds one body part as a SINGLE mesh, with the per-material differences
 * baked into per-vertex layer/tint. A rig drawn material-by-material cost ~28
 * draw calls per soldier, times three passes, times nine bots — which was most
 * of the frame. This makes it one draw per bone instead.
 */
function partBuilder(camoTint) {
  const b = new Builder();
  const vm = (name) => {
    const d = PARTMAT[name];
    // Team colour is baked into the fatigues at build time rather than applied
    // as a draw uniform, because the whole bone is now a single mesh.
    if (name === 'camo' && camoTint) return { layer: d.layer, tint: camoTint };
    return { layer: d.layer, tint: d.tint || [1, 1, 1] };
  };
  const uvOf = (name) => PARTMAT[name].uvScale[0];
  const m = m4();
  const api = {
    box(name, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0, uvS = 1) {
      M4.compose(m, x, y, z, rx, ry, rz);
      b.add(boxGeo(w, h, d), m, uvS * uvOf(name), [0, 0], vm(name)); return api;
    },
    sph(name, r, x, y, z, sx = 1, sy = 1, sz = 1, uvS = 1) {
      M4.compose(m, x, y, z, 0, 0, 0, sx, sy, sz);
      b.add(sphereGeo(r, 14, 10), m, uvS * uvOf(name), [0, 0], vm(name)); return api;
    },
    cap(name, r, h, x, y, z, rx = 0, ry = 0, rz = 0) {
      M4.compose(m, x, y, z, rx, ry, rz);
      b.add(capsuleGeo(r, h, 12, 8), m, uvOf(name), [0, 0], vm(name)); return api;
    },
    cyl(name, r, h, x, y, z, rx = 0, ry = 0, rz = 0, seg = 12) {
      M4.compose(m, x, y, z, rx, ry, rz);
      b.add(cylinderGeo(r, h, seg), m, uvOf(name), [0, 0], vm(name)); return api;
    },
    build(gl) {
      // uvScale is already folded into the vertex UVs, so the shared material
      // only has to carry the shading constants.
      const mat = defaultMaterial();
      mat.uvScale = [1, 1];
      mat.rough = 1; mat.metal = 1;
      return [{ mesh: b.build(gl), mat, name: 'body' }];
    },
  };
  return api;
}

/**
 * Body parts are modelled around their joint pivot so the animation code can
 * just rotate them. Rig is: pelvis -> torso -> head, and limbs off those.
 */
/** @param camoTint per-team fatigue colour, baked into the mesh. */
export function buildSoldier(gl, camoTint) {
  const parts = {};
  const partBuilderT = () => partBuilder(camoTint);

  // --- torso (pivot at the waist)
  let p = partBuilderT();
  p.box('camo', 0.40, 0.30, 0.23, 0, 0.16, 0);
  p.box('camo', 0.44, 0.20, 0.25, 0, 0.40, 0);
  p.box('gear', 0.42, 0.30, 0.27, 0, 0.24, 0.005, 0, 0, 0, 1.6);        // plate carrier
  p.box('gearTan', 0.10, 0.09, 0.05, -0.13, 0.24, -0.145, 0, 0, 0, 3);   // mag pouches
  p.box('gearTan', 0.10, 0.09, 0.05, 0.00, 0.24, -0.150, 0, 0, 0, 3);
  p.box('gearTan', 0.10, 0.09, 0.05, 0.13, 0.24, -0.145, 0, 0, 0, 3);
  p.box('gearTan', 0.09, 0.10, 0.05, -0.13, 0.11, -0.145, 0, 0, 0, 3);
  p.box('gear', 0.26, 0.30, 0.16, 0, 0.26, 0.19, 0, 0, 0, 2);            // pack
  p.box('gearTan', 0.20, 0.10, 0.06, 0, 0.14, 0.25, 0, 0, 0, 3);
  p.cyl('metal', 0.035, 0.16, 0.11, 0.42, 0.18, 0.2, 0, 0);              // antenna
  p.box('gear', 0.075, 0.075, 0.055, -0.16, 0.36, -0.10, 0, 0, 0.4, 3);  // radio
  parts.torso = p.build(gl);

  // --- head (pivot at the neck)
  p = partBuilderT();
  p.sph('gear', 0.107, 0, 0.115, 0.005, 1.06, 1.16, 1.14, 2.0);          // helmet
  p.box('gear', 0.215, 0.045, 0.10, 0, 0.115, -0.085, 0.28, 0, 0, 2.5);  // brim
  p.sph('camo', 0.093, 0, 0.10, 0, 1, 1.10, 1.02, 2.5);                  // balaclava
  p.box('camo', 0.15, 0.10, 0.02, 0, 0.085, -0.098, 0, 0, 0, 3);
  p.box('glass', 0.175, 0.052, 0.035, 0, 0.128, -0.078, 0.05, 0, 0, 2);  // goggles
  p.box('gear', 0.205, 0.028, 0.06, 0, 0.145, 0.005, 0, 0, 0, 3);        // strap
  p.box('metal', 0.045, 0.075, 0.045, 0.055, 0.185, -0.055, 0.3, 0, 0);  // NVG mount
  p.cyl('metal', 0.026, 0.075, 0.055, 0.215, -0.075, 1.57, 0, 0, 10);
  parts.head = p.build(gl);

  // --- upper arm (pivot at shoulder, extends -Y)
  p = partBuilderT();
  p.cap('camo', 0.058, 0.13, 0, -0.105, 0);
  p.box('gear', 0.105, 0.075, 0.098, 0, -0.020, 0, 0, 0, 0, 2.2);        // shoulder pad
  parts.upperArm = p.build(gl);

  // --- lower arm + glove
  p = partBuilderT();
  p.cap('camo', 0.049, 0.115, 0, -0.095, 0);
  p.box('gear', 0.075, 0.070, 0.062, 0, -0.190, 0, 0, 0, 0, 2.6);
  parts.lowerArm = p.build(gl);

  // --- thigh
  p = partBuilderT();
  p.cap('camo', 0.077, 0.17, 0, -0.135, 0);
  p.box('gearTan', 0.10, 0.11, 0.055, 0.055, -0.165, 0, 0, 0, 0, 3);     // drop pouch
  parts.thigh = p.build(gl);

  // --- shin + boot
  p = partBuilderT();
  p.cap('camo', 0.062, 0.16, 0, -0.125, 0);
  p.box('gear', 0.098, 0.075, 0.235, 0, -0.245, -0.035, 0, 0, 0, 2.2);   // boot
  p.box('gear', 0.104, 0.030, 0.245, 0, -0.278, -0.035, 0, 0, 0, 2.6);   // sole
  parts.shin = p.build(gl);

  // --- pelvis
  p = partBuilderT();
  p.box('camo', 0.32, 0.19, 0.21, 0, -0.06, 0);
  p.box('gearTan', 0.35, 0.075, 0.23, 0, 0.01, 0, 0, 0, 0, 2.2);         // belt
  p.box('gear', 0.075, 0.11, 0.05, 0.155, -0.06, 0.02, 0, 0, 0, 3);      // holster
  parts.pelvis = p.build(gl);

  // --- team marker (emissive strip on the shoulder)
  p = partBuilderT();
  p.box('metal', 0.11, 0.035, 0.09, 0, 0, 0);
  parts.marker = p.build(gl);

  return parts;
}

/* ------------------------------------------------------- movement/collide */

const _l = [0, 0, 0], _w = [0, 0, 0], _p = [0, 0, 0];

export function collideXZ(world, pos, radius, yMin, yMax) {
  let hitTop = -Infinity, hit = false;
  for (const c of world.colliders) {
    if (yMax <= c.bottom + 0.02 || yMin >= c.top - 0.02) continue;
    if (pos[0] < c.min[0] - radius || pos[0] > c.max[0] + radius) continue;
    if (pos[2] < c.min[2] - radius || pos[2] > c.max[2] + radius) continue;
    _p[0] = pos[0]; _p[1] = pos[1]; _p[2] = pos[2];
    c.toLocal(_p, _l);
    const cx = clamp(_l[0], -c.h[0], c.h[0]);
    const cz = clamp(_l[2], -c.h[2], c.h[2]);
    const dx = _l[0] - cx, dz = _l[2] - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > radius * radius) continue;
    let nx, nz, push;
    if (d2 > 1e-7) {
      const d = Math.sqrt(d2);
      nx = dx / d; nz = dz / d; push = radius - d;
    } else {
      const px = c.h[0] + radius - Math.abs(_l[0]);
      const pz = c.h[2] + radius - Math.abs(_l[2]);
      if (px < pz) { nx = Math.sign(_l[0]) || 1; nz = 0; push = px; }
      else { nx = 0; nz = Math.sign(_l[2]) || 1; push = pz; }
    }
    _w[0] = nx; _w[1] = 0; _w[2] = nz;
    c.toWorldDir(_w, _w);
    pos[0] += _w[0] * push;
    pos[2] += _w[2] * push;
    hit = true;
    if (c.top > hitTop) hitTop = c.top;
  }
  return { hit, hitTop };
}

export function groundAt(world, x, z, fromY, radius) {
  let best = 0;
  _p[0] = x; _p[2] = z;
  for (const c of world.colliders) {
    if (c.top > fromY + 0.02 || c.top < best) continue;
    if (x < c.min[0] - radius || x > c.max[0] + radius) continue;
    if (z < c.min[2] - radius || z > c.max[2] + radius) continue;
    _p[1] = 0;
    c.toLocal(_p, _l);
    const cx = clamp(_l[0], -c.h[0], c.h[0]);
    const cz = clamp(_l[2], -c.h[2], c.h[2]);
    const dx = _l[0] - cx, dz = _l[2] - cz;
    if (dx * dx + dz * dz > radius * radius) continue;
    best = c.top;
  }
  return best;
}

/**
 * Cylinder-vs-OBB movement with step-up. `ent` needs pos, vel, radius, height.
 */
export function moveEntity(world, ent, dt, stepHeight = 0.46) {
  const pos = ent.pos, vel = ent.vel;
  const r = ent.radius, h = ent.height;
  const wasGrounded = ent.grounded === true;

  // --- vertical
  const prevY = pos[1];
  pos[1] += vel[1] * dt;
  let grounded = false;
  for (const c of world.colliders) {
    if (pos[0] < c.min[0] - r || pos[0] > c.max[0] + r) continue;
    if (pos[2] < c.min[2] - r || pos[2] > c.max[2] + r) continue;
    _p[0] = pos[0]; _p[1] = 0; _p[2] = pos[2];
    c.toLocal(_p, _l);
    const cx = clamp(_l[0], -c.h[0], c.h[0]);
    const cz = clamp(_l[2], -c.h[2], c.h[2]);
    const dx = _l[0] - cx, dz = _l[2] - cz;
    if (dx * dx + dz * dz > r * r) continue;
    if (vel[1] <= 0 && prevY >= c.top - 0.001 && pos[1] <= c.top) {
      pos[1] = c.top; vel[1] = 0; grounded = true;
    } else if (vel[1] > 0 && prevY + h <= c.bottom + 0.001 && pos[1] + h >= c.bottom) {
      pos[1] = c.bottom - h; vel[1] = 0;
    }
  }
  if (pos[1] <= 0) { pos[1] = 0; if (vel[1] < 0) vel[1] = 0; grounded = true; }

  // --- horizontal, with a step-up retry
  const beforeX = pos[0], beforeZ = pos[2];
  pos[0] += vel[0] * dt;
  pos[2] += vel[2] * dt;
  const res = collideXZ(world, pos, r, pos[1] + 0.12, pos[1] + h);

  if (res.hit && grounded) {
    const rise = res.hitTop - pos[1];
    if (rise > 0.02 && rise <= stepHeight) {
      const tx = beforeX + vel[0] * dt, tz = beforeZ + vel[2] * dt;
      const probe = [tx, res.hitTop + 0.02, tz];
      const re = collideXZ(world, probe, r, res.hitTop + 0.14, res.hitTop + h);
      if (!re.hit) { pos[0] = tx; pos[2] = tz; pos[1] = res.hitTop + 0.001; }
    }
  }

  // --- ground snapping
  // Walking *down* a step would otherwise launch the entity into a one-frame
  // fall, which reads as a stutter and breaks the footstep/bob cadence.
  if (wasGrounded && !grounded && vel[1] <= 0 && ent.snapGround !== false) {
    const below = groundAt(world, pos[0], pos[2], pos[1], r * 0.9);
    if (pos[1] - below <= stepHeight && below <= pos[1]) {
      pos[1] = below;
      vel[1] = 0;
      grounded = true;
    }
  }

  // Arena bounds.
  const B = ARENA + 0.6;
  pos[0] = clamp(pos[0], -B, B);
  pos[2] = clamp(pos[2], -B, B);
  ent.grounded = grounded;
  return grounded;
}

/* --------------------------------------------------------------- hitboxes */

export const HITBOX = {
  head: { y: 1.62, r: 0.135, mul: 'head' },
  chest: { y: 1.20, hx: 0.24, hy: 0.30, hz: 0.19, mul: 'body' },
  belly: { y: 0.85, hx: 0.20, hy: 0.20, hz: 0.17, mul: 'body' },
  legs: { y: 0.42, hx: 0.24, hy: 0.42, hz: 0.20, mul: 'limb' },
  arms: { y: 1.24, hx: 0.38, hy: 0.20, hz: 0.15, mul: 'limb' },
};

/**
 * Ray vs a soldier's hitboxes. Returns {t, zone, point} or null.
 * The actor's yaw rotates the boxes so shots from the side are honest.
 */
export function rayHitActor(o, d, actor, maxT) {
  const base = actor.pos;
  const cy = Math.cos(-actor.yaw), sy = Math.sin(-actor.yaw);
  const dx = o[0] - base[0], dz = o[2] - base[2];
  const ox = dx * cy - dz * sy, oz = dx * sy + dz * cy;
  const rx = d[0] * cy - d[2] * sy, rz = d[0] * sy + d[2] * cy;
  const oy = o[1] - base[1], ry = d[1];
  const crouch = actor.crouchAmt || 0;
  const yScale = 1 - crouch * 0.32;

  let best = maxT, zone = null, hitPoint = null;

  // Head as a sphere.
  {
    const hb = HITBOX.head;
    const hy = hb.y * yScale;
    const mx = ox, my = oy - hy, mz = oz;
    const b = mx * rx + my * ry + mz * rz;
    const c = mx * mx + my * my + mz * mz - hb.r * hb.r;
    const disc = b * b - c;
    if (disc >= 0) {
      const t = -b - Math.sqrt(disc);
      if (t > 0.02 && t < best) { best = t; zone = 'head'; }
    }
  }
  // Body/limb boxes.
  for (const key of ['chest', 'belly', 'legs', 'arms']) {
    const hb = HITBOX[key];
    const cyy = hb.y * yScale, hh = hb.hy * yScale;
    const bmin = [-hb.hx, cyy - hh, -hb.hz];
    const bmax = [hb.hx, cyy + hh, hb.hz];
    const oo = [ox, oy, oz], rr = [rx, ry, rz];
    let tmin = 0, tmax = best, miss = false;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(rr[a]) < 1e-8) {
        if (oo[a] < bmin[a] || oo[a] > bmax[a]) { miss = true; break; }
      } else {
        const inv = 1 / rr[a];
        let t1 = (bmin[a] - oo[a]) * inv, t2 = (bmax[a] - oo[a]) * inv;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { miss = true; break; }
      }
    }
    if (!miss && tmin > 0.02 && tmin < best) { best = tmin; zone = key; }
  }
  if (!zone) return null;
  hitPoint = [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best];
  return { t: best, zone, point: hitPoint, mul: HITBOX[zone].mul };
}

/* -------------------------------------------------------------- animation */

const _m = m4();

/** Evaluates the rig and pushes every part into the renderer. */
export function drawSoldier(renderer, parts, actor, teamMat, time) {
  const p = actor.pos;
  const yaw = actor.yaw;
  const anim = actor.anim;
  const crouch = actor.crouchAmt || 0;
  const dead = actor.dead;

  const speed = anim.speed;
  const phase = anim.phase;
  const swing = Math.sin(phase) * Math.min(1, speed / 5.5);
  const swing2 = Math.sin(phase * 2);
  const bob = anim.bob;

  const hipY = (0.92 - crouch * 0.30) + bob + (dead ? anim.deathDrop : 0);
  const lean = dead ? 0 : -Math.min(0.20, speed * 0.022);
  const deathPitch = dead ? anim.deathPitch : 0;
  const deathRoll = dead ? anim.deathRoll : 0;

  // One draw per bone. Team colour rides on the shared material's tint, which
  // multiplies the per-vertex tint baked into the mesh.
  const draw = (list, mx) => {
    for (const part of list) renderer.draw(part.mesh, mx, teamMat.body, true);
  };

  // Pelvis
  M4.compose(_m, p[0], p[1] + hipY, p[2], deathPitch, yaw, deathRoll);
  draw(parts.pelvis, _m);
  const pelvis = m4(); pelvis.set(_m);

  // Torso
  const torsoPitch = lean + deathPitch * 0.35 + Math.sin(time * 1.6) * 0.012;
  const torsoYaw = yaw + swing2 * 0.035 * Math.min(1, speed / 5);
  M4.compose(_m, p[0], p[1] + hipY + 0.06, p[2], torsoPitch, torsoYaw, deathRoll);
  const torso = m4(); torso.set(_m);
  draw(parts.torso, _m);

  const local = (parent, x, y, z, rx, ry, rz, out) => {
    const t = m4();
    M4.compose(t, x, y, z, rx, ry, rz);
    M4.mul(out, parent, t);
    return out;
  };
  const tmp = m4();

  // Head — bots look where they aim.
  const headPitch = clamp(actor.pitch || 0, -0.7, 0.7) * (dead ? 0.2 : 1);
  local(torso, 0, 0.52, 0, headPitch - torsoPitch * 0.6, (actor.headYaw || 0), 0, tmp);
  draw(parts.head, tmp);

  // Arms: when armed, both hands are forward on the weapon.
  const aim = dead ? 0 : (actor.aimAmt === undefined ? 1 : actor.aimAmt);
  for (const side of [-1, 1]) {
    const sx = side * 0.225;
    const armSwing = swing * side * 0.55 * (1 - aim);
    const upPitch = lerp(armSwing, side < 0 ? -1.30 : -1.15, aim);
    const upRoll = lerp(side * 0.10, side < 0 ? 0.34 : -0.18, aim);
    local(torso, sx, 0.40, 0.0, upPitch, 0, upRoll, tmp);
    draw(parts.upperArm, tmp);
    const elbow = m4(); elbow.set(tmp);
    const loPitch = lerp(0.22 + Math.max(0, -armSwing) * 0.5, side < 0 ? 1.05 : 0.62, aim);
    local(elbow, 0, -0.21, 0, loPitch, 0, 0, tmp);
    draw(parts.lowerArm, tmp);
  }

  // Legs
  for (const side of [-1, 1]) {
    const sx = side * 0.105;
    const legSwing = -swing * side * 0.72;
    const crouchBend = crouch * 0.75;
    const thighPitch = dead ? deathPitch * 0.4 + side * 0.12 : legSwing - crouchBend;
    local(pelvis, sx, -0.10, 0, thighPitch, 0, 0, tmp);
    draw(parts.thigh, tmp);
    const knee = m4(); knee.set(tmp);
    const shinBend = dead ? 0.25
      : Math.max(0, -legSwing * 1.1) * 0.9 + crouchBend * 1.6 + 0.06;
    local(knee, 0, -0.28, 0, shinBend, 0, 0, tmp);
    draw(parts.shin, tmp);
  }

  // Team marker on the left shoulder.
  local(torso, -0.245, 0.40, 0.02, 0, 0, 0.25, tmp);
  for (const part of parts.marker) renderer.draw(part.mesh, tmp, teamMat.marker, false);
}

/* ------------------------------------------------------------------- BOTS */

const STATE = { IDLE: 0, ADVANCE: 1, ENGAGE: 2, COVER: 3, DEAD: 4 };
export { STATE };

let botId = 0;

export class Bot {
  constructor(world, team, difficulty = 1) {
    this.world = world;
    this.team = team;
    this.id = ++botId;
    this.pos = v3(0, 0, 0);
    this.vel = v3(0, 0, 0);
    this.radius = 0.36;
    this.height = 1.74;
    this.yaw = 0; this.pitch = 0; this.headYaw = 0;
    this.health = 100; this.maxHealth = 100;
    this.dead = false; this.deadTime = 0;
    this.crouchAmt = 0;
    this.aimAmt = 1;
    this.grounded = true;
    this.state = STATE.ADVANCE;
    this.target = null;
    this.path = null; this.pathIdx = 0; this.repathTimer = 0;
    this.fireTimer = 0; this.burst = 0; this.burstPause = 0;
    this.reloadTimer = 0; this.ammo = 30;
    this.reactionTimer = 0;
    this.aimError = v3(0, 0, 0);
    this.aimSettle = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 0;
    this.goal = null;
    this.difficulty = difficulty;
    this.anim = { speed: 0, phase: Math.random() * 6.28, bob: 0, deathPitch: 0, deathRoll: 0, deathDrop: 0 };
    this.name = BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0];
    this.lastSeen = null;
    this.muzzleFlashT = 0;
    this.stepTimer = 0;
    this.weapon = null;
    this.spawnProtect = 0;
  }

  spawn(spawnPoint) {
    V3.set(this.pos, spawnPoint.x, 0, spawnPoint.z);
    V3.set(this.vel, 0, 0, 0);
    this.yaw = spawnPoint.yaw;
    this.health = this.maxHealth;
    this.dead = false; this.deadTime = 0;
    this.state = STATE.ADVANCE;
    this.ammo = 30;
    this.reloadTimer = 0;
    this.path = null;
    this.goal = null;
    this.anim.deathPitch = 0; this.anim.deathRoll = 0; this.anim.deathDrop = 0;
    this.spawnProtect = 1.2;
  }

  eyePos(out) {
    out[0] = this.pos[0];
    out[1] = this.pos[1] + 1.58 - this.crouchAmt * 0.5;
    out[2] = this.pos[2];
    return out;
  }
}

const BOT_NAMES = [
  'RVN-01', 'HAVOC', 'KESTREL', 'SPECTRE', 'IRONSIDE', 'NOMAD', 'VULTURE',
  'BRAVO-6', 'WRAITH', 'TALON', 'GHOSTLINE', 'MERIDIAN', 'ZULU-9', 'HALFTRACK',
  'ROGUE-4', 'SANDSTORM', 'ECHO-7', 'BLACKOUT', 'HOLLOW', 'CINDER',
];

/* ----------------------------------------------------------- A* on the grid */

export class NavAgent {
  constructor(world) {
    this.world = world;
    const N = world.nav.N;
    this.g = new Float32Array(N * N);
    this.f = new Float32Array(N * N);
    this.from = new Int32Array(N * N);
    this.open = new Int32Array(N * N);
    this.state = new Uint8Array(N * N);
    this.stamp = new Int32Array(N * N);
    this.gen = 0;
  }

  find(sx, sz, gx, gz) {
    const w = this.world, nav = w.nav, N = nav.N;
    const s = w.navIndex(sx, sz), g = w.navIndex(gx, gz);
    if (!nav.walk[g.idx]) {
      // Snap the goal to the nearest walkable cell.
      let best = -1, bd = 1e9;
      for (let j = Math.max(0, g.j - 4); j < Math.min(N, g.j + 5); j++) {
        for (let i = Math.max(0, g.i - 4); i < Math.min(N, g.i + 5); i++) {
          const idx = j * N + i;
          if (!nav.walk[idx]) continue;
          const d = (i - g.i) ** 2 + (j - g.j) ** 2;
          if (d < bd) { bd = d; best = idx; }
        }
      }
      if (best < 0) return null;
      g.idx = best; g.i = best % N; g.j = (best / N) | 0;
    }
    this.gen++;
    const gen = this.gen;
    const { g: G, f: F, from, open, state, stamp } = this;
    let openN = 0;
    const H = (i, j) => Math.abs(i - g.i) + Math.abs(j - g.j);

    G[s.idx] = 0; F[s.idx] = H(s.i, s.j); from[s.idx] = -1;
    stamp[s.idx] = gen; state[s.idx] = 1;
    open[openN++] = s.idx;

    let guard = 0;
    while (openN > 0 && guard++ < 9000) {
      // Linear scan for the lowest f — fine at this grid size.
      let bi = 0;
      for (let i = 1; i < openN; i++) if (F[open[i]] < F[open[bi]]) bi = i;
      const cur = open[bi];
      open[bi] = open[--openN];
      if (cur === g.idx) {
        const out = [];
        let n = cur;
        while (n !== -1) {
          out.push([-ARENA + ((n % N) + 0.5) * nav.S, -ARENA + (((n / N) | 0) + 0.5) * nav.S]);
          n = from[n];
        }
        out.reverse();
        return out;
      }
      state[cur] = 2;
      const ci = cur % N, cj = (cur / N) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
          const nidx = nj * N + ni;
          if (!nav.walk[nidx]) continue;
          if (di && dj && (!nav.walk[cj * N + ni] || !nav.walk[nj * N + ci])) continue;
          if (stamp[nidx] === gen && state[nidx] === 2) continue;
          // Step height gate keeps bots off ledges they can't climb.
          if (Math.abs(nav.height[nidx] - nav.height[cur]) > 0.5) continue;
          const cost = (di && dj ? 1.414 : 1) * (nav.walk[nidx] === 2 ? 2.3 : 1);
          const ng = G[cur] + cost;
          if (stamp[nidx] !== gen) {
            stamp[nidx] = gen; state[nidx] = 1;
            G[nidx] = ng; F[nidx] = ng + H(ni, nj); from[nidx] = cur;
            open[openN++] = nidx;
          } else if (ng < G[nidx]) {
            G[nidx] = ng; F[nidx] = ng + H(ni, nj); from[nidx] = cur;
            if (state[nidx] !== 1) { state[nidx] = 1; open[openN++] = nidx; }
          }
        }
      }
    }
    return null;
  }
}
