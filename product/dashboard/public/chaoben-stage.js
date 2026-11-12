// チャオベン劇場: a gross-funny look behind the game screen, all made of チャオベン (assets/models/chaoben.glb).
//   - a ring of him around the arena, T-posing, all hopping and swaying exactly in step (in step is the joke: dozens of one man moving as one)
//   - his heads growing out of the ground further out, nodding together
//   - one giant head on the horizon as the sun, its face turned on the two players wherever they go
//   - at a KO the whole crowd spins round once and leaps (react)
// Pastel and bright (pink sky, mint horizon, lavender checks), so it reads funny rather than scary; no orange or blue in it, so the players' colours stand out.
// Same shape as the other looks (courtyard.js, backdrop.js): { group, uniforms, sun, hour, final, t, fit(R), setTime(h, final), update(dt), dispose() }, plus react() and watch(points).
// Only looks: shots pass through all of it. The crowd is the model's rest pose baked once (ko-shatter.js bakeTriangles) and instanced: three draw calls per group.
import * as THREE from 'three';
import { timeOfDay, DEFAULT_HOUR } from './sky.js';
import { bakeTriangles } from './ko-shatter.js';

const SUN = new THREE.Vector3(-.3, .6, .74).normalize(); // light from behind the camera, a little left: the players and the crowd face it lit
const GIANT = { z: -58, scale: 16, sink: .3 };          // the giant head: how far, how big, how much of it is under the horizon
export const CROWD = { gap: 1.85, rows: 2, rowGap: 1.6, from: 3.2, beat: 2, hop: .16, sway: .22, tint: 0xe2f7c4 }; // m between them; beats per second
const HEADS = { n: 26, r0: 15, r1: 34, s0: 2.2, s1: 5 };

// the ground (shared with the floor of the field, field3d.js): lavender checks, a flesh-pink band far out that slowly breathes
export const THEATER_GLSL = `
vec3 theaterColor(vec2 p) {
  vec2 q = floor(p / 1.2); float chk = mod(q.x + q.y, 2.);
  vec3 c = mix(vec3(.784, .714, 1.), vec3(.914, .886, 1.), chk);
  float r = length(p), band = smoothstep(17., 21., r) * (1. - smoothstep(36., 44., r));
  c = mix(c, vec3(.949, .655, .627) * (.93 + .07 * sin(r * 1.3 - uTime * 2.)), band * .85);
  return c;
}`;
const SKY_VS = `varying vec3 vD; void main() { vD = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.); gl_Position = p.xyww; }`;
const SKY_FS = `
uniform float uTime; uniform vec3 uHead; varying vec3 vD;
void main() { // pink overhead, mint at the horizon, pale yellow rays turning slowly behind the giant head
  vec3 d = normalize(vD); float y = max(d.y, 0.);
  vec3 c = mix(vec3(.851, .969, .910), vec3(1., .839, .925), smoothstep(0., .45, y));
  vec3 h = normalize(uHead); vec3 t = normalize(d - h * dot(d, h)), u = normalize(cross(h, vec3(0., 1., 0.)));
  float a = atan(dot(t, cross(u, h)), dot(t, u)), near = smoothstep(.2, .98, dot(d, h));
  float rays = step(.5, fract(a * 18. / 6.2832 + uTime * .05));
  c = mix(c, vec3(1., .957, .42), rays * near * .45);
  gl_FragColor = vec4(c, 1.);
}`;
const GROUND_VS = `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const GROUND_FS = `uniform float uTime; varying vec3 vW;
${THEATER_GLSL}
void main() { gl_FragColor = vec4(theaterColor(vW.xz), 1.); }`;

const url = n => new URL('./assets/models/' + n, import.meta.url).href;
let MODEL = null; // the baked rest pose, loaded once: { parts: [{ material, geometry, head: geometry }], height }
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
    return { height: maxY - minY, parts: baked.map(b => ({ material: b.material, geometry: geo(b, () => true), head: geo(b, s => s === 'head') })) };
  }).catch(e => { console.warn('chaoben stage: model', e); return null; });
}
function skinMat(src, tint) {
  const map = src.map ?? null;
  return new THREE.MeshStandardMaterial(map ? { map, color: tint, roughness: .8, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: .18 }
    : { color: 0x16110e, roughness: .55, metalness: 0, emissive: 0x16110e, emissiveIntensity: .1 });
}

/** createChaobenStage() -> the look (see the top). Builds the sky and the ground at once; the crowd, the heads and the giant appear once the model has loaded. */
export function createChaobenStage() {
  const group = new THREE.Group(); group.name = 'chaoben-stage';
  const uniforms = { uTime: { value: 0 }, uHead: { value: new THREE.Vector3(0, .3, GIANT.z).normalize() } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms, side: THREE.BackSide, depthTest: false, depthWrite: false }));
  sky.frustumCulled = false; sky.renderOrder = -10;
  const ground = new THREE.Mesh(new THREE.RingGeometry(4, 120, 64, 1), new THREE.ShaderMaterial({ vertexShader: GROUND_VS, fragmentShader: GROUND_FS, uniforms }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.02;
  group.add(sky, ground);

  let R = 3, crowd = [], heads = [], giant = null, mats = [], time = 0, reactAt = -9, model = null, built = false;
  const watchAt = new THREE.Vector3(0, 1.2, 0), lookNow = new THREE.Vector3(0, 1.2, 0);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const seats = []; // { x, z, yaw } around the arena, facing in

  function place() { // the seats follow the field's size
    seats.length = 0;
    for (let row = 0; row < CROWD.rows; row++) {
      const r = R + CROWD.from + row * CROWD.rowGap, n = Math.max(8, Math.round(2 * Math.PI * r / CROWD.gap));
      for (let i = 0; i < n; i++) { const a = (i + row * .5) / n * 2 * Math.PI; seats.push({ x: Math.sin(a) * r, z: Math.cos(a) * r, yaw: a + Math.PI }); }
    }
  }
  function build() {
    if (!model || built) return; built = true;
    for (const c of crowd) group.remove(c); for (const h of heads) group.remove(h);
    const tint = new THREE.Color(CROWD.tint);
    crowd = model.parts.map(p => { const m = new THREE.InstancedMesh(p.geometry, skinMat(p.material, tint), seats.length); m.frustumCulled = false; mats.push(m.material); return m; });
    heads = model.parts.map(p => { const m = new THREE.InstancedMesh(p.head, skinMat(p.material, new THREE.Color(1, 1, 1)), HEADS.n); m.frustumCulled = false; mats.push(m.material); return m; });
    // the heads: scattered by a fixed sequence (the same every time), looking in at the arena
    const rnd = (k => () => (k = (k * 16807) % 2147483647) / 2147483647)(7);
    heads.spots = Array.from({ length: HEADS.n }, (_, i) => { const a = i / HEADS.n * 2 * Math.PI + rnd() * .2, r = HEADS.r0 + (HEADS.r1 - HEADS.r0) * rnd(); return { x: Math.sin(a) * r, z: Math.cos(a) * r, s: HEADS.s0 + (HEADS.s1 - HEADS.s0) * rnd(), yaw: a + Math.PI }; });
    giant = new THREE.Group();
    for (const p of model.parts) { const m = new THREE.Mesh(p.head, skinMat(p.material, new THREE.Color(1, 1, 1))); mats.push(m.material); giant.add(m); }
    giant.scale.setScalar(GIANT.scale); giant.position.set(0, -model.height * GIANT.scale * (1 - GIANT.sink) * .8, GIANT.z);
    group.add(...crowd, ...heads, giant);
  }
  loadModel().then(m => { model = m; build(); });

  const t = timeOfDay(DEFAULT_HOUR, SUN);
  return {
    group, uniforms, sun: SUN.clone(), hour: DEFAULT_HOUR, final: true, t,
    setTime() { return 0; }, // always the same bright afternoon: the joke is not in the dark
    fit(r) { if (r !== R || !seats.length) { R = r; place(); built = false; build(); } },
    /** A KO: the whole crowd spins round once and leaps. */
    react() { reactAt = time; },
    /** points: world positions the giant head keeps its face on (the players' chests); their middle is looked at. */
    watch(points) { const ps = points.filter(Boolean); if (!ps.length) return; watchAt.set(0, 0, 0); for (const p of ps) watchAt.add(p); watchAt.divideScalar(ps.length); },
    update(dt) {
      time += dt; uniforms.uTime.value = time;
      if (!built) return;
      const beat = time * CROWD.beat, hop = CROWD.hop * Math.abs(Math.sin(Math.PI * beat)), sway = CROWD.sway * Math.sin(Math.PI * beat);
      const rt = time - reactAt, spin = rt < .9 ? 2 * Math.PI * (1 - Math.pow(1 - rt / .9, 3)) : 0, leap = rt < .9 ? 1.2 * Math.sin(Math.PI * rt / .9) : 0;
      seats.forEach((s, i) => {
        q.setFromAxisAngle(Y, s.yaw + sway + spin); m4.compose(p3.set(s.x, hop + leap, s.z), q, s3.set(1, 1, 1));
        for (const m of crowd) m.setMatrixAt(i, m4);
      });
      for (const m of crowd) { m.count = seats.length; m.instanceMatrix.needsUpdate = true; }
      const nod = .18 * Math.sin(Math.PI * beat * .5);
      heads.spots.forEach((h, i) => {
        q.setFromEuler(new THREE.Euler(nod, h.yaw, 0, 'YXZ')); m4.compose(p3.set(h.x, -model.height * h.s * .82, h.z), q, s3.setScalar(h.s));
        for (const m of heads) m.setMatrixAt(i, m4);
      });
      for (const m of heads) m.instanceMatrix.needsUpdate = true;
      // the giant: its face turned on the players, smoothly (a slow, heavy head)
      lookNow.lerp(watchAt, 1 - Math.exp(-dt * 3));
      const d = p3.copy(lookNow).sub(giant.position); giant.rotation.set(.12, Math.atan2(d.x, d.z), 0, 'YXZ'); // a little down, on the arena
      giant.scale.setScalar(GIANT.scale * (1 + .015 * Math.sin(time * 1.3))); // breathing
    },
    dispose() {
      for (const m of [sky, ground]) { m.geometry.dispose(); m.material.dispose(); }
      for (const m of mats) m.dispose(); // the baked geometry stays loaded for the next time
    },
  };
}
