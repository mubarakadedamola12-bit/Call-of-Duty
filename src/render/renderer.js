// Deferred renderer.
//
//   shadow (2 cascades) -> G-buffer -> depth blit -> SSAO(+bilateral blur)
//   -> deferred resolve (+sky, fog) -> forward FX (decals are in the G-buffer)
//   -> bloom pyramid -> composite/grade/tonemap -> FXAA -> screen

import { Program, RT, FullscreenTri, makeTex2D } from '../core/gl.js';
import { M4, V3, m4, v3 } from '../core/math.js';
import * as S from './shaders.js';
import { buildMaterialArrays, makeNoiseTex, MAT } from './textures.js';

const MAX_PARTICLES = 3000;
const MAX_BEAMS = 400;
const MAX_DECALS = 320;
const ARRAY_UNIT_ALBEDO = 12;
const ARRAY_UNIT_SURF = 13;
const SHADOW_NEAR_SIZE = 2048;
const SHADOW_FAR_SIZE = 2048;

export const defaultMaterial = () => ({
  layer: MAT.CONCRETE,
  uvScale: [1, 1],
  tint: [1, 1, 1],
  emissive: [0, 0, 0],
  rough: 1,
  metal: 1,
  normalScale: 1,
  macro: 0,
  ao: 1,
});

export class Renderer {
  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.tri = new FullscreenTri(gl);

    this.width = 1; this.height = 1;
    this.renderScale = 1;

    // ---- camera state
    this.view = m4(); this.proj = m4(); this.vp = m4();
    this.invVP = m4(); this.invProj = m4();
    this.camPos = v3(0, 1.7, 0);
    this.near = 0.045; this.far = 260;
    this.fov = 78;

    // ---- sun / atmosphere (late golden hour: warm key, cool sky fill)
    this.sunDir = v3(); V3.norm(this.sunDir, v3(0.40, 0.78, 0.62));
    this.sunColor = v3(1.0, 0.80, 0.58);
    this.sunIntensity = 4.4;
    this.ambientTint = v3(0.66, 0.77, 1.0);
    this.ambientMul = 3.10;
    this.fogColor = v3(0.32, 0.29, 0.31);
    this.fogDensity = 0.0026;
    this.fogHeight = 40;

    // ---- grade / post
    this.exposure = 1.78;
    this.bloomAmt = 0.55;
    this.bloomThreshold = 1.25;
    this.vignette = 0.58;
    this.chroma = 0.13;
    this.grain = 0.034;
    this.saturation = 1.28;
    this.contrast = 1.16;
    this.lift = v3(0.028, 0.038, 0.060);
    this.gain = v3(1.03, 0.995, 0.955);
    this.damage = 0; this.hurt = 0; this.flash = 0;
    this.adsBlur = 0; this.speedBlur = 0;
    this.ssaoIntensity = 0.95;
    this.ssaoRadius = 0.62;

    // ---- per-frame lists
    this.draws = [];
    this.drawPool = [];
    this.lightPosR = new Float32Array(S.MAX_LIGHTS * 4);
    this.lightCol = new Float32Array(S.MAX_LIGHTS * 4);
    this.lightCount = 0;

    this.pData = new Float32Array(MAX_PARTICLES * 12);
    this.pCount = 0;
    this.bData = new Float32Array(MAX_BEAMS * 12);
    this.bCount = 0;
    this.dData = new Float32Array(MAX_DECALS * 12);
    this.dCount = 0; this.dHead = 0; this.dDirty = true;

    this.frame = 0;
    this.time = 0;

    // ---- shadow matrices
    this.lightVP = [m4(), m4()];
    // Near cascade snapped ahead of the player; far cascade covers the arena.
    // Anything beyond the far cascade falls outside the map and stays lit,
    // which is exactly what we want for the decorative skyline.
    this.cascadeSize = [22, 62];

    this._m = { model: m4(), nm: new Float32Array(9), tmp: m4(), tmp2: m4() };

    this._initPrograms();
    this._initBuffers();
  }

  async loadMaterials(onProgress) {
    const { albedo, surf } = await buildMaterialArrays(this.gl, onProgress);
    this.matAlbedo = albedo;
    this.matSurf = surf;
    this.noiseTex = makeNoiseTex(this.gl);
  }

  _initPrograms() {
    const gl = this.gl;
    const P = (vs, fs, n) => new Program(gl, vs, fs, n);
    this.pg = {
      gbuffer: P(S.gbufferVS, S.gbufferFS, 'gbuffer'),
      shadow: P(S.shadowVS, S.shadowFS, 'shadow'),
      ssao: P(S.fsTriVS, S.ssaoFS, 'ssao'),
      blur: P(S.fsTriVS, S.blurFS, 'blur'),
      lighting: P(S.fsTriVS, S.lightingFS, 'lighting'),
      bloomPre: P(S.fsTriVS, S.bloomPrefilterFS, 'bloomPre'),
      bloomDown: P(S.fsTriVS, S.bloomDownFS, 'bloomDown'),
      bloomUp: P(S.fsTriVS, S.bloomUpFS, 'bloomUp'),
      composite: P(S.fsTriVS, S.compositeFS, 'composite'),
      fxaa: P(S.fsTriVS, S.fxaaFS, 'fxaa'),
      particle: P(S.particleVS, S.particleFS, 'particle'),
      beam: P(S.beamVS, S.beamFS, 'beam'),
      decal: P(S.decalVS, S.decalFS, 'decal'),
      unlit: P(S.unlitVS, S.unlitFS, 'unlit'),
    };
  }

  _instancedVAO(byteSize) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, byteSize, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 48, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    return { vao, buf };
  }

  _initBuffers() {
    const gl = this.gl;
    this.particleVAO = this._instancedVAO(MAX_PARTICLES * 48);
    this.beamVAO = this._instancedVAO(MAX_BEAMS * 48);
    this.decalVAO = this._instancedVAO(MAX_DECALS * 48);

    this.shadowRT = [
      new RT(gl, SHADOW_NEAR_SIZE, SHADOW_NEAR_SIZE, [], true),
      new RT(gl, SHADOW_FAR_SIZE, SHADOW_FAR_SIZE, [], true),
    ];
    // NOTE: these are sampled through a plain sampler2D, so the filter MUST be
    // NEAREST — a depth texture with COMPARE_MODE=NONE and a linear filter is
    // *incomplete* in GLES 3.0 and reads back as 0 (i.e. everything shadowed).
    // The softness comes from the spiral PCF kernel instead.
    for (const rt of this.shadowRT) {
      gl.bindTexture(gl.TEXTURE_2D, rt.depth);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  }

  resize(w, h) {
    const gl = this.gl;
    w = Math.max(2, w | 0); h = Math.max(2, h | 0);
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;

    const half = [Math.max(1, w >> 1), Math.max(1, h >> 1)];
    const F16 = { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    const R8 = { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };

    this.gbuf = new RT(gl, w, h, [
      { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
      F16,
      { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
    ], true);

    this.depthCopy = makeTex2D(gl, {
      width: w, height: h,
      internalFormat: gl.DEPTH_COMPONENT32F, format: gl.DEPTH_COMPONENT, type: gl.FLOAT,
      min: gl.NEAREST, mag: gl.NEAREST,
    });
    this.depthCopyFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthCopyFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthCopy, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.aoRT = new RT(gl, half[0], half[1], [R8], false);
    this.aoTmp = new RT(gl, half[0], half[1], [R8], false);

    // Scene HDR shares the G-buffer depth so forward FX can depth-test.
    this.sceneRT = new RT(gl, w, h, [F16], false, this.gbuf.depth);
    this.sceneNoDepth = new RT(gl, w, h, [F16], false);
    // Same colour texture, two FBOs: one with depth (forward), one without.
    gl.deleteTexture(this.sceneNoDepth.colors[0]);
    this.sceneNoDepth.colors[0] = this.sceneRT.colors[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneNoDepth.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneRT.colors[0], 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Bloom pyramid.
    this.bloom = [];
    let bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    for (let i = 0; i < 6 && bw > 4 && bh > 4; i++) {
      this.bloom.push(new RT(gl, bw, bh, [F16], false));
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    this.bloomUpRT = this.bloom.map((rt) => new RT(gl, rt.width, rt.height, [F16], false));

    this.ldrRT = new RT(gl, w, h, [{ internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE }], false);
  }

  /* ------------------------------------------------------------ submission */

  setCamera(pos, viewMat, fovDeg) {
    V3.copy(this.camPos, pos);
    M4.copy(this.view, viewMat);
    this.fov = fovDeg;
    const aspect = this.width / this.height;
    M4.perspective(this.proj, fovDeg * Math.PI / 180, aspect, this.near, this.far);
    M4.mul(this.vp, this.proj, this.view);
    M4.invert(this.invVP, this.vp);
    M4.invert(this.invProj, this.proj);
  }

  beginFrame(dt) {
    this.draws.length = 0;
    this.lightCount = 0;
    this.pCount = 0;
    this.bCount = 0;
    this.time += dt;
    this.frame++;
  }

  /** @param model mat4 (copied) */
  draw(mesh, model, mat, castShadow = true) {
    let it = this.drawPool[this.draws.length];
    if (!it) { it = { mesh: null, model: m4(), mat: null, castShadow: true }; this.drawPool.push(it); }
    it.mesh = mesh;
    it.model.set(model);
    it.mat = mat;
    it.castShadow = castShadow;
    this.draws.push(it);
  }

  addLight(x, y, z, radius, r, g, b, intensity) {
    if (this.lightCount >= S.MAX_LIGHTS) return;
    const i = this.lightCount++;
    this.lightPosR[i * 4] = x; this.lightPosR[i * 4 + 1] = y;
    this.lightPosR[i * 4 + 2] = z; this.lightPosR[i * 4 + 3] = radius;
    this.lightCol[i * 4] = r; this.lightCol[i * 4 + 1] = g;
    this.lightCol[i * 4 + 2] = b; this.lightCol[i * 4 + 3] = intensity;
  }

  addParticle(x, y, z, size, r, g, b, a, rot, stretch, kind, glow) {
    if (this.pCount >= MAX_PARTICLES) return;
    const o = this.pCount++ * 12, d = this.pData;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = r; d[o + 5] = g; d[o + 6] = b; d[o + 7] = a;
    d[o + 8] = rot; d[o + 9] = stretch; d[o + 10] = kind; d[o + 11] = glow;
  }

  addBeam(ax, ay, az, bx, by, bz, width, r, g, b, a) {
    if (this.bCount >= MAX_BEAMS) return;
    const o = this.bCount++ * 12, d = this.bData;
    d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = width;
    d[o + 4] = bx; d[o + 5] = by; d[o + 6] = bz; d[o + 7] = 0;
    d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = a;
  }

  addDecal(x, y, z, nx, ny, nz, size, rot, kind, alpha) {
    const i = this.dHead;
    this.dHead = (this.dHead + 1) % MAX_DECALS;
    if (this.dCount < MAX_DECALS) this.dCount++;
    const o = i * 12, d = this.dData;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size;
    d[o + 4] = nx; d[o + 5] = ny; d[o + 6] = nz; d[o + 7] = rot;
    d[o + 8] = kind; d[o + 9] = alpha; d[o + 10] = Math.random(); d[o + 11] = 0;
    this.dDirty = true;
  }

  /* ------------------------------------------------------------- rendering */

  _fitCascade(index, size) {
    const c = this.camPos;
    // Snap the cascade centre to texel increments so shadows don't crawl.
    const res = index === 0 ? SHADOW_NEAR_SIZE : SHADOW_FAR_SIZE;
    const texel = (size * 2) / res;
    const fwd = index === 0 ? size * 0.42 : 0;
    // Push the near cascade slightly ahead of the player.
    const vx = -this.view[2], vz = -this.view[10];
    const l = Math.hypot(vx, vz) || 1;
    let cx = index === 0 ? c[0] + (vx / l) * fwd : 0;
    let cz = index === 0 ? c[2] + (vz / l) * fwd : 0;
    let cy = index === 0 ? c[1] * 0.5 : 6;
    cx = Math.round(cx / texel) * texel;
    cz = Math.round(cz / texel) * texel;
    cy = Math.round(cy / texel) * texel;

    const d = this.sunDir;
    const eye = v3(cx + d[0] * 90, cy + d[1] * 90, cz + d[2] * 90);
    const center = v3(cx, cy, cz);
    const up = Math.abs(d[1]) > 0.95 ? v3(1, 0, 0) : v3(0, 1, 0);
    const lv = this._m.tmp, lp = this._m.tmp2;
    M4.lookAt(lv, eye, center, up);
    M4.ortho(lp, -size, size, -size, size, 0.5, 200);
    M4.mul(this.lightVP[index], lp, lv);
  }

  _shadowPass() {
    const gl = this.gl;
    const pg = this.pg.shadow.use();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.1, 1.8);
    for (let c = 0; c < 2; c++) {
      this._fitCascade(c, this.cascadeSize[c]);
      this.shadowRT[c].bind();
      gl.clear(gl.DEPTH_BUFFER_BIT);
      pg.m4('uLightVP', this.lightVP[c]);
      for (const it of this.draws) {
        if (!it.castShadow) continue;
        pg.m4('uModel', it.model);
        it.mesh.draw();
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  _gbufferPass() {
    const gl = this.gl;
    this.gbuf.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    const pg = this.pg.gbuffer.use();
    pg.m4('uVP', this.vp);
    // Units 12/13 are reserved for the material arrays — no 2D texture is ever
    // bound there, so the array samplers stay valid.
    pg.tex('uAlbedoArr', this.matAlbedo, gl.TEXTURE_2D_ARRAY, ARRAY_UNIT_ALBEDO);
    pg.tex('uSurfArr', this.matSurf, gl.TEXTURE_2D_ARRAY, ARRAY_UNIT_SURF);
    const nm = this._m.nm;
    let lastMat = null;
    for (const it of this.draws) {
      const m = it.mat;
      pg.m4('uModel', it.model);
      M4.normalMat3(nm, it.model);
      pg.m3('uNM', nm);
      if (m !== lastMat) {
        pg.f('uLayer', m.layer);
        pg.f2('uUVScale', m.uvScale[0], m.uvScale[1]);
        pg.f3('uTint', m.tint[0], m.tint[1], m.tint[2]);
        pg.f3('uEmissive', m.emissive[0], m.emissive[1], m.emissive[2]);
        pg.f('uRoughMul', m.rough);
        pg.f('uMetalMul', m.metal);
        pg.f('uNormalScale', m.normalScale);
        pg.f('uMacro', m.macro);
        pg.f('uAOMul', m.ao);
        lastMat = m;
      }
      it.mesh.draw();
    }

    // Decals write into the G-buffer so they receive full lighting.
    if (this.dCount > 0) {
      if (this.dDirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.decalVAO.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dData, 0, MAX_DECALS * 12);
        this.dDirty = false;
      }
      const dp = this.pg.decal.use();
      dp.m4('uVP', this.vp);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2.0, -4.0);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(this.decalVAO.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.dCount);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
    }
  }

  _ssaoPass() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    this.aoRT.bind();
    const pg = this.pg.ssao.use();
    pg.tex('uDepth', this.depthCopy);
    pg.tex('uNormal', this.gbuf.colors[1]);
    pg.tex('uNoise', this.noiseTex);
    pg.m4('uProj', this.proj);
    pg.m4('uInvProj', this.invProj);
    pg.m4('uView', this.view);
    pg.f2('uRes', this.aoRT.width, this.aoRT.height);
    pg.f('uRadius', this.ssaoRadius);
    pg.f('uBias', 0.022);
    pg.f('uIntensity', this.ssaoIntensity);
    pg.f('uFrame', this.frame % 64);
    this.tri.draw();

    const bp = this.pg.blur.use();
    const tw = 1 / this.aoRT.width, th = 1 / this.aoRT.height;
    this.aoTmp.bind();
    bp.tex('uTex', this.aoRT.tex); bp.tex('uDepth', this.depthCopy);
    bp.f2('uTexel', tw, th); bp.f2('uDir', 1, 0);
    this.tri.draw();
    this.aoRT.bind();
    bp.use();
    bp.tex('uTex', this.aoTmp.tex); bp.tex('uDepth', this.depthCopy);
    bp.f2('uTexel', tw, th); bp.f2('uDir', 0, 1);
    this.tri.draw();
  }

  _lightingPass() {
    const gl = this.gl;
    this.sceneNoDepth.bind();
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    const pg = this.pg.lighting.use();
    pg.tex('uAlbedo', this.gbuf.colors[0]);
    pg.tex('uNormal', this.gbuf.colors[1]);
    pg.tex('uMisc', this.gbuf.colors[2]);
    pg.tex('uDepth', this.depthCopy);
    pg.tex('uAO', this.aoRT.tex);
    pg.tex('uShadow', this.shadowRT[0].depth);
    pg.tex('uShadowFar', this.shadowRT[1].depth);
    pg.m4('uInvVP', this.invVP);
    pg.m4('uLightVP', this.lightVP[0]);
    pg.m4('uLightVPFar', this.lightVP[1]);
    pg.v3('uCamPos', this.camPos);
    pg.f2('uRes', this.width, this.height);
    pg.f('uShadowTexel', 1 / SHADOW_NEAR_SIZE);
    pg.f('uShadowTexelFar', 1 / SHADOW_FAR_SIZE);
    pg.f('uShadowWorld', (this.cascadeSize[0] * 2) / SHADOW_NEAR_SIZE);
    pg.f('uShadowWorldFar', (this.cascadeSize[1] * 2) / SHADOW_FAR_SIZE);
    pg.f('uCascadeSplit', this.cascadeSize[0] * 0.78);
    pg.v3('uSunDir', this.sunDir);
    pg.f3('uSunColor', this.sunColor[0] * this.sunIntensity, this.sunColor[1] * this.sunIntensity, this.sunColor[2] * this.sunIntensity);
    pg.f('uTime', this.time);
    pg.v3('uAmbientTint', this.ambientTint);
    pg.f('uAmbientMul', this.ambientMul);
    pg.f('uFogDensity', this.fogDensity);
    pg.f('uFogHeight', this.fogHeight);
    pg.v3('uFogColor', this.fogColor);
    gl.uniform4fv(pg.u.uLightPosR, this.lightPosR);
    gl.uniform4fv(pg.u.uLightCol, this.lightCol);
    pg.i('uLightCount', this.lightCount);
    this.tri.draw();
  }

  _forwardFX() {
    const gl = this.gl;
    this.sceneRT.bind();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
    gl.disable(gl.CULL_FACE);

    const right = v3(this.view[0], this.view[4], this.view[8]);
    const up = v3(this.view[1], this.view[5], this.view[9]);

    if (this.bCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.beamVAO.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.bData, 0, this.bCount * 12);
      const pg = this.pg.beam.use();
      pg.m4('uVP', this.vp);
      pg.v3('uCamPos', this.camPos);
      pg.tex('uDepth', this.depthCopy);
      pg.f2('uRes', this.width, this.height);
      pg.f('uNear', this.near); pg.f('uFar', this.far);
      gl.bindVertexArray(this.beamVAO.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.bCount);
    }

    if (this.pCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVAO.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pData, 0, this.pCount * 12);
      const pg = this.pg.particle.use();
      pg.m4('uVP', this.vp);
      pg.v3('uCamRight', right);
      pg.v3('uCamUp', up);
      pg.tex('uDepth', this.depthCopy);
      pg.f2('uRes', this.width, this.height);
      pg.f('uNear', this.near); pg.f('uFar', this.far);
      pg.f('uTime', this.time);
      gl.bindVertexArray(this.particleVAO.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.pCount);
    }
    gl.disable(gl.BLEND);
  }

  _bloomPass() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);

    const pre = this.pg.bloomPre.use();
    this.bloom[0].bind();
    pre.tex('uTex', this.sceneRT.tex);
    pre.f2('uTexel', 1 / this.width, 1 / this.height);
    pre.f('uThreshold', this.bloomThreshold);
    pre.f('uSoftKnee', 0.65);
    pre.f('uClamp', 9.0);
    this.tri.draw();

    const dn = this.pg.bloomDown.use();
    for (let i = 1; i < this.bloom.length; i++) {
      this.bloom[i].bind();
      dn.use();
      dn.tex('uTex', this.bloom[i - 1].tex);
      dn.f2('uTexel', 1 / this.bloom[i - 1].width, 1 / this.bloom[i - 1].height);
      this.tri.draw();
    }

    const n = this.bloom.length;
    // Seed the top of the up-chain with the smallest mip.
    const up = this.pg.bloomUp.use();
    let src = this.bloom[n - 1].tex;
    for (let i = n - 2; i >= 0; i--) {
      const dst = this.bloomUpRT[i];
      dst.bind();
      up.use();
      up.tex('uTex', src);
      up.tex('uPrev', this.bloom[i].tex);
      up.f2('uTexel', 1 / this.bloom[i].width, 1 / this.bloom[i].height);
      up.f('uRadius', 1.25);
      up.f('uBlend', 0.58);
      this.tri.draw();
      src = dst.tex;
    }
    this.bloomResult = src;
  }

  _compositePass() {
    const gl = this.gl;
    this.ldrRT.bind();
    const pg = this.pg.composite.use();
    pg.tex('uScene', this.sceneRT.tex);
    pg.tex('uBloom', this.bloomResult);
    pg.tex('uDepth', this.depthCopy);
    pg.f2('uRes', this.width, this.height);
    pg.f('uTime', this.time);
    pg.f('uExposure', this.exposure);
    pg.f('uBloomAmt', this.bloomAmt);
    pg.f('uVignette', this.vignette);
    pg.f('uChroma', this.chroma);
    pg.f('uGrain', this.grain);
    pg.f('uSaturation', this.saturation);
    pg.f('uContrast', this.contrast);
    pg.v3('uLift', this.lift);
    pg.v3('uGain', this.gain);
    pg.f('uDamage', this.damage);
    pg.f('uHurt', this.hurt);
    pg.f('uFlash', this.flash);
    pg.f('uAdsBlur', this.adsBlur);
    pg.f('uSpeedBlur', this.speedBlur);
    this.tri.draw();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const fx = this.pg.fxaa.use();
    fx.tex('uTex', this.ldrRT.tex);
    fx.f2('uTexel', 1 / this.width, 1 / this.height);
    this.tri.draw();
  }

  render() {
    const gl = this.gl;
    this._shadowPass();
    this._gbufferPass();

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.gbuf.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthCopyFBO);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height,
      gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._ssaoPass();
    this._lightingPass();
    this._forwardFX();
    this._bloomPass();
    this._compositePass();
    gl.bindVertexArray(null);
  }
}
