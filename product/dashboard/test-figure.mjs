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
const glb = n => readFileSync(new URL('./public/assets/models/' + n, import.meta.url));
globalThis.fetch = async u => new Response(glb(String(u.url ?? u).split('/').pop())); // GLTFLoader reads the models through fetch
globalThis.ProgressEvent = class extends Event { constructor(t, o) { super(t); Object.assign(this, o); } };
const THREE = await import('three'), { createField, POSE, TEAM, clothColor } = await import('./public/field3d.js'), W = await import('./public/world.js');
POSE.show = true; // the pose code is tested even while the dashboard has it switched off
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
const C = [0, 0, 0]; // the sensors' place: the figure stands there whatever the camera saw
assert.ok(rh.z > C[2] && lh.z < C[2], 'hands on their own sides');
assert.ok(rh.distanceTo(player.base) < .2, 'the stick hand holds the sensors\' stick base');
assert.ok(lh.y < 1.1 && Math.abs(lh.x - C[0]) < .2, 'left arm hangs down');
assert.ok(rf.x > lf.x + .15 && rf.y > lf.y + .05, 'right knee raised forward');
assert.ok(hd.y > 1.4 && hd.y < 1.8, 'head above the shoulders');
player.skel = null; field.update(.016, { A: player }); // the sensors-only pose drives it too
// sensors only, the chest lowered: a crouch bends the knees and leans the back; the body keeps its size and its feet on the floor
const bendDeg = () => { const k = at('LeftLeg'); return 180 - at('LeftUpLeg').sub(k).angleTo(at('LeftFoot').sub(k)) * 180 / Math.PI; }; // knee bend, 0 = straight
const stand = () => { scene.updateMatrixWorld(true); return { thigh: at('LeftUpLeg').distanceTo(at('LeftLeg')), head: at('Head').y, foot: Math.min(at('LeftFoot').y, at('RightFoot').y), knee: at('LeftLeg').x - at('LeftUpLeg').x, bend: bendDeg() }; };
const pose = h => { player.body = W.bodyPose([0, h, 0], 0, h); player.base = new THREE.Vector3(.3, h + .1, .2); player.tip = new THREE.Vector3(1.3, h + .1, .2); for (let i = 0; i < 30; i++) field.update(.016, { A: player }); return stand(); };
const fmt = o => JSON.stringify(o, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v);
const up = pose(1.35), low = pose(.9);
console.log('standing', fmt(up), 'crouched', fmt(low));
assert.ok(Math.abs(low.thigh - up.thigh) < .005, 'a crouch keeps the body its size');
assert.ok(low.head < up.head - .3, 'the head comes down');
assert.ok(Math.abs(low.foot - up.foot) < .08, 'the feet stay on the floor');
assert.ok(low.knee > up.knee + .1, 'the knees bend forward');
// standing is whatever height the player starts at: a shorter player standing is drawn standing (straight knees), not half-crouched
player.body = null; field.update(.016, { A: player }); // gone: the next one seen is measured afresh
const short = pose(1.15);
console.log('short player standing', fmt(short));
assert.ok(short.bend < 12 && up.bend < 12 && low.bend > 60, 'standing knees straight (both players), bent in the crouch');
assert.ok(short.thigh < up.thigh - .02, 'and a smaller body');
// a one-frame jump of the AR height does not turn standing into a crouch
player.body = W.bodyPose([0, 1.6, 0], 0, 1.6); field.update(.016, { A: player });
const after = pose(1.15);
assert.ok(after.bend < 12, 'a one-frame AR jump leaves the stance alone');
// switched off (the dashboard's default for now): upright whatever the camera pose or the chest height says
POSE.show = false; player.skel = { joints, vis };
const off = pose(.9);
assert.ok(off.bend < 12 && Math.abs(off.head - after.head) < .05, 'POSE.show off: always standing');
// the wizard over the rig: holding the stick, both hands on it for a charge, one knee up when low, in the player's colour
POSE.show = true; player.skel = null; player.body = null; field.update(.016, { A: player });
const wiz = scene.getObjectByName('wizard').userData.pose, hands = () => wiz.hands.map(h => h.clone());
const standWiz = pose(1.35); scene.updateMatrixWorld(true);
const stickBase = () => scene.getObjectByName('wizard').parent.worldToLocal(player.base.clone());
assert.ok(hands()[0].distanceTo(stickBase()) < .01, 'the right hand on the stick');
assert.ok(hands()[1].distanceTo(stickBase()) > .3, 'the left hand free while not charging');
player.charging = true; player.charge = .5; pose(1.35);
assert.ok(hands()[0].distanceTo(stickBase()) < .01 && hands()[1].distanceTo(stickBase()) < .25, 'both hands on the stick while charging');
player.charging = false; pose(1.35);
assert.ok(hands()[1].distanceTo(stickBase()) > .3, 'and the left hand lets go after it');
assert.ok(wiz.low < .05, 'standing: not kneeling');
pose(.8);
const [kneeL, kneeR] = wiz.knees, [footL, footR] = wiz.feet;
assert.ok(wiz.low > .9, 'a low chest kneels, got ' + wiz.low);
assert.ok(kneeL.y > kneeR.y + .03 * wiz.k, 'left knee up, right knee down, got ' + (kneeL.y - kneeR.y) / wiz.k);
assert.ok(footL.x > footR.x + .2 * wiz.k, 'left foot in front, right behind');
// the loser kneels in the same pose as a crouch, standing height or not, by HP or by the clock; the body stays upright
{
  const crouched = wiz.knees.map(k => k.clone()), wizRoot = scene.getObjectByName('wizard').parent;
  pose(1.35); assert.ok(wiz.low < .05, 'up again');
  const lose = () => { for (let i = 0; i < 40; i++) field.update(.016, { A: player }); };
  player.hp = 0; lose();
  assert.ok(wiz.low > .99, 'at 0 HP: kneeling');
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(wizRoot.matrix, 1).y - 1) < 1e-6, 'upright, not toppled');
  assert.ok(wiz.knees[0].y > wiz.knees[1].y + .03 * wiz.k && crouched.length === 2, 'the left knee up, as in a crouch');
  player.hp = 100; lose(); assert.ok(wiz.low < .01, 'a new round stands up');
  player.lost = true; lose(); assert.ok(wiz.low > .99, 'lost on time with HP left: kneeling');
  player.lost = false; lose();
}
// the eyes: the same off the face on both sides, though the face is not symmetric
const [eyeR, eyeL] = wiz.eyes; // x < 0 is the wizard's right
assert.ok(eyeR.x < 0 && eyeL.x > 0 && eyeR.z > eyeL.z + .005, 'each eye sits on its own side of the uneven face, got ' + eyeR.z + ' ' + eyeL.z);
// the cuffs: the colour changes on one line across each arm
{
  const group = scene.getObjectByName('wizard'), ms = group.children.filter(c => c.isSkinnedMesh), skel = ms[0].skeleton, joint = n => new THREE.Vector3().setFromMatrixPosition(skel.boneInverses[skel.bones.findIndex(b => b.name === n)].clone().invert());
  for (const side of ['L', 'R']) {
    const ha = joint(side + '_Hand'), ax = ha.clone().sub(joint(side + '_Forearm')).normalize();
    for (const m of ms) {
      const isSkin = m.material.color.getHex() === 0xf0bfa0, pos = m.geometry.attributes.position, idx = m.geometry.index, c = new THREE.Vector3(), v = new THREE.Vector3();
      for (let i = 0; i < idx.count; i += 3) {
        c.set(0, 0, 0); for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(pos, idx.getX(i + k))); c.divideScalar(3).sub(ha);
        const t = c.dot(ax), rad = c.clone().addScaledVector(ax, -t).length();
        if (Math.abs(t) > .1 || rad > .12 || Math.abs(c.x + ha.x) < .2) continue;
        assert.ok(isSkin ? t > .009 : t < .009, `${side} cuff: ${isSkin ? 'skin' : 'other'} at ${t}`);
      }
    }
  }
}
const worn = scene.getObjectByName('wizard').children[0].material;
assert.equal(worn.color.getHex(), clothColor(TEAM.A).getHex(), 'worn in the player\'s colour');
for (const [team, hue] of [[TEAM.A, 24], [TEAM.B, 212]]) { // only the hue differs: HSV (hue, 39 %, 30 %) as displayed
  const [r, g, b] = clothColor(team).convertLinearToSRGB().toArray(), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  assert.ok(Math.abs(h - hue) < 1 && Math.abs(d / max - .39) < .005 && Math.abs(max - .3) < .005, `clothes HSV ${h} ${d / max} ${max}`);
}
player.online = false; field.update(.016, { A: player });
assert.equal(worn.color.getHex(), clothColor(TEAM.A).getHex(), 'and while offline too');
player.online = true;
// the one built in code (?avatar=simple, or if the model fails to load): three heads tall
const { makeWizard } = await import('./public/wizard.js');
{
  const r0 = new THREE.Group(), up = makeWizard(r0, new THREE.MeshStandardMaterial()), w = r0.getObjectByName('wizard').userData.pose;
  const foot = y => ({ foot: new THREE.Vector3(0, y, 0), toe: new THREE.Vector3(.16, y, 0) }), h = (x, y, z) => new THREE.Vector3(x, y, z);
  up({ legs: [foot(-1.3), foot(-1.3)], hip: h(-.1, -.6, 0), leg: .71, sR: h(-.1, .07, .21), sL: h(-.1, .07, -.21), hR: h(.3, -.3, .2), hL: h(-.1, -.5, -.3), headQ: new THREE.Quaternion(), time: 0 });
  const heads = (w.head.y - w.floor + .25 * w.k) / (.5 * w.k);
  assert.ok(heads > 2.8 && heads < 3.2, 'three heads tall, got ' + heads);
}
console.log('figure ok: limbs follow the skeleton, sides right, falls back without a pose, crouches without shrinking, standing height per player, upright when switched off, the wizard holds the stick and kneels');
