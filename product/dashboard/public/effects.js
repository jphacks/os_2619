// Magic effects over the third-person video. Everything is drawn into its own HDR layer, bloomed on its own and then laid
// over the scene, so the video never blooms (selective bloom without layers).
// World frame: metres, y up (world.js). Sizes are world metres, so effects shrink with distance like real objects.
//
// Three GPU batches, all additive, no depth test:
// - particles: ring buffer of instanced quads; motion is analytic in the vertex shader (drag, gravity, turbulence),
//   so JS only writes a particle once when it is born
// - sprites: instanced quads rewritten every frame (fireball / plasma cores, glows, rings, swirls, afterimages)
// - segments: instanced screen-space capsules for lightning and glowing sticks
// Premultiplied blending everywhere: glows/sparks/bolts add (alpha ~0), flames and smoke also cover what is behind them
// (alpha > 0), so dense fire stays orange instead of summing to white. The layer alpha then hides the video behind the effect.
import * as THREE from 'three';
import { createFireEffects } from './fire-effects.js';
import { createThunderEffects } from './thunder-effects.js';
import { createChargeEffects } from './charge-effects.js';

const TAU = Math.PI * 2;
const K = { FLAME: 0, SMOKE: 1, SPARK: 2, GLOW: 3, EMBER: 4 };                              // particle kinds
const S = { GLOW: 0, FIREBALL: 1, PLASMA: 2, RING: 3, SWIRL: 4, FLARE: 5, GHOST: 6 };        // sprite kinds
const COL = {
  fire: [1, .38, .08], ember: [1, .5, .14], smoke: [.09, .06, .05], hot: [1, .78, .45], one: [1, 1, 1],
  elec: [.28, .66, 1], spark: [.62, .86, 1], elecGlow: [.16, .38, 1], white: [.85, .94, 1],
};
const PS = 20, SS = 20, GS = 12; // floats per particle / sprite / segment

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Tileable fbm value noise, generated once. r, g: two independent fbm fields, b: ridged.
function noiseTexture(size = 256, seed = 7) {
  const rnd = mulberry(seed), N = size * size;
  const field = () => {
    const out = new Float32Array(N);
    for (const [period, amp] of [[4, .5], [8, .25], [16, .13], [32, .07], [64, .04]]) {
      const g = Float32Array.from({ length: period * period }, rnd);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const fx = x / size * period, fy = y / size * period, ix = fx | 0, iy = fy | 0;
        let u = fx - ix, v = fy - iy; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
        const x1 = (ix + 1) % period, y1 = (iy + 1) % period;
        const a = g[iy * period + ix], b = g[iy * period + x1], c = g[y1 * period + ix], d = g[y1 * period + x1];
        out[y * size + x] += amp * (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v);
      }
    }
    let lo = 1e9, hi = -1e9; for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < N; i++) out[i] = (out[i] - lo) / (hi - lo);
    return out;
  };
  const r = field(), g = field(), b = field(), data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    data[i * 4] = r[i] * 255; data[i * 4 + 1] = g[i] * 255; data[i * 4 + 2] = (1 - Math.abs(2 * b[i] - 1)) * 255; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ---- shaders ----
const COMMON = `
uniform sampler2D uNoise; uniform float uTime;
#define TAU 6.2831853
vec3 fireRamp(float h) { // 0 dark red smoke .. 1 white-hot
  h = clamp(h, 0., 1.);
  vec3 c = mix(vec3(.16, .012, 0.), vec3(.9, .13, .01), smoothstep(0., .3, h));
  c = mix(c, vec3(1., .45, .04), smoothstep(.25, .55, h));
  c = mix(c, vec3(1., .82, .34), smoothstep(.5, .8, h));
  return mix(c, vec3(1., .97, .86), smoothstep(.8, 1., h));
}`;

const PARTICLE_VS = `
attribute vec4 iA, iB, iC, iD, iE; // p0 t0 | v0 life | size0 size1 drag gravY | rgb kind | seed intensity turb stretch-or-spin
uniform float uTime;
#define TAU 6.2831853
varying vec2 vUv; varying float vX, vKind, vSeed, vInt; varying vec3 vCol;
void main() {
  float age = uTime - iA.w, x = age / iB.w;
  if (age < 0. || x >= 1.) { gl_Position = vec4(2., 2., 2., 1.); return; }
  float k = iC.z, e = exp(-k * age);
  bool dr = k > 1e-3;
  float f = dr ? (1. - e) / k : age;
  vec3 g = vec3(0., iC.w, 0.);
  vec3 p = iA.xyz + iB.xyz * f + (dr ? g * (age - f) / k : .5 * g * age * age);
  vec3 vel = iB.xyz * e + (dr ? g * (1. - e) / k : g * age);
  float s = iE.x * TAU;
  vec3 w = vec3(sin(p.y * 4.3 + uTime * 2.9 + s), sin(p.z * 3.7 + uTime * 2.1 + s * 1.7) * .5, sin(p.x * 4.1 + uTime * 2.5 + s * 2.3));
  p += iE.z * age * w; vel += iE.z * w;
  float size = mix(iC.x, iC.y, x);
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  vec2 c = position.xy;
  if (iD.w > 1.5 && iD.w < 2.5) { // spark: quad stretched along the screen-space velocity, head at c.y = 1
    vec2 d = (modelViewMatrix * vec4(vel, 0.)).xy; float L = length(d) * iE.w;
    d = L > 1e-5 ? normalize(d) : vec2(0., 1.);
    mv.xy += vec2(-d.y, d.x) * c.x * size + d * ((c.y * .5 - .5) * L + c.y * size);
  } else {
    float a = (iD.w < .5 ? 0. : s) + iE.w * age; // flames stay upright so their noise rises
    mv.xy += mat2(cos(a), sin(a), -sin(a), cos(a)) * c * size * (iD.w < .5 ? vec2(.75, 1.25) : vec2(1.));
  }
  vUv = c; vX = x; vKind = iD.w; vSeed = iE.x; vInt = iE.y; vCol = iD.rgb;
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = COMMON + `
varying vec2 vUv; varying float vX, vKind, vSeed, vInt; varying vec3 vCol;
void main() {
  int k = int(vKind + .5);
  float r2 = dot(vUv, vUv), x = vX;
  vec3 rgb = vec3(0.); float occ = 0.;
  if (k == 2) {
    float across = exp(-vUv.x * vUv.x * 4.5) - .011;
    float along = smoothstep(-1., .5, vUv.y) * smoothstep(1., .65, vUv.y);
    float a = max(across, 0.) * along * pow(1. - x, .6);
    rgb = mix(vCol, vec3(1.), across * across * .55) * a * vInt; occ = a * .2;
  } else {
    if (r2 > 1.) discard;
    float fin = smoothstep(0., .07, x);
    if (k == 0) { // flame: teardrop of scrolling noise, eroded as it ages; heat white -> yellow -> orange -> red
      vec2 q = vUv * vec2(.3, .38) + vec2(vSeed * 13.7, vSeed * 7.3 - x * .8);
      float n = texture2D(uNoise, q).r * .55 + texture2D(uNoise, q * 2.7 + .5).g * .45;
      float m = 1. - length(vec2(vUv.x, vUv.y * (vUv.y > 0. ? .8 : 1.1)));
      float dens = smoothstep(0., .9, m) * (.2 + 1.1 * n);
      float th = x * .85;
      float a = smoothstep(th, th + .4, dens) * fin;
      float heat = clamp(dens * 1.2 - x * 1.05 + .05, 0., 1.);
      rgb = fireRamp(heat) * (.1 + 1.25 * heat * heat) * vCol * a * vInt; occ = a * mix(.08, .75, smoothstep(.1, .6, heat)) * min(vInt, 1.);
    } else if (k == 1) { // smoke: dark, hides the video behind it
      vec2 q = vUv * .17 + vec2(vSeed * 5.1, vSeed * 9.7 - x * .3);
      float dens = (texture2D(uNoise, q).g * .65 + texture2D(uNoise, q * 2.1).r * .35) * (1. - r2) * 1.8;
      float th = .25 + x * .45;
      float a = smoothstep(th, th + .35, dens) * smoothstep(0., .25, x) * (1. - x);
      rgb = vCol * a * vInt; occ = a * .28 * vInt;
    } else if (k == 3) { // soft glow puff
      float g = exp(-r2 * 5.) - exp(-5.);
      float a = g * pow(1. - x, 1.5) * fin;
      rgb = vCol * a * vInt; occ = a * .12;
    } else { // ember dot
      float g = exp(-r2 * 9.) - exp(-9.);
      float fl = .55 + .45 * sin(uTime * 31. + vSeed * 60.);
      float a = g * fl * (1. - x);
      rgb = mix(vCol, vec3(1.), g * g * .5) * a * vInt;
    }
  }
  gl_FragColor = vec4(rgb, occ);
}`;

const SPRITE_VS = `
attribute vec4 iA, iB, iC, iD, iE; // pos kind | sx sy rot seed | rgb intensity | U param | V -
varying vec2 vUv; varying float vKind, vSeed, vInt, vParam; varying vec3 vCol;
void main() {
  vec2 c = position.xy;
  if (dot(iD.xyz, iD.xyz) > 0.) { // world-oriented plane (floor rings)
    gl_Position = projectionMatrix * modelViewMatrix * vec4(iA.xyz + iD.xyz * c.x + iE.xyz * c.y, 1.);
  } else {
    vec4 mv = modelViewMatrix * vec4(iA.xyz, 1.);
    float a = iB.z;
    mv.xy += mat2(cos(a), sin(a), -sin(a), cos(a)) * (c * iB.xy);
    gl_Position = projectionMatrix * mv;
  }
  vUv = c; vKind = iA.w; vSeed = iB.w; vCol = iC.rgb; vInt = iC.w; vParam = iD.w;
}`;

const SPRITE_FS = COMMON + `
varying vec2 vUv; varying float vKind, vSeed, vInt, vParam; varying vec3 vCol;
void main() {
  int k = int(vKind + .5);
  float r2 = dot(vUv, vUv), r = sqrt(r2), ang = atan(vUv.y, vUv.x);
  vec3 rgb = vec3(0.); float occ = 0.;
  if (k == 5) { // flare: anamorphic streak
    float s = exp(-vUv.y * vUv.y * 9.) * pow(max(1. - abs(vUv.x), 0.), 2.5);
    rgb = mix(vCol, vec3(1.), s * .5) * s * vInt;
  } else if (k == 6) { // afterimage: hollow glowing capsule with horizontal streaks
    vec2 q = vec2(vUv.x, max(abs(vUv.y) - .55, 0.) / .45);
    float d = length(q);
    float body = smoothstep(1., .1, d), rim = exp(-pow((d - .72) / .16, 2.));
    float st = textureLod(uNoise, vec2(vUv.y * .9 + vSeed, vSeed * 3.), 0.).r;
    float a = (body * .22 + rim * .7) * (.4 + 1.1 * st) * step(d, 1.);
    rgb = vCol * a * vInt; occ = body * .05 * min(vInt, 1.);
  } else {
    if (r2 > 1.) discard;
    if (k == 0) { // glow, vParam = extra tight core
      float g = exp(-r2 * 4.5) - exp(-4.5);
      rgb = vCol * (g + (exp(-r2 * 40.) * vParam)) * vInt; occ = g * .12 * min(vInt, 1.);
    } else if (k == 1) { // fireball: boundary noise flowing outward, vParam = heat (1 fresh, 0 burnt out)
      vec2 pc = vec2(ang / TAU * 3. + vSeed, r * .9 - uTime * 1.1 + vSeed);
      float n = textureLod(uNoise, pc, 1.).r * .6 + textureLod(uNoise, pc * vec2(2., 2.3) + .37, 1.).g * .4;
      float edge = .38 + .55 * n;
      float body = smoothstep(edge, edge - .32, r);
      float heat = (body * (1.2 - r * 1.) + exp(-r2 * 10.) * .45) * vParam;
      rgb = fireRamp(heat) * (.25 + 2.8 * heat * heat) * body * vInt; occ = body * .55 * min(vInt, 1.);
    } else if (k == 2) { // electric orb: hot core + crawling filaments
      vec2 p1 = vec2(ang / TAU * 2. + uTime * .7 + vSeed, r * .55 - uTime * 1.9);
      vec2 p2 = vec2(-ang / TAU * 3. + uTime * .45 + vSeed * 2., r * .8 - uTime * 1.2);
      float n = textureLod(uNoise, p1, 1.).r - textureLod(uNoise, p2, 1.).g;
      float fil = smoothstep(.07, 0., abs(n)) * smoothstep(1., .3, r);
      float core = exp(-r2 * 16.) * 2.2 + (exp(-r2 * 3.5) - exp(-3.5)) * .55;
      rgb = (vCol * (core + fil * 2.) + vec3(1.) * exp(-r2 * 45.) * 2.5) * vInt; occ = (core * .25 + fil * .3) * min(vInt, 1.);
    } else if (k == 3) { // shockwave ring, vParam = thickness
      float n = textureLod(uNoise, vec2(ang / TAU * 4. + vSeed, uTime * .3), 0.).r;
      float d = (r - .8) / vParam;
      float g = exp(-d * d) * (.55 + .9 * n) + smoothstep(.8, 0., r) * .06;
      rgb = vCol * g * vInt; occ = g * .2 * min(vInt, 1.);
    } else if (k == 4) { // swirl: three spiral arms drawn inward
      float s = sin(ang * 3. + r * 9. + uTime * 9. + vSeed * TAU);
      float n = textureLod(uNoise, vec2(ang / TAU * 2. + vSeed, r - uTime), 0.).r;
      float arms = smoothstep(.2, 1., s) * smoothstep(1., .4, r) * smoothstep(.06, .3, r) * (.5 + n);
      rgb = vCol * arms * vInt; occ = arms * .15 * min(vInt, 1.);
    }
  }
  gl_FragColor = vec4(rgb, occ);
}`;

const SEG_VS = `
attribute vec4 iA, iB, iC; // a width | b intensity | rgb -
uniform vec2 uRes;
varying vec2 vL; varying float vLen, vHW, vInt; varying vec3 vCol;
void main() {
  vec4 ca = projectionMatrix * modelViewMatrix * vec4(iA.xyz, 1.), cb = projectionMatrix * modelViewMatrix * vec4(iB.xyz, 1.);
  if (ca.w < .05 || cb.w < .05) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec2 sa = (ca.xy / ca.w * .5 + .5) * uRes, sb = (cb.xy / cb.w * .5 + .5) * uRes;
  float hw = iA.w * projectionMatrix[1][1] * uRes.y * .5 / (.5 * (ca.w + cb.w)), it = iB.w;
  if (hw < 2.5) { it *= hw / 2.5; hw = 2.5; } // keep far bolts from aliasing: wider but dimmer
  vec2 d = sb - sa; float len = length(d); d = len > 1e-4 ? d / len : vec2(1., 0.);
  vec2 n = vec2(-d.y, d.x);
  float e = position.x;
  vec2 px = mix(sa, sb, e) + n * position.y * hw + d * (e * 2. - 1.) * hw;
  vL = vec2(dot(px - sa, d), dot(px - sa, n)); vLen = len; vHW = hw; vInt = it; vCol = iC.rgb;
  gl_Position = vec4(px / uRes * 2. - 1., 0., 1.); // w = 1: varyings interpolate linearly in screen space
}`;

const SEG_FS = `
varying vec2 vL; varying float vLen, vHW, vInt; varying vec3 vCol;
void main() {
  float dx = max(max(-vL.x, vL.x - vLen), 0.);
  float d = length(vec2(dx, vL.y)) / vHW;
  if (d > 1.) discard;
  float core = exp(-d * d * 30.), glow = exp(-d * d * 5.) - exp(-5.);
  gl_FragColor = vec4((vec3(1.) * core * 2.2 + vCol * (glow * 1.1 + core)) * vInt, (core * .5 + glow * .2) * min(vInt, 1.));
}`;

const PASS_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;
const DOWN_FS = `
uniform sampler2D tSrc; uniform vec2 uTs; uniform float uPre, uTh, uKnee; varying vec2 vUv;
void main() { // dual-kawase downsample, soft threshold on the first level
  vec3 c = texture2D(tSrc, vUv).rgb * 4. + texture2D(tSrc, vUv - uTs).rgb + texture2D(tSrc, vUv + uTs).rgb
    + texture2D(tSrc, vUv + vec2(uTs.x, -uTs.y)).rgb + texture2D(tSrc, vUv - vec2(uTs.x, -uTs.y)).rgb;
  c = min(c / 8., vec3(40.));
  if (uPre > .5) {
    float br = max(c.r, max(c.g, c.b));
    float soft = clamp(br - uTh + uKnee, 0., 2. * uKnee); soft = soft * soft / (4. * uKnee + 1e-4);
    c *= max(soft, br - uTh) / max(br, 1e-4);
  }
  gl_FragColor = vec4(c, 1.);
}`;
const UP_FS = `
uniform sampler2D tSmall, tCur; uniform vec2 uTs; uniform float uRad; varying vec2 vUv;
void main() { // dual-kawase upsample of the smaller level, added onto this level
  vec3 s = texture2D(tSmall, vUv + vec2(-2. * uTs.x, 0.)).rgb + texture2D(tSmall, vUv + vec2(2. * uTs.x, 0.)).rgb
    + texture2D(tSmall, vUv + vec2(0., -2. * uTs.y)).rgb + texture2D(tSmall, vUv + vec2(0., 2. * uTs.y)).rgb
    + 2. * (texture2D(tSmall, vUv + uTs).rgb + texture2D(tSmall, vUv - uTs).rgb
    + texture2D(tSmall, vUv + vec2(uTs.x, -uTs.y)).rgb + texture2D(tSmall, vUv - vec2(uTs.x, -uTs.y)).rgb);
  gl_FragColor = vec4(texture2D(tCur, vUv).rgb + s / 12. * uRad, 1.);
}`;
const COMP_FS = `
uniform sampler2D tFx, tBloom; uniform float uStr, uExp, uOcc; varying vec2 vUv;
void main() { // premultiplied over: out = fx + video * (1 - a)
  vec4 fx = texture2D(tFx, vUv);
  vec3 c = fx.rgb + texture2D(tBloom, vUv).rgb * uStr;
  vec3 t = 1. - exp(-c * uExp);
  float a = clamp(max(fx.a, max(t.r, max(t.g, t.b)) * uOcc), 0., .94);
  gl_FragColor = vec4(t, a);
}`;

// ---- lightning polyline: midpoint displacement with branches, regenerated a few times per second ----
class Bolt {
  constructor(cap = 160) { this.d = new Float32Array(cap * 8); this.n = 0; this.cap = cap; this.on = 1; }
}

export function createFx(renderer, scene, camera, opts = {}) {
  // fxPixels: most pixels of the effect layer; adaptive: shrink it (down to fxPixelsMin) while the effect passes take more than
  // fxBudgetMs of GPU time (timer queries, Chrome / Edge; elsewhere the size stays at fxPixels). On an M5 at 1080p the passes
  // take 2-5 ms and ~2 ms of that does not shrink with the layer, so the budget only bites on GPUs that really are slow.
  // A busy frame's fill is mostly this layer, so this is the knob; the full-size scene / MSAA cost is the page's pixel ratio.
  opts = Object.assign({ onShake: null, quality: 'high', seed: 1, fxPixels: 2.2e6, fxPixelsMin: .5e6, fxBudgetMs: 6, adaptive: true }, opts);
  const hi = opts.quality !== 'low';
  const Q = hi ? 1 : .5, CAP = hi ? 32768 : 12288, SCAP = 512, GCAP = hi ? 8192 : 4096, LEVELS = hi ? 6 : 5;
  const R = mulberry(opts.seed), RS = s => (R() * 2 - 1) * s;
  const noise = noiseTexture();
  let time = 0;
  const bloom = { strength: 1.1, radius: .75, threshold: .2 };
  const shake = a => opts.onShake?.(a);

  const fxScene = new THREE.Scene();
  const fire = createFireEffects(fxScene, { onShake: shake });
  const thunder = createThunderEffects(fxScene, { onShake: shake });
  const charging = createChargeEffects(fxScene);
  const common = { uNoise: { value: noise }, uTime: { value: 0 } };
  const addMat = (vs, fs, uniforms = {}) => new THREE.ShaderMaterial({
    // DoubleSide: floor sprites (sprFloor) span +x/+z, so seen from above their winding faces away and FrontSide culled them
    vertexShader: vs, fragmentShader: fs, uniforms: { ...common, ...uniforms }, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  function batch(cap, stride, names, corners, vs, fs, uniforms) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * stride), stride).setUsage(THREE.DynamicDrawUsage);
    names.forEach((n, i) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, i * 4)));
    g.instanceCount = 0;
    const mesh = new THREE.Mesh(g, addMat(vs, fs, uniforms));
    mesh.frustumCulled = false;
    fxScene.add(mesh);
    return { g, buf, a: buf.array, mesh };
  }
  const QUAD = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
  const P = batch(CAP, PS, ['iA', 'iB', 'iC', 'iD', 'iE'], QUAD, PARTICLE_VS, PARTICLE_FS);
  const SP = batch(SCAP, SS, ['iA', 'iB', 'iC', 'iD', 'iE'], QUAD, SPRITE_VS, SPRITE_FS);
  const SG = batch(GCAP, GS, ['iA', 'iB', 'iC'], [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], SEG_VS, SEG_FS, { uRes: { value: new THREE.Vector2(1, 1) } });
  P.g.instanceCount = CAP;

  // ---- particle ring buffer: written once at birth, uploaded as dirty ranges ----
  let cursor = 0, dirtyFrom = 0, dirtyN = 0, pAlive = -1; // pAlive: when the last particle dies
  function emit(x, y, z, vx, vy, vz, life, s0, s1, drag, grav, col, kind, inten, turb, extra, ageOff) {
    const o = cursor * PS, a = P.a;
    a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = time - ageOff;
    a[o + 4] = vx; a[o + 5] = vy; a[o + 6] = vz; a[o + 7] = life;
    a[o + 8] = s0; a[o + 9] = s1; a[o + 10] = drag; a[o + 11] = grav;
    a[o + 12] = col[0]; a[o + 13] = col[1]; a[o + 14] = col[2]; a[o + 15] = kind;
    a[o + 16] = R(); a[o + 17] = inten; a[o + 18] = turb; a[o + 19] = extra;
    cursor = (cursor + 1) % CAP; dirtyN++;
    pAlive = Math.max(pAlive, time - ageOff + life);
  }
  function uploadParticles() {
    if (!dirtyN) return;
    const b = P.buf; b.clearUpdateRanges();
    if (dirtyN >= CAP) b.addUpdateRange(0, CAP * PS);
    else if (dirtyFrom + dirtyN <= CAP) b.addUpdateRange(dirtyFrom * PS, dirtyN * PS);
    else { b.addUpdateRange(dirtyFrom * PS, (CAP - dirtyFrom) * PS); b.addUpdateRange(0, (dirtyFrom + dirtyN - CAP) * PS); }
    b.needsUpdate = true; dirtyFrom = cursor; dirtyN = 0;
  }
  let nS = 0, nG = 0;
  function spr(kind, p, sx, sy, rot, seed, col, inten, param = 0) {
    if (nS >= SCAP || inten <= 0) return;
    const o = nS++ * SS, a = SP.a;
    a[o] = p.x; a[o + 1] = p.y; a[o + 2] = p.z; a[o + 3] = kind; a[o + 4] = sx; a[o + 5] = sy; a[o + 6] = rot; a[o + 7] = seed;
    a[o + 8] = col[0]; a[o + 9] = col[1]; a[o + 10] = col[2]; a[o + 11] = inten;
    a[o + 12] = a[o + 13] = a[o + 14] = 0; a[o + 15] = param; a[o + 16] = a[o + 17] = a[o + 18] = 0;
  }
  function sprFloor(kind, p, rad, col, inten, param = 0, seed = 0) { // horizontal plane
    if (nS >= SCAP || inten <= 0) return;
    spr(kind, p, 0, 0, 0, seed, col, inten, param);
    const o = (nS - 1) * SS, a = SP.a;
    a[o + 12] = rad; a[o + 18] = rad;
  }
  function seg(ax, ay, az, bx, by, bz, w, inten, col) {
    if (nG >= GCAP || inten <= 0) return;
    const o = nG++ * GS, a = SG.a;
    a[o] = ax; a[o + 1] = ay; a[o + 2] = az; a[o + 3] = w; a[o + 4] = bx; a[o + 5] = by; a[o + 6] = bz; a[o + 7] = inten;
    a[o + 8] = col[0]; a[o + 9] = col[1]; a[o + 10] = col[2];
  }
  const segV = (a, b, w, inten, col) => seg(a.x, a.y, a.z, b.x, b.y, b.z, w, inten, col);

  // ---- lightning ----
  const u3 = [0, 0, 0];
  function runit(o = u3) { const z = R() * 2 - 1, t = R() * TAU, r = Math.sqrt(1 - z * z); o[0] = r * Math.cos(t); o[1] = z; o[2] = r * Math.sin(t); return o; }
  function sub(b, ax, ay, az, bx, by, bz, depth, jag, w, it, br, u0, u1, taper) {
    if (depth === 0) {
      if (b.n >= b.cap) return;
      const o = b.n++ * 8, d = b.d, um = (u0 + u1) / 2;
      d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = bx; d[o + 4] = by; d[o + 5] = bz; d[o + 6] = w; d[o + 7] = it * (taper + (1 - taper) * um);
      return;
    }
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1e-6; dx /= len; dy /= len; dz /= len;
    runit(); const k = u3[0] * dx + u3[1] * dy + u3[2] * dz;
    let px = u3[0] - k * dx, py = u3[1] - k * dy, pz = u3[2] - k * dz; const pl = Math.hypot(px, py, pz) || 1;
    const off = len * jag * RS(1) / pl;
    const mx = (ax + bx) / 2 + px * off, my = (ay + by) / 2 + py * off, mz = (az + bz) / 2 + pz * off, um = (u0 + u1) / 2;
    sub(b, ax, ay, az, mx, my, mz, depth - 1, jag, w, it, br, u0, um, taper);
    sub(b, mx, my, mz, bx, by, bz, depth - 1, jag, w, it, br, um, u1, taper);
    if (br > 0 && depth >= 2 && R() < br) {
      runit(); const bl = len * (.25 + .3 * R());
      let ex = dx + u3[0] * .7, ey = dy + u3[1] * .7, ez = dz + u3[2] * .7; const el = Math.hypot(ex, ey, ez) || 1;
      sub(b, mx, my, mz, mx + ex / el * bl, my + ey / el * bl, mz + ez / el * bl, depth - 1, jag * 1.1, w * .5, it * .6, br * .5, um, 1, taper);
    }
  }
  function gen(b, a, c, depth = 4, jag = .15, br = 0, taper = 1) {
    b.n = 0; sub(b, a.x, a.y, a.z, c.x, c.y, c.z, depth, jag, 1, 1, br, 0, 1, taper);
    b.on = R() < .85 ? .65 + .6 * R() : 0;
  }
  function drawBolt(b, w, inten, col) {
    const it = inten * b.on, d = b.d;
    if (it <= 0) return;
    for (let i = 0; i < b.n; i++) { const o = i * 8; seg(d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], w * d[o + 6], it * d[o + 7], col); }
  }

  // ---- helpers ----
  const V = () => new THREE.Vector3();
  const tA = V(), tB = V(), tC = V(), UP = new THREE.Vector3(0, 1, 0);
  function take(st, key, amount) { const v = (st.acc[key] ?? 0) + amount, n = Math.floor(v); st.acc[key] = v - n; return n; }
  const flick = (seed, f = 23) => .78 + .22 * Math.sin(time * f + seed * 17) * Math.sin(time * f * 1.73 + seed * 5);
  const sc = (k, a, b) => Math.min(1, Math.max(0, (k - a) / (b - a)));

  // fire / thunder bursts shared by hit() and special()
  function fireBurst(p, pw, big = 1) {
    const n = Math.round((90 + 140 * pw) * Q * big);
    for (let i = 0; i < n; i++) {
      runit(); const sp = (1.1 + 2.4 * pw) * big * (.35 + .65 * R());
      emit(p.x + u3[0] * .05, p.y + u3[1] * .05, p.z + u3[2] * .05, u3[0] * sp, u3[1] * sp + .3, u3[2] * sp, .45 + .45 * R(),
        (.11 + .1 * pw) * big * (.7 + .6 * R()), (.26 + .2 * pw) * big, 3.6, 1.6, COL.one, K.FLAME, 1.1, .3, 0, R() * .03);
    }
    for (let i = 0; i < 30 * Q * big; i++) {
      runit(); const sp = .4 * R();
      emit(p.x, p.y, p.z, u3[0] * sp, u3[1] * sp, u3[2] * sp, .3 + .15 * R(), .16 * big, .3 * big, 2, 1, COL.one, K.FLAME, 1.4, .1, 0, 0);
    }
    for (let i = 0; i < (40 + 60 * pw) * Q * big; i++) {
      runit(); const sp = (.4 + 1.2 * R()) * (.6 + .6 * pw) * big;
      emit(p.x, p.y, p.z, u3[0] * sp, u3[1] * sp * .6 + .2, u3[2] * sp, 1.3 + .8 * R(), .12 * big, (.5 + .3 * pw) * big, 2.2, .35, COL.smoke, K.SMOKE, .9, .2, 0, -(.06 + .15 * R()));
    }
    for (let i = 0; i < (90 + 150 * pw) * Q * big; i++) {
      runit(); const sp = (2.5 + 6 * R()) * (.5 + .5 * pw) * Math.sqrt(big);
      emit(p.x, p.y, p.z, u3[0] * sp, u3[1] * sp + 1, u3[2] * sp, .35 + .55 * R(), .012, .006, 1.4, -5.5, COL.ember, K.SPARK, 2.6, .2, .045, 0);
    }
    for (let i = 0; i < 30 * Q * big; i++) {
      runit(); const sp = .5 + R();
      emit(p.x, p.y, p.z, u3[0] * sp, u3[1] * sp + .5, u3[2] * sp, 1.2 + .8 * R(), .009, .005, 1.5, .4, COL.ember, K.SPARK, 2, .8, .03, 0);
    }
  }
  function sparkBurst(p, pw, n, speed = 1) {
    for (let i = 0; i < n * Q; i++) {
      runit(); const sp = (3 + 8 * R()) * (.5 + .5 * pw) * speed;
      emit(p.x, p.y, p.z, u3[0] * sp, u3[1] * sp + .6, u3[2] * sp, .2 + .45 * R(), .011, .005, 2.4, -4, COL.spark, K.SPARK, 3, .15, .04, 0);
    }
    for (let i = 0; i < 16 * Q; i++) {
      runit(); const sp = .5 * R();
      emit(p.x, p.y, p.z, u3[0] * sp, u3[1] * sp, u3[2] * sp, .35 + .2 * R(), .15, .5, 3, 0, COL.elecGlow, K.GLOW, .6, 0, 0, 0);
    }
  }

  // ---- per-frame effects: aura and charge (requested each frame, keyed) ----
  const auras = new Map(), charges = new Map(), guards = new Map();
  function request(map, key, el) {
    let st = map.get(key);
    if (!st) { st = { el, base: V(), tip: V(), v: 0, seen: 0, acc: {}, regen: 0, seed: R(), bolts: Array.from({ length: 10 }, () => new Bolt(96)), ring: 0 }; map.set(key, st); }
    st.el = el; st.seen = time; st.live = true;
    return st;
  }
  function stickPoint(st, u, o) { return o.copy(st.base).lerp(st.tip, u); }

  function fireAura(a, dt) {
    const it = a.v, b = a.base, t = a.tip, dx = t.x - b.x, dy = t.y - b.y, dz = t.z - b.z;
    for (let n = take(a, 'f', (340 * it + 30) * Q * dt); n > 0; n--) {
      const u = Math.pow(R(), .6);
      emit(b.x + dx * u + RS(.015), b.y + dy * u + RS(.015), b.z + dz * u + RS(.015), RS(.12), .5 + R() * .5, RS(.12),
        .35 + R() * .4, (.08 + .07 * R()) * (.6 + .5 * it), .03, 1.6, 1.4, COL.one, K.FLAME, 1, .22, 0, R() * dt);
    }
    for (let n = take(a, 's', 6 * it * Q * dt); n > 0; n--)
      emit(t.x + RS(.03), t.y + .05, t.z + RS(.03), RS(.1), .35 + .2 * R(), RS(.1), 1.1 + .6 * R(), .06, .28, 1, .25, COL.smoke, K.SMOKE, .6, .18, 0, -.15);
    for (let n = take(a, 'e', 26 * it * Q * dt); n > 0; n--) {
      const u = Math.pow(R(), .4);
      emit(b.x + dx * u, b.y + dy * u, b.z + dz * u, RS(.4), .4 + R() * .9, RS(.4), .7 + .7 * R(), .01, .005, 1.2, .3, COL.ember, K.SPARK, 2.2, .7, .05, R() * dt);
    }
    const fl = flick(a.seed);
    segV(b, t, .04, (.7 + .3 * fl) * it, COL.fire);
    for (const u of [.3, .65, 1]) spr(S.GLOW, stickPoint(a, u, tA), .16 + .1 * it, .16 + .1 * it, 0, 0, COL.fire, .3 * it * fl, .2);
  }
  function thunderAura(a, dt) {
    const it = a.v, b = a.base, t = a.tip, len = b.distanceTo(t);
    if ((a.regen -= dt) <= 0) {
      a.regen = .05 + R() * .06;
      gen(a.bolts[0], stickPoint(a, .05, tA), t, 4, .12, .25);
      stickPoint(a, .3 + .7 * R(), tA); runit(); tB.set(u3[0], u3[1], u3[2]).multiplyScalar((.1 + .2 * R()) * (.5 + .5 * it)).add(tA);
      gen(a.bolts[1], tA, tB, 3, .3, .2, .3);
      const u1 = R() * .6; stickPoint(a, u1, tA); stickPoint(a, Math.min(1, u1 + .25 + .4 * R()), tB);
      gen(a.bolts[2], tA, tB, 4, .35 * Math.min(1, .3 / len + .5));
      runit(); tB.set(u3[0], Math.abs(u3[1]), u3[2]).multiplyScalar(.12 + .15 * R()).add(t);
      gen(a.bolts[3], t, tB, 3, .3, .2, .2);
    }
    const fl = flick(a.seed, 40);
    segV(b, t, .032, (.75 + .35 * fl) * it, COL.elec);
    for (let i = 0; i < 4; i++) drawBolt(a.bolts[i], i ? .03 : .036, 1.7 * it, COL.elec);
    for (let n = take(a, 'k', 40 * it * Q * dt); n > 0; n--) {
      stickPoint(a, Math.pow(R(), .5), tA); runit(); const sp = 1 + 2 * R();
      emit(tA.x, tA.y, tA.z, u3[0] * sp, u3[1] * sp, u3[2] * sp, .12 + .18 * R(), .008, .004, 2, -3, COL.spark, K.SPARK, 2.6, .1, .035, R() * dt);
    }
    for (const u of [.3, .65, 1]) spr(S.GLOW, stickPoint(a, u, tA), .2 + .1 * it, .2 + .1 * it, 0, 0, COL.elecGlow, .55 * it * fl, .25);
  }

  function fireCharge(c, dt) {
    const L = c.v, full = L >= .999, p = c.tip, pulse = full ? 1 + .12 * Math.sin(time * 20) : 1;
    for (let n = take(c, 'f', (60 + 320 * L) * Q * dt); n > 0; n--) {
      runit(); const r = .16 + .36 * L * (.5 + .5 * R()), life = .22 + .15 * R(), sp = r / life;
      tA.set(u3[0], u3[1], u3[2]); tB.crossVectors(tA, UP);
      emit(p.x + u3[0] * r, p.y + u3[1] * r, p.z + u3[2] * r, -u3[0] * sp + tB.x * sp * .5, -u3[1] * sp, -u3[2] * sp + tB.z * sp * .5,
        life, .03 + .03 * L, .05 + .05 * L, 0, 0, COL.one, K.FLAME, .9, .04, 0, R() * dt);
    }
    if (full) for (let n = take(c, 'e', 80 * Q * dt); n > 0; n--) {
      runit(); const sp = 1.2 + 1.5 * R();
      emit(p.x, p.y, p.z, u3[0] * sp, u3[1] * sp + .5, u3[2] * sp, .4 + .4 * R(), .012, .006, 1.5, -2, COL.ember, K.SPARK, 2.5, .3, .04, R() * dt);
    }
    const sz = (.05 + .16 * L) * pulse;
    spr(S.FIREBALL, p, sz, sz, 0, c.seed, COL.one, 1.1 + .7 * L, 1);
    spr(S.GLOW, p, (.2 + .55 * L) * pulse, (.2 + .55 * L) * pulse, 0, 0, COL.fire, .45 + .6 * L, .3);
    spr(S.SWIRL, p, .22 + .4 * L, .22 + .4 * L, 0, c.seed, COL.fire, .3 + .9 * L);
    if (full) { const ph = (time * 2.2) % 1; spr(S.RING, p, .2 + .55 * ph, .2 + .55 * ph, 0, c.seed, COL.hot, 1.6 * (1 - ph) ** 1.5, .06); }
  }
  function thunderCharge(c, dt) {
    const L = c.v, full = L >= .999, p = c.tip, pulse = full ? 1 + .15 * Math.sin(time * 26) : 1;
    if ((c.regen -= dt) <= 0) {
      c.regen = .04 + .03 * R();
      const nb = 2 + Math.round(4 * L) + (full ? 3 : 0);
      for (let i = 0; i < 10; i++) {
        const bo = c.bolts[i];
        if (i >= nb) { bo.n = 0; continue; }
        runit(); const r = (i >= 6 ? .55 + .35 * R() : .18 + .38 * L * (.4 + .6 * R()));
        tA.set(u3[0], u3[1], u3[2]).multiplyScalar(r).add(p);
        gen(bo, tA, p, 4, .28, .2, .25);
      }
    }
    for (const bo of c.bolts) drawBolt(bo, .02 + .012 * L, 1.6, COL.elec);
    for (let n = take(c, 'k', (50 + 260 * L) * Q * dt); n > 0; n--) {
      runit(); const r = .18 + .4 * L, life = .14 + .1 * R(), sp = r / life;
      emit(p.x + u3[0] * r, p.y + u3[1] * r, p.z + u3[2] * r, -u3[0] * sp, -u3[1] * sp, -u3[2] * sp, life, .008, .006, 0, 0, COL.spark, K.SPARK, 2.2, 0, .05, R() * dt);
    }
    const sz = (.06 + .16 * L) * pulse;
    spr(S.PLASMA, p, sz, sz, 0, c.seed, COL.elec, 1.2 + .8 * L);
    spr(S.GLOW, p, (.22 + .55 * L) * pulse, (.22 + .55 * L) * pulse, 0, 0, COL.elecGlow, .5 + .8 * L, .4);
    if (full) { const ph = (time * 2.6) % 1; spr(S.RING, p, .2 + .6 * ph, .2 + .6 * ph, 0, c.seed, COL.elec, 1.8 * (1 - ph) ** 1.5, .05); }
  }

  // ---- shots ----
  const shots = new Map();
  let nextId = 1;
  function trailFire(s, dt, prev, pos, pw, big = 1) {
    const dist = prev.distanceTo(pos), d = s.dir;
    for (let n = take(s, 'f', (dist * (240 + 260 * pw) * big + dt * 70) * Q); n > 0; n--) {
      const u = R(); tA.copy(prev).lerp(pos, u);
      emit(tA.x + RS(.03 * big), tA.y + RS(.03 * big), tA.z + RS(.03 * big), -d.x * .5 + RS(.25), -d.y * .5 + RS(.25) + .2, -d.z * .5 + RS(.25),
        .28 + .25 * R(), (.08 + .09 * pw) * big * (.7 + .5 * R()), .03 * big, 2.2, 1.1, COL.one, K.FLAME, 1, .3, 0, (1 - u) * dt);
    }
    for (let n = take(s, 's', dist * 22 * (.5 + pw) * big * Q); n > 0; n--) {
      tA.copy(prev).lerp(pos, R());
      emit(tA.x, tA.y, tA.z, RS(.15), .25 + RS(.1), RS(.15), .8 + .5 * R(), .08 * big, .35 * big, 1.5, .3, COL.smoke, K.SMOKE, .8, .2, 0, -.12);
    }
    for (let n = take(s, 'e', (dist * 70 * big + dt * 30) * Q); n > 0; n--) {
      const u = R(); tA.copy(prev).lerp(pos, u); runit(); const sp = .4 + .8 * R();
      emit(tA.x, tA.y, tA.z, -d.x * (.5 + R()) + u3[0] * sp, -d.y * (.5 + R()) + u3[1] * sp, -d.z * (.5 + R()) + u3[2] * sp,
        .35 + .4 * R(), .011, .005, 1.3, -1.2, COL.ember, K.SPARK, 2.4, .4, .05, (1 - u) * dt);
    }
  }
  function headFire(p, sz, seed, inten = 1) {
    spr(S.FIREBALL, p, sz, sz, time * .5, seed, COL.one, 1.05 * inten, .9);
    spr(S.GLOW, p, sz * 3.6, sz * 3.6, 0, 0, COL.fire, .75 * inten, .15);
  }
  function updateShot(s, dt) {
    const pw = s.power, dist = s.prev.distanceTo(s.pos), big = s.big ?? 1;
    if (dist > 1e-3) s.dir.copy(s.pos).sub(s.prev).normalize();
    s.travel += dist;
    if (s.el === 'fire') {
      trailFire(s, dt, s.prev, s.pos, pw, big);
      headFire(s.pos, (.12 + .1 * pw) * big, s.seed);
    } else {
      const sz = (.1 + .09 * pw) * big, d = s.dir;
      if ((s.regen -= dt) <= 0) {
        s.regen = .035 + .03 * R();
        for (let i = 0; i < 4; i++) { runit(); tA.set(u3[0], u3[1], u3[2]).multiplyScalar(sz * (1.5 + R())).add(s.pos); gen(s.bolts[i], s.pos, tA, 3, .35, 0, .3); }
        tA.copy(s.pos).addScaledVector(d, -Math.min(s.travel, .55 + .45 * pw));
        gen(s.bolts[4], tA, s.pos, 4, .13, .35, .05); s.bolts[4].on = Math.max(s.bolts[4].on, .7);
        tA.addScaledVector(d, -.15);
        gen(s.bolts[5], tA, s.pos, 4, .2, 0, 0);
      }
      for (let i = 0; i < 4; i++) drawBolt(s.bolts[i], .02 * big, 1.7, COL.elec);
      drawBolt(s.bolts[4], .035 * big, 1.5, COL.elec); drawBolt(s.bolts[5], .02 * big, .9, COL.elec);
      for (let n = take(s, 'k', (dist * 140 + dt * 40) * Q); n > 0; n--) {
        const u = R(); tA.copy(s.prev).lerp(s.pos, u); runit(); const sp = 1 + 2.5 * R();
        emit(tA.x, tA.y, tA.z, u3[0] * sp - d.x, u3[1] * sp - d.y, u3[2] * sp - d.z, .12 + .2 * R(), .009, .004, 2, -2, COL.spark, K.SPARK, 2.6, .1, .035, (1 - u) * dt);
      }
      for (let n = take(s, 'g', dist * 18 * Q); n > 0; n--) {
        tA.copy(s.prev).lerp(s.pos, R());
        emit(tA.x, tA.y, tA.z, -d.x * .3, -d.y * .3, -d.z * .3, .3, .12 + .06 * pw, .25, 3, 0, COL.elecGlow, K.GLOW, .45, 0, 0, 0);
      }
      spr(S.PLASMA, s.pos, sz, sz, 0, s.seed, COL.elec, 1.7);
      spr(S.GLOW, s.pos, sz * 4.2, sz * 4.2, 0, 0, COL.elecGlow, .9, .3);
    }
    s.prev.copy(s.pos);
  }

  // ---- transient effects: hit, dodge, special ----
  const live = [];
  function add(e) { e.age = 0; e.seed = R(); e.acc = {}; e.bolts = e.bolts ?? []; live.push(e); return e; }

  function hitFire(e) {
    const a = e.age, pw = e.power, p = e.pos, big = e.big ?? 1;
    if (a < .15) spr(S.GLOW, p, (.5 + .5 * pw) * big, (.5 + .5 * pw) * big, 0, 0, COL.hot, 2 * (1 - a / .15) ** 2, 1);
    const fb = (.25 + .3 * pw) * big * (.6 + .8 * sc(a, 0, .25));
    spr(S.FIREBALL, p, fb, fb, e.seed * TAU, e.seed, COL.one, 1.6 * (1 - sc(a, .1, .55)), 1 - sc(a, 0, .5) * .8);
    const k = sc(a, 0, .45), rr = (.2 + 1.1 * (1 - (1 - k) ** 3)) * (.6 + .5 * pw) * big;
    spr(S.RING, p, rr, rr, 0, e.seed, COL.fire, 1.2 * (1 - k) ** 1.5, .045);
    if (a < .22) spr(S.FLARE, p, (1.8 + 1.6 * pw) * big, (.08 + .05 * pw) * big, 0, 0, COL.hot, 2.4 * (1 - a / .22) ** 2);
    return a < 1;
  }
  function hitThunder(e) {
    const a = e.age, pw = e.power, p = e.pos, big = e.big ?? 1, nb = Math.min(10, 5 + Math.round(5 * pw));
    if (a < .5 && (e.regen = (e.regen ?? 0) - e.dt) <= 0) {
      e.regen = .04 + .02 * R();
      for (let i = 0; i < nb; i++) {
        runit(); tA.set(u3[0], u3[1] * .7, u3[2]).normalize().multiplyScalar((.5 + .8 * R()) * (.6 + .4 * pw) * big).add(p);
        gen(e.bolts[i], p, tA, 4, .25, .35, .15);
      }
    }
    const fade = 1 - sc(a, .25, .55);
    for (let i = 0; i < nb; i++) drawBolt(e.bolts[i], .03 * big, 2 * fade, COL.elec);
    if (a < .14) spr(S.GLOW, p, (.6 + .6 * pw) * big, (.6 + .6 * pw) * big, 0, 0, COL.white, 2.2 * (1 - a / .14) ** 2, 1);
    spr(S.PLASMA, p, (.22 + .2 * pw) * big * (1 - sc(a, 0, .45)), (.22 + .2 * pw) * big, 0, e.seed, COL.elec, 2);
    spr(S.GLOW, p, .8 * big, .8 * big, 0, 0, COL.elecGlow, 1.2 * (1 - sc(a, 0, .5)), .3);
    const k = sc(a, 0, .35), rr = (.2 + 1.1 * (1 - (1 - k) ** 3)) * (.6 + .5 * pw) * big;
    spr(S.RING, p, rr, rr, 0, e.seed, COL.elec, 1.4 * (1 - k) ** 1.5, .04);
    if (a < .2) spr(S.FLARE, p, (2 + 1.6 * pw) * big, (.07 + .05 * pw) * big, 0, 0, COL.white, 2.6 * (1 - a / .2) ** 2);
    return a < .8;
  }
  function dodgeFx(e) {
    const a = e.age, fade = (1 - a / .45) ** 1.5, col = e.el === 'fire' ? COL.fire : COL.elec;
    for (let i = 1; i <= 4; i++) {
      tA.copy(e.pos).addScaledVector(e.dir, -.2 * i * Math.min(1, a / .06 + .3));
      spr(S.GHOST, tA, .3, .85, 0, e.seed + i, col, 1.3 * (1 - i * .19) * fade);
    }
    if (e.el === 'thunder') {
      if ((e.regen = (e.regen ?? 0) - e.dt) <= 0 && a < .25) { e.regen = .04; tA.copy(e.pos).addScaledVector(e.dir, -.9); gen(e.bolts[0], tA, e.pos, 4, .2, .3, .1); }
      if (a < .25) drawBolt(e.bolts[0], .03, 1.6, COL.elec);
    }
    return a < .45;
  }
  // guard: a shield of rings in front of the chest (st.tip = its centre), flickering sparks around the rim
  function guardFx(g, dt) {
    const p = g.tip, col = g.el === 'fire' ? COL.fire : COL.elec, fl = flick(g.seed, 11);
    spr(S.GLOW, p, .9, .9, 0, 0, col, .35 * g.v * fl, .3);
    for (let i = 0; i < 3; i++) { const r = .55 + .08 * i + .02 * Math.sin(time * 6 + i); spr(S.RING, p, r, r, time * (i - 1), g.seed + i, col, (.9 - .25 * i) * g.v * fl, .03); }
    for (let n = take(g, 'r', 40 * Q * dt); n > 0; n--) {
      const a = R() * TAU;
      emit(p.x + Math.cos(a) * .3, p.y + Math.sin(a) * .3, p.z, RS(.2), RS(.2), RS(.2), .25 + .2 * R(), .012, .006, 2, 0, g.el === 'fire' ? COL.ember : COL.spark, K.SPARK, 1.6, 0, .05, 0);
    }
  }
  function classicBlock(element, pos) { sparkBurst(pos, .3, 80, .8); add({ update: blockFx, el: element, pos: pos.clone() }); shake(.15); }
  function blockFx(e) {
    const a = e.age, k = sc(a, 0, .3), col = e.el === 'fire' ? COL.hot : COL.white;
    spr(S.RING, e.pos, .5 + 1.2 * k, .5 + 1.2 * k, 0, e.seed, col, 2 * (1 - k) ** 2, .05);
    if (a < .12) spr(S.FLARE, e.pos, 1.6, .06, 0, 0, col, 2.2 * (1 - a / .12) ** 2);
    return a < .3;
  }
  function specialFire(e, dt) {
    const a = e.age, T1 = .55, f = e.from, to = e.to;
    e.ground = e.ground ?? new THREE.Vector3(to.x, .02, to.z);
    if (a < T1) {
      const k = a / T1, kk = k * k;
      tC.copy(f).lerp(to, kk); tC.y += Math.sin(k * Math.PI) * .12;
      e.head = e.head ?? f.clone(); e.dir = e.dir ?? to.clone().sub(f).normalize();
      trailFire(e, dt, e.head, tC, 1, 1.7);
      e.head.copy(tC);
      headFire(tC, .4, e.seed, 1.3);
      spr(S.SWIRL, tC, .9, .9, 0, e.seed, COL.fire, .8);
      if (a < .2) { spr(S.GLOW, f, 1, 1, 0, 0, COL.hot, 2 * (1 - a / .2)); spr(S.RING, f, .3 + 2 * a, .3 + 2 * a, 0, e.seed, COL.fire, 1.5 * (1 - a / .2), .06); }
    } else {
      if (!e.boom) { e.boom = true; fireBurst(to, 1, 1.6); add({ update: hitFire, pos: to.clone(), power: 1, big: 1.5 }); shake(1); }
      const b = a - T1;
      if (b < .2) spr(S.GLOW, to, 1.4, 1.4, 0, 0, COL.hot, 2 * (1 - b / .2) ** 2, 1);
      if (b < .25) spr(S.FLARE, to, 4, .16, 0, 0, COL.hot, 2.5 * (1 - b / .25) ** 2);
      const k = sc(b, 0, .7), rr = .3 + 2.6 * (1 - (1 - k) ** 3);
      sprFloor(S.RING, e.ground, rr, COL.fire, 2 * (1 - k) ** 1.5, .05, e.seed);
      spr(S.RING, to, rr * .9, rr * .9, 0, e.seed, COL.fire, 1.4 * (1 - k) ** 1.5, .05);
      const pil = 1 - sc(b, .9, 1.4), g = e.ground;
      if (pil > 0) {
        for (let n = take(e, 'p', 950 * pil * Q * dt); n > 0; n--) {
          const rr2 = .35 * Math.sqrt(R()), th = R() * TAU, cx = Math.cos(th), sz = Math.sin(th);
          emit(g.x + cx * rr2, g.y + R() * .1, g.z + sz * rr2, cx * .35 - sz * .5, 3.5 + 3 * R(), sz * .35 + cx * .5,
            .55 + .35 * R(), .14 + .08 * R(), .3, .8, 1.5, COL.one, K.FLAME, 1.05, .35, 0, R() * dt);
        }
        for (let n = take(e, 'q', 40 * pil * Q * dt); n > 0; n--)
          emit(g.x + RS(.3), 2 + R() * .6, g.z + RS(.3), RS(.3), .6 + .4 * R(), RS(.3), 1.4 + .6 * R(), .2, .7, 1, .2, COL.smoke, K.SMOKE, .9, .25, 0, 0);
        for (let n = take(e, 'e', 140 * pil * Q * dt); n > 0; n--) {
          const th = R() * TAU;
          emit(g.x + Math.cos(th) * .4, .1 + R() * 1.5, g.z + Math.sin(th) * .4, RS(.8), 2 + 3 * R(), RS(.8), .6 + .6 * R(), .012, .006, 1, -1, COL.ember, K.SPARK, 2.4, .6, .05, R() * dt);
        }
        sprFloor(S.GLOW, g, 1.3, COL.fire, 1.1 * pil, .2);
        tA.copy(g); tA.y = 1.3; spr(S.GLOW, tA, .9, 1.8, 0, 0, COL.fire, .55 * pil);
        if ((e.rumble = (e.rumble ?? 0) - dt) <= 0) { e.rumble = .2; if (b > .1) shake(.3 * pil); }
      }
    }
    return a < T1 + 2.6;
  }
  function specialThunder(e, dt) {
    const a = e.age, f = e.from, to = e.to;
    e.strikes = e.strikes ?? [.3, .62, .95].map(t0 => ({ t0, bolt: new Bolt(400), sky: V(), g: V(), regen: 0, hit: false }));
    // beam from caster to target
    if (a > .03 && a < .55) {
      if ((e.regen = (e.regen ?? 0) - dt) <= 0) {
        e.regen = .035;
        gen(e.bolts[0], f, to, 5, .1, .35, .5); e.bolts[0].on = .8 + .5 * R();
        gen(e.bolts[1], f, to, 5, .22, 0, .3); gen(e.bolts[2], f, to, 5, .25, 0, .3);
      }
      const fade = 1 - sc(a, .4, .55);
      drawBolt(e.bolts[0], .085, 2.2 * fade, COL.elec); drawBolt(e.bolts[1], .03, 1.3 * fade, COL.elec); drawBolt(e.bolts[2], .03, 1.3 * fade, COL.elec);
      spr(S.PLASMA, f, .25, .25, 0, e.seed, COL.elec, 1.6 * fade);
      spr(S.GLOW, to, 1.1, 1.1, 0, 0, COL.elecGlow, 1.2 * fade, .5);
    }
    if (a < .15) spr(S.GLOW, f, .7, .7, 0, 0, COL.white, 1.8 * (1 - a / .15) ** 2, 1);
    for (const s of e.strikes) {
      const b = a - s.t0;
      if (b < 0 || b > .26) continue;
      if (!s.hit) {
        s.hit = true; s.g.set(to.x + RS(.15), 0, to.z + RS(.15)); s.sky.set(to.x + RS(.8), 6.5, to.z + RS(.8));
        sparkBurst(tA.copy(s.g).setY(.05), 1, 160); sparkBurst(to, .8, 80); shake(.8);
      }
      if ((s.regen -= dt) <= 0) { s.regen = .07; gen(s.bolt, s.sky, s.g, 6, .085, .45, .6); s.bolt.on = .85 + .4 * R(); }
      const fl = b < .05 ? 1.4 : (1 - b / .26) * (R() < .25 ? .3 : 1);
      drawBolt(s.bolt, .12, 3 * fl, COL.elec);
      if (b < .1) { tA.copy(s.g); tA.y = .9; spr(S.GLOW, tA, 1.3, 1.6, 0, 0, COL.white, 1.6 * (1 - b / .1) ** 2, .5); }
      const k = sc(b, 0, .26), rr = .2 + 2.2 * (1 - (1 - k) ** 3);
      sprFloor(S.RING, tA.copy(s.g).setY(.02), rr, COL.elec, 2 * (1 - k) ** 1.5, .045, e.seed);
    }
    if (a > .3 && a < 1.8) { // lingering crackle on the target
      const fade = 1 - sc(a, 1.1, 1.8);
      if ((e.cregen = (e.cregen ?? 0) - dt) <= 0) {
        e.cregen = .05;
        for (let i = 3; i < 7; i++) { runit(); tA.set(u3[0], u3[1], u3[2]).multiplyScalar(.25 + .35 * R()).add(to); gen(e.bolts[i], to, tA, 3, .35, .2, .2); }
      }
      for (let i = 3; i < 7; i++) drawBolt(e.bolts[i], .022, 1.5 * fade, COL.elec);
      sprFloor(S.GLOW, tA.set(to.x, .02, to.z), 1.2, COL.elecGlow, .9 * fade, .3);
      for (let n = take(e, 'k', 60 * fade * Q * dt); n > 0; n--) {
        runit(); const sp = 1 + 2 * R();
        emit(to.x + u3[0] * .2, to.y + u3[1] * .4, to.z + u3[2] * .2, u3[0] * sp, u3[1] * sp, u3[2] * sp, .15 + .2 * R(), .009, .004, 2, -3, COL.spark, K.SPARK, 2.5, .1, .035, R() * dt);
      }
    }
    return a < 2;
  }

  // ---- effect styles: other sets of moves drawn with the same primitives (fx-smash.js). 'classic' is everything above. ----
  // A style is make(kit) -> { shot?(s, dt), end?(s, reason), hit?(el, pos, power, opt), charge?(c, dt), aura?(a, dt) };
  // a missing handler falls back to the classic one. Shots keep the style they were fired with.
  const classic = { shot: updateShot, end: classicEnd, hit: classicHit, charge: (c, dt) => (c.el === 'fire' ? fireCharge : thunderCharge)(c, dt),
    aura: (a, dt) => (a.el === 'fire' ? fireAura : thunderAura)(a, dt), guard: guardFx, block: classicBlock };
  const kit = {
    THREE, K, S, COL, TAU, Q, R, RS, V, emit, spr, sprFloor, seg, segV, Bolt, gen, drawBolt, runit, u3, take, flick, sc, shake,
    fireBurst, sparkBurst, trailFire, headFire, add, classic, get time() { return time; },
  };
  // 'textured': takumi's set (fire-effects.js / thunder-effects.js / charge-effects.js, generated texture sprites in their own
  // meshes). They take the shot by id and draw everything themselves; nothing goes through the primitives above.
  const texMod = el => el === 'fire' ? fire : thunder;
  const textured = {
    start: s => texMod(s.el).shot(s.id, s.pos, s.dir, s.power),
    move: (s, pos) => texMod(s.el).moveShot(s.id, pos),
    shot: s => { s.prev.copy(s.pos); },
    end: s => texMod(s.el).endShot(s.id),
    hit: (el, pos, power) => texMod(el).hit(pos, power),
    charge: () => {}, // the tip sphere is part of charge-effects.js, requested from aura()
    aura: (a) => { if (a.opt?.charging) charging.request(a.el, a.opt.chest, a.tip, a.opt.level, a.el); }, // no stick glow when not charging
  };
  const styles = { classic, textured }; let style = textured, styleName = 'textured';
  function classicEnd(s) {
    const p = s.pos;
    if (s.el === 'fire') for (let i = 0; i < 25 * Q; i++) { runit(); emit(p.x, p.y, p.z, u3[0] * .6, u3[1] * .6 + .3, u3[2] * .6, .3 + .2 * R(), .08, .14, 3, 1, COL.one, K.FLAME, 1, .2, 0, 0); }
    else sparkBurst(p, .2, 30, .5);
  }
  function classicHit(element, pos, power) {
    if (element === 'fire') fireBurst(pos, power); else sparkBurst(pos, power, 220 + 260 * power);
    add({ update: element === 'fire' ? hitFire : hitThunder, el: element, pos: pos.clone(), power, bolts: element === 'fire' ? [] : Array.from({ length: 10 }, () => new Bolt(160)) });
    shake(.25 + .75 * power);
  }

  // ---- render targets / bloom ----
  const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false };
  const fxRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
  const down = Array.from({ length: LEVELS }, () => new THREE.WebGLRenderTarget(1, 1, rtOpts));
  const up = Array.from({ length: LEVELS - 1 }, () => new THREE.WebGLRenderTarget(1, 1, rtOpts));
  const passMat = (fs, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: PASS_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false, ...extra });
  const downMat = passMat(DOWN_FS, { tSrc: { value: null }, uTs: { value: new THREE.Vector2() }, uPre: { value: 0 }, uTh: { value: 0 }, uKnee: { value: .2 } });
  const upMat = passMat(UP_FS, { tSmall: { value: null }, tCur: { value: null }, uTs: { value: new THREE.Vector2() }, uRad: { value: 1 } });
  const compMat = passMat(COMP_FS, { tFx: { value: fxRT.texture }, tBloom: { value: null }, uStr: { value: 1 }, uExp: { value: 1 }, uOcc: { value: .85 } }, {
    transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  quad.frustumCulled = false; quadScene.add(quad);
  const pass = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); };
  let W = 0, H = 0, px = opts.fxPixels;
  function resizeTargets(w, h) {
    W = w; H = h;
    const s = Math.min(1, Math.sqrt(px / (w * h))) * (hi ? 1 : .5);
    let lw = Math.max(1, Math.round(w * s)), lh = Math.max(1, Math.round(h * s));
    fxRT.setSize(lw, lh); SG.mesh.material.uniforms.uRes.value.set(lw, lh);
    for (let i = 0; i < LEVELS; i++) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      down[i].setSize(lw, lh); if (i < LEVELS - 1) up[i].setSize(lw, lh);
    }
  }
  const dbs = new THREE.Vector2(), cc = new THREE.Color();

  // ---- GPU time per frame (scene = video + 3D, fx = effect layer + bloom + composite), and the adaptive layer size ----
  // The fill of the effect layer (overlapping additive quads) is most of the GPU time of a busy frame, so its size is the knob.
  const gl = renderer.getContext(), tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const gpu = { scene: 0, fx: 0, n: 0, at: 0 }, queries = [];
  function timed(kind, f) {
    // one TIME_ELAPSED query at a time: skip when the caller (a profiler) has one open, or results lag far behind
    const q = tq && queries.length < 12 && !gl.getQuery(tq.TIME_ELAPSED_EXT, gl.CURRENT_QUERY) && gl.createQuery();
    if (q) gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
    f();
    if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); queries.push({ q, kind }); }
  }
  function readTimers() {
    if (!tq) return;
    const lost = gl.getParameter(tq.GPU_DISJOINT_EXT); // results across a disjoint event are garbage
    while (queries.length && (lost || gl.getQueryParameter(queries[0].q, gl.QUERY_RESULT_AVAILABLE))) {
      const { q, kind } = queries.shift();
      if (!lost) { gpu[kind] += (gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 - gpu[kind]) * .1; if (kind === 'fx') gpu.n++; }
      gl.deleteQuery(q);
    }
  }
  function adapt() {
    const t = performance.now();
    if (!opts.adaptive || !tq || gpu.n < 20 || t - gpu.at < 500) return;
    gpu.at = t; gpu.n = 0;
    const B = opts.fxBudgetMs, k = gpu.fx > B ? Math.max(.6, B / gpu.fx) : gpu.fx < .6 * B ? 1.15 : 1;
    const np = Math.min(opts.fxPixels, Math.max(opts.fxPixelsMin, px * k));
    if (Math.abs(np / px - 1) > .05) { px = np; resizeTargets(W, H); }
  }

  return {
    opts,
    /** opt (styles may use it): { charging, level 0..1, tier 's'|'m'|'l'|null, chest: Vector3, feet: Vector3 } */
    aura(element, base, tip, intensity = 1, key = element, opt = {}) { const st = request(auras, key, element); st.base.copy(base); st.tip.copy(tip); st.v = Math.min(1, Math.max(0, intensity)); st.opt = opt; },
    /** opt: { tier, chargeT } */
    charge(element, tip, level, key = element, opt = {}) { const st = request(charges, key, element); st.tip.copy(tip); st.v = Math.min(1, Math.max(0, level)); st.opt = opt; },
    /** The textured set's body aura + tip sphere directly (charge-effects.js); the 'textured' style also reaches it through aura(). */
    charging(element, chest, tip, level, key = element) { charging.request(element, chest, tip, level, key); },
    /** big: overall size of the projectile (1 = the usual shot; the game's 小・中・大 tiers pass different sizes). opt: { tier, scale } — scale:
     *  the dashboard's ball size for styles that draw their own sizes (fx-smash.js); 'classic' gets it through big. */
    shot(element, pos, dir, power = .5, big = 1, opt = {}) {
      const id = nextId++;
      shots.set(id, { id, el: element, pos: pos.clone(), prev: pos.clone(), from: pos.clone(), dir: dir.clone().normalize(), power, big, tier: opt.tier ?? null, scale: opt.scale ?? 1, age: 0, travel: 0, acc: {}, regen: 0, seed: R(),
        bolts: Array.from({ length: 6 }, () => new Bolt(96)), st: style });
      style.start?.(shots.get(id));
      return id;
    },
    moveShot(id, pos) { const s = shots.get(id); if (!s) return; s.pos.copy(pos); s.st.move?.(s, pos); },
    /** reason: 'hit' | 'floor' | 'timeout' (game.js); a style may leave something behind (a pillar of fire where it landed). */
    endShot(id, reason = 'timeout') {
      const s = shots.get(id); if (!s) return;
      shots.delete(id);
      (s.st.end ?? classicEnd)(s, reason);
    },
    /** opt: { tier } */
    /** opt.target: the struck player's chest. Thunder lands on it in plan (x, z), keeping the hit's height, whatever the style. */
    hit(element, pos, power = .5, opt = {}) {
      if (element === 'thunder' && opt.target) pos = pos.clone().set(opt.target.x, pos.y, opt.target.z);
      (style.hit ?? classicHit)(element, pos, power, opt);
    },
    /** Adds a style: make(kit) -> handlers (see above). */
    addStyle(name, make) { styles[name] = { ...make(kit) }; if (name === styleName) style = styles[name]; },
    setStyle(name) { styleName = name; style = styles[name] ?? classic; },
    get style() { return styleName; },
    get styles() { return Object.keys(styles); },
    dodge(element, pos, dir) {
      const d = dir.clone().normalize(), col = element === 'fire' ? COL.ember : COL.spark;
      for (let i = 0; i < 45 * Q; i++) {
        const sp = 3 + 3 * R();
        emit(pos.x + RS(.25), pos.y + RS(.8), pos.z + RS(.25), -d.x * sp, -d.y * sp, -d.z * sp, .16 + .14 * R(), .012, .006, 3, 0, col, K.SPARK, 1.8, 0, .07, 0);
      }
      if (element === 'fire') for (let i = 0; i < 40 * Q; i++) {
        const u = R() * .7;
        emit(pos.x - d.x * u + RS(.15), pos.y + RS(.6), pos.z - d.z * u + RS(.15), -d.x * .4, .5, -d.z * .4, .3 + .2 * R(), .07, .03, 2, 1, COL.one, K.FLAME, .9, .2, 0, 0);
      } else sparkBurst(pos, .2, 40, .5);
      add({ update: dodgeFx, el: element, pos: pos.clone(), dir: d, bolts: [new Bolt(96)] });
    },
    /** Shield held this frame (call every frame like aura); level 0..1. */
    /** facing (optional): the guarding body's forward (world, horizontal), kept on st.base for styles that orient the shield */
    guard(element, centre, level = 1, key = 'guard-' + element, facing = null) { const st = request(guards, key, element); st.tip.copy(centre); st.v = Math.min(1, Math.max(0, level)); if (facing) st.base.copy(facing); st.facing = !!facing; },
    /** A hit stopped by the shield. */
    /** A shot met a raised guard at pos (it bounces back if 小, goes through otherwise). */
    block(element, pos) { (style.block ?? classicBlock)(element, pos); },
    special(element, from, to) {
      if (styleName === 'textured') { texMod(element).special(from, to); return; }
      add({ update: element === 'fire' ? specialFire : specialThunder, el: element, from: from.clone(), to: to.clone(), bolts: Array.from({ length: 8 }, () => new Bolt(200)) });
      if (element === 'thunder') shake(.4);
    },
    /** Visual checks only: no game damage or sensor input is generated. */
    previewFire(tier, from, to, getTarget = null) { fire.preview(tier, from, to, getTarget); },
    controlFirePreview(state) { fire.previewControl(state); },
    previewThunder(tier, from, to, getTarget = null) { thunder.preview(tier, from, to, getTarget); },
    controlThunderPreview(state) { thunder.previewControl(state); },
    step(dt) {
      dt = Math.min(Math.max(dt, 0), .1); time += dt;
      nS = 0; nG = 0;
      for (const [k, a] of auras) { if (time - a.seen > .15) { auras.delete(k); continue; } (style.aura ?? classic.aura)(a, dt); }
      for (const [k, g] of guards) { if (time - g.seen > .15) { guards.delete(k); continue; } (style.guard ?? guardFx)(g, dt); }
      for (const [k, c] of charges) { if (time - c.seen > .15) { charges.delete(k); continue; } if (c.v > 0) (style.charge ?? classic.charge)(c, dt); }
      for (const s of shots.values()) { s.regen ??= 0; (s.st.shot ?? updateShot)(s, dt); s.age += dt; }
      for (let i = live.length - 1; i >= 0; i--) {
        const e = live[i]; e.dt = dt;
        if (!e.update(e, dt)) live.splice(i, 1);
        e.age += dt;
      }
      uploadParticles();
      for (const [b, n, st] of [[SP, nS, SS], [SG, nG, GS]]) {
        b.g.instanceCount = n;
        if (n) { b.buf.clearUpdateRanges(); b.buf.addUpdateRange(0, n * st); b.buf.needsUpdate = true; }
      }
      common.uTime.value = time;
      fire.step(dt);
      thunder.step(dt);
      charging.step(dt);
    },
    render() {
      renderer.getDrawingBufferSize(dbs);
      if (dbs.x !== W || dbs.y !== H) resizeTargets(dbs.x, dbs.y);
      readTimers(); adapt();
      const ac = renderer.autoClear, rt0 = renderer.getRenderTarget(), ca = renderer.getClearAlpha(); renderer.getClearColor(cc);
      renderer.setRenderTarget(null); renderer.autoClear = true;
      timed('scene', () => renderer.render(scene, camera));
      // nothing alive: skip the effect layer, bloom and composite (setup, between moves)
      if (!nS && !nG && time >= pAlive && !fire.active && !thunder.active && !charging.active) { renderer.autoClear = ac; renderer.setRenderTarget(rt0); return; }
      timed('fx', fxPasses);
      renderer.setClearColor(cc, ca); renderer.autoClear = ac; renderer.setRenderTarget(rt0);
    },
    setSize(w, h) { renderer.setSize(w, h, false); renderer.getDrawingBufferSize(dbs); resizeTargets(dbs.x, dbs.y); },
    setBloom(b) { Object.assign(bloom, b); },
    /** { fxPixels, fxPixelsMin, fxBudgetMs, adaptive }: fxPixels also resets the adaptive size to it. */
    setQuality(q) { Object.assign(opts, q); if (q.fxPixels) { px = q.fxPixels; if (W) resizeTargets(W, H); } },
    stats() { return { sprites: nS, segments: nG, particleCap: CAP, shots: shots.size, live: live.length, auras: auras.size, charges: charges.size,
      fire: fire.stats(), thunder: thunder.stats(), charging: charging.stats(), fxPixels: Math.round(fxRT.width * fxRT.height), gpuSceneMs: +gpu.scene.toFixed(2), gpuFxMs: +gpu.fx.toFixed(2), timer: !!tq }; },
    dispose() {
      fire.dispose();
      thunder.dispose();
      charging.dispose();
      for (const t of [fxRT, ...down, ...up]) t.dispose();
      for (const m of [P, SP, SG]) { m.g.dispose(); m.mesh.material.dispose(); }
      for (const m of [downMat, upMat, compMat]) m.dispose();
      for (const { q } of queries.splice(0)) gl.deleteQuery(q);
      quad.geometry.dispose(); noise.dispose();
    },
  };
  function fxPasses() {
    renderer.autoClear = false;
    renderer.setRenderTarget(fxRT); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
    renderer.render(fxScene, camera);
    let src = fxRT;
    for (let i = 0; i < LEVELS; i++) {
      const u = downMat.uniforms; u.tSrc.value = src.texture; u.uTs.value.set(1 / src.width, 1 / src.height);
      u.uPre.value = i === 0 ? 1 : 0; u.uTh.value = bloom.threshold; u.uKnee.value = Math.max(.05, bloom.threshold * .5);
      pass(downMat, down[i]); src = down[i];
    }
    for (let i = LEVELS - 2; i >= 0; i--) {
      const u = upMat.uniforms; u.tSmall.value = src.texture; u.tCur.value = down[i].texture; u.uTs.value.set(1 / src.width, 1 / src.height); u.uRad.value = bloom.radius;
      pass(upMat, up[i]); src = up[i];
    }
    let norm = 0; for (let i = 0; i < LEVELS; i++) norm += bloom.radius ** i;
    compMat.uniforms.tBloom.value = src.texture; compMat.uniforms.uStr.value = bloom.strength * 2 / norm;
    pass(compMat, null);
  }
}
