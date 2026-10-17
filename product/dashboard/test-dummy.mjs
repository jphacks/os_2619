import assert from 'node:assert/strict';
import { createDummyMotion } from './public/dummy-motion.js';
import { createSim } from './fake-world.mjs';
import { toThreeCamera } from './public/extrinsics.js';
import * as W from './public/world.js';
const room = { start: { A: [-1.2,0,0], B: [1.2,0,0] }, zAmp: .45 };
let ms = 0;
const motion = createDummyMotion(room, () => ms);
const a = motion.sample(2), b = motion.sample(3);
assert.notDeepEqual(a.players.A.chest,b.players.A.chest);
assert.notDeepEqual(a.players.B.tip,b.players.B.tip);
assert.equal(a.players.A.source,'synthetic');
assert.ok(Object.isFrozen(a.players.A.tip)); // neither game nor later frames can alter the displayed snapshot

const sim = createSim({ seed: 17 }); sim.step();
const truth = sim.truth('A');
motion.setTruth('A',truth);
const receivedTip = [...truth.tip]; truth.tip[0] += 100;
const exact = motion.sample(4);
assert.deepEqual(exact.players.A.tip,receivedTip); // exact wand endpoint from the fake input, no length estimate
assert.equal(exact.players.A.source,'fake-world');
assert.equal(exact.players.B.source,'synthetic'); // phones can independently drop out
ms = 1001;
const fallback = motion.sample(5);
assert.equal(fallback.players.A.source,'synthetic');
assert.deepEqual(exact.players.A.tip,receivedTip); // switching source does not rewrite earlier frames
for(const p of Object.values(fallback.players)){
  assert.ok([...p.chest,...p.base,...p.tip,...p.dir].every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...p.tip.map((v,i)=>v-p.base[i]))-W.STICK.len)<1e-9);
}
console.log('dummy shared poses / fake input / fallback ok');

// Dummy truePose is flat {R,t,fovY}; a real scan is {pose:{R,t},fovY}.
// Both must work, otherwise the final render stops before any effect can be drawn.
const camera = () => ({ position: { set(...v) { this.xyz=v; } }, quaternion: {
  set(...q) { this.xyzw=q; return this; }, normalize() { return this; } },
  updateProjectionMatrix() {}, updateMatrixWorld() {} });
const pose={R:[1,0,0,0,1,0,0,0,1],t:[.2,1.7,3.5],fovY:55};
const raw=camera(), scanned=camera();
toThreeCamera(pose,raw);toThreeCamera({pose,fovY:55},scanned);
assert.deepEqual(raw.position.xyz,pose.t);
assert.deepEqual(raw.position.xyz,scanned.position.xyz);
assert.deepEqual(raw.quaternion.xyzw,scanned.quaternion.xyzw);
assert.equal(raw.fov,55);
console.log('dummy / scan camera formats ok');

// map4 scan from behind the centre square (-z): the floor model + fixed frame put phone C where it is, not mirrored
{
  const FM = await import('./public/fieldmap.js'), pos = [.3, 1.7, -3.5], f = 540 / Math.tan(25 * Math.PI / 180);
  const z = (n => n.map(v => v / Math.hypot(...n)))(pos.map(v => -v)), x = (n => n.map(v => v / Math.hypot(...n)))([-z[2], 0, z[0]]);
  const cam = W.pose(W.fromCols(x, [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]], z), pos), inv = W.invert(cam);
  const dets = [0, 1, 2, 3].map(id => { const T = W.worldTagPose(id), h = W.TAGS[id].size / 2;
    return { id, corners: [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => { const c = W.apply(inv, W.apply(T, [a * h, b * h, 0])); return [f * c[0] / c[2] + 960, f * c[1] / c[2] + 540]; }) }; });
  const m = FM.solveFieldMap(dets, 1920, 1080, { fovY: 50, mount: 'floor' }), fit = W.toFixedFrame(m.tags, m.cam.pose);
  assert.ok(fit.pose.t.every((v, i) => Math.abs(v - pos[i]) < .05), `scan put phone C at ${fit.pose.t}`);
  console.log('map4 scan from behind ok');
}
