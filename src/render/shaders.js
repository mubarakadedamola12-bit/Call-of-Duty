// All GLSL for the deferred pipeline. Kept in one place so the whole shading
// model can be read top-to-bottom.

const H = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
`;

const HV = `#version 300 es
precision highp float;
precision highp int;
`;

export const EM_SCALE = 12.0;

/* ------------------------------------------------------------ shared GLSL */

const COMMON = `
const float PI = 3.14159265359;
const float EM_SCALE = ${EM_SCALE.toFixed(1)};

float sat(float x){ return clamp(x,0.0,1.0); }
vec3  sat3(vec3 x){ return clamp(x,vec3(0.0),vec3(1.0)); }

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x),
             mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float fbm2(vec2 p){
  float s = 0.0, a = 0.5;
  for(int i=0;i<5;i++){ s += a*vnoise(p); p *= 2.03; p += 17.3; a *= 0.5; }
  return s;
}

// Interleaved Gradient Noise (Jimenez) — the dither basis used for shadow
// filtering and banding removal throughout the pipeline.
float ign(vec2 p){
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

const SKY = `
uniform vec3  uSunDir;       // points TOWARD the sun
uniform vec3  uSunColor;
uniform float uTime;

// Cheap analytic sky — also used as the ambient/specular environment.
vec3 skyBase(vec3 d){
  float h = sat(d.y * 0.5 + 0.5);
  float horizon = pow(1.0 - sat(abs(d.y)), 4.5);

  vec3 zenith  = vec3(0.080, 0.170, 0.350);
  vec3 mid     = vec3(0.265, 0.345, 0.490);
  vec3 haze    = vec3(0.640, 0.520, 0.395);

  vec3 col = mix(mid, zenith, pow(sat(d.y), 0.50));
  col = mix(col, haze, horizon * 0.92);

  // Warm forward-scattering lobe around the sun.
  float sd = sat(dot(d, uSunDir));
  col += uSunColor * pow(sd, 5.0)  * 0.36;
  col += uSunColor * pow(sd, 48.0) * 0.55;
  col += vec3(0.55,0.32,0.16) * horizon * pow(sat(dot(normalize(vec3(d.x,0.0,d.z)), normalize(vec3(uSunDir.x,0.0,uSunDir.z)))), 3.0) * 0.55;

  // Ground bounce below the horizon (desert).
  col = mix(col, vec3(0.205, 0.160, 0.110), sat(-d.y * 3.2));
  return col;
}

vec3 skyFull(vec3 d){
  vec3 col = skyBase(d);
  if (d.y > -0.02){
    // Flat-projected cirrus deck.
    vec2 cp = d.xz / max(d.y + 0.10, 0.06);
    float t = uTime * 0.006;
    float c = fbm2(cp * 0.55 + vec2(t, t*0.35));
    c = sat((c - 0.44) * 2.3);
    float c2 = sat((fbm2(cp * 1.45 + vec2(-t*1.6, t*0.9)) - 0.50) * 2.6);
    float cov = sat(c * 0.85 + c2 * 0.45) * sat(d.y * 5.0);
    float lit = pow(sat(dot(d, uSunDir)) * 0.5 + 0.5, 3.0);
    vec3 cloud = mix(vec3(0.30,0.28,0.32), vec3(1.35,1.02,0.80), lit);
    cloud += uSunColor * pow(sat(dot(d,uSunDir)), 14.0) * 0.7;
    col = mix(col, cloud, cov * 0.72);
  }
  // Sun disc with a soft limb.
  float sd = dot(d, uSunDir);
  col += uSunColor * 22.0 * smoothstep(0.99920, 0.99975, sd);
  col += uSunColor * 2.0  * smoothstep(0.9955, 0.9993, sd);
  return col;
}
`;

const PBR = `
vec3 F_Schlick(vec3 f0, float u){
  float f = pow(1.0 - u, 5.0);
  return f0 + (vec3(1.0) - f0) * f;
}
float D_GGX(float NoH, float a){
  float a2 = a*a;
  float d = (NoH*a2 - NoH)*NoH + 1.0;
  return a2 / max(PI*d*d, 1e-7);
}
float V_SmithGGX(float NoV, float NoL, float a){
  float a2 = a*a;
  float lv = NoL * sqrt(NoV*NoV*(1.0-a2)+a2);
  float ll = NoV * sqrt(NoL*NoL*(1.0-a2)+a2);
  return 0.5 / max(lv+ll, 1e-6);
}
// Karis' analytic split-sum environment BRDF approximation.
vec3 envBRDFApprox(vec3 f0, float rough, float NoV){
  const vec4 c0 = vec4(-1.0, -0.0275, -0.5724, 0.0);
  const vec4 c1 = vec4( 1.0,  0.0425,  1.0400, -0.0400);
  vec4 r = vec4(rough,rough,rough,rough) * c0 + c1;
  float a004 = min(r.x*r.x, exp2(-9.28*NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}
`;

/* -------------------------------------------------------------- G-buffer */

export const gbufferVS = HV + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aTan;

uniform mat4 uVP;
uniform mat4 uModel;
uniform mat3 uNM;

out vec3 vW;
out vec3 vN;
out vec2 vUV;
out vec3 vT;
out float vTW;

void main(){
  vec4 wp = uModel * vec4(aPos, 1.0);
  vW  = wp.xyz;
  vN  = normalize(uNM * aNrm);
  vT  = normalize(uNM * aTan.xyz);
  vTW = aTan.w;
  vUV = aUV;
  gl_Position = uVP * wp;
}`;

export const gbufferFS = H + COMMON + `
in vec3 vW; in vec3 vN; in vec2 vUV; in vec3 vT; in float vTW;

uniform sampler2DArray uAlbedoArr;
uniform sampler2DArray uSurfArr;
uniform float uLayer;
uniform vec2  uUVScale;
uniform vec3  uTint;
uniform vec3  uEmissive;
uniform float uRoughMul;
uniform float uMetalMul;
uniform float uNormalScale;
uniform float uMacro;      // 0..1 — strength of large-scale tint break-up
uniform float uAOMul;

layout(location=0) out vec4 oAlbedo;   // rgb albedo, a baked AO
layout(location=1) out vec4 oNormal;   // xyz world normal, w roughness
layout(location=2) out vec4 oMisc;     // rgb emissive/EM_SCALE, a metallic

void main(){
  vec2 uv = vUV * uUVScale;
  vec4 alb = texture(uAlbedoArr, vec3(uv, uLayer));
  vec4 srf = texture(uSurfArr,   vec3(uv, uLayer));

  vec3 base = alb.rgb * uTint;

  // Break tiling with two octaves of low-frequency world-space variation.
  if (uMacro > 0.0){
    float m = fbm2(vW.xz * 0.055) * 0.65 + fbm2(vW.xz * 0.013) * 0.35;
    base *= mix(1.0, 0.62 + m * 0.85, uMacro);
  }

  vec3 N = normalize(vN);
  vec3 T = normalize(vT - N * dot(N, vT));
  vec3 B = cross(N, T) * vTW;
  vec3 tn = vec3(srf.rg * 2.0 - 1.0, 0.0);
  tn.xy *= uNormalScale;
  tn.z = sqrt(max(1.0 - dot(tn.xy, tn.xy), 1e-4));
  vec3 Nw = normalize(T * tn.x + B * tn.y + N * tn.z);

  oAlbedo = vec4(base, clamp(alb.a * uAOMul, 0.0, 1.0));
  oNormal = vec4(Nw, clamp(srf.b * uRoughMul, 0.055, 1.0));
  oMisc   = vec4(uEmissive / EM_SCALE, clamp(srf.a * uMetalMul, 0.0, 1.0));
}`;

/* ---------------------------------------------------------------- shadow */

export const shadowVS = HV + `
layout(location=0) in vec3 aPos;
uniform mat4 uLightVP;
uniform mat4 uModel;
void main(){ gl_Position = uLightVP * uModel * vec4(aPos,1.0); }`;

export const shadowFS = HV + `
out vec4 o;
void main(){ o = vec4(1.0); }`;

/* ------------------------------------------------------------ fullscreen */

export const fsTriVS = HV + `
out vec2 vUV;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* ------------------------------------------------------------------ SSAO */

export const ssaoFS = H + COMMON + `
in vec2 vUV;
uniform sampler2D uDepth;
uniform sampler2D uNormal;
uniform sampler2D uNoise;
uniform mat4 uProj, uInvProj, uView;
uniform vec2 uRes;
uniform float uRadius, uBias, uIntensity;
uniform float uFrame;
out vec4 oCol;

vec3 viewPosFromDepth(vec2 uv, float d){
  vec4 c = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uInvProj * c;
  return v.xyz / v.w;
}

void main(){
  float d = texture(uDepth, vUV).r;
  if (d >= 0.9999){ oCol = vec4(1.0); return; }

  vec3 P  = viewPosFromDepth(vUV, d);
  vec3 Nw = texture(uNormal, vUV).xyz;
  vec3 N  = normalize(mat3(uView) * Nw);

  float rot = ign(gl_FragCoord.xy + uFrame * 5.588238) * PI * 2.0;
  float cr = cos(rot), sr = sin(rot);

  float occ = 0.0;
  const int K = 16;
  for (int i = 0; i < K; i++){
    // Cosine-ish hemisphere spiral, radius grows with sample index.
    float fi = float(i) + 0.5;
    float a = fi * 2.39996323 + rot;
    float r = sqrt(fi / float(K));
    vec3 s = vec3(cos(a) * r, sin(a) * r, 0.0);
    s.z = sqrt(max(0.05, 1.0 - r * r));
    // Orient into the hemisphere around N.
    vec3 up = abs(N.z) < 0.9 ? vec3(0.0,0.0,1.0) : vec3(1.0,0.0,0.0);
    vec3 t = normalize(cross(up, N));
    vec3 b = cross(N, t);
    vec3 dir = t * (s.x*cr - s.y*sr) + b * (s.x*sr + s.y*cr) + N * s.z;

    float scale = mix(0.25, 1.0, r * r);
    vec3 sp = P + dir * uRadius * scale;

    vec4 op = uProj * vec4(sp, 1.0);
    vec2 suv = (op.xy / op.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float sd = texture(uDepth, suv).r;
    vec3 sampleP = viewPosFromDepth(suv, sd);
    float dz = sampleP.z - sp.z;
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sampleP.z), 1e-4));
    occ += (dz >= uBias ? 1.0 : 0.0) * rangeCheck;
  }
  float ao = 1.0 - (occ / float(K)) * uIntensity;
  oCol = vec4(sat(ao), 0.0, 0.0, 1.0);
}`;

export const blurFS = H + `
in vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform vec2 uDir;
out vec4 oCol;
void main(){
  float c = texture(uDepth, vUV).r;
  float sum = 0.0, wsum = 0.0;
  for (int i = -3; i <= 3; i++){
    vec2 uv = vUV + uDir * uTexel * float(i);
    float d = texture(uDepth, uv).r;
    float w = exp(-float(i*i) * 0.22) * exp(-abs(d - c) * 900.0);
    sum += texture(uTex, uv).r * w;
    wsum += w;
  }
  oCol = vec4(sum / max(wsum, 1e-4), 0.0, 0.0, 1.0);
}`;

/* -------------------------------------------------------- deferred resolve */

export const MAX_LIGHTS = 40;

export const lightingFS = H + COMMON + SKY + PBR + `
in vec2 vUV;

uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uMisc;
uniform sampler2D uDepth;
uniform sampler2D uAO;
uniform sampler2D uShadow;

uniform sampler2D uShadowFar;

uniform mat4  uInvVP;
uniform mat4  uLightVP;
uniform mat4  uLightVPFar;
uniform vec3  uCamPos;
uniform vec2  uRes;
uniform float uShadowTexel;
uniform float uShadowTexelFar;
uniform float uShadowWorld;      // near-cascade texel size in metres
uniform float uShadowWorldFar;
uniform float uCascadeSplit;
uniform vec3  uAmbientTint;
uniform float uAmbientMul;
uniform float uFogDensity;
uniform float uFogHeight;
uniform vec3  uFogColor;

uniform vec4 uLightPosR[${MAX_LIGHTS}];    // xyz pos, w radius
uniform vec4 uLightCol[${MAX_LIGHTS}];     // rgb colour, a intensity
uniform int  uLightCount;

out vec4 oCol;

// 8-tap spiral PCF jittered by Interleaved Gradient Noise — cheap, temporally
// stable, and it gives varied penumbra steps instead of a fixed kernel shape.
float pcf(sampler2D smap, vec3 pc, float texel, float rot){
  // Depth bias is tiny because the heavy lifting is done by the world-space
  // normal offset applied before projection.
  const float bias = 0.00035;
  float ca = cos(rot), sa = sin(rot);
  float sum = 0.0;
  const int T = 8;
  for (int i = 0; i < T; i++){
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(T)) * 2.35;
    float ang = fi * 2.39996323;
    vec2 o = vec2(cos(ang), sin(ang)) * r;
    o = vec2(o.x * ca - o.y * sa, o.x * sa + o.y * ca) * texel;
    float sd = texture(smap, pc.xy + o).r;
    sum += (pc.z - bias) <= sd ? 1.0 : 0.0;
  }
  return sum / float(T);
}

bool inMap(vec3 pc){
  return pc.z <= 1.0 && pc.x > 0.015 && pc.x < 0.985 && pc.y > 0.015 && pc.y < 0.985;
}

// Two cascades: a tight one snapped ahead of the player for crisp contact
// shadows, and a loose one covering the whole arena. Blended in the overlap.
//
// The lookup position is pushed along the GEOMETRIC normal (never the
// normal-mapped one — that makes the bias oscillate with surface detail and
// turns every shadow edge into a sawtooth).
float shadowFactor(vec3 wpos, vec3 Ngeo, float NoLg){
  float rot = ign(gl_FragCoord.xy) * PI * 2.0;
  float slope = 1.0 + 2.6 * sqrt(sat(1.0 - NoLg * NoLg));

  vec3 wF = wpos + Ngeo * uShadowWorldFar * 1.7 * slope;
  vec4 lpF = uLightVPFar * vec4(wF, 1.0);
  vec3 pcF = lpF.xyz / lpF.w * 0.5 + 0.5;
  float far = inMap(pcF) ? pcf(uShadowFar, pcF, uShadowTexelFar, rot) : 1.0;

  vec3 wN = wpos + Ngeo * uShadowWorld * 1.7 * slope;
  vec4 lpN = uLightVP * vec4(wN, 1.0);
  vec3 pcN = lpN.xyz / lpN.w * 0.5 + 0.5;
  if (!inMap(pcN)) return far;

  float near = pcf(uShadow, pcN, uShadowTexel, rot);
  // Fade to the far cascade as we approach the near cascade's border.
  vec2 e = abs(pcN.xy - 0.5) * 2.0;
  float edge = max(e.x, e.y);
  return mix(near, far, smoothstep(0.80, 0.97, edge));
}

vec3 shade(vec3 N, vec3 V, vec3 L, vec3 radiance, vec3 diffCol, vec3 f0, float rough){
  vec3 Hv = normalize(V + L);
  float NoL = sat(dot(N, L));
  float NoV = abs(dot(N, V)) + 1e-5;
  float NoH = sat(dot(N, Hv));
  float VoH = sat(dot(V, Hv));
  float a = max(rough * rough, 0.0018);
  float D = D_GGX(NoH, a);
  float Vis = V_SmithGGX(NoV, NoL, a);
  vec3  F = F_Schlick(f0, VoH);
  vec3 spec = D * Vis * F;
  vec3 kd = (vec3(1.0) - F);
  return (kd * diffCol / PI + spec) * radiance * NoL;
}

void main(){
  float depth = texture(uDepth, vUV).r;

  vec4 ndc = vec4(vUV * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 wp4 = uInvVP * ndc;
  vec3 W = wp4.xyz / wp4.w;
  vec3 V = normalize(uCamPos - W);

  if (depth >= 0.99999){
    vec3 dir = normalize(W - uCamPos);
    oCol = vec4(skyFull(dir), 1.0);
    return;
  }

  vec4 ab = texture(uAlbedo, vUV);
  vec4 nr = texture(uNormal, vUV);
  vec4 ms = texture(uMisc, vUV);

  vec3  albedo = ab.rgb;
  float bakedAO = ab.a;
  vec3  N = normalize(nr.xyz);
  float rough = nr.w;
  float metal = ms.a;
  vec3  emis = ms.rgb * EM_SCALE;
  float ssao = texture(uAO, vUV).r;
  float ao = bakedAO * ssao;

  vec3 diffCol = albedo * (1.0 - metal);
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  float NoV = sat(dot(N, V));

  // ---- sun
  // Geometric normal from the reconstructed position, used for shadow bias and
  // to soften the terminator where the normal map disagrees with the surface.
  vec3 Ngeo = normalize(cross(dFdx(W), dFdy(W)));
  if (dot(Ngeo, V) < 0.0) Ngeo = -Ngeo;

  vec3 Lsun = normalize(uSunDir);
  float NoLs = sat(dot(N, Lsun));
  float NoLg = dot(Ngeo, Lsun);
  float sh = NoLg > 0.0 ? shadowFactor(W, Ngeo, NoLg) : 0.0;
  // Fade the sun out across the geometric terminator so normal-mapped detail
  // can't be lit by a sun that the surface itself is facing away from.
  sh *= smoothstep(-0.02, 0.14, NoLg);
  vec3 col = shade(N, V, Lsun, uSunColor * sh, diffCol, f0, rough);

  // ---- ambient / IBL from the analytic sky
  vec3 skyUp   = skyBase(vec3(0.0, 1.0, 0.0));
  vec3 skyN    = skyBase(N);
  vec3 ground  = vec3(0.185, 0.128, 0.078);
  float upness = N.y * 0.5 + 0.5;
  vec3 irr = mix(ground, mix(skyN, skyUp, 0.45), upness) * uAmbientTint * uAmbientMul;
  col += diffCol * irr * ao;

  vec3 R = reflect(-V, N);
  vec3 envSpec = mix(skyBase(R), skyUp * 0.85, rough * rough);
  envSpec *= uAmbientTint * uAmbientMul;
  col += envSpec * envBRDFApprox(f0, rough, NoV) * mix(ao, 1.0, 0.35);

  // Horizon-facing spec occlusion keeps metal from glowing in crevices.
  col *= mix(1.0, sat(ao * 1.15), 0.25);

  // ---- dynamic point lights (muzzle flashes, tracers, fires, explosions)
  for (int i = 0; i < ${MAX_LIGHTS}; i++){
    if (i >= uLightCount) break;
    vec3 lp = uLightPosR[i].xyz;
    float radius = uLightPosR[i].w;
    vec3 dl = lp - W;
    float d2 = dot(dl, dl);
    float r2 = radius * radius;
    if (d2 > r2) continue;
    float d = sqrt(max(d2, 1e-6));
    vec3 L = dl / d;
    // Inverse-square with a smooth window so lights fade out cleanly.
    float win = sat(1.0 - (d2 / r2));
    float atten = win * win / (d2 + 0.06);
    vec3 radiance = uLightCol[i].rgb * uLightCol[i].a * atten;
    col += shade(N, V, L, radiance, diffCol, f0, rough);
  }

  col += emis;

  // ---- height fog with sun inscattering
  float dist = length(uCamPos - W);
  float hf = exp(-max(W.y, 0.0) / uFogHeight);
  float camHf = exp(-max(uCamPos.y, 0.0) / uFogHeight);
  float fogAmt = 1.0 - exp(-uFogDensity * dist * (hf + camHf) * 0.5);
  vec3 vd = normalize(W - uCamPos);
  float sunAmt = pow(sat(dot(vd, uSunDir)), 8.0);
  vec3 fogCol = uFogColor + uSunColor * sunAmt * 0.55;
  col = mix(col, fogCol, sat(fogAmt));

  oCol = vec4(col, 1.0);
}`;

/* ----------------------------------------------------------------- bloom */
// Pyramidal down/upsample (Jimenez, CoD:AW): 13-tap box-ish downsample with a
// Karis luma-weighted average on the first level, 3x3 tent on the way up.

export const bloomPrefilterFS = H + COMMON + `
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold, uSoftKnee, uClamp;
out vec4 oCol;

vec3 fetch(vec2 uv){ return min(texture(uTex, uv).rgb, vec3(uClamp)); }

void main(){
  vec2 t = uTexel;
  vec3 a = fetch(vUV + t*vec2(-1,-1));
  vec3 b = fetch(vUV + t*vec2( 1,-1));
  vec3 c = fetch(vUV + t*vec2(-1, 1));
  vec3 d = fetch(vUV + t*vec2( 1, 1));
  vec3 e = fetch(vUV);
  vec3 col = (a+b+c+d) * 0.125 + e * 0.5;

  float br = max(col.r, max(col.g, col.b));
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0*knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  oCol = vec4(col * contrib, 1.0);
}`;

export const bloomDownFS = H + `
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 oCol;
void main(){
  vec2 t = uTexel;
  vec3 a = texture(uTex, vUV + t*vec2(-2,-2)).rgb;
  vec3 b = texture(uTex, vUV + t*vec2( 0,-2)).rgb;
  vec3 c = texture(uTex, vUV + t*vec2( 2,-2)).rgb;
  vec3 d = texture(uTex, vUV + t*vec2(-1,-1)).rgb;
  vec3 e = texture(uTex, vUV + t*vec2( 1,-1)).rgb;
  vec3 f = texture(uTex, vUV + t*vec2(-2, 0)).rgb;
  vec3 g = texture(uTex, vUV).rgb;
  vec3 h = texture(uTex, vUV + t*vec2( 2, 0)).rgb;
  vec3 i = texture(uTex, vUV + t*vec2(-1, 1)).rgb;
  vec3 j = texture(uTex, vUV + t*vec2( 1, 1)).rgb;
  vec3 k = texture(uTex, vUV + t*vec2(-2, 2)).rgb;
  vec3 l = texture(uTex, vUV + t*vec2( 0, 2)).rgb;
  vec3 m = texture(uTex, vUV + t*vec2( 2, 2)).rgb;
  vec3 o = (d+e+i+j) * 0.125
         + (a+b+g+f) * 0.03125
         + (b+c+h+g) * 0.03125
         + (f+g+l+k) * 0.03125
         + (g+h+m+l) * 0.03125;
  oCol = vec4(o, 1.0);
}`;

export const bloomUpFS = H + `
in vec2 vUV;
uniform sampler2D uTex;      // lower-res mip being upsampled
uniform sampler2D uPrev;     // higher-res mip to blend with
uniform vec2 uTexel;
uniform float uRadius;
uniform float uBlend;        // progressive blend keeps total energy bounded
out vec4 oCol;
void main(){
  vec2 t = uTexel * uRadius;
  vec3 s = texture(uTex, vUV + t*vec2(-1,-1)).rgb * 1.0
         + texture(uTex, vUV + t*vec2( 0,-1)).rgb * 2.0
         + texture(uTex, vUV + t*vec2( 1,-1)).rgb * 1.0
         + texture(uTex, vUV + t*vec2(-1, 0)).rgb * 2.0
         + texture(uTex, vUV).rgb                 * 4.0
         + texture(uTex, vUV + t*vec2( 1, 0)).rgb * 2.0
         + texture(uTex, vUV + t*vec2(-1, 1)).rgb * 1.0
         + texture(uTex, vUV + t*vec2( 0, 1)).rgb * 2.0
         + texture(uTex, vUV + t*vec2( 1, 1)).rgb * 1.0;
  // Blending (rather than summing) each level keeps the pyramid energy-neutral;
  // summing 6 mips multiplies the bright energy and fogs the whole frame.
  oCol = vec4(mix(texture(uPrev, vUV).rgb, s * (1.0/16.0), uBlend), 1.0);
}`;

/* ------------------------------------------------------------- composite */

export const compositeFS = H + COMMON + `
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uDepth;
uniform vec2  uRes;
uniform float uTime;
uniform float uExposure;
uniform float uBloomAmt;
uniform float uVignette;
uniform float uChroma;
uniform float uGrain;
uniform float uSaturation;
uniform float uContrast;
uniform vec3  uLift, uGain;
uniform float uDamage;      // red flash on taking a hit
uniform float uHurt;        // sustained low-health desaturation
uniform float uFlash;       // white-out (stun / spawn)
uniform float uAdsBlur;     // peripheral blur strength when aiming
uniform float uSpeedBlur;   // radial blur while sprinting
out vec4 oCol;

// ACES filmic (Stephen Hill's fit)
const mat3 ACESIn = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACESOut = mat3(
  1.60475, -0.10208, -0.00327,
 -0.53108,  1.10813, -0.07276,
 -0.07367, -0.00605,  1.07602);
vec3 RRT(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 c){
  c = ACESIn * c;
  c = RRT(c);
  c = ACESOut * c;
  return sat3(c);
}

void main(){
  vec2 uv = vUV;
  vec2 cen = uv - 0.5;
  float r2 = dot(cen, cen);

  // Radial sprint blur + peripheral ADS blur, folded into one gather.
  float blurAmt = uSpeedBlur * sat(r2 * 3.0) + uAdsBlur * sat(r2 * 2.2 - 0.06);
  vec3 scene;
  if (blurAmt > 0.001){
    vec3 acc = vec3(0.0);
    float j = ign(gl_FragCoord.xy + uTime * 61.0);
    for (int i = 0; i < 6; i++){
      float t = (float(i) + j) / 6.0;
      vec2 suv = uv - cen * t * blurAmt * 0.16;
      acc += texture(uScene, suv).rgb;
    }
    scene = acc / 6.0;
  } else {
    scene = texture(uScene, uv).rgb;
  }

  // Chromatic aberration grows toward the frame edge.
  float ca = uChroma * (0.55 + r2 * 2.6);
  if (ca > 0.0001){
    vec2 off = cen * ca * 0.014;
    scene.r = texture(uScene, uv + off).r;
    scene.b = texture(uScene, uv - off).b;
  }

  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 col = scene + bloom * uBloomAmt;

  // Anamorphic-ish streak lift from the bloom chain.
  col += bloom * vec3(0.12, 0.06, 0.22) * uBloomAmt;

  col *= uExposure;
  col = acesFitted(col);

  // Lift / gain / contrast / saturation grade — cool shadows, warm highlights.
  col = col * uGain + uLift * (1.0 - col);
  col = sat3((col - 0.5) * uContrast + 0.5);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSaturation);

  // Low-health: desaturate and crush toward red.
  col = mix(col, vec3(dot(col, vec3(0.33))) * vec3(1.25, 0.62, 0.55), uHurt * 0.75);

  float vig = pow(sat(1.0 - r2 * uVignette), 1.65);
  col *= mix(1.0, vig, 0.92);

  // Damage direction flash.
  col = mix(col, vec3(0.72, 0.045, 0.03), uDamage * sat(0.25 + r2 * 2.6));
  col = mix(col, vec3(1.0), uFlash);

  // Film grain, stronger in the shadows.
  float g = hash12(gl_FragCoord.xy + fract(uTime) * 1000.0) - 0.5;
  col += g * uGrain * mix(1.6, 0.35, sat(lum));

  // Ordered dither to kill 8-bit banding.
  col += (ign(gl_FragCoord.xy) - 0.5) / 255.0;

  oCol = vec4(sat3(col), 1.0);
}`;

/* ------------------------------------------------------------------ FXAA */

export const fxaaFS = H + `
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 oCol;

float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

void main(){
  vec3 rgbM = texture(uTex, vUV).rgb;
  float lM  = luma(rgbM);
  float lNW = luma(texture(uTex, vUV + uTexel*vec2(-1,-1)).rgb);
  float lNE = luma(texture(uTex, vUV + uTexel*vec2( 1,-1)).rgb);
  float lSW = luma(texture(uTex, vUV + uTexel*vec2(-1, 1)).rgb);
  float lSE = luma(texture(uTex, vUV + uTexel*vec2( 1, 1)).rgb);

  float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE)));
  float lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));
  float range = lMax - lMin;
  if (range < max(0.0312, lMax * 0.125)){ oCol = vec4(rgbM, 1.0); return; }

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;

  vec3 rgbA = 0.5 * (texture(uTex, vUV + dir * (1.0/3.0 - 0.5)).rgb +
                     texture(uTex, vUV + dir * (2.0/3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(uTex, vUV - dir * 0.5).rgb +
                                   texture(uTex, vUV + dir * 0.5).rgb);
  float lB = luma(rgbB);
  oCol = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}`;

/* ============================================================== FORWARD FX */

const FXCOMMON = `
const float PI = 3.14159265359;
float sat(float x){ return clamp(x,0.0,1.0); }
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x),
             mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float fbm2(vec2 p){
  float s = 0.0, a = 0.5;
  for(int i=0;i<4;i++){ s += a*vnoise(p); p *= 2.07; p += 11.7; a *= 0.5; }
  return s;
}
`;

/* -------------------------------------------------------------- particles */

export const particleVS = HV + `
layout(location=0) in vec4 aPosSize;   // xyz world, w size
layout(location=1) in vec4 aColor;     // rgb, a alpha
layout(location=2) in vec4 aParams;    // x rot, y stretchY, z kind, w glow

uniform mat4 uVP;
uniform vec3 uCamRight, uCamUp;

out vec2 vQuad;
out vec4 vColor;
out vec4 vParams;
out vec4 vClip;

void main(){
  int id = gl_VertexID;
  vec2 c = vec2((id == 0 || id == 3 || id == 5) ? -1.0 : 1.0,
                (id == 0 || id == 1 || id == 3) ? -1.0 : 1.0);
  if (id == 4) c = vec2(1.0, 1.0);
  vQuad = c;
  float s = sin(aParams.x), co = cos(aParams.x);
  vec2 rc = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
  rc.y *= aParams.y;
  vec3 wp = aPosSize.xyz + (uCamRight * rc.x + uCamUp * rc.y) * aPosSize.w;
  vColor = aColor;
  vParams = aParams;
  vClip = uVP * vec4(wp, 1.0);
  gl_Position = vClip;
}`;

export const particleFS = H + FXCOMMON + `
in vec2 vQuad;
in vec4 vColor;
in vec4 vParams;
in vec4 vClip;

uniform sampler2D uDepth;
uniform vec2 uRes;
uniform float uNear, uFar;
uniform float uTime;
out vec4 oCol;

float linearizeDepth(float d){
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

void main(){
  float r = length(vQuad);
  int kind = int(vParams.z + 0.5);
  float a = vColor.a;
  vec3 col = vColor.rgb;

  if (kind == 0){            // smoke / dust puff
    float n = fbm2(vQuad * 1.6 + vec2(vParams.w * 7.0, uTime * 0.05));
    float d = sat(1.0 - r) * (0.55 + n * 0.85);
    a *= smoothstep(0.0, 0.55, d);
    col *= 0.75 + n * 0.6;
  } else if (kind == 1){     // spark
    float core = exp(-r * r * 9.0);
    a *= core;
    col *= 1.0 + core * 2.5;
  } else if (kind == 2){     // muzzle flash star
    float ang = atan(vQuad.y, vQuad.x);
    float star = 0.55 + 0.45 * pow(abs(cos(ang * 3.0 + vParams.w * 6.28)), 3.0);
    float core = exp(-r * r * 5.0) * star;
    float glow = exp(-r * 2.4);
    a *= sat(core * 1.4 + glow * 0.55);
    col *= 1.0 + core * 3.0;
  } else if (kind == 3){     // hard debris fleck
    a *= step(r, 0.9) * sat(1.4 - r);
  } else if (kind == 4){     // blood mist
    float n = fbm2(vQuad * 3.0 + vParams.w * 11.0);
    a *= smoothstep(0.0, 0.6, sat(1.0 - r) * (0.4 + n));
  } else if (kind == 5){     // shockwave ring
    float ring = exp(-pow((r - 0.78) * 7.0, 2.0));
    a *= ring;
    col *= 1.0 + ring;
  }
  if (a <= 0.003) discard;

  // Soft-particle fade against scene depth.
  vec2 suv = gl_FragCoord.xy / uRes;
  float sceneZ = linearizeDepth(texture(uDepth, suv).r);
  float myZ = linearizeDepth(gl_FragCoord.z);
  a *= sat((sceneZ - myZ) * 3.2);
  if (a <= 0.003) discard;

  oCol = vec4(col * a, a);
}`;

/* ------------------------------------------------------------ beams/tracer */

export const beamVS = HV + `
layout(location=0) in vec4 aA;      // xyz start, w width
layout(location=1) in vec4 aB;      // xyz end
layout(location=2) in vec4 aColor;

uniform mat4 uVP;
uniform vec3 uCamPos;

out vec2 vQuad;
out vec4 vColor;

void main(){
  int id = gl_VertexID;
  vec2 c = vec2((id == 0 || id == 3 || id == 5) ? 0.0 : 1.0,
                (id == 0 || id == 1 || id == 3) ? -1.0 : 1.0);
  if (id == 4) c = vec2(1.0, 1.0);
  vQuad = c;
  vec3 p = mix(aA.xyz, aB.xyz, c.x);
  vec3 axis = normalize(aB.xyz - aA.xyz + vec3(1e-6));
  vec3 toCam = normalize(uCamPos - p);
  vec3 side = normalize(cross(axis, toCam));
  p += side * c.y * aA.w;
  vColor = aColor;
  gl_Position = uVP * vec4(p, 1.0);
}`;

export const beamFS = H + FXCOMMON + `
in vec2 vQuad;
in vec4 vColor;
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform float uNear, uFar;
out vec4 oCol;

float linearizeDepth(float d){
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

void main(){
  float across = 1.0 - abs(vQuad.y);
  float core = pow(across, 6.0);
  float glow = pow(across, 1.6);
  // Bright hot head, fading tail.
  float along = pow(sat(vQuad.x), 1.5) * 0.85 + 0.15;
  float a = vColor.a * (core * 0.85 + glow * 0.35) * along;
  vec3 col = vColor.rgb * (1.0 + core * 4.0);

  vec2 suv = gl_FragCoord.xy / uRes;
  float sceneZ = linearizeDepth(texture(uDepth, suv).r);
  float myZ = linearizeDepth(gl_FragCoord.z);
  a *= sat((sceneZ - myZ) * 6.0);
  if (a <= 0.004) discard;
  oCol = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ decals */

export const decalVS = HV + `
layout(location=0) in vec4 aPosSize;   // xyz world, w size
layout(location=1) in vec4 aNormal;    // xyz surface normal, w rotation
layout(location=2) in vec4 aParams;    // x kind, y alpha, z seed, w unused

uniform mat4 uVP;
out vec2 vQuad;
out vec3 vN;
out vec4 vParams;
out vec3 vT;

void main(){
  int id = gl_VertexID;
  vec2 c = vec2((id == 0 || id == 3 || id == 5) ? -1.0 : 1.0,
                (id == 0 || id == 1 || id == 3) ? -1.0 : 1.0);
  if (id == 4) c = vec2(1.0, 1.0);
  vQuad = c;
  vec3 N = normalize(aNormal.xyz);
  vec3 up = abs(N.y) > 0.95 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  float s = sin(aNormal.w), co = cos(aNormal.w);
  vec2 rc = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
  vec3 wp = aPosSize.xyz + (T * rc.x + B * rc.y) * aPosSize.w;
  vN = N; vT = T;
  vParams = aParams;
  gl_Position = uVP * vec4(wp, 1.0);
}`;

export const decalFS = H + FXCOMMON + `
in vec2 vQuad;
in vec3 vN;
in vec3 vT;
in vec4 vParams;

layout(location=0) out vec4 oAlbedo;
layout(location=1) out vec4 oNormal;
layout(location=2) out vec4 oMisc;

void main(){
  float r = length(vQuad);
  float seed = vParams.z;
  int kind = int(vParams.x + 0.5);

  // Irregular rim so holes don't read as perfect circles.
  float ang = atan(vQuad.y, vQuad.x);
  float wob = fbm2(vec2(cos(ang), sin(ang)) * 3.0 + seed * 31.0);
  float edge = 0.72 + wob * 0.30;
  if (r > edge) discard;

  float crater = sat(1.0 - r / edge);
  float alpha = vParams.y * smoothstep(0.0, 0.22, crater);
  if (alpha < 0.02) discard;

  vec3 albedo; float rough; float metal = 0.0; vec3 emis = vec3(0.0);

  if (kind == 0){                 // bullet impact on hard surface
    float hole = smoothstep(0.42, 0.16, r / edge);
    float ring = smoothstep(0.30, 0.55, r / edge) * smoothstep(1.0, 0.72, r / edge);
    albedo = mix(vec3(0.30, 0.28, 0.26), vec3(0.012, 0.010, 0.010), hole);
    albedo = mix(albedo, vec3(0.60, 0.57, 0.52), ring * 0.7 * (0.5 + wob));
    rough = mix(0.95, 0.65, hole);
  } else if (kind == 1){          // scorch / explosion mark
    float c = sat(1.0 - r / edge);
    albedo = mix(vec3(0.10,0.09,0.085), vec3(0.02,0.018,0.016), c);
    rough = 0.98;
  } else {                        // blood splatter
    float c = sat(1.0 - r / edge);
    albedo = mix(vec3(0.16,0.015,0.012), vec3(0.30,0.02,0.015), c);
    rough = mix(0.55, 0.30, c);
  }

  // Fake a pushed-in dent by tilting the normal toward the crater centre.
  vec3 N = normalize(vN);
  vec3 up = abs(N.y) > 0.95 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  float dent = smoothstep(0.55, 0.0, r / edge) * (kind == 0 ? 1.0 : 0.25);
  vec3 Nw = normalize(N + (T * vQuad.x + B * vQuad.y) * dent * 1.5);

  oAlbedo = vec4(albedo, mix(1.0, 0.45, dent));
  oNormal = vec4(Nw, rough);
  oMisc   = vec4(emis, metal);
}`;

/* -------------------------------------------------- unlit forward (holo/UI) */

export const unlitVS = HV + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aTan;
uniform mat4 uVP, uModel;
out vec2 vUV; out vec3 vN; out vec3 vW;
void main(){
  vec4 wp = uModel * vec4(aPos,1.0);
  vUV = aUV; vN = mat3(uModel) * aNrm; vW = wp.xyz;
  gl_Position = uVP * wp;
}`;

export const unlitFS = H + FXCOMMON + `
in vec2 vUV; in vec3 vN; in vec3 vW;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform vec3 uCamPos;
uniform float uMode;    // 0 flat, 1 holo scanline, 2 fresnel shell
out vec4 oCol;
void main(){
  vec3 col = uColor;
  float a = uAlpha;
  int mode = int(uMode + 0.5);
  if (mode == 1){
    float scan = 0.72 + 0.28 * sin(vUV.y * 90.0 - uTime * 6.0);
    col *= scan;
    a *= 0.55 + 0.45 * scan;
  } else if (mode == 2){
    vec3 V = normalize(uCamPos - vW);
    float f = pow(1.0 - sat(dot(normalize(vN), V)), 2.2);
    a *= f;
    col *= 0.6 + f;
  }
  oCol = vec4(col * a, a);
}`;
