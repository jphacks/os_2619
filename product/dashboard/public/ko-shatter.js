// KO: the beaten player's character breaks into pieces. The pose it had at the blow is baked (skinned meshes included), each triangle
// goes with the body part it is skinned to, and each part flies off as its own piece: out from the blow and up, spinning, bouncing on the
// floor (y = 0), then shrinking away. One piece per body part (about ten, split at the joints by the skin's bone weights). Only looks: the game knows nothing of it. step(dt) takes the caller's (slowed) time.
import * as THREE from 'three';

export const SHATTER = {
  speed: [3.5, 7.5], // m/s out from the blow
  push: 2.5,         // m/s more along the blow's direction
  up: [3, 6.5],      // m/s upwards
  spin: [6, 16],     // rad/s
  g: 16,             // m/s², more than real: it reads as heavy and quick
  bounce: .3, friction: .7,
  life: 2.6,         // s until a piece is gone
  shrink: .6,        // s of shrinking at the end of the life
  flash: .35,        // s of white-hot glow at the start
};
// One piece per body part, roughly at the joints (the two models' bone names, wizard.glb / chaoben.glb): about ten pieces
const SEG = { Neck: 'head', Head: 'head', L_Upperarm: 'armUL', R_Upperarm: 'armUR', L_Forearm: 'armFL', L_Hand: 'armFL', R_Forearm: 'armFR', R_Hand: 'armFR',
  L_Thigh: 'thighL', R_Thigh: 'thighR', L_Calf: 'shinL', L_Foot: 'shinL', R_Calf: 'shinR', R_Foot: 'shinR' }; // anything else (hips, spine, clavicles, skirt): the trunk

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _v = V(), _q = new THREE.Quaternion();

function shown(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }

/** The visible meshes under roots, baked to world space: [{ material, pos: number[] (xyz per corner), uv: number[] | null, seg: string[] (per triangle) }] */
export function bakeTriangles(roots) {
  const out = [];
  for (const root of roots) {
    root.updateWorldMatrix(true, false); root.updateMatrixWorld(true); // updateMatrixWorld: a skinned mesh's bindMatrixInverse follows it there only
    root.traverse(o => {
      if (!o.isMesh || !shown(o) || !o.geometry?.attributes.position) return;
      const g = o.geometry, idx = g.index, n = idx ? idx.count : g.attributes.position.count, uvA = g.attributes.uv;
      const pos = new Array(n * 3), uv = uvA ? new Array(n * 2) : null, seg = new Array(n / 3);
      const sI = o.isSkinnedMesh && g.attributes.skinIndex, sW = o.isSkinnedMesh && g.attributes.skinWeight, bones = o.skeleton?.bones, w = new Map();
      for (let k = 0; k < n; k++) {
        const i = idx ? idx.getX(k) : k;
        if (o.isSkinnedMesh) o.getVertexPosition(i, _v); else _v.fromBufferAttribute(g.attributes.position, i);
        _v.applyMatrix4(o.matrixWorld);
        pos[3 * k] = _v.x; pos[3 * k + 1] = _v.y; pos[3 * k + 2] = _v.z;
        if (uv) { uv[2 * k] = uvA.getX(i); uv[2 * k + 1] = uvA.getY(i); }
        if (sI) for (let j = 0; j < 4; j++) { const s = SEG[bones[sI.getComponent(i, j)]?.name] ?? 'trunk'; w.set(s, (w.get(s) ?? 0) + sW.getComponent(i, j)); }
        if (k % 3 === 2) { // the part with the most weight on the triangle's corners
          let best = 'trunk', bw = -1; for (const [s, v] of w) if (v > bw) { best = s; bw = v; }
          seg[(k - 2) / 3] = sI ? best : o.uuid; w.clear(); // an unskinned mesh (the stick, the fallback figure's parts) is a piece of its own
        }
      }
      out.push({ material: Array.isArray(o.material) ? o.material[0] : o.material, pos, uv, seg });
    });
  }
  return out;
}

/** The baked triangles gathered into body parts: [{ center: Vector3, parts: [{ material, pos: Float32Array (around center), uv }] }] */
export function chunk(parts) {
  const segs = new Map(); // seg -> Map(part -> triangle indices)
  for (const part of parts) part.seg.forEach((s, t) => {
    let m = segs.get(s); if (!m) segs.set(s, m = new Map());
    let l = m.get(part); if (!l) m.set(part, l = []);
    l.push(t);
  });
  const pieces = [];
  for (const m of segs.values()) {
    const center = V(); let n = 0;
    for (const [part, tris] of m) for (const t of tris) for (let k = 0; k < 9; k += 3) { center.x += part.pos[9 * t + k]; center.y += part.pos[9 * t + k + 1]; center.z += part.pos[9 * t + k + 2]; n++; }
    center.divideScalar(n);
    pieces.push({ center, parts: [...m].map(([part, tris]) => {
      const P = part.pos, pos = new Float32Array(tris.length * 9), uv = part.uv ? new Float32Array(tris.length * 6) : null;
      tris.forEach((t, j) => {
        for (let k = 0; k < 3; k++) {
          pos[9 * j + 3 * k] = P[9 * t + 3 * k] - center.x; pos[9 * j + 3 * k + 1] = P[9 * t + 3 * k + 1] - center.y; pos[9 * j + 3 * k + 2] = P[9 * t + 3 * k + 2] - center.z;
          if (uv) { uv[6 * j + 2 * k] = part.uv[6 * t + 2 * k]; uv[6 * j + 2 * k + 1] = part.uv[6 * t + 2 * k + 1]; }
        }
      });
      return { material: part.material, pos, uv };
    }) });
  }
  return pieces;
}

const rand = ([a, b], r) => a + (b - a) * r();

/**
 * createShatter(parent, { random }) -> { burst(roots, at, dir), step(dt), clear(), get count }
 * burst: breaks what is shown under roots (Object3D[]) at world point at, the blow going along dir (Vector3, may be zero).
 */
export function createShatter(parent, { random = Math.random } = {}) {
  const group = new THREE.Group(); group.name = 'ko-shatter'; parent.add(group);
  const pieces = [], mats = new Map(); // source material -> its glowing copy (the map is shared, never disposed here)
  function matFor(src) {
    if (!mats.has(src)) {
      const m = src.clone(); m.side = THREE.DoubleSide; m.wireframe = false; m.transparent = false; m.opacity = 1;
      if (m.emissive) { m.userData.baseEmissive = m.emissive.clone(); m.userData.baseIntensity = m.emissiveIntensity ?? 1; } // a MeshBasicMaterial has no emissive (nor the uniform for it): no glow
      mats.set(src, m);
    }
    return mats.get(src);
  }
  function remove(p) { group.remove(p.mesh); for (const m of p.mesh.children) m.geometry.dispose(); }
  let age = 0;
  // the blast around the break: a hot ball, two shock rings racing out along the floor, a pillar of light, all in the blow's colour (additive)
  const blastMat = c => new THREE.MeshBasicMaterial({ color: c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const BALL = new THREE.SphereGeometry(1, 24, 12), RING = new THREE.RingGeometry(.86, 1, 64).rotateX(-Math.PI / 2), PILLAR = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, .5, 0);
  const blasts = []; // { mesh, t, life, grow(k) }
  let onTrail = null, trailAt = 0;
  function blast(geo, color, life, delay, grow) {
    const mesh = new THREE.Mesh(geo, blastMat(color)); mesh.visible = false; mesh.renderOrder = 5; group.add(mesh);
    blasts.push({ mesh, t: -delay, life, grow });
  }
  return {
    group,
    /** opt: { color (the blast, a CSS colour or number; none: no blast), trail(pos) called for each flying piece every ~0.07 s of its first second (sparks behind it) } */
    burst(roots, at, dir = V(), { color = null, trail = null } = {}) {
      onTrail = trail; trailAt = 0;
      if (color != null) {
        const c = new THREE.Color(color), white = new THREE.Color(1, 1, 1), floor = V(at.x, .03, at.z);
        blast(BALL, white, .26, 0, (m, k) => { m.position.copy(at); m.scale.setScalar(.15 + 1.3 * Math.pow(k, .4)); m.material.opacity = .8 * (1 - k) * (1 - k); m.material.color.copy(white).lerp(c, k); }); // small: the pieces must show through it
        blast(RING, c, .9, 0, (m, k) => { m.position.copy(floor); m.scale.setScalar(.3 + 11 * (1 - Math.pow(1 - k, 3))); m.material.opacity = 1 - k; });
        blast(RING, white, .7, .12, (m, k) => { m.position.copy(floor); m.scale.setScalar(.3 + 7 * (1 - Math.pow(1 - k, 3))); m.material.opacity = .8 * (1 - k); });
        blast(PILLAR, c, .75, 0, (m, k) => { m.position.set(at.x, 0, at.z); m.scale.set(.9 * (1 - k) + .05, 40, .9 * (1 - k) + .05); m.material.opacity = Math.min(1, 3 * (1 - k)); });
      }
      const chunks = chunk(bakeTriangles(roots));
      const d = dir.clone().setY(0); if (d.lengthSq() > 1e-6) d.normalize();
      age = 0;
      for (const c of chunks) {
        const obj = new THREE.Group(); obj.position.copy(c.center); let r = 0;
        for (const part of c.parts) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(part.pos, 3));
          if (part.uv) geo.setAttribute('uv', new THREE.BufferAttribute(part.uv, 2));
          geo.computeVertexNormals(); geo.computeBoundingSphere(); r = Math.max(r, geo.boundingSphere.center.length() + geo.boundingSphere.radius);
          obj.add(new THREE.Mesh(geo, matFor(part.material)));
        }
        const out = c.center.clone().sub(at).setY(0); if (out.lengthSq() < 1e-6) out.set(random() - .5, 0, random() - .5); out.normalize();
        const vel = out.multiplyScalar(rand(SHATTER.speed, random)).addScaledVector(d, SHATTER.push); vel.y += rand(SHATTER.up, random) * (.6 + .4 * Math.min(1, c.center.y / 1.5)); // the head flies higher than the boots
        const axis = V(random() - .5, random() - .5, random() - .5).normalize();
        pieces.push({ mesh: obj, vel, axis, spin: rand(SHATTER.spin, random), life: SHATTER.life * (.85 + .3 * random()), t: 0, r });
        group.add(obj);
      }
    },
    step(dt) {
      age += dt;
      for (let i = blasts.length - 1; i >= 0; i--) {
        const b = blasts[i]; b.t += dt;
        if (b.t >= b.life) { group.remove(b.mesh); b.mesh.material.dispose(); blasts.splice(i, 1); continue; }
        if (b.t >= 0) { b.mesh.visible = true; b.grow(b.mesh, b.t / b.life); }
      }
      if (onTrail && age < 1.1 && age - trailAt >= .07) { trailAt = age; for (const p of pieces) if (p.mesh.position.y > p.r * .5 + .05) onTrail(p.mesh.position); }
      const glow = Math.max(0, 1 - age / SHATTER.flash);
      for (const m of mats.values()) if (m.emissive) { m.emissive.copy(m.userData.baseEmissive).lerp(new THREE.Color(1, 1, 1), glow); m.emissiveIntensity = m.userData.baseIntensity + 2.5 * glow; }
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i], m = p.mesh; p.t += dt;
        if (p.t >= p.life) { remove(p); pieces.splice(i, 1); continue; }
        p.vel.y -= SHATTER.g * dt;
        m.position.addScaledVector(p.vel, dt);
        m.quaternion.premultiply(_q.setFromAxisAngle(p.axis, p.spin * dt));
        const floor = p.r * .4 * m.scale.x;
        if (m.position.y < floor) { // bounce, and lose spin and slide on the floor
          m.position.y = floor;
          if (p.vel.y < 0) p.vel.y *= -SHATTER.bounce;
          p.vel.x *= SHATTER.friction; p.vel.z *= SHATTER.friction; p.spin *= .6;
          if (Math.abs(p.vel.y) < .3) p.vel.y = 0;
        }
        m.scale.setScalar(Math.max(.001, Math.min(1, (p.life - p.t) / SHATTER.shrink)));
      }
    },
    clear() { for (const p of pieces) remove(p); pieces.length = 0; for (const b of blasts) { group.remove(b.mesh); b.mesh.material.dispose(); } blasts.length = 0; onTrail = null; },
    get count() { return pieces.length; },
    dispose() { this.clear(); for (const m of mats.values()) m.dispose(); mats.clear(); parent.remove(group); },
  };
}
