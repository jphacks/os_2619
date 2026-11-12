// チャオベン劇場: a gross-funny look behind the game screen, all made of チャオベン, cut the way a MAD (音MAD) video cuts a face:
//   - the sky: his face tiled all over it, mirrored every other row, scrolling, each tile its own hue, over a turning rainbow burst; the whole
//     sky zooms on every beat and its colours jump every four beats (a cut, not a flash)
//   - a giant face cut out of the photo on the horizon, punching in on every beat (seen from the drone; the fixed camera looks down at the floor)
//   - a ring of big faces standing behind the crowd, all punching in together on the beat, every other one mirrored
//   - dozens of his faces flying round behind them, spinning, some mirrored, some hue-shifted, all pulsing on the beat
//   - the floor past the crowd: every other check is his face
//   - a ring of him around the arena (the 3D model), T-posing, hopping and swaying exactly in step; his heads growing out of the ground further out
//   - at a KO the whole crowd spins round once and leaps (react)
// The floor's checks change colour on the beat too. Pastel colours and no strong orange or blue, so the players' colours stand out.
// The pictures are the model's own (assets/models/chaoben.glb: 'face', the head cut from the photo it was made from).
// Same shape as the other looks (courtyard.js, backdrop.js): { group, uniforms, sun, hour, final, t, fit(R), setTime(h, final), update(dt), dispose() }, plus react() and watch(points).
// Only looks: shots pass through all of it. Draw calls: one for the sky, one for all the flat faces, three each for the crowd and the heads.
import * as THREE from 'three';
import { timeOfDay, DEFAULT_HOUR } from './sky.js';
import { bakeTriangles } from './ko-shatter.js';

const SUN = new THREE.Vector3(-.3, .6, .74).normalize(); // light from behind the camera, a little left: the players and the crowd face it lit
export const BEAT = 2;                                  // beats per second (120 BPM): everything here moves on it
export const CROWD = { gap: 1.85, rows: 2, rowGap: 1.6, from: 3.2, hop: .16, sway: .22, tint: 0xe2f7c4 }; // m between them
const HEADS = { n: 26, r0: 15, r1: 34, s0: 2.2, s1: 5 };
const FACES = { n: 48, r0: 2.4, r1: 9, y0: .7, y1: 3.4, s0: .9, s1: 2.2 }; // the flying faces, behind the crowd: m past its back row, height, size
const WALL = { n: 34, back: 2.2, y: 1.5, size: 2.5 };                        // the big faces standing in a ring behind the crowd (what the fixed camera sees above the crowd)
const GIANT = { pos: [0, 15, -62], size: 34 };

// the face's outline in the 'face' picture (u, v from its top left): an ellipse round the head
const FACE_GLSL = `
uniform sampler2D uFace;
float faceMask(vec2 uv) { vec2 q = (uv - vec2(.5, .45)) / vec2(.37, .47); return 1. - smoothstep(.93, 1., length(q)); }
vec3 faceAt(vec2 uv) { return texture2D(uFace, uv).rgb; }
vec3 hueTurn(vec3 c, float a) { // turn the hue by a (radians), keeping the brightness (YIQ)
  float y = dot(c, vec3(.299, .587, .114)), i = dot(c, vec3(.596, -.274, -.322)), q = dot(c, vec3(.211, -.523, .312));
  float ca = cos(a), sa = sin(a); vec2 iq = vec2(i * ca - q * sa, i * sa + q * ca);
  return clamp(vec3(y + .956 * iq.x + .621 * iq.y, y - .272 * iq.x - .647 * iq.y, y - 1.106 * iq.x + 1.703 * iq.y), 0., 1.);
}
float beatPunch(float t) { return pow(1. - fract(t * ${BEAT.toFixed(1)}), 4.); } // 1 on the beat, falling fast`;

// the ground (shared with the floor of the field, field3d.js): checks whose two colours change on every beat; a flesh-pink band far out
export const THEATER_GLSL = `
uniform float uBeatT;
${FACE_GLSL}
vec3 theaterColor(vec2 p) {
  vec2 q = floor(p / 1.2); float chk = mod(q.x + q.y, 2.), b = mod(floor(uBeatT * ${BEAT.toFixed(1)}), 4.);
  vec3 a = b < .5 ? vec3(.784, .714, 1.) : b < 1.5 ? vec3(1., .76, .886) : b < 2.5 ? vec3(.722, .961, .847) : vec3(.89, .722, 1.);
  vec3 w = b < .5 ? vec3(.914, .886, 1.) : b < 1.5 ? vec3(1., .953, .659) : b < 2.5 ? vec3(.945, 1., .969) : vec3(1., .878, .957);
  vec3 c = mix(a, w, chk);
  float r = length(p);
  // out past the crowd, every other check is his face (top towards -z, as the camera sees it), zooming on the beat, some hue-turned
  vec2 g = p / 1.8, cell = floor(g), f = (fract(g) - .5) / (1. + .1 * beatPunch(uBeatT)) + .5;
  float on = step(.5, mod(cell.x + cell.y, 2.)) * faceMask(f) * smoothstep(7., 8., r);
  vec3 face = faceAt(f); if (fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5) > .6) face = hueTurn(face, b * 1.6 + cell.x);
  c = mix(c, face, on);
  float band = smoothstep(17., 21., r) * (1. - smoothstep(36., 44., r));
  c = mix(c, vec3(.949, .655, .627) * (.93 + .07 * sin(r * 1.3 - uBeatT * 2.)), band * .85);
  return c;
}`;
const SKY_VS = `varying vec3 vD; void main() { vD = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.); gl_Position = p.xyww; }`;
const SKY_FS = `
uniform float uBeatT; varying vec3 vD;
${FACE_GLSL}
void main() {
  vec3 d = normalize(vD); float t = uBeatT, cut = floor(t * ${BEAT.toFixed(1)} / 4.); // every four beats the colours jump
  // a rainbow burst turning round the giant face's direction
  vec3 h = normalize(vec3(${GIANT.pos.join(', ')})); float a = atan(dot(d, vec3(1., 0., 0.)), dot(d, cross(vec3(1., 0., 0.), h))) / 6.2832 + .5;
  float ray = floor(fract(a + t * .06) * 24.);
  vec3 c = .5 + .5 * cos(6.2832 * (ray / 24. + cut * .23 + vec3(0., .33, .67)));
  c = mix(c, vec3(1.), .35); // pastel
  // his face tiled over the sky, scrolling up and along, every other row mirrored, zooming on the beat
  float z = 1. + .12 * beatPunch(t);
  vec2 uv = vec2(atan(d.x, -d.z) / 6.2832 * 18., (d.y + .15) * 7.) + vec2(t * .35, t * .25);
  vec2 cell = floor(uv), f = (fract(uv) - .5) / z + .5; f.y = 1. - f.y; // the picture's v runs down
  if (mod(cell.y, 2.) > .5) f.x = 1. - f.x;
  float on = step(.5, mod(cell.x + cell.y, 2.)) * faceMask(f) * smoothstep(-.2, .02, d.y);
  vec3 face = hueTurn(faceAt(f), (fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5) > .55 ? 1. : 0.) * (cut * 1.7 + cell.x));
  c = mix(c, face, on);
  gl_FragColor = vec4(c, 1.);
}`;
const GROUND_VS = `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const GROUND_FS = `varying vec3 vW;
${THEATER_GLSL}
void main() { gl_FragColor = vec4(theaterColor(vW.xz), 1.); }`;
// the flat faces, one instanced quad each, always turned to the camera. aLook: x hue turn (0: his own colours), y 1 or -1 (mirrored), z spin (rad/s), w punch on the beat
const FACE_VS = `
attribute vec4 aLook; uniform float uBeatT; varying vec2 vUv; varying vec4 vLook;
float beatPunch2(float t) { return pow(1. - fract(t * ${BEAT.toFixed(1)}), 4.); }
void main() {
  vUv = vec2(uv.x, 1. - uv.y); vLook = aLook;
  vec4 c = modelViewMatrix * instanceMatrix * vec4(0., 0., 0., 1.);
  float s = length(instanceMatrix[0].xyz) * (1. + aLook.w * beatPunch2(uBeatT)), a = aLook.z * uBeatT;
  vec2 o = mat2(cos(a), sin(a), -sin(a), cos(a)) * (position.xy * vec2(aLook.y, 1.)) * s;
  gl_Position = projectionMatrix * (c + vec4(o, 0., 0.));
}`;
const FACE_FS = `
varying vec2 vUv; varying vec4 vLook;
${FACE_GLSL}
void main() {
  float m = faceMask(vUv); if (m < .5) discard; // a hard cut-out edge, as in the videos
  vec3 c = faceAt(vUv); if (vLook.x != 0.) c = hueTurn(c, vLook.x);
  gl_FragColor = vec4(c, 1.);
}`;

const url = n => new URL('./assets/models/' + n, import.meta.url).href;
let MODEL = null; // the baked rest pose and the face picture, loaded once: { parts: [{ material, geometry, head }], height, face (texture) }
function loadModel() {
  return MODEL ??= import('three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) => new GLTFLoader().loadAsync(url('chaoben.glb'))).then(g => {
    const baked = bakeTriangles([g.scene]);
    let minY = Infinity, maxY = -Infinity;
    for (const b of baked) for (let i = 1; i < b.pos.length; i += 3) { minY = Math.min(minY, b.pos[i]); maxY = Math.max(maxY, b.pos[i]); }
    const geo = (b, keep) => {
      const pos = [], uv = [];
      b.seg.forEach((s, t) => { if (!keep(s)) return; for (let k = 0; k < 9; k++) pos.push(b.pos[9 * t + k] - (k % 3 === 1 ? minY : 0)); if (b.uv) for (let k = 0; k < 6; k++) uv.push(b.uv[6 * t + k]); });
      const gm = new THREE.BufferGeometry(); gm.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      if (b.uv) gm.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      gm.computeVertexNormals(); return gm;
    };
    const src = baked.find(b => b.material.name === 'face')?.material.map;
    const face = src ? src.clone() : null; // its own copy: read as it is stored (the shaders here work in display colours), from the top left
    if (face) { face.colorSpace = THREE.NoColorSpace; face.flipY = false; face.wrapS = face.wrapT = THREE.ClampToEdgeWrapping; face.needsUpdate = true; }
    return { height: maxY - minY, face, parts: baked.map(b => ({ material: b.material, geometry: geo(b, () => true), head: geo(b, s => s === 'head') })) };
  }).catch(e => { console.warn('chaoben stage: model', e); return null; });
}
function skinMat(src, tint) {
  const map = src.map ?? null;
  return new THREE.MeshStandardMaterial(map ? { map, color: tint, roughness: .8, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: .18 }
    : { color: 0x16110e, roughness: .55, metalness: 0, emissive: 0x16110e, emissiveIntensity: .1 });
}

/** createChaobenStage() -> the look (see the top). Builds the sky and the ground at once; the faces, the crowd and the heads appear once the model has loaded. */
export function createChaobenStage() {
  const group = new THREE.Group(); group.name = 'chaoben-stage';
  const uniforms = { uBeatT: { value: 0 }, uFace: { value: null } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms, side: THREE.BackSide, depthTest: false, depthWrite: false }));
  sky.frustumCulled = false; sky.renderOrder = -10; sky.visible = false; // until the face is loaded
  const ground = new THREE.Mesh(new THREE.RingGeometry(4, 120, 64, 1), new THREE.ShaderMaterial({ vertexShader: GROUND_VS, fragmentShader: GROUND_FS, uniforms }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.02;
  group.add(sky, ground);

  let R = 3, crowd = [], heads = [], faces = null, mats = [], time = 0, reactAt = -9, model = null, built = false;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), E = new THREE.Euler();
  const seats = []; // { x, z, yaw } around the arena, facing in
  const rnd = (k => () => (k = (k * 16807) % 2147483647) / 2147483647)(7); // a fixed sequence: the same stage every time

  function place() { // the seats follow the field's size
    seats.length = 0;
    for (let row = 0; row < CROWD.rows; row++) {
      const r = R + CROWD.from + row * CROWD.rowGap, n = Math.max(8, Math.round(2 * Math.PI * r / CROWD.gap));
      for (let i = 0; i < n; i++) { const a = (i + row * .5) / n * 2 * Math.PI; seats.push({ x: Math.sin(a) * r, z: Math.cos(a) * r, yaw: a + Math.PI }); }
    }
  }
  function buildFaces() {
    if (faces || !model?.face) return;
    uniforms.uFace.value = model.face; sky.visible = true;
    const n = 1 + WALL.n + FACES.n, look = new Float32Array(n * 4);
    faces = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1.25), new THREE.ShaderMaterial({ vertexShader: FACE_VS, fragmentShader: FACE_FS, uniforms }), n);
    faces.frustumCulled = false; mats.push(faces.material);
    faces.spots = [];
    for (let i = 0; i < n; i++) {
      const giant = i === 0, wall = i > 0 && i <= WALL.n;
      if (giant) look.set([0, 1, 0, .14], 0);
      else if (wall) look.set([i % 3 === 0 ? (i * 1.9) % 6.28 : 0, i % 2 ? 1 : -1, 0, .22], 4 * i); // all punch together; every other one mirrored, every third hue-turned
      else look.set([rnd() < .45 ? 0 : rnd() * 6.28, rnd() < .6 ? 1 : -1, (rnd() - .5) * 3, .1 + .25 * rnd()], 4 * i);
      faces.spots.push(giant ? null : wall ? { wall: (i - 1) / WALL.n * 2 * Math.PI } : { a: rnd() * 6.28, r: FACES.r0 + (FACES.r1 - FACES.r0) * rnd(), y: FACES.y0 + (FACES.y1 - FACES.y0) * rnd(), s: FACES.s0 + (FACES.s1 - FACES.s0) * rnd(), w: (rnd() < .5 ? -1 : 1) * (.08 + .2 * rnd()), bob: rnd() * 6.28 });
    }
    faces.geometry.setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 4));
    faces.setMatrixAt(0, m4.compose(p3.fromArray(GIANT.pos), q.identity(), s3.setScalar(GIANT.size)));
    group.add(faces);
  }
  function build() {
    if (!model || built) return; built = true;
    for (const c of crowd) group.remove(c); for (const h of heads) group.remove(h);
    const tint = new THREE.Color(CROWD.tint);
    crowd = model.parts.map(p => { const m = new THREE.InstancedMesh(p.geometry, skinMat(p.material, tint), seats.length); m.frustumCulled = false; mats.push(m.material); return m; });
    heads = model.parts.map(p => { const m = new THREE.InstancedMesh(p.head, skinMat(p.material, new THREE.Color(1, 1, 1)), HEADS.n); m.frustumCulled = false; mats.push(m.material); return m; });
    const r2 = (k => () => (k = (k * 16807) % 2147483647) / 2147483647)(11);
    heads.spots = Array.from({ length: HEADS.n }, (_, i) => { const a = i / HEADS.n * 2 * Math.PI + r2() * .2, r = HEADS.r0 + (HEADS.r1 - HEADS.r0) * r2(); return { x: Math.sin(a) * r, z: Math.cos(a) * r, s: HEADS.s0 + (HEADS.s1 - HEADS.s0) * r2(), yaw: a + Math.PI }; });
    group.add(...crowd, ...heads);
    buildFaces();
  }
  loadModel().then(m => { model = m; build(); });

  const t = timeOfDay(DEFAULT_HOUR, SUN);
  return {
    group, uniforms, sun: SUN.clone(), hour: DEFAULT_HOUR, final: true, t,
    setTime() { return 0; }, // always the same bright afternoon: the joke is not in the dark
    fit(r) { if (r !== R || !seats.length) { R = r; place(); built = false; build(); } },
    /** A KO: the whole crowd spins round once and leaps. */
    react() { reactAt = time; },
    watch() {}, // the faces look at the camera anyway
    update(dt) {
      time += dt; uniforms.uBeatT.value = time;
      if (!built) return;
      const beat = time * BEAT, hop = CROWD.hop * Math.abs(Math.sin(Math.PI * beat)), sway = CROWD.sway * Math.sin(Math.PI * beat);
      const rt = time - reactAt, spin = rt < .9 ? 2 * Math.PI * (1 - Math.pow(1 - rt / .9, 3)) : 0, leap = rt < .9 ? 1.2 * Math.sin(Math.PI * rt / .9) : 0;
      seats.forEach((s, i) => {
        q.setFromAxisAngle(Y, s.yaw + sway + spin); m4.compose(p3.set(s.x, hop + leap, s.z), q, s3.set(1, 1, 1));
        for (const m of crowd) m.setMatrixAt(i, m4);
      });
      for (const m of crowd) { m.count = seats.length; m.instanceMatrix.needsUpdate = true; }
      const nod = .18 * Math.sin(Math.PI * beat * .5);
      heads.spots.forEach((h, i) => {
        q.setFromEuler(E.set(nod, h.yaw, 0, 'YXZ')); m4.compose(p3.set(h.x, -model.height * h.s * .82, h.z), q, s3.setScalar(h.s));
        for (const m of heads) m.setMatrixAt(i, m4);
      });
      for (const m of heads) m.instanceMatrix.needsUpdate = true;
      if (faces) { // the wall turns slowly round the arena; the flyers circle further out, bobbing; the giant (0) stays
        const back = R + CROWD.from + (CROWD.rows - 1) * CROWD.rowGap;
        faces.spots.forEach((f, i) => {
          if (!f) return;
          if (f.wall != null) { const a = f.wall + time * .05, r = back + WALL.back; faces.setMatrixAt(i, m4.compose(p3.set(Math.sin(a) * r, WALL.y, Math.cos(a) * r), q.identity(), s3.setScalar(WALL.size))); return; }
          const a = f.a + f.w * time, r = back + f.r;
          faces.setMatrixAt(i, m4.compose(p3.set(Math.sin(a) * r, f.y + .4 * Math.sin(time * 1.7 + f.bob), Math.cos(a) * r), q.identity(), s3.setScalar(f.s)));
        });
        faces.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      for (const m of [sky, ground]) { m.geometry.dispose(); m.material.dispose(); }
      if (faces) faces.geometry.dispose();
      for (const m of mats) m.dispose(); // the baked geometry and the picture stay loaded for the next time
    },
  };
}
