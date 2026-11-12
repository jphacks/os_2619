// チャオベン, the special character (assets/models/chaoben.glb, built by tools/build-chaoben-model.py from the model and the photo it was made from).
// Same contract as wizard.js / wizardmodel.js: update(rig) every frame, in the avatar's root frame (x forward, y up, z right; metres), from the rig's points.
// A grown man at full size, so unlike the wizard the body is the rig's own: the hips and neck where a person's are, the feet where the rig steps,
// the stick hand on the sensors' stick, the free hand moving as the rig's. Bones hang flat under the group, each transform worked out here (as wizardmodel.js).
// Only looks: the game knows nothing of it.
import * as THREE from 'three';
import { turn, jointFor } from './wizardmodel.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const SIZE = 1.35;              // the model's scale per metre of the rig's leg: a 1.3 m chest mount (rig leg .74) stands him at his own 1.73 m
const BODY_X = -.04;            // the body's centre behind the chest's sensor point, m
const LOW = { hip: .5, neck: 1.02, lean: .12, back: -.06, frontFoot: .32, backFoot: -.34, backFootY: .13 }; // down on the right knee, in the model's metres
const GRIP = .07, HANDS_APART = .11; // the fist's centre past the wrist; between the two fists on the stick (model's metres)
const RIG_ARM = .6;             // the rig's shoulder to hand (field3d.js UPPER + FORE)
const HAIR = 0x16110e;
const POLE = { R: V(-.25, -1, .55).normalize(), L: V(-.25, -1, -.55).normalize() }; // the elbows point down and out

const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const _a = new THREE.Matrix4(), _st = new THREE.Matrix4(), _b = new THREE.Matrix4(), _f1 = V(), _f2 = V();

/** makeChaobenModel(root, scene): scene: the loaded (cloned) model. Returns update(rig); see wizard.js for rig. */
export function makeChaobenModel(root, scene) {
  const fig = new THREE.Group(); fig.name = 'chaoben'; root.add(fig);
  const meshes = []; scene.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  for (const m of meshes) {
    const src = m.material, map = src.map ?? null;
    m.material = new THREE.MeshStandardMaterial(map ? { map, roughness: .78, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: .12 } // the photo: a little of its own light, so the face reads in the shade
      : { color: HAIR, roughness: .55, metalness: 0, emissive: HAIR, emissiveIntensity: .1 });
    src.dispose();
    m.frustumCulled = false; fig.add(m);
  }
  const skeleton = meshes[0].skeleton, B = {}, restW = {}, J = {};
  skeleton.bones.forEach((b, i) => { B[b.name] = b; restW[b.name] = skeleton.boneInverses[i].clone().invert(); J[b.name] = V().setFromMatrixPosition(restW[b.name]); });
  for (const b of skeleton.bones) { fig.add(b); b.matrixAutoUpdate = false; }

  const toRoot = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2); // the model: +z forward, +x its left
  const Q = new THREE.Matrix4().makeRotationFromQuaternion(toRoot);
  const R = new THREE.Quaternion(), Rs = new THREE.Quaternion(), Rg = new THREE.Quaternion(), Rhand = new THREE.Quaternion();
  const al = p => p.clone().applyQuaternion(toRoot);
  const UP = V(0, 1, 0), footY = J.L_Foot.y; // the ankle over the soles
  const seg = (a, b) => { const v = al(V().subVectors(J[b], J[a])); return { dir: v.clone().normalize(), len: v.length() }; };
  const ARMS = [['R', 1], ['L', -1]].map(([s, side]) => {
    const upper = seg(s + '_Upperarm', s + '_Forearm'), fore = seg(s + '_Forearm', s + '_Hand');
    const back = V(-1, 0, 0);
    const up1 = upper.dir.clone(), upP = back.clone().addScaledVector(up1, -back.dot(up1)).normalize();
    const fo1 = fore.dir.clone(), foP = back.clone().addScaledVector(fo1, -back.dot(fo1)).normalize();
    const handAxis = V(1, 0, 0).addScaledVector(fo1, -fo1.x).normalize(); // at rest the palm faces the thigh, the thumb forward
    return { s, side, upper, fore, up1, upP, fo1, foP, handAxis, shoulder: V(), elbow: V(), wrist: V(), hand: V(), dir: V(), poleU: V(), poleF: V(), rest: V() };
  });
  const LEGS = [['L', 0], ['R', 1]].map(([s, i]) => ({ s, i, thigh: seg(s + '_Thigh', s + '_Calf'), calf: seg(s + '_Calf', s + '_Foot'), hipAt: V(), knee: V(), foot: V() }));
  const THIGH_OFF = { L: al(V().subVectors(J.L_Thigh, J.Hip)), R: al(V().subVectors(J.R_Thigh, J.Hip)) };
  const armLen = ARMS[0].upper.len + ARMS[0].fore.len;

  const hip = V(), neck = V(), spine = V(), t = V(), tmp = V(), tmp2 = V(), head = V(), pole = V(), side = V();
  const pose = fig.userData.pose = { low: 0, k: 1, floor: 0, knees: LEGS.map(l => l.knee), feet: LEGS.map(l => l.foot), hands: ARMS.map(a => a.hand), head };

  function setBone(name, at, q, s, dir = null, f = 1) {
    _a.makeRotationFromQuaternion(q);
    if (dir && Math.abs(f - 1) > 1e-4) {
      const g = f - 1, x = dir.x, y = dir.y, z = dir.z;
      _st.set(1 + g * x * x, g * x * y, g * x * z, 0, g * y * x, 1 + g * y * y, g * y * z, 0, g * z * x, g * z * y, 1 + g * z * z, 0, 0, 0, 0, 1);
      _a.multiply(_st);
    }
    _a.multiply(_b.copy(Q).scale(tmp2.set(s, s, s)));
    const j = J[name], e = _a.elements;
    e[12] = at.x - (e[0] * j.x + e[4] * j.y + e[8] * j.z); e[13] = at.y - (e[1] * j.x + e[5] * j.y + e[9] * j.z); e[14] = at.z - (e[2] * j.x + e[6] * j.y + e[10] * j.z);
    B[name].matrix.multiplyMatrices(_a, restW[name]); B[name].matrixWorldNeedsUpdate = true;
  }

  return function update(r) {
    const legs = r.legs, s = r.leg * SIZE, fy = Math.min(legs[0].foot.y, legs[1].foot.y), floor = fy - .04;
    const low = Math.max(smooth((.92 - (r.hip.y - fy) / r.leg) / .47), smooth(r.down ?? 0)); // 0 standing, 1 down on a knee (as wizardmodel.js)
    const breath = .006 * s * Math.sin((r.time ?? 0) * 2.1);
    pose.low = low; pose.k = s; pose.floor = floor;
    const hipH = J.Hip.y + (LOW.hip - J.Hip.y) * low, neckH = J.Neck.y + (LOW.neck - J.Neck.y) * low;
    const lean = (r.lean ?? 0) * (1 - low); // the rig's crouch bends him forward at the waist
    hip.set(BODY_X + LOW.back * low * s, floor + hipH * s, 0);
    neck.set(hip.x + Math.sin(lean) * (neckH - hipH) * s + LOW.lean * low * s, hip.y + Math.cos(lean) * (neckH - hipH) * s + breath, 0);

    // the trunk along the line from the hips to the neck
    spine.subVectors(neck, hip); const spineLen = spine.length(), restLen = (J.Neck.y - J.Hip.y) * s; spine.divideScalar(spineLen);
    R.setFromUnitVectors(UP, spine);
    for (const a of ['Hip', 'Waist', 'Spine01', 'Spine02']) {
      t.copy(hip).addScaledVector(spine, (J[a].y - J.Hip.y) / (J.Neck.y - J.Hip.y) * spineLen);
      setBone(a, t, R, s, UP, spineLen / restLen);
    }
    setBone('Neck', neck, R, s);
    head.copy(neck).addScaledVector(spine, (J.Head.y - J.Neck.y) * s);
    setBone('Head', head, r.headQ, s); // the head's turn in the body frame, as the wizard's

    // the arms: the stick hand holds the stick; the free one moves as the rig's does, and comes to the stick for a charge
    const st = r.stick, g = st ? st.grip : 0;
    for (const a of ARMS) {
      const rigS = a.s === 'R' ? r.sR : r.sL, rigH = a.s === 'R' ? r.hR : r.hL, onStick = st && st.hand === a.s;
      setBone(a.s + '_Clavicle', tmp.copy(al(V().subVectors(J[a.s + '_Clavicle'], J.Neck))).multiplyScalar(s).applyQuaternion(R).add(neck), R, s);
      a.shoulder.copy(al(V().subVectors(J[a.s + '_Upperarm'], J.Neck))).multiplyScalar(s).applyQuaternion(R).add(neck);
      a.rest.copy(a.shoulder).add(tmp.subVectors(rigH, rigS).multiplyScalar(armLen * s / RIG_ARM)); // the rig's reach, at his arm's length
      a.rest.z += a.side * .05 * s; // clear of the thigh
      if (onStick) a.hand.copy(st.base);
      else if (st && g > 0) a.hand.copy(a.rest).lerp(tmp.copy(st.base).addScaledVector(st.dir, -HANDS_APART * s), g);
      else a.hand.copy(a.rest);
      const w = onStick ? 1 : g;
      a.dir.subVectors(a.hand, a.shoulder); if (st) a.dir.addScaledVector(st.dir, -a.dir.dot(st.dir) * w);
      if (a.dir.lengthSq() < 1e-6) a.dir.set(1, 0, 0); a.dir.normalize();
      a.wrist.copy(a.hand).addScaledVector(a.dir, -GRIP * s);
      const lu = a.upper.len * s, lf = a.fore.len * s;
      jointFor(a.elbow, a.shoulder, a.wrist, lu, lf, POLE[a.s]);
      const du = _f1.subVectors(a.elbow, a.shoulder), Lu = du.length(); du.divideScalar(Math.max(Lu, 1e-5));
      a.poleU.copy(POLE[a.s]).addScaledVector(du, -POLE[a.s].dot(du)).normalize();
      setBone(a.s + '_Upperarm', a.shoulder, turn(Rs, a.up1, a.upP, du, a.poleU), s, a.up1, Lu / lu);
      const df = _f2.subVectors(a.wrist, a.elbow), Lf = df.length(); df.divideScalar(Math.max(Lf, 1e-5));
      a.poleF.copy(POLE[a.s]).addScaledVector(df, -POLE[a.s].dot(df)).normalize();
      turn(Rs, a.fo1, a.foP, df, a.poleF);
      setBone(a.s + '_Forearm', a.elbow, Rs, s, a.fo1, Lf / lf);
      Rhand.copy(Rs);
      if (st && w > 0) { turn(Rg, a.fo1, a.handAxis, a.dir, tmp.copy(st.dir).addScaledVector(a.dir, -st.dir.dot(a.dir)).normalize()); Rhand.slerp(Rg, w); }
      setBone(a.s + '_Hand', a.wrist, Rhand, s);
    }

    // the legs: stepping where the rig steps; down, the left foot flat in front and the right knee on the floor behind
    for (const l of LEGS) {
      const rl = legs[l.i], back = l.s === 'R', restFoot = al(tmp2.copy(J[l.s + '_Foot'])), f = l.foot;
      f.set(BODY_X + (rl.foot.x - r.hip.x), floor + footY * s + (rl.foot.y - fy), restFoot.z * s);
      tmp.set(BODY_X + (back ? LOW.backFoot : LOW.frontFoot) * s, floor + (back ? LOW.backFootY : footY) * s, restFoot.z * s);
      f.lerp(tmp, low);
      l.hipAt.copy(THIGH_OFF[l.s]).multiplyScalar(s).applyQuaternion(R).add(hip);
      pole.set(1, back ? -.75 * low : .55 * low, 0);
      const lt = l.thigh.len * s, lc = l.calf.len * s;
      jointFor(l.knee, l.hipAt, f, lt, lc, pole);
      side.subVectors(l.knee, l.hipAt); const Lt = side.length();
      setBone(l.s + '_Thigh', l.hipAt, Rs.setFromUnitVectors(l.thigh.dir, side.divideScalar(Math.max(Lt, 1e-5))), s, l.thigh.dir, Lt / lt);
      side.subVectors(f, l.knee); const Lc = side.length();
      setBone(l.s + '_Calf', l.knee, Rs.setFromUnitVectors(l.calf.dir, side.divideScalar(Math.max(Lc, 1e-5))), s, l.calf.dir, Lc / lc);
      tmp.subVectors(rl.toe, rl.foot);
      const yaw = low > .5 ? 0 : Math.atan2(-tmp.z, Math.max(.01, tmp.x));
      Rs.setFromAxisAngle(UP, yaw).multiply(Rg.setFromAxisAngle(V(0, 0, 1), back ? -.9 * low : 0));
      setBone(l.s + '_Foot', f, Rs, s);
    }
  };
}
