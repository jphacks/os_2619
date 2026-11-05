// The magic-school courtyard behind the game screen (screen 3): a lawn, paths, sandstone gothic ranges with a cloister around it, a domed
// gate tower, a deep blue sky. All generated here but the grass (assets/backdrop/lawn.png). Only looks: nothing in the game knows about the buildings, and shots pass through them.
// It lives in the field's group (field3d.js), as the canyon does (backdrop.js), and has the same shape: { group, uniforms, sun, fit(R), update(dt), dispose() }.
// World frame: world.js (metres, y up). Phone C and the guide camera look from +z towards -z, so the tower stands on -z, far enough to show the sky above the roofline.
import * as THREE from 'three';
import { noiseTexture, sunBaker } from './backdrop.js';
import { TOD_GLSL, todUniforms, applyTod, timeOfDay, DEFAULT_HOUR } from './sky.js';

const TAU = Math.PI * 2;
const SUN = new THREE.Vector3(-.36, .52, .78).normalize(); // at DEFAULT_HOUR (sky.js), from behind the camera on the left: the range facing the camera is lit, the others throw their shadows on the lawn
const WALL_X = 28, WALL_BACK = -64, WALL_FRONT = 64; // m, the fronts of the ranges around the court: the field's centre is the court's centre
const LAWN = { x: 25, z0: -59, z1: 59, tile: 8, mean: [0.384, 0.471, 0.098] }; // m, the lawn; m one copy of the grass image covers (the size of the field), its mean colour
const EXT = 80, SHADOW_N = 1024; // m half the baked sunlight's side, its texels per side
const KIND = { stone: 0, trim: 1, glass: 2, dark: 3, slate: 4, lead: 5, gold: 6 };

// ---- geometry: everything goes into one mesh; aK is the surface kind ----
function builder() {
  const pos = [], kind = [], idx = [], v = new THREE.Vector3();
  return {
    pos, kind, idx,
    add(g, m, k) {
      const p = g.attributes.position, base = pos.length / 3;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); pos.push(v.x, v.y, v.z); kind.push(k); }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base);
      else for (let i = 0; i < p.count; i++) idx.push(i + base);
    },
  };
}
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CONE = new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4);
const archCache = new Map();
// A two-centred pointed arch, base at y = 0, width w, its curve starting at height s: points counter-clockwise seen from +z.
function archPoints(w, s, y0 = 0, seg = 5) {
  const P = [new THREE.Vector2(w / 2, y0)], top = Math.PI / 3;
  for (let i = 0; i <= seg; i++) { const a = top * i / seg; P.push(new THREE.Vector2(-w / 2 + w * Math.cos(a), s + w * Math.sin(a))); }
  for (let i = seg - 1; i >= 0; i--) { const a = top * i / seg; P.push(new THREE.Vector2(w / 2 - w * Math.cos(a), s + w * Math.sin(a))); }
  P.push(new THREE.Vector2(-w / 2, y0));
  return P;
}
function archPanel(w, s) { // the flat opening
  const key = `p${w},${s}`;
  if (!archCache.has(key)) archCache.set(key, new THREE.ShapeGeometry(new THREE.Shape(archPoints(w, s))));
  return archCache.get(key);
}
function archRing(w, s, t, depth) { // the stone around it
  const key = `r${w},${s},${t},${depth}`;
  if (!archCache.has(key)) {
    const shape = new THREE.Shape(archPoints(w, s));
    shape.holes.push(new THREE.Path(archPoints(w - 2 * t, s, t)));
    archCache.set(key, new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 }));
  }
  return archCache.get(key);
}

/** One range of the building, seen from the court: u runs along its face, n points out of it into the court, y up. */
function frame(b, ox, oz, nx, nz) {
  const n = new THREE.Vector3(nx, 0, nz), up = new THREE.Vector3(0, 1, 0), u = new THREE.Vector3().crossVectors(up, n);
  const M = new THREE.Matrix4().makeBasis(u, up, n).setPosition(ox, 0, oz), m = new THREE.Matrix4(), t = new THREE.Matrix4();
  return {
    box(u0, u1, y0, y1, n0, n1, k) { m.copy(M).multiply(t.makeTranslation((u0 + u1) / 2, (y0 + y1) / 2, (n0 + n1) / 2)).multiply(new THREE.Matrix4().makeScale(u1 - u0, y1 - y0, n1 - n0)); b.add(BOX, m, k); },
    at(g, uu, y, nn, k) { m.copy(M).multiply(t.makeTranslation(uu, y, nn)); b.add(g, m, k); },
    cone(uu, y, nn, r, h, k) { m.copy(M).multiply(t.makeTranslation(uu, y + h / 2, nn)).multiply(new THREE.Matrix4().makeScale(r, h, r)); b.add(CONE, m, k); },
    roof(u0, u1, y, depth, rise, k) { // a slate slope going up and back from the wall's top
      const s = rise / depth, shear = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, -s, 0, 0, 0, 1, 0, 0, 0, 0, 1);
      m.copy(M).multiply(shear).multiply(t.makeTranslation((u0 + u1) / 2, y - .5, -depth / 2 - .1)).multiply(new THREE.Matrix4().makeScale(u1 - u0, 1, depth)); b.add(BOX, m, k);
    },
  };
}
function pointedWindow(f, u, y, w, s, depth = .14) {
  f.at(archPanel(w, s), u, y, .02, KIND.glass);
  f.at(archRing(w + .36, s, .19, depth), u, y - .02, 0, KIND.trim);
  f.box(u - .045, u + .045, y, y + s + w * .78, 0, .1, KIND.trim); // mullion
  f.box(u - w / 2, u + w / 2, y + s * .52, y + s * .52 + .08, 0, .1, KIND.trim); // transom
  f.box(u - w / 2 - .28, u + w / 2 + .28, y - .16, y, 0, .24, KIND.trim); // sill
}
/** A range: the wall, its cloister along the court, one tall window a bay, the battlements, buttresses with pinnacles, an optional slate roof. */
function range(b, ox, oz, nx, nz, L, H, { bay = 3.7, sill = 4.5, spring = 7, winW = 1.6, roof = true, skip = () => false } = {}) {
  const f = frame(b, ox, oz, nx, nz), bays = Math.round(L / bay), W = L / bays;
  f.box(0, L, 0, H, -1.6, 0, KIND.stone); // the wall
  f.box(0, L, 0, .55, 0, 1.28, KIND.trim); // plinth of the cloister
  f.box(0, L, .55, 3.65, .9, 1.2, KIND.stone); // the cloister's front
  f.box(0, L, 3.65, 3.95, -.05, 1.42, KIND.trim); // its coping
  f.box(0, L, 3.95, 4.18, -.05, .5, KIND.stone); // the sloped lead above, read as a course
  f.box(0, L, H - .42, H - .16, -.05, .2, KIND.trim); // cornice
  for (let i = 0; i < bays; i++) {
    if (skip(i, bays)) continue;
    const c = (i + .5) * W, aw = W * .68;
    f.at(archPanel(aw, 1.5), c, .55, 1.205, KIND.dark);
    f.at(archRing(aw + .2, 1.5, .13, .13), c, .54, 1.2, KIND.trim);
    for (const side of [-1, 1]) f.at(archRing(aw / 2 - .02, 1.42, .06, .06), c + side * (aw / 4 - .01), .56, 1.22, KIND.trim); // two lancets in the tracery
    f.box(c - .05, c + .05, .55, 2.95, 1.2, 1.28, KIND.trim);
    pointedWindow(f, c, sill, winW, spring - sill);
  }
  for (let i = 0; i <= bays; i++) { // buttresses and their pinnacles
    const c = i * W;
    f.box(c - .3, c + .3, 0, 3.9, 1.2, 1.72, KIND.stone);
    f.box(c - .2, c + .2, 3.9, H - .1, 0, .34, KIND.stone);
    if (i % 2 === 0) { f.box(c - .2, c + .2, H - .1, H + .55, -.2, .2, KIND.trim); f.cone(c, H + .55, 0, .26, 1.3, KIND.trim); }
  }
  for (let u = .3; u < L - .3; u += 1.06) f.box(u, u + .6, H - .16, H + .4, -.3, .1, KIND.trim); // battlements
  f.box(0, L, H - .16, H + .02, -.3, .1, KIND.trim);
  if (roof) f.roof(0, L, H - .3, 5.2, 3.6, KIND.slate);
  return f;
}
function gateTower(f, c) { // the gate tower on the far range: the clock, the octagon, the lead dome and its lantern
  const w = 3.1, top = 10.6;
  f.box(c - w, c + w, 0, top, -2, 2.2, KIND.stone);
  f.box(c - w, c + w, 0, .6, 2.2, 2.36, KIND.trim);
  f.at(archPanel(3, 2.3), c, 0, 2.21, KIND.dark);
  f.at(archRing(3.5, 2.3, .25, .2), c, 0, 2.2, KIND.trim);
  f.box(c - w - .08, c + w + .08, 4.25, 4.5, 2.2, 2.38, KIND.trim);
  pointedWindow({ ...f, at: (g, u, y, n, k) => f.at(g, u, y, n + 2.2, k), box: (u0, u1, y0, y1, n0, n1, k) => f.box(u0, u1, y0, y1, n0 + 2.2, n1 + 2.2, k) }, c, 4.6, 1.9, 1.5, .2);
  const disc = new THREE.CylinderGeometry(.82, .82, .1, 24).rotateX(Math.PI / 2);
  f.at(disc, c, 8.8, 2.26, KIND.trim);
  f.box(c - .04, c + .04, 8.8, 9.4, 2.31, 2.34, KIND.dark); f.box(c - .04, c + .38, 8.76, 8.84, 2.31, 2.34, KIND.dark); // the clock's hands
  f.box(c - w - .08, c + w + .08, top - .3, top, 2.2, 2.38, KIND.trim);
  for (let u = c - w; u < c + w - .3; u += 1) f.box(u, u + .58, top, top + .55, 1.85, 2.3, KIND.trim);
  for (const s of [-1, 1]) { f.box(c + s * (w - .4) - .4, c + s * (w - .4) + .4, top, top + 1.3, 1.5, 2.3, KIND.stone); f.cone(c + s * (w - .4), top + 1.3, 1.9, .42, 2.2, KIND.trim); }
  const oct = new THREE.CylinderGeometry(2.05, 2.35, 3.8, 8);
  f.at(oct, c, top + 1.9, 0, KIND.stone);
  const belt = new THREE.CylinderGeometry(2.22, 2.22, .24, 8);
  f.at(belt, c, top + 3.86, 0, KIND.trim);
  const dome = new THREE.SphereGeometry(2.05, 16, 7, 0, TAU, 0, Math.PI / 2).scale(1, 1.42, 1);
  f.at(dome, c, top + 3.96, 0, KIND.lead);
  const lantern = new THREE.CylinderGeometry(.42, .5, 1.2, 8), cap = new THREE.ConeGeometry(.55, .9, 8);
  f.at(lantern, c, top + 7.3, 0, KIND.trim); f.at(cap, c, top + 8.3, 0, KIND.lead); f.cone(c, top + 8.7, 0, .06, 1.3, KIND.gold);
}
function buildCourt() {
  const b = builder(), width = 2 * WALL_X, length = WALL_FRONT - WALL_BACK, mid = width / 2;
  // the two ends of the court are the same range with the same corner towers; only the far one has the gate tower, in the gap left for it
  const end = (ox, oz, nz, skip) => {
    const f = range(b, ox, oz, 0, nz, width, 7.2, { sill: 4.35, spring: 5.35, winW: 1.2, roof: false, skip });
    for (const c of [1.7, width - 1.7]) {
      f.box(c - 1.8, c + 1.8, 0, 9, -1.6, 1.8, KIND.stone);
      for (const s of [-1, 1]) for (const n of [-1.3, 1.5]) { f.box(c + s * 1.5 - .25, c + s * 1.5 + .25, 9, 9.9, n - .25, n + .25, KIND.trim); f.cone(c + s * 1.5, 9.9, n, .34, 1.8, KIND.trim); }
      for (let x = c - 1.7; x < c + 1.6; x += .85) f.box(x, x + .5, 9, 9.45, 1.4, 1.8, KIND.trim);
    }
    return f;
  };
  gateTower(end(-WALL_X, WALL_BACK, 1, (i, n) => Math.abs(i + .5 - n / 2) < 1), mid);
  end(WALL_X, WALL_FRONT, -1); // behind the camera
  range(b, -WALL_X, WALL_FRONT, 1, 0, length, 10.5, { spring: 7.5 }); // left of the view
  range(b, WALL_X, WALL_BACK, -1, 0, length, 10.5, { spring: 7.5 }); // right of the view
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('aK', new THREE.Float32BufferAttribute(b.kind, 1));
  g.setIndex(b.idx);
  return { geometry: g, pos: b.pos, idx: b.idx };
}

function loadGrass(slot) { // slot: the uniform that holds the texture
  const t = new THREE.DataTexture(new Uint8Array([...LAWN.mean.map(v => v * 255), 255]), 1, 1, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  slot.value = t;
  if (typeof Image === 'undefined') return;
  const img = new Image();
  img.onload = () => {
    const photo = new THREE.Texture(img);
    photo.wrapS = photo.wrapT = THREE.RepeatWrapping; photo.minFilter = THREE.LinearMipmapLinearFilter; photo.magFilter = THREE.LinearFilter;
    photo.generateMipmaps = true; photo.anisotropy = 16; photo.needsUpdate = true; // no colour space: the shaders work in display colours
    t.dispose(); slot.value = photo;
  };
  img.onerror = () => console.warn('courtyard: lawn.png did not load');
  img.src = new URL('./assets/backdrop/lawn.png', import.meta.url).href;
}

// ---- shaders: display colours, their own sun (as backdrop.js) ----
// The ground, shared with the floor of the field (field3d.js).
export const LAWN_GLSL = `
uniform sampler2D cN, cSh, cG; uniform vec3 cSun; uniform float cExt;
vec2 grassRand(vec2 v) { return fract(sin(mat2(127.1, 311.7, 269.5, 183.3) * v) * 43758.5453); }
vec3 grassCopy(vec2 uv, vec2 dx, vec2 dy, vec2 corner) { // the image as this corner of the grid sees it: its own turn and its own place
  vec2 h = grassRand(corner); float a = h.x * 6.2832; mat2 r = mat2(cos(a), sin(a), -sin(a), cos(a));
  return textureGrad(cG, r * uv + h.yx * 7.3 + h, r * dx, r * dy).rgb;
}
vec3 grass(vec2 uv) { // the clovers must not line up: a triangle grid over the ground, each corner reading a turned, shifted copy
  vec2 dx = dFdx(uv), dy = dFdy(uv), sk = mat2(1., -.57735027, 0., 1.15470054) * uv * 1.5, base = floor(sk), f = fract(sk);
  float z = 1. - f.x - f.y; vec3 w; vec2 a, b, c;
  if (z > 0.) { w = vec3(z, f.y, f.x); a = base; b = base + vec2(0., 1.); c = base + vec2(1., 0.); }
  else { w = vec3(-z, 1. - f.y, 1. - f.x); a = base + vec2(1.); b = base + vec2(1., 0.); c = base + vec2(0., 1.); }
  w = pow(w, vec3(6.)); w /= w.x + w.y + w.z; // mostly one copy, a short fade between them
  vec3 m = vec3(${LAWN.mean.join(', ')}); // blending flattens contrast: put it back (variance-preserving blend)
  vec3 sum = (grassCopy(uv, dx, dy, a) - m) * w.x + (grassCopy(uv, dx, dy, b) - m) * w.y + (grassCopy(uv, dx, dy, c) - m) * w.z;
  return m + sum / sqrt(dot(w, w));
}
float turfHeight(vec2 q) { return .6 * texture2D(cN, mat2(.825, .565, -.565, .825) * q * .63).r + .4 * texture2D(cN, mat2(.454, -.891, .891, .454) * q * 1.07 + .37).g; }
vec3 lawnColor(vec2 p) {
  vec2 e = abs(p - vec2(0., ${((LAWN.z0 + LAWN.z1) / 2).toFixed(2)})) - vec2(${LAWN.x.toFixed(1)}, ${((LAWN.z1 - LAWN.z0) / 2).toFixed(2)});
  float out_ = max(e.x, e.y), onLawn = 1. - smoothstep(-.015, .015, out_);
  // inside the field's outline, one whole copy of the image, as it is; around it, the turned copies, fading in just past the outline
  vec3 g = mix(grass(p / ${LAWN.tile.toFixed(1)}), texture2D(cG, vec2(.5 + p.x / ${LAWN.tile.toFixed(1)}, .5 - p.y / ${LAWN.tile.toFixed(1)})).rgb, 1. - smoothstep(${(LAWN.tile / 2).toFixed(1)}, ${(LAWN.tile / 2 + .6).toFixed(1)}, max(abs(p.x), abs(p.y))));
  float big = texture2D(cN, p * .05 + .7).r, tuft = texture2D(cN, p * .23 + .3).g;
  g *= .92 + big * .1 + tuft * .08; // slow changes of tone, so the far lawn does not go flat
  // the turf's gentle lumps, only in the light: a height, the sun on its slope (the surface stays flat). So they do not repeat: two noises at unrelated turns and scales, stronger in some places than others
  // (moving the noise about instead, by another noise, stretched the lumps into streaks)
  float e1 = .02, h1 = turfHeight(p);
  vec2 slope = vec2(turfHeight(p + vec2(e1, 0.)) - h1, turfHeight(p + vec2(0., e1)) - h1) / e1 * (.015 + .03 * big);
  g *= clamp(dot(normalize(vec3(-slope.x, 1., -slope.y)), cSun) / cSun.y, .82, 1.16);
  // the paths: pale flagstones
  vec2 q = p / vec2(1.3, .8); float row = floor(q.y); q.x += mod(row, 2.) * .5; vec2 fq = abs(fract(q) - .5) * 2., cell = floor(q);
  float tone = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453), joint = smoothstep(.93, .98, max(fq.x, fq.y));
  vec3 pave = mix(vec3(.60, .56, .47), vec3(.72, .67, .57), tone) * (.86 + tuft * .2) * (1. - joint * .3 * (1. - smoothstep(.1, .5, fwidth(q.x))));
  vec3 c = mix(pave, g, onLawn);
  c *= 1. - .35 * (1. - smoothstep(0., .1, abs(out_))); // the lawn's cut edge
  vec4 sh = texture2D(cSh, p / (2. * cExt) + .5);
  return c * (vec3(.27, .33, .47) * uTodAmb + vec3(.78, .70, .50) * uTodSun * sh.r) * mix(.76, 1., smoothstep(.1, .95, sh.g)); // the sky's light, the sun's on top
}`;
const SKY_VS = `varying vec3 vD; void main() { vD = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.); gl_Position = p.xyww; }`;
const SKY_FS = `
uniform sampler2D cN; uniform float uTime; uniform vec3 cSun; varying vec3 vD;
${TOD_GLSL}
void main() { // deep blue, a few small white clouds; the clock (sky.js) turns it into dawn, dusk or night
  vec3 d = normalize(vD); float y = max(d.y, 0.);
  vec3 c = mix(vec3(.66, .81, .96), vec3(.20, .47, .87), smoothstep(0., .2, y));
  c = mix(c, vec3(.03, .20, .58), smoothstep(.12, .75, y));
  c += vec3(.5, .45, .35) * pow(max(dot(d, cSun), 0.), 200.);
  vec2 q = d.xz / (y + .22);
  float a = texture2D(cN, q * .055 + uTime * vec2(.0011, .0002)).r, b = texture2D(cN, q * .19 - uTime * .0005).g, m = texture2D(cN, q * .017 + .4).g;
  float n = a * .68 + b * .34, cloud = smoothstep(.58, .68, n) * smoothstep(.42, .6, m) * smoothstep(.015, .11, y);
  c = mix(c, mix(vec3(.80, .84, .90), vec3(1.), smoothstep(.6, .78, n)), cloud);
  gl_FragColor = vec4(todSky(d, c, cloud, uTime), 1.);
}`;
const GROUND_VS = `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const GROUND_FS = `
${TOD_GLSL}
${LAWN_GLSL}
varying vec3 vW;
void main() { gl_FragColor = vec4(lawnColor(vW.xz), 1.); }`;
const STONE_VS = `attribute float aK; varying vec3 vW; varying float vK; void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vK = aK; gl_Position = projectionMatrix * viewMatrix * w; }`;
const STONE_FS = `
uniform sampler2D cN; uniform highp sampler2D cD; uniform vec3 cSun, cSunB; uniform float cExt, uKeep; varying vec3 vW; varying float vK;
${TOD_GLSL}
float sunlit(vec3 p) { // the baked depth, four taps: is anything higher up this point's sun ray? (cSunB: the sun it was baked for)
  vec2 g = (p.xz - cSunB.xz / cSunB.y * p.y) / (2. * cExt) + .5;
  if (g.x < 0. || g.y < 0. || g.x > 1. || g.y > 1.) return 1.;
  float t = max(p.y, 0.) / cSunB.y + .24, o = .75 / ${SHADOW_N}.;
  return (step(texture2D(cD, g + vec2(-o, -o)).r, t) + step(texture2D(cD, g + vec2(o, -o)).r, t) + step(texture2D(cD, g + vec2(-o, o)).r, t) + step(texture2D(cD, g + vec2(o, o)).r, t)) / 4.;
}
float hash(vec2 v) { return fract(sin(dot(v, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  // a building standing between the camera and the field dissolves, wherever phone C or the drone ends up
  vec2 cp = cameraPosition.xz; float cl = max(length(cp), .001); vec2 u = cp / cl; float along = dot(vW.xz, u);
  if (cl > uKeep && along > uKeep && along < cl + 2. && vW.y > cameraPosition.y * (along - uKeep) / (cl - uKeep) * .8) {
    float off = length(vW.xz - u * along), dither = fract(52.9829 * fract(dot(gl_FragCoord.xy, vec2(.0671, .00584))));
    if (smoothstep(uKeep, uKeep + 1.5, off) < dither) discard;
  }
  vec3 N = normalize(cross(dFdx(vW), dFdy(vW)));
  float k = floor(vK + .5), along2 = abs(N.x) > abs(N.z) ? vW.z : vW.x;
  vec2 tuv = vec2(along2, vW.y);
  float n1 = texture2D(cN, tuv * .07).r, n2 = texture2D(cN, tuv * vec2(.13, .05) + 3.).g, n3 = texture2D(cN, tuv * .9).a;
  vec3 alb;
  if (k < .5) { // coursed sandstone: rows of blocks, each its own tone, darker low down and in long streaks
    float h = .31, row = floor(vW.y / h), len = .62 + .3 * hash(vec2(row, 3.));
    float x = along2 / len + hash(vec2(row, 7.)) * 3.;
    float col = floor(x), tone = hash(vec2(col, row));
    float fy = abs(fract(vW.y / h) - .5) * 2., fx = abs(fract(x) - .5) * 2.;
    float fade = 1. - smoothstep(.12, .45, max(fwidth(vW.y / h), fwidth(x))); // mortar goes before it would shimmer
    float mortar = max(smoothstep(.86, .96, fy), smoothstep(.93, .985, fx)) * fade;
    alb = mix(vec3(.69, .56, .37), vec3(.84, .72, .50), tone * fade + .5 * (1. - fade));
    alb = mix(alb, vec3(.60, .46, .30), smoothstep(.72, 1., hash(vec2(col + 9., row))) * .7 * fade);
    alb *= 1. - mortar * .34;
    alb *= .82 + n1 * .28;
    float low = 1. - smoothstep(.3, 5.2, vW.y);
    alb = mix(alb, vec3(.26, .22, .17) * (.8 + n1 * .5), low * smoothstep(.25, .7, n2) * .78); // soot and damp at the foot, as on the old walls
    alb *= 1. - smoothstep(.62, .85, n2) * .2;
  } else if (k < 1.5) { // dressed stone: paler and smooth
    alb = mix(vec3(.80, .71, .53), vec3(.90, .82, .65), n1) * (.93 + n3 * .1);
    alb = mix(alb, vec3(.34, .29, .23), (1. - smoothstep(.3, 3.8, vW.y)) * smoothstep(.3, .7, n2) * .6);
  } else if (k < 2.5) { // leaded glass: it mirrors the sky darkly, lit by nothing
    vec2 lat = abs(fract(vec2(along2, vW.y) / .24) - .5) * 2.; float fade = 1. - smoothstep(.1, .4, fwidth(along2 / .24));
    vec3 g = mix(vec3(.09, .13, .19), vec3(.27, .38, .52), smoothstep(.3, .78, n2 + (n3 - .5) * .35));
    float lamp = step(.38, hash(vec2(floor(along2 / 1.9), floor(vW.y / 2.6)))) * uTodLamp; // after dark most windows are lit from inside
    g = mix(g * uTodAmb, vec3(1., .70, .34) * (.85 + .3 * n2), lamp);
    gl_FragColor = vec4(g * (1. - max(smoothstep(.8, .95, lat.x), smoothstep(.8, .95, lat.y)) * .45 * fade), 1.);
    return;
  } else if (k < 3.5) { // the dark inside of the cloister
    gl_FragColor = vec4((vec3(.05, .05, .055) + vec3(.05, .045, .035) * smoothstep(1.8, .6, vW.y)) * uTodAmb + vec3(.30, .17, .06) * uTodLamp * smoothstep(3.2, .4, vW.y), 1.); // lanterns in the cloister at night
    return;
  } else if (k < 4.5) { alb = vec3(.25, .28, .33) * (.8 + n2 * .35); // slates
  } else if (k < 5.5) { alb = vec3(.56, .63, .68) * (.88 + n1 * .24); // the dome's lead
  } else { alb = vec3(.95, .74, .28); } // gold
  float ndl = max(dot(N, cSun), 0.), s = ndl > 0. ? sunlit(vW) : 0.;
  vec3 light = vec3(1.34, 1.2, 1.0) * uTodSun * ndl * s + (vec3(.38, .46, .62) * (.62 + .38 * N.y) + vec3(.26, .34, .15) * max(-N.y * .6 + .4, 0.)) * uTodAmb; // the sun, the blue sky, the lawn's green from below
  vec3 c = alb * light;
  gl_FragColor = vec4(mix(c, todHaze(vec3(.70, .80, .92)), smoothstep(40., 120., distance(vW, cameraPosition)) * .22), 1.);
}`;

/** createCourtyard(tod) -> { group, uniforms (the floor shares c* and tod), sun (the light now), fit(R), setTime(h, final), update(dt), dispose() }. tod: sky.js todUniforms(), shared with the floor. */
export function createCourtyard(tod = todUniforms()) {
  const group = new THREE.Group(); group.name = 'courtyard';
  const { geometry, pos, idx } = buildCourt();
  const uniforms = {
    cN: { value: noiseTexture() }, cSh: { value: null }, cD: { value: null }, cSun: { value: SUN.clone() }, cSunB: { value: SUN.clone() }, cExt: { value: EXT },
    cG: { value: null }, uTime: { value: 0 }, uKeep: { value: 6 }, ...tod,
  };
  const baker = sunBaker({ depth: uniforms.cD, light: uniforms.cSh, dir: uniforms.cSunB }, SHADOW_N);
  baker.setGeometry(pos, idx, [[0, idx.length]], EXT);
  baker.bake(SUN, true);
  loadGrass(uniforms.cG);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms, side: THREE.BackSide, depthTest: false, depthWrite: false, extensions: { derivatives: true } }));
  sky.frustumCulled = false; sky.renderOrder = -10;
  const ground = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ vertexShader: GROUND_VS, fragmentShader: GROUND_FS, uniforms, extensions: { derivatives: true } }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.02;
  const stone = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ vertexShader: STONE_VS, fragmentShader: STONE_FS, uniforms, extensions: { derivatives: true } }));
  stone.frustumCulled = false;
  group.add(sky, ground, stone);
  let holeR = 0;
  return {
    group, uniforms, sun: uniforms.cSun.value, hour: DEFAULT_HOUR, final: true, t: timeOfDay(DEFAULT_HOUR, SUN),
    /** The clock (hours). final: bake the shadows at full size (~0.2 s), else a quick small bake while the clock is being turned. Returns the bake's ms. */
    setTime(h, final) {
      this.hour = h; this.final = final; this.t = timeOfDay(h, SUN);
      applyTod(tod, this.t); uniforms.cSun.value.fromArray(this.t.lightDir);
      return baker.bake(uniforms.cSun.value, final);
    },
    fit(R) { // the court keeps its size: it is far larger than any field a scan gives
      uniforms.uKeep.value = R + .5;
      if (R !== holeR) { ground.geometry.dispose(); ground.geometry = new THREE.RingGeometry(R + 1, 95, 64, 1); holeR = R; } // the floor's quad is opaque out to R + 1.4
    },
    update(dt) { uniforms.uTime.value += dt; },
    dispose() { uniforms.cN.value.dispose(); uniforms.cG.value.dispose(); baker.dispose(); for (const m of [sky, ground, stone]) { m.geometry.dispose(); m.material.dispose(); } },
  };
}
export const courtForTests = { buildCourt, LAWN, WALL_X, WALL_BACK, WALL_FRONT, SUN, EXT };
