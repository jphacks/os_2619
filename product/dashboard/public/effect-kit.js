// Shared drawing kit for fire-effects.js / thunder-effects.js / charge-effects.js.
// Everything is rewritten every frame from (event age, fixed seed), so pausing / stepping reproduces the same picture.
//  sprite(): camera-facing textured quads at 3D points (optionally rotated along a 3D axis)
//  ribbon(): camera-facing soft strips between two 3D points (bolts, streaks, light pillars)
//  mesh():   pooled meshes with the caller's own shader (fireballs, spheres)
// All output is premultiplied: rgb = colour × coverage, alpha = coverage × occ (how much of the video it hides).
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const clamp = v => Math.max(0, Math.min(1, v));
export const rand = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
/** 1 until `end - tail`, then linearly to 0 at `end`. */
export const fade = (t, end, tail = .3) => clamp((end - t) / tail);
/** 0 → 1 over [a, b], smoothstep. */
export const rise = (t, a, b) => { const x = clamp((t - a) / (b - a)); return x * x * (3 - 2 * x); };
export const easeOut = (t, k = 10) => 1 - Math.exp(-k * Math.max(0, t));
export const blend = { transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };

/** Colour treatments of a sprite's grey texture (grey = brightness / heat). */
export const RAMP = { tint: 0, fire: 1, crimson: 2, texture: 3, smoke: 4, flat: 5 };

const SPRITE_VS = `
attribute vec4 iA, iB, iC, iD, iE;
varying vec2 vUv; varying vec4 vData; varying vec3 vColor; varying vec4 vExtra;
void main(){
  vec4 p = modelViewMatrix * vec4(iA.xyz, 1.); vec2 c = position.xy; float a = iB.y;
  if (iD.w > .5) { vec2 d = (modelViewMatrix * vec4(iD.xyz, 0.)).xy; if (length(d) > .0001) a += atan(d.y, d.x) - 1.5707963; }
  c = mat2(cos(a), sin(a), -sin(a), cos(a)) * (c * vec2(iA.w, iB.x)); p.xy += c; gl_Position = projectionMatrix * p;
  vUv = position.xy + .5; if (iE.w > .5) vUv.x = 1. - vUv.x;
  vData = vec4(iB.z, iB.w, iC.w, 0.); vColor = iC.rgb; vExtra = iE;
}`;
const SPRITE_FS = n => `
${Array.from({ length: n }, (_, i) => `uniform sampler2D t${i};`).join('')}
varying vec2 vUv; varying vec4 vData; varying vec3 vColor; varying vec4 vExtra;
vec4 tex(float i){ ${Array.from({ length: n }, (_, i) => `${i ? 'else ' : ''}if (i < ${i}.5) return texture2D(t${i}, vUv);`).join(' ')} return vec4(0.); }
vec3 fireRamp(float h){ vec3 c = mix(vec3(.55,.03,.004), vec3(1.,.26,.01), smoothstep(.05,.4,h));
  c = mix(c, vec3(1.,.66,.07), smoothstep(.35,.68,h)); return mix(c, vec3(1.,.96,.78), smoothstep(.7,.97,h)); }
vec3 crimsonRamp(float h){ vec3 c = mix(vec3(.38,.0,.03), vec3(1.,.03,.05), smoothstep(.05,.4,h));
  c = mix(c, vec3(1.,.42,.06), smoothstep(.42,.72,h)); c = mix(c, vec3(1.,.85,.3), smoothstep(.7,.88,h)); return mix(c, vec3(1.,.98,.88), smoothstep(.88,1.,h)); }
void main(){
  vec4 s = tex(vData.x); float a = s.a * vData.y; if (a < .006) discard;
  float ramp = vExtra.x, heat = vExtra.z; vec3 c;
  if (ramp < .5) c = vColor * (.35 + 1.15 * s.r);
  else if (ramp < 1.5) c = fireRamp(clamp((s.r * .7 + s.a * .3) * heat, 0., 1.)) * vColor;
  else if (ramp < 2.5) c = crimsonRamp(clamp((s.r * .7 + s.a * .3) * heat, 0., 1.)) * vColor;
  else if (ramp < 3.5) c = s.rgb * vColor;
  else if (ramp < 4.5) c = vColor * (.6 + .4 * s.r);
  else c = vColor;
  gl_FragColor = vec4(c * a * vData.z, a * vExtra.y);
}`;
// Ribbon: position.x 0..1 along a→b, position.y -1..1 across. Width is in world metres, expanded in view space.
const RIBBON_VS = `
attribute vec4 iA, iB, iC, iD;
varying float vX, vY; varying vec4 vC; varying vec4 vD;
void main(){
  vec4 a = modelViewMatrix * vec4(iA.xyz, 1.), b = modelViewMatrix * vec4(iB.xyz, 1.);
  vec2 d = b.xy - a.xy; float l = length(d); d = l > 1e-5 ? d / l : vec2(1., 0.); vec2 n = vec2(-d.y, d.x);
  float w = mix(iA.w, iB.w, position.x);
  vec4 p = mix(a, b, position.x); p.xy += n * position.y * w + d * (position.x * 2. - 1.) * w * .5;
  gl_Position = projectionMatrix * p; vX = position.x; vY = position.y; vC = iC; vD = iD;
}`;
const RIBBON_FS = `
varying float vX, vY; varying vec4 vC; varying vec4 vD;
void main(){
  float d = abs(vY), core = vD.z > 0. ? 1. - smoothstep(vD.z * .55, vD.z, d) : 0., halo = pow(max(0., 1. - d), 2.2);
  float ends = vD.w > 0. ? smoothstep(0., vD.w, vX) * smoothstep(0., vD.w, 1. - vX) : 1.;
  float a = max(core, halo * .75) * vD.x * ends; if (a < .004) discard;
  vec3 c = mix(vC.rgb, vec3(1., 1., .92), core * .85) * vC.w;
  gl_FragColor = vec4(c * a, a * vD.y);
}`;

/**
 * textures: [[key, file, isColour]] loaded from ./assets/<folder>/. Returns the kit; call begin() at the start of a frame,
 * draw, then end().
 */
export function createKit(group, folder, files, { cap = 4096, ribbons = 2048, label = folder } = {}) {
  const loader = new THREE.TextureLoader(), textures = [], loaded = [], errors = [], index = {};
  files.forEach(([key, file, colour], i) => {
    const t = loader.load(new URL(`./assets/${folder}/${file}`, import.meta.url).href, () => loaded.push(file), undefined,
      () => { errors.push(file); console.error(`${label} texture could not be loaded:`, file); });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    textures.push(t); index[key] = i;
  });
  const uniforms = Object.fromEntries(textures.map((t, i) => ['t' + i, { value: t }]));

  function batch(cap, stride, names, corners, vs, fs, u = {}) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * stride), stride).setUsage(THREE.DynamicDrawUsage);
    names.forEach((n, i) => g.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, i * 4)));
    g.instanceCount = 0;
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ ...blend, vertexShader: vs, fragmentShader: fs, uniforms: u }));
    m.frustumCulled = false; group.add(m);
    return { g, buf, a: buf.array, m, n: 0, cap, stride };
  }
  const SPR = batch(cap, 20, ['iA', 'iB', 'iC', 'iD', 'iE'], [-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], SPRITE_VS, SPRITE_FS(textures.length), uniforms);
  const RIB = batch(ribbons, 16, ['iA', 'iB', 'iC', 'iD'], [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], RIBBON_VS, RIBBON_FS);
  SPR.m.renderOrder = 5; RIB.m.renderOrder = 6;
  const pools = {}, used = {};
  const dir = V(), mid = V();

  const kit = {
    TEX: index, loaded, errors, total: files.length,
    texture: key => textures[index[key]],
    /**
     * Camera-facing quad. o: { opacity, intensity, color, rot, axis (Vector3: quad's +y follows it on screen), ramp, occ, heat, flip }
     */
    sprite(tex, p, w, h, o = {}) {
      const opacity = o.opacity ?? 1; if (SPR.n >= SPR.cap || opacity <= .002 || w <= 0 || h <= 0) return;
      const a = SPR.a, k = SPR.n++ * 20, c = o.color ?? [1, 1, 1], ax = o.axis;
      a[k] = p.x; a[k + 1] = p.y; a[k + 2] = p.z; a[k + 3] = w;
      a[k + 4] = h; a[k + 5] = o.rot ?? 0; a[k + 6] = typeof tex === 'number' ? tex : index[tex]; a[k + 7] = opacity;
      a[k + 8] = c[0]; a[k + 9] = c[1]; a[k + 10] = c[2]; a[k + 11] = o.intensity ?? 1;
      a[k + 12] = ax?.x ?? 0; a[k + 13] = ax?.y ?? 0; a[k + 14] = ax?.z ?? 0; a[k + 15] = ax ? 1 : 0;
      a[k + 16] = o.ramp ?? RAMP.tint; a[k + 17] = o.occ ?? .15; a[k + 18] = o.heat ?? 1; a[k + 19] = o.flip ? 1 : 0;
    },
    /** Soft strip a→b. o: { color, intensity, opacity, occ, core (0..1 width of the white core), ends (fade length 0...5) } */
    ribbon(p, q, wa, wb, o = {}) {
      const opacity = o.opacity ?? 1; if (RIB.n >= RIB.cap || opacity <= .002) return;
      const a = RIB.a, k = RIB.n++ * 16, c = o.color ?? [1, .85, .2];
      a[k] = p.x; a[k + 1] = p.y; a[k + 2] = p.z; a[k + 3] = wa;
      a[k + 4] = q.x; a[k + 5] = q.y; a[k + 6] = q.z; a[k + 7] = wb;
      a[k + 8] = c[0]; a[k + 9] = c[1]; a[k + 10] = c[2]; a[k + 11] = o.intensity ?? 1;
      a[k + 12] = opacity; a[k + 13] = o.occ ?? .12; a[k + 14] = o.core ?? .3; a[k + 15] = o.ends ?? 0;
    },
    /** Polyline through pts with widths tapering from w0 to w1. */
    strip(pts, w0, w1, o = {}) { for (let i = 1; i < pts.length; i++) kit.ribbon(pts[i - 1], pts[i], w0 + (w1 - w0) * (i - 1) / (pts.length - 1), w0 + (w1 - w0) * i / (pts.length - 1), o); },
    /** Jagged lightning a→b: count points displaced perpendicular to the line, seeded. Returns the points. */
    bolt(a, b, seed, { jag = .2, count = 9, w = .03, w1 = null, branches = 0, branchLen = .3, ...o } = {}) {
      dir.copy(b).sub(a); const len = dir.length(); if (len < 1e-4) return [];
      dir.normalize(); const side = V().crossVectors(dir, Math.abs(dir.y) > .9 ? V(1, 0, 0) : V(0, 1, 0)).normalize(), up = V().crossVectors(side, dir);
      const pts = [];
      for (let i = 0; i < count; i++) {
        const u = i / (count - 1), env = Math.sin(Math.PI * u) ** .7, p = a.clone().lerp(b, u);
        if (i && i < count - 1) p.addScaledVector(side, (rand(seed + i * 7.3) - .5) * jag * len * env).addScaledVector(up, (rand(seed + i * 11.9 + 2) - .5) * jag * len * env);
        pts.push(p);
      }
      kit.strip(pts, w, w1 ?? w * .6, o);
      for (let i = 1; i < count - 1; i++) if (rand(seed + i * 19.7) < branches) {
        const ang = rand(seed + i * 23.1) * TAU, bl = len * branchLen * (.5 + rand(seed + i * 29.3) * .7);
        mid.copy(dir).multiplyScalar(bl * .5).addScaledVector(side, Math.cos(ang) * bl).addScaledVector(up, Math.sin(ang) * bl).add(pts[i]);
        kit.bolt(pts[i], mid.clone(), seed + i * 131, { jag: jag * 1.1, count: 5, w: w * .55, w1: w * .15, branches: 0, ...o, opacity: (o.opacity ?? 1) * .85 });
      }
      return pts;
    },
    /** A pooled mesh; make() builds it the first time. Reset to visible, position p, scale s, no rotation. */
    mesh(kind, make, p, s = 1) {
      pools[kind] ??= []; const i = used[kind] ?? 0; used[kind] = i + 1;
      let m = pools[kind][i]; if (!m) { m = make(); m.frustumCulled = false; group.add(m); pools[kind].push(m); }
      m.visible = true; m.position.copy(p); if (Array.isArray(s)) m.scale.set(...s); else m.scale.setScalar(s); m.rotation.set(0, 0, 0); m.quaternion.identity();
      return m;
    },
    begin() { SPR.n = 0; RIB.n = 0; for (const k of Object.keys(used)) used[k] = 0; for (const p of Object.values(pools)) for (const m of p) m.visible = false; },
    end() {
      for (const b of [SPR, RIB]) { b.g.instanceCount = b.n; b.buf.clearUpdateRanges(); if (b.n) { b.buf.addUpdateRange(0, b.n * b.stride); b.buf.needsUpdate = true; } }
      group.visible = SPR.n > 0 || RIB.n > 0 || Object.values(used).some(x => x > 0);
    },
    get count() { return SPR.n + RIB.n; },
    dispose() {
      for (const b of [SPR, RIB]) { b.g.dispose(); b.m.material.dispose(); }
      textures.forEach(t => t.dispose());
      for (const p of Object.values(pools)) for (const m of p) { m.geometry.dispose?.(); m.material.dispose(); }
    },
  };
  return kit;
}
