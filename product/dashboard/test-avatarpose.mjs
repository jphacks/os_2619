// personTo3D: a person seen by a camera 3 m back and 1.7 m up, looking at them (pitched down): the feet must land on the floor
// where the camera sees them, and the body must be upright whatever the camera's pitch.
import assert from 'node:assert/strict';
import { personTo3D, J } from './public/avatarpose.js';

const pitch = 16 * Math.PI / 180, aspect = 16 / 9, fovY = 45;
// camera at (0, 1.7, 3.5) looking along -z, pitched down; matrixWorld column-major: right, up, back, position
const c = Math.cos(pitch), s = Math.sin(pitch);
const e = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 1.7, 3.5, 1];
const cam = { e, fovY };
// person standing at world (0.4, 0, 0), arm raised on the right side: build world landmarks (camera-aligned axes) and project the hip
const stand = { x: .4, z: 0 }, hipH = .95;
const world = new Float32Array(33 * 4).fill(0);
const set = (i, x, y, z) => { world.set([x, y, z, 1], 4 * i); };
for (let i = 0; i < 33; i++) set(i, 0, -.3, 0);
set(J.lHip, .1, 0, 0); set(J.rHip, -.1, 0, 0); set(J.lAnk, .1, hipH, 0); set(J.rAnk, -.1, hipH, 0);
set(J.lHeel, .1, hipH, 0); set(J.rHeel, -.1, hipH, 0); set(J.lToe, .1, hipH, -.1); set(J.rToe, -.1, hipH, -.1);
set(J.lSh, .2, -.5, 0); set(J.rSh, -.2, -.5, 0); set(J.rWr, -.2, -.9, 0);
// the hip centre's picture position from the true world point (stand.x, hipH, stand.z)
const p = [stand.x - e[12], hipH - e[13], stand.z - e[14]];
const camX = p[0] * 1 + p[1] * 0 + p[2] * 0, camY = p[0] * 0 + p[1] * c + p[2] * s, camZ = -(p[0] * 0 + p[1] * -s + p[2] * c); // along the view
const th = Math.tan(fovY * Math.PI / 360), u = (camX / camZ / (th * aspect) + 1) / 2, v = (1 - camY / camZ / th) / 2;
const pts = Array.from({ length: 33 }, () => [u, v, 1]);
const r = personTo3D({ world, pts }, cam, aspect);
assert.ok(r, 'a person in view is found');
const h = i => r.joints[i];
assert.ok(Math.abs((h(J.lHip)[0] + h(J.rHip)[0]) / 2 - stand.x) < .01 && Math.abs((h(J.lHip)[2] + h(J.rHip)[2]) / 2 - stand.z) < .01, 'hip lands where it stands: ' + h(J.lHip));
assert.ok(Math.abs(r.hipH - hipH) < .01, 'hip height from the feet');
assert.ok(Math.abs(h(J.lAnk)[1]) < .01 && Math.abs(h(J.rToe)[1]) < .01, 'feet on the floor');
assert.ok(Math.abs(h(J.rWr)[1] - (hipH + .9)) < .01, 'a raised wrist is above the hip by the same amount');
assert.ok(h(J.lHip)[0] > h(J.rHip)[0], 'camera-right stays world +x');
assert.ok(h(J.lToe)[2] > h(J.lAnk)[2] + .05, 'a toe pointing at the camera (z smaller) is nearer the camera (world +z)');
assert.equal(personTo3D({ world, pts }, { e: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 3, 0, 1], fovY }, aspect), null, 'camera straight down: no heading');
console.log('avatarpose ok: floor position, upright body, handedness');
