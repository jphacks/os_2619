import assert from 'node:assert/strict';
import { createDummyMotion } from './public/dummy-motion.js';
import { createSim } from './fake-world.mjs';
import { toThreeCamera } from './public/extrinsics.js';
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
  assert.ok(Math.abs(Math.hypot(...p.tip.map((v,i)=>v-p.base[i]))-.8)<1e-9);
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
