// Skeletal skinning: a lofted humanoid mesh deformed by a bone palette.
//
// The previous soldier was a stack of rigid primitives — one mesh per bone —
// which meant every joint was a visible seam where two boxes overlapped. Here
// the body is a single continuous surface whose vertices are weighted across
// two or more bones, so elbows and knees bend instead of coming apart.

import { Mesh, STRIDE } from '../core/gl.js';
import { M4, m4 } from '../core/math.js';

export const MAX_BONES = 24;
/** pos3 nrm3 uv2 tan4 layer1 tint3 boneIdx4 boneWt4 */
export const SKIN_STRIDE = 24;

export class SkinnedMesh {
  constructor(gl, data, indices, bounds) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const s = SKIN_STRIDE * 4;
    const attrs = [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 4, 32],
                   [4, 1, 48], [5, 3, 52], [6, 4, 64], [7, 4, 80]];
    for (const [loc, size, off] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, s, off);
    }
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.count = indices.length;
    this.type = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindVertexArray(null);
    this.bx = bounds.cx; this.by = bounds.cy; this.bz = bounds.cz; this.br = bounds.r;
  }
  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, this.type, 0);
  }
}

/* ------------------------------------------------------------- skeleton */

export class Skeleton {
  constructor(bones) {
    // bones: [{ name, parent, head:[x,y,z] }] in bind pose, parent before child
    this.bones = bones;
    this.n = bones.length;
    this.index = {};
    bones.forEach((b, i) => { this.index[b.name] = i; });

    // Bind pose is a pure translation from the parent's head.
    this.bindLocal = bones.map((b, i) => {
      const p = b.parent >= 0 ? bones[b.parent].head : [0, 0, 0];
      return [b.head[0] - p[0], b.head[1] - p[1], b.head[2] - p[2]];
    });
    this.invBind = bones.map((b) => {
      const m = m4();
      M4.fromTranslation(m, -b.head[0], -b.head[1], -b.head[2]);
      return m;
    });

    this.world = bones.map(() => m4());
    this.palette = new Float32Array(MAX_BONES * 16);
    this._local = m4();
    this._tmp = m4();
  }

  /**
   * @param pose  array of [rx, ry, rz] local rotations, indexed by bone
   * @param root  optional [x,y,z] world offset and yaw for the whole rig
   */
  evaluate(pose, rootX, rootY, rootZ, rootYaw, rootPitch = 0, rootRoll = 0) {
    const L = this._local, T = this._tmp;
    for (let i = 0; i < this.n; i++) {
      const b = this.bones[i];
      const t = this.bindLocal[i];
      const r = pose[i] || ZERO3;
      M4.compose(L, t[0], t[1], t[2], r[0], r[1], r[2]);
      if (b.parent >= 0) M4.mul(this.world[i], this.world[b.parent], L);
      else {
        M4.compose(T, rootX, rootY, rootZ, rootPitch, rootYaw, rootRoll);
        M4.mul(this.world[i], T, L);
      }
    }
    for (let i = 0; i < this.n; i++) {
      M4.mul(T, this.world[i], this.invBind[i]);
      this.palette.set(T, i * 16);
    }
    return this.palette;
  }
}

const ZERO3 = [0, 0, 0];

/* ------------------------------------------------------------- geometry */

/**
 * Lofts a closed tube through a series of elliptical cross-sections, carrying
 * per-section bone weights along the length. Interpolating the weights between
 * sections is what produces a smooth bend at a joint rather than a crease.
 *
 * Each section: { c:[x,y,z], rx, rz, bones:[[boneIndex, weight], ...], v }
 */
export function loft(sections, radial = 14, capStart = true, capEnd = true) {
  const pos = [], nrm = [], uv = [], idx = [], bi = [], bw = [];
  const n = sections.length;

  // Parallel-transport frame so the tube does not spin along its length.
  let up = [0, 0, 1];
  const frames = [];
  for (let i = 0; i < n; i++) {
    const a = sections[Math.max(0, i - 1)].c;
    const b = sections[Math.min(n - 1, i + 1)].c;
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    // right = up x dir, then re-orthogonalise up
    let rx = up[1] * dz - up[2] * dy;
    let ry = up[2] * dx - up[0] * dz;
    let rz = up[0] * dy - up[1] * dx;
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-5) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    const ux = dy * rz - dz * ry, uy = dz * rx - dx * rz, uz = dx * ry - dy * rx;
    up = [ux, uy, uz];
    frames.push([[rx, ry, rz], [ux, uy, uz], [dx, dy, dz]]);
  }

  for (let i = 0; i < n; i++) {
    const s = sections[i];
    const [R, U] = frames[i];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ox = R[0] * ca * s.rx + U[0] * sa * s.rz;
      const oy = R[1] * ca * s.rx + U[1] * sa * s.rz;
      const oz = R[2] * ca * s.rx + U[2] * sa * s.rz;
      pos.push(s.c[0] + ox, s.c[1] + oy, s.c[2] + oz);
      // Normal of an ellipse: scale the offset by the inverse radii.
      let nx = R[0] * ca / s.rx + U[0] * sa / s.rz;
      let ny = R[1] * ca / s.rx + U[1] * sa / s.rz;
      let nz = R[2] * ca / s.rx + U[2] * sa / s.rz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nrm.push(nx / nl, ny / nl, nz / nl);
      uv.push(j / radial, s.v === undefined ? i / (n - 1) : s.v);
      pushWeights(bi, bw, s.bones);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // Flat caps.
  const cap = (si, flip) => {
    const s = sections[si];
    const [, , D] = frames[si];
    const base = pos.length / 3;
    const sgn = flip ? -1 : 1;
    pos.push(s.c[0], s.c[1], s.c[2]);
    nrm.push(D[0] * sgn, D[1] * sgn, D[2] * sgn);
    uv.push(0.5, 0.5);
    pushWeights(bi, bw, s.bones);
    const ring = si * (radial + 1);
    for (let j = 0; j <= radial; j++) {
      const src = (ring + j) * 3;
      pos.push(pos[src], pos[src + 1], pos[src + 2]);
      nrm.push(D[0] * sgn, D[1] * sgn, D[2] * sgn);
      uv.push(0.5, 0.5);
      pushWeights(bi, bw, s.bones);
    }
    for (let j = 0; j < radial; j++) {
      if (flip) idx.push(base, base + 1 + j, base + 2 + j);
      else idx.push(base, base + 2 + j, base + 1 + j);
    }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(n - 1, false);

  return { pos, nrm, uv, idx, bi, bw };
}

function pushWeights(bi, bw, bones) {
  const b = bones || [[0, 1]];
  let total = 0;
  for (let k = 0; k < 4; k++) {
    const e = b[k];
    bi.push(e ? e[0] : 0);
    const w = e ? e[1] : 0;
    bw.push(w);
    total += w;
  }
  if (total > 1e-5 && Math.abs(total - 1) > 1e-4) {
    const L = bw.length;
    for (let k = 1; k <= 4; k++) bw[L - k] /= total;
  }
}

/** Accumulates lofted pieces into one skinned mesh. */
export class SkinBuilder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.idx = [];
    this.bi = []; this.bw = []; this.layer = []; this.tint = [];
  }
  add(geo, mat, uvScale = 1) {
    const base = this.pos.length / 3;
    const n = geo.pos.length / 3;
    const layer = mat.layer, tint = mat.tint || [1, 1, 1];
    for (let i = 0; i < n; i++) {
      this.pos.push(geo.pos[i * 3], geo.pos[i * 3 + 1], geo.pos[i * 3 + 2]);
      this.nrm.push(geo.nrm[i * 3], geo.nrm[i * 3 + 1], geo.nrm[i * 3 + 2]);
      this.uv.push(geo.uv[i * 2] * uvScale, geo.uv[i * 2 + 1] * uvScale);
      this.layer.push(layer);
      this.tint.push(tint[0], tint[1], tint[2]);
      for (let k = 0; k < 4; k++) {
        this.bi.push(geo.bi ? geo.bi[i * 4 + k] : 0);
        this.bw.push(geo.bw ? geo.bw[i * 4 + k] : (k === 0 ? 1 : 0));
      }
    }
    for (let i = 0; i < geo.idx.length; i++) this.idx.push(base + geo.idx[i]);
    return this;
  }

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

    const data = new Float32Array(vcount * SKIN_STRIDE);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vcount; i++) {
      const o = i * SKIN_STRIDE;
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
      let tx = tan[i * 3], ty = tan[i * 3 + 1], tz = tan[i * 3 + 2];
      const d = tx * nx + ty * ny + tz * nz;
      tx -= nx * d; ty -= ny * d; tz -= nz * d;
      let tl = Math.hypot(tx, ty, tz);
      if (tl < 1e-8) {
        if (Math.abs(nx) < 0.9) { tx = 0; ty = -nz; tz = ny; } else { tx = -nz; ty = 0; tz = nx; }
        tl = Math.hypot(tx, ty, tz) || 1;
      }
      tx /= tl; ty /= tl; tz /= tl;
      const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
      const w = (cx * bit[i * 3] + cy * bit[i * 3 + 1] + cz * bit[i * 3 + 2]) < 0 ? -1 : 1;

      data[o] = px; data[o + 1] = py; data[o + 2] = pz;
      data[o + 3] = nx; data[o + 4] = ny; data[o + 5] = nz;
      data[o + 6] = uv[i * 2]; data[o + 7] = uv[i * 2 + 1];
      data[o + 8] = tx; data[o + 9] = ty; data[o + 10] = tz; data[o + 11] = w;
      data[o + 12] = this.layer[i];
      data[o + 13] = this.tint[i * 3]; data[o + 14] = this.tint[i * 3 + 1]; data[o + 15] = this.tint[i * 3 + 2];
      for (let k = 0; k < 4; k++) {
        data[o + 16 + k] = this.bi[i * 4 + k];
        data[o + 20 + k] = this.bw[i * 4 + k];
      }
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    let r2 = 0;
    for (let i = 0; i < vcount; i++) {
      const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    // Generous radius: skinning moves vertices away from their bind position.
    const bounds = { cx, cy, cz, r: Math.sqrt(r2) * 1.35 + 0.2 };
    const indices = vcount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
    return new SkinnedMesh(gl, data, indices, bounds);
  }
}
