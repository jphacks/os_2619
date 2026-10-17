// The wireframe figure: load Xbot.glb in node, pose avatar A from a skeleton, and check the figure's wrist / ankle bones land
// on the same side and near the person's (the model keeps its own bone lengths, so only roughly).
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const three = new URL('./vendor/cdn/npm/three@0.160.0/', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) {
  if (s === 'three') return { url: ${JSON.stringify(three + 'build/three.module.js')}, shortCircuit: true };
  if (s.startsWith('three/addons/')) return { url: ${JSON.stringify(three + 'examples/jsm/')} + s.slice(13), shortCircuit: true };
  return n(s, c); }`));
const ctx = new Proxy(function () {}, { get: (t, k) => k === 'canvas' ? {} : k === 'width' ? 10 : k === 'measureText' ? () => ({ width: 10 }) : ctx, apply: () => ctx, set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
globalThis.window = globalThis; globalThis.location = { search: '' };
const glb = readFileSync(new URL('./public/assets/models/Xbot.glb', import.meta.url));
globalThis.fetch = async () => new Response(glb); // GLTFLoader reads the model through fetch
globalThis.ProgressEvent = class extends Event { constructor(t, o) { super(t); Object.assign(this, o); } };
const THREE = await import('three'), { createField } = await import('./public/field3d.js'), W = await import('./public/world.js');
const scene = new THREE.Scene(), field = createField(scene);
const joints = Array.from({ length: 33 }, () => [0, 1, 0]), vis = Array(33).fill(1);
const put = (i, x, y, z) => { joints[i] = [x, y, z]; };
const O = [1, 0, .5]; // facing +x, the right side towards +z; right arm straight forward, left arm down
put(0, O[0] + .08, 1.62, O[2]); put(7, O[0], 1.62, O[2] - .08); put(8, O[0], 1.62, O[2] + .08);
put(11, O[0], 1.45, O[2] - .2); put(12, O[0], 1.45, O[2] + .2); put(13, O[0], 1.2, O[2] - .22); put(14, O[0] + .25, 1.45, O[2] + .2);
put(15, O[0], .95, O[2] - .22); put(16, O[0] + .5, 1.45, O[2] + .2);
put(23, O[0], .95, O[2] - .1); put(24, O[0], .95, O[2] + .1); put(25, O[0], .5, O[2] - .1); put(26, O[0] + .3, .7, O[2] + .1);
put(27, O[0], .08, O[2] - .1); put(28, O[0] + .3, .2, O[2] + .1); put(29, O[0] - .05, 0, O[2] - .1); put(30, O[0] + .25, .15, O[2] + .1); put(31, O[0] + .15, 0, O[2] - .1); put(32, O[0] + .45, .15, O[2] + .1);
const player = { body: W.bodyPose([0, 1.3, 0], 0, 1.3), base: new THREE.Vector3(.3, 1.4, .2), tip: new THREE.Vector3(1.3, 1.4, .2), hp: 100, online: true, skel: { joints, vis } };
for (let i = 0; i < 50 && !scene.getObjectByProperty('isSkinnedMesh', true); i++) await new Promise(r => setTimeout(r, 20));
assert.ok(scene.getObjectByProperty('isSkinnedMesh', true), 'the figure is loaded');
for (let i = 0; i < 4; i++) field.update(.016, { A: player });
scene.updateMatrixWorld(true);
const at = n => scene.getObjectByName('mixamorig' + n).getWorldPosition(new THREE.Vector3());
const rh = at('RightHand'), lh = at('LeftHand'), rf = at('RightFoot'), lf = at('LeftFoot'), hd = at('Head');
const show = v => v.toArray().map(x => x.toFixed(2)).join(',');
console.log('right hand', show(rh), 'left hand', show(lh), 'right foot', show(rf), 'left foot', show(lf), 'head', show(hd));
assert.ok(rh.z > O[2] && lh.z < O[2], 'hands on their own sides');
assert.ok(rh.x > O[0] + .35 && Math.abs(rh.y - 1.45) < .15, 'right arm points forward');
assert.ok(lh.y < 1.1 && Math.abs(lh.x - O[0]) < .15, 'left arm hangs down');
assert.ok(rf.x > lf.x + .15 && rf.y > lf.y + .05, 'right knee raised forward');
assert.ok(hd.y > 1.4 && hd.y < 1.8, 'head above the shoulders');
player.skel = null; field.update(.016, { A: player }); // the sensors-only pose drives it too
console.log('figure ok: limbs follow the skeleton, sides right, falls back without a pose');
