// The rocky canyon behind the game screen (screen 3): sky, layered sandstone mesas and the ground they stand on. The sky and the rocks
// are generated here; the ground is one image (assets/backdrop/ground.png), used as it is. Only looks: nothing in the game knows about the rocks, and shots and players pass through them.
// It lives in the field's group (field3d.js), so it shows wherever the arena does and never in the final render's picture.
// The shaders write display colours directly and use their own fixed sun, so the avatars' lights do not touch them.
// World frame: world.js (metres, y up). Phone C and the guide camera look from +z towards -z: the open side stays on +z.
import * as THREE from 'three';

const rng = seed => () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const TAU = Math.PI * 2;
const SUN = new THREE.Vector3(-.5, .68, .54).normalize(); // high, from behind the left of the view: the cliffs facing the camera are lit, shadows fall away from the field
export const SUN_DIR = SUN;
export const DEFAULT_R = 4 * Math.SQRT2; // the 8 m square field the layout was placed around; a larger field pushes the rocks out
const CLEAR = 1.6; // m, boulders stay this far outside the field's radius
const GROUND_M = 12, SHADOW_N = 1024; // m one repeat of the ground image covers, centred on the field; texels per side of the baked sunlight

const tilingNoise = (period, rand) => { // value noise over [0, 1)², tiling
  const g = Float32Array.from({ length: period * period }, rand);
  return (x, y) => {
    const fx = x * period, fy = y * period, ix = Math.floor(fx), iy = Math.floor(fy);
    const s = t => t * t * (3 - 2 * t), a = s(fx - ix), b = s(fy - iy);
    const at = (i, j) => g[(i % period) + (j % period) * period];
    return (at(ix, iy) * (1 - a) + at(ix + 1, iy) * a) * (1 - b) + (at(ix, iy + 1) * (1 - a) + at(ix + 1, iy + 1) * a) * b;
  };
};
// One tiling noise texture (r, g: soft layers, b: ridges, a: fine grain), mipmapped so far rock does not shimmer.
export function noiseTexture(size = 256) {
  const rand = rng(11), data = new Uint8Array(size * size * 4), layer = period => tilingNoise(period, rand);
  const fbm = (periods, x, y) => { let v = 0, w = .5, n = 0; for (const l of periods) { v += l(x, y) * w; n += w; w *= .55; } return v / n; };
  const A = [4, 8, 16, 32, 64].map(layer), B = [3, 7, 14, 28, 56].map(layer), C = [5, 11, 23, 47].map(layer), F = layer(128);
  const stretch = v => Math.max(0, Math.min(1, (v - .5) * 1.9 + .5)); // fbm bunches around .5: spread it over the whole range
  for (let j = 0, k = 0; j < size; j++) for (let i = 0; i < size; i++, k += 4) {
    const x = i / size, y = j / size;
    data[k] = stretch(fbm(A, x, y)) * 255;
    data[k + 1] = stretch(fbm(B, x, y)) * 255;
    data[k + 2] = (1 - Math.abs(fbm(C, x, y) * 2 - 1)) * 255;
    data[k + 3] = F(x, y) * 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

// The ground image. Until it has loaded (and in the tests, which have no images) the ground is one plain orange.
function loadGround(slot) { // slot: the uniform that holds the texture
  const t = new THREE.DataTexture(new Uint8Array([205, 107, 46, 255]), 1, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  slot.value = t;
  if (typeof Image === 'undefined') return;
  const img = new Image();
  img.onload = () => {
    const photo = new THREE.Texture(img);
    photo.wrapS = photo.wrapT = THREE.RepeatWrapping; photo.minFilter = THREE.LinearMipmapLinearFilter; photo.magFilter = THREE.LinearFilter;
    photo.generateMipmaps = true; photo.anisotropy = 16; photo.needsUpdate = true; // no colour space: the shaders work in display colours
    t.dispose(); slot.value = photo;
  };
  img.onerror = () => console.warn('backdrop: ground.png did not load');
  img.src = new URL('./assets/backdrop/ground.png', import.meta.url).href;
}

// The sunlight, baked once from the real rock shapes: every triangle is projected along the sun onto the ground.
// depth: per texel, how far up the sun's ray the highest rock is (m). ground: r = sharp shadow, g = the wide dark around a rock's foot.
export function bakeSunlight(pos, idx, ranges, ext, n = SHADOW_N, depth = new Float32Array(n * n), ground = new Uint8Array(n * n * 4), sun = SUN) {
  depth.fill(0);
  const ax = sun.x / sun.y, az = sun.z / sun.y, k = n / (2 * ext);
  const U = i => (pos[i] - ax * pos[i + 1] + ext) * k, V = i => (pos[i + 2] - az * pos[i + 1] + ext) * k, T = i => Math.max(0, pos[i + 1]) / sun.y;
  for (const [from, to] of ranges) for (let q = from; q < to; q += 3) {
    const a = idx[q] * 3, b = idx[q + 1] * 3, c = idx[q + 2] * 3;
    const x0 = U(a), y0 = V(a), x1 = U(b), y1 = V(b), x2 = U(c), y2 = V(c), t0 = T(a), t1 = T(b), t2 = T(c);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-5) continue;
    const X0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), X1 = Math.min(n - 1, Math.ceil(Math.max(x0, x1, x2)));
    const Y0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), Y1 = Math.min(n - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const w1 = ((x + .5 - x0) * (y2 - y0) - (x2 - x0) * (y + .5 - y0)) / area, w2 = ((x1 - x0) * (y + .5 - y0) - (x + .5 - x0) * (y1 - y0)) / area, w0 = 1 - w1 - w2;
      if (w0 < -.01 || w1 < -.01 || w2 < -.01) continue;
      const t = w0 * t0 + w1 * t1 + w2 * t2, p = x + y * n;
      if (t > depth[p]) depth[p] = t;
    }
  }
  const cover = Float32Array.from(depth, d => d > .02 ? 0 : 1); // 1 = in the sun
  const blur = (src, r) => { // box blur, both ways
    const a = Float32Array.from(src), b = new Float32Array(n * n), norm = 1 / (2 * r + 1);
    for (let y = 0; y < n; y++) { let sum = 0; for (let x = -r; x <= r; x++) sum += a[Math.max(0, Math.min(n - 1, x)) + y * n]; for (let x = 0; x < n; x++) { b[x + y * n] = sum * norm; sum += a[Math.min(n - 1, x + r + 1) + y * n] - a[Math.max(0, x - r) + y * n]; } }
    for (let x = 0; x < n; x++) { let sum = 0; for (let y = -r; y <= r; y++) sum += b[x + Math.max(0, Math.min(n - 1, y)) * n]; for (let y = 0; y < n; y++) { a[x + y * n] = sum * norm; sum += b[x + Math.min(n - 1, y + r + 1) * n] - b[x + Math.max(0, y - r) * n]; } }
    return a;
  };
  const sharp = blur(cover, 1), wide = blur(blur(cover, 9), 9);
  for (let p = 0; p < n * n; p++) { ground[p * 4] = sharp[p] * 255; ground[p * 4 + 1] = wide[p] * 255; ground[p * 4 + 3] = 255; }
  return { depth, ground };
}

// ---- rock geometry: stacked strata. All rocks share the same layer heights, as real sediment does, so the bands line up across the view ----
function strataHeights(max = 34) {
  const rand = rng(5), h = [-.3];
  while (h[h.length - 1] < max) { const v = rand(); h.push(h[h.length - 1] + (v < .25 ? .3 + rand() * .3 : v < .8 ? .6 + rand() * .6 : 1.2 + rand() * 1.1)); }
  return h;
}
const STRATA = strataHeights();

/** Adds one rock to the arrays. { x, z, r, h, n: columns around, seed, squash: x/z stretch, angle, flat: >0 keeps the top wide (a slab) }. */
export function addRock(pos, ao, idx, { x, z, r, h, n = 48, seed = 1, squash = 1, angle = 0, flat = 0 }) {
  const rand = rng(seed), wave = Array.from({ length: 4 }, (_, i) => [rand() * TAU, .3 / (i + 1.5) * (.6 + rand() * .8)]);
  const shape = a => 1 + wave.reduce((s, [p, w], i) => s + Math.sin(a * (i + 2) + p) * w, 0);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const put = (a, rad, y, o) => {
    const u = Math.cos(a) * rad * squash, v = Math.sin(a) * rad / squash;
    pos.push(x + u * cos - v * sin, y, z + u * sin + v * cos); ao.push(o);
    return pos.length / 3 - 1;
  };
  const tiers = STRATA.filter(y => y < h).concat(h);
  let setback = 1, last = null;
  for (let k = 0; k < tiers.length - 1; k++) {
    const y0 = tiers[k], y1 = tiers[k + 1], thick = y1 - y0;
    // each layer breaks into blocks that stick out or fall back, and the whole mass steps in as it rises
    const v = rand(); setback *= 1 - (flat ? .02 : v * v * v * .34 + .012);
    setback = Math.max(setback, flat ? .8 : .3);
    const M = 5 + Math.floor(rand() * 13), blocks = Array.from({ length: M }, () => (rand() - .5) * (.35 + rand() * .75));
    const rows = [[], []], bite = rand() < .3 ? rand() * TAU : null;
    for (let j = 0; j < n; j++) {
      const a = j / n * TAU, b = blocks[Math.floor(j / n * M)], notch = bite !== null ? Math.exp(-((Math.atan2(Math.sin(a - bite), Math.cos(a - bite)) / .5) ** 2)) * .22 : 0;
      const rad = Math.max(.2, r * shape(a) * (setback - notch) + b * Math.min(thick, 1.1) * Math.min(1, r / 3));
      rows[0].push(put(a, rad * 1.02, y0, .52)); // under the layer above: in its shade
      rows[1].push(put(a, rad * (flat ? .84 : .985), y1, 1));
    }
    const quad = (A, B) => { for (let j = 0; j < n; j++) { const a = A[j], b = A[(j + 1) % n], c = B[j], d = B[(j + 1) % n]; idx.push(a, c, b, b, c, d); } };
    quad(rows[0], rows[1]); // the wall of this layer
    if (last) quad(last, rows[0]); // the ledge from the layer below
    last = rows[1];
  }
  const centre = put(0, 0, h, 1);
  for (let j = 0; j < n; j++) idx.push(last[j], centre, last[(j + 1) % n]);
}

/** The layout: hand placed around the view from +z, then a far ring for the other camera modes. Positions scale with the field. */
export function layout(R = DEFAULT_R) {
  const s = Math.max(1, R / DEFAULT_R), rand = rng(23), L = [];
  const add = (x, z, r, h, o = {}) => L.push({ x: x * s, z: z * s, r, h, seed: L.length * 7 + 3, ...o });
  // the tall wall on the left of the view, the terraces on the right; a gap between them shows the sky and the far buttes
  add(-20, -9, 7.5, 21, { squash: 1.25, angle: .9, n: 96 }); add(-14.5, -18, 5.5, 15, { n: 72 }); add(-24, 2, 7, 17, { n: 72 });
  add(17, -9.5, 5.5, 5.5, { n: 72, squash: 1.3, angle: -.5 }); add(23, -17, 7, 11, { n: 84 }); add(15, -20, 5, 6, { n: 72, squash: 1.2 }); add(28, -6, 7, 13, { n: 72 });
  add(1, -38, 9, 2.6, { n: 56, squash: 1.6 }); add(-11, -46, 8, 5, { n: 48 });
  // the sides and the back: farther off on +z, where phone C stands and the drone flies
  add(23, 11, 6, 9, { n: 56 }); add(-26, 16, 7, 11, { n: 56 }); add(21, 26, 7, 8, { n: 48 }); add(-13, 31, 7, 7, { n: 48 }); add(6, 39, 9, 10, { n: 48 });
  for (let i = 0; i < 26; i++) { // the horizon all around
    const a = i / 26 * TAU + rand() * .15, d = 52 + rand() * 20;
    const open = Math.max(0, 1 - Math.abs(Math.atan2(Math.cos(a), -Math.sin(a))) / .62); // towards -z the horizon stays low: the sky of the fixed view
    add(Math.cos(a) * d, Math.sin(a) * d, 5 + rand() * 7, (6 + rand() * rand() * 20) * (1 - open * .8), { far: true, n: 24, squash: .8 + rand() * .7, angle: rand() * TAU });
  }
  const rocks = L.length;
  // loose slabs and boulders on the sand, more towards the far side
  for (let i = 0; i < 46; i++) {
    const a = rand() * TAU, d = (R + CLEAR) + rand() * rand() * 15 * s;
    const x = Math.cos(a) * d, z = Math.sin(a) * d * (Math.sin(a) > 0 ? 1.6 : 1), big = rand();
    L.push({ x, z, r: .22 + big * big * 1.25, h: .1 + big * .55 + rand() * .15, seed: 900 + i, n: 22, flat: 1, squash: .75 + rand() * .8, angle: rand() * TAU });
  }
  return { list: L, big: L.slice(0, rocks) };
}

// ---- shaders ----
// Sky, sand and rock share this: the sun, the far haze, and the sand's colour with the mesas' soft shadows on it.
export const SAND_GLSL = `
uniform sampler2D tN, tSh, tG; uniform vec3 uSun; uniform float uExt;
const vec3 HAZE = vec3(.75, .85, .95);
vec3 sandColor(vec2 p) { // the ground image as it is; only the rocks' shadows go on top
  vec3 c = texture2D(tG, p / ${GROUND_M}. + .5).rgb;
  // the sun: rock shadows, cool and clean-edged, and a little dark around a rock's foot
  vec4 sh = texture2D(tSh, p / (2. * uExt) + .5);
  float lit = sh.r, foot = smoothstep(.15, .95, sh.g);
  return c * mix(vec3(.30, .34, .50), vec3(1.07, 1.03, .98), lit) * mix(.72, 1., foot);
}`;
const SKY_VS = `varying vec3 vD; void main() { vD = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.); gl_Position = p.xyww; }`;
const SKY_FS = `
uniform sampler2D tN; uniform float uTime; uniform vec3 uSun; varying vec3 vD;
void main() {
  vec3 d = normalize(vD); float y = max(d.y, 0.);
  vec3 c = mix(vec3(.76, .87, .97), vec3(.33, .62, .94), smoothstep(0., .17, y)); // clear: pale at the horizon, deep overhead
  c = mix(c, vec3(.07, .29, .70), smoothstep(.1, .72, y));
  c += vec3(.5, .42, .3) * pow(max(dot(d, uSun), 0.), 180.) + vec3(.18, .17, .14) * pow(max(dot(d, uSun), 0.), 16.); // the sun's halo
  vec2 q = d.xz / (y + .16); // a few small, thin clouds
  float a = texture2D(tN, q * vec2(.021, .05) + uTime * vec2(.0012, .0003)).r, b = texture2D(tN, q * vec2(.11, .26) - uTime * .0006).g, m = texture2D(tN, q * .009 + .3).g;
  float cloud = smoothstep(.70, .90, a * .72 + b * .32) * smoothstep(.52, .70, m) * smoothstep(.02, .14, y);
  c = mix(c, vec3(1.), cloud * .8);
  gl_FragColor = vec4(c, 1.);
}`;
const GROUND_VS = `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const GROUND_FS = `
${SAND_GLSL}
varying vec3 vW;
void main() {
  vec3 c = sandColor(vW.xz);
  gl_FragColor = vec4(mix(c, HAZE, smoothstep(34., 92., distance(vW, cameraPosition)) * .88), 1.);
}`;
const ROCK_VS = `attribute float aO; varying vec3 vW; varying float vO; void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vO = aO; gl_Position = projectionMatrix * viewMatrix * w; }`;
const ROCK_FS = `
${SAND_GLSL}
uniform float uKeep; uniform highp sampler2D tD; varying vec3 vW; varying float vO;
float sunlit(vec3 p) { // the baked depth, four taps: is anything higher up this point's sun ray?
  vec2 g = (p.xz - uSun.xz / uSun.y * p.y) / (2. * uExt) + .5;
  if (g.x < 0. || g.y < 0. || g.x > 1. || g.y > 1.) return 1.;
  float t = max(p.y, 0.) / uSun.y + .42, o = .75 / ${SHADOW_N}.;
  return (step(texture2D(tD, g + vec2(-o, -o)).r, t) + step(texture2D(tD, g + vec2(o, -o)).r, t) + step(texture2D(tD, g + vec2(-o, o)).r, t) + step(texture2D(tD, g + vec2(o, o)).r, t)) / 4.;
}
vec4 tri(vec3 p, vec3 w, float k) { // one noise sample per plane, squeezed along y so it reads as bedding
  return w.x * texture2D(tN, vec2(p.z, p.y * 4.5) * k) + w.z * texture2D(tN, vec2(p.x, p.y * 4.5) * k) + w.y * texture2D(tN, p.xz * k * 1.2);
}
void main() {
  // a rock standing between the camera and the field dissolves, wherever phone C or the drone ends up
  vec2 cp = cameraPosition.xz; float cl = max(length(cp), .001); vec2 u = cp / cl; float along = dot(vW.xz, u);
  if (cl > uKeep && along > uKeep && along < cl + 2. && vW.y > cameraPosition.y * (along - uKeep) / (cl - uKeep) * .8) { // above the sight line down to the field's near edge
    float off = length(vW.xz - u * along), dither = fract(52.9829 * fract(dot(gl_FragCoord.xy, vec2(.0671, .00584))));
    if (smoothstep(uKeep, uKeep + 1.5, off) < dither) discard;
  }
  vec3 N = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 w = pow(abs(N), vec3(5.)); w /= w.x + w.y + w.z;
  float wander = texture2D(tN, vW.xz * .019).r, y = vW.y + (wander - .5) * 2.4; // the bands wander a little
  float b1 = texture2D(tN, vec2(.37, y * .041)).g, b2 = texture2D(tN, vec2(.71, y * .17)).r;
  vec3 alb = mix(vec3(.47, .23, .14), vec3(.68, .35, .20), smoothstep(.28, .58, b1));
  alb = mix(alb, vec3(.86, .53, .31), smoothstep(.48, .78, b2));
  float olive = texture2D(tN, vW.xz * .043 + vW.y * .027).g; // the weathered, mossy tan patches
  alb = mix(alb, vec3(.60, .52, .31), smoothstep(.58, .8, olive) * .62);
  vec4 d1 = tri(vW, w, .13), d2 = tri(vW, w, .47), d3 = tri(vW, w, 1.7);
  alb *= .76 + d1.r * .3 + d2.g * .2;
  float crack = smoothstep(.95, 1., d1.b) * .55 + smoothstep(.965, 1., d2.b) * .35; // dark fissures
  float joint = w.x * texture2D(tN, vec2(vW.z * .31, vW.y * .05)).b + w.z * texture2D(tN, vec2(vW.x * .31, vW.y * .05)).b;
  crack += smoothstep(.95, 1., joint) * (1. - w.y) * .45;
  alb *= 1. - min(crack, 1.) * .55;
  float up = smoothstep(.45, .85, N.y);
  alb = mix(alb, vec3(.72, .45, .29) * (.82 + d2.r * .36), up * .78); // ledges carry sand
  N = normalize(N + (vec3(d2.r, d3.g, d2.g) - .5) * .85 + (vec3(d3.a, d3.r, d3.g) - .5) * .35);
  vec3 sun = vec3(1.32, 1.18, .98) * max(dot(N, uSun), 0.) * sunlit(vW);
  vec3 sky = vec3(.34, .44, .64) * (.62 + .38 * N.y), bounce = vec3(.58, .36, .23) * max(-N.y * .6 + .4, 0.); // blue from above, the bright sand from below
  vec3 c = alb * (sun + sky + bounce) * mix(vO, 1., .35);
  gl_FragColor = vec4(mix(c, HAZE, smoothstep(30., 90., distance(vW, cameraPosition)) * .7), 1.);
}`;

/** createBackdrop() -> { group, uniforms (the floor shares them for its sand), update(dt), fit(R), dispose() } */
export function createBackdrop() {
  const group = new THREE.Group(); group.name = 'backdrop';
  const uniforms = {
    tN: { value: noiseTexture() }, uSun: { value: SUN.clone() }, uTime: { value: 0 }, uKeep: { value: DEFAULT_R },
    tG: { value: null }, uExt: { value: 64 }, tD: { value: null }, tSh: { value: null },
  };
  loadGround(uniforms.tG);
  const depth = new Float32Array(SHADOW_N * SHADOW_N), light = new Uint8Array(SHADOW_N * SHADOW_N * 4);
  const tD = uniforms.tD.value = new THREE.DataTexture(depth, SHADOW_N, SHADOW_N, THREE.RedFormat, THREE.FloatType); // read four times by hand: floats do not filter everywhere
  const tSh = uniforms.tSh.value = new THREE.DataTexture(light, SHADOW_N, SHADOW_N, THREE.RGBAFormat);
  tSh.minFilter = THREE.LinearMipmapLinearFilter; tSh.magFilter = THREE.LinearFilter; tSh.generateMipmaps = true;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms, side: THREE.BackSide, depthTest: false, depthWrite: false }));
  sky.frustumCulled = false; sky.renderOrder = -10;
  const ground = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ vertexShader: GROUND_VS, fragmentShader: GROUND_FS, uniforms }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.02;
  const rocks = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ vertexShader: ROCK_VS, fragmentShader: ROCK_FS, uniforms }));
  rocks.frustumCulled = false; // one mesh all around the field
  group.add(sky, ground, rocks);
  let fitted = 0, holeR = 0;
  function fit(R) { // rebuilds only when the field outgrew the layout
    const scale = Math.max(1, R / DEFAULT_R);
    uniforms.uKeep.value = R + .5;
    if (R !== holeR) { ground.geometry.dispose(); ground.geometry = new THREE.RingGeometry(R + 1, 95, 64, 1); holeR = R; } // the floor's quad is opaque out to R + 1.4
    if (scale === fitted) return;
    fitted = scale;
    const { list } = layout(R), pos = [], ao = [], idx = [], ranges = [];
    for (const r of list) { const from = idx.length; addRock(pos, ao, idx, r); if (!r.far) ranges.push([from, idx.length]); }
    rocks.geometry.dispose();
    const g = rocks.geometry = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aO', new THREE.Float32BufferAttribute(ao, 1)); g.setIndex(idx);
    uniforms.uExt.value = 64 * scale;
    bakeSunlight(pos, idx, ranges, 64 * scale, SHADOW_N, depth, light);
    tD.needsUpdate = tSh.needsUpdate = true;
  }
  fit(DEFAULT_R);
  return {
    group, uniforms, fit, sun: SUN,
    update(dt) { uniforms.uTime.value += dt; },
    dispose() { uniforms.tN.value.dispose(); uniforms.tG.value.dispose(); tD.dispose(); tSh.dispose(); for (const m of [sky, ground, rocks]) { m.geometry.dispose(); m.material.dispose(); } },
  };
}
