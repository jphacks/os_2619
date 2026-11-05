// What the avatars look like: a small wizard, three heads tall, in a wide hat with a bent tip and a long gown, all in one colour (the player's).
// Rebuilt every frame in the avatar's root frame (x forward, y up, z right; metres) from the rig's points (field3d.js). The rig is human sized,
// so only what the sensors say is taken from it: where the feet stand and step, how low the body is, how the free hand moves, and the stick hand,
// which stays on the stick. Holding a charge, the free hand comes to the stick too. A low body kneels on the right knee, the left one raised.
// Only looks: the game knows nothing of it.
import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const STAND_LEG = .71;      // m, the rig's leg length the sizes below are written for: big enough that the sensors' stick hand comes about level with the shoulders, not the face
const HEAD = .25;           // the head's radius; 6 of them make the height (soles to the top of the head): three heads tall
const NECK = .97, HIP = .5; // heights standing, over the floor
const LOW_NECK = .72, LOW_HIP = .25; // kneeling
const LEG = .235, ARM = .3; // a bone of the leg, of the arm
const SHOULDER = .17, BODY_X = -.1; // half the shoulders; the body stands behind the chest's sensor point
const FOOT = .06;           // the ankle over the floor
const FACE = 0xf4dfc6, EYE = 0x17110d;
const FOLDS = [[6, .6, 1], [11, .4, 2.4]]; // the gown's folds around it: count, weight, phase

const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = v => { const t = clamp01(v); return t * t * (3 - 2 * t); };

/** A tube of `rows` rings of `cols` points, its vertices rewritten by set(row, col, x, y, z). */
function grid(rows, cols, material, parent) {
  const pos = new Float32Array(rows * cols * 3), idx = [];
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols; j++) {
    const a = i * cols + j, b = i * cols + (j + 1) % cols, c = (i + 1) * cols + j, d = (i + 1) * cols + (j + 1) % cols;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)); g.setIndex(idx);
  const mesh = new THREE.Mesh(g, material); mesh.frustumCulled = false; parent.add(mesh);
  return { set(r, c, x, y, z) { const k = (r * cols + c) * 3; pos[k] = x; pos[k + 1] = y; pos[k + 2] = z; }, done() { g.attributes.position.needsUpdate = true; g.computeVertexNormals(); } };
}
/** A round tube along points: rings kept from twisting by carrying the side vector along. */
const _d = V(), _s = V(), _n = V();
function tube(t, points, radii, cols) {
  const n = points.length; _s.set(0, 0, 1);
  for (let i = 0; i < n; i++) {
    _d.subVectors(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]); if (_d.lengthSq() < 1e-10) _d.set(0, -1, 0); _d.normalize();
    _s.addScaledVector(_d, -_s.dot(_d)); if (_s.lengthSq() < 1e-6) _s.set(1, 0, 0).addScaledVector(_d, -_d.x); _s.normalize();
    _n.crossVectors(_d, _s);
    for (let j = 0; j < cols; j++) {
      const q = j / cols * Math.PI * 2, u = Math.cos(q) * radii[i], v = Math.sin(q) * radii[i], p = points[i];
      t.set(i, j, p.x + _s.x * u + _n.x * v, p.y + _s.y * u + _n.y * v, p.z + _s.z * u + _n.z * v);
    }
  }
  t.done();
}
/** Joint between a and b, bones of length l each, bending toward pole. */
function jointFor(out, a, b, l, pole) {
  _d.subVectors(b, a); const d = _d.length(); _d.divideScalar(Math.max(d, 1e-4));
  _n.copy(pole).addScaledVector(_d, -pole.dot(_d)); if (_n.lengthSq() < 1e-6) _n.set(0, -1, 0); _n.normalize();
  return out.copy(a).addScaledVector(_d, d / 2).addScaledVector(_n, d < 2 * l ? Math.sqrt(l * l - d * d / 4) : 0);
}
function hatGeometry() { // the brim drooping to the sides, then the crown up along a spine that bends over backward; unit: the avatar's k
  const spine = new THREE.CatmullRomCurve3([V(0, .03), V(-.01, .18), V(-.03, .32), V(-.07, .45), V(-.15, .55), V(-.29, .5), V(-.33, .35)].map((p, i) => p.setZ(i < 3 ? 0 : (i - 2) * -.035)));
  const R = [.245, .2, .155, .112, .078, .048, .004], BRIM = 7, CROWN = 26, COLS = 48, pos = [], idx = [], rows = BRIM + CROWN;
  const tan = V(), side = V(), nrm = V(), c = V();
  for (let i = 0; i < rows; i++) for (let j = 0; j < COLS; j++) {
    const a = j / COLS * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    if (i < BRIM) {
      const e = 1 - i / BRIM, r = .245 + .285 * e; // e: 1 at the rim, 0 at the crown
      pos.push(ca * r, .03 - e * e * (.08 + .05 * sa * sa) + e * e * e * .018 * Math.sin(a * 3 + 1), sa * r);
    } else {
      const t = (i - BRIM) / (CROWN - 1), u = t * 6, n = Math.min(5, Math.floor(u));
      spine.getPoint(t, c); spine.getTangent(t, tan); side.set(0, 0, 1).addScaledVector(tan, -tan.z).normalize(); nrm.crossVectors(tan, side);
      const r = R[n] + (R[n + 1] - R[n]) * (u - n), dent = 1 + .05 * Math.sin(a * 2 + t * 5) * t;
      pos.push(c.x + (nrm.x * ca + side.x * sa) * r * dent, c.y + (nrm.y * ca + side.y * sa) * r * dent, c.z + (nrm.z * ca + side.z * sa) * r * dent);
    }
  }
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < COLS; j++) {
    const a = i * COLS + j, b = i * COLS + (j + 1) % COLS, d = a + COLS, e = b + COLS;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function bootGeometry() { // round toe, flat sole, the ankle at the origin
  const g = new THREE.SphereGeometry(1, 20, 14), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), toe = clamp01((x + 1) / 2);
    p.setXYZ(i, -.03 + (x + 1) * .125, -FOOT + Math.max(0, y + .35) / 1.35 * (.15 - .055 * toe), z * (.075 + .025 * toe));
  }
  g.computeVertexNormals();
  return g;
}

/**
 * makeWizard(root, cloth): adds the wizard to the avatar's root; returns update(rig). cloth: the material of everything worn (the player's colour).
 * rig: sR sL hR hL (shoulders, hands), legs [{ foot, toe }] (left, right), hip, leg, headQ, time, down; stick { base, dir, grip, hand }: the stick in the root
 * frame, grip 0..1 how far the free hand has come to it, hand 'R' | 'L' the hand on it.
 */
export function makeWizard(root, cloth) {
  const skin = new THREE.MeshStandardMaterial({ color: FACE, roughness: .8, metalness: 0, emissive: FACE, emissiveIntensity: .22 }); // stays a face in the hat's shade
  const eye = new THREE.MeshBasicMaterial({ color: EYE });
  const wiz = new THREE.Group(); wiz.name = 'wizard'; root.add(wiz);

  const ROWS = 11, COLS = 30, gown = grid(ROWS, COLS, cloth, wiz);
  const sleeves = [grid(7, 12, cloth, wiz), grid(7, 12, cloth, wiz)], legTubes = [grid(5, 10, cloth, wiz), grid(5, 10, cloth, wiz)];
  const boots = [0, 1].map(() => { const m = new THREE.Mesh(bootGeometry(), cloth); wiz.add(m); return m; });
  const hands = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), skin); wiz.add(m); return m; });
  const head = new THREE.Group(); wiz.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(HEAD, 28, 20), skin));
  for (const s of [-1, 1]) { const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), eye); m.position.set(.219, -.085, s * .085); m.scale.set(.016, .055, .028); head.add(m); }
  const hat = new THREE.Mesh(hatGeometry(), cloth); hat.position.set(-.005, .14, 0); hat.rotation.z = -.14; head.add(hat); // tipped forward: the brim comes down to just over the eyes

  const hip = V(), neck = V(), headC = V(), hemC = V(), tmp = V(), tmp2 = V(), toeD = V(), pole = V();
  const feet = [V(), V()], knees = [V(), V()], arm = Array.from({ length: 7 }, () => V()), elbow = V(), shoulder = V(), hand = V(), legPts = Array.from({ length: 5 }, () => V());
  const up = V(0, 1, 0), zAxis = V(0, 0, 1), qYaw = new THREE.Quaternion(), qTip = new THREE.Quaternion();
  const ringAt = (i, c, rx, rz, fold, tilt = 0) => { // tilt: how much the front is lifted
    for (let j = 0; j < COLS; j++) {
      const a = j / COLS * Math.PI * 2; let f = 0; for (const [n, w, p] of FOLDS) f += Math.sin(a * n + p) * w;
      const m = 1 + f * .05 * fold;
      gown.set(i, j, c.x + Math.cos(a) * rx * m, c.y + (Math.cos(a) + 1) / 2 * tilt, c.z + Math.sin(a) * rz * m);
    }
  };
  const SLEEVE = [.072, .074, .078, .085, .098, .115, .13];
  const pose = wiz.userData.pose = { low: 0, k: 1, floor: 0, knees, feet, hands: hands.map(h => h.position), head: headC };

  return function update(r) {
    const legs = r.legs, k = r.leg / STAND_LEG, footY = Math.min(legs[0].foot.y, legs[1].foot.y), floor = footY - .04;
    const low = Math.max(smooth((.92 - (r.hip.y - footY) / r.leg) / .47), smooth(r.down ?? 0)); // how far down the rig's hips have come: 0 standing, 1 kneeling; r.down: the same kneel for the loser
    const breath = .006 * k * Math.sin((r.time ?? 0) * 2.1);
    pose.low = low; pose.k = k; pose.floor = floor;
    hip.set(BODY_X - .05 * low * k, floor + (HIP + (LOW_HIP - HIP) * low) * k, 0);
    neck.set(BODY_X + .07 * low * k, floor + (NECK + (LOW_NECK - NECK) * low) * k + breath, 0);
    headC.set(neck.x + .02 * low * k, neck.y + .32 * k + breath * .5, 0);
    head.position.copy(headC); head.quaternion.copy(r.headQ); head.scale.setScalar(k);

    // the feet: stepping where the rig steps; kneeling, the left one flat in front and the right one behind on its toes
    legs.forEach((l, i) => {
      const f = feet[i], back = i === 1;
      f.set(BODY_X + (l.foot.x - r.hip.x) * .75, floor + FOOT * k + (l.foot.y - footY) * .8, l.foot.z * .95);
      tmp.set(back ? BODY_X - .4 * k : BODY_X + .2 * k, floor + (back ? .13 : FOOT) * k, (back ? .12 : -.13) * k);
      f.lerp(tmp, low);
      pole.set(1, back ? -.75 * low : .55 * low, 0);
      tmp2.set(hip.x, hip.y, (back ? .08 : -.08) * k);
      jointFor(knees[i], tmp2, f, LEG * k, pole);
      legPts[0].copy(tmp2); legPts[1].lerpVectors(tmp2, knees[i], .6); legPts[2].copy(knees[i]); legPts[3].lerpVectors(knees[i], f, .5); legPts[4].copy(f);
      tube(legTubes[i], legPts, [.09 * k, .08 * k, .068 * k, .062 * k, .058 * k], 10);
      toeD.subVectors(l.toe, l.foot); const yaw = low > .5 ? 0 : Math.atan2(-toeD.z, Math.max(.01, toeD.x));
      qYaw.setFromAxisAngle(up, yaw); qTip.setFromAxisAngle(zAxis, back ? -.95 * low : 0);
      boots[i].position.copy(f); boots[i].quaternion.copy(qYaw).multiply(qTip); boots[i].scale.setScalar(k);
    });

    // the gown, collar to hem. Its rings stay level; kneeling, the hem lies over the legs
    const hemY = floor + (.16 + .08 * low) * k, spread = Math.abs(feet[1].x - feet[0].x) / 2 * (1 - low); // kneeling, the back leg comes out from under it
    hemC.set(BODY_X + ((feet[0].x + feet[1].x) / 2 - BODY_X) * .75 * (1 - low) + .02 * low * k, hemY, 0);
    const rxHem = Math.max(.27 * k, spread * .78 + .13 * k), rzHem = .3 * k;
    ringAt(0, tmp.copy(neck).setY(neck.y + .06 * k), .075 * k, .085 * k, 0); // up inside the head: no gap under the chin
    ringAt(1, tmp.copy(neck).setY(neck.y - .005 * k), .105 * k, SHOULDER * .86 * k, 0);
    for (let i = 2; i < ROWS; i++) {
      const t = (i - 1) / (ROWS - 2), u = t * t * (1.5 - .5 * t);
      tmp.lerpVectors(neck, hemC, t);
      tmp.x += (hip.x - (neck.x + (hemC.x - neck.x) * .55)) * Math.sin(t * Math.PI) * .6; // the back rounds over the hips
      tmp.y = neck.y + (hemY - neck.y) * t;
      ringAt(i, tmp, (.115 + (rxHem / k - .115) * u) * k, (SHOULDER + .02 + (rzHem / k - SHOULDER - .02) * u) * k, t * 1.25, .16 * k * low * t * t); // kneeling, the raised knee lifts the front
    }
    gown.done();

    // the arms: the stick hand on the stick, the free one moving as the rig's does (from these shoulders) and coming to the stick for a charge
    const st = r.stick, g = st ? st.grip : 0;
    [[r.sR, r.hR, 1, 'R'], [r.sL, r.hL, -1, 'L']].forEach(([s, h, side, name], n) => {
      shoulder.set(neck.x - .005 * k, neck.y - .06 * k, side * SHOULDER * k);
      if (st && st.hand === name) hand.copy(st.base);
      else {
        hand.copy(shoulder).add(tmp.subVectors(h, s).multiplyScalar(k));
        if (st && g > 0) hand.lerp(tmp2.copy(st.base).addScaledVector(st.dir, -.17 * k), g);
      }
      pole.set(-.25, -1, .55 * side);
      jointFor(elbow, shoulder, hand, ARM * k, pole);
      arm[0].copy(shoulder); arm[1].lerpVectors(shoulder, elbow, .5); arm[2].copy(elbow); arm[3].lerpVectors(elbow, hand, .3); arm[4].lerpVectors(elbow, hand, .55); arm[5].lerpVectors(elbow, hand, .76); arm[6].lerpVectors(elbow, hand, .86);
      tube(sleeves[n], arm, SLEEVE.map(v => v * k), 12);
      hands[n].position.copy(hand); hands[n].scale.setScalar(.075 * k);
    });
  };
}
