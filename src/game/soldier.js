// A skinned humanoid soldier: one continuous surface over a 17-bone rig.
//
// Proportions are taken from a ~1.78 m adult at roughly 7.4 heads tall, which
// is what stops it reading as a toy. Everything is lofted through elliptical
// cross-sections — bodies are not round, so a chest is wide and shallow while
// an upper arm is nearly circular, and that difference is most of what sells a
// silhouette as human.

import { Skeleton, SkinBuilder, loft } from '../render/skinning.js';
import { MAT } from '../render/textures.js';
import { clamp, lerp } from '../core/math.js';

/* ------------------------------------------------------------- skeleton */

export const BONE = {
  pelvis: 0, spine: 1, chest: 2, neck: 3, head: 4,
  lClav: 5, lArm: 6, lFore: 7, lHand: 8,
  rClav: 9, rArm: 10, rFore: 11, rHand: 12,
  lThigh: 13, lShin: 14, lFoot: 15,
  rThigh: 16, rShin: 17, rFoot: 18,
};

// Bind pose, in metres, origin at the feet.
const BONES = [
  { name: 'pelvis', parent: -1, head: [0, 0.960, 0] },
  { name: 'spine', parent: 0, head: [0, 1.100, 0] },
  { name: 'chest', parent: 1, head: [0, 1.270, 0] },
  { name: 'neck', parent: 2, head: [0, 1.470, 0] },
  { name: 'head', parent: 3, head: [0, 1.560, 0] },

  { name: 'lClav', parent: 2, head: [-0.055, 1.430, 0] },
  { name: 'lArm', parent: 5, head: [-0.190, 1.440, 0] },
  { name: 'lFore', parent: 6, head: [-0.190, 1.170, 0] },
  { name: 'lHand', parent: 7, head: [-0.190, 0.925, 0] },

  { name: 'rClav', parent: 2, head: [0.055, 1.430, 0] },
  { name: 'rArm', parent: 9, head: [0.190, 1.440, 0] },
  { name: 'rFore', parent: 10, head: [0.190, 1.170, 0] },
  { name: 'rHand', parent: 11, head: [0.190, 0.925, 0] },

  { name: 'lThigh', parent: 0, head: [-0.098, 0.930, 0] },
  { name: 'lShin', parent: 13, head: [-0.098, 0.500, 0] },
  { name: 'lFoot', parent: 14, head: [-0.098, 0.075, 0] },

  { name: 'rThigh', parent: 0, head: [0.098, 0.930, 0] },
  { name: 'rShin', parent: 16, head: [0.098, 0.500, 0] },
  { name: 'rFoot', parent: 17, head: [0.098, 0.075, 0] },
];

export function makeSkeleton() { return new Skeleton(BONES); }

/* ------------------------------------------------------------ materials */

const M = {
  camo: (tint) => ({ layer: MAT.FATIGUES, tint }),
  gear: { layer: MAT.POLYMER, tint: [0.80, 0.83, 0.88] },
  gearTan: { layer: MAT.POLYMER, tint: [2.4, 1.95, 1.30] },
  glove: { layer: MAT.POLYMER, tint: [0.62, 0.60, 0.58] },
  boot: { layer: MAT.POLYMER, tint: [0.42, 0.40, 0.40] },
  helmet: { layer: MAT.POLYMER, tint: [1.05, 1.08, 1.02] },
  skin: { layer: MAT.SANDBAG, tint: [1.55, 1.12, 0.86] },
  visor: { layer: MAT.GLASSDIRT, tint: [1.4, 1.3, 1.0] },
  metal: { layer: MAT.GUNMETAL, tint: [0.9, 0.9, 0.95] },
};

/** Blend two bones over a joint so the surface bends instead of creasing. */
const W = (a, b, t) => (t <= 0 ? [[a, 1]] : t >= 1 ? [[b, 1]] : [[a, 1 - t], [b, t]]);

/* -------------------------------------------------------------- the body */

export function buildSoldier(gl, camoTint) {
  const b = new SkinBuilder();
  const camo = M.camo(camoTint || [1, 1, 1]);
  const B = BONE;

  // --- torso: hips -> waist -> ribcage -> shoulders.
  // Elliptical throughout: humans are much wider than they are deep.
  b.add(loft([
    { c: [0, 0.905, 0.005], rx: 0.150, rz: 0.108, bones: W(B.pelvis, B.pelvis, 0) },
    { c: [0, 0.985, 0.004], rx: 0.163, rz: 0.113, bones: W(B.pelvis, B.pelvis, 0) },
    { c: [0, 1.060, 0.002], rx: 0.150, rz: 0.104, bones: W(B.pelvis, B.spine, 0.45) },
    { c: [0, 1.135, 0.000], rx: 0.146, rz: 0.100, bones: W(B.spine, B.spine, 0) },
    { c: [0, 1.215, 0.002], rx: 0.164, rz: 0.112, bones: W(B.spine, B.chest, 0.55) },
    { c: [0, 1.300, 0.004], rx: 0.184, rz: 0.122, bones: W(B.chest, B.chest, 0) },
    { c: [0, 1.375, 0.002], rx: 0.190, rz: 0.120, bones: W(B.chest, B.chest, 0) },
    { c: [0, 1.440, -0.004], rx: 0.168, rz: 0.108, bones: W(B.chest, B.chest, 0) },
    { c: [0, 1.478, -0.008], rx: 0.100, rz: 0.086, bones: W(B.chest, B.neck, 0.6) },
  ], 18), camo, 2.0);

  // --- neck
  b.add(loft([
    { c: [0, 1.455, -0.006], rx: 0.058, rz: 0.058, bones: W(B.chest, B.neck, 0.5) },
    { c: [0, 1.530, -0.004], rx: 0.052, rz: 0.054, bones: W(B.neck, B.head, 0.4) },
  ], 12, false, false), M.skin, 2.4);

  // --- head: cranium, then jaw/chin, so it is not a ball
  b.add(loft([
    { c: [0, 1.545, -0.004], rx: 0.070, rz: 0.078, bones: W(B.head, B.head, 0) },
    { c: [0, 1.585, -0.006], rx: 0.083, rz: 0.093, bones: W(B.head, B.head, 0) },
    { c: [0, 1.628, -0.004], rx: 0.089, rz: 0.098, bones: W(B.head, B.head, 0) },
    { c: [0, 1.672, 0.000], rx: 0.086, rz: 0.094, bones: W(B.head, B.head, 0) },
    { c: [0, 1.706, 0.006], rx: 0.070, rz: 0.076, bones: W(B.head, B.head, 0) },
    { c: [0, 1.726, 0.010], rx: 0.040, rz: 0.044, bones: W(B.head, B.head, 0) },
  ], 16), M.skin, 2.6);

  // --- helmet shell, sitting proud of the cranium
  b.add(loft([
    { c: [0, 1.632, -0.002], rx: 0.101, rz: 0.110, bones: W(B.head, B.head, 0) },
    { c: [0, 1.672, 0.002], rx: 0.101, rz: 0.108, bones: W(B.head, B.head, 0) },
    { c: [0, 1.712, 0.006], rx: 0.090, rz: 0.096, bones: W(B.head, B.head, 0) },
    { c: [0, 1.740, 0.008], rx: 0.062, rz: 0.066, bones: W(B.head, B.head, 0) },
    { c: [0, 1.752, 0.008], rx: 0.026, rz: 0.028, bones: W(B.head, B.head, 0) },
  ], 16, false, true), M.helmet, 2.2);

  // Helmet brim and rear lip.
  b.add(loft([
    { c: [0, 1.630, -0.004], rx: 0.104, rz: 0.113, bones: W(B.head, B.head, 0) },
    { c: [0, 1.617, -0.004], rx: 0.107, rz: 0.116, bones: W(B.head, B.head, 0) },
  ], 16, false, false), M.helmet, 2.2);

  // Goggles across the brow.
  b.add(loft([
    { c: [-0.086, 1.640, -0.052], rx: 0.030, rz: 0.028, bones: W(B.head, B.head, 0) },
    { c: [0, 1.644, -0.082], rx: 0.034, rz: 0.030, bones: W(B.head, B.head, 0) },
    { c: [0.086, 1.640, -0.052], rx: 0.030, rz: 0.028, bones: W(B.head, B.head, 0) },
  ], 10, true, true), M.visor, 2.0);

  // --- plate carrier: a shell over the ribcage, front and back plates
  b.add(loft([
    { c: [0, 1.180, 0.004], rx: 0.176, rz: 0.126, bones: W(B.spine, B.chest, 0.4) },
    { c: [0, 1.260, 0.006], rx: 0.196, rz: 0.136, bones: W(B.chest, B.chest, 0) },
    { c: [0, 1.350, 0.005], rx: 0.201, rz: 0.134, bones: W(B.chest, B.chest, 0) },
    { c: [0, 1.418, -0.002], rx: 0.181, rz: 0.120, bones: W(B.chest, B.chest, 0) },
  ], 18, true, true), M.gear, 1.7);

  // Magazine pouches across the front of the carrier.
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 0.098;
    b.add(loft([
      { c: [x, 1.190, -0.132], rx: 0.043, rz: 0.030, bones: W(B.chest, B.chest, 0) },
      { c: [x, 1.268, -0.138], rx: 0.045, rz: 0.032, bones: W(B.chest, B.chest, 0) },
    ], 8), M.gearTan, 3.0);
  }
  // Radio on the left chest, canteen on the belt.
  b.add(loft([
    { c: [-0.150, 1.300, -0.070], rx: 0.036, rz: 0.030, bones: W(B.chest, B.chest, 0) },
    { c: [-0.152, 1.392, -0.066], rx: 0.034, rz: 0.028, bones: W(B.chest, B.chest, 0) },
  ], 8), M.gear, 3.0);
  b.add(loft([
    { c: [-0.010, 1.448, -0.060], rx: 0.010, rz: 0.010, bones: W(B.chest, B.chest, 0) },
    { c: [-0.020, 1.560, -0.048], rx: 0.007, rz: 0.007, bones: W(B.chest, B.head, 0.3) },
  ], 6, false, false), M.metal, 3.0);

  // --- daypack
  b.add(loft([
    { c: [0, 1.190, 0.140], rx: 0.140, rz: 0.062, bones: W(B.spine, B.chest, 0.4) },
    { c: [0, 1.290, 0.162], rx: 0.152, rz: 0.078, bones: W(B.chest, B.chest, 0) },
    { c: [0, 1.395, 0.150], rx: 0.140, rz: 0.070, bones: W(B.chest, B.chest, 0) },
    { c: [0, 1.440, 0.126], rx: 0.104, rz: 0.048, bones: W(B.chest, B.chest, 0) },
  ], 14), M.gearTan, 1.8);

  // --- belt
  b.add(loft([
    { c: [0, 1.010, 0.003], rx: 0.170, rz: 0.119, bones: W(B.pelvis, B.pelvis, 0) },
    { c: [0, 1.052, 0.002], rx: 0.168, rz: 0.117, bones: W(B.pelvis, B.spine, 0.3) },
  ], 16, false, false), M.gearTan, 2.6);

  /* ------------------------------------------------------------- limbs */

  for (const side of [-1, 1]) {
    const L = side < 0;
    const arm = L ? B.lArm : B.rArm;
    const fore = L ? B.lFore : B.rFore;
    const hand = L ? B.lHand : B.rHand;
    const clav = L ? B.lClav : B.rClav;
    const sx = side * 0.190;

    // Shoulder cap -> upper arm -> elbow. The deltoid bulge is what keeps a
    // shoulder from looking like a pipe stuck into a box.
    b.add(loft([
      { c: [side * 0.120, 1.462, 0], rx: 0.086, rz: 0.086, bones: W(B.chest, arm, 0.35) },
      { c: [side * 0.172, 1.440, 0], rx: 0.078, rz: 0.079, bones: W(clav, arm, 0.75) },
      { c: [sx, 1.372, 0], rx: 0.062, rz: 0.064, bones: W(arm, arm, 0) },
      { c: [sx, 1.270, 0], rx: 0.053, rz: 0.055, bones: W(arm, arm, 0) },
      { c: [sx, 1.196, 0], rx: 0.048, rz: 0.050, bones: W(arm, fore, 0.35) },
      { c: [sx, 1.168, 0], rx: 0.050, rz: 0.051, bones: W(arm, fore, 0.62) },
      // Forearm: swells at the top, tapers hard at the wrist.
      { c: [sx, 1.110, 0], rx: 0.050, rz: 0.049, bones: W(fore, fore, 0) },
      { c: [sx, 1.020, 0], rx: 0.042, rz: 0.040, bones: W(fore, fore, 0) },
      { c: [sx, 0.950, 0], rx: 0.033, rz: 0.030, bones: W(fore, hand, 0.35) },
    ], 14), camo, 2.2);

    // Glove: palm block plus a rolled finger mass.
    b.add(loft([
      { c: [sx, 0.930, 0], rx: 0.037, rz: 0.030, bones: W(fore, hand, 0.8) },
      { c: [sx, 0.884, -0.004], rx: 0.043, rz: 0.034, bones: W(hand, hand, 0) },
      { c: [sx, 0.838, -0.012], rx: 0.041, rz: 0.033, bones: W(hand, hand, 0) },
      { c: [sx, 0.812, -0.022], rx: 0.030, rz: 0.028, bones: W(hand, hand, 0) },
    ], 12), M.glove, 3.0);

    // Shoulder pad over the deltoid.
    b.add(loft([
      { c: [side * 0.132, 1.452, 0], rx: 0.094, rz: 0.094, bones: W(B.chest, arm, 0.4) },
      { c: [side * 0.182, 1.418, 0], rx: 0.084, rz: 0.085, bones: W(clav, arm, 0.8) },
      { c: [side * 0.196, 1.360, 0], rx: 0.068, rz: 0.070, bones: W(arm, arm, 0) },
    ], 14, false, false), M.gear, 2.2);
  }

  for (const side of [-1, 1]) {
    const L = side < 0;
    const thigh = L ? B.lThigh : B.rThigh;
    const shin = L ? B.lShin : B.rShin;
    const foot = L ? B.lFoot : B.rFoot;
    const sx = side * 0.098;

    b.add(loft([
      { c: [sx, 0.945, 0], rx: 0.098, rz: 0.101, bones: W(B.pelvis, thigh, 0.55) },
      { c: [sx, 0.860, 0.002], rx: 0.093, rz: 0.098, bones: W(thigh, thigh, 0) },
      { c: [sx, 0.720, 0.002], rx: 0.083, rz: 0.088, bones: W(thigh, thigh, 0) },
      { c: [sx, 0.580, 0.000], rx: 0.072, rz: 0.076, bones: W(thigh, thigh, 0) },
      // Knee
      { c: [sx, 0.512, -0.002], rx: 0.068, rz: 0.072, bones: W(thigh, shin, 0.45) },
      { c: [sx, 0.470, -0.002], rx: 0.070, rz: 0.074, bones: W(thigh, shin, 0.75) },
      // Calf belly, then a thin ankle.
      { c: [sx, 0.400, 0.006], rx: 0.068, rz: 0.076, bones: W(shin, shin, 0) },
      { c: [sx, 0.300, 0.004], rx: 0.059, rz: 0.064, bones: W(shin, shin, 0) },
      { c: [sx, 0.180, 0.000], rx: 0.044, rz: 0.046, bones: W(shin, shin, 0) },
      { c: [sx, 0.110, -0.002], rx: 0.040, rz: 0.042, bones: W(shin, foot, 0.4) },
    ], 14), camo, 2.2);

    // Boot: ankle collar, instep, toe.
    b.add(loft([
      { c: [sx, 0.130, -0.004], rx: 0.055, rz: 0.058, bones: W(shin, foot, 0.35) },
      { c: [sx, 0.075, -0.010], rx: 0.056, rz: 0.062, bones: W(foot, foot, 0) },
      { c: [sx, 0.042, -0.038], rx: 0.054, rz: 0.078, bones: W(foot, foot, 0) },
      { c: [sx, 0.028, -0.086], rx: 0.048, rz: 0.070, bones: W(foot, foot, 0) },
      { c: [sx, 0.022, -0.124], rx: 0.036, rz: 0.040, bones: W(foot, foot, 0) },
    ], 12), M.boot, 2.6);

    // Drop pouch on the thigh.
    b.add(loft([
      { c: [side * 0.148, 0.700, 0.006], rx: 0.044, rz: 0.052, bones: W(thigh, thigh, 0) },
      { c: [side * 0.152, 0.610, 0.004], rx: 0.042, rz: 0.050, bones: W(thigh, thigh, 0) },
    ], 8), M.gearTan, 3.0);
  }

  return b.build(gl);
}

/* ----------------------------------------------------------- animation */

const N = BONES.length;

/** Reusable pose buffer — evaluating a rig should not allocate. */
export function makePose() {
  const p = new Array(N);
  for (let i = 0; i < N; i++) p[i] = [0, 0, 0];
  return p;
}

const set = (p, i, x, y, z) => { const b = p[i]; b[0] = x; b[1] = y; b[2] = z; };

/**
 * Writes a full body pose. `aim` blends between a relaxed carry and both hands
 * up on the weapon; `speed`/`phase` drive the walk cycle; `crouch` folds the
 * legs and drops the hips.
 */
export function poseSoldier(pose, o) {
  const speed = o.speed || 0;
  const phase = o.phase || 0;
  const aim = clamp(o.aim === undefined ? 1 : o.aim, 0, 1);
  const crouch = clamp(o.crouch || 0, 0, 1);
  const pitch = clamp(o.pitch || 0, -0.7, 0.7);
  const dead = o.dead ? 1 : 0;
  const t = o.time || 0;

  const gait = clamp(speed / 5.5, 0, 1);
  const sw = Math.sin(phase) * gait;
  const sw2 = Math.sin(phase * 2);
  const breathe = Math.sin(t * 1.5) * 0.012 * (1 - gait * 0.7);

  // Spine: lean into the run, curl forward when crouched, slump when dead.
  const lean = -gait * 0.16 - crouch * 0.20 - dead * 0.5;
  set(pose, BONE.pelvis, dead * 0.9, 0, sw2 * 0.02 * gait + dead * 0.4);
  set(pose, BONE.spine, lean * 0.45 + breathe, sw2 * 0.035 * gait, 0);
  set(pose, BONE.chest, lean * 0.55 + breathe, -sw2 * 0.05 * gait, 0);
  set(pose, BONE.neck, -lean * 0.35 + pitch * 0.35, 0, 0);
  set(pose, BONE.head, -lean * 0.35 + pitch * 0.55 + (o.headYaw ? 0 : 0), o.headYaw || 0, 0);

  // Arms. Relaxed swing, or both hands brought onto the weapon.
  const relaxL = [sw * 0.55, 0, 0.13];
  const relaxR = [-sw * 0.55, 0, -0.13];
  // Support hand forward and across, trigger hand tucked in.
  const aimL = [-1.28, 0.28, 0.46];
  const aimR = [-1.12, -0.18, -0.24];
  for (const [bone, relax, aimed] of [[BONE.lArm, relaxL, aimL], [BONE.rArm, relaxR, aimR]]) {
    set(pose, bone,
      lerp(relax[0], aimed[0], aim) + pitch * 0.5 * aim,
      lerp(relax[1], aimed[1], aim),
      lerp(relax[2], aimed[2], aim));
  }
  set(pose, BONE.lFore, lerp(0.30 + Math.max(0, sw) * 0.4, 1.18, aim), 0, 0);
  set(pose, BONE.rFore, lerp(0.30 + Math.max(0, -sw) * 0.4, 0.72, aim), 0, 0);
  set(pose, BONE.lHand, 0, 0, lerp(0, -0.25, aim));
  set(pose, BONE.rHand, 0, 0, lerp(0, 0.20, aim));
  set(pose, BONE.lClav, 0, 0, aim * -0.10);
  set(pose, BONE.rClav, 0, 0, aim * 0.06);

  // Legs. Thigh swings, shin trails and straightens at the front of the step.
  for (const side of [-1, 1]) {
    const L = side < 0;
    const s = L ? sw : -sw;
    const thigh = L ? BONE.lThigh : BONE.rThigh;
    const shin = L ? BONE.lShin : BONE.rShin;
    const foot = L ? BONE.lFoot : BONE.rFoot;
    if (dead) {
      set(pose, thigh, -0.25, 0, side * 0.30);
      set(pose, shin, 0.55, 0, 0);
      set(pose, foot, 0.15, 0, 0);
      continue;
    }
    const swingT = -s * 0.62;
    set(pose, thigh, swingT - crouch * 0.95, 0, 0);
    set(pose, shin, Math.max(0, s) * 0.85 + 0.06 + crouch * 1.55, 0, 0);
    set(pose, foot, -swingT * 0.35 - crouch * 0.55 + 0.04, 0, 0);
  }
  return pose;
}

/** Vertical offset of the hips for a given stance, used to plant the feet. */
export function hipHeight(crouch, dead) {
  return dead ? -0.72 : -crouch * 0.34;
}
