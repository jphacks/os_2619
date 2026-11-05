// The wizard from the artist's rigged model (assets/models/wizard.glb, built by tools/build-wizard-model.py). Same contract as wizard.js: update(rig) every frame,
// in the avatar's root frame (x forward, y up, z right; metres), from the rig's points. No animation clips: each bone's transform is worked out here, directly from
// the targets, with no parent chain (the bones hang flat under the group). So an arm can stretch to keep the hand on the sensors' stick, and the skirt can squash.
// Only looks: the game knows nothing of it.
import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const SIZE = 2.65;              // the model's scale per metre of the rig's leg: its 1 m (soles to hat tip) stands about as tall as the human rig did, the shoulders near the sensors' hand
const BODY_X = -.03;            // the body's centre behind the chest's sensor point, m
const LOW = { hip: .15, neck: .4, lean: .05, back: -.02, frontFoot: .12, backFoot: -.15, backFootY: .085, hemFront: .1, hemBack: .03 }; // kneeling, in the model's units
const GRIP = .04, HANDS_APART = .075; // the fist's centre past the wrist; between the two fists on the stick (model's units)
const PART = { skin: 0xf0bfa0, boot: 0x6e3a1e, face: 0x0d0a09 }; // what is not the player's colour, as in the artist's picture
const EYE = { x: .038, y: .655, off: .0045, yaw: .5, w: .0135, h: .0225, d: .006, color: 0xfff1c0 }; // on the face (the model's own eyes are texture only). off: the middle stands this far off the face, whose two sides differ by 1 cm: one eye would sink into it
const POLE = { R: V(-.25, -1, .55).normalize(), L: V(-.25, -1, -.55).normalize() }; // the elbows point down and out

const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const _a = new THREE.Matrix4(), _st = new THREE.Matrix4(), _b = new THREE.Matrix4();
const _d = V(), _n = V(), _e1 = V(), _e2 = V(), _e3 = V(), _f1 = V(), _f2 = V(), _f3 = V();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

/** The turn taking the frame (a1, a2) to (b1, b2), each pair unit and at right angles. */
function turn(q, a1, a2, b1, b2) {
  _e3.crossVectors(a1, a2); _f3.crossVectors(b1, b2);
  _m1.makeBasis(a1, a2, _e3); _m2.makeBasis(b1, b2, _f3);
  return q.setFromRotationMatrix(_m2.multiply(_m1.transpose()));
}
/** Joint between a and b, bones l1 and l2, bending toward pole. */
function jointFor(out, a, b, l1, l2, pole) {
  _d.subVectors(b, a); const d = Math.max(_d.length(), 1e-4); _d.divideScalar(d);
  _n.copy(pole).addScaledVector(_d, -pole.dot(_d)); if (_n.lengthSq() < 1e-6) _n.set(0, -1, 0); _n.normalize();
  const reach = l1 + l2, k = d >= reach ? d : reach, x = d >= reach ? d * l1 / reach : (d * d + l1 * l1 - l2 * l2) / (2 * d), h = d >= reach ? 0 : Math.sqrt(Math.max(0, l1 * l1 - x * x));
  void k; return out.copy(a).addScaledVector(_d, x).addScaledVector(_n, h);
}

/** (x, y) -> the frontmost z of the surface there, in the rest pose. */
function surfaceFront(geo) {
  const pos = geo.attributes.position, idx = geo.index, a = V(), b = V(), c = V(), hit = V(), ray = new THREE.Ray();
  return (x, y) => {
    ray.origin.set(x, y, 2); ray.direction.set(0, 0, -1); let z = -Infinity;
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i)); b.fromBufferAttribute(pos, idx.getX(i + 1)); c.fromBufferAttribute(pos, idx.getX(i + 2));
      if (ray.intersectTriangle(a, b, c, false, hit)) z = Math.max(z, hit.z);
    }
    return z;
  };
}

/** makeWizardModel(root, cloth, scene): scene: the loaded (cloned) model; cloth: the material of hat and gown (the player's colour). Returns update(rig); see wizard.js for rig. */
export function makeWizardModel(root, cloth, scene) {
  const wiz = new THREE.Group(); wiz.name = 'wizard'; root.add(wiz);
  const parts = Object.fromEntries(Object.entries(PART).map(([n, color]) => [n, new THREE.MeshStandardMaterial({ color, roughness: n === 'face' ? .5 : .8, metalness: 0, emissive: color, emissiveIntensity: n === 'skin' ? .3 : .08 })]));
  cloth.side = THREE.FrontSide; // a closed surface: both sides would light the hat's underside in specks
  const meshes = []; scene.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  const faceZ = surfaceFront(meshes.find(m => m.material.name === 'face').geometry);
  meshes.sort((a, b) => (b.material.name === 'cloth') - (a.material.name === 'cloth'));
  const skeleton = meshes[0].skeleton, B = {}, restW = {}, J = {};
  skeleton.bones.forEach((b, i) => { B[b.name] = b; restW[b.name] = skeleton.boneInverses[i].clone().invert(); J[b.name] = V().setFromMatrixPosition(restW[b.name]); });
  for (const m of meshes) { m.material = parts[m.material.name] ?? cloth; m.frustumCulled = false; wiz.add(m); }
  for (const b of skeleton.bones) { wiz.add(b); b.matrixAutoUpdate = false; } // flat: each bone's matrix is its whole transform
  const eyeMat = new THREE.MeshBasicMaterial({ color: EYE.color }), eyeGeo = new THREE.SphereGeometry(1, 14, 10);
  const eyes = [-1, 1].map(s => {
    const m = new THREE.Mesh(eyeGeo, eyeMat); m.matrixAutoUpdate = false; m.frustumCulled = false; wiz.add(m);
    const rest = new THREE.Matrix4().compose(V(s * EYE.x, EYE.y, faceZ(s * EYE.x, EYE.y) + EYE.off), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), s * EYE.yaw), V(EYE.w, EYE.h, EYE.d));
    return { m, rest };
  });

  const toRoot = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI / 2); // the model: +z forward, +x its left
  const Q = new THREE.Matrix4().makeRotationFromQuaternion(toRoot);
  const R = new THREE.Quaternion(), Rs = new THREE.Quaternion(), Rg = new THREE.Quaternion(), Rhand = new THREE.Quaternion();
  const al = p => p.clone().applyQuaternion(toRoot); // a rest vector, turned to the root's axes (still unscaled)
  const UP = V(0, 1, 0);
  const seg = (a, b) => { const v = al(V().subVectors(J[b], J[a])); return { dir: v.clone().normalize(), len: v.length() }; };
  const ARMS = [['R', 1], ['L', -1]].map(([s, side]) => {
    const upper = seg(s + '_Upperarm', s + '_Forearm'), fore = seg(s + '_Forearm', s + '_Hand');
    const back = V(-1, 0, 0); // at rest the elbow's bend faces back
    const up1 = upper.dir.clone().addScaledVector(back, 0).normalize(), upP = back.clone().addScaledVector(up1, -back.dot(up1)).normalize();
    const fo1 = fore.dir.clone(), foP = back.clone().addScaledVector(fo1, -back.dot(fo1)).normalize();
    const handAxis = V(1, 0, 0).addScaledVector(fo1, -fo1.x).normalize(); // the fist's hole, at rest along the model's front-back (the thumb forward)
    return { s, side, upper, fore, up1, upP, fo1, foP, handAxis, shoulder: V(), elbow: V(), wrist: V(), hand: V(), dir: V(), poleU: V(), poleF: V(), rest: V() };
  });
  const LEGS = [['L', 0], ['R', 1]].map(([s, i]) => ({ s, i, thigh: seg(s + '_Thigh', s + '_Calf'), calf: seg(s + '_Calf', s + '_Foot'), hipAt: V(), knee: V(), foot: V() }));
  const THIGH_OFF = { L: al(V().subVectors(J.L_Thigh, J.Hip)), R: al(V().subVectors(J.R_Thigh, J.Hip)) };

  const hip = V(), neck = V(), spine = V(), t = V(), tmp = V(), tmp2 = V(), head = V(), pole = V(), side = V();
  const pose = wiz.userData.pose = { low: 0, k: 1, floor: 0, knees: LEGS.map(l => l.knee), feet: LEGS.map(l => l.foot), hands: ARMS.map(a => a.hand), head, eyes: eyes.map(e => V().setFromMatrixPosition(e.rest)) };

  /** bone's transform: rest point p -> at + R St (s Q) (p - joint); dir / f: stretch by f along dir (root axes, before R). */
  function setBone(name, at, q, s, dir = null, f = 1) {
    _a.makeRotationFromQuaternion(q);
    if (dir && Math.abs(f - 1) > 1e-4) {
      const g = f - 1, x = dir.x, y = dir.y, z = dir.z;
      _st.set(1 + g * x * x, g * x * y, g * x * z, 0, g * y * x, 1 + g * y * y, g * y * z, 0, g * z * x, g * z * y, 1 + g * z * z, 0, 0, 0, 0, 1);
      _a.multiply(_st);
    }
    return place(name, at, s);
  }
  function place(name, at, s) { // the rest of setBone, with the turn and stretch already in _a
    _a.multiply(_b.copy(Q).scale(tmp2.set(s, s, s)));
    const j = J[name], e = _a.elements;
    e[12] = at.x - (e[0] * j.x + e[4] * j.y + e[8] * j.z); e[13] = at.y - (e[1] * j.x + e[5] * j.y + e[9] * j.z); e[14] = at.z - (e[2] * j.x + e[6] * j.y + e[10] * j.z);
    const b = B[name]; b.matrix.multiplyMatrices(_a, restW[name]); b.matrixWorldNeedsUpdate = true;
    return _a;
  }

  return function update(r) {
    const legs = r.legs, s = r.leg * SIZE, footY = Math.min(legs[0].foot.y, legs[1].foot.y), floor = footY - .04;
    const low = Math.max(smooth((.92 - (r.hip.y - footY) / r.leg) / .47), smooth(r.down ?? 0)); // how far down the rig's hips have come: 0 standing, 1 kneeling; r.down: the same kneel for the loser
    const breath = .004 * s * Math.sin((r.time ?? 0) * 2.1);
    pose.low = low; pose.k = s; pose.floor = floor;
    const hipH = J.Hip.y + (LOW.hip - J.Hip.y) * low, neckH = J.Neck.y + (LOW.neck - J.Neck.y) * low;
    hip.set(BODY_X + LOW.back * low * s, floor + hipH * s, 0);
    neck.set(BODY_X + LOW.lean * low * s, floor + neckH * s + breath, 0);

    // the trunk: Hip, Waist, Spine01, Spine02 along the line from the hips to the neck, stretched to fit it
    spine.subVectors(neck, hip); const spineLen = spine.length(), restLen = (J.Neck.y - J.Hip.y) * s; spine.divideScalar(spineLen);
    R.setFromUnitVectors(UP, spine);
    const chain = [['Hip', 'Waist'], ['Waist', 'Spine01'], ['Spine01', 'Spine02'], ['Spine02', 'Neck']];
    for (const [a, b] of chain) {
      const f = (J[a].y - J.Hip.y) / (J.Neck.y - J.Hip.y);
      t.copy(hip).addScaledVector(spine, f * spineLen);
      setBone(a, t, R, s, UP, spineLen / restLen);
    }
    void chain;
    setBone('Neck', neck, R, s);
    head.copy(neck).addScaledVector(spine, (J.Head.y - J.Neck.y) * s);
    const Mh = setBone('Head', head, r.headQ, s);
    for (const e of eyes) { e.m.matrix.multiplyMatrices(Mh, e.rest); e.m.matrixWorldNeedsUpdate = true; }
    pose.head.copy(head); // the pivot at the neck's top

    // the skirt squashes between the hips and the hem: at the front over the raised knee, at the back down on the floor
    for (const [name, hem, x] of [['Skirt_F', LOW.hemFront, .03], ['Skirt_B', LOW.hemBack, 0]]) {
      const restH = J[name].y, hemRest = .1, f = 1 + ((hipH - hem * low - hemRest * (1 - low)) / (restH - hemRest) - 1) * 1, flare = 1 + .12 * low;
      _a.makeScale(flare, Math.max(.05, f), flare);
      t.set(hip.x + x * low * s, floor + (hipH + (restH - J.Hip.y)) * s, 0);
      place(name, t, s);
    }

    // the arms: the stick hand holds the stick; the free one moves as the rig's does, and comes to the stick for a charge
    const st = r.stick, g = st ? st.grip : 0;
    for (const a of ARMS) {
      const rigS = a.s === 'R' ? r.sR : r.sL, rigH = a.s === 'R' ? r.hR : r.hL, onStick = st && st.hand === a.s;
      setBone(a.s + '_Clavicle', tmp.copy(al(V().subVectors(J[a.s + '_Clavicle'], J.Neck))).multiplyScalar(s).applyQuaternion(R).add(neck), R, s);
      a.shoulder.copy(al(V().subVectors(J[a.s + '_Upperarm'], J.Neck))).multiplyScalar(s).applyQuaternion(R).add(neck);
      a.rest.copy(a.shoulder).add(tmp.subVectors(rigH, rigS).multiplyScalar(s / 1.95)); // where the free hand would be: the rig's reach, at this body's size
      a.rest.z += a.side * .06 * low * s; a.rest.y = Math.max(a.rest.y, floor + (.2 + .1 * low) * s); // over the skirt, which spreads when kneeling
      if (onStick) a.hand.copy(st.base);
      else if (st && g > 0) a.hand.copy(a.rest).lerp(tmp.copy(st.base).addScaledVector(st.dir, -HANDS_APART * s), g);
      else a.hand.copy(a.rest);
      const w = onStick ? 1 : g;
      // the fist grips across the stick: the wrist on the side the arm comes from
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
      Rhand.copy(Rs); // free: on along the forearm
      if (st && w > 0) { turn(Rg, a.fo1, a.handAxis, a.dir, tmp.copy(st.dir).addScaledVector(a.dir, -st.dir.dot(a.dir)).normalize()); Rhand.slerp(Rg, w); }
      setBone(a.s + '_Hand', a.wrist, Rhand, s);
    }

    // the legs: stepping where the rig steps; kneeling, the left foot flat in front and the right behind on its toes, the knee down
    for (const l of LEGS) {
      const rl = legs[l.i], back = l.s === 'R', restFoot = al(tmp2.copy(J[l.s + '_Foot'])), f = l.foot;
      f.set(BODY_X + (rl.foot.x - r.hip.x) * .75, floor + restFoot.y * s + (rl.foot.y - footY) * .8, restFoot.z * s);
      tmp.set(BODY_X + (back ? LOW.backFoot : LOW.frontFoot) * s, floor + (back ? LOW.backFootY : restFoot.y) * s, restFoot.z * s);
      f.lerp(tmp, low);
      l.hipAt.copy(THIGH_OFF[l.s]).multiplyScalar(s).add(hip);
      pole.set(1, back ? -.75 * low : .55 * low, 0);
      const lt = l.thigh.len * s, lc = l.calf.len * s;
      jointFor(l.knee, l.hipAt, f, lt, lc, pole);
      side.subVectors(l.knee, l.hipAt); const Lt = side.length();
      setBone(l.s + '_Thigh', l.hipAt, Rs.setFromUnitVectors(l.thigh.dir, side.divideScalar(Math.max(Lt, 1e-5))), s, l.thigh.dir, Lt / lt);
      side.subVectors(f, l.knee); const Lc = side.length();
      setBone(l.s + '_Calf', l.knee, Rs.setFromUnitVectors(l.calf.dir, side.divideScalar(Math.max(Lc, 1e-5))), s, l.calf.dir, Lc / lc);
      tmp.subVectors(rl.toe, rl.foot);
      const yaw = low > .5 ? 0 : Math.atan2(-tmp.z, Math.max(.01, tmp.x));
      Rs.setFromAxisAngle(UP, yaw).multiply(Rg.setFromAxisAngle(V(0, 0, 1), back ? -.95 * low : 0));
      setBone(l.s + '_Foot', f, Rs, s);
    }
  };
}
