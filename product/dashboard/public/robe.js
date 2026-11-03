// What the avatars wear: a dark brown hooded monk's robe with a shoulder cape, wide sleeves, a white rope belt and a wooden cross.
// The cloth is rebuilt every frame from the rig's points (field3d.js), in the avatar's root frame (x forward, y up, z right; metres):
// the hem opens with the feet, the sleeves follow the arms, the hood turns with the head. Only looks: the game knows nothing of it.
import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const STAND_LEG = .85; // m, the leg length the sizes below are written for
const FOLDS = [[7, .55, 1], [11, .3, 2.4], [17, .15, .7]]; // the skirt's folds around it: count, weight, phase

/** A tube of `rows` rings of `cols` points, its vertices rewritten by set(row, col, x, y, z). */
function grid(rows, cols, material, parent, closed = false) {
  const pos = new Float32Array(rows * cols * 3), idx = [], last = closed ? rows : rows - 1;
  for (let i = 0; i < last; i++) for (let j = 0; j < cols; j++) {
    const a = i * cols + j, b = i * cols + (j + 1) % cols, c = (i + 1) % rows * cols + j, d = (i + 1) % rows * cols + (j + 1) % cols;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)); g.setIndex(idx);
  const mesh = new THREE.Mesh(g, material); mesh.frustumCulled = false; parent.add(mesh);
  return { set(r, c, x, y, z) { const k = (r * cols + c) * 3; pos[k] = x; pos[k + 1] = y; pos[k + 2] = z; }, done() { g.attributes.position.needsUpdate = true; g.computeVertexNormals(); } };
}
/** A round tube along points: rings kept from twisting by carrying the side vector along. */
const _d = V(), _s = V(), _n = V();
function tube(t, points, radii, cols, closed = false) {
  const n = points.length; _s.set(0, 0, 1);
  for (let i = 0; i < n; i++) {
    const a = points[closed ? (i + n - 1) % n : Math.max(0, i - 1)], b = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    _d.subVectors(b, a); if (_d.lengthSq() < 1e-10) _d.set(0, -1, 0); _d.normalize();
    _s.addScaledVector(_d, -_s.dot(_d)); if (_s.lengthSq() < 1e-6) _s.set(1, 0, 0).addScaledVector(_d, -_d.x); _s.normalize();
    _n.crossVectors(_d, _s);
    for (let j = 0; j < cols; j++) {
      const q = j / cols * Math.PI * 2, u = Math.cos(q) * radii[i], v = Math.sin(q) * radii[i], p = points[i];
      t.set(i, j, p.x + _s.x * u + _n.x * v, p.y + _s.y * u + _n.y * v, p.z + _s.z * u + _n.z * v);
    }
  }
  t.done();
}
function hoodGeometry() { // round over the head, a point up and behind, narrow under the chin; the face's opening is a clean oval
  const ROWS = 26, COLS = 44, pos = [], idx = [];
  for (let i = 0; i <= ROWS; i++) for (let j = 0; j < COLS; j++) {
    const f = j / COLS * Math.PI * 2, t0 = .72 + .23 * Math.cos(f) ** 2, t = t0 + (Math.PI - t0) * i / ROWS; // angles from +x, the way the face looks
    const x = Math.cos(t), y = Math.sin(t) * Math.cos(f), z = Math.sin(t) * Math.sin(f), up = Math.max(0, y);
    pos.push(x * .15 * (1 - .28 * up) - .09 * up * up * up, y < 0 ? y * .125 : y * (1 + .3 * up * up) * .165, z * (y < 0 ? .14 : .148 * (1 - .3 * up)));
  }
  for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) {
    const a = i * COLS + j, b = i * COLS + (j + 1) % COLS, c = a + COLS, d = b + COLS;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** makeRobe(root): adds the robe to the avatar's root; returns update(rig). rig: sR eR hR sL eL hL, legs [{ hip, knee, foot }] (left, right), hip, leg, headAt, headQ. */
export function makeRobe(root) {
  const cloth = new THREE.MeshStandardMaterial({ color: 0x2c1e12, roughness: .96, metalness: 0, side: THREE.DoubleSide });
  const capeCloth = new THREE.MeshStandardMaterial({ color: 0x281b10, roughness: .96, metalness: 0, side: THREE.DoubleSide });
  const rope = new THREE.MeshStandardMaterial({ color: 0xe9e2d0, roughness: .9, metalness: 0 });
  const wood = new THREE.MeshStandardMaterial({ color: 0xc49a62, roughness: .7, metalness: 0 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc99d7e, roughness: .75, metalness: 0 });
  const shade = new THREE.MeshBasicMaterial({ color: 0x0b0806 });
  const robe = new THREE.Group(); robe.name = 'robe'; root.add(robe);

  const ROWS = 10, COLS = 28, gown = grid(ROWS, COLS, cloth, robe);
  const cape = grid(4, COLS, capeCloth, robe);
  const sleeves = [grid(7, 12, cloth, robe), grid(7, 12, cloth, robe)];
  const belt = grid(20, 6, rope, robe, true), cords = [grid(7, 5, rope, robe), grid(6, 5, rope, robe)];
  const knot = new THREE.IcosahedronGeometry(1, 1), knots = [0, 1, 2].map(() => { const m = new THREE.Mesh(knot, rope); robe.add(m); return m; });
  const hands = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), skin); robe.add(m); return m; });
  const hood = new THREE.Group(); robe.add(hood);
  hood.add(new THREE.Mesh(hoodGeometry(), Object.assign(cloth.clone(), { color: new THREE.Color(0x2e2013) })));
  const dark = new THREE.Mesh(new THREE.IcosahedronGeometry(.11, 3), shade); dark.position.set(-.002, -.008, 0); hood.add(dark); // the face stays in the hood's shadow
  const neck = grid(3, 12, cloth, robe), neckAt = [V(), V(), V()], neckDir = V(), headC = V();
  const cross = new THREE.Group(); robe.add(cross);
  const barV = new THREE.Mesh(new THREE.BoxGeometry(.02, .19, .03), wood), barH = new THREE.Mesh(new THREE.BoxGeometry(.02, .03, .12), wood); barH.position.y = .04;
  cross.add(barV, barH);

  const rows = Array.from({ length: ROWS }, () => ({ c: V(), x: V(), z: V(), rx: 0, rz: 0, fold: 0 }));
  const side = V(), hipSide = V(), up = V(0, 1, 0), mid = V(), waist = V(), F = V(), K = V(), hipAt = V(), tmp = V();
  const belts = Array.from({ length: 20 }, () => V()), cord = Array.from({ length: 7 }, () => V()), cord2 = Array.from({ length: 6 }, () => V()), arm = Array.from({ length: 7 }, () => V());
  const fwd = (out, z) => out.crossVectors(up, z).normalize();
  const put = (r, c, x0, z0, rx, rz, fold, y = 0) => { // one ring of the gown
    const q = rows[r]; q.c.copy(c); if (y) q.c.y += y;
    q.z.copy(z0); q.x.copy(x0); q.rx = rx; q.rz = rz; q.fold = fold;
  };
  const armRadii = [.078, .078, .082, .094, .112, .128, .132];
  return function update(r) {
    const legs = r.legs, leg = r.leg ?? legs.reduce((a, l) => a + l.hip.distanceTo(l.knee) + l.knee.distanceTo(l.foot), 0) / 2, k = leg / STAND_LEG;
    mid.addVectors(r.sR, r.sL).multiplyScalar(.5);
    side.subVectors(r.sR, r.sL); side.y = 0; const half = Math.max(.1, side.length() / 2); side.normalize();
    hipAt.copy(r.hip ?? tmp.set(-.1, -.5, 0));
    hipSide.subVectors(legs[1].hip, legs[0].hip); hipSide.y = 0; if (hipSide.lengthSq() < 1e-6) hipSide.set(0, 0, 1); hipSide.normalize();
    const shoulderF = V(), hipF = V(), bodyS = V().addVectors(side, hipSide).normalize(), bodyF = V();
    fwd(shoulderF, side); fwd(hipF, hipSide); fwd(bodyF, bodyS);
    F.addVectors(legs[0].foot, legs[1].foot).multiplyScalar(.5); K.addVectors(legs[0].knee, legs[1].knee).multiplyScalar(.5);
    const hemY = Math.min(legs[0].foot.y, legs[1].foot.y) - .055 * k, spreadZ = Math.abs(legs[1].foot.z - legs[0].foot.z) / 2, spreadX = Math.abs(legs[1].foot.x - legs[0].foot.x) / 2;
    waist.lerpVectors(hipAt, mid, .22);
    // the gown, from the collar to the hem. Its rings stay level; a bent body shifts their centres
    put(0, tmp.copy(mid), shoulderF, side, .06 * k, .066 * k, 0, .045 * k);
    put(1, tmp.copy(mid), shoulderF, side, .105 * k, half + .03 * k, 0, -.005 * k);
    put(2, tmp.lerpVectors(mid, waist, .4), shoulderF, side, .125 * k, Math.max(half, .17 * k) + .01 * k, .1);
    put(3, waist, bodyF, bodyS, .116 * k, .158 * k, .08);
    put(4, tmp.lerpVectors(waist, hipAt, .85), hipF, hipSide, .135 * k, .178 * k, .35);
    const hz = Math.max(.27 * k, spreadZ + .17 * k), hx = Math.max(.25 * k, spreadX + .17 * k);
    for (let i = 0; i < 5; i++) {
      const t = (i + 1) / 5, c = tmp;
      c.lerpVectors(hipAt, F, t); c.addScaledVector(K, 0); // straight down between the feet...
      const bulge = Math.sin(t * Math.PI); c.x += (K.x - (hipAt.x + F.x) / 2) * bulge * .85; // ...pushed out by bent knees
      c.y = hipAt.y + (hemY - hipAt.y) * t;
      const w = t * t * (3 - 2 * t);
      put(5 + i, c, hipF, hipSide, .135 * k + (hx - .135 * k) * w, .178 * k + (hz - .178 * k) * w, .55 + t * .85);
    }
    for (let i = 0; i < ROWS; i++) {
      const q = rows[i];
      for (let j = 0; j < COLS; j++) {
        const a = j / COLS * Math.PI * 2; let f = 0; for (const [n, w, p] of FOLDS) f += Math.sin(a * n + p) * w;
        const m = 1 + f * .055 * q.fold, ca = Math.cos(a) * q.rx * m, sa = Math.sin(a) * q.rz * m;
        gown.set(i, j, q.c.x + q.x.x * ca + q.z.x * sa, q.c.y + (i >= 5 ? Math.sin(a * 7 + i) * .004 * q.fold : 0), q.c.z + q.x.z * ca + q.z.z * sa);
      }
    }
    gown.done();
    // the shoulder cape
    const capeR = [[.066, .072, .05], [.13, half + .045 * k, .012], [.185, half + .105 * k, -.09], [.218, half + .14 * k, -.215]];
    capeR.forEach(([rx, rz, dy], i) => {
      const X = i ? rx * k : rx * k, Z = i ? rz : rz * k;
      for (let j = 0; j < COLS; j++) {
        const a = j / COLS * Math.PI * 2; let f = 0; for (const [n, w, p] of FOLDS) f += Math.sin(a * n + p) * w;
        const m = 1 + f * .035 * i, ca = Math.cos(a) * X * m, sa = Math.sin(a) * Z * m;
        cape.set(i, j, mid.x + shoulderF.x * ca + side.x * sa, mid.y + dy * k + (i === 3 ? Math.cos(a) * .02 : 0), mid.z + shoulderF.z * ca + side.z * sa);
      }
    });
    cape.done();
    // the sleeves: shoulder to elbow to a wide cuff short of the wrist
    [[r.sR, r.eR, r.hR], [r.sL, r.eL, r.hL]].forEach(([s, e, h], n) => {
      arm[0].copy(s); arm[1].lerpVectors(s, e, .5); arm[2].copy(e); arm[3].lerpVectors(e, h, .28); arm[4].lerpVectors(e, h, .55); arm[5].lerpVectors(e, h, .8); arm[6].lerpVectors(e, h, .92);
      tube(sleeves[n], arm, armRadii.map(v => v * k), 12);
      hands[n].position.copy(h); hands[n].scale.setScalar(.048 * k);
    });
    // the rope: around the waist, then two strands down the front with knots
    const wr = rows[3], fr = V(wr.x.x, 0, wr.x.z);
    belts.forEach((p, i) => { const a = i / 20 * Math.PI * 2, ca = Math.cos(a) * (wr.rx + .012 * k), sa = Math.sin(a) * (wr.rz + .012 * k); p.set(wr.c.x + wr.x.x * ca + wr.z.x * sa, wr.c.y, wr.c.z + wr.x.z * ca + wr.z.z * sa); });
    tube(belt, belts, belts.map(() => .0125 * k), 6, true);
    const frontOf = (i, off) => { const q = rows[i]; return tmp.copy(q.c).addScaledVector(q.x, q.rx * 1.03 + .012 * k).addScaledVector(q.z, off); };
    const strand = (pts, off, last) => { pts.forEach((p, i) => { const t = i / (pts.length - 1), at = 3 + t * last, a = Math.floor(at), b = Math.min(ROWS - 1, a + 1); p.copy(frontOf(a, off)); p.lerp(frontOf(b, off), at - a); }); };
    strand(cord, .012 * k, 3.2); tube(cords[0], cord, cord.map(() => .0105 * k), 5);
    strand(cord2, -.016 * k, 2.3); tube(cords[1], cord2, cord2.map(() => .0105 * k), 5);
    knots[0].position.copy(belts[0]); knots[0].scale.setScalar(.026 * k);
    knots[1].position.copy(cord[cord.length - 1]); knots[1].scale.setScalar(.02 * k);
    knots[2].position.copy(cord2[cord2.length - 1]); knots[2].scale.setScalar(.02 * k);
    // the hood turns with the head; the cross hangs on the chest
    // the head stands on the shoulders' middle, with a neck between: half up the line of the spine (a bent body takes it along), half straight up
    neckDir.subVectors(mid, hipAt).normalize(); neckDir.y += 1; neckDir.normalize();
    headC.copy(mid).addScaledVector(neckDir, .165 * k);
    hood.position.copy(headC); hood.quaternion.copy(r.headQ); hood.scale.setScalar(k);
    neckAt[0].copy(mid).addScaledVector(neckDir, .02 * k); neckAt[1].copy(mid).addScaledVector(neckDir, .06 * k); neckAt[2].copy(headC).addScaledVector(neckDir, -.07 * k);
    tube(neck, neckAt, [.066 * k, .056 * k, .058 * k], 12);
    const ch = rows[2];
    cross.position.copy(ch.c).addScaledVector(ch.x, ch.rx + .012 * k); cross.position.y += .015 * k;
    cross.quaternion.setFromUnitVectors(V(1, 0, 0), ch.x); cross.scale.setScalar(k);
  };
}
