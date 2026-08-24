// Match logic: player controller, ballistics, bot AI, killstreaks, scoring.

import { M4, V3, m4, v3, clamp, lerp, damp, smoothstep, rand, TAU } from '../core/math.js';
import { World, ARENA } from './world.js';
import { FX } from './fx.js';
import { buildAllWeapons, recoilStep, GRENADE } from './weapons.js';
import { Viewmodel, buildHands } from './viewmodel.js';
import {
  buildSoldier, drawSoldier, moveEntity, rayHitActor, groundAt, collideXZ,
  Bot, NavAgent, STATE,
} from './actors.js';
import { defaultMaterial } from '../render/renderer.js';
import { MAT } from '../render/textures.js';

const EYE_STAND = 1.63, EYE_CROUCH = 1.08;
const GRAVITY = -19.5;

/**
 * Movement tuning. The acceleration model is deliberately Quake-lineage
 * (friction + accelerate-toward-wish-direction) rather than a simple lerp:
 * it gives a crisp stop, honest momentum, and air-strafing that rewards input,
 * which is what "boots on the ground" shooter movement is built on.
 */
const MOVE = {
  walk: 4.40, sprint: 6.60, tac: 8.15, crouch: 2.30, ads: 2.55,

  // Committing to a direction is faster than backpedalling.
  strafeMul: 0.88, backMul: 0.76,

  groundAccel: 14.0,   // 1/s, multiplied by wish speed
  airAccel: 2.8,       // enough to steer and air-strafe, not to fly
  friction: 10.5,      // 1/s
  stopSpeed: 1.70,     // floor so the last bit of speed still bleeds off

  jumpVel: 6.35,
  coyote: 0.12,        // grace period after walking off a ledge
  jumpBuffer: 0.16,    // grace period for pressing jump slightly early
  terminal: 32,

  slideSpeed: 9.70,
  slideMin: 5.20,      // you must actually be moving to slide
  slideSteer: 3.20,
  slideFriction: 2.35,
  slideCooldown: 0.50,

  mantleMax: 1.60,     // tallest ledge you can pull yourself onto
  mantleTime: 0.46,

  tacMax: 4.20,        // seconds of tactical sprint
  sprintOut: 0.15,     // delay from dropping sprint to being able to fire
};

/**
 * Difficulty presets. `healthScale` lengthens time-to-kill for *everyone*, so
 * firefights stop being decided in a quarter of a second; `damageTaken` is the
 * extra allowance the player gets on top; `botSkill` drives enemy reaction
 * time and aim convergence.
 */
export const DIFFICULTY = {
  recruit: { name: 'RECRUIT', healthScale: 1.9, damageTaken: 0.55, botSkill: 0.42, regen: 2.4, regenRate: 55 },
  regular: { name: 'REGULAR', healthScale: 1.5, damageTaken: 0.78, botSkill: 0.62, regen: 3.1, regenRate: 48 },
  hardened: { name: 'HARDENED', healthScale: 1.2, damageTaken: 1.0, botSkill: 0.84, regen: 4.0, regenRate: 42 },
  veteran: { name: 'VETERAN', healthScale: 1.0, damageTaken: 1.15, botSkill: 1.0, regen: 5.0, regenRate: 36 },
};

export const STREAKS = [
  { at: 3, name: 'UAV', key: '[4]', id: 'uav' },
  { at: 5, name: 'AIRSTRIKE', key: '[5]', id: 'strike' },
];

export class Game {
  constructor(gl, renderer, audio, input, hud, difficulty = 'regular') {
    this.diff = { ...(DIFFICULTY[difficulty] || DIFFICULTY.regular) };
    this.difficultyKey = DIFFICULTY[difficulty] ? difficulty : 'regular';
    this.gl = gl; this.renderer = renderer; this.audio = audio;
    this.input = input; this.hud = hud;

    this.world = new World();
    this.worldMeshes = this.world.upload(gl);
    this.fx = new FX(this.world);
    this.weapons = buildAllWeapons(gl);
    // One baked rig per team — see buildSoldier().
    this.soldiers = [
      buildSoldier(gl, [0.72, 0.86, 1.25]),
      buildSoldier(gl, [1.30, 0.86, 0.70]),
    ];
    this.vm = new Viewmodel(buildHands(gl));
    this.nav = new NavAgent(this.world);

    // The rig itself carries its materials per-vertex; these only supply the
    // shading constants and the emissive team marker.
    const bodyMat = () => this._mat({ uvScale: [1, 1], rough: 1, metal: 1 });
    this.teamMat = [
      { body: bodyMat(),
        marker: this._mat({ layer: MAT.GUNMETAL, uvScale: [1, 1], tint: [0.1, 0.1, 0.1], emissive: [0.25, 1.4, 3.4] }) },
      { body: bodyMat(),
        marker: this._mat({ layer: MAT.GUNMETAL, uvScale: [1, 1], tint: [0.1, 0.1, 0.1], emissive: [3.6, 0.35, 0.18] }) },
    ];

    // ---- player
    this.player = {
      pos: v3(0, 0, 0), vel: v3(0, 0, 0), radius: 0.34, height: 1.72,
      yaw: 0, pitch: 0, grounded: true, crouchAmt: 0, dead: false,
      health: 100 * this.diff.healthScale, maxHealth: 100 * this.diff.healthScale, regenDelay: 0,
      anim: { speed: 0, phase: 0, bob: 0, deathPitch: 0, deathRoll: 0, deathDrop: 0 },
      team: 0, name: 'YOU', isPlayer: true,
    };
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.aimPunchP = 0; this.aimPunchY = 0;
    this.viewRoll = 0; this.viewBobY = 0; this.viewBobX = 0;
    this.bobPhase = 0;
    this.slide = 0; this.slideDir = v3(0, 0, 0); this.slideTimer = 0;
    this.sprinting = false; this.tacSprint = false; this.lastSprintTap = -9;
    this.crouching = false;
    this.stepTimer = 0;
    this.coyote = 0; this.jumpBuffer = 0;
    this.slideCooldown = 0;
    this.tacFuel = MOVE.tacMax;
    this.sprintOut = 0;
    this.crouchHold = 0;
    this.mantle = null;
    this.moveInput = false;
    // Aim assist. 0 disables it entirely (the desktop default); touch turns it
    // on, because a thumb cannot track a strafing target the way a mouse can.
    this.aimAssist = 0;
    this.assistSlow = 1;
    this.assistTarget = null;
    this.touch = null;
    this.adsSensMul = 0.85;   // extra look scaling while aiming
    this.motionBlur = 1;      // 0 disables the sprint / ADS blur entirely

    this.loadout = ['kilo', 'pistol'];
    this.slot = 0;
    this.ammo = {}; this.reserve = {};
    for (const id of Object.keys(this.weapons)) {
      const w = this.weapons[id];
      if (!w.mag) continue;
      this.ammo[id] = w.mag; this.reserve[id] = w.reserve;
    }
    this.grenades = 2;
    this.fireTimer = 0; this.shotIndex = 0; this.sinceFire = 9;
    this.reloadTimer = -1; this.reloadPending = 0;
    this.switchTimer = -1; this.pendingSlot = -1;
    this.boltTimer = 0;
    this.adsHeld = false; this.adsAmt = 0;
    this.throwTimer = -1;

    this.projectiles = [];
    this.airstrikes = [];

    // ---- match
    this.scoreLimit = 75;
    this.timeLimit = 600;
    this.timeLeft = this.timeLimit;
    this.score = [0, 0];
    this.kills = 0; this.deaths = 0; this.streak = 0; this.bestStreak = 0; this.xp = 0;
    this.streakEarned = {};
    this.uavTime = 0;
    this.respawnIn = 0; this.respawnTotal = 4.0;
    this.killerName = '';
    this.matchOver = false;
    this.spawnProtect = 0;

    // Squad size scales with the render tier — mobile runs fewer actors.
    const total = clamp(renderer.q ? renderer.q.bots : 9, 4, 12);
    const allies = Math.floor(total / 2);
    const sk = this.diff.botSkill;
    this.bots = [];
    for (let i = 0; i < allies; i++) this.bots.push(new Bot(this.world, 0, clamp((0.72 + i * 0.05) * sk, 0.1, 1)));
    for (let i = 0; i < total - allies; i++) this.bots.push(new Bot(this.world, 1, clamp((0.80 + i * 0.05) * sk, 0.1, 1)));
    for (const b of this.bots) {
      b.baseSkill = b.difficulty / sk;
      b.maxHealth = 100 * this.diff.healthScale;
      b.health = b.maxHealth;
    }

    this.time = 0;
    this.camWorld = m4();
    this.view = m4();
    this._eye = v3();
    this._dir = v3();
    this._tmp = v3();
    this._muzzleOut = {};
    this.fovBase = 80;
    this.fov = 80;
    this.hitSounds = 0;

    this.respawnPlayer(true);
    for (const b of this.bots) this.respawnBot(b, true);
  }

  _mat(o) { const m = defaultMaterial(); Object.assign(m, o); return m; }

  get weapon() { return this.weapons[this.loadout[this.slot]]; }
  get weaponId() { return this.loadout[this.slot]; }

  /** Swaps difficulty mid-match, rescaling everyone's health proportionally. */
  applyDifficulty(key) {
    const d = DIFFICULTY[key];
    if (!d) return;
    const k = d.healthScale / this.diff.healthScale;
    this.diff = { ...d };
    this.difficultyKey = key;
    const rescale = (a) => {
      a.maxHealth *= k;
      a.health = Math.min(a.maxHealth, a.health * k);
    };
    rescale(this.player);
    for (const b of this.bots) {
      rescale(b);
      b.difficulty = clamp((b.baseSkill || 0.8) * d.botSkill, 0.1, 1);
    }
  }

  /* ------------------------------------------------------------- spawning */

  pickSpawn(team, avoidEnemies = true) {
    const list = this.world.spawns[team];
    let best = null, bestScore = -1e9;
    for (const sp of list) {
      let score = rand(0, 3);
      if (avoidEnemies) {
        for (const b of this.bots) {
          if (b.dead || b.team === team) continue;
          const d = Math.hypot(b.pos[0] - sp.x, b.pos[2] - sp.z);
          score += Math.min(d, 30);
        }
        if (team !== this.player.team && !this.player.dead) {
          score += Math.min(Math.hypot(this.player.pos[0] - sp.x, this.player.pos[2] - sp.z), 30);
        }
      }
      if (score > bestScore) { bestScore = score; best = sp; }
    }
    return best;
  }

  respawnPlayer(initial = false) {
    const sp = this.pickSpawn(this.player.team, !initial);
    V3.set(this.player.pos, sp.x, 0, sp.z);
    V3.set(this.player.vel, 0, 0, 0);
    this.player.yaw = sp.yaw; this.player.pitch = 0;
    this.player.health = this.player.maxHealth;
    this.player.dead = false;
    this.recoilPitch = this.recoilYaw = 0;
    this.slide = 0; this.slideTimer = 0; this.slideCooldown = 0;
    this.mantle = null; this.coyote = 0; this.jumpBuffer = 0;
    this.tacFuel = MOVE.tacMax; this.sprintOut = 0;
    this.sprinting = false; this.tacSprint = false; this.crouching = false;
    this.reloadTimer = -1;
    this.spawnProtect = 1.5;
    this.renderer.flash = 0.55;
    const w = this.weapon;
    this.ammo[this.weaponId] = w.mag;
    this.vm.startSwitch(0.6);
  }

  respawnBot(b, initial = false) {
    b.spawn(this.pickSpawn(b.team, !initial));
    b.weapon = this.weapons[b.team === 1
      ? (Math.random() < 0.55 ? 'kilo' : (Math.random() < 0.6 ? 'vector' : 'sniper'))
      : (Math.random() < 0.6 ? 'kilo' : 'vector')];
    b.ammo = b.weapon.mag;
  }

  /* -------------------------------------------------------------- camera */

  buildCamera() {
    const p = this.player;
    const eye = this._eye;
    const crouch = p.crouchAmt;
    const slideDip = this.slide * 0.34;
    eye[0] = p.pos[0] + this.viewBobX;
    eye[1] = p.pos[1] + lerp(EYE_STAND, EYE_CROUCH, crouch) - slideDip + this.viewBobY;
    eye[2] = p.pos[2];

    const yaw = p.yaw + this.recoilYaw + this.aimPunchY;
    const pitch = clamp(p.pitch + this.recoilPitch + this.aimPunchP, -1.52, 1.52);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const f = this._dir;
    f[0] = -Math.sin(yaw) * cp; f[1] = sp; f[2] = -Math.cos(yaw) * cp;

    let rx = Math.cos(yaw), ry = 0, rz = -Math.sin(yaw);
    let ux = ry * f[2] - rz * f[1], uy = rz * f[0] - rx * f[2], uz = rx * f[1] - ry * f[0];
    ux = -ux; uy = -uy; uz = -uz;
    // Recompute up as cross(right, forward) with the right sign.
    ux = ry * f[2] - rz * f[1]; uy = rz * f[0] - rx * f[2]; uz = rx * f[1] - ry * f[0];
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    if (uy < 0) { ux = -ux; uy = -uy; uz = -uz; }

    const roll = this.viewRoll;
    if (roll !== 0) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const nrx = rx * c + ux * s, nry = ry * c + uy * s, nrz = rz * c + uz * s;
      const nux = ux * c - rx * s, nuy = uy * c - ry * s, nuz = uz * c - rz * s;
      rx = nrx; ry = nry; rz = nrz; ux = nux; uy = nuy; uz = nuz;
    }

    const v = this.view;
    v[0] = rx; v[4] = ry; v[8] = rz; v[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
    v[1] = ux; v[5] = uy; v[9] = uz; v[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    v[2] = -f[0]; v[6] = -f[1]; v[10] = -f[2]; v[14] = (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]);
    v[3] = 0; v[7] = 0; v[11] = 0; v[15] = 1;

    const cw = this.camWorld;
    cw[0] = rx; cw[1] = ry; cw[2] = rz; cw[3] = 0;
    cw[4] = ux; cw[5] = uy; cw[6] = uz; cw[7] = 0;
    cw[8] = -f[0]; cw[9] = -f[1]; cw[10] = -f[2]; cw[11] = 0;
    cw[12] = eye[0]; cw[13] = eye[1]; cw[14] = eye[2]; cw[15] = 1;
    return { eye, dir: f, right: [rx, ry, rz] };
  }

  /**
   * Two-part aim assist, the way console shooters do it:
   *  - *slowdown* scales look sensitivity down while the reticle is on a target,
   *    so it is easy to stop on them;
   *  - *magnetism* nudges the view toward the target while firing or aiming.
   * Both are proportional to how centred the target already is, so it never
   * takes the shot for you — it only makes a thumb competitive with a mouse.
   */
  updateAimAssist(dt) {
    if (this.aimAssist <= 0) { this.assistSlow = 1; this.assistTarget = null; return; }
    const p = this.player;
    const cp = Math.cos(p.pitch + this.recoilPitch), sp = Math.sin(p.pitch + this.recoilPitch);
    const yw = p.yaw + this.recoilYaw;
    const dirX = -Math.sin(yw) * cp, dirY = sp, dirZ = -Math.cos(yw) * cp;
    const ex = p.pos[0], ey = p.pos[1] + lerp(EYE_STAND, EYE_CROUCH, p.crouchAmt), ez = p.pos[2];

    const cone = Math.cos(0.115);           // ~6.6 degrees
    let best = null, bestDot = cone;
    for (const b of this.bots) {
      if (b.dead || b.team === p.team) continue;
      const tx = b.pos[0], ty = b.pos[1] + 1.22 - b.crouchAmt * 0.4, tz = b.pos[2];
      const dx = tx - ex, dy = ty - ey, dz = tz - ez;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.6 || d > 60) continue;
      const dot = (dx * dirX + dy * dirY + dz * dirZ) / d;
      if (dot <= bestDot) continue;
      if (!this.world.visible([ex, ey, ez], [tx, ty, tz])) continue;
      bestDot = dot; best = { b, tx, ty, tz, d };
    }
    this.assistTarget = best;

    if (!best) {
      this.assistSlow = damp(this.assistSlow, 1, 9, dt);
      return;
    }
    // How centred: 0 at the edge of the cone, 1 dead on.
    const centred = clamp((bestDot - cone) / (1 - cone), 0, 1);
    const slowMin = lerp(1, 0.40, this.aimAssist);
    this.assistSlow = damp(this.assistSlow, lerp(1, slowMin, Math.sqrt(centred)), 9, dt);

    // Magnetism only when the player is actually committing to the shot.
    const firing = this.input.buttons[0] ? 1 : 0;
    const engage = clamp(firing * 0.85 + this.adsAmt * 0.60, 0, 1);
    if (engage <= 0.01) return;

    const wantYaw = Math.atan2(-(best.tx - ex), -(best.tz - ez));
    let dyaw = wantYaw - p.yaw;
    while (dyaw > Math.PI) dyaw -= TAU;
    while (dyaw < -Math.PI) dyaw += TAU;
    const horiz = Math.hypot(best.tx - ex, best.tz - ez);
    let dpitch = Math.atan2(best.ty - ey, horiz) - p.pitch;

    const rate = 6.0 * this.aimAssist * engage * (0.35 + centred * 0.65);
    const k = 1 - Math.exp(-rate * dt);
    p.yaw += clamp(dyaw, -0.5, 0.5) * k;
    p.pitch = clamp(p.pitch + clamp(dpitch, -0.5, 0.5) * k, -1.50, 1.50);
  }

  /* ------------------------------------------------------------ ballistics */

  /** Nearest actor hit along a ray; ignores `self`. */
  traceActors(o, d, maxT, self, team) {
    let best = null, bestT = maxT;
    const check = (a) => {
      if (a === self || a.dead) return;
      if (a.team === team) return;
      const dx = a.pos[0] - o[0], dz = a.pos[2] - o[2];
      if (dx * dx + dz * dz > (bestT + 2) * (bestT + 2)) return;
      const h = rayHitActor(o, d, a, bestT);
      if (h) { best = { ...h, actor: a }; bestT = h.t; }
    };
    check(this.player);
    for (const b of this.bots) check(b);
    return best;
  }

  slabExit(c, o, d) {
    const dx = o[0] - c.c[0], dz = o[2] - c.c[2];
    const oo = [dx * c.cos + dz * c.sin, o[1] - c.c[1], -dx * c.sin + dz * c.cos];
    const rr = [d[0] * c.cos + d[2] * c.sin, d[1], -d[0] * c.sin + d[2] * c.cos];
    let tmax = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(rr[a]) < 1e-8) continue;
      const inv = 1 / rr[a];
      let t1 = (-c.h[a] - oo[a]) * inv, t2 = (c.h[a] - oo[a]) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t2 < tmax) tmax = t2;
    }
    return tmax;
  }

  /**
   * One bullet. Handles actor hits, world impacts and a single wall
   * penetration when the weapon supports it.
   */
  fireRay(o, d, w, shooter, team, damageScale = 1, depth = 0) {
    const maxRange = 200;
    const worldHit = this.world.raycast(o, d, maxRange);
    const actorHit = this.traceActors(o, d, worldHit ? worldHit.t : maxRange, shooter, team);

    if (actorHit) {
      const dist = actorHit.t;
      const fall = 1 - smoothstep(w.falloffStart, w.falloffEnd, dist);
      const rangeMul = lerp(w.falloffMin, 1, fall);
      const zoneMul = actorHit.mul === 'head' ? w.headMul : actorHit.mul === 'limb' ? w.limbMul : 1;
      const dmg = w.damage * rangeMul * zoneMul * damageScale;
      const p = actorHit.point;
      this.fx.bloodImpact(p[0], p[1], p[2], d[0], d[1], d[2], actorHit.mul === 'head' ? 1.4 : 1);
      this.damageActor(actorHit.actor, dmg, shooter, w, actorHit.mul === 'head', o);
      return { dist, actor: actorHit.actor, head: actorHit.mul === 'head' };
    }

    if (worldHit) {
      const p = [o[0] + d[0] * worldHit.t, o[1] + d[1] * worldHit.t, o[2] + d[2] * worldHit.t];
      this.fx.impact(p[0], p[1], p[2], worldHit.nx, worldHit.ny, worldHit.nz, worldHit.kind, 1);
      const pan = this._panFor(p[0], p[2]);
      this.audio.impact(worldHit.kind === 'metal' ? 'metal' : 'hard', pan, V3.dist(this._eye, p));

      // Wallbang: one penetration, reduced damage.
      if (depth === 0 && w.penetration > 0 && worldHit.collider) {
        const exit = this.slabExit(worldHit.collider, o, d);
        const thickness = exit - worldHit.t;
        if (thickness > 0 && thickness < w.penetration * 1.6) {
          const no = [o[0] + d[0] * (exit + 0.02), o[1] + d[1] * (exit + 0.02), o[2] + d[2] * (exit + 0.02)];
          this.fx.impact(no[0], no[1], no[2], -worldHit.nx, -worldHit.ny, -worldHit.nz, worldHit.kind, 0.7);
          return this.fireRay(no, d, w, shooter, team, damageScale * 0.55, 1);
        }
      }
      return { dist: worldHit.t };
    }
    return { dist: maxRange };
  }

  _panFor(x, z) {
    const p = this.player.pos;
    const dx = x - p[0], dz = z - p[2];
    const yaw = this.player.yaw;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const d = Math.hypot(dx, dz) || 1;
    return clamp((dx * rx + dz * rz) / d, -1, 1) * 0.85;
  }

  damageActor(a, dmg, shooter, weapon, headshot, from) {
    if (a.dead) return;
    if (a.isPlayer && this.spawnProtect > 0) return;
    if (!a.isPlayer && a.spawnProtect > 0) return;

    // The player's allowance is applied before the hit lands, not unwound after.
    if (a.isPlayer) dmg *= this.diff.damageTaken;
    a.health -= dmg;

    if (a.isPlayer) {
      this.player.regenDelay = this.diff.regen;
      this.renderer.damage = Math.min(1, this.renderer.damage + dmg / (90 * this.diff.healthScale));
      this.aimPunchP += rand(-0.02, 0.03);
      this.aimPunchY += rand(-0.025, 0.025);
      if (from) this.hud.addDamageDir(Math.atan2(-(from[0] - a.pos[0]), -(from[2] - a.pos[2])));
      this.audio.impact('flesh', 0, 0);
    } else if (shooter === this.player) {
      this.hud.hit(a.health <= 0, headshot);
      this.audio.hitmarker(headshot);
    }

    if (a.health <= 0) {
      a.health = 0;
      this.onKill(a, shooter, weapon, headshot);
    }
  }

  onKill(victim, killer, weapon, headshot) {
    victim.dead = true;
    victim.deadTime = 0;
    if (victim.anim) {
      victim.anim.deathPitch = rand(-0.4, 0.4);
      victim.anim.deathRoll = rand(-1.4, 1.4);
      victim.anim.deathDrop = 0;
    }
    const kName = killer === this.player ? 'YOU' : (killer ? killer.name : 'WORLD');
    const vName = victim.isPlayer ? 'YOU' : victim.name;
    const kTeam = killer ? killer.team : (victim.team ^ 1);
    this.score[kTeam]++;
    this.hud.addKill(kName, vName, weapon ? weapon.name : 'FRAG', killer === this.player || victim.isPlayer, headshot);

    if (killer === this.player) {
      this.kills++; this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      const pts = headshot ? 150 : 100;
      this.xp += pts;
      this.hud.addPopup('+' + pts, headshot ? 'HEADSHOT · ELIMINATED ' + vName : 'ELIMINATED ' + vName,
        headshot ? '#ffd54a' : '#ffc233');
      this.audio.killConfirm();
      this.checkStreaks();
    }
    if (victim.isPlayer) {
      this.deaths++; this.streak = 0; this.streakEarned = {};
      this.killerName = kName;
      this.respawnIn = this.respawnTotal;
      this.audio.deathSting();
      this.renderer.flash = 0;
    }
    if (this.score[0] >= this.scoreLimit || this.score[1] >= this.scoreLimit) this.endMatch();
  }

  checkStreaks() {
    for (const s of STREAKS) {
      if (this.streak >= s.at && !this.streakEarned[s.id]) {
        this.streakEarned[s.id] = true;
        this.hud.showBanner(s.name + ' READY', 'PRESS ' + s.key.replace(/[\[\]]/g, '') + ' TO DEPLOY', 2.4);
        this.audio.levelUp();
      }
    }
  }

  endMatch() {
    if (this.matchOver) return;
    this.matchOver = true;
    const won = this.score[0] > this.score[1];
    this.hud.showBanner(won ? 'VICTORY' : (this.score[0] === this.score[1] ? 'DRAW' : 'DEFEAT'),
      `${this.score[0]} — ${this.score[1]}   ·   ${this.kills} KILLS / ${this.deaths} DEATHS`, 9.0);
    if (won) this.audio.levelUp(); else this.audio.deathSting();
  }

  /* --------------------------------------------------------- player input */

  updatePlayer(dt) {
    const inp = this.input, p = this.player;

    // --- look
    if (inp.active && !p.dead) {
      // Scale look with the optical zoom so aiming tracks at the same angular
      // rate, blended over the transition rather than snapping at the midpoint.
      const optical = lerp(1, this.weapon.adsFov, 0.85) * this.adsSensMul;
      const zoom = lerp(1, optical, smoothstep(0, 1, this.adsAmt));
      // Aim-assist "slowdown": the reticle drags as it crosses a target.
      const sens = inp.sensitivity * zoom * this.assistSlow;
      p.yaw -= inp.mouse.dx * sens;
      p.pitch -= inp.mouse.dy * sens * (inp.invertY ? -1 : 1);
      p.pitch = clamp(p.pitch, -1.50, 1.50);
      p.yaw = ((p.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
    }
    this.lookDX = inp.mouse.dx; this.lookDY = inp.mouse.dy;
    if (!p.dead) this.updateAimAssist(dt);

    // Recoil recovers toward zero; countering with the mouse just works.
    const rec = this.weapon.recoil;
    this.recoilPitch = damp(this.recoilPitch, 0, rec.recover, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, rec.recover * 0.8, dt);
    this.aimPunchP = damp(this.aimPunchP, 0, 7, dt);
    this.aimPunchY = damp(this.aimPunchY, 0, 7, dt);

    if (p.dead) {
      this.respawnIn -= dt;
      p.anim.deathDrop = damp(p.anim.deathDrop, -0.75, 6, dt);
      if (this.respawnIn <= 0 && !this.matchOver) this.respawnPlayer();
      return;
    }

    /* ------------------------------------------------------------ movement */

    // Input axes. WASD and the arrow cluster are fully equivalent, so the
    // game is playable with either hand on the keyboard.
    const held = (a, b) => inp.down(a) || inp.down(b);
    const tapped = (...codes) => codes.some((c) => inp.hit(c));
    let ix = 0, iz = 0;
    if (held('KeyW', 'ArrowUp')) iz += 1;
    if (held('KeyS', 'ArrowDown')) iz -= 1;
    if (held('KeyA', 'ArrowLeft')) ix -= 1;
    if (held('KeyD', 'ArrowRight')) ix += 1;
    // Analog stick (touch) adds in, so partial deflection walks.
    ix += inp.axis.x; iz += inp.axis.y;
    let il = Math.hypot(ix, iz);
    // Clamp to the unit circle rather than normalising: digital diagonals lose
    // their speed bonus, but an analog half-push still means half speed.
    if (il > 1) { ix /= il; iz /= il; il = 1; }
    const hasInput = il > 0.04;
    this.moveInput = hasInput;

    const yaw = p.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let wishX = fx * iz + rx * ix, wishZ = fz * iz + rz * ix;
    const wl = Math.hypot(wishX, wishZ);
    if (wl > 1e-4) { wishX /= wl; wishZ /= wl; }   // unit direction; il is the magnitude

    // ---- mantle: a scripted pull-up that owns movement while it runs
    if (this.mantle) {
      const m = this.mantle;
      m.t += dt;
      const k = clamp(m.t / m.dur, 0, 1);
      // Rise first, then move forward — reads like hauling yourself over a lip.
      const up = smoothstep(0, 0.60, k);
      const fwd = smoothstep(0.26, 1, k);
      p.pos[0] = lerp(m.from[0], m.to[0], fwd);
      p.pos[1] = lerp(m.from[1], m.to[1], up);
      p.pos[2] = lerp(m.from[2], m.to[2], fwd);
      V3.set(p.vel, 0, 0, 0);
      p.grounded = false;
      this.viewRoll = damp(this.viewRoll, 0.075, 9, dt);
      this.viewBobY = damp(this.viewBobY, -0.05 * Math.sin(k * Math.PI), 12, dt);
      if (k >= 1) {
        this.mantle = null;
        p.grounded = true;
        this.audio.footstep(1.0, 0);
      }
      this.updateWeapon(dt);
      return;
    }

    // ---- stance: tap to toggle crouch, or hold it down
    const crouchDown = inp.down('ControlLeft') || inp.down('ControlRight') || inp.down('KeyC');
    const crouchTap = tapped('ControlLeft', 'ControlRight', 'KeyC');
    if (crouchTap) { this.crouching = !this.crouching; this.crouchHold = 0; }
    if (crouchDown) this.crouchHold += dt;
    else {
      if (this.crouchHold > 0.28) this.crouching = false;   // it was a hold
      this.crouchHold = 0;
    }

    // ---- sprint
    const wantAds = inp.buttons[2];
    const firing = inp.buttons[0];
    const sprintKey = inp.down('ShiftLeft') || inp.down('ShiftRight');
    if (tapped('ShiftLeft', 'ShiftRight')) {
      if (this.time - this.lastSprintTap < 0.32 && this.tacFuel > 0.8) this.tacSprint = true;
      this.lastSprintTap = this.time;
    }
    const forwardish = iz > 0.25 && il > 0.6;
    this.sprinting = sprintKey && forwardish && !wantAds && !firing
      && p.grounded && this.slideTimer <= 0 && this.throwTimer < 0;
    if (!this.sprinting) this.tacSprint = false;

    // Tactical sprint runs off a small reserve that refills when you ease off.
    if (this.tacSprint) {
      this.tacFuel -= dt;
      if (this.tacFuel <= 0) { this.tacFuel = 0; this.tacSprint = false; }
    } else {
      this.tacFuel = Math.min(MOVE.tacMax, this.tacFuel + dt * (this.sprinting ? 0.35 : 1.1));
    }
    if (this.sprinting) { this.crouching = false; this.sprintOut = MOVE.sprintOut; }
    else if (this.sprintOut > 0) this.sprintOut -= dt;

    // ---- slide
    const speedNow = Math.hypot(p.vel[0], p.vel[2]);
    if (this.slideCooldown > 0) this.slideCooldown -= dt;
    if (this.sprinting && crouchTap && this.slideTimer <= 0 && this.slideCooldown <= 0
      && p.grounded && speedNow > MOVE.slideMin) {
      const entry = Math.max(MOVE.slideSpeed, speedNow * 1.16);
      // Longer slide the faster you entered it.
      this.slideTimer = clamp(0.42 + (entry - MOVE.slideMin) * 0.105, 0.45, 0.95);
      V3.set(this.slideDir, fx, 0, fz);
      p.vel[0] = fx * entry; p.vel[2] = fz * entry;
      this.crouching = false;
      this.sprinting = false;
      this.audio.footstep(1.7, 0);
      this.fx.impact(p.pos[0], p.pos[1] + 0.05, p.pos[2], 0, 1, 0, 'sand', 1.5);
      this.vm.jumpImpulse(-0.05);
    }
    let sliding = this.slideTimer > 0;
    if (sliding) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0) {
        this.slideTimer = 0;
        this.slideCooldown = MOVE.slideCooldown;
        this.crouching = crouchDown;
        sliding = false;
      }
    }
    this.slide = damp(this.slide, sliding ? 1 : 0, 13, dt);
    p.crouchAmt = damp(p.crouchAmt, (this.crouching || sliding) ? 1 : 0, 12, dt);

    // ---- target speed
    const w = this.weapon;
    let target;
    if (sliding) target = MOVE.slideSpeed;
    else if (this.sprinting) target = this.tacSprint ? MOVE.tac : MOVE.sprint;
    else if (this.crouching) target = MOVE.crouch;
    else target = lerp(MOVE.walk, MOVE.ads, smoothstep(0.15, 1.0, this.adsAmt));
    if (!sliding && !this.sprinting && hasInput) {
      const fwd = Math.max(0, iz), back = Math.max(0, -iz), side = Math.abs(ix);
      const sum = fwd + back + side;
      target *= (fwd + side * MOVE.strafeMul + back * MOVE.backMul) / sum;
    }
    target *= w.moveMul;
    if (this.reloadTimer >= 0) target *= 0.95;
    if (!sliding) target *= Math.min(1, il);   // analog magnitude

    // ---- friction
    if (sliding) {
      const decay = Math.exp(-MOVE.slideFriction * dt);
      p.vel[0] *= decay; p.vel[2] *= decay;
    } else if (p.grounded) {
      const sp = Math.hypot(p.vel[0], p.vel[2]);
      if (sp > 1e-4) {
        // Less friction while actively pushing, so held input feels planted.
        const control = Math.max(sp, MOVE.stopSpeed);
        const drop = control * MOVE.friction * dt * (hasInput ? 0.72 : 1.0);
        const scale = Math.max(0, sp - drop) / sp;
        p.vel[0] *= scale; p.vel[2] *= scale;
      }
    }

    // ---- accelerate toward the wish direction
    if (hasInput) {
      const accel = sliding ? MOVE.slideSteer : (p.grounded ? MOVE.groundAccel : MOVE.airAccel);
      // Projecting current velocity onto the wish direction is what lets you
      // steer a slide or air-strafe without simply overwriting momentum.
      const cur = p.vel[0] * wishX + p.vel[2] * wishZ;
      const add = target - cur;
      if (add > 0) {
        const step = Math.min(add, accel * target * dt);
        p.vel[0] += wishX * step;
        p.vel[2] += wishZ * step;
      }
    }

    // ---- jump: coyote time + input buffering, and mantling takes priority
    if (tapped('Space')) this.jumpBuffer = MOVE.jumpBuffer;
    else if (this.jumpBuffer > 0) this.jumpBuffer -= dt;
    if (p.grounded) this.coyote = MOVE.coyote;
    else if (this.coyote > 0) this.coyote -= dt;

    if (this.jumpBuffer > 0 && this.tryMantle()) {
      this.jumpBuffer = 0;
      this.slideTimer = 0;
      this.updateWeapon(dt);
      return;
    }
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.jumpBuffer = 0; this.coyote = 0;
      p.vel[1] = MOVE.jumpVel;
      p.grounded = false;
      if (sliding) {
        // Slide-hop: cancel the slide but keep the speed you earned.
        this.slideTimer = 0;
        this.slideCooldown = MOVE.slideCooldown * 0.6;
        sliding = false;
        p.vel[0] *= 1.05; p.vel[2] *= 1.05;
      }
      this.vm.jumpImpulse(-0.10);
      this.audio.footstep(0.75, 0);
    }

    p.vel[1] += GRAVITY * dt;
    if (p.vel[1] < -MOVE.terminal) p.vel[1] = -MOVE.terminal;

    const wasGrounded = p.grounded;
    const fallSpeed = p.vel[1];
    moveEntity(this.world, p, dt);

    if (!wasGrounded && p.grounded) {
      const impact = -fallSpeed;
      if (impact > 3.5) {
        this.vm.jumpImpulse(clamp(fallSpeed * 0.016, -0.14, 0));
        this.audio.footstep(Math.min(2, impact * 0.14), 0);
        this.fx.impact(p.pos[0], p.pos[1] + 0.04, p.pos[2], 0, 1, 0, 'sand', 0.9);
        // Heavy landings cost you momentum.
        if (impact > 11) { p.vel[0] *= 0.70; p.vel[2] *= 0.70; }
      }
    }

    // ---- head bob and camera roll
    const speed = Math.hypot(p.vel[0], p.vel[2]);
    this.bobPhase += dt * (5.0 + speed * 1.25);
    const bobK = clamp(speed / 6.0, 0, 1) * (p.grounded ? 1 : 0)
      * (1 - this.adsAmt * 0.72) * (1 - this.slide);
    this.viewBobY = damp(this.viewBobY, Math.sin(this.bobPhase * 2) * 0.028 * bobK, 16, dt);
    this.viewBobX = damp(this.viewBobX, Math.sin(this.bobPhase) * 0.020 * bobK, 16, dt);
    // Lean into strafes, and tilt into the slide.
    const lateral = p.vel[0] * rx + p.vel[2] * rz;
    const strafeRoll = -lateral * 0.0044 * (1 - this.adsAmt * 0.6);
    this.viewRoll = damp(this.viewRoll, strafeRoll + this.slide * 0.11, 9, dt);

    // ---- footsteps, paced by stance
    if (p.grounded && speed > 1.1 && !sliding) {
      this.stepTimer -= dt * speed;
      if (this.stepTimer <= 0) {
        this.stepTimer = this.crouching ? 3.6 : 2.9;
        const vol = clamp(speed / 6, 0.35, 1.3) * (this.crouching ? 0.45 : 1);
        this.audio.footstep(vol, 0);
      }
    }

    // --- health regen
    if (p.regenDelay > 0) p.regenDelay -= dt;
    else if (p.health < p.maxHealth) {
      p.health = Math.min(p.maxHealth, p.health + this.diff.regenRate * dt);
    }
    if (this.spawnProtect > 0) this.spawnProtect -= dt;

    this.updateWeapon(dt);
  }

  /** True when a standing cylinder at (x,y,z) is clear of level geometry. */
  spaceFree(x, y, z, r, h) {
    const probe = [x, y, z];
    return !collideXZ(this.world, probe, r, y + 0.10, y + h).hit;
  }

  /**
   * Looks for a ledge in front of the player that is too tall to step onto but
   * low enough to climb, and starts a mantle if the far side is clear.
   */
  tryMantle() {
    const p = this.player;
    if (this.mantle) return false;
    const dx = -Math.sin(p.yaw), dz = -Math.cos(p.yaw);
    const origin = [p.pos[0], p.pos[1] + 0.55, p.pos[2]];
    const hit = this.world.raycast(origin, [dx, 0, dz], p.radius + 0.72);
    // Must be a wall face, not a floor or ceiling.
    if (!hit || !hit.collider || Math.abs(hit.ny) > 0.45) return false;

    const top = hit.collider.top;
    const rise = top - p.pos[1];
    if (rise < 0.30 || rise > MOVE.mantleMax) return false;
    // Don't mantle onto something the head is already inside.
    if (top - (p.pos[1] + p.height) > 0) return false;

    const lx = p.pos[0] + dx * (p.radius + 0.78);
    const lz = p.pos[2] + dz * (p.radius + 0.78);
    if (!this.spaceFree(lx, top + 0.06, lz, p.radius * 0.92, p.height)) return false;

    this.mantle = {
      t: 0,
      dur: MOVE.mantleTime * (0.72 + rise * 0.22),
      from: [p.pos[0], p.pos[1], p.pos[2]],
      to: [lx, top + 0.02, lz],
    };
    this.vm.jumpImpulse(-0.14);
    this.audio.footstep(1.3, 0);
    return true;
  }

  /* ------------------------------------------------------------- weapons */

  updateWeapon(dt) {
    const inp = this.input;
    const w = this.weapon;
    const id = this.weaponId;

    this.sinceFire += dt;
    if (this.sinceFire > 0.28) this.shotIndex = 0;
    if (this.fireTimer > 0) this.fireTimer -= dt;
    if (this.boltTimer > 0) this.boltTimer -= dt;

    // --- weapon switching
    if (inp.hit('Digit1') && this.slot !== 0) this.beginSwitch(0);
    if (inp.hit('Digit2') && this.slot !== 1) this.beginSwitch(1);
    if (inp.mouse.wheel !== 0) this.beginSwitch(this.slot === 0 ? 1 : 0);
    if (inp.hit('KeyQ')) this.beginSwitch(this.slot === 0 ? 1 : 0);
    if (this.switchTimer >= 0) {
      this.switchTimer -= dt;
      if (this.switchTimer <= 0 && this.pendingSlot >= 0) {
        this.slot = this.pendingSlot; this.pendingSlot = -1;
        this.switchTimer = -1;
        this.vm.startSwitch(this.weapon.switchTime * 0.6);
        this.audio.click(900, 0.20, 0.05);
      }
    }

    // --- killstreaks
    if (inp.hit('Digit4') && this.streakEarned.uav && this.uavTime <= 0) {
      this.streakEarned.uav = false;
      this.uavTime = 32;
      this.hud.showBanner('UAV ONLINE', 'ENEMY POSITIONS REVEALED', 2.2);
      this.audio.tone([660, 880, 1100], 0.14, 0.2, 'sine');
    }
    if (inp.hit('Digit5') && this.streakEarned.strike) {
      this.streakEarned.strike = false;
      this.callAirstrike();
    }
    if (this.uavTime > 0) this.uavTime -= dt;

    // --- ADS
    const canAds = this.reloadTimer < 0 && this.switchTimer < 0 && !this.sprinting
      && !this.mantle && this.throwTimer < 0;
    this.adsHeld = inp.buttons[2] && canAds;
    const adsRate = 1 / w.adsTime;
    this.adsAmt = clamp(this.adsAmt + (this.adsHeld ? dt * adsRate : -dt * adsRate * 1.35), 0, 1);

    // --- reload
    if (this.reloadTimer >= 0) {
      const prev = this.reloadTimer;
      this.reloadTimer -= dt;
      const dur = this.reloadDur;
      const doneFrac = 1 - this.reloadTimer / dur;
      if (prev / dur > 0.85 && this.reloadTimer / dur <= 0.85) this.audio.reload('out');
      if (prev / dur > 0.45 && this.reloadTimer / dur <= 0.45) this.audio.reload('in');
      if (this.reloadEmpty && prev / dur > 0.15 && this.reloadTimer / dur <= 0.15) this.audio.reload('bolt');
      if (this.reloadTimer <= 0) this.finishReload();
    } else if ((inp.hit('KeyR') || (this.ammo[id] === 0 && this.reserve[id] > 0 && this.fireTimer <= 0))
      && this.ammo[id] < w.mag && this.reserve[id] > 0 && this.switchTimer < 0 && this.throwTimer < 0) {
      this.beginReload();
    }

    // --- grenade
    if (this.throwTimer >= 0) {
      this.throwTimer -= dt;
      if (this.throwTimer <= 0) { this.throwGrenade(); this.throwTimer = -1; }
    } else if (inp.hit('KeyG') && this.grenades > 0 && this.reloadTimer < 0) {
      this.throwTimer = 0.32;
      this.grenades--;
      this.vm.startSwitch(0.28);
    }

    if (inp.hit('KeyF')) this.vm.inspectT = 0;

    // --- firing
    const wantFire = w.auto ? inp.buttons[0] : inp.btnPressed[0];
    // Sprint-to-fire delay: dropping sprint costs a beat before the weapon is
    // back on target, and you cannot shoot mid-mantle.
    const blocked = this.reloadTimer >= 0 || this.switchTimer >= 0 || this.sprinting
      || this.sprintOut > 0 || this.mantle || this.throwTimer >= 0
      || this.boltTimer > 0 || this.matchOver;
    if (wantFire && !blocked && this.fireTimer <= 0) {
      if (this.ammo[id] > 0) this.shoot();
      else if (inp.btnPressed[0]) { this.audio.click(320, 0.16, 0.05, 'square'); this.fireTimer = 0.25; }
    }

    // Peripheral blur while aiming + speed blur while sprinting. A telescopic
    // sight shows a real optical image, so it stays sharp.
    this.renderer.adsBlur = (w.scope ? this.adsAmt * 0.12 : this.adsAmt * 0.55) * this.motionBlur;
    this.renderer.speedBlur = damp(this.renderer.speedBlur,
      (this.slide > 0.5 ? 0.50 : this.sprinting ? (this.tacSprint ? 0.60 : 0.30) : 0) * this.motionBlur,
      8, dt);

    // Viewmodel push-back near walls.
    const cam = this._eye, dir = this._dir;
    const probe = this.world.raycast(cam, dir, 1.05);
    const lower = probe ? clamp(1 - probe.t / 1.05, 0, 1) : 0;

    this.vm.update(dt, {
      adsTarget: this.adsHeld ? 1 : 0,
      adsTime: w.adsTime,
      sprintTarget: this.sprinting ? 1 : 0,
      moveSpeed: Math.hypot(this.player.vel[0], this.player.vel[2]),
      grounded: this.player.grounded,
      lookDX: this.lookDX || 0, lookDY: this.lookDY || 0,
      lowerTarget: lower * (1 - this.adsAmt),
    });

    // FOV: widen slightly while sprinting, narrow when aiming.
    const targetFov = this.fovBase * lerp(1, w.adsFov, smoothstep(0, 1, this.adsAmt))
      * (1 + (this.sprinting ? (this.tacSprint ? 0.075 : 0.04) : 0));
    this.fov = damp(this.fov, targetFov, 14, dt);
  }

  beginSwitch(slot) {
    if (this.switchTimer >= 0 || this.pendingSlot >= 0) return;
    if (this.reloadTimer >= 0) this.reloadTimer = -1, this.vm.cancelReload();
    this.pendingSlot = slot;
    this.switchTimer = this.weapon.switchTime * 0.45;
    this.vm.startSwitch(this.weapon.switchTime * 0.45);
    this.adsAmt = 0;
  }

  beginReload() {
    const w = this.weapon, id = this.weaponId;
    const empty = this.ammo[id] === 0;
    this.reloadEmpty = empty;
    this.reloadDur = empty ? w.reloadEmptyTime : w.reloadTime;
    if (w.shellReload) this.reloadDur = w.reloadTime;
    this.reloadTimer = this.reloadDur;
    this.vm.startReload(this.reloadDur, empty);
    this.adsAmt = 0;
  }

  finishReload() {
    const w = this.weapon, id = this.weaponId;
    if (w.shellReload) {
      if (this.ammo[id] < w.mag && this.reserve[id] > 0) {
        this.ammo[id]++; this.reserve[id]--;
        this.audio.click(760, 0.22, 0.06);
      }
      this.reloadTimer = -1;
      if (this.ammo[id] < w.mag && this.reserve[id] > 0 && !this.input.buttons[0]) this.beginReload();
      else this.audio.reload('bolt');
      return;
    }
    const need = w.mag - this.ammo[id];
    const take = Math.min(need, this.reserve[id]);
    this.ammo[id] += take;
    this.reserve[id] -= take;
    this.reloadTimer = -1;
  }

  shoot() {
    const w = this.weapon, id = this.weaponId;
    this.ammo[id]--;
    this.fireTimer = 60 / w.rpm;
    if (w.boltTime) this.boltTimer = w.boltTime;
    this.sinceFire = 0;

    const cam = this._eye, dir = this._dir;
    const speed = Math.hypot(this.player.vel[0], this.player.vel[2]);
    const moveK = clamp(speed / 6, 0, 1) * (this.player.grounded ? 1 : 1.8);
    const spread = (this.adsAmt > 0.85 ? w.spreadAds : lerp(w.spreadHip, w.spreadAds, this.adsAmt))
      + w.moveSpread * moveK * (1 - this.adsAmt * 0.55);
    this.currentSpread = spread;

    // Basis for cone sampling.
    const upx = 0, upy = 1, upz = 0;
    let rx = dir[1] * upz - dir[2] * upy, ry = dir[2] * upx - dir[0] * upz, rz = dir[0] * upy - dir[1] * upx;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * dir[2] - rz * dir[1], uy = rz * dir[0] - rx * dir[2], uz = rx * dir[1] - ry * dir[0];

    const muzzle = this._muzzleOut;
    const mx = muzzle.mx === undefined ? cam[0] : muzzle.mx;
    const my = muzzle.my === undefined ? cam[1] : muzzle.my;
    const mz = muzzle.mz === undefined ? cam[2] : muzzle.mz;

    let firstDist = 60;
    for (let i = 0; i < w.bullets; i++) {
      const a = Math.random() * TAU;
      const r = (w.bullets > 1 ? Math.sqrt(Math.random()) : Math.random() * Math.random()) * spread;
      const ox = Math.cos(a) * r, oy = Math.sin(a) * r;
      const d = v3(
        dir[0] + rx * ox + ux * oy,
        dir[1] + ry * ox + uy * oy,
        dir[2] + rz * ox + uz * oy,
      );
      V3.norm(d, d);
      const res = this.fireRay(cam, d, w, this.player, this.player.team);
      if (i === 0) firstDist = res.dist;
      if (w.tracerEvery > 0 && (this.shotIndex % w.tracerEvery === 0 || w.bullets > 1)) {
        this.fx.tracer(mx, my, mz, d[0], d[1], d[2], Math.max(1.5, res.dist), 460, [2.4, 1.25, 0.42]);
      }
    }

    // Recoil.
    const step = recoilStep(w, this.shotIndex);
    const adsDamp = lerp(1, 0.72, this.adsAmt);
    this.recoilPitch += step.pitch * adsDamp;
    this.recoilYaw += step.yaw * adsDamp;
    this.shotIndex++;

    // Feedback.
    this.vm.fire(w);
    this.fx.muzzleFlash(mx, my, mz, dir[0], dir[1], dir[2], w.muzzleScale * lerp(1, 0.72, this.adsAmt), Math.random());
    if (muzzle.ex !== undefined) {
      this.fx.shellCasing(muzzle.ex, muzzle.ey, muzzle.ez, muzzle.rx, muzzle.ry, muzzle.rz);
    }
    this.audio.gunshot(w.sound, { pan: 0, distance: 0, gain: 1 });
    this.audio.shell(0.2);
  }

  throwGrenade() {
    const cam = this._eye, dir = this._dir;
    this.projectiles.push({
      pos: v3(cam[0] + dir[0] * 0.5, cam[1] + dir[1] * 0.5, cam[2] + dir[2] * 0.5),
      vel: v3(dir[0] * GRENADE.throwSpeed + this.player.vel[0],
        dir[1] * GRENADE.throwSpeed + 2.0 + this.player.vel[1] * 0.4,
        dir[2] * GRENADE.throwSpeed + this.player.vel[2]),
      fuse: GRENADE.fuse, owner: this.player, team: this.player.team, spin: rand(4, 12),
      rot: v3(rand(0, 6), rand(0, 6), rand(0, 6)),
    });
    this.audio.click(520, 0.18, 0.07, 'triangle');
  }

  callAirstrike() {
    const dir = this._dir;
    const p = this.player.pos;
    const ang = Math.atan2(dir[0], dir[2]);
    this.airstrikes.push({ t: 0, x: p[0], z: p[2], ang, n: 0 });
    this.hud.showBanner('AIRSTRIKE INBOUND', 'DANGER CLOSE', 2.4);
    this.audio.tone([300, 240, 180], 0.30, 0.22, 'sawtooth');
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const g = this.projectiles[i];
      g.vel[1] += GRAVITY * dt;
      const prev = [g.pos[0], g.pos[1], g.pos[2]];
      g.pos[0] += g.vel[0] * dt; g.pos[1] += g.vel[1] * dt; g.pos[2] += g.vel[2] * dt;
      g.rot[0] += g.spin * dt; g.rot[1] += g.spin * 0.7 * dt;

      // Collide by sweeping the previous position.
      const dx = g.pos[0] - prev[0], dy = g.pos[1] - prev[1], dz = g.pos[2] - prev[2];
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-5) {
        const d = [dx / len, dy / len, dz / len];
        const hit = this.world.raycast(prev, d, len + 0.09);
        if (hit) {
          const n = [hit.nx, hit.ny, hit.nz];
          g.pos[0] = prev[0] + d[0] * Math.max(0, hit.t - 0.09);
          g.pos[1] = prev[1] + d[1] * Math.max(0, hit.t - 0.09);
          g.pos[2] = prev[2] + d[2] * Math.max(0, hit.t - 0.09);
          const dot = g.vel[0] * n[0] + g.vel[1] * n[1] + g.vel[2] * n[2];
          g.vel[0] = (g.vel[0] - 2 * dot * n[0]) * 0.42;
          g.vel[1] = (g.vel[1] - 2 * dot * n[1]) * 0.42;
          g.vel[2] = (g.vel[2] - 2 * dot * n[2]) * 0.42;
          g.spin *= 0.6;
          if (Math.abs(dot) > 1.2) {
            this.audio.impact('metal', this._panFor(g.pos[0], g.pos[2]), V3.dist(this._eye, g.pos));
          }
        }
      }
      g.fuse -= dt;
      if (g.fuse <= 0) {
        this.explode(g.pos[0], g.pos[1], g.pos[2], GRENADE.radius, GRENADE.damage, g.owner, g.team);
        this.projectiles.splice(i, 1);
      }
    }

    for (let i = this.airstrikes.length - 1; i >= 0; i--) {
      const a = this.airstrikes[i];
      a.t += dt;
      const start = 1.6;
      if (a.t > start + a.n * 0.14 && a.n < 10) {
        const d = 8 + a.n * 5.0;
        const x = clamp(a.x + Math.sin(a.ang) * d + rand(-3, 3), -ARENA + 2, ARENA - 2);
        const z = clamp(a.z + Math.cos(a.ang) * d + rand(-3, 3), -ARENA + 2, ARENA - 2);
        const y = groundAt(this.world, x, z, 6, 0.4);
        this.explode(x, y + 0.4, z, 9.5, 190, this.player, this.player.team, 1.5);
        a.n++;
      }
      if (a.n >= 10 && a.t > start + 2.2) this.airstrikes.splice(i, 1);
    }
  }

  explode(x, y, z, radius, damage, owner, team, scale = 1) {
    this.fx.explosion(x, y, z, scale);
    const dist = V3.dist(this._eye, [x, y, z]);
    this.audio.explosion(dist, this._panFor(x, z));
    const p = [x, y, z];
    const hurt = (a) => {
      if (a.dead) return;
      const ax = a.pos[0], ay = a.pos[1] + 0.9, az = a.pos[2];
      const d = Math.hypot(ax - x, ay - y, az - z);
      if (d > radius) return;
      if (!this.world.visible(p, [ax, ay, az])) return;
      const k = 1 - d / radius;
      this.damageActor(a, damage * k * k, owner, { name: 'FRAG' }, false, p);
    };
    hurt(this.player);
    for (const b of this.bots) hurt(b);
    // Camera shake.
    if (dist < radius * 2.6) {
      const k = 1 - clamp(dist / (radius * 2.6), 0, 1);
      this.aimPunchP += rand(-0.09, 0.09) * k;
      this.aimPunchY += rand(-0.09, 0.09) * k;
      this.renderer.flash = Math.max(this.renderer.flash, k * 0.35);
    }
  }

  /* ---------------------------------------------------------------- bots */

  updateBots(dt) {
    for (const b of this.bots) {
      if (b.spawnProtect > 0) b.spawnProtect -= dt;
      if (b.dead) {
        b.deadTime += dt;
        b.anim.deathDrop = damp(b.anim.deathDrop, -0.72, 5.5, dt);
        b.anim.deathPitch = damp(b.anim.deathPitch, b.anim.deathPitch > 0 ? 1.5 : -1.5, 3.2, dt);
        if (b.deadTime > 5.0 && !this.matchOver) this.respawnBot(b);
        continue;
      }
      this.updateBot(b, dt);
    }
  }

  enemiesOf(team) {
    const out = [];
    if (this.player.team !== team && !this.player.dead) out.push(this.player);
    for (const o of this.bots) if (o.team !== team && !o.dead) out.push(o);
    return out;
  }

  updateBot(b, dt) {
    const eye = v3(); b.eyePos(eye);
    const skill = b.difficulty;

    // ---- perception (throttled)
    b.perceptTimer = (b.perceptTimer || 0) - dt;
    if (b.perceptTimer <= 0) {
      b.perceptTimer = 0.12 + Math.random() * 0.06;
      let best = null, bestD = 1e9;
      for (const e of this.enemiesOf(b.team)) {
        const ex = e.pos[0], ey = e.pos[1] + 1.35, ez = e.pos[2];
        const dx = ex - eye[0], dy = ey - eye[1], dz = ez - eye[2];
        const d = Math.hypot(dx, dy, dz);
        if (d > 68) continue;
        // Field of view (generous behind-cover awareness is handled by hearing).
        const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
        const dot = (dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1);
        const inFov = dot > Math.cos(1.15) || d < 7;
        if (!inFov) continue;
        if (!this.world.visible(eye, [ex, ey, ez])) continue;
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) {
        if (b.target !== best) { b.reactionTimer = lerp(0.34, 0.14, skill); b.aimSettle = 0; }
        b.target = best;
        b.lastSeen = [best.pos[0], best.pos[1], best.pos[2]];
        b.loseTimer = 2.6;
      } else if (b.target) {
        b.loseTimer = (b.loseTimer || 0) - 0.18;
        if (b.loseTimer <= 0) b.target = null;
      }
    }

    if (b.reactionTimer > 0) b.reactionTimer -= dt;
    if (b.target) b.aimSettle = Math.min(1, b.aimSettle + dt * lerp(1.3, 3.4, skill));

    // ---- state
    if (b.target && b.reactionTimer <= 0) b.state = b.health < 35 && Math.random() < 0.02 ? STATE.COVER : STATE.ENGAGE;
    else if (b.lastSeen) b.state = STATE.ADVANCE;
    else b.state = STATE.ADVANCE;

    // ---- goal selection + pathing
    b.repathTimer -= dt;
    if (b.repathTimer <= 0 || !b.path) {
      b.repathTimer = 0.55 + Math.random() * 0.5;
      let gx, gz;
      if (b.target) {
        // Close to a preferred engagement range instead of walking into them.
        const pref = b.weapon.id === 'sniper' ? 26 : b.weapon.id === 'vector' ? 9 : 15;
        const dx = b.target.pos[0] - b.pos[0], dz = b.target.pos[2] - b.pos[2];
        const d = Math.hypot(dx, dz) || 1;
        const want = clamp(d - pref, -10, 14);
        gx = b.pos[0] + (dx / d) * want;
        gz = b.pos[2] + (dz / d) * want;
      } else if (b.lastSeen) {
        gx = b.lastSeen[0] + rand(-3, 3); gz = b.lastSeen[2] + rand(-3, 3);
        if (Math.hypot(b.pos[0] - gx, b.pos[2] - gz) < 3) b.lastSeen = null;
      } else {
        // Roam toward the contested middle, biased to the enemy half.
        const en = this.enemiesOf(b.team);
        if (en.length && Math.random() < 0.7) {
          const t = en[(Math.random() * en.length) | 0];
          gx = t.pos[0] + rand(-9, 9); gz = t.pos[2] + rand(-9, 9);
        } else { gx = rand(-24, 24); gz = rand(-24, 24); }
      }
      gx = clamp(gx, -ARENA + 2, ARENA - 2);
      gz = clamp(gz, -ARENA + 2, ARENA - 2);
      const path = this.nav.find(b.pos[0], b.pos[2], gx, gz);
      if (path) { b.path = path; b.pathIdx = Math.min(1, path.length - 1); }
    }

    // ---- steering
    let mx = 0, mz = 0;
    if (b.path && b.pathIdx < b.path.length) {
      const node = b.path[b.pathIdx];
      const dx = node[0] - b.pos[0], dz = node[1] - b.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 0.9) {
        b.pathIdx++;
        if (b.pathIdx >= b.path.length) b.path = null;
      } else { mx = dx / d; mz = dz / d; }
    }
    // Strafe while engaged so bots aren't static targets.
    if (b.state === STATE.ENGAGE && b.target) {
      b.strafeTimer -= dt;
      if (b.strafeTimer <= 0) { b.strafeTimer = rand(0.7, 1.9); if (Math.random() < 0.45) b.strafeDir *= -1; }
      const tx = b.target.pos[0] - b.pos[0], tz = b.target.pos[2] - b.pos[2];
      const tl = Math.hypot(tx, tz) || 1;
      mx += (-tz / tl) * b.strafeDir * 0.85;
      mz += (tx / tl) * b.strafeDir * 0.85;
    }
    const ml = Math.hypot(mx, mz);
    if (ml > 0.01) { mx /= ml; mz /= ml; }

    const targetSpeed = b.state === STATE.ENGAGE ? 4.0 : (b.target ? 5.0 : 5.6);
    b.vel[0] = damp(b.vel[0], mx * targetSpeed, 9, dt);
    b.vel[2] = damp(b.vel[2], mz * targetSpeed, 9, dt);
    b.vel[1] += GRAVITY * dt;
    moveEntity(this.world, b, dt);

    // ---- facing
    let wantYaw = b.yaw;
    if (b.target) {
      const dx = b.target.pos[0] - b.pos[0], dz = b.target.pos[2] - b.pos[2];
      wantYaw = Math.atan2(-dx, -dz);
      const dy = (b.target.pos[1] + 1.3) - (b.pos[1] + 1.5);
      b.pitch = damp(b.pitch, Math.atan2(dy, Math.hypot(dx, dz)), 9, dt);
    } else if (ml > 0.01) {
      wantYaw = Math.atan2(-mx, -mz);
      b.pitch = damp(b.pitch, 0, 5, dt);
    }
    let dyaw = wantYaw - b.yaw;
    while (dyaw > Math.PI) dyaw -= TAU;
    while (dyaw < -Math.PI) dyaw += TAU;
    b.yaw += clamp(dyaw, -1, 1) * dt * lerp(5.5, 11, skill);
    b.aimAmt = b.target ? 1 : 0.65;
    b.crouchAmt = damp(b.crouchAmt, b.state === STATE.COVER ? 0.85 : 0, 6, dt);

    // ---- animation drive
    const spd = Math.hypot(b.vel[0], b.vel[2]);
    b.anim.speed = spd;
    b.anim.phase += dt * (2.4 + spd * 1.55);
    b.anim.bob = Math.sin(b.anim.phase * 2) * 0.022 * clamp(spd / 5, 0, 1);
    b.stepTimer -= dt * spd;
    if (b.stepTimer <= 0 && spd > 1 && b.grounded) {
      b.stepTimer = 3.0;
      const d = V3.dist(this._eye, b.pos);
      if (d < 22) this.audio.footstep(clamp(0.7 - d * 0.025, 0.06, 0.7), this._panFor(b.pos[0], b.pos[2]));
    }

    // ---- shooting
    b.fireTimer -= dt;
    if (b.reloadTimer > 0) {
      b.reloadTimer -= dt;
      if (b.reloadTimer <= 0) b.ammo = b.weapon.mag;
      return;
    }
    if (b.ammo <= 0) { b.reloadTimer = b.weapon.reloadEmptyTime; return; }

    if (b.state !== STATE.ENGAGE || !b.target || b.reactionTimer > 0 || b.spawnProtect > 0) return;
    const t = b.target;
    const aimAt = [t.pos[0], t.pos[1] + lerp(1.35, 1.05, t.crouchAmt || 0), t.pos[2]];
    if (!this.world.visible(eye, aimAt)) return;

    if (b.burstPause > 0) { b.burstPause -= dt; return; }
    if (b.fireTimer > 0) return;

    const w = b.weapon;
    b.fireTimer = 60 / w.rpm;
    b.ammo--;
    b.burst++;
    const burstLen = w.id === 'sniper' ? 1 : (w.auto ? Math.round(lerp(3, 8, skill)) + ((Math.random() * 3) | 0) : 2);
    if (b.burst >= burstLen) {
      b.burst = 0;
      b.burstPause = w.id === 'sniper' ? rand(0.9, 1.7) : rand(0.25, 0.62) * lerp(1.6, 0.7, skill);
    }

    // Aim error: wide on acquisition, tightening as they settle, plus lead error.
    const dist = V3.dist(eye, aimAt);
    const baseErr = lerp(0.075, 0.020, skill) * lerp(2.1, 1.0, b.aimSettle);
    const moveErr = Math.hypot(t.vel ? t.vel[0] : 0, t.vel ? t.vel[2] : 0) * 0.0055;
    const err = baseErr + moveErr;
    const d = v3(aimAt[0] - eye[0], aimAt[1] - eye[1], aimAt[2] - eye[2]);
    V3.norm(d, d);
    d[0] += rand(-err, err); d[1] += rand(-err, err) * 0.7; d[2] += rand(-err, err);
    V3.norm(d, d);

    const res = this.fireRay(eye, d, w, b, b.team);

    // Feedback for the player.
    const pd = V3.dist(this._eye, eye);
    const pan = this._panFor(eye[0], eye[2]);
    this.audio.gunshot(w.sound, { pan, distance: pd, gain: 0.95 });
    this.fx.muzzleFlash(eye[0] + d[0] * 0.55, eye[1] + d[1] * 0.55 - 0.12, eye[2] + d[2] * 0.55,
      d[0], d[1], d[2], w.muzzleScale * 0.9, Math.random());
    this.renderer.addLight(eye[0] + d[0] * 0.6, eye[1] + d[1] * 0.6, eye[2] + d[2] * 0.6,
      8, 1.0, 0.72, 0.35, 55);
    if (w.tracerEvery > 0) {
      this.fx.tracer(eye[0] + d[0] * 0.6, eye[1] + d[1] * 0.6 - 0.1, eye[2] + d[2] * 0.6,
        d[0], d[1], d[2], Math.max(2, res.dist), 460, [2.2, 0.9, 0.35]);
    }
    // Supersonic crack if the round passes near the player.
    if (t === this.player) {
      const miss = !res.actor;
      if (miss && Math.random() < 0.55) this.audio.whiz(pan * -0.6, clamp(1 - pd / 60, 0.2, 1));
    }
  }

  /* --------------------------------------------------------------- frame */

  update(dt) {
    this.time += dt;
    if (!this.matchOver) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) { this.timeLeft = 0; this.endMatch(); }
    }
    this.updatePlayer(dt);
    this.updateBots(dt);
    this.updateProjectiles(dt);

    const r = this.renderer;
    r.damage = Math.max(0, r.damage - dt * 2.2);
    r.flash = Math.max(0, r.flash - dt * 1.9);
    r.hurt = damp(r.hurt, this.player.dead
      ? 0.9 : clamp(1 - this.player.health / (45 * this.diff.healthScale), 0, 1), 5, dt);
    this.hud.update(dt);
  }

  /* -------------------------------------------------------------- render */

  submit(dt) {
    const r = this.renderer;
    const cam = this.buildCamera();
    r.setCamera(cam.eye, this.view, this.fov);

    for (const m of this.worldMeshes) r.draw(m.mesh, IDENTITY, m.mat, true);

    // Static lights (lamps, fires, beacon).
    for (const L of this.world.lights) {
      let inten = L.i;
      if (L.flicker) inten *= 0.72 + Math.sin(this.time * 11 + L.x) * 0.16 + Math.random() * 0.14;
      if (L.beacon) inten *= 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(this.time * 1.9)), 6);
      if (V3.dist(cam.eye, [L.x, L.y, L.z]) > 55) continue;
      r.addLight(L.x, L.y, L.z, L.r, L.col[0], L.col[1], L.col[2], inten);
    }
    if (this.world.fires) {
      for (const f of this.world.fires) this.fx.fireEmbers(f.x, f.y, f.z, dt);
    }
    this.fx.dustDevil(cam.eye[0], cam.eye[2], dt);

    // Actors.
    for (const b of this.bots) {
      if (b.dead && b.deadTime > 4.6) continue;
      const d = V3.dist(cam.eye, b.pos);
      if (d > 110) continue;
      drawSoldier(r, this.soldiers[b.team], b, this.teamMat[b.team], this.time);
      if (!b.dead) this.drawBotWeapon(b);
    }
    if (this.player.dead) {
      drawSoldier(r, this.soldiers[this.player.team], this.player, this.teamMat[this.player.team], this.time);
    }

    // Grenades in flight.
    for (const g of this.projectiles) {
      M4.compose(TMP, g.pos[0], g.pos[1], g.pos[2], g.rot[0], g.rot[1], g.rot[2]);
      for (const part of this.weapons.grenade.model.parts) r.draw(part.mesh, TMP, part.mat, true);
      // Fuse spark.
      if (g.fuse < 1.2) {
        r.addParticle(g.pos[0], g.pos[1] + 0.05, g.pos[2], 0.05, 4, 1.6, 0.4, 1, 0, 1, 1, Math.random());
        r.addLight(g.pos[0], g.pos[1] + 0.05, g.pos[2], 2.5, 1, 0.5, 0.2, 4);
      }
    }

    // Viewmodel. Hidden while dead, and hidden behind a telescopic sight —
    // there the 2D scope overlay is the whole picture.
    const scoped = this.weapon.scope && this.adsAmt > 0.80;
    if (!this.player.dead && !scoped) {
      this.vm.render(r, this.camWorld, this.weapon, this._muzzleOut);
      // Muzzle flash light comes from the actual muzzle.
      if (this.sinceFire < 0.05) {
        const m = this._muzzleOut;
        r.addLight(m.mx + m.dx * 0.4, m.my + m.dy * 0.4, m.mz + m.dz * 0.4,
          11 * this.weapon.muzzleScale, 1.0, 0.74, 0.40,
          140 * this.weapon.muzzleScale * (1 - this.sinceFire / 0.05));
      }
    } else if (scoped) {
      // Keep the muzzle anchored to the camera so FX still originate sanely.
      const m = this._muzzleOut, e = cam.eye, d = cam.dir;
      m.mx = e[0] + d[0] * 0.75; m.my = e[1] + d[1] * 0.75; m.mz = e[2] + d[2] * 0.75;
      m.dx = d[0]; m.dy = d[1]; m.dz = d[2];
      m.ex = m.mx; m.ey = m.my; m.ez = m.mz;
      m.rx = cam.right[0]; m.ry = cam.right[1]; m.rz = cam.right[2];
    }

    this.fx.update(dt, r);
  }

  drawBotWeapon(b) {
    const w = b.weapon;
    if (!w || !w.model) return;
    const crouch = b.crouchAmt || 0;
    M4.compose(BASE, b.pos[0], b.pos[1] + 1.34 - crouch * 0.30, b.pos[2], b.pitch * 0.8, b.yaw, 0);
    M4.compose(TMP, 0.13, -0.02, -0.26, 0, 0, 0);
    M4.mul(TMP2, BASE, TMP);
    for (const part of w.model.parts) this.renderer.draw(part.mesh, TMP2, part.mat, true);
  }

  /* ----------------------------------------------------------- HUD state */

  hudState() {
    const w = this.weapon, id = this.weaponId;
    const blips = [];
    const revealAll = this.uavTime > 0;
    for (const b of this.bots) {
      if (b.dead) continue;
      const enemy = b.team !== this.player.team;
      if (enemy && !revealAll) {
        // Only show enemies who have fired recently or are very close.
        const d = V3.dist(this.player.pos, b.pos);
        const recentFire = b.fireTimer > (60 / (b.weapon ? b.weapon.rpm : 600)) - 0.55;
        if (!recentFire && d > 12) continue;
      }
      blips.push({ x: b.pos[0], z: b.pos[2], enemy, yaw: b.yaw, dead: b.dead });
    }
    return {
      ads: this.adsAmt,
      scoped: w.scope ? this.adsAmt : 0,
      scopeSway: Math.sin(this.time * 1.3) * 0.4 + this.recoilYaw * 30,
      scopeSwayY: Math.cos(this.time * 0.9) * 0.3 - this.recoilPitch * 30,
      spread: this.currentSpread || w.spreadHip,
      moving: clamp(Math.hypot(this.player.vel[0], this.player.vel[2]) / 6, 0, 1),
      yaw: this.player.yaw,
      px: this.player.pos[0], pz: this.player.pos[2],
      ammo: this.ammo[id], reserve: this.reserve[id], magSize: w.mag,
      weaponName: w.name, weaponClass: w.class,
      reloading: this.reloadTimer >= 0,
      reloadProgress: this.reloadTimer >= 0 ? 1 - this.reloadTimer / this.reloadDur : 0,
      health: this.player.health, maxHealth: this.player.maxHealth,
      regen: this.player.regenDelay <= 0 && this.player.health < this.player.maxHealth ? 1 : 0,
      grenades: this.grenades,
      timeLeft: this.timeLeft, scoreAllies: this.score[0], scoreEnemies: this.score[1],
      scoreLimit: this.scoreLimit,
      streak: this.streak,
      streakRewards: STREAKS.map((s) => ({ name: s.name, at: s.at, key: s.key, ready: !!this.streakEarned[s.id] })),
      uav: this.uavTime,
      blips,
      touch: this.touch && this.touch.enabled ? this.touch : null,
      dead: this.player.dead,
      killerName: this.killerName,
      respawnIn: this.respawnIn, respawnTotal: this.respawnTotal,
    };
  }
}

const IDENTITY = m4();
const TMP = m4();
const TMP2 = m4();
const BASE = m4();
