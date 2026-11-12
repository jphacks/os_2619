// チャオベン, the special character (assets/models/chaoben.glb, built by tools/build-chaoben-model.py from the model and the photo it was made from).
// Same contract as wizard.js / wizardmodel.js: update(rig) every frame, in the avatar's root frame (x forward, y up, z right; metres), from the rig's points.
// A grown man at full size, so unlike the wizard the body is the rig's own: the hips and neck where a person's are, the feet where the rig steps,
// the stick hand on the sensors' stick, the free hand moving as the rig's. Bones hang flat under the group, each transform worked out here (as wizardmodel.js).
// Only looks: the game knows nothing of it.
import * as THREE from 'three';
import { turn, jointFor } from './wizardmodel.js';
import { solveArm } from './armik.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const SIZE = 1.35;              // the model's scale per metre of the rig's leg: a 1.3 m chest mount (rig leg .74) stands him at his own 1.73 m
const BODY_X = -.04;            // the body's centre behind the chest's sensor point, m
const LOW = { hip: .5, neck: 1.02, lean: .12, back: -.06, frontFoot: .32, backFoot: -.34, backFootY: .13 }; // down on the right knee, in the model's metres
const GRIP = .07, HANDS_APART = .11; // the fist's centre past the wrist; between the two fists on the stick (model's metres)
const RIG_HANG = .5;            // the rig's free hand hangs this far from its shoulder (field3d.js): taken as his arm hanging straight
const HAIR = 0x16110e;

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
    const g0 = J[s + '_Grip'], g1 = J[s + '_GripEnd'], gripOff = g0 ? al(V().subVectors(g0, J[s + '_Hand'])) : V(GRIP, 0, 0);
    const gripAxis = g0 && g1 ? al(V().subVectors(g1, g0)).normalize() : null; // the hole's direction at rest
    const gripAlong = gripAxis && fo1.clone().addScaledVector(gripAxis, -fo1.dot(gripAxis)).normalize(); // the hand's length, square to it
    return { s, side, upper, fore, up1, upP, fo1, foP, handAxis, gripOff, gripAxis, gripAlong, root: V(), shoulder: V(), elbow: V(), wrist: V(), hand: V(), dir: V(), pole: V(), poleU: V(), poleF: V(), rest: V(), ik: {} };
  });
  const LEGS = [['L', 0], ['R', 1]].map(([s, i]) => ({ s, i, thigh: seg(s + '_Thigh', s + '_Calf'), calf: seg(s + '_Calf', s + '_Foot'), hipAt: V(), knee: V(), foot: V() }));
  const THIGH_OFF = { L: al(V().subVectors(J.L_Thigh, J.Hip)), R: al(V().subVectors(J.R_Thigh, J.Hip)) };
  const armLen = ARMS[0].upper.len + ARMS[0].fore.len + GRIP; // shoulder to the fist's centre

  const hip = V(), neck = V(), spine = V(), t = V(), tmp = V(), tmp2 = V(), head = V(), pole = V(), side = V();
  const pose = fig.userData.pose = { stickArm: { shoulder: V(), upper: 0, fore: 0 }, low: 0, k: 1, floor: 0, knees: LEGS.map(l => l.knee), feet: LEGS.map(l => l.foot), hands: ARMS.map(a => a.hand), head };

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

  const _fw = V(), _uw = V(), _ow = V(), _hl = V(); let lastT = null;
  return function update(r) {
    const dt = lastT == null ? 0 : Math.min(.1, Math.max(0, (r.time ?? 0) - lastT)); lastT = r.time ?? 0; // for the elbow's easing (armik.js)
    const legs = r.legs, s = r.leg * SIZE, fy = Math.min(legs[0].foot.y, legs[1].foot.y), floor = fy - .04;
    const low = Math.max(smooth((.92 - (r.hip.y - fy) / r.leg) / .47), smooth(r.down ?? 0)); // 0 standing, 1 down on a knee (as wizardmodel.js)
    const breath = .006 * s * Math.sin((r.time ?? 0) * 2.1);
    pose.low = low; pose.k = s; pose.floor = floor; pose.handsApart = HANDS_APART * s; // field3d.js: how far behind the stick hand the other one holds it
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
      a.root.copy(al(V().subVectors(J[a.s + '_Clavicle'], J.Neck))).multiplyScalar(s).applyQuaternion(R).add(neck); // the clavicle's root
      a.shoulder.copy(al(V().subVectors(J[a.s + '_Upperarm'], J.Neck))).multiplyScalar(s).applyQuaternion(R).add(neck);
      tmp.subVectors(rigH, rigS); const reach = tmp.length(); // the rig's reach: its direction, and how far out of hanging straight
      a.rest.copy(a.shoulder).addScaledVector(tmp.divideScalar(Math.max(reach, 1e-5)), armLen * s * .98 * Math.min(1, reach / RIG_HANG));
      a.rest.z += a.side * .05 * s; // clear of the thigh
      if (onStick) a.hand.copy(st.base);
      else if (st && g > 0) a.hand.copy(a.rest).lerp(tmp.copy(st.base).addScaledVector(st.dir, -HANDS_APART * s), g);
      else a.hand.copy(a.rest);
      const w = onStick ? 1 : g, lu = a.upper.len * s, lf = a.fore.len * s, lfg = lf + GRIP * s;
      if (a.s === 'R') { pose.stickArm.shoulder.copy(a.shoulder); pose.stickArm.upper = lu; pose.stickArm.fore = lf + a.gripOff.length() * s; } // at rest: what world.js ARM_OF.<chara> is measured from
      // the stick hand: the fist's hole (the Grip marker, tools/build-chaoben-model.py) on the stick and along it; the wrist bends for that, and the
      // arm reaches the wrist. The hand's length axis stays as near the arm's line as it can (square to the stick)
      const grip = onStick && a.gripAxis;
      if (grip) {
        _hl.subVectors(st.base, a.shoulder).addScaledVector(st.dir, -st.dir.dot(tmp.subVectors(st.base, a.shoulder))); if (_hl.lengthSq() < 1e-8) _hl.set(1, 0, 0); _hl.normalize();
        turn(Rhand, a.gripAxis, a.gripAlong, st.dir, _hl);
        a.wrist.copy(st.base).sub(tmp.copy(a.gripOff).multiplyScalar(s).applyQuaternion(Rhand));
      }
      // the arm from its shoulder to the wrist / fist (armik.js: two bones, the elbow's side, the clavicle and shoulder as VRArmIK places them)
      _fw.set(1, 0, 0).applyQuaternion(R); _uw.set(0, 1, 0).applyQuaternion(R); _ow.set(0, 0, a.side).applyQuaternion(R);
      const sol = solveArm({ root: a.root, shoulder: a.shoulder, fwd: _fw, up: _uw, out: _ow, upper: lu, fore: grip ? lf : lfg, target: grip ? a.wrist : a.hand, state: a.ik, dt });
      setBone(a.s + '_Clavicle', a.root, Rs.copy(sol.clavicle).multiply(R), s);
      a.shoulder.copy(sol.shoulder); a.elbow.copy(sol.elbow);
      if (grip) { a.dir.subVectors(a.wrist, a.elbow).normalize(); }
      else { a.dir.subVectors(a.hand, a.elbow); const Lfg = a.dir.length(); a.dir.divideScalar(Math.max(Lfg, 1e-5)); a.wrist.copy(a.elbow).addScaledVector(a.dir, Lfg * lf / lfg); } // the forearm, on to the fist
      a.pole.copy(a.elbow).sub(tmp.copy(a.shoulder).lerp(a.wrist, .5)); if (a.pole.lengthSq() < 1e-8) a.pole.copy(_uw).negate(); a.pole.normalize(); // where the elbow sticks out
      const du = _f1.subVectors(a.elbow, a.shoulder), Lu = du.length(); du.divideScalar(Math.max(Lu, 1e-5));
      a.poleU.copy(a.pole).addScaledVector(du, -a.pole.dot(du)).normalize();
      setBone(a.s + '_Upperarm', a.shoulder, turn(Rs, a.up1, a.upP, du, a.poleU), s, a.up1, Lu / lu);
      const df = _f2.subVectors(a.wrist, a.elbow), Lf = df.length(); df.divideScalar(Math.max(Lf, 1e-5));
      a.poleF.copy(a.pole).addScaledVector(df, -a.pole.dot(df)).normalize();
      turn(Rs, a.fo1, a.foP, df, a.poleF);
      setBone(a.s + '_Forearm', a.elbow, Rs, s, a.fo1, Lf / lf);
      if (!grip) {
        Rhand.copy(Rs); // free: on along the forearm
        if (st && w > 0) { turn(Rg, a.fo1, a.handAxis, a.dir, tmp.copy(st.dir).addScaledVector(a.dir, -st.dir.dot(a.dir)).normalize()); Rhand.slerp(Rg, w); }
      }
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
