// fx-ww-layer.js: textured sprites and shader meshes for the water and wind moves (fx-smash-water.js, fx-smash-wind.js,
// fx-smash-charge.js), drawn in effects.js's HDR effect scene next to the particle / sprite batches.
// Immediate mode like effect-kit.js: effects.js calls begin() before the styles run each frame and end() after; a move draws
// what it needs every frame from its own age, so nothing here keeps state between frames.
//
// Why: the program-drawn water / wind read as flat rings and dots next to fire / thunder, which have painted textures and
// fbm-noise spheres. Real-time VFX breakdowns build water and wind the same way: meshes (columns, cones, discs, ribbons) with
// tileable noise textures scrolled along them (UV panning), a value ramp dark→light, a fresnel rim and alpha erosion
// (Season waterfall on realtimevfx.com, Unity nature shaders, Maxime Catel's tornado on 80.lv).
//   tube   an open cylinder, u round / v up: geyser, waterfall, tornado funnel (radius r0 → r1, wobble, lean)
//   helix  a ribbon wound round the y axis: water strands round the body, wind bands round the tornado / body
//   sphere the water orb / compressed-air ball
//   disc   lying on the floor: splash pool with ring waves, whirlpool, dust swirl
// Water: tWater-flow streaks scrolled along the flow, Worley foam where flow peaks and where `foam` asks, fresnel rim, dark body
// that hides the video. Wind: thin tapered streaks (wind-streak) scrolled round, opacity × fresnel, almost no body.
import * as THREE from 'three';
import { createKit, RAMP, blend } from './effect-kit.js';

const MVS = `
uniform float uShape, uTime, uSeed, uR0, uR1, uH, uTurns, uWidth, uPhase, uWob, uLean, uCurve;
varying vec2 vUv; varying vec3 vN, vEye;
#define TAU 6.2831853
void main(){
  vec3 p, n; vec2 t = uv;
  if (uShape < .5) { // tube
    float a = t.x * TAU, v = t.y, r = mix(uR0, uR1, pow(v, uCurve));
    r *= 1. + uWob * (sin(a * 3. + v * 7. - uTime * 4. + uSeed * 9.) * .5 + sin(a * 5. - v * 11. + uTime * 6.3) * .3);
    vec2 c = uLean * v * vec2(sin(v * 3.1 + uTime * 1.7 + uSeed * 6.), cos(v * 2.3 + uTime * 1.3 + uSeed * 4.));
    p = vec3(cos(a) * r + c.x, v * uH, sin(a) * r + c.y); n = vec3(cos(a), 0., sin(a));
  } else if (uShape < 1.5) { // helix ribbon
    float s = t.x, a = s * uTurns * TAU + uPhase, r = mix(uR0, uR1, s);
    r *= 1. + uWob * sin(s * 13. + uTime * 5. + uSeed * 7.);
    p = vec3(cos(a) * r, s * uH + (t.y - .5) * uWidth * (.3 + .7 * sin(3.1416 * s)), sin(a) * r); n = vec3(cos(a), 0., sin(a));
  } else if (uShape < 2.5) { p = position; n = normal; } // sphere
  else { float a = t.x * TAU, r = t.y; p = vec3(cos(a) * r, 0., sin(a) * r); n = vec3(0., 1., 0.); } // disc
  vUv = t; vec4 mv = modelViewMatrix * vec4(p, 1.);
  vN = normalize(normalMatrix * n); vEye = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const MFS = `
uniform sampler2D tFlow, tFoam, tStreak;
uniform float uEl, uShape, uTime, uSeed, uOpacity, uI, uFlow, uSpin, uFoam, uErode, uOcc, uTwist;
uniform vec2 uTile; uniform vec3 uColA, uColB;
varying vec2 vUv; varying vec3 vN, vEye;
#define TAU 6.2831853
void main(){
  vec3 N = normalize(vN), E = normalize(vEye);
  float rim = 1. - abs(dot(N, E)), s = uSeed; vec2 t = vUv;
  vec2 q; float ends = 1.;
  bool tube = uShape < .5, helix = uShape > .5 && uShape < 1.5, ball = uShape > 1.5 && uShape < 2.5, disc = uShape > 2.5;
  if (disc) { float r = max(t.y, .001); q = vec2(t.x * uTile.x + uSpin * uTime + log(r) * uTwist, r * uTile.y - uFlow * uTime); ends = smoothstep(1., .72, r); }
  else if (helix) { q = vec2(t.x * uTile.x - uFlow * uTime + s, t.y * uTile.y + s * 3.); ends = smoothstep(0., .5, abs(.5 - abs(t.y - .5)) * 2.) ; }
  else { q = vec2(t.x * uTile.x + s + uSpin * uTime + t.y * uTwist, t.y * uTile.y - uFlow * uTime); }
  if (tube) ends = smoothstep(0., .06, t.y) * smoothstep(1., .86, t.y);
  vec3 c; float a, occ;
  if (uEl < .5) { // ---- water ----
    vec2 qf = helix ? q.yx * vec2(1., -1.) : q; // the flow texture streaks run along v; on a helix the flow runs along u
    float f1 = texture2D(tFlow, qf).r, f2 = texture2D(tFlow, qf * vec2(1.6, .7) + vec2(.37, -uFlow * uTime * .35)).r;
    float val = f1 * .62 + f2 * .38;
    float fm = texture2D(tFoam, q * vec2(1.3, 1.5) + vec2(.11, .23)).r;
    vec3 deep = uColA * .3;
    c = mix(deep, uColA, smoothstep(.15, .55, val));
    c = mix(c, uColB, smoothstep(.6, .88, val));
    float hl = smoothstep(.8, .96, f1), fres = pow(rim, 2.2);
    float foam = clamp(smoothstep(.5, .8, fm * .7 + val * .5 - .45 + uFoam * .45) * uFoam * 1.5, 0., 1.);
    if (disc) foam = max(foam, smoothstep(.62, .9, fm) * smoothstep(.2, .0, t.y) * uFoam);
    if (ball) { vec3 L = normalize(vec3(-.45, .6, .65)); float sp = pow(max(dot(reflect(-E, N), L), 0.), 40.);
      c += vec3(.95, .99, 1.) * sp * 2.2 + uColB * smoothstep(.55, .95, fm) * .5 * (1. - rim); }
    c += uColB * fres * 1.3 + vec3(.85, .96, 1.) * hl * .55;
    c = mix(c, vec3(.9, .97, 1.) * 1.3, foam);
    float er = smoothstep(uErode, uErode + .14, val * .8 + fm * .2 + .06);
    float edge = ball ? 1. : smoothstep(1.02, .8, rim + (.5 - val) * .4);
    if (helix) edge *= .85 + .15 * rim;
    a = ends * er * edge * uOpacity * (gl_FrontFacing ? 1. : .55);
    occ = uOcc * (.65 + .35 * foam);
  } else { // ---- wind ----
    float st = texture2D(tStreak, q).r, st2 = texture2D(tStreak, q * vec2(.6, 1.7) + vec2(.5, .21)).r;
    float n = texture2D(tFlow, q.yx * .3 + vec2(s, 0.)).r;
    float band = clamp(pow(st, 1.2) * 1.5 + st2 * .5, 0., 1.6) * (.3 + 1.1 * smoothstep(.25, .8, n)) + .06 * n; // crisp streaks, broken up by noise, a faint body
    float fres = ball ? .4 + .6 * pow(rim, 1.2) : mix(.15, 1.1, pow(rim, 1.6)); // seen through the middle, dense at the silhouette
    if (disc || helix) fres = 1.; // flat bands: no silhouette to brighten
    if (helix) ends *= smoothstep(0., .55, t.x) * smoothstep(1., .9, t.x); // bright head, long fading tail: a swoosh
    c = mix(uColA, uColB, smoothstep(.2, .9, st));
    a = band * fres * ends * uOpacity * smoothstep(uErode, uErode + .25, n) * (gl_FrontFacing ? 1. : .7);
    occ = uOcc;
  }
  if (a < .004) discard;
  gl_FragColor = vec4(c * a * uI, a * occ);
}`;

const WATER_TEX = [['flow', 'water-flow.png'], ['foam', 'water-foam.png'], ['streak', 'wind-streak.png'], ['splash', 'water-splash.png'], ['drop', 'water-drop.png'],
  ['mist', 'mist-puff.png'], ['foamRing', 'foam-ring.png'], ['spray', 'spray-cluster.png'], ['glint', 'glint.png']];
const WIND_TEX = [['flow', 'water-flow.png'], ['streak', 'wind-streak.png'], ['twirl', 'wind-twirl.png'], ['slash', 'wind-slash.png'], ['trace', 'wind-trace.png'],
  ['mist', 'mist-puff.png'], ['dust', 'dust-debris.png'], ['leaf', 'leaf.png'], ['glint', 'glint.png']];

export function createWaterWindLayer(scene) {
  const gW = new THREE.Group(), gA = new THREE.Group(), gM = new THREE.Group();
  gW.name = 'water-sprites'; gA.name = 'wind-sprites'; gM.name = 'water-wind-meshes';
  scene.add(gM, gW, gA);
  const water = createKit(gW, 'water', WATER_TEX.map(([k, f]) => [k, f]), { cap: 2048, ribbons: 512, label: 'Water' });
  const wind = createKit(gA, 'wind', WIND_TEX.map(([k, f]) => [k, f]), { cap: 2048, ribbons: 512, label: 'Wind' });
  const meshes = createKit(gM, 'water', [], { cap: 1, ribbons: 1, label: 'WaterWindMesh' }); // only for its mesh pool
  for (const t of [water.texture('flow'), water.texture('foam'), water.texture('streak'), wind.texture('flow'), wind.texture('streak')]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const grid = new THREE.PlaneGeometry(1, 1, 64, 24), ball = new THREE.SphereGeometry(1, 40, 24);
  const SHAPE = { tube: 0, helix: 1, sphere: 2, disc: 3 };
  let time = 0, nMesh = 0;
  const material = () => new THREE.ShaderMaterial({ ...blend, vertexShader: MVS, fragmentShader: MFS, uniforms: {
    tFlow: { value: water.texture('flow') }, tFoam: { value: water.texture('foam') }, tStreak: { value: water.texture('streak') },
    ...Object.fromEntries(['uEl', 'uShape', 'uTime', 'uSeed', 'uR0', 'uR1', 'uH', 'uTurns', 'uWidth', 'uPhase', 'uWob', 'uLean', 'uCurve', 'uOpacity', 'uI', 'uFlow', 'uSpin', 'uFoam', 'uErode', 'uOcc', 'uTwist'].map(k => [k, { value: 0 }])),
    uTile: { value: new THREE.Vector2(1, 1) }, uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
  } });
  const DEF = { r0: 1, r1: 1, h: 1, turns: 1, width: .1, phase: 0, wob: 0, lean: 0, curve: 1, opacity: 1, intensity: 1, flow: 1, spin: 0, foam: 0, erode: 0, occ: .5, twist: 0, seed: 0, tile: [1, 1], t: null };
  /**
   * el 'water' | 'wind', shape 'tube' | 'helix' | 'sphere' | 'disc', p position (tube / helix / disc: the base centre), s scale.
   * o: { r0, r1, h, turns, width, phase, wob, lean, curve, opacity, intensity, flow, spin, foam, erode (0 solid .. 1 gone), occ, twist,
   *      seed, tile [u, v], colA (body / dim), colB (light), t (shader time; default the layer clock) }. Returns the mesh (rotate it if needed).
   */
  function mesh(el, shape, p, s, o = {}) {
    if ((o.opacity ?? 1) <= .003) return null;
    const m = meshes.mesh(shape, () => { const m = new THREE.Mesh(shape === 'sphere' ? ball : grid, material()); m.renderOrder = 4; return m; }, p, s);
    const u = m.material.uniforms, q = { ...DEF, ...o };
    u.uEl.value = el === 'wind' ? 1 : 0; u.uShape.value = SHAPE[shape];
    u.uTime.value = q.t ?? time; u.uSeed.value = q.seed; u.uR0.value = q.r0; u.uR1.value = q.r1; u.uH.value = q.h; u.uTurns.value = q.turns;
    u.uWidth.value = q.width; u.uPhase.value = q.phase; u.uWob.value = q.wob; u.uLean.value = q.lean; u.uCurve.value = q.curve;
    u.uOpacity.value = q.opacity; u.uI.value = q.intensity; u.uFlow.value = q.flow; u.uSpin.value = q.spin; u.uFoam.value = q.foam;
    u.uErode.value = q.erode; u.uOcc.value = q.occ; u.uTwist.value = q.twist; u.uTile.value.set(q.tile[0], q.tile[1]);
    const A = q.colA ?? (el === 'wind' ? [.55, .72, .75] : [.02, .2, .85]), B = q.colB ?? (el === 'wind' ? [.95, 1, 1] : [.35, .85, 1]);
    u.uColA.value.setRGB(A[0], A[1], A[2]); u.uColB.value.setRGB(B[0], B[1], B[2]);
    if (el === 'wind') { u.tFlow.value = wind.texture('flow'); u.tStreak.value = wind.texture('streak'); }
    nMesh++;
    return m;
  }
  return {
    water, wind, mesh, RAMP,
    begin(t) { time = t; nMesh = 0; water.begin(); wind.begin(); meshes.begin(); },
    end() { water.end(); wind.end(); meshes.end(); },
    get active() { return gW.visible || gA.visible || gM.visible; },
    stats() { return { sprites: water.count + wind.count, meshes: nMesh, loaded: water.loaded.length + wind.loaded.length, errors: [...water.errors, ...wind.errors] }; },
    dispose() { water.dispose(); wind.dispose(); meshes.dispose(); grid.dispose(); ball.dispose(); },
  };
}
