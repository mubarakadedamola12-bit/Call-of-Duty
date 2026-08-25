// Character model, movement/collision, and bot AI.

import { M4, V3, m4, v3, clamp, lerp, damp, rand, smoothstep } from '../core/math.js';
import { poseSoldier, hipHeight } from './soldier.js';
import { ARENA } from './world.js';

/* --------------------------------------------------------- soldier model */

/* --------------------------------------------------------------- actors */
// The soldier mesh and rig live in soldier.js; this module keeps movement,
// hitboxes and AI. drawSoldier() below just evaluates a pose and submits.

/**
 * Evaluates an actor's rig and submits it as a single skinned draw.
 * @param rig { mesh, skeleton, pose } per team
 */
export function drawSoldier(renderer, rig, actor, teamMat, time) {
  const p = actor.pos;
  const anim = actor.anim;
  const dead = !!actor.dead;
  const crouch = actor.crouchAmt || 0;

  poseSoldier(rig.pose, {
    speed: anim.speed,
    phase: anim.phase,
    aim: dead ? 0 : (actor.aimAmt === undefined ? 1 : actor.aimAmt),
    crouch,
    pitch: dead ? 0 : (actor.pitch || 0),
    headYaw: actor.headYaw || 0,
    dead,
    time,
  });

  const y = p[1] + hipHeight(crouch, dead) + (dead ? anim.deathDrop : anim.bob);
  const palette = rig.skeleton.evaluate(
    rig.pose, p[0], y, p[2], actor.yaw,
    dead ? anim.deathPitch : 0, dead ? anim.deathRoll : 0,
  );
  renderer.drawSkinned(rig.mesh, IDENTITY4, palette, teamMat.body, true);
}

const IDENTITY4 = m4();

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
    this.name = nextBotName();
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

/**
 * Callsigns are drawn without replacement from a shuffled pool — picking at
 * random put two HOLLOWs on the same squad, which reads as a bug in a roster.
 */
let namePool = [];
export function resetBotNames() { namePool = []; }
function nextBotName() {
  if (!namePool.length) {
    namePool = BOT_NAMES.slice();
    for (let i = namePool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [namePool[i], namePool[j]] = [namePool[j], namePool[i]];
    }
  }
  return namePool.pop();
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
