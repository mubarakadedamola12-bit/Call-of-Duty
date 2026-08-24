// Weapon definitions and procedurally-modelled viewmodels.
//
// Gun-local space: origin at the grip reference, muzzle points down -Z, +Y up,
// +X to the shooter's right. The optic centre sits at (0, sightY, sightZ) so
// aiming down sights is just a translation of -sightY on the viewmodel.

import { Builder, boxGeo, cylinderGeo, sphereGeo } from '../render/geometry.js';
import { MAT } from '../render/textures.js';
import { defaultMaterial } from '../render/renderer.js';
import { M4, m4 } from '../core/math.js';

const _x = m4();

const M = {
  metal: { layer: MAT.GUNMETAL, uvScale: [3.2, 3.2], tint: [1, 1, 1], rough: 1.0, metal: 1, normalScale: 0.9 },
  metalDark: { layer: MAT.GUNMETAL, uvScale: [4.0, 4.0], tint: [0.62, 0.64, 0.70], rough: 0.85, metal: 1 },
  poly: { layer: MAT.POLYMER, uvScale: [5.0, 5.0], tint: [1, 1, 1], rough: 1, metal: 1, normalScale: 1.0 },
  polyTan: { layer: MAT.POLYMER, uvScale: [5.0, 5.0], tint: [3.4, 2.7, 1.75], rough: 1.0, metal: 1 },
  wood: { layer: MAT.WOOD, uvScale: [1.6, 1.6], tint: [0.85, 0.78, 0.70], rough: 0.85, metal: 1 },
  glow: { layer: MAT.GUNMETAL, uvScale: [1, 1], tint: [0.2, 0.2, 0.2], emissive: [7.0, 0.6, 0.35], rough: 1, metal: 0 },
  glowGreen: { layer: MAT.GUNMETAL, uvScale: [1, 1], tint: [0.2, 0.2, 0.2], emissive: [0.6, 6.0, 1.4], rough: 1, metal: 0 },
  glass: { layer: MAT.GLASSDIRT, uvScale: [2, 2], tint: [1, 1, 1], rough: 0.25, metal: 0.9 },
};

class GunParts {
  constructor() { this.b = new Map(); }
  get(name) {
    let e = this.b.get(name);
    if (!e) {
      const mat = defaultMaterial();
      Object.assign(mat, M[name]);
      e = { builder: new Builder(), mat };
      this.b.set(name, e);
    }
    return e.builder;
  }
  box(name, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0, uvS = 1) {
    M4.compose(_x, x, y, z, rx, ry, rz);
    this.get(name).add(boxGeo(w, h, d), _x, uvS);
    return this;
  }
  cyl(name, r, h, x, y, z, rx = 0, ry = 0, rz = 0, seg = 14, rTop = null) {
    M4.compose(_x, x, y, z, rx, ry, rz);
    this.get(name).add(cylinderGeo(r, h, seg, true, rTop), _x, 1);
    return this;
  }
  /** Cylinder oriented along -Z (barrels, tubes, suppressors). */
  tube(name, r, len, x, y, z, seg = 14, rTop = null) {
    return this.cyl(name, r, len, x, y, z, Math.PI / 2, 0, 0, seg, rTop);
  }
  sph(name, r, x, y, z, sx = 1, sy = 1, sz = 1) {
    M4.compose(_x, x, y, z, 0, 0, 0, sx, sy, sz);
    this.get(name).add(sphereGeo(r, 12, 8), _x, 1);
    return this;
  }
  build(gl) {
    const out = [];
    for (const [, e] of this.b) {
      if (e.builder.idx.length) out.push({ mesh: e.builder.build(gl), mat: e.mat });
    }
    return out;
  }
}

/* ---------------------------------------------------- shared sub-assemblies */

function addRailSection(p, x, y, z, len, slots) {
  p.box('metalDark', 0.026, 0.010, len, x, y, z, 0, 0, 0, 3);
  for (let i = 0; i < slots; i++) {
    p.box('metalDark', 0.030, 0.008, 0.0075, x, y + 0.008, z - len / 2 + 0.012 + i * (len / slots), 0, 0, 0, 3);
  }
}

/** Red-dot: tube body, glass, and a small emissive dot at the reticle plane. */
function addRedDot(p, x, y, z) {
  p.box('metalDark', 0.036, 0.030, 0.090, x, y + 0.018, z, 0, 0, 0, 3);
  p.box('metalDark', 0.044, 0.044, 0.010, x, y + 0.032, z - 0.043, 0, 0, 0, 3);
  p.box('metalDark', 0.044, 0.044, 0.010, x, y + 0.032, z + 0.043, 0, 0, 0, 3);
  p.box('glass', 0.034, 0.034, 0.003, x, y + 0.032, z - 0.040);
  p.box('glow', 0.0035, 0.0035, 0.002, x, y + 0.032, z - 0.036);
  p.box('metalDark', 0.010, 0.012, 0.020, x + 0.020, y + 0.030, z + 0.010, 0, 0, 0, 3);
  return y + 0.032;
}

function addMagAR(p, x, y, z, curve = 1) {
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const yy = y - t * 0.150;
    const zz = z + Math.pow(t, 1.7) * 0.030 * curve;
    p.box('poly', 0.026, 0.036, 0.070 - t * 0.004, x, yy, zz, curve * t * 0.30, 0, 0, 4);
  }
  p.box('poly', 0.030, 0.014, 0.062, x, y - 0.152, z + 0.030 * curve, curve * 0.30, 0, 0, 4);
}

function addStockCollapsible(p, x, y, z) {
  p.box('metalDark', 0.020, 0.020, 0.150, x, y, z + 0.075, 0, 0, 0, 3);
  p.box('poly', 0.048, 0.052, 0.110, x, y - 0.004, z + 0.170, 0, 0, 0, 4);
  p.box('poly', 0.052, 0.090, 0.026, x, y - 0.020, z + 0.232, -0.06, 0, 0, 4);
  p.box('poly', 0.040, 0.030, 0.075, x, y + 0.036, z + 0.150, 0, 0, 0, 4);
}

function addPistolGrip(p, x, y, z, ang = 0.34) {
  p.box('poly', 0.036, 0.115, 0.052, x, y - 0.062, z + 0.030, ang, 0, 0, 5);
  p.box('poly', 0.038, 0.026, 0.056, x, y - 0.122, z + 0.052, ang, 0, 0, 5);
  p.box('metalDark', 0.016, 0.038, 0.012, x, y - 0.020, z - 0.005, 0, 0, 0, 4);   // trigger guard face
  p.box('metalDark', 0.010, 0.024, 0.008, x, y - 0.028, z + 0.004, 0.25, 0, 0, 4); // trigger
}

/* --------------------------------------------------------------- weapons */

function buildKilo(gl) {
  const p = new GunParts();
  // Upper receiver + handguard
  p.box('metal', 0.052, 0.060, 0.230, 0, 0.030, -0.030, 0, 0, 0, 3);
  p.box('poly', 0.050, 0.052, 0.230, 0, 0.026, -0.255, 0, 0, 0, 4);
  for (let i = 0; i < 7; i++) {
    p.box('poly', 0.056, 0.012, 0.016, 0, 0.026, -0.170 - i * 0.028, 0, 0, 0, 5);
  }
  addRailSection(p, 0, 0.062, -0.150, 0.44, 22);
  // Barrel + muzzle brake
  p.tube('metalDark', 0.011, 0.230, 0, 0.026, -0.480, 12);
  p.tube('metalDark', 0.018, 0.055, 0, 0.026, -0.615, 12);
  for (let i = 0; i < 3; i++) p.box('metalDark', 0.040, 0.006, 0.010, 0, 0.026, -0.600 + i * 0.016);
  // Gas block + front sight
  p.box('metalDark', 0.026, 0.030, 0.040, 0, 0.040, -0.380);
  p.box('metalDark', 0.008, 0.028, 0.008, 0, 0.062, -0.380);
  // Ejection port + charging handle
  p.box('metalDark', 0.008, 0.026, 0.070, 0.028, 0.036, -0.040, 0, 0, 0, 3);
  p.box('metalDark', 0.056, 0.014, 0.018, 0, 0.058, 0.080, 0, 0, 0, 3);
  // Lower
  p.box('metal', 0.044, 0.052, 0.150, 0, -0.008, 0.005, 0, 0, 0, 3);
  addPistolGrip(p, 0, -0.024, 0.052);
  addMagAR(p, 0, -0.036, -0.030, 1);
  addStockCollapsible(p, 0, 0.020, 0.070);
  const sightY = addRedDot(p, 0, 0.066, -0.100);
  // Foregrip
  p.box('poly', 0.030, 0.070, 0.032, 0, -0.020, -0.300, 0.10, 0, 0, 5);
  return { parts: p.build(gl), sightY, sightZ: -0.100, muzzle: [0, 0.026, -0.645], eject: [0.045, 0.036, -0.030], mag: [0, -0.11, -0.02], grip: [0, -0.072, 0.082], support: [0, -0.052, -0.300] };
}

function buildVector(gl) {
  const p = new GunParts();
  p.box('poly', 0.048, 0.080, 0.210, 0, 0.024, -0.020, 0, 0, 0, 4);
  p.box('poly', 0.050, 0.048, 0.150, 0, 0.010, -0.190, 0, 0, 0, 4);
  addRailSection(p, 0, 0.066, -0.100, 0.30, 15);
  p.tube('metalDark', 0.010, 0.150, 0, 0.014, -0.320, 12);
  p.tube('metalDark', 0.021, 0.090, 0, 0.014, -0.430, 12);   // suppressor-ish shroud
  for (let i = 0; i < 5; i++) p.cyl('metalDark', 0.023, 0.004, 0, 0.014, -0.400 - i * 0.018, Math.PI / 2, 0, 0, 12);
  p.box('metalDark', 0.008, 0.022, 0.055, 0.026, 0.030, -0.020, 0, 0, 0, 3);
  addPistolGrip(p, 0, -0.026, 0.040, 0.28);
  for (let i = 0; i < 4; i++) {
    p.box('poly', 0.024, 0.030, 0.056, 0, -0.058 - i * 0.030, -0.050 + i * 0.006, 0.12, 0, 0, 4);
  }
  p.box('poly', 0.026, 0.016, 0.050, 0, -0.180, -0.028, 0.12, 0, 0, 4);
  // Folding stock
  p.box('metalDark', 0.016, 0.016, 0.130, 0.020, 0.040, 0.140, 0, 0, 0, 3);
  p.box('poly', 0.044, 0.070, 0.022, 0.010, 0.030, 0.210, 0, 0, 0, 4);
  p.box('poly', 0.034, 0.052, 0.030, 0, -0.014, -0.245, 0.14, 0, 0, 5);
  const sightY = addRedDot(p, 0, 0.070, -0.060);
  return { parts: p.build(gl), sightY, sightZ: -0.060, muzzle: [0, 0.014, -0.478], eject: [0.042, 0.030, -0.020], mag: [0, -0.13, -0.03], grip: [0, -0.076, 0.070], support: [0, -0.040, -0.248] };
}

function buildSniper(gl) {
  const p = new GunParts();
  p.box('metal', 0.048, 0.062, 0.310, 0, 0.028, -0.010, 0, 0, 0, 3);
  p.box('polyTan', 0.056, 0.060, 0.300, 0, 0.006, -0.290, 0, 0, 0, 4);
  p.tube('metalDark', 0.014, 0.400, 0, 0.028, -0.560, 14);
  p.tube('metalDark', 0.022, 0.080, 0, 0.028, -0.790, 14);
  for (let i = 0; i < 4; i++) p.box('metalDark', 0.048, 0.005, 0.012, 0, 0.028, -0.775 + i * 0.018);
  // Bolt handle
  p.box('metalDark', 0.014, 0.014, 0.055, 0.034, 0.040, 0.030, 0, 0, 0, 3);
  p.sph('metalDark', 0.016, 0.062, 0.040, 0.048);
  // Scope: 30mm tube on tall rings
  p.box('metalDark', 0.024, 0.036, 0.020, 0, 0.070, -0.070);
  p.box('metalDark', 0.024, 0.036, 0.020, 0, 0.070, 0.055);
  p.tube('metalDark', 0.021, 0.300, 0, 0.094, -0.020, 16);
  p.tube('metalDark', 0.031, 0.070, 0, 0.094, -0.180, 16);
  p.tube('metalDark', 0.027, 0.060, 0, 0.094, 0.115, 16);
  p.box('glass', 0.048, 0.048, 0.003, 0, 0.094, -0.212);
  p.box('glass', 0.040, 0.040, 0.003, 0, 0.094, 0.142);
  p.box('glow', 0.0030, 0.0030, 0.002, 0, 0.094, 0.138);
  for (let i = 0; i < 6; i++) p.box('metalDark', 0.030, 0.008, 0.006, 0, 0.116, 0.050 + i * 0.010);
  addPistolGrip(p, 0, -0.020, 0.070, 0.30);
  // Magazine
  p.box('metal', 0.030, 0.070, 0.075, 0, -0.058, -0.020, 0, 0, 0, 4);
  // Fixed stock with cheek riser
  p.box('polyTan', 0.050, 0.080, 0.240, 0, 0.006, 0.230, 0, 0, 0, 4);
  p.box('polyTan', 0.048, 0.036, 0.130, 0, 0.058, 0.190, 0, 0, 0, 4);
  p.box('polyTan', 0.052, 0.110, 0.028, 0, -0.010, 0.348, -0.05, 0, 0, 4);
  // Bipod
  for (const s of [-1, 1]) p.cyl('metalDark', 0.007, 0.140, s * 0.030, -0.055, -0.400, 0, 0, s * 0.30, 8);
  const sightY = 0.094;
  return { parts: p.build(gl), sightY, sightZ: -0.020, muzzle: [0, 0.028, -0.828], eject: [0.045, 0.040, 0.010], mag: [0, -0.09, -0.02], grip: [0, -0.068, 0.100], support: [0, -0.040, -0.300], scoped: true };
}

function buildShotgun(gl) {
  const p = new GunParts();
  p.box('metal', 0.046, 0.056, 0.220, 0, 0.028, 0.010, 0, 0, 0, 3);
  p.tube('metalDark', 0.019, 0.520, 0, 0.036, -0.380, 14);
  p.tube('metalDark', 0.016, 0.430, 0, 0.002, -0.330, 12);   // magazine tube
  p.box('metalDark', 0.008, 0.026, 0.008, 0, 0.058, -0.620);  // bead sight
  // Pump
  p.box('wood', 0.050, 0.048, 0.150, 0, 0.000, -0.290, 0, 0, 0, 3);
  for (let i = 0; i < 6; i++) p.box('wood', 0.056, 0.010, 0.012, 0, 0.000, -0.230 - i * 0.024, 0, 0, 0, 3);
  addPistolGrip(p, 0, -0.020, 0.060, 0.32);
  p.box('wood', 0.048, 0.076, 0.230, 0, 0.010, 0.220, 0, 0, 0, 3);
  p.box('wood', 0.050, 0.104, 0.026, 0, -0.004, 0.335, -0.06, 0, 0, 3);
  p.box('metalDark', 0.008, 0.024, 0.060, 0.026, 0.030, 0.010, 0, 0, 0, 3);
  // Shell carrier on the receiver
  for (let i = 0; i < 4; i++) p.cyl('glowGreen', 0.010, 0.052, -0.030, 0.048, -0.040 + i * 0.028, Math.PI / 2, 0, 0, 8);
  const sightY = 0.058;
  return { parts: p.build(gl), sightY, sightZ: -0.620, muzzle: [0, 0.036, -0.645], eject: [0.042, 0.030, 0.010], mag: [0, -0.06, 0.0], grip: [0, -0.066, 0.090], support: [0, -0.036, -0.292] };
}

function buildPistol(gl) {
  const p = new GunParts();
  p.box('metalDark', 0.032, 0.042, 0.185, 0, 0.020, -0.040, 0, 0, 0, 4);   // slide
  for (let i = 0; i < 6; i++) p.box('metalDark', 0.034, 0.024, 0.006, 0, 0.020, 0.020 - i * 0.012, 0, 0, 0, 4);
  p.tube('metalDark', 0.008, 0.030, 0, 0.020, -0.140, 10);
  p.box('metal', 0.030, 0.030, 0.140, 0, -0.010, -0.020, 0, 0, 0, 4);      // frame
  p.box('poly', 0.032, 0.110, 0.048, 0, -0.070, 0.024, 0.22, 0, 0, 5);     // grip
  p.box('metalDark', 0.008, 0.020, 0.008, 0, -0.024, 0.000, 0.2, 0, 0, 4);
  p.box('glow', 0.004, 0.005, 0.004, 0, 0.044, -0.126);
  p.box('metalDark', 0.020, 0.012, 0.014, 0, 0.044, 0.038);
  p.box('glow', 0.003, 0.004, 0.004, -0.006, 0.046, 0.036);
  p.box('glow', 0.003, 0.004, 0.004, 0.006, 0.046, 0.036);
  const sightY = 0.046;
  return { parts: p.build(gl), sightY, sightZ: -0.045, muzzle: [0, 0.020, -0.158], eject: [0.026, 0.030, -0.020], mag: [0, -0.10, 0.02], grip: [0, -0.086, 0.038], support: [0, -0.070, 0.010] };
}

function buildGrenade(gl) {
  const p = new GunParts();
  p.sph('poly', 0.036, 0, 0, 0, 1, 1.25, 1);
  p.cyl('metalDark', 0.014, 0.020, 0, 0.048, 0);
  p.box('metalDark', 0.010, 0.055, 0.006, 0.016, 0.038, 0, 0, 0, 0.15);
  p.cyl('metalDark', 0.010, 0.004, -0.016, 0.048, 0);
  return { parts: p.build(gl), sightY: 0, sightZ: 0, muzzle: [0, 0, 0], eject: [0, 0, 0], mag: [0, 0, 0] };
}

/* ------------------------------------------------------------------ stats */
// TTK-first tuning: no hipfire bloom — accuracy is a pure function of recoil
// and movement, so every shot is readable (per the modern CoD design goal).

export const WEAPONS = [
  {
    id: 'kilo', name: 'KILO 7', class: 'ASSAULT RIFLE', build: buildKilo,
    rpm: 720, damage: 27, headMul: 2.1, limbMul: 0.88,
    falloffStart: 26, falloffEnd: 55, falloffMin: 0.62,
    mag: 30, reserve: 210, reloadTime: 1.95, reloadEmptyTime: 2.45,
    adsTime: 0.245, adsFov: 0.68, spreadHip: 0.030, spreadAds: 0.0016, moveSpread: 0.028,
    recoil: { v: 0.72, h: 0.34, rand: 0.30, recover: 9.0, kickBack: 0.030, kickRot: 0.075, visualMul: 1.0 },
    sound: { body: 155, crack: 2900, dur: 0.30, punch: 1.0, tail: 0.60 },
    muzzleScale: 1.0, tracerEvery: 3, moveMul: 1.0, auto: true, bullets: 1,
    penetration: 0.35, switchTime: 0.55,
  },
  {
    id: 'vector', name: 'VECTOR 9', class: 'SUBMACHINE GUN', build: buildVector,
    rpm: 960, damage: 22, headMul: 1.85, limbMul: 0.90,
    falloffStart: 14, falloffEnd: 34, falloffMin: 0.48,
    mag: 32, reserve: 224, reloadTime: 1.70, reloadEmptyTime: 2.15,
    adsTime: 0.180, adsFov: 0.76, spreadHip: 0.024, spreadAds: 0.0028, moveSpread: 0.016,
    recoil: { v: 0.58, h: 0.46, rand: 0.42, recover: 10.5, kickBack: 0.024, kickRot: 0.062, visualMul: 0.9 },
    sound: { body: 128, crack: 2300, dur: 0.24, punch: 0.82, tail: 0.42, supp: 1 },
    muzzleScale: 0.72, tracerEvery: 4, moveMul: 1.08, auto: true, bullets: 1,
    penetration: 0.20, switchTime: 0.45,
  },
  {
    id: 'sniper', name: 'SR-338', class: 'SNIPER RIFLE', build: buildSniper,
    rpm: 48, damage: 130, headMul: 2.0, limbMul: 0.78,
    falloffStart: 120, falloffEnd: 160, falloffMin: 0.90,
    mag: 5, reserve: 40, reloadTime: 2.9, reloadEmptyTime: 3.3,
    adsTime: 0.390, adsFov: 0.20, spreadHip: 0.090, spreadAds: 0.0002, moveSpread: 0.050,
    recoil: { v: 3.10, h: 0.70, rand: 0.35, recover: 3.6, kickBack: 0.100, kickRot: 0.30, visualMul: 1.6 },
    sound: { body: 105, crack: 3600, dur: 0.52, punch: 1.6, tail: 1.0 },
    muzzleScale: 1.6, tracerEvery: 1, moveMul: 0.88, auto: false, bullets: 1,
    penetration: 0.85, switchTime: 0.80, boltTime: 0.95, scope: true,
  },
  {
    id: 'shotgun', name: 'M-1014', class: 'SHOTGUN', build: buildShotgun,
    rpm: 180, damage: 22, headMul: 1.4, limbMul: 0.95,
    falloffStart: 7, falloffEnd: 18, falloffMin: 0.12,
    mag: 7, reserve: 42, reloadTime: 0.55, reloadEmptyTime: 0.55, shellReload: true,
    adsTime: 0.260, adsFov: 0.86, spreadHip: 0.055, spreadAds: 0.038, moveSpread: 0.012,
    recoil: { v: 1.85, h: 0.55, rand: 0.45, recover: 5.5, kickBack: 0.070, kickRot: 0.20, visualMul: 1.3 },
    sound: { body: 118, crack: 2000, dur: 0.42, punch: 1.4, tail: 0.85 },
    muzzleScale: 1.5, tracerEvery: 0, moveMul: 0.96, auto: false, bullets: 8,
    penetration: 0.10, switchTime: 0.60,
  },
  {
    id: 'pistol', name: 'P-45', class: 'SIDEARM', build: buildPistol,
    rpm: 420, damage: 30, headMul: 1.9, limbMul: 0.85,
    falloffStart: 12, falloffEnd: 30, falloffMin: 0.45,
    mag: 15, reserve: 90, reloadTime: 1.45, reloadEmptyTime: 1.85,
    adsTime: 0.170, adsFov: 0.80, spreadHip: 0.028, spreadAds: 0.0035, moveSpread: 0.018,
    recoil: { v: 1.10, h: 0.42, rand: 0.38, recover: 11.0, kickBack: 0.030, kickRot: 0.10, visualMul: 1.0 },
    sound: { body: 140, crack: 2600, dur: 0.26, punch: 0.85, tail: 0.45 },
    muzzleScale: 0.85, tracerEvery: 0, moveMul: 1.14, auto: false, bullets: 1,
    penetration: 0.15, switchTime: 0.35,
  },
];

export const GRENADE = { build: buildGrenade, fuse: 3.1, radius: 8.0, damage: 150, throwSpeed: 15.5 };

export function buildAllWeapons(gl) {
  const out = {};
  for (const w of WEAPONS) out[w.id] = { ...w, model: w.build(gl) };
  out.grenade = { ...GRENADE, model: GRENADE.build(gl) };
  return out;
}

/**
 * Deterministic recoil pattern with a small random component — the shape is
 * learnable (the point of a pattern) but not perfectly repeatable.
 */
export function recoilStep(w, shotIndex) {
  const r = w.recoil;
  const n = shotIndex;
  // Steep initial climb that flattens, then a lateral S-curve.
  const climb = (1 - Math.exp(-n * 0.55)) * 0.55 + 0.45;
  const vert = r.v * climb * (0.85 + Math.sin(n * 1.7) * 0.15);
  const wave = Math.sin(n * 0.62) * 0.7 + Math.sin(n * 0.27 + 1.1) * 0.5;
  const horiz = r.h * wave * Math.min(1, n * 0.20);
  return {
    pitch: (vert + (Math.random() - 0.5) * r.v * r.rand) * 0.01,
    yaw: (horiz + (Math.random() - 0.5) * r.h * r.rand * 2) * 0.01,
  };
}
