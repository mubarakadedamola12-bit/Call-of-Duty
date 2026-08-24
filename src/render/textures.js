// Procedural PBR material atlas. Everything is generated at runtime — zero
// binary assets. Two TEXTURE_2D_ARRAYs are produced:
//   ALBEDO : rgb = base colour, a = baked cavity/AO
//   SURF   : rg  = tangent-space normal xy, b = roughness, a = metallic

import { mulberry32 } from '../core/math.js';

/* ------------------------------------------------------- tileable noise */

const PERM = new Uint8Array(512);
{
  const r = mulberry32(1337);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

const GX = new Float32Array(256), GY = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const a = (i / 256) * Math.PI * 2;
  GX[i] = Math.cos(a); GY[i] = Math.sin(a);
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Integer hash -> gradient index. A plain 256-entry permutation table CANNOT be
 * used here: the noise periods go well past 256, and `PERM[PERM[x] + y]` then
 * reads off the end of the array, yielding undefined -> NaN -> black holes
 * baked into the texture. This hash is period-agnostic.
 */
function gradIndex(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 255;
}

/** Perlin noise with integer period `per` on both axes → seamless tiling. */
function pnoise(x, y, per) {
  const P = per < 1 ? 1 : Math.round(per);
  let xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  xi = ((xi % P) + P) % P;
  yi = ((yi % P) + P) % P;
  const xi1 = (xi + 1) % P, yi1 = (yi + 1) % P;
  const u = fade(xf), v = fade(yf);
  const h00 = gradIndex(xi, yi), h10 = gradIndex(xi1, yi);
  const h01 = gradIndex(xi, yi1), h11 = gradIndex(xi1, yi1);
  const n00 = GX[h00] * xf + GY[h00] * yf;
  const n10 = GX[h10] * (xf - 1) + GY[h10] * yf;
  const n01 = GX[h01] * xf + GY[h01] * (yf - 1);
  const n11 = GX[h11] * (xf - 1) + GY[h11] * (yf - 1);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return a + v * (b - a);
}

function fbm(x, y, per, oct = 4, gain = 0.5, lac = 2) {
  let s = 0, a = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * pnoise(x * f, y * f, per * f);
    norm += a; a *= gain; f *= lac;
  }
  return s / norm;
}

const ridge = (x, y, per, oct) => 1 - Math.abs(fbm(x, y, per, oct)) * 2;

/** Tileable Worley/cellular noise → F1 distance in [0,1]. */
function worley(x, y, per) {
  const P = per < 1 ? 1 : Math.round(per);
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 8;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = (((xi + dx) % P) + P) % P;
      const cy = (((yi + dy) % P) + P) % P;
      const h = gradIndex(cx, cy);
      const px = xi + dx + (GX[h] * 0.5 + 0.5);
      const py = yi + dy + (GY[h] * 0.5 + 0.5);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

const sat = (v) => (v > 0 ? (v > 1 ? 1 : v) : 0);   // NaN-safe
const mix = (a, b, t) => a + (b - a) * t;
const step2 = (e0, e1, x) => { const t = sat((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/* ---------------------------------------------------------- material defs */
// Each generator fills (out, u, v) with [r,g,b, rough, metal, height, ao]
// u/v are in "tiles" (0..TILE), so noise frequencies read as world-ish detail.

const TILE = 8; // noise period — must divide evenly for seamlessness

export const MAT = {
  SAND: 0, CONCRETE: 1, CONTAINER: 2, CORRUGATED: 3, WOOD: 4, GUNMETAL: 5,
  POLYMER: 6, SANDBAG: 7, RUSTBARREL: 8, ASPHALT: 9, FATIGUES: 10, BRICK: 11,
  TARP: 12, GLASSDIRT: 13,
};
export const MAT_COUNT = 14;

const gens = new Array(MAT_COUNT);

gens[MAT.SAND] = (o, u, v) => {
  const g = fbm(u * 6, v * 6, TILE * 6, 5);
  const dunes = fbm(u * 1.5, v * 1.5, TILE * 1.5, 3);
  const grit = worley(u * 40, v * 40, TILE * 40);
  // Real dry sand sits around 0.30-0.45 albedo; higher than that clips under a
  // strong key light and the ground reads as white paper.
  const t = sat(0.5 + g * 0.6);
  const r = mix(0.335, 0.470, t) * mix(0.86, 1.06, grit);
  const gr = mix(0.255, 0.375, t) * mix(0.86, 1.06, grit);
  const b = mix(0.160, 0.248, t) * mix(0.86, 1.06, grit);
  o[0] = r * mix(0.9, 1.05, dunes * 0.5 + 0.5); o[1] = gr; o[2] = b;
  o[3] = mix(0.82, 0.96, t);
  o[4] = 0;
  o[5] = g * 0.35 + dunes * 0.5 + grit * 0.15;
  o[6] = mix(0.75, 1, grit);
};

gens[MAT.CONCRETE] = (o, u, v) => {
  const base = fbm(u * 5, v * 5, TILE * 5, 5);
  const pores = worley(u * 26, v * 26, TILE * 26);
  const stain = sat(fbm(u * 2 + 11, v * 2, TILE * 2, 3) * 1.6 + 0.35);
  const crack = sat(1 - Math.abs(ridge(u * 3, v * 3, TILE * 3, 3)) * 6);
  let l = mix(0.275, 0.430, sat(base * 0.9 + 0.5));
  l *= mix(0.72, 1.0, stain);
  l *= mix(0.55, 1.0, step2(0.02, 0.20, pores));
  l = mix(l, l * 0.35, crack);
  o[0] = l * 1.02; o[1] = l * 1.0; o[2] = l * 0.96;
  o[3] = mix(0.70, 0.94, sat(base + 0.5));
  o[4] = 0;
  o[5] = base * 0.5 + pores * 0.5 - crack * 1.4;
  o[6] = mix(0.45, 1, step2(0.0, 0.25, pores)) * mix(0.35, 1, 1 - crack);
};

gens[MAT.CONTAINER] = (o, u, v) => {
  // Painted corrugated container: vertical ribs + rust eating through.
  // Rib pitch is deliberately coarse — fine ribs alias into noise in motion.
  const rib = Math.cos(u * Math.PI * 2 * 3.5) * 0.5 + 0.5;
  const ribH = step2(0.20, 0.80, rib);
  const rustMask = sat(fbm(u * 3, v * 3, TILE * 3, 4) * 2.0 + 0.26);
  const rustFine = worley(u * 14, v * 14, TILE * 14);
  const scratch = sat(1 - Math.abs(ridge(u * 6, v * 6, TILE * 6, 2)) * 8);
  const paintR = 0.52, paintG = 0.135, paintB = 0.105;
  const rustR = 0.42, rustG = 0.215, rustB = 0.105;
  const t = sat(rustMask * 1.25 - 0.22);
  let r = mix(paintR, rustR * mix(0.78, 1.24, rustFine), t);
  let g = mix(paintG, rustG * mix(0.82, 1.20, rustFine), t);
  let b = mix(paintB, rustB * mix(0.82, 1.20, rustFine), t);
  const shade = mix(0.80, 1.10, ribH);
  r *= shade; g *= shade; b *= shade;
  r = mix(r, 0.50, scratch * 0.55); g = mix(g, 0.48, scratch * 0.55); b = mix(b, 0.47, scratch * 0.55);
  o[0] = r; o[1] = g; o[2] = b;
  o[3] = mix(0.42, 0.86, t) * mix(1, 0.65, scratch);
  // Painted steel is a dielectric; only the scratched-through metal is metallic.
  o[4] = mix(0.16, 0.05, t) + scratch * 0.72;
  o[5] = ribH * 1.5 + rustMask * 0.18 + rustFine * 0.07;
  o[6] = mix(0.68, 1, ribH) * mix(0.86, 1, rustFine);
};

gens[MAT.CORRUGATED] = (o, u, v) => {
  const wave = Math.cos(v * Math.PI * 2 * 4.0);
  const ribH = wave * 0.5 + 0.5;
  const rust = sat(fbm(u * 5 + 7, v * 5, TILE * 5, 4) * 1.9 + 0.22);
  const l = mix(0.38, 0.58, ribH) * mix(1, 0.78, rust);
  o[0] = l * mix(1, 1.32, rust); o[1] = l * mix(1, 0.94, rust); o[2] = l * mix(1.06, 0.70, rust);
  o[3] = mix(0.42, 0.84, rust);
  o[4] = mix(0.82, 0.14, rust);
  o[5] = ribH * 1.8;
  o[6] = mix(0.66, 1, ribH);
};

gens[MAT.WOOD] = (o, u, v) => {
  const plank = Math.floor(v * 5);
  const jitter = (PERM[(plank * 37) & 255] / 255 - 0.5);
  const gy = v * 5 - plank;
  const grain = fbm(u * 3 + jitter * 5, v * 26, TILE * 26, 4);
  const rings = Math.sin((u * 5 + grain * 2.2 + jitter * 3) * 9) * 0.5 + 0.5;
  const gap = step2(0.0, 0.05, gy) * step2(0.0, 0.05, 1 - gy);
  const knot = step2(0.35, 0.05, worley(u * 3 + 5, v * 3, TILE * 3));
  let l = mix(0.30, 0.52, rings) * mix(0.85, 1.1, 0.5 + jitter);
  l = mix(l * 0.35, l, gap);
  l = mix(l, l * 0.4, knot);
  o[0] = l * 1.15; o[1] = l * 0.82; o[2] = l * 0.52;
  o[3] = mix(0.62, 0.90, rings);
  o[4] = 0;
  o[5] = rings * 0.35 + gap * 1.1 + grain * 0.2 - knot * 0.6;
  o[6] = mix(0.35, 1, gap) * mix(0.5, 1, 1 - knot);
};

gens[MAT.GUNMETAL] = (o, u, v) => {
  const brush = fbm(u * 90, v * 3, TILE * 90, 3);
  const macro = fbm(u * 5, v * 5, TILE * 5, 3);
  const wear = sat(fbm(u * 8 + 21, v * 8, TILE * 8, 4) * 2.4 - 0.55);
  let l = mix(0.075, 0.135, sat(brush * 0.7 + 0.5)) * mix(0.85, 1.15, macro);
  l = mix(l, 0.32, wear * 0.8);
  o[0] = l * 1.02; o[1] = l * 1.0; o[2] = l * 1.02;
  o[3] = mix(0.38, 0.62, sat(brush + 0.5)) * mix(1, 0.66, wear);
  o[4] = 1;
  o[5] = brush * 0.25 + macro * 0.4;
  o[6] = mix(0.85, 1, sat(macro + 0.5));
};

gens[MAT.POLYMER] = (o, u, v) => {
  const stipple = worley(u * 60, v * 60, TILE * 60);
  const macro = fbm(u * 6, v * 6, TILE * 6, 3);
  const l = mix(0.045, 0.075, stipple) * mix(0.9, 1.1, macro);
  o[0] = l * 1.05; o[1] = l; o[2] = l * 0.95;
  o[3] = mix(0.55, 0.82, stipple);
  o[4] = 0.0;
  o[5] = stipple * 1.3;
  o[6] = mix(0.6, 1, stipple);
};

gens[MAT.SANDBAG] = (o, u, v) => {
  const weave = (Math.sin(u * Math.PI * 2 * 22) * Math.sin(v * Math.PI * 2 * 22)) * 0.5 + 0.5;
  const lump = fbm(u * 4, v * 4, TILE * 4, 4);
  const dirt = sat(fbm(u * 9 + 13, v * 9, TILE * 9, 3) * 1.5 + 0.4);
  const l = mix(0.205, 0.320, sat(lump + 0.5)) * mix(0.8, 1.05, weave) * mix(0.75, 1, dirt);
  o[0] = l * 1.18; o[1] = l * 1.0; o[2] = l * 0.70;
  o[3] = mix(0.86, 0.98, weave);
  o[4] = 0;
  o[5] = lump * 1.4 + weave * 0.25;
  o[6] = mix(0.6, 1, weave) * mix(0.7, 1, sat(lump + 0.5));
};

gens[MAT.RUSTBARREL] = (o, u, v) => {
  const rib = step2(0.42, 0.5, Math.abs(((v * 3) % 1) - 0.5));
  const rust = sat(fbm(u * 7 + 31, v * 7, TILE * 7, 5) * 2.1 + 0.15);
  const flake = worley(u * 22, v * 22, TILE * 22);
  const paint = 1 - sat(rust * 1.4 - 0.1);
  let r = mix(0.42, 0.30, paint) * mix(0.75, 1.25, flake);
  let g = mix(0.20, 0.30, paint) * mix(0.8, 1.2, flake);
  let b = mix(0.10, 0.14, paint) * mix(0.8, 1.2, flake);
  const pb = paint * step2(0.45, 0.55, ((v * 3 + 0.5) % 1));
  r = mix(r, 0.10, pb * 0.6); g = mix(g, 0.22, pb * 0.6); b = mix(b, 0.32, pb * 0.6);
  o[0] = r; o[1] = g; o[2] = b;
  o[3] = mix(0.45, 0.92, 1 - paint);
  o[4] = mix(0.15, 0.75, paint);
  o[5] = rib * 1.5 + rust * 0.4 + flake * 0.2;
  o[6] = mix(0.7, 1, flake) * mix(0.75, 1, rib);
};

gens[MAT.ASPHALT] = (o, u, v) => {
  const agg = worley(u * 34, v * 34, TILE * 34);
  const macro = fbm(u * 4, v * 4, TILE * 4, 4);
  const crack = sat(1 - Math.abs(ridge(u * 4 + 2, v * 4, TILE * 4, 3)) * 8);
  let l = mix(0.055, 0.115, agg) * mix(0.82, 1.15, sat(macro + 0.5));
  l = mix(l, l * 0.4, crack);
  o[0] = l; o[1] = l * 1.0; o[2] = l * 1.06;
  o[3] = mix(0.72, 0.95, agg);
  o[4] = 0;
  o[5] = agg * 0.9 + macro * 0.4 - crack * 1.5;
  o[6] = mix(0.5, 1, agg) * mix(0.3, 1, 1 - crack);
};

gens[MAT.FATIGUES] = (o, u, v) => {
  // Multicam-ish blobs over ripstop weave.
  const w = (Math.sin(u * Math.PI * 2 * 90) * 0.5 + 0.5) * (Math.sin(v * Math.PI * 2 * 90) * 0.5 + 0.5);
  const a = fbm(u * 5, v * 5, TILE * 5, 3);
  const b = fbm(u * 5 + 17, v * 5 + 9, TILE * 5, 3);
  const c = fbm(u * 11 + 4, v * 11, TILE * 11, 2);
  let r, g, bl;
  if (a > 0.10) { r = 0.20; g = 0.19; bl = 0.13; }
  else if (b > 0.06) { r = 0.28; g = 0.25; bl = 0.16; }
  else if (c > 0.18) { r = 0.13; g = 0.14; bl = 0.11; }
  else { r = 0.34; g = 0.30; bl = 0.20; }
  const sh = mix(0.82, 1.08, w);
  o[0] = r * sh; o[1] = g * sh; o[2] = bl * sh;
  o[3] = mix(0.88, 0.99, w);
  o[4] = 0;
  o[5] = w * 0.6 + c * 0.3;
  o[6] = mix(0.7, 1, w);
};

gens[MAT.BRICK] = (o, u, v) => {
  const row = Math.floor(v * 12);
  const off = (row & 1) ? 0.5 : 0;
  const bx = (u * 6 + off) % 1, by = (v * 12) % 1;
  const mort = 1 - step2(0.0, 0.06, bx) * step2(0.0, 0.06, 1 - bx)
                 * step2(0.0, 0.10, by) * step2(0.0, 0.10, 1 - by);
  const grit = fbm(u * 22, v * 22, TILE * 22, 3);
  const tone = PERM[(row * 91 + Math.floor(u * 6 + off) * 13) & 255] / 255;
  let r = mix(0.245, 0.360, tone) * mix(0.85, 1.1, sat(grit + 0.5));
  let g = r * 0.55, b = r * 0.44;
  const ml = 0.315 * mix(0.85, 1.05, sat(grit + 0.5));
  o[0] = mix(r, ml, mort); o[1] = mix(g, ml * 0.98, mort); o[2] = mix(b, ml * 0.94, mort);
  o[3] = mix(0.80, 0.94, mort);
  o[4] = 0;
  o[5] = (1 - mort) * 1.3 + grit * 0.25;
  o[6] = mix(1, 0.45, mort);
};

gens[MAT.TARP] = (o, u, v) => {
  const weave = (Math.sin(u * Math.PI * 2 * 50) * 0.5 + 0.5) * 0.5 + (Math.sin(v * Math.PI * 2 * 50) * 0.5 + 0.5) * 0.5;
  const fold = fbm(u * 3, v * 3, TILE * 3, 3);
  const wear = sat(fbm(u * 12 + 6, v * 12, TILE * 12, 3) * 1.8 + 0.4);
  const l = mix(0.10, 0.17, sat(fold + 0.5)) * mix(0.85, 1.1, weave) * mix(0.8, 1, wear);
  o[0] = l * 0.85; o[1] = l * 1.0; o[2] = l * 0.80;
  o[3] = mix(0.55, 0.85, weave);
  o[4] = 0;
  o[5] = fold * 1.6 + weave * 0.2;
  o[6] = mix(0.7, 1, weave);
};

gens[MAT.GLASSDIRT] = (o, u, v) => {
  const smear = fbm(u * 7, v * 7, TILE * 7, 4);
  const dust = worley(u * 45, v * 45, TILE * 45);
  const l = 0.035 * mix(0.6, 1.6, sat(smear + 0.5));
  o[0] = l * 0.9; o[1] = l * 1.05; o[2] = l * 1.15;
  o[3] = mix(0.06, 0.34, sat(smear * 1.6 + 0.35));
  o[4] = 0.05;
  o[5] = smear * 0.3 + dust * 0.1;
  o[6] = 1;
};

/* --------------------------------------------------------------- baking */

const SIZE = 512;

/** Linear -> sRGB. The albedo array is SRGB8_ALPHA8, so values must be encoded
 *  on the way in or the sampler's decode darkens everything a second time. */
function toSRGB(c) {
  if (!(c > 0)) return 0;            // also catches NaN
  if (c > 1) c = 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function bakeLayer(gen, albedo, surf, layer, normalStrength) {
  const N = SIZE, px = new Float32Array(7);
  const H = new Float32Array(N * N);
  const AO = new Float32Array(N * N);
  const base = layer * N * N * 4;
  for (let y = 0; y < N; y++) {
    const v = (y / N) * TILE;
    for (let x = 0; x < N; x++) {
      const u = (x / N) * TILE;
      gen(px, u, v);
      const i = y * N + x, o = base + i * 4;
      albedo[o] = toSRGB(px[0]) * 255;
      albedo[o + 1] = toSRGB(px[1]) * 255;
      albedo[o + 2] = toSRGB(px[2]) * 255;
      surf[o + 2] = sat(px[3]) * 255;
      surf[o + 3] = sat(px[4]) * 255;
      H[i] = px[5];
      AO[i] = sat(px[6]);
    }
  }
  // Sobel the height field into a tangent-space normal (wrapping at edges).
  const S = normalStrength;
  for (let y = 0; y < N; y++) {
    const ym = ((y - 1) + N) % N, yp = (y + 1) % N;
    for (let x = 0; x < N; x++) {
      const xm = ((x - 1) + N) % N, xp = (x + 1) % N;
      const h00 = H[ym * N + xm], h10 = H[ym * N + x], h20 = H[ym * N + xp];
      const h01 = H[y * N + xm], h21 = H[y * N + xp];
      const h02 = H[yp * N + xm], h12 = H[yp * N + x], h22 = H[yp * N + xp];
      // Sobel weights sum to 8 per axis; without dividing that out the slope is
      // ~8x too steep and every micro-detail becomes a hard lighting edge.
      const dx = ((h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02)) * 0.125;
      const dy = ((h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20)) * 0.125;
      let nx = -dx * S, ny = -dy * S, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = base + (y * N + x) * 4;
      surf[o] = (nx * 0.5 + 0.5) * 255;
      surf[o + 1] = (ny * 0.5 + 0.5) * 255;
      // Fold a little curvature darkening into the baked AO channel.
      albedo[o + 3] = sat(AO[y * N + x] * (0.75 + 0.25 * nz)) * 255;
    }
  }
}

// Sobel gain per material. Kept modest: an over-strong normal map turns into
// specular sparkle once the surface is in motion.
export const NORMAL_STRENGTH = [
  //sand con  cont corr wood gun  poly bag  barr asph fat  brick tarp glass
  2.20, 1.90, 1.60, 1.70, 1.80, 0.90, 1.40, 2.60, 2.00, 1.80, 1.10, 2.30, 1.60, 0.60,
];

/**
 * Bakes every material. Yields between layers so a loading bar can animate.
 * @returns {{albedo: WebGLTexture, surf: WebGLTexture}}
 */
export async function buildMaterialArrays(gl, onProgress) {
  const N = SIZE;
  const albedo = new Uint8Array(N * N * 4 * MAT_COUNT);
  const surf = new Uint8Array(N * N * 4 * MAT_COUNT);
  for (let i = 0; i < MAT_COUNT; i++) {
    bakeLayer(gens[i], albedo, surf, i, NORMAL_STRENGTH[i]);
    if (onProgress) onProgress((i + 1) / MAT_COUNT);
    await new Promise((r) => setTimeout(r, 0));
  }
  const mk = (data, srgb) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8,
      N, N, MAT_COUNT, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (gl.__aniso) {
      gl.texParameterf(gl.TEXTURE_2D_ARRAY, gl.__aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, gl.__maxAniso));
    }
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    return t;
  };
  return { albedo: mk(albedo, true), surf: mk(surf, false) };
}

/** 64x64 RGBA blue-noise-ish tile used for dithering, SSAO rotation and PCF. */
export function makeNoiseTex(gl) {
  const N = 64, d = new Uint8Array(N * N * 4);
  const r = mulberry32(9001);
  for (let i = 0; i < N * N; i++) {
    const a = r() * Math.PI * 2;
    d[i * 4] = (Math.cos(a) * 0.5 + 0.5) * 255;
    d[i * 4 + 1] = (Math.sin(a) * 0.5 + 0.5) * 255;
    d[i * 4 + 2] = r() * 255;
    d[i * 4 + 3] = r() * 255;
  }
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return t;
}
