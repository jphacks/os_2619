// The avatar in skeleton mode: stub the DOM canvas, build the field, feed a pose, and check the limbs end where the person's do.
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'three' ? { url: ${JSON.stringify(new URL('./vendor/cdn/npm/three@0.160.0/build/three.module.js', import.meta.url).href)}, shortCircuit: true } : n(s, c); }`));
const ctx = new Proxy(function () {}, { get: (t, k) => k === 'canvas' ? {} : k === 'width' ? 10 : k === 'measureText' ? () => ({ width: 10 }) : ctx, apply: () => ctx, set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
globalThis.window = globalThis; globalThis.location = { search: '' };
const THREE = await import('three'), { createField, POSE } = await import('./public/field3d.js'), W = await import('./public/world.js');
POSE.show = true; // the pose code is tested even while the dashboard has it switched off
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
// the camera pose shapes the body but never places it: the stick hand is at the sensors' stick base (not the camera's wrist)
assert.ok(wp.distanceTo(player.base) < .05, 'stick hand on the sensors\' stick base: ' + wp.toArray().map(v => v.toFixed(2)));
const where = () => { scene.updateMatrixWorld(true); return new THREE.Vector3().setFromMatrixPosition(avatar.matrixWorld); };
const at0 = where();
assert.ok(Math.hypot(at0.x, at0.z) < .25, 'the avatar stands where the sensors say (0, 0), not where the camera saw the person (1, 0.5)');
for (const j of joints) { j[0] += 2; j[2] -= 1; } // the camera sees the person 2 m off: the avatar does not move
for (let i = 0; i < 30; i++) field.update(.016, { A: player });
assert.ok(where().distanceTo(at0) < .01, 'a camera-pose shift does not move the avatar');
player.body = W.bodyPose([1, 1.3, -1], 0, 1.3); player.base.add(new THREE.Vector3(1, 0, -1)); player.tip.add(new THREE.Vector3(1, 0, -1));
for (let i = 0; i < 4; i++) field.update(.016, { A: player });
const at1 = where();
assert.ok(Math.abs(at1.x - at0.x - 1) < .01 && Math.abs(at1.z - at0.z + 1) < .01, 'the sensors move it');
// no skeleton: back to the avatar's own pose without throwing
player.skel = null; field.update(.016, { A: player });
console.log('avatar ok: placed by the sensors only (the camera pose never moves it), stick hand on the stick, falls back without a pose');
