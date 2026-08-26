// Thin WebGL2 wrapper: programs, VAOs, textures, framebuffers.

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,          // we do our own AA in post
    alpha: false,
    depth: false,              // we render into our own FBOs
    stencil: false,
    powerPreference: 'high-performance',
    desynchronized: true,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_float_blend');
  gl.getExtension('OES_texture_float_linear');
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  gl.__aniso = aniso;
  gl.__maxAniso = aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
  return gl;
}

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
    console.error(`[${label}] shader compile failed:\n${log}\n${numbered}`);
    throw new Error(`shader ${label}: ${log}`);
  }
  return sh;
}

export class Program {
  constructor(gl, vsSrc, fsSrc, label = 'prog') {
    this.gl = gl;
    this.label = label;
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label + '.vs');
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + '.fs');
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`link ${label}: ${gl.getProgramInfoLog(p)}`);
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    this.p = p;
    this.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      this.u[name] = gl.getUniformLocation(p, name);
    }
    this._unit = 0;
  }
  use() { this.gl.useProgram(this.p); this._unit = 0; return this; }
  // A stray `undefined` uploads as NaN and silently poisons everything it
  // touches downstream, so scalars are validated on the way in.
  _num(n, v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!this._warned) this._warned = new Set();
    if (!this._warned.has(n)) {
      this._warned.add(n);
      console.error(`[${this.label}] uniform ${n} got a non-finite value:`, v);
    }
    return 0;
  }
  i(n, v) { const l = this.u[n]; if (l) this.gl.uniform1i(l, this._num(n, v) | 0); return this; }
  f(n, v) { const l = this.u[n]; if (l) this.gl.uniform1f(l, this._num(n, v)); return this; }
  f2(n, a, b) { const l = this.u[n]; if (l) this.gl.uniform2f(l, this._num(n, a), this._num(n, b)); return this; }
  f3(n, a, b, c) {
    const l = this.u[n];
    if (l) this.gl.uniform3f(l, this._num(n, a), this._num(n, b), this._num(n, c));
    return this;
  }
  f4(n, a, b, c, d) {
    const l = this.u[n];
    if (l) this.gl.uniform4f(l, this._num(n, a), this._num(n, b), this._num(n, c), this._num(n, d));
    return this;
  }
  v3(n, v) { const l = this.u[n]; if (l) this.gl.uniform3fv(l, v); return this; }
  v3a(n, v) { const l = this.u[n]; if (l) this.gl.uniform3fv(l, v); return this; }
  v4a(n, v) { const l = this.u[n]; if (l) this.gl.uniform4fv(l, v); return this; }
  fa(n, v) { const l = this.u[n]; if (l) this.gl.uniform1fv(l, v); return this; }
  m4(n, v) { const l = this.u[n]; if (l) this.gl.uniformMatrix4fv(l, false, v); return this; }
  m3(n, v) { const l = this.u[n]; if (l) this.gl.uniformMatrix3fv(l, false, v); return this; }
  /**
   * Bind a texture to a sampler. Pass an explicit `unit` for textures whose
   * target differs from TEXTURE_2D: a unit may only ever have ONE target
   * bound, otherwise the sampler reads black on strict drivers (ANGLE/Metal).
   */
  tex(n, texture, target, unit) {
    const l = this.u[n];
    if (!l) return this;
    if (!texture) {
      // Binding null samples black, which usually looks like "the effect is
      // subtle" rather than "the effect is missing". Say so once.
      if (!this._warned) this._warned = new Set();
      const key = 'tex:' + n;
      if (!this._warned.has(key)) {
        this._warned.add(key);
        console.error(`[${this.label}] sampler ${n} bound to a missing texture`);
      }
    }
    const gl = this.gl;
    const u = unit === undefined ? this._unit++ : unit;
    gl.activeTexture(gl.TEXTURE0 + u);
    gl.bindTexture(target || gl.TEXTURE_2D, texture);
    gl.uniform1i(l, u);
    return this;
  }
}

/**
 * Interleaved static mesh:
 *   pos(3) nrm(3) uv(2) tan(4) layer(1) tint(3) = 16 floats/vertex.
 *
 * `layer` and `tint` are per-vertex so several materials can live in ONE mesh
 * and therefore one draw call. A negative layer means "use the uniform", which
 * keeps single-material meshes exactly as they were.
 */
export const STRIDE = 16;

export class Mesh {
  /** @param bounds optional {cx,cy,cz,r} local-space bounding sphere for culling */
  constructor(gl, data, indices, bounds) {
    this.gl = gl;
    this.bx = bounds ? bounds.cx : 0;
    this.by = bounds ? bounds.cy : 0;
    this.bz = bounds ? bounds.cz : 0;
    this.br = bounds ? bounds.r : 1e9;   // no bounds -> never culled
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const s = STRIDE * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, s, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, s, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, s, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, s, 32);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, s, 48);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 3, gl.FLOAT, false, s, 52);
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.count = indices.length;
    this.type = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindVertexArray(null);
  }
  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, this.type, 0);
  }
  drawInstanced(n) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.count, this.type, 0, n);
  }
  /** Frees the GL objects. Meshes outlive JS GC otherwise. */
  dispose() {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    this.vao = this.vbo = this.ibo = null;
    this.count = 0;
  }
}

/** Fullscreen triangle drawn with gl_VertexID — no buffers needed. */
export class FullscreenTri {
  constructor(gl) { this.gl = gl; this.vao = gl.createVertexArray(); }
  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export function makeTex2D(gl, opts) {
  const {
    width, height, internalFormat = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE,
    min = gl.LINEAR, mag = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, data = null,
    mips = false, aniso = 0, compare = false,
  } = opts;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (compare) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  }
  if (aniso && gl.__aniso) {
    gl.texParameterf(gl.TEXTURE_2D, gl.__aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(aniso, gl.__maxAniso));
  }
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  t.__w = width; t.__h = height;
  return t;
}

/** Render target: N colour attachments + optional depth texture. */
export class RT {
  constructor(gl, width, height, colorSpecs, withDepth = false, depthTexture = null) {
    this.gl = gl;
    this.width = width; this.height = height;
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    this.colors = [];
    const draws = [];
    colorSpecs.forEach((spec, i) => {
      const t = makeTex2D(gl, { width, height, ...spec });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      draws.push(gl.COLOR_ATTACHMENT0 + i);
      this.colors.push(t);
    });
    if (draws.length) gl.drawBuffers(draws);
    else { gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }

    if (depthTexture) {
      this.depth = depthTexture;
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
    } else if (withDepth) {
      this.depth = makeTex2D(gl, {
        width, height, internalFormat: gl.DEPTH_COMPONENT32F,
        format: gl.DEPTH_COMPONENT, type: gl.FLOAT,
        min: gl.NEAREST, mag: gl.NEAREST,
      });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depth, 0);
    }
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) console.error('FBO incomplete 0x' + st.toString(16), width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  bind(clearMask = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    if (clearMask) gl.clear(clearMask);
    return this;
  }
  get tex() { return this.colors[0]; }
}
