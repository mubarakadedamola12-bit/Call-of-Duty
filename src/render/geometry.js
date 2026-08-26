// Procedural primitives + a batching builder that bakes many shapes into one VBO.

import { Mesh, STRIDE } from '../core/gl.js';
import { M4, m4 } from '../core/math.js';

/* ------------------------------------------------------------- primitives */

/**
 * Global chamfer applied to every box, in metres. Real objects do not have
 * mathematically perfect 90-degree edges — they have a small chamfer that
 * catches a highlight, and its absence is one of the strongest "this is CG"
 * tells there is. Set to 0 to get the old sharp boxes back.
 */
let BEVEL = 0.018;
export function setBevel(m) { BEVEL = Math.max(0, m); }
export function getBevel() { return BEVEL; }

export function boxGeo(w = 1, h = 1, d = 1, bevel) {
  const x = w / 2, y = h / 2, z = d / 2;
  // Never let the chamfer eat more than a third of the smallest dimension.
  const b = Math.min(bevel === undefined ? BEVEL : bevel, Math.min(x, y, z) * 0.33);
  const pos = [], nrm = [], uv = [], idx = [];

  const push = (px, py, pz, nx, ny, nz, tu, tv) => {
    pos.push(px, py, pz); nrm.push(nx, ny, nz); uv.push(tu, tv);
  };

  // face: normal, u-axis, v-axis, extent-u, extent-v, offset along normal
  const faces = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], x, y, z],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0], x, y, z],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0], z, y, x],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0], z, y, x],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1], x, z, y],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1], x, z, y],
  ];
  for (const [n, U, V, eu, ev, off] of faces) {
    const base = pos.length / 3;
    const iu = eu - b, iv = ev - b;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      push(
        n[0] * off + U[0] * iu * su + V[0] * iv * sv,
        n[1] * off + U[1] * iu * su + V[1] * iv * sv,
        n[2] * off + U[2] * iu * su + V[2] * iv * sv,
        n[0], n[1], n[2],
        // UVs stay in the box's own units so the inset does not shift tiling.
        (su * iu + eu), (sv * iv + ev),
      );
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (b <= 1e-6) return { pos, nrm, uv, idx };

  const E = [x, y, z];
  const at = (a, av, bAx, bv, cAx, cv) => {
    const p = [0, 0, 0];
    p[a] = av; p[bAx] = bv; p[cAx] = cv;
    return p;
  };

  // ---- 12 edge chamfers: for each axis pair, a quad running along the third.
  for (let a = 0; a < 3; a++) {              // axis the edge runs along
    const b1 = (a + 1) % 3, b2 = (a + 2) % 3;
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        const base = pos.length / 3;
        const nx = [0, 0, 0];
        nx[b1] = s1; nx[b2] = s2;
        const nl = Math.SQRT1_2;
        const quad = [
          at(a, -(E[a] - b), b1, E[b1] * s1, b2, (E[b2] - b) * s2),
          at(a, (E[a] - b), b1, E[b1] * s1, b2, (E[b2] - b) * s2),
          at(a, (E[a] - b), b1, (E[b1] - b) * s1, b2, E[b2] * s2),
          at(a, -(E[a] - b), b1, (E[b1] - b) * s1, b2, E[b2] * s2),
        ];
        quad.forEach((p, i) => push(p[0], p[1], p[2],
          nx[0] * nl, nx[1] * nl, nx[2] * nl,
          p[a] + E[a], (i < 2 ? 0 : b) + E[b2]));
        // Wind so the face points outward along the chamfer normal.
        const e1 = [quad[1][0] - quad[0][0], quad[1][1] - quad[0][1], quad[1][2] - quad[0][2]];
        const e2 = [quad[3][0] - quad[0][0], quad[3][1] - quad[0][1], quad[3][2] - quad[0][2]];
        const cx = e1[1] * e2[2] - e1[2] * e2[1];
        const cy = e1[2] * e2[0] - e1[0] * e2[2];
        const cz = e1[0] * e2[1] - e1[1] * e2[0];
        if (cx * nx[0] + cy * nx[1] + cz * nx[2] >= 0) {
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        } else {
          idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
        }
      }
    }
  }

  // ---- 8 corner patches
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const base = pos.length / 3;
        const A = [sx * (x - b), sy * y, sz * (z - b)];
        const B = [sx * (x - b), sy * (y - b), sz * z];
        const C = [sx * x, sy * (y - b), sz * (z - b)];
        const nl = 1 / Math.sqrt(3);
        for (const p of [A, B, C]) {
          push(p[0], p[1], p[2], sx * nl, sy * nl, sz * nl, p[0] + x, p[1] + y);
        }
        const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const cx = e1[1] * e2[2] - e1[2] * e2[1];
        const cy = e1[2] * e2[0] - e1[0] * e2[2];
        const cz = e1[0] * e2[1] - e1[1] * e2[0];
        if (cx * sx + cy * sy + cz * sz >= 0) idx.push(base, base + 1, base + 2);
        else idx.push(base, base + 2, base + 1);
      }
    }
  }
  return { pos, nrm, uv, idx };
}

export function cylinderGeo(r = 0.5, h = 1, seg = 20, caps = true, rTop = null) {
  const rt = rTop === null ? r : rTop;
  const pos = [], nrm = [], uv = [], idx = [];
  const slope = (r - rt) / h;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const nl = Math.hypot(1, slope);
    for (let j = 0; j <= 1; j++) {
      const rr = j ? rt : r;
      pos.push(c * rr, j ? h / 2 : -h / 2, s * rr);
      nrm.push((c / nl), (slope / nl), (s / nl));
      uv.push((i / seg) * Math.PI * 2 * r, j ? h : 0);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 2;
    idx.push(a, b, b + 1, a, b + 1, a + 1);
  }
  if (caps) {
    for (const top of [true, false]) {
      const base = pos.length / 3;
      const y = top ? h / 2 : -h / 2, ny = top ? 1 : -1, rr = top ? rt : r;
      pos.push(0, y, 0); nrm.push(0, ny, 0); uv.push(0, 0);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
        nrm.push(0, ny, 0);
        uv.push(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      for (let i = 0; i < seg; i++) {
        if (top) idx.push(base, base + 1 + i, base + 2 + i);
        else idx.push(base, base + 2 + i, base + 1 + i);
      }
    }
  }
  return { pos, nrm, uv, idx };
}

export function sphereGeo(r = 0.5, seg = 20, rings = 14) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings, phi = v * Math.PI;
    for (let x = 0; x <= seg; x++) {
      const u = x / seg, theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      pos.push(nx * r, ny * r, nz * r);
      nrm.push(nx, ny, nz);
      uv.push(u * r * 6, v * r * 3);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < seg; x++) {
      const a = y * (seg + 1) + x, b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { pos, nrm, uv, idx };
}

/** Rounded box built from a subdivided cube — used for organic-ish props. */
export function capsuleGeo(r = 0.3, h = 1.0, seg = 16, rings = 10) {
  const pos = [], nrm = [], uv = [], idx = [];
  const half = h / 2;
  for (let y = 0; y <= rings; y++) {
    const v = y / rings, phi = v * Math.PI;
    const ny = Math.cos(phi), sy = Math.sin(phi);
    const off = ny >= 0 ? half : -half;
    for (let x = 0; x <= seg; x++) {
      const u = x / seg, theta = u * Math.PI * 2;
      const nx = sy * Math.cos(theta), nz = sy * Math.sin(theta);
      pos.push(nx * r, ny * r + off, nz * r);
      nrm.push(nx, ny, nz);
      uv.push(u * 2, v * 2);
    }
  }
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < seg; x++) {
      const a = y * (seg + 1) + x, b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { pos, nrm, uv, idx };
}

export function planeGeo(w = 1, d = 1, sub = 1, uvScale = 1) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let z = 0; z <= sub; z++) {
    for (let x = 0; x <= sub; x++) {
      const fx = (x / sub - 0.5) * w, fz = (z / sub - 0.5) * d;
      pos.push(fx, 0, fz);
      nrm.push(0, 1, 0);
      uv.push(fx * uvScale, fz * uvScale);
    }
  }
  for (let z = 0; z < sub; z++) {
    for (let x = 0; x < sub; x++) {
      const a = z * (sub + 1) + x, b = a + sub + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { pos, nrm, uv, idx };
}

/* ----------------------------------------------------------------- builder */

const ONE3 = [1, 1, 1];
const _tmp = m4();
const _nm = new Float32Array(9);

export class Builder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.idx = [];
    // Per-vertex material, so one mesh can hold several looks in one draw call.
    this.layer = []; this.tint = [];
  }

  /**
   * @param geo   primitive from *Geo()
   * @param xf    optional mat4 to bake in
   * @param uvS   uv multiplier
   * @param uvO   [u,v] offset (used to de-tile repeated props)
   */
  /** @param vmat optional {layer, tint} baked per-vertex instead of per-draw */
  add(geo, xf = null, uvS = 1, uvO = [0, 0], vmat = null) {
    const base = this.pos.length / 3;
    const n = geo.pos.length / 3;
    const vl = vmat ? vmat.layer : -1;
    const vt = (vmat && vmat.tint) || ONE3;
    if (xf) M4.normalMat3(_nm, xf);
    for (let i = 0; i < n; i++) {
      const px = geo.pos[i * 3], py = geo.pos[i * 3 + 1], pz = geo.pos[i * 3 + 2];
      const nx = geo.nrm[i * 3], ny = geo.nrm[i * 3 + 1], nz = geo.nrm[i * 3 + 2];
      if (xf) {
        this.pos.push(
          xf[0] * px + xf[4] * py + xf[8] * pz + xf[12],
          xf[1] * px + xf[5] * py + xf[9] * pz + xf[13],
          xf[2] * px + xf[6] * py + xf[10] * pz + xf[14],
        );
        let ax = _nm[0] * nx + _nm[3] * ny + _nm[6] * nz;
        let ay = _nm[1] * nx + _nm[4] * ny + _nm[7] * nz;
        let az = _nm[2] * nx + _nm[5] * ny + _nm[8] * nz;
        const l = Math.hypot(ax, ay, az) || 1;
        this.nrm.push(ax / l, ay / l, az / l);
      } else {
        this.pos.push(px, py, pz);
        this.nrm.push(nx, ny, nz);
      }
      this.uv.push(geo.uv[i * 2] * uvS + uvO[0], geo.uv[i * 2 + 1] * uvS + uvO[1]);
      this.layer.push(vl);
      this.tint.push(vt[0], vt[1], vt[2]);
    }
    for (let i = 0; i < geo.idx.length; i++) this.idx.push(base + geo.idx[i]);
    return this;
  }

  addBox(w, h, d, px, py, pz, rx = 0, ry = 0, rz = 0, uvS = 1, uvO = [0, 0]) {
    M4.compose(_tmp, px, py, pz, rx, ry, rz);
    return this.add(boxGeo(w, h, d), _tmp, uvS, uvO);
  }

  /** Interleave + generate tangents, then upload. */
  build(gl) {
    const { pos, nrm, uv, idx } = this;
    const vcount = pos.length / 3;
    const tan = new Float32Array(vcount * 3);
    const bit = new Float32Array(vcount * 3);
    for (let i = 0; i < idx.length; i += 3) {
      const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
      const x0 = pos[i0 * 3], y0 = pos[i0 * 3 + 1], z0 = pos[i0 * 3 + 2];
      const e1x = pos[i1 * 3] - x0, e1y = pos[i1 * 3 + 1] - y0, e1z = pos[i1 * 3 + 2] - z0;
      const e2x = pos[i2 * 3] - x0, e2y = pos[i2 * 3 + 1] - y0, e2z = pos[i2 * 3 + 2] - z0;
      const u0 = uv[i0 * 2], v0 = uv[i0 * 2 + 1];
      const du1 = uv[i1 * 2] - u0, dv1 = uv[i1 * 2 + 1] - v0;
      const du2 = uv[i2 * 2] - u0, dv2 = uv[i2 * 2 + 1] - v0;
      const det = du1 * dv2 - du2 * dv1;
      const r = Math.abs(det) < 1e-12 ? 0 : 1 / det;
      const tx = (e1x * dv2 - e2x * dv1) * r, ty = (e1y * dv2 - e2y * dv1) * r, tz = (e1z * dv2 - e2z * dv1) * r;
      const bx = (e2x * du1 - e1x * du2) * r, by = (e2y * du1 - e1y * du2) * r, bz = (e2z * du1 - e1z * du2) * r;
      for (const k of [i0, i1, i2]) {
        tan[k * 3] += tx; tan[k * 3 + 1] += ty; tan[k * 3 + 2] += tz;
        bit[k * 3] += bx; bit[k * 3 + 1] += by; bit[k * 3 + 2] += bz;
      }
    }
    const data = new Float32Array(vcount * STRIDE);
    for (let i = 0; i < vcount; i++) {
      const o = i * STRIDE;
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      let tx = tan[i * 3], ty = tan[i * 3 + 1], tz = tan[i * 3 + 2];
      // Gram-Schmidt orthogonalise against the normal.
      const d = tx * nx + ty * ny + tz * nz;
      tx -= nx * d; ty -= ny * d; tz -= nz * d;
      let tl = Math.hypot(tx, ty, tz);
      if (tl < 1e-8) {
        // Degenerate: pick any perpendicular axis.
        if (Math.abs(nx) < 0.9) { tx = 0; ty = -nz; tz = ny; } else { tx = -nz; ty = 0; tz = nx; }
        tl = Math.hypot(tx, ty, tz) || 1;
      }
      tx /= tl; ty /= tl; tz /= tl;
      // Handedness from the bitangent.
      const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
      const w = (cx * bit[i * 3] + cy * bit[i * 3 + 1] + cz * bit[i * 3 + 2]) < 0 ? -1 : 1;
      data[o] = pos[i * 3]; data[o + 1] = pos[i * 3 + 1]; data[o + 2] = pos[i * 3 + 2];
      data[o + 3] = nx; data[o + 4] = ny; data[o + 5] = nz;
      data[o + 6] = uv[i * 2]; data[o + 7] = uv[i * 2 + 1];
      data[o + 8] = tx; data[o + 9] = ty; data[o + 10] = tz; data[o + 11] = w;
      data[o + 12] = this.layer[i];
      data[o + 13] = this.tint[i * 3];
      data[o + 14] = this.tint[i * 3 + 1];
      data[o + 15] = this.tint[i * 3 + 2];
    }
    const indices = vcount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);

    // Bounding sphere for frustum / shadow-cascade culling.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vcount; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    let r2 = 0;
    for (let i = 0; i < vcount; i++) {
      const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    return new Mesh(gl, data, indices, { cx, cy, cz, r: Math.sqrt(r2) });
  }
}

export function meshFrom(gl, geo, xf = null, uvS = 1) {
  return new Builder().add(geo, xf, uvS).build(gl);
}
