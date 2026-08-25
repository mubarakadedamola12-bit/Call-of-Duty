// Minimal glTF 2.0 / GLB reader.
//
// Deliberately a subset: static meshes with POSITION / NORMAL / TEXCOORD_0 and
// indices, node-hierarchy transforms, and pbrMetallicRoughness factors. That
// is exactly what an OBJ-derived asset pack contains, and it keeps the reader
// small enough to audit.
//
// Output is CPU-side geometry rather than GL buffers, so callers can bake
// models straight into an existing batch and pay no extra draw calls.

const MAGIC_GLB = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function parseGLB(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== MAGIC_GLB) throw new Error('not a GLB file');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported glTF version ${version}`);
  const total = dv.getUint32(8, true);
  const bytes = new Uint8Array(arrayBuffer);

  let offset = 12, json = null, bin = null;
  while (offset + 8 <= total) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const body = bytes.subarray(offset + 8, offset + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === CHUNK_BIN) bin = body;
    offset += 8 + len;
    if (len % 4) offset += 4 - (len % 4);   // chunks are 4-byte aligned
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

/** Reads an accessor into a flat array, honouring byteStride for interleaving. */
function readAccessor(json, bin, index) {
  const acc = json.accessors[index];
  const n = COMPONENTS_PER[acc.type];
  const TA = COMPONENT[acc.componentType];
  if (!TA) throw new Error(`unsupported componentType ${acc.componentType}`);
  const out = new (acc.componentType === 5126 ? Float32Array : TA)(acc.count * n);

  if (acc.bufferView === undefined) return out;   // spec: all zeros
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride;
  const elemBytes = TA.BYTES_PER_ELEMENT;

  if (!stride || stride === n * elemBytes) {
    const src = new TA(bin.buffer, bin.byteOffset + base, acc.count * n);
    out.set(src);
  } else {
    // Interleaved: walk element by element.
    for (let i = 0; i < acc.count; i++) {
      const src = new TA(bin.buffer, bin.byteOffset + base + i * stride, n);
      for (let k = 0; k < n; k++) out[i * n + k] = src[k];
    }
  }
  return out;
}

/* ------------------------------------------------------------- transforms */

function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];   // quaternion xyzw
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function mulMat(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                   + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/**
 * Flattens a GLB scene into world-space primitives.
 *
 * Each primitive carries its material's baseColorFactor as `tint`, which the
 * renderer bakes per-vertex — so an entire model collapses to one draw call
 * with several colours, without needing image textures.
 *
 * @returns {{ prims: Array, min: number[], max: number[], height: number }}
 */
export function flattenGLB(glb) {
  const { json, bin } = glb;
  const prims = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  const scene = json.scenes ? json.scenes[json.scene || 0] : null;
  const roots = scene ? scene.nodes : json.nodes.map((_, i) => i);

  const visit = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex];
    const world = mulMat(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const p of json.meshes[node.mesh].primitives) {
        if (p.mode !== undefined && p.mode !== 4) continue;   // triangles only
        const pos = readAccessor(json, bin, p.attributes.POSITION);
        const nrm = p.attributes.NORMAL !== undefined
          ? readAccessor(json, bin, p.attributes.NORMAL) : null;
        const uv = p.attributes.TEXCOORD_0 !== undefined
          ? readAccessor(json, bin, p.attributes.TEXCOORD_0) : null;
        const idx = p.indices !== undefined
          ? Array.from(readAccessor(json, bin, p.indices))
          : Array.from({ length: pos.length / 3 }, (_, i) => i);

        const count = pos.length / 3;
        const wp = new Float32Array(count * 3);
        const wn = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          const X = world[0] * x + world[4] * y + world[8] * z + world[12];
          const Y = world[1] * x + world[5] * y + world[9] * z + world[13];
          const Z = world[2] * x + world[6] * y + world[10] * z + world[14];
          wp[i * 3] = X; wp[i * 3 + 1] = Y; wp[i * 3 + 2] = Z;
          if (X < min[0]) min[0] = X; if (X > max[0]) max[0] = X;
          if (Y < min[1]) min[1] = Y; if (Y > max[1]) max[1] = Y;
          if (Z < min[2]) min[2] = Z; if (Z > max[2]) max[2] = Z;
          if (nrm) {
            // Rotation only — these packs never carry non-uniform scale, and a
            // renormalise below covers uniform scale anyway.
            const nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
            let ax = world[0] * nx + world[4] * ny + world[8] * nz;
            let ay = world[1] * nx + world[5] * ny + world[9] * nz;
            let az = world[2] * nx + world[6] * ny + world[10] * nz;
            const l = Math.hypot(ax, ay, az) || 1;
            wn[i * 3] = ax / l; wn[i * 3 + 1] = ay / l; wn[i * 3 + 2] = az / l;
          } else { wn[i * 3 + 1] = 1; }
        }

        const mat = p.material !== undefined ? json.materials[p.material] : null;
        const pbr = (mat && mat.pbrMetallicRoughness) || {};
        const bc = pbr.baseColorFactor || [0.8, 0.8, 0.8, 1];
        prims.push({
          pos: wp, nrm: wn,
          uv: uv || new Float32Array(count * 2),
          idx,
          tint: [bc[0], bc[1], bc[2]],
          roughness: pbr.roughnessFactor === undefined ? 0.8 : pbr.roughnessFactor,
          metallic: pbr.metallicFactor === undefined ? 0 : pbr.metallicFactor,
          name: mat && mat.name,
        });
      }
    }
    for (const child of node.children || []) visit(child, world);
  };

  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of roots) visit(r, I);

  return { prims, min, max, height: max[1] - min[1] };
}

export async function loadGLB(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parseGLB(await res.arrayBuffer());
}
