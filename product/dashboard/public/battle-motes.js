// Battle motes: during a fight, the whole field breathes fire and magic — embers welling up from the ground, short flickers of flame,
// and slow drifting sparks of magic light — drawn over the arena (field3d.js) on the game screen. One THREE.Points; every mote's place
// is a function of the time (no per-frame work on the CPU), additive and depth-tested so the players stand in front of them.
// createBattleMotes(extent): { points, update(dt, on) } — extent { minX, maxX, minZ, maxZ } (field3d.js fieldExtent), spread 1 m past it;
// on: a fight is running (the motes fade in over ~1 s, and out again after).
import * as THREE from 'three';

const KINDS = [ // count, life (s), size (m)
  { n: 420, life: 2.4, size: .045 }, // ember: small, rises fast, flickers
  { n: 140, life: 1.1, size: .13 },  // flame: a short-lived lick of fire close to the ground
  { n: 160, life: 5.5, size: .08 },  // magic: blue / violet / teal, floats and wanders
];

const VS = `
attribute vec4 aSeed; attribute float aKind;
uniform float uTime, uLevel, uScale;
varying vec3 vCol; varying float vA;
float hash(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
void main() {
  float life = aKind < .5 ? ${KINDS[0].life.toFixed(2)} : aKind < 1.5 ? ${KINDS[1].life.toFixed(2)} : ${KINDS[2].life.toFixed(2)};
  float size = aKind < .5 ? ${KINDS[0].size.toFixed(3)} : aKind < 1.5 ? ${KINDS[1].size.toFixed(3)} : ${KINDS[2].size.toFixed(3)};
  float t = uTime + aSeed.z * life, cyc = floor(t / life), f = fract(t / life), r = hash(aSeed.w + cyc * 1.618);
  vec3 p = vec3(aSeed.x + (r - .5) * 1.6, 0., aSeed.y + (hash(r + 3.1) - .5) * 1.6); // a new spot each time it comes round
  float a = sin(3.14159 * f);
  if (aKind < .5) {        // ember: wells up from the ground, wavering, and flickers
    p.y = f * f * 2.4 + f * .6; p.x += .18 * sin(t * 2.3 + r * 9.); p.z += .18 * cos(t * 1.9 + r * 7.);
    a *= .55 + .45 * sin(t * 23. + r * 40.);
    vCol = mix(vec3(1., .32, .05), vec3(1., .78, .3), r);
  } else if (aKind < 1.5) { // flame: a quick lick of fire off the floor
    p.y = .05 + f * .55; size *= 1. - .6 * f;
    vCol = mix(vec3(1., .45, .08), vec3(1., .85, .45), 1. - f);
    a *= .8;
  } else {                 // magic: floats in the air, wandering slowly
    p.y = .25 + 1.6 * hash(r + 7.7) + .25 * sin(t * .9 + r * 6.);
    p.x += .35 * sin(t * .6 + r * 11.); p.z += .35 * cos(t * .5 + r * 13.);
    a *= .65 + .35 * sin(t * 4. + r * 20.);
    vCol = r < .34 ? vec3(.35, .55, 1.) : r < .67 ? vec3(.72, .4, 1.) : vec3(.3, 1., .85);
  }
  vA = min(1., a * uLevel * 1.8); // bright enough to glow (the CRT pass makes the brightest bloom)
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = vA > .003 ? size * uScale / max(.1, -mv.z) : 0.;
}`;
const FS = `
varying vec3 vCol; varying float vA;
void main() {
  float d = length(gl_PointCoord - .5) * 2.;
  float g = pow(max(0., 1. - d), 2.) * vA; // a soft glowing dot, hottest in the middle
  gl_FragColor = vec4(mix(vCol, vec3(1.), pow(max(0., 1. - d), 6.) * .6) * g, g);
}`;

export function createBattleMotes(extent) {
  const total = KINDS.reduce((s, k) => s + k.n, 0), seed = new Float32Array(total * 4), kind = new Float32Array(total), pos = new Float32Array(total * 3);
  let i = 0, s = 1;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  KINDS.forEach((k, ki) => {
    for (let j = 0; j < k.n; j++, i++) {
      seed.set([extent.minX - 1 + rnd() * (extent.maxX - extent.minX + 2), extent.minZ - 1 + rnd() * (extent.maxZ - extent.minZ + 2), rnd(), rnd() * 100], i * 4);
      kind[i] = ki;
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); // unused by the shader (places come from aSeed and the time)
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  const uniforms = { uTime: { value: 0 }, uLevel: { value: 0 }, uScale: { value: 500 } };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; points.renderOrder = 5; points.visible = false;
  const size = new THREE.Vector2();
  points.onBeforeRender = (renderer, scene, camera) => { // pixels per metre at 1 m: the drawing buffer's height over the view's height
    renderer.getDrawingBufferSize(size);
    uniforms.uScale.value = size.y / (2 * Math.tan((camera.fov ?? 50) * Math.PI / 360)) * (camera.zoom ?? 1);
  };
  return {
    points,
    update(dt, on) {
      uniforms.uTime.value += dt;
      const L = uniforms.uLevel.value + (on ? 1 : -1) * Math.min(dt, .1) * (on ? 1 : .7); // in over 1 s, out over 1.4 s
      uniforms.uLevel.value = Math.max(0, Math.min(1, L));
      points.visible = uniforms.uLevel.value > .001;
    },
    /** still showing (fading out counts) */
    get shown() { return uniforms.uLevel.value > .001; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
