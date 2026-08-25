// "SCRAPYARD" — a three-lane arena in the Call of Duty tradition: a left
// container corridor, an open central pad with a derrick you can climb, and a
// right-hand warehouse. Everything here is generated: geometry, collision,
// the nav grid and the spawn/cover metadata.

import { Builder, boxGeo, cylinderGeo, sphereGeo, planeGeo } from '../render/geometry.js';
import { MAT } from '../render/textures.js';
import { defaultMaterial } from '../render/renderer.js';
import { humanMaterial, tintFor } from './humans.js';
import { M4, m4, mulberry32, clamp } from '../core/math.js';

const R = mulberry32(20260823);
const rnd = (a, b) => a + R() * (b - a);
const pick = (arr) => arr[(R() * arr.length) | 0];

export const ARENA = 33;      // half-extent of the playable box

/**
 * Map registry. `atmosphere` is applied wholesale to the renderer, and is
 * doing most of the work of making the three locations feel different — the
 * same geometry under a different sky reads as a different place.
 */
export const MAPS = {
  scrapyard: {
    name: 'SCRAPYARD',
    blurb: 'Desert container yard · golden hour',
    build: (w) => w.buildScrapyard(),
    atmosphere: {
      sunDir: [0.40, 0.78, 0.62], sunColor: [1.0, 0.80, 0.58], sunIntensity: 4.4,
      ambientTint: [0.66, 0.77, 1.0], ambientMul: 3.10,
      fogColor: [0.32, 0.29, 0.31], fogDensity: 0.0026, fogHeight: 40,
      cloudAmount: 0.55, exposure: 1.78,
      skyZenith: [0.080, 0.170, 0.350], skyMid: [0.265, 0.345, 0.490], skyHaze: [0.640, 0.520, 0.395],
      lift: [0.028, 0.038, 0.060], saturation: 1.28, contrast: 1.16,
    },
  },
  blacksite: {
    name: 'BLACKSITE',
    blurb: 'Night refinery · floodlit',
    build: (w) => w.buildBlacksite(),
    atmosphere: {
      // A low, cold "moon" plus heavy fog; the floodlights do the real lighting.
      sunDir: [-0.32, 0.42, -0.85], sunColor: [0.52, 0.66, 1.0], sunIntensity: 0.75,
      ambientTint: [0.55, 0.68, 1.0], ambientMul: 2.6,
      fogColor: [0.055, 0.070, 0.105], fogDensity: 0.0100, fogHeight: 26,
      cloudAmount: 0.25, exposure: 2.30,
      skyZenith: [0.016, 0.028, 0.062], skyMid: [0.032, 0.052, 0.100], skyHaze: [0.090, 0.108, 0.160],
      lift: [0.012, 0.020, 0.045], saturation: 1.10, contrast: 1.22,
    },
  },
  dustbowl: {
    name: 'DUSTBOWL',
    blurb: 'Ruined village · high noon',
    build: (w) => w.buildDustbowl(),
    atmosphere: {
      // Sun almost overhead: short hard shadows, bleached ground, dusty air.
      sunDir: [0.18, 0.965, 0.19], sunColor: [1.0, 0.955, 0.88], sunIntensity: 4.9,
      ambientTint: [0.86, 0.90, 1.0], ambientMul: 2.15,
      fogColor: [0.60, 0.53, 0.44], fogDensity: 0.0060, fogHeight: 60,
      cloudAmount: 0.30, exposure: 1.08,
      skyZenith: [0.115, 0.235, 0.470], skyMid: [0.330, 0.430, 0.590], skyHaze: [0.720, 0.660, 0.560],
      lift: [0.030, 0.028, 0.022], saturation: 1.12, contrast: 1.10,
    },
  },
};

/* ------------------------------------------------------------------ OBB */

export class Collider {
  constructor(cx, cy, cz, hx, hy, hz, ry = 0, kind = 'hard') {
    this.c = [cx, cy, cz];
    this.h = [hx, hy, hz];
    this.ry = ry;
    this.cos = Math.cos(ry); this.sin = Math.sin(ry);
    this.kind = kind;           // 'hard' | 'metal' | 'wood' | 'sand'
    this.top = cy + hy;
    this.bottom = cy - hy;
    // Conservative AABB for broad-phase.
    const ax = Math.abs(this.cos) * hx + Math.abs(this.sin) * hz;
    const az = Math.abs(this.sin) * hx + Math.abs(this.cos) * hz;
    this.min = [cx - ax, cy - hy, cz - az];
    this.max = [cx + ax, cy + hy, cz + az];
  }
  toLocal(p, out) {
    const dx = p[0] - this.c[0], dz = p[2] - this.c[2];
    out[0] = dx * this.cos + dz * this.sin;
    out[1] = p[1] - this.c[1];
    out[2] = -dx * this.sin + dz * this.cos;
    return out;
  }
  toWorldDir(v, out) {
    out[0] = v[0] * this.cos - v[2] * this.sin;
    out[1] = v[1];
    out[2] = v[0] * this.sin + v[2] * this.cos;
    return out;
  }
}

/* ------------------------------------------------------------ world build */

class Batches {
  constructor() { this.map = new Map(); }
  get(key, matInit) {
    let b = this.map.get(key);
    if (!b) {
      const mat = defaultMaterial();
      Object.assign(mat, matInit);
      b = { builder: new Builder(), mat };
      this.map.set(key, b);
    }
    return b.builder;
  }
}

const _xf = m4();

export class World {
  constructor(mapId = 'scrapyard', opts = {}) {
    this.humans = opts.humans || null;   // HumanLibrary, optional
    this.batches = new Batches();
    this.colliders = [];
    this.lights = [];          // static emissive point lights
    this.spawns = [[], []];    // team 0 / team 1
    this.cover = [];           // {x,z,h} cover positions for bots
    this.props = [];           // dynamic-ish decorative meshes (drawn per-frame)
    this.meshes = [];
    this.fires = [];
    const def = MAPS[mapId] || MAPS.scrapyard;
    this.mapId = MAPS[mapId] ? mapId : 'scrapyard';
    this.info = def;
    this.atmosphere = def.atmosphere;
    def.build(this);
    this._buildNav();
  }

  /* ------------------------------------------------------------ helpers */

  box(mat, w, h, d, x, y, z, ry = 0, uvS = 1, solid = true, kind = 'hard') {
    M4.compose(_xf, x, y, z, 0, ry, 0);
    this.batches.get(mat.key, mat).add(boxGeo(w, h, d), _xf, uvS, [rnd(0, 40), rnd(0, 40)]);
    if (solid) this.colliders.push(new Collider(x, y, z, w / 2, h / 2, d / 2, ry, kind));
  }

  cyl(mat, r, h, x, y, z, seg = 18, ry = 0, rTop = null, uvS = 1, solid = true, kind = 'metal') {
    M4.compose(_xf, x, y, z, 0, ry, 0);
    this.batches.get(mat.key, mat).add(cylinderGeo(r, h, seg, true, rTop), _xf, uvS, [rnd(0, 40), rnd(0, 40)]);
    if (solid) this.colliders.push(new Collider(x, y, z, r, h / 2, r, 0, kind));
  }

  sph(mat, r, x, y, z, sx = 1, sy = 1, sz = 1, solid = false) {
    M4.compose(_xf, x, y, z, 0, rnd(0, 6.28), 0, sx, sy, sz);
    this.batches.get(mat.key, mat).add(sphereGeo(r, 14, 10), _xf, 1, [rnd(0, 40), rnd(0, 40)]);
    if (solid) this.colliders.push(new Collider(x, y, z, r * sx, r * sy, r * sz, 0, 'sand'));
  }

  /** Non-colliding decoration in an existing batch. */
  deco(mat, geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, uvS = 1) {
    M4.compose(_xf, x, y, z, rx, ry, rz, sx, sy, sz);
    this.batches.get(mat.key, mat).add(geo, _xf, uvS, [rnd(0, 40), rnd(0, 40)]);
  }

  /* --------------------------------------------------------- materials */

  static M = {
    sand: { key: 'sand', layer: MAT.SAND, uvScale: [0.11, 0.11], macro: 0.85, rough: 1, metal: 1, normalScale: 1.15 },
    asphalt: { key: 'asphalt', layer: MAT.ASPHALT, uvScale: [0.16, 0.16], macro: 0.65, normalScale: 1.1 },
    concrete: { key: 'concrete', layer: MAT.CONCRETE, uvScale: [0.34, 0.34], macro: 0.34, normalScale: 1.0 },
    concreteDark: { key: 'concreteDark', layer: MAT.CONCRETE, uvScale: [0.30, 0.30], tint: [0.62, 0.63, 0.66], macro: 0.30 },
    backdrop: { key: 'backdrop', layer: MAT.CONCRETE, uvScale: [0.10, 0.10], tint: [1.25, 1.12, 1.00], macro: 0.45, rough: 1.1, metal: 0 },
    steel: { key: 'steel', layer: MAT.CORRUGATED, uvScale: [0.30, 0.30], tint: [0.85, 0.86, 0.90], normalScale: 1.0 },
    corrugated: { key: 'corrugated', layer: MAT.CORRUGATED, uvScale: [0.22, 0.22], tint: [0.62, 0.60, 0.58], normalScale: 1.15, macro: 0.30 },
    steelDark: { key: 'steelDark', layer: MAT.GUNMETAL, uvScale: [0.55, 0.55], tint: [0.85, 0.87, 0.95] },
    wood: { key: 'wood', layer: MAT.WOOD, uvScale: [0.42, 0.42], macro: 0.25 },
    sandbag: { key: 'sandbag', layer: MAT.SANDBAG, uvScale: [0.75, 0.75], macro: 0.30 },
    barrel: { key: 'barrel', layer: MAT.RUSTBARREL, uvScale: [0.55, 0.55] },
    brick: { key: 'brick', layer: MAT.BRICK, uvScale: [0.26, 0.26], macro: 0.28 },
    tarp: { key: 'tarp', layer: MAT.TARP, uvScale: [0.45, 0.45] },
    stain: { key: 'stain', layer: MAT.ASPHALT, uvScale: [0.55, 0.55], tint: [0.30, 0.28, 0.26], rough: 0.55, macro: 0.5 },
    sandPatch: { key: 'sandPatch', layer: MAT.SAND, uvScale: [0.22, 0.22], tint: [0.78, 0.74, 0.70], macro: 0.9 },
    glass: { key: 'glass', layer: MAT.GLASSDIRT, uvScale: [0.4, 0.4], rough: 1, metal: 1 },
  };

  static container(tint, key) {
    return { key, layer: MAT.CONTAINER, uvScale: [0.165, 0.30], tint, normalScale: 1.15, macro: 0.18 };
  }

  /* -------------------------------------------------------------- props */

  addContainer(x, y, z, ry, variant) {
    const W = 6.06, H = 2.59, D = 2.44;
    const m = variant;
    this.box(m, W, H, D, x, y + H / 2, z, ry, 1);

    // Local axes: `r` runs along the length, `f` across the depth.
    const rx = Math.cos(ry), rz = Math.sin(ry);
    const fx = -Math.sin(ry), fz = Math.cos(ry);
    const sd = World.M.steelDark;

    for (const sgn of [1, -1]) {
      const ex = x + rx * sgn * (W / 2 + 0.022);
      const ez = z + rz * sgn * (W / 2 + 0.022);
      // Two door leaves side by side.
      for (const lf of [-1, 1]) {
        this.deco(sd, boxGeo(0.045, H * 0.90, D * 0.46),
          ex + fx * lf * (D * 0.24), y + H / 2, ez + fz * lf * (D * 0.24), 0, ry, 0, 1, 1, 1, 1.8);
      }
      // Four locking bars, spread across the depth (not stacked on top of
      // each other — that was z-fighting into a sawtooth).
      for (let i = 0; i < 4; i++) {
        const t = (i - 1.5) * (D * 0.235);
        this.deco(sd, cylinderGeo(0.027, H * 0.84, 8),
          ex + fx * t + rx * sgn * 0.030, y + H / 2, ez + fz * t + rz * sgn * 0.030);
      }
      // End cap channel.
      this.deco(sd, boxGeo(0.05, 0.10, D * 0.98), ex, y + H - 0.05, ez, 0, ry, 0, 1, 1, 1, 2);
    }
    // Corner castings.
    for (const a of [-1, 1]) {
      for (const b of [-1, 1]) {
        const cx = x + rx * a * (W / 2 - 0.09) + fx * b * (D / 2 - 0.09);
        const cz = z + rz * a * (W / 2 - 0.09) + fz * b * (D / 2 - 0.09);
        this.deco(sd, boxGeo(0.22, 0.16, 0.22), cx, y + H - 0.06, cz, 0, ry, 0, 1, 1, 1, 2.5);
        this.deco(sd, boxGeo(0.22, 0.16, 0.22), cx, y + 0.06, cz, 0, ry, 0, 1, 1, 1, 2.5);
      }
    }
  }

  addBarrel(x, z, y = 0, ry = null) {
    const r = 0.30, h = 0.88;
    this.cyl(World.M.barrel, r, h, x, y + h / 2, z, 16, ry === null ? rnd(0, 6.28) : ry, null, 1);
    this.deco(World.M.steelDark, cylinderGeo(r * 1.03, 0.05, 16), x, y + h - 0.02, z);
    this.deco(World.M.steelDark, cylinderGeo(r * 1.03, 0.05, 16), x, y + 0.02, z);
  }

  addCrate(x, z, y = 0, s = 1, ry = null) {
    const w = 0.9 * s;
    const r = ry === null ? rnd(-0.4, 0.4) : ry;
    this.box(World.M.wood, w, w, w, x, y + w / 2, z, r, 1.1);
    // Corner frame battens.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      M4.compose(_xf, x, y + w / 2, z, 0, r, 0);
      const lx = sx * w * 0.47, lz = sz * w * 0.47;
      this.deco(World.M.wood, boxGeo(0.07 * s, w * 1.01, 0.07 * s),
        x + lx * Math.cos(r) + lz * Math.sin(r), y + w / 2, z - lx * Math.sin(r) + lz * Math.cos(r), 0, r, 0, 1, 1, 1, 2.2);
    }
  }

  addSandbags(x, z, ry, len, rows = 3) {
    const bw = 0.52, bh = 0.24, bd = 0.34;
    const c = Math.cos(ry), s = Math.sin(ry);
    for (let row = 0; row < rows; row++) {
      const n = len - (row & 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const t = (i - (n - 1) / 2) * bw + (row & 1 ? bw * 0.5 : 0);
        const px = x + c * t, pz = z + s * t;
        const py = bh / 2 + row * bh * 0.92;
        this.sph(World.M.sandbag, bh * 0.62, px + rnd(-0.02, 0.02), py, pz + rnd(-0.02, 0.02),
          bw / (bh * 1.24), 1.0, bd / (bh * 1.24));
      }
    }
    const total = len * bw;
    this.colliders.push(new Collider(x, rows * bh * 0.92 / 2, z, total / 2, rows * bh * 0.92 / 2, bd / 2, ry, 'sand'));
  }

  addJersey(x, z, ry) {
    const m = World.M.concreteDark;
    this.box(m, 2.2, 0.42, 0.62, x, 0.21, z, ry, 1.2);
    this.deco(m, boxGeo(2.1, 0.42, 0.30), x, 0.63, z, 0, ry, 0, 1, 1, 1, 1.2);
    this.colliders.push(new Collider(x, 0.52, z, 1.1, 0.52, 0.31, ry, 'hard'));
  }

  addTireStack(x, z, n = 3) {
    for (let i = 0; i < n; i++) {
      const y = 0.13 + i * 0.24;
      this.cyl(World.M.tarp, 0.46, 0.24, x, y, z, 16, rnd(0, 6.28), null, 1, i === 0);
      this.deco(World.M.tarp, cylinderGeo(0.20, 0.26, 12), x, y, z);
    }
    this.colliders.push(new Collider(x, n * 0.12, z, 0.46, n * 0.12, 0.46, 0, 'sand'));
  }

  addPallet(x, z, ry) {
    for (let i = 0; i < 5; i++) {
      this.deco(World.M.wood, boxGeo(1.2, 0.035, 0.12), x, 0.115, z, 0, ry, 0);
      break;
    }
    const c = Math.cos(ry), s = Math.sin(ry);
    for (let i = 0; i < 6; i++) {
      const t = (i - 2.5) * 0.19;
      this.deco(World.M.wood, boxGeo(1.2, 0.035, 0.13), x + -s * t, 0.115, z + c * t, 0, ry, 0, 1, 1, 1, 2);
    }
    for (const t of [-0.5, 0, 0.5]) {
      this.deco(World.M.wood, boxGeo(1.2, 0.09, 0.10), x + -s * t, 0.05, z + c * t, 0, ry, 0, 1, 1, 1, 2);
    }
  }

  /** Steps built from individual boxes so the step-up controller handles them. */
  addStairs(x, y, z, ry, steps, rise, run, width) {
    const c = Math.cos(ry), s = Math.sin(ry);
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * run;
      const h = (i + 1) * rise;
      this.box(World.M.steelDark, width, h, run, x + -s * t, y + h / 2, z + c * t, ry, 1.4);
    }
    // Side stringers.
    for (const sgn of [-1, 1]) {
      const off = sgn * (width / 2 + 0.05);
      const len = steps * run;
      this.deco(World.M.steelDark, boxGeo(0.08, 0.12, len),
        x + c * off + -s * (len / 2), y + steps * rise * 0.55, z + s * off + c * (len / 2), 0, ry, 0, 1, 1, 1, 2);
    }
  }

  addRailing(x, y, z, ry, len, h = 1.05) {
    const m = World.M.steelDark;
    this.deco(m, boxGeo(len, 0.055, 0.055), x, y + h, z, 0, ry, 0, 1, 1, 1, 2.5);
    this.deco(m, boxGeo(len, 0.045, 0.045), x, y + h * 0.55, z, 0, ry, 0, 1, 1, 1, 2.5);
    const c = Math.cos(ry), s = Math.sin(ry);
    const n = Math.max(2, Math.round(len / 1.3));
    for (let i = 0; i <= n; i++) {
      const t = (i / n - 0.5) * len;
      this.deco(m, cylinderGeo(0.032, h, 8), x + c * t, y + h / 2, z + s * t);
    }
    this.colliders.push(new Collider(x, y + h / 2, z, (len / 2), h / 2, 0.07, ry, 'metal'));
  }

  addLamp(x, z, h = 6.2) {
    const m = World.M.steelDark;
    this.cyl(m, 0.11, h, x, h / 2, z, 12, 0, 0.09, 1.5);
    this.deco(m, boxGeo(0.9, 0.10, 0.35), x + 0.35, h, z, 0, 0, 0.18);
    // Emissive lamp head.
    const lm = { key: 'lampglow', layer: MAT.GUNMETAL, uvScale: [1, 1], tint: [0.9, 0.9, 0.9], emissive: [3.2, 2.5, 1.5] };
    this.deco(lm, boxGeo(0.52, 0.07, 0.26), x + 0.62, h - 0.09, z);
    this.lights.push({ x: x + 0.62, y: h - 0.35, z, r: 13.0, col: [1.0, 0.80, 0.52], i: 95 });
  }

  addFireBarrel(x, z) {
    this.addBarrel(x, z);
    this.lights.push({ x, y: 1.05, z, r: 9.5, col: [1.0, 0.52, 0.20], i: 62, flicker: true });
    this.fires = this.fires || [];
    this.fires.push({ x, y: 0.92, z });
  }

  /** Large vertical storage tank with ribs, a roof and a maintenance ladder. */
  addTank(x, z, r, h, mat) {
    const m = mat || World.M.steel;
    this.cyl(m, r, h, x, h / 2, z, 24, 0, null, 1);
    // Banding ribs.
    for (let i = 1; i < 4; i++) {
      this.deco(World.M.steelDark, cylinderGeo(r * 1.02, 0.16, 24), x, (h / 4) * i, z);
    }
    // Domed roof and rail.
    this.deco(m, cylinderGeo(r * 1.01, 0.5, 24, true, r * 0.72), x, h + 0.25, z);
    this.addRailing(x, h + 0.5, z - r * 0.72, 0, r * 1.3, 0.7);
    this.addLadder(x + r * 0.99, 0, z, Math.PI / 2, h);
    // Outlet pipework at the base.
    this.addPipeRun(x, 0.6, z + r + 0.25, 0, r * 2.2, 0.11);
  }

  /**
   * Hollow building shell: four walls with a doorway on one side and an open
   * top, so it reads as a ruin you can fight through rather than a solid block.
   */
  addRuin(x, z, w, d, h, ry, mat, doorSide = 0, roof = false) {
    const m = mat || World.M.brick;
    const c = Math.cos(ry), s = Math.sin(ry);
    const put = (lx, lz, lw, ld) => {
      this.box(m, lw, h, ld, x + c * lx - s * lz, h / 2, z + s * lx + c * lz, ry, 1);
    };
    const t = 0.45;
    const sides = [
      [0, -d / 2, w, t], [0, d / 2, w, t],
      [-w / 2, 0, t, d], [w / 2, 0, t, d],
    ];
    sides.forEach((sd, i) => {
      if (i === doorSide) {
        // Split the wall around a doorway.
        const seg = (sd[2] > sd[3]) ? 'x' : 'z';
        const len = seg === 'x' ? sd[2] : sd[3];
        const gap = 1.7;
        const piece = (len - gap) / 2;
        for (const sgn of [-1, 1]) {
          const off = sgn * (gap / 2 + piece / 2);
          if (seg === 'x') put(sd[0] + off, sd[1], piece, sd[3]);
          else put(sd[0], sd[1] + off, sd[2], piece);
        }
        // Lintel over the opening.
        const lx = seg === 'x' ? sd[0] : sd[0];
        const lz = seg === 'x' ? sd[1] : sd[1];
        this.deco(World.M.concreteDark, boxGeo(seg === 'x' ? gap + 0.5 : 0.6, 0.35, seg === 'x' ? 0.6 : gap + 0.5),
          x + c * lx - s * lz, h - 0.3, z + s * lx + c * lz, 0, ry, 0, 1, 1, 1, 1.4);
      } else {
        put(sd[0], sd[1], sd[2], sd[3]);
      }
    });
    // Flat roof, where the shell is still intact. Adobe roofs are flat, and it
    // gives the rooftop figures something to actually stand on.
    if (roof) {
      this.box(mat === World.M.brick ? World.M.concreteDark : m, w - 0.2, 0.35, d - 0.2,
        x, h - 0.175, z, ry, 1);
      // Low parapet around the edge.
      for (const [ox, oz, pw, pd] of [
        [0, -d / 2 + 0.3, w, 0.3], [0, d / 2 - 0.3, w, 0.3],
        [-w / 2 + 0.3, 0, 0.3, d], [w / 2 - 0.3, 0, 0.3, d],
      ]) {
        this.deco(m, boxGeo(pw, 0.5, pd),
          x + c * ox - s * oz, h + 0.25, z + s * ox + c * oz, 0, ry, 0, 1, 1, 1, 1.2);
      }
    }

    // Broken parapet.
    for (let i = 0; i < 10; i++) {
      const a = rnd(0, 6.28), rr = Math.max(w, d) * 0.5;
      this.deco(m, boxGeo(rnd(0.4, 1.0), rnd(0.15, 0.5), 0.42),
        x + Math.cos(a) * rr * rnd(0.7, 1), h + 0.15, z + Math.sin(a) * rr * rnd(0.7, 1), 0, rnd(0, 3.14), 0);
    }
  }

  /** Fabric awning on poles — market stalls. */
  addStall(x, z, ry) {
    const m = World.M.tarp;
    const c = Math.cos(ry), s = Math.sin(ry);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this.deco(World.M.wood, cylinderGeo(0.045, 2.1, 6),
        x + c * sx * 1.2 - s * sz * 0.9, 1.05, z + s * sx * 1.2 + c * sz * 0.9);
    }
    this.deco(m, boxGeo(2.7, 0.05, 2.1), x, 2.12, z, 0.06, ry, 0, 1, 1, 1, 1);
    this.deco(World.M.wood, boxGeo(2.5, 0.08, 0.9), x, 0.95, z, 0, ry, 0, 1, 1, 1, 2);
    this.colliders.push(new Collider(x, 0.5, z, 1.25, 0.5, 0.45, ry, 'wood'));
    for (let i = 0; i < 3; i++) {
      this.addCrate(x + c * rnd(-1, 1), z + s * rnd(-1, 1), 0, rnd(0.5, 0.8));
    }
  }

  /** Tall floodlight mast — the primary light source on a night map. */
  addFloodlight(x, z, h, col) {
    const m = World.M.steelDark;
    this.cyl(m, 0.16, h, x, h / 2, z, 10, 0, 0.11, 1.5);
    for (const sgn of [-1, 1]) {
      this.deco(m, boxGeo(0.9, 0.55, 0.30), x + sgn * 0.55, h - 0.2, z, 0, 0, sgn * 0.22);
      this.deco({ key: 'floodglow', layer: MAT.GUNMETAL, uvScale: [1, 1], tint: [0.9, 0.9, 0.9],
        emissive: [col[0] * 7, col[1] * 7, col[2] * 7] },
        boxGeo(0.72, 0.40, 0.06), x + sgn * 0.55, h - 0.24, z - 0.17, 0, 0, sgn * 0.22);
      this.lights.push({ x: x + sgn * 0.8, y: h - 0.6, z: z - 0.5, r: 30, col, i: 620 });
    }
  }

  /**
   * Bakes an imported civilian into the static batch. Deliberately collision-
   * free and placed clear of the fight: a human-shaped object you can shoot
   * through reads as a bug, so these live beyond the wire as scenery.
   */
  addHuman(name, x, z, ry = 0, y = 0, scaleMul = 1) {
    if (!this.humans || !this.humans.has(name)) return false;
    const model = this.humans.get(name);
    const sc = model.scale * scaleMul;
    const b = this.batches.get('humans', humanMaterial());
    M4.compose(_xf, x, y, z, 0, ry, 0, sc, sc, sc);
    for (const prim of model.prims) {
      b.add(
        { pos: prim.pos, nrm: prim.nrm, uv: prim.uv, idx: prim.idx },
        _xf, 1, [0, 0],
        { layer: MAT.PLAIN, tint: tintFor(prim.tint) },
      );
    }
    return true;
  }

  /** Scatters onlookers around a ring outside the arena. */
  addCrowdRing(entries) {
    let placed = 0;
    for (const [name, x, z, ry, scaleMul] of entries) {
      if (this.addHuman(name, x, z, ry, 0, scaleMul === undefined ? 1 : scaleMul)) placed++;
    }
    return placed;
  }

  /** Sagging cable between two points — catenary, in segments. */
  addCable(x0, y0, z0, x1, y1, z1, sag = 0.6, seg = 10, r = 0.022) {
    const m = World.M.steelDark;
    let px = x0, py = y0, pz = z0;
    for (let i = 1; i <= seg; i++) {
      const t = i / seg;
      const nx = x0 + (x1 - x0) * t;
      const nz = z0 + (z1 - z0) * t;
      // Catenary approximation: parabolic dip, deepest at mid-span.
      const ny = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * sag;
      const dx = nx - px, dy = ny - py, dz = nz - pz;
      const len = Math.hypot(dx, dy, dz);
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.asin(clamp(dy / (len || 1), -1, 1));
      this.deco(m, cylinderGeo(r, len, 5),
        (px + nx) / 2, (py + ny) / 2, (pz + nz) / 2,
        Math.PI / 2 - pitch, yaw, 0);
      px = nx; py = ny; pz = nz;
    }
  }

  /** Run of pipework along a wall, with support brackets. */
  addPipeRun(x, y, z, ry, len, r = 0.09) {
    const m = World.M.steelDark;
    const c = Math.cos(ry), s = Math.sin(ry);
    this.deco(m, cylinderGeo(r, len, 10), x, y, z, Math.PI / 2, ry + Math.PI / 2, 0);
    this.deco(m, cylinderGeo(r * 0.62, len, 8), x, y - r * 2.4, z, Math.PI / 2, ry + Math.PI / 2, 0);
    const n = Math.max(2, Math.round(len / 3.2));
    for (let i = 0; i <= n; i++) {
      const t = (i / n - 0.5) * len;
      this.deco(m, boxGeo(0.10, 0.34, 0.06), x + c * t, y - r * 1.2, z + s * t, 0, ry, 0, 1, 1, 1, 2);
      this.deco(m, cylinderGeo(r * 1.25, 0.05, 10), x + c * t, y, z + s * t, Math.PI / 2, ry + Math.PI / 2, 0);
    }
  }

  /** Wall-mounted ladder — decoration only, not climbable. */
  addLadder(x, y, z, ry, h) {
    const m = World.M.steelDark;
    const c = Math.cos(ry), s = Math.sin(ry);
    for (const sgn of [-1, 1]) {
      this.deco(m, cylinderGeo(0.030, h, 6), x + c * sgn * 0.22, y + h / 2, z + s * sgn * 0.22);
    }
    const rungs = Math.floor(h / 0.30);
    for (let i = 1; i < rungs; i++) {
      this.deco(m, cylinderGeo(0.018, 0.44, 5), x, y + i * 0.30, z, Math.PI / 2, ry + Math.PI / 2, 0);
    }
  }

  /** Ground stain — a flat disc that catches the light differently. */
  addStain(x, z, r, mat) {
    M4.compose(_xf, x, 0.014, z, 0, rnd(0, 6.28), 0, 1, 1, 1);
    this.batches.get(mat.key, mat).add(planeGeo(r * 2, r * 2, 1, 1), _xf, 1, [rnd(0, 40), rnd(0, 40)]);
  }

  /* -------------------------------------------------------------- layout */

  buildScrapyard() {
    const M = World.M;
    const CON = {
      red: World.container([1.0, 0.95, 0.92], 'conRed'),
      blue: World.container([0.42, 0.72, 1.15], 'conBlue'),
      green: World.container([0.52, 1.05, 0.62], 'conGreen'),
      tan: World.container([1.35, 1.15, 0.78], 'conTan'),
      grey: World.container([0.72, 0.76, 0.82], 'conGrey'),
    };
    const CONS = [CON.red, CON.blue, CON.green, CON.tan, CON.grey];

    // ---- ground
    this.batches.get(M.sand.key, M.sand).add(planeGeo(320, 320, 8, 1), null, 1);
    // Central asphalt pad, sunk a hair to avoid z-fighting.
    M4.compose(_xf, 0, 0.012, 0, 0, 0, 0);
    this.batches.get(M.asphalt.key, M.asphalt).add(planeGeo(38, 46, 4, 1), _xf, 1);

    // ---- perimeter blast walls
    const P = ARENA + 1.5;
    for (const [ax, az, ry, len] of [[0, -P, 0, 2 * P], [0, P, 0, 2 * P], [-P, 0, Math.PI / 2, 2 * P], [P, 0, Math.PI / 2, 2 * P]]) {
      const segs = Math.ceil(len / 4.2);
      for (let i = 0; i < segs; i++) {
        const t = (i - (segs - 1) / 2) * 4.2;
        const c = Math.cos(ry), s = Math.sin(ry);
        const px = ax + c * t, pz = az + s * t;
        const hgt = 4.4 + (i % 3) * 0.22;
        this.box(M.concrete, 4.18, hgt, 0.55, px, hgt / 2, pz, ry, 1);
        this.deco(M.concreteDark, boxGeo(4.3, 0.20, 0.72), px, hgt + 0.09, pz, 0, ry, 0, 1, 1, 1, 1.2);
      }
    }
    // Far backdrop silhouette so the horizon isn't empty. Lifted toward the
    // haze colour so it reads as distance rather than as floating black boxes.
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + 0.2;
      const d = 82 + rnd(0, 52);
      const w = rnd(9, 26), h = rnd(5, 21);
      this.box(M.backdrop, w, h, rnd(9, 24), Math.cos(a) * d, h / 2 - 0.5, Math.sin(a) * d, rnd(0, 3.1), 1, false);
      if (R() < 0.4) {
        this.deco(M.backdrop, boxGeo(w * 0.3, rnd(3, 8), w * 0.3),
          Math.cos(a) * d + rnd(-4, 4), h + 1.5, Math.sin(a) * d + rnd(-4, 4), 0, rnd(0, 3.1), 0);
      }
    }

    /* ---- LEFT LANE: container corridor running north-south (x ≈ -21) */
    // Long axis along Z so the rows read as corridor walls, with deliberate
    // gaps so the lane cross-connects to the centre.
    const Q = Math.PI / 2;
    let vi = 0;
    for (const z of [-20.5, -14.2, -7.9, 0.6, 6.9, 13.2, 19.5]) {
      this.addContainer(-25.2, 0, z, Q, CONS[vi++ % 5]);
    }
    for (const z of [-17.5, -11.2, 3.8, 10.1, 16.4]) {
      this.addContainer(-16.8, 0, z, Q, CONS[vi++ % 5]);
    }
    // Second tier — the catwalk route.
    for (const z of [-14.2, -7.9, 0.6]) {
      this.addContainer(-25.2, 2.62, z + rnd(-0.25, 0.25), Q + rnd(-0.02, 0.02), CONS[vi++ % 5]);
    }
    // Stairs up onto the stack from the south end of the lane.
    this.addStairs(-22.0, 0, -28.6, 0, 12, 0.222, 0.30, 1.35);
    this.box(M.steelDark, 3.2, 0.16, 3.0, -22.0, 2.68, -24.6, 0, 1.6);
    this.addRailing(-23.5, 2.76, -24.6, Q, 3.0);

    // Catwalk bridging the two container rows.
    for (let i = 0; i < 4; i++) {
      this.box(M.steelDark, 2.4, 0.14, 1.8, -23.4 + i * 2.3, 2.66, -21.4, 0, 1.8);
    }
    this.addRailing(-19.9, 2.73, -20.6, 0, 9.4);
    this.addRailing(-19.9, 2.73, -22.2, 0, 9.4);

    /* ---- RIGHT LANE: warehouse (x ≈ +20) */
    const wx = 21.5, wz = 0, ww = 15.0, wd = 24.0, wh = 5.4;
    // Walls with two door openings on the inner face.
    this.box(M.brick, 0.6, wh, wd, wx + ww / 2, wh / 2, wz, 0, 1);       // outer
    this.box(M.brick, ww, wh, 0.6, wx, wh / 2, wz - wd / 2, 0, 1);       // north
    this.box(M.brick, ww, wh, 0.6, wx, wh / 2, wz + wd / 2, 0, 1);       // south
    // Inner wall with gaps at z = -7 and z = +7.
    const innerX = wx - ww / 2;
    for (const [z0, z1] of [[-12.0, -9.0], [-5.0, 5.0], [9.0, 12.0]]) {
      const len = z1 - z0;
      this.box(M.brick, 0.6, wh, len, innerX, wh / 2, wz + (z0 + z1) / 2, 0, 1);
    }
    // Lintels over the doorways.
    for (const z of [-7, 7]) this.box(M.concreteDark, 0.7, 0.9, 4.2, innerX, wh - 0.45, wz + z, 0, 1.2);
    // Roof (partially collapsed — leaves a light shaft).
    for (let i = 0; i < 7; i++) {
      const z = wz - wd / 2 + 1.9 + i * 3.4;
      if (i === 3) continue;
      this.box(M.steel, ww + 0.7, 0.28, 3.3, wx, wh + 0.14, z, 0, 1);
    }
    for (let i = 0; i < 8; i++) {
      const z = wz - wd / 2 + 1.2 + i * 3.2;
      this.deco(M.steelDark, boxGeo(ww + 0.5, 0.30, 0.16), wx, wh - 0.22, z, 0, 0, 0, 1, 1, 1, 2);
    }
    // Mezzanine inside the warehouse.
    this.box(M.steelDark, 6.2, 0.18, 9.0, wx + 3.6, 2.85, wz - 5.5, 0, 1.6);
    this.addRailing(wx + 0.5, 2.94, wz - 5.5, Math.PI / 2, 9.0);
    this.addRailing(wx + 3.6, 2.94, wz - 1.0, 0, 6.2);
    this.addStairs(wx + 3.6, 0, wz + 1.2, Math.PI, 13, 0.219, 0.30, 1.5);
    // Warehouse interior clutter.
    this.addCrate(wx + 5.2, wz + 8.0, 0, 1.3);
    this.addCrate(wx + 5.4, wz + 6.6, 0, 1.15);
    this.addCrate(wx + 5.3, wz + 7.3, 1.05, 1.0);
    this.addBarrel(wx - 3.5, wz + 9.5);
    this.addBarrel(wx - 2.9, wz + 10.1);
    this.addPallet(wx + 1.2, wz + 4.0, 0.4);
    this.addPallet(wx - 2.0, wz - 8.2, 1.9);
    this.addTireStack(wx + 5.6, wz - 10.0, 4);

    /* ---- CENTRE: derrick tower on the pad */
    const T = 4.6;               // half footprint
    const legH = 7.4;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      // Tapered legs.
      this.cyl(M.steelDark, 0.19, legH, sx * T, legH / 2, sz * T, 10, 0, 0.13, 1.5);
    }
    // Horizontal bracing — one bar per side per level (drawing these inside the
    // leg loop duplicated every bar and z-fought).
    for (let i = 0; i < 3; i++) {
      const y = 1.6 + i * 2.2;
      for (const s of [-1, 1]) {
        this.deco(M.steelDark, boxGeo(0.10, 0.10, T * 2), s * T, y, 0, 0, 0, 0, 1, 1, 1, 2.5);
        this.deco(M.steelDark, boxGeo(T * 2, 0.10, 0.10), 0, y, s * T, 0, 0, 0, 1, 1, 1, 2.5);
      }
    }
    for (let i = 0; i < 3; i++) {
      const y = 2.7 + i * 2.2;
      for (const s of [-1, 1]) {
        this.deco(M.steelDark, boxGeo(0.09, 0.09, T * 2.9), s * T, y, 0, 0.42 * s, 0, 0, 1, 1, 1, 2.5);
        this.deco(M.steelDark, boxGeo(T * 2.9, 0.09, 0.09), 0, y, s * T, 0, 0, 0.42 * s, 1, 1, 1, 2.5);
      }
    }
    // Platform deck.
    const deckY = 5.35;
    this.box(M.steelDark, T * 2 + 1.4, 0.20, T * 2 + 1.4, 0, deckY, 0, 0, 2.0);
    for (const [ax, az, ry, len] of [
      [0, -(T + 0.7), 0, T * 2 + 1.4], [0, T + 0.7, 0, T * 2 + 1.4],
      [-(T + 0.7), 0, Math.PI / 2, T * 2 + 1.4], [T + 0.7, 0, Math.PI / 2, T * 2 + 1.4],
    ]) {
      if (ax === 0 && az > 0) continue;      // leave the stair side open
      this.addRailing(ax, deckY + 0.10, az, ry, len);
    }
    this.addStairs(0, 0, T + 1.4, 0, 24, 0.222, 0.285, 1.6);
    // Control shack on the deck.
    const shX = -1.8, shZ = -1.6;
    this.box(M.steel, 3.4, 2.5, 3.0, shX, deckY + 1.35, shZ, 0, 1);
    this.deco(M.steelDark, boxGeo(3.7, 0.14, 3.3), shX, deckY + 2.63, shZ);
    this.deco(M.glass, boxGeo(0.06, 1.05, 2.2), shX + 1.72, deckY + 1.75, shZ);
    this.deco({ key: 'shacklight', layer: MAT.GUNMETAL, uvScale: [1, 1], emissive: [1.6, 2.6, 3.4] },
      boxGeo(0.10, 0.24, 0.24), shX + 1.75, deckY + 2.35, shZ + 1.1);
    this.lights.push({ x: shX + 2.0, y: deckY + 2.3, z: shZ + 1.1, r: 8.5, col: [0.45, 0.72, 1.0], i: 34 });
    // Derrick mast above the deck.
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      this.deco(M.steelDark, cylinderGeo(0.12, 6.4, 8), sx * 1.5, deckY + 3.3, sz * 1.5, 0.06 * sx, 0, 0.06 * sz);
    }
    for (let i = 0; i < 5; i++) {
      const y = deckY + 0.9 + i * 1.28;
      this.deco(M.steelDark, boxGeo(3.0, 0.07, 0.07), 0, y, -1.5, 0, 0, 0, 1, 1, 1, 2.5);
      this.deco(M.steelDark, boxGeo(3.0, 0.07, 0.07), 0, y, 1.5, 0, 0, 0, 1, 1, 1, 2.5);
      this.deco(M.steelDark, boxGeo(0.07, 0.07, 3.0), -1.5, y, 0, 0, 0, 0, 1, 1, 1, 2.5);
      this.deco(M.steelDark, boxGeo(0.07, 0.07, 3.0), 1.5, y, 0, 0, 0, 0, 1, 1, 1, 2.5);
    }
    // Beacon.
    this.deco({ key: 'beacon', layer: MAT.GUNMETAL, uvScale: [1, 1], emissive: [6.0, 0.7, 0.4] },
      sphereGeo(0.20, 12, 8), 0, deckY + 9.7, 0);
    this.lights.push({ x: 0, y: deckY + 9.7, z: 0, r: 18, col: [1.0, 0.22, 0.14], i: 55, beacon: true });

    /* ---- centre pad cover (the three-lane connective tissue) */
    this.addSandbags(-8.5, -6.0, 0, 5);
    this.addSandbags(8.5, 6.0, 0, 5);
    this.addSandbags(-7.0, 10.5, Math.PI / 2, 4);
    this.addSandbags(6.5, -11.0, Math.PI / 2, 4);
    this.addJersey(-11.5, 2.0, Math.PI / 2);
    this.addJersey(-11.5, 4.3, Math.PI / 2);
    this.addJersey(11.5, -2.0, Math.PI / 2);
    this.addJersey(11.5, -4.3, Math.PI / 2);
    this.addJersey(-2.5, 14.5, 0);
    this.addJersey(2.5, -14.5, 0);

    // Containers laid across the lanes to break long sightlines.
    this.addContainer(-9.5, 0, -18.0, 0.04, CON.tan);
    this.addContainer(9.0, 0, 17.5, -0.05, CON.blue);
    this.addContainer(-4.5, 0, 23.5, 0.10, CON.green);
    this.addContainer(5.5, 0, -23.5, -0.08, CON.red);
    this.addContainer(-4.3, 2.62, 23.7, 0.06, CON.grey);

    // Scattered clutter.
    const clutter = [
      [-13.0, -9.0], [-12.2, -9.9], [-14.0, 12.0], [13.5, -12.5], [12.8, -11.6],
      [-6.0, 18.0], [7.0, -18.5], [-19.0, 4.0], [18.5, 14.0], [-18.0, -14.0],
      [3.5, 9.0], [-4.5, -9.5], [15.0, 20.0], [-15.5, 20.5], [16.0, -20.0],
    ];
    for (const [cx, cz] of clutter) {
      const t = R();
      if (t < 0.42) this.addBarrel(cx + rnd(-0.4, 0.4), cz + rnd(-0.4, 0.4));
      else if (t < 0.78) this.addCrate(cx, cz, 0, rnd(0.85, 1.35));
      else this.addTireStack(cx, cz, 2 + ((R() * 3) | 0));
    }
    for (let i = 0; i < 14; i++) {
      this.addPallet(rnd(-26, 26), rnd(-28, 28), rnd(0, 3.1));
    }
    // Debris rubble for ground interest (no collision).
    for (let i = 0; i < 90; i++) {
      const x = rnd(-30, 30), z = rnd(-30, 30);
      const s = rnd(0.10, 0.36);
      this.deco(pick([M.concreteDark, M.brick, M.steelDark]), boxGeo(s, s * rnd(0.3, 0.8), s * rnd(0.6, 1.4)),
        x, s * 0.16, z, rnd(0, 3.1), rnd(0, 6.28), rnd(0, 3.1));
    }

    /* ---- detail pass: pipework, cabling, stains, ladders */
    // Power lines strung between the yard lamps and the tower.
    this.addCable(-13.5, 5.9, -13.5, 13.5, 5.9, -13.5, 1.1, 12);
    this.addCable(13.5, 5.9, -13.5, 13.5, 5.9, 13.5, 1.1, 12);
    this.addCable(-13.5, 5.9, 13.5, -13.5, 5.9, -13.5, 1.1, 12);
    this.addCable(-13.5, 5.9, -13.5, -2.4, deckY + 1.9, -2.4, 0.8, 10);
    this.addCable(13.5, 5.9, 13.5, 27.0, 5.9, 7.0, 0.9, 10);
    this.addCable(-27.0, 5.9, 7.0, -13.5, 5.9, 13.5, 0.9, 10);

    // Pipework on the warehouse and the perimeter.
    this.addPipeRun(innerX - 0.42, 3.9, wz - 4.0, 0, 14.0, 0.10);
    this.addPipeRun(innerX - 0.42, 1.5, wz + 7.0, 0, 8.0, 0.07);
    this.addPipeRun(-(ARENA + 1.2), 3.2, -8.0, Math.PI / 2, 16.0, 0.09);
    this.addPipeRun(0, 3.4, ARENA + 1.2, 0, 18.0, 0.08);

    this.addLadder(wx + 7.2, 0, wz - 11.6, 0, 5.1);
    this.addLadder(-25.2, 0, -23.9, Math.PI / 2, 2.5);

    // Oil stains and tyre-scrubbed patches on the pad.
    for (let i = 0; i < 16; i++) {
      this.addStain(rnd(-16, 16), rnd(-20, 20), rnd(0.8, 2.6), M.stain);
    }
    for (let i = 0; i < 10; i++) {
      this.addStain(rnd(-26, 26), rnd(-28, 28), rnd(1.2, 3.4), M.sandPatch);
    }

    // Loose scrap: rebar bundles, sheet offcuts, cable spools.
    for (let i = 0; i < 22; i++) {
      const x = rnd(-28, 28), z = rnd(-30, 30);
      const k = R();
      if (k < 0.4) {
        const ry = rnd(0, 3.14);
        for (let j = 0; j < 5; j++) {
          this.deco(M.steelDark, cylinderGeo(0.022, rnd(1.4, 2.6), 5),
            x + rnd(-0.09, 0.09), 0.03 + j * 0.045, z + rnd(-0.09, 0.09), Math.PI / 2, ry + rnd(-0.06, 0.06), 0);
        }
      } else if (k < 0.72) {
        this.deco(M.steel, boxGeo(rnd(0.7, 1.6), 0.03, rnd(0.5, 1.2)),
          x, 0.02, z, rnd(-0.05, 0.05), rnd(0, 3.14), rnd(-0.05, 0.05));
      } else {
        this.deco(M.wood, cylinderGeo(rnd(0.35, 0.55), 0.42, 12),
          x, 0.21, z, Math.PI / 2, rnd(0, 3.14), 0);
      }
    }

    /* ---- yard crew, up on the stacks and the warehouse roof: visible from
       anywhere on the pad, and well out of the fight */
    for (const [name, hx, hz, hh, ry] of [
      ['male_standing_hips', -25.2, -14.2, 5.21, 1.6],
      ['male_lookingup', -25.2, -7.9, 5.21, 1.9],
      ['male_standing_coveringeyes', -25.2, 0.6, 5.21, 1.4],
      ['female_standing', -16.8, -17.5, 2.59, 1.7],
      ['male_pickingup', -16.8, 10.1, 2.59, 2.1],
      ['male_standing', wx - 3.0, wz - 9.0, 5.68, -1.5],
      ['female_standing_hips', wx + 2.0, wz - 3.0, 5.68, -1.8],
      ['male_walking', wx + 4.5, wz + 6.0, 5.68, -1.2],
      ['woman_standing_waving', 5.5, -23.5, 2.61, 0.1],
      ['male_sitting', -4.5, 23.5, 2.61, 3.2],
    ]) this.addHuman(name, hx, hz, ry, hh + 0.02);

    /* ---- lighting props */
    this.addLamp(-13.5, -13.5); this.addLamp(13.5, 13.5);
    this.addLamp(-13.5, 13.5); this.addLamp(13.5, -13.5);
    this.addLamp(-27.0, 0, 7.0); this.addLamp(27.0, 0, 7.0);
    this.addFireBarrel(-20.0, 9.5);
    this.addFireBarrel(19.0, -9.0);
    this.addFireBarrel(-1.5, -27.5);

    /* ---- spawns: opposite corners, CoD-style */
    // Opposite corners, spread over a few metres so spawns aren't stacked.
    const spawnGrid = [[-1.8, -1.8], [0, -2.2], [1.8, -1.8], [-2.2, 0], [2.2, 0], [-1.8, 1.8], [1.8, 1.8], [0, 2.2]];
    for (const [ox, oz] of spawnGrid) {
      this.spawns[0].push({ x: -28.6 + ox, z: -28.6 + oz, yaw: Math.PI * 0.25 });
      this.spawns[1].push({ x: 28.6 + ox, z: 28.6 + oz, yaw: Math.PI * 1.25 });
    }

    /* ---- cover points for the bots */
    for (const c of this.colliders) {
      if (c.top < 0.55 || c.top > 2.2 || c.bottom > 0.4) continue;
      const r = Math.max(c.h[0], c.h[2]) + 0.75;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        const x = c.c[0] + Math.cos(a) * r, z = c.c[2] + Math.sin(a) * r;
        if (Math.abs(x) < ARENA - 1 && Math.abs(z) < ARENA - 1) this.cover.push({ x, z, h: c.top });
      }
    }

  }

  /* ====================================================== MAP: BLACKSITE */
  /**
   * Night refinery. Vertical bulk — storage tanks and pipe racks — instead of
   * Scrapyard's low container maze, so sightlines are long down the lanes and
   * completely blocked across them. Lit almost entirely by floodlights, which
   * makes the lanes pools of light with black gaps between.
   */
  buildBlacksite() {
    const M = World.M;
    // Ground: wet concrete apron over asphalt.
    this.batches.get(M.sand.key, M.sand).add(planeGeo(320, 320, 8, 1), null, 1);
    M4.compose(_xf, 0, 0.012, 0, 0, 0, 0);
    this.batches.get(M.asphalt.key, M.asphalt).add(planeGeo(58, 58, 4, 1), _xf, 1);

    // Perimeter fence walls.
    const P = ARENA + 1.5;
    for (const [ax, az, ry] of [[0, -P, 0], [0, P, 0], [-P, 0, Math.PI / 2], [P, 0, Math.PI / 2]]) {
      const segs = Math.ceil((2 * P) / 4.2);
      for (let i = 0; i < segs; i++) {
        const t = (i - (segs - 1) / 2) * 4.2;
        const c = Math.cos(ry), sn = Math.sin(ry);
        this.box(M.corrugated, 4.18, 4.0, 0.4, ax + c * t, 2.0, az + sn * t, ry, 1);
      }
    }

    // Four big tanks in a diamond — the map's defining silhouette.
    this.addTank(-15, -15, 5.2, 11, M.steel);
    this.addTank(15, 15, 5.2, 11, M.steel);
    this.addTank(-16, 14, 4.2, 8.5, M.corrugated);
    this.addTank(16, -14, 4.2, 8.5, M.corrugated);
    // A smaller pair flanking the centre.
    this.addTank(0, -24, 3.4, 7, M.steel);
    this.addTank(0, 24, 3.4, 7, M.steel);

    // Central gantry: raised deck linking the two big tanks, with stairs.
    const gy = 4.6;
    for (let i = 0; i < 9; i++) {
      this.box(M.steelDark, 3.2, 0.18, 3.4, -12 + i * 3.0, gy, -12 + i * 3.0, Math.PI * 0.25, 1.6);
    }
    for (let i = 0; i < 9; i++) {
      const x = -12 + i * 3.0, z = -12 + i * 3.0;
      this.addRailing(x, gy + 0.09, z - 1.8, Math.PI * 0.25, 3.2, 1.0);
      this.addRailing(x, gy + 0.09, z + 1.8, Math.PI * 0.25, 3.2, 1.0);
      if (i % 3 === 0) this.cyl(M.steelDark, 0.14, gy, x, gy / 2, z, 8, 0, null, 1.5);
    }
    this.addStairs(-14.5, 0, -16.5, Math.PI * 0.25, 21, 0.22, 0.30, 1.6);
    this.addStairs(14.5, 0, 16.5, Math.PI * 1.25, 21, 0.22, 0.30, 1.6);

    // Pipe racks overhead, running the other diagonal.
    for (let i = -3; i <= 3; i++) {
      const x = i * 7, z = -i * 7;
      this.cyl(M.steelDark, 0.18, 6.2, x - 3.5, 3.1, z - 3.5, 8, 0, null, 1.5);
      this.cyl(M.steelDark, 0.18, 6.2, x + 3.5, 3.1, z + 3.5, 8, 0, null, 1.5);
      this.deco(M.steelDark, boxGeo(0.22, 0.22, 10.5), x, 6.2, z, 0, Math.PI * 0.75, 0);
    }
    for (const off of [-0.55, -0.2, 0.2, 0.55]) {
      this.addPipeRun(off * 1.4, 6.5 + off * 0.3, -off * 1.4, Math.PI * 0.75, 46, 0.13);
    }

    // Cover: pump housings, valve skids, jersey barriers.
    const skids = [[-7, 3], [7, -3], [-3, -8], [3, 8], [-10, 8], [10, -8], [-20, 2], [20, -2]];
    for (const [x, z] of skids) {
      this.box(M.steelDark, 2.6, 1.15, 1.7, x, 0.575, z, rnd(-0.3, 0.3), 1.4);
      this.deco(M.steel, cylinderGeo(0.34, 0.9, 12), x + 0.7, 1.6, z);
      this.deco(M.barrel, cylinderGeo(0.22, 0.7, 10), x - 0.7, 1.5, z, Math.PI / 2, rnd(0, 3), 0);
      this.addPipeRun(x, 1.5, z + 1.0, 0, 2.4, 0.07);
    }
    for (const [x, z, r] of [[-5, -18, 0], [5, 18, 0], [-18, -5, Math.PI / 2], [18, 5, Math.PI / 2]]) {
      this.addJersey(x, z, r); this.addJersey(x + Math.cos(r) * 2.4, z + Math.sin(r) * 2.4, r);
    }
    for (let i = 0; i < 20; i++) {
      const x = rnd(-27, 27), z = rnd(-27, 27);
      if (Math.hypot(x, z) < 6) continue;
      if (R() < 0.5) this.addBarrel(x, z); else this.addCrate(x, z, 0, rnd(0.8, 1.2));
    }

    // Floodlights are the map. Cold on the perimeter, sodium in the middle.
    this.addFloodlight(-24, -24, 9.5, [0.62, 0.74, 1.0]);
    this.addFloodlight(24, 24, 9.5, [0.62, 0.74, 1.0]);
    this.addFloodlight(-24, 24, 9.5, [0.70, 0.78, 1.0]);
    this.addFloodlight(24, -24, 9.5, [0.70, 0.78, 1.0]);
    this.addFloodlight(-9, 9, 8.0, [1.0, 0.72, 0.34]);
    this.addFloodlight(9, -9, 8.0, [1.0, 0.72, 0.34]);
    this.addFireBarrel(-13, 20);
    this.addFireBarrel(13, -20);

    // Techs up on the tank decks — enough to imply the site is manned, and the
    // only human silhouettes against a floodlit sky.
    for (const [name, hx, hz, hh, ry] of [
      ['male_standing', -15, -15, 11.5, 2.2], ['male_lookingup', 15, 15, 11.5, -0.9],
      ['male_standing_hips', -16, 14, 9.0, 1.4], ['male_walking', 16, -14, 9.0, -1.7],
    ]) this.addHuman(name, hx, hz, ry, hh + 0.02);

    const grid = [[-1.8, -1.8], [0, -2.2], [1.8, -1.8], [-2.2, 0], [2.2, 0], [-1.8, 1.8], [1.8, 1.8], [0, 2.2]];
    for (const [ox, oz] of grid) {
      this.spawns[0].push({ x: -27 + ox, z: 27 + oz, yaw: Math.PI * 0.75 });
      this.spawns[1].push({ x: 27 + ox, z: -27 + oz, yaw: Math.PI * 1.75 });
    }
    this._coverFromColliders();
  }

  /* ======================================================= MAP: DUSTBOWL */
  /**
   * A ruined village at hard midday. Adobe shells with doorways make a proper
   * warren — short sightlines, lots of corners, and roofs you cannot reach, so
   * fights stay on the ground and close.
   */
  buildDustbowl() {
    const M = World.M;
    this.batches.get(M.sand.key, M.sand).add(planeGeo(320, 320, 8, 1), null, 1);

    // Low perimeter wall, broken in places.
    const P = ARENA + 1.0;
    for (const [ax, az, ry] of [[0, -P, 0], [0, P, 0], [-P, 0, Math.PI / 2], [P, 0, Math.PI / 2]]) {
      const segs = Math.ceil((2 * P) / 3.6);
      for (let i = 0; i < segs; i++) {
        if (i === 3 || i === segs - 4) continue;      // gaps
        const t = (i - (segs - 1) / 2) * 3.6;
        const c = Math.cos(ry), sn = Math.sin(ry);
        const h = 2.6 + (i % 3) * 0.3;
        this.box(M.brick, 3.55, h, 0.5, ax + c * t, h / 2, az + sn * t, ry, 1);
      }
    }

    // Village blocks: three lanes emerge from the gaps between shells.
    const houses = [
      [-19, -18, 9, 8, 4.2, 0.1, 1], [-8, -20, 8, 7, 3.4, -0.05, 0],
      [8, -17, 10, 8, 5.0, 0.06, 2], [20, -17, 8, 9, 3.8, 0, 3],
      [-21, -3, 8, 10, 4.6, 0.04, 1], [-9, -4, 7, 7, 3.2, 0.1, 0],
      [10, -3, 9, 9, 4.4, -0.06, 3], [21, -2, 7, 8, 3.6, 0, 2],
      [-19, 13, 9, 8, 4.0, 0.05, 1], [-7, 15, 7, 7, 3.4, 0, 0],
      [9, 14, 9, 8, 4.8, -0.04, 3], [21, 15, 8, 8, 3.6, 0.08, 2],
      [-3, 25, 8, 7, 3.8, 0, 0], [4, -27, 8, 7, 3.6, 0, 1],
    ];
    // Buildings that carry a rooftop figure keep their roof; the rest are
    // bombed open, which also varies the skyline.
    const roofed = new Set(['-19,-18', '20,-17', '-19,13', '21,15', '-3,25', '4,-27', '-21,-3', '21,-2']);
    for (const [x, z, w, d, h, ry, door] of houses) {
      this.addRuin(x, z, w, d, h, ry, M.brick, door, roofed.has(`${x},${z}`));
    }

    // Central plaza: a well, stalls and sandbag positions.
    this.cyl(M.concreteDark, 1.5, 1.0, 0, 0.5, 0, 16, 0, null, 1.2);
    this.deco(M.concreteDark, cylinderGeo(1.62, 0.22, 16), 0, 1.0, 0);
    for (const sgn of [-1, 1]) {
      this.deco(M.wood, cylinderGeo(0.09, 2.6, 6), sgn * 1.3, 2.3, 0);
    }
    this.deco(M.wood, boxGeo(3.0, 0.16, 0.16), 0, 3.55, 0);
    this.addStall(-5, 3, 0.3);
    this.addStall(5.5, -3, -0.2);
    this.addStall(-4, -6, 1.4);
    this.addStall(4, 6.5, 1.7);
    this.addSandbags(-8, 0, Math.PI / 2, 5);
    this.addSandbags(8, 0, Math.PI / 2, 5);
    this.addSandbags(0, -9, 0, 5);
    this.addSandbags(0, 9, 0, 5);

    // Rubble spill from the ruins, plus burnt-out clutter.
    for (let i = 0; i < 120; i++) {
      const x = rnd(-30, 30), z = rnd(-30, 30);
      const sz = rnd(0.18, 0.6);
      this.deco(M.brick, boxGeo(sz, sz * rnd(0.4, 0.9), sz * rnd(0.7, 1.3)),
        x, sz * 0.2, z, rnd(0, 3.1), rnd(0, 6.28), rnd(0, 3.1));
    }
    for (let i = 0; i < 26; i++) {
      const x = rnd(-28, 28), z = rnd(-28, 28);
      if (Math.hypot(x, z) < 3) continue;
      const k = R();
      if (k < 0.35) this.addCrate(x, z, 0, rnd(0.8, 1.3));
      else if (k < 0.6) this.addBarrel(x, z);
      else if (k < 0.8) this.addJersey(x, z, rnd(0, 3.1));
      else this.addTireStack(x, z, 2 + ((R() * 3) | 0));
    }
    for (let i = 0; i < 12; i++) this.addStain(rnd(-26, 26), rnd(-26, 26), rnd(1, 3), M.sandPatch);

    // Villagers watching from the rooftops. Placed up there deliberately:
    // visible from anywhere in the map, unreachable (the shells are 3.5 m+ and
    // there is nothing to mantle from), and so never mistaken for a target.
    for (const [name, hx, hz, hh, ry] of [
      ['female_sitting', -19, -18, 4.2, 1.9], ['male_sitting', -17, -16.5, 4.2, 2.2],
      ['female_standing_coveringeyes', 20, -17, 3.8, -1.6], ['male_lookingup', 21.5, -15, 3.8, -1.9],
      ['woman_standing_waving', -19, 13, 4.0, 1.5], ['male_standing_hips', -17.5, 15, 4.0, 1.2],
      ['female_standing', 21, 15, 3.6, -1.4], ['male_standing', 22.5, 13.5, 3.6, -1.8],
      ['female_sitting_cheering', -3, 25, 3.8, 3.1], ['male_standing_waving', -1, 23.5, 3.8, 3.4],
      ['male_pickingup', 4, -27, 3.6, 0.2], ['female_lookingup', -21, -3, 4.6, 1.7],
      ['male_standing_coveringeyes', 21, -2, 3.6, -1.5],
    ]) this.addHuman(name, hx, hz, ry, hh + 0.02);

    // A few at ground level, framed by the gaps in the perimeter wall.
    this.addCrowdRing([
      ['female_walking', -37, 0, 1.55], ['male_walking', 37, 0, -1.55],
      ['female_pickingup', -38.5, 3.5, 1.7], ['male_running', 38, -3.5, -1.4],
    ]);

    // Palms-as-poles with cabling between them, for vertical interest.
    for (const [x, z] of [[-14, 6], [14, -6], [-14, -10], [14, 10]]) this.addLamp(x, z, 5.6);
    this.addCable(-14, 5.3, 6, 14, 5.3, -6, 1.6, 14);
    this.addCable(-14, 5.3, -10, 14, 5.3, 10, 1.6, 14);
    this.addFireBarrel(-11, 20);
    this.addFireBarrel(11, -20);

    const grid = [[-1.8, -1.8], [0, -2.2], [1.8, -1.8], [-2.2, 0], [2.2, 0], [-1.8, 1.8], [1.8, 1.8], [0, 2.2]];
    for (const [ox, oz] of grid) {
      this.spawns[0].push({ x: -28 + ox, z: 6 + oz, yaw: Math.PI * 1.5 });
      this.spawns[1].push({ x: 28 + ox, z: -6 + oz, yaw: Math.PI * 0.5 });
    }
    this._coverFromColliders();
  }

  /** Shared: derive bot cover points from waist-high geometry. */
  _coverFromColliders() {
    for (const c of this.colliders) {
      if (c.top < 0.55 || c.top > 2.2 || c.bottom > 0.4) continue;
      const r = Math.max(c.h[0], c.h[2]) + 0.75;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        const x = c.c[0] + Math.cos(a) * r, z = c.c[2] + Math.sin(a) * r;
        if (Math.abs(x) < ARENA - 1 && Math.abs(z) < ARENA - 1) this.cover.push({ x, z, h: c.top });
      }
    }
  }

  /* ---------------------------------------------------------- navigation */

  _buildNav() {
    const S = 1.0;
    const N = Math.ceil((ARENA * 2) / S);
    this.nav = { N, S, origin: -ARENA, walk: new Uint8Array(N * N), height: new Float32Array(N * N) };
    const p = [0, 0, 0];
    const l = [0, 0, 0];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -ARENA + (i + 0.5) * S;
        const z = -ARENA + (j + 0.5) * S;
        // Highest surface at or below knee-ish height that a bot can stand on.
        let h = 0;
        let blocked = false;
        for (const c of this.colliders) {
          if (x < c.min[0] - 0.34 || x > c.max[0] + 0.34 || z < c.min[2] - 0.34 || z > c.max[2] + 0.34) continue;
          p[0] = x; p[1] = 0; p[2] = z;
          c.toLocal(p, l);
          if (Math.abs(l[0]) > c.h[0] + 0.34 || Math.abs(l[2]) > c.h[2] + 0.34) continue;
          if (c.top <= 0.62) { if (c.top > h) h = c.top; }
          else if (c.bottom < 1.9) blocked = true;
        }
        const idx = j * N + i;
        this.nav.walk[idx] = blocked ? 0 : 1;
        this.nav.height[idx] = h;
      }
    }
    // Erode by one cell so bots don't hug corners.
    const w2 = this.nav.walk.slice();
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (!w2[j * N + i]) continue;
        let ok = 1;
        for (let dj = -1; dj <= 1 && ok; dj++) {
          for (let di = -1; di <= 1; di++) {
            const a = i + di, b = j + dj;
            if (a < 0 || b < 0 || a >= N || b >= N || !w2[b * N + a]) { ok = 0; break; }
          }
        }
        this.nav.walk[j * N + i] = ok ? 1 : 2;   // 2 = walkable but tight
      }
    }
  }

  navIndex(x, z) {
    const { N, S } = this.nav;
    const i = clamp(Math.floor((x + ARENA) / S), 0, N - 1);
    const j = clamp(Math.floor((z + ARENA) / S), 0, N - 1);
    return { i, j, idx: j * N + i };
  }

  /* ------------------------------------------------------------ raycast */

  /** Slab test against every collider. Returns {t, nx,ny,nz, kind} or null. */
  raycast(o, d, maxT = 200, skip = null) {
    let bestT = maxT, hit = null;
    for (const c of this.colliders) {
      if (c === skip) continue;
      // Transform ray into the box's local frame.
      const dx = o[0] - c.c[0], dz = o[2] - c.c[2];
      const ox = dx * c.cos + dz * c.sin, oy = o[1] - c.c[1], oz = -dx * c.sin + dz * c.cos;
      const rx = d[0] * c.cos + d[2] * c.sin, ry = d[1], rz = -d[0] * c.sin + d[2] * c.cos;

      let tmin = -Infinity, tmax = bestT;
      let nAxis = 0, nSign = 1;
      const oo = [ox, oy, oz], rr = [rx, ry, rz];
      let miss = false;
      for (let a = 0; a < 3; a++) {
        const h = c.h[a];
        if (Math.abs(rr[a]) < 1e-8) {
          if (oo[a] < -h || oo[a] > h) { miss = true; break; }
        } else {
          const inv = 1 / rr[a];
          let t1 = (-h - oo[a]) * inv, t2 = (h - oo[a]) * inv;
          let sgn = -1;
          if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sgn = 1; }
          if (t1 > tmin) { tmin = t1; nAxis = a; nSign = sgn; }
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) { miss = true; break; }
        }
      }
      if (miss || tmin < 0 || tmin > bestT) continue;
      bestT = tmin;
      const ln = [0, 0, 0];
      ln[nAxis] = nSign;
      const wn = [0, 0, 0];
      c.toWorldDir(ln, wn);
      hit = { t: tmin, nx: wn[0], ny: wn[1], nz: wn[2], kind: c.kind, collider: c };
    }
    // Ground plane.
    if (d[1] < -1e-6) {
      const t = -o[1] / d[1];
      if (t > 0 && t < bestT) {
        const gx = o[0] + d[0] * t, gz = o[2] + d[2] * t;
        if (Math.abs(gx) < 160 && Math.abs(gz) < 160) {
          hit = { t, nx: 0, ny: 1, nz: 0, kind: 'sand', collider: null };
        }
      }
    }
    return hit;
  }

  /** Cheap boolean line-of-sight. */
  visible(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.001) return true;
    const d = [dx / len, dy / len, dz / len];
    const h = this.raycast(a, d, len - 0.15);
    return !h;
  }

  upload(gl) {
    this.meshes = [];
    for (const [, b] of this.batches.map) {
      if (b.builder.idx.length === 0) continue;
      this.meshes.push({ mesh: b.builder.build(gl), mat: b.mat });
    }
    this.batches = null;
    return this.meshes;
  }
}
