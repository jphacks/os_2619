// The avatar in skeleton mode: stub the DOM canvas, build the field, feed a pose, and check the limbs end where the person's do.
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'three' ? { url: ${JSON.stringify(new URL('./vendor/cdn/npm/three@0.160.0/build/three.module.js', import.meta.url).href)}, shortCircuit: true } : n(s, c); }`));
const ctx = new Proxy(function () {}, { get: (t, k) => k === 'canvas' ? {} : k === 'width' ? 10 : k === 'measureText' ? () => ({ width: 10 }) : ctx, apply: () => ctx, set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
globalThis.window = globalThis; globalThis.location = { search: '' };
const THREE = await import('three'), { createField } = await import('./public/field3d.js'), W = await import('./public/world.js');
const scene = new THREE.Scene(), field = createField(scene);
const joints = Array.from({ length: 33 }, () => [0, 1, 0]), vis = Array(33).fill(1);
const put = (i, x, y, z) => { joints[i] = [x, y, z]; };
// facing +x at (1, 0, 0.5): up the spine, the right side towards +z
const O = [1, 0, .5];
put(0, O[0] + .08, 1.62, O[2]); put(7, O[0], 1.62, O[2] - .08); put(8, O[0], 1.62, O[2] + .08);
put(11, O[0], 1.45, O[2] - .2); put(12, O[0], 1.45, O[2] + .2); put(13, O[0], 1.2, O[2] - .22); put(14, O[0] + .25, 1.45, O[2] + .2);
put(15, O[0], .95, O[2] - .22); put(16, O[0] + .5, 1.45, O[2] + .2);
put(23, O[0], .95, O[2] - .1); put(24, O[0], .95, O[2] + .1); put(25, O[0], .5, O[2] - .1); put(26, O[0], .5, O[2] + .1);
put(27, O[0], .08, O[2] - .1); put(28, O[0], .08, O[2] + .1); put(29, O[0] - .05, 0, O[2] - .1); put(30, O[0] - .05, 0, O[2] + .1); put(31, O[0] + .15, 0, O[2] - .1); put(32, O[0] + .15, 0, O[2] + .1);
const player = { body: W.bodyPose([0, 1.3, 0], 0, 1.3), base: new THREE.Vector3(.3, 1.4, .2), tip: new THREE.Vector3(1.3, 1.4, .2), hp: 100, online: true, skel: { joints, vis } };
for (let i = 0; i < 4; i++) field.update(.016, { A: player });
scene.updateMatrixWorld(true);
const avatar = scene.children.find(o => o.isGroup).children.filter(o => o.matrixAutoUpdate === false)[0]; // avatar A's root
const hand = avatar.children.find(o => o.isMesh && o.geometry.type === 'IcosahedronGeometry' && Math.abs(o.scale.x - .05) < 1e-6 && o.material.color.getHex() === 0x252a36 && o.position.z > 0);
const wp = new THREE.Vector3(); hand.getWorldPosition(wp);
assert.ok(Math.hypot(wp.x - (O[0] + .5), wp.y - 1.45 - 0, wp.z - (O[2] + .2)) < .12, 'stick hand reaches the raised right wrist: ' + wp.toArray().map(v => v.toFixed(2)));
// no skeleton: back to the avatar's own pose without throwing
player.skel = null; field.update(.016, { A: player });
console.log('avatar ok: right hand on the right wrist, falls back without a pose');
