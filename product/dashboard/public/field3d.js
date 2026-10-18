// Stylized arena for the 3D / drone views: floor, boundary line painted along FIELD.poly, start rings, the tags with their real images,
// two team-coloured avatars posed from the players' body / stick, and a 2D top-down minimap.
// Everything lives in one group the integrator shows only in 3D views; effects.js renders on top (no depth test).
// World frame and layout: world.js (metres, y up, origin floor centre). Body frame: x forward, y up, z right.
import * as THREE from 'three';
import * as W from './world.js';
import { tagCanvas } from './dummycam.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v3 = a => V(a[0], a[1], a[2]);
const m4 = p => new THREE.Matrix4().set(p.R[0], p.R[1], p.R[2], p.t[0], p.R[3], p.R[4], p.R[5], p.t[1], p.R[6], p.R[7], p.R[8], p.t[2], 0, 0, 0, 1);
export const TEAM = { A: 0xff3b3b, B: 0x2fd46a };
const css = c => '#' + c.toString(16).padStart(6, '0');
const UP = V(0, 1, 0);

function canvasTex(w, h, draw) {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
/** Text label sprite, `h` metres tall. */
function label(text, color, h = .14) {
  const tex = canvasTex(256, 96, (g, w, hh) => {
    g.font = '700 60px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(text).width + 40;
    g.fillStyle = 'rgba(8,10,16,.72)'; g.beginPath(); g.roundRect((w - tw) / 2, 12, tw, hh - 24, 18); g.fill();
    g.fillStyle = color; g.fillText(text, w / 2, hh / 2 + 2);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(h * 256 / 96, h, 1);
  limitSprite(s, { near: 1.2, behindNear: 1.2 });
  return s;
}

/**
 * Per camera, just before drawing: shrink a sprite so it covers at most `maxFrac` of the view height, and fade it out
 * when the camera is within `near` m (or `behindNear` m when behind `facing`, a world Vector3 or null).
 */
const _cp = V(), _sp = V();
function limitSprite(s, { maxFrac = .12, near = 2, behindNear = 3.5, facing = null } = {}) {
  const w0 = s.scale.x, h0 = s.scale.y, op0 = s.material.opacity;
  s.onBeforeRender = (r, sc, cam) => {
    s.getWorldPosition(_sp); _cp.setFromMatrixPosition(cam.matrixWorld);
    const d = _cp.distanceTo(_sp);
    const behind = facing && _cp.sub(_sp).dot(facing) < 0, fadeAt = behind ? behindNear : near; // behind: the bar sits between camera and action
    const k = cam.isPerspectiveCamera ? Math.min(1, (behind ? .6 : 1) * maxFrac * 2 * d * Math.tan(cam.fov * Math.PI / 360) / cam.zoom / h0) : 1;
    const a = THREE.MathUtils.clamp((d - fadeAt * .6) / (fadeAt * .4), 0, 1);
    s.scale.set(w0 * k, h0 * k, 1); s.updateMatrixWorld();
    s.material.opacity = op0 * a;
  };
  s.onAfterRender = () => { s.scale.set(w0, h0, 1); };
}

// ---- the field outline (world.js FIELD.poly) and a cheap signature of everything drawn from it ----
const MAXP = 8; // outline vertices the floor shader takes (a scanned map4 field has 4)
/** Extent of the field: bbox, radius from the origin and the vertices. Recomputed on change, never per frame. */
export function fieldExtent(poly = W.FIELD.poly) {
  const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), R: Math.max(...poly.map(p => Math.hypot(p[0], p[1]))), poly };
}
/** Changes whenever setField / setFloorSep moved the outline, a tag or a start mark (both mutate in place). No allocation. */
export function fieldSig() {
  let h = W.FIELD.poly.length + W.START.A.pos[0] * 7 + W.START.B.pos[0] * 13;
  for (let i = 0; i < W.FIELD.poly.length; i++) h = h * 1.618 + W.FIELD.poly[i][0] * 3.1 + W.FIELD.poly[i][1] * 5.7;
  for (let i = 0; i < W.CORNER_IDS.length; i++) { const t = W.TAGS[W.CORNER_IDS[i]]; h = h * 1.618 + t.pos[0] * 2.3 + t.pos[2] * 4.1 + (t.yaw ?? 0) * 6.7 + (t.flip ? 1 : 0) + (t.floor ? 2 : 0); }
  return h;
}

// ---- floor: one quad, everything analytic (grid, boundary glow, centre line, start rings, player shadows + HP arcs) ----
const FLOOR_VS = `
varying vec2 vP;
void main() { vec4 w = modelMatrix * vec4(position, 1.); vP = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FLOOR_FS = `
uniform float uTime, uR; uniform vec2 uX; uniform vec2 uPoly[${MAXP}]; uniform int uN;
uniform vec4 uP[2]; uniform vec3 uCA, uCB; uniform vec2 uSA, uSB;
varying vec2 vP;
float aline(float d, float px) { return 1. - smoothstep(.5 * px, 1.5 * px, d); } // ~1.5 px wide line at distance d (px units)
float gridAt(vec2 p, float s) { vec2 q = p / s, g = abs(fract(q - .5) - .5) / fwidth(q); return 1. - min(min(g.x, g.y) / 1.2, 1.); }
float ring(vec2 p, vec2 c, float r, float w) { float d = abs(length(p - c) - r); return 1. - smoothstep(w * .5, w * .5 + fwidth(d) * 1.5, d); }
float sdPoly(vec2 p) { // signed distance to the outline, < 0 inside (any simple polygon, either winding)
  vec2 a = uPoly[uN - 1]; float d = 1e9, s = 1.;
  for (int i = 0; i < ${MAXP}; i++) {
    if (i >= uN) break;
    vec2 b = uPoly[i], e = a - b, w = p - b, q = w - e * clamp(dot(w, e) / dot(e, e), 0., 1.);
    d = min(d, dot(q, q));
    bvec3 c = bvec3(p.y >= b.y, p.y < a.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
    a = b;
  }
  return s * sqrt(d);
}
void main() {
  vec2 p = vP; float r = length(p), d = sdPoly(p), inside = step(d, 0.);
  vec3 team = p.x < 0. ? uCA : uCB;
  vec3 c = mix(vec3(.028, .034, .052), vec3(.05, .06, .09), inside);
  c += inside * vec3(.035, .04, .06) * exp(-r * r / 5.);                                           // soft centre spot
  c += mix(vec3(.04, .05, .08), vec3(.10, .12, .17), inside) * gridAt(p, .5) * (inside > .5 ? 1. : exp(-d * .8));
  c += inside * vec3(.07, .08, .11) * gridAt(p, 1.);
  // boundary: a line painted on the floor, 6 cm wide (no wall, no posts)
  c += team * (1. - smoothstep(.03, .03 + fwidth(d) * 1.5, abs(d)));
  // centre line (dashed, x = 0 runs across the field between the A and B halves) and circle
  float dash = step(.45, fract(p.y * 2.5 + uTime * .3));
  c += inside * vec3(.55, .6, .7) * aline(abs(p.x) / fwidth(p.x), .7) * dash * .5;
  c += inside * vec3(.35, .4, .5) * ring(p, vec2(0.), .6, .008) * .5;
  // start rings
  c += uCA * ring(p, uSA, .32, .01) * .8;
  c += uCB * ring(p, uSB, .32, .01) * .8;
  // players: contact shadow, team ring with HP arc (from -z, clockwise seen from above)
  for (int i = 0; i < 2; i++) {
    vec4 P = uP[i]; if (P.w <= 0.) continue;
    vec3 tc = i == 0 ? uCA : uCB;
    vec2 q = p - P.xy; float dq = length(q);
    c *= 1. - .7 * exp(-dq * dq / .045) * P.w;
    float a = fract(atan(q.x, -q.y) / 6.2831853 + .5);
    float on = step(a, P.z);
    c += tc * ring(p, P.xy, .46, .015) * mix(.15, 1., on) * P.w;
  }
  float alpha = 1. - smoothstep(uR + 1.4, uR + 5.7, r);
  gl_FragColor = vec4(c, alpha);
}`;

function makeFloor(uniforms) { // unit quad, scaled to the field on rebuild
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, uniforms, transparent: true, depthWrite: true,
    extensions: { derivatives: true },
  }));
  floor.rotation.x = -Math.PI / 2; floor.renderOrder = -1;
  return floor;
}
function floorText(text, color, x, z) { // big flat letter on the floor, upright seen from +z
  const tex = canvasTex(128, 128, (g, w, h) => { g.font = '900 100px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color; g.fillText(text, w / 2, h / 2 + 6); });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(.5, .5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: .55, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, .004, z);
  return m;
}

// ---- tags: tag plane exactly at worldTagPose (flip / floor yaw respected); standing ones get a board and pole in an
// upright frame (as dummycam), floor sheets lie flat with their paper ----
const TAG_TEX = {}; // per id, kept across rebuilds
const tagTex = id => {
  if (TAG_TEX[id]) return TAG_TEX[id];
  const t = new THREE.CanvasTexture(tagCanvas(id, 16)); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.anisotropy = 4;
  return (TAG_TEX[id] = t);
};
function disposeTree(root) { // geometries / materials / textures made for one build (shared ones are kept)
  root.traverse(o => {
    if (o.geometry && !o.isSprite && o.geometry !== CYL && o.geometry !== JOINT) o.geometry.dispose(); // sprites share three's quad
    if (o.material) { const m = o.material; if (m.map && !Object.values(TAG_TEX).includes(m.map)) m.map.dispose(); m.dispose(); }
  });
}
function makeTags(debugGroup) {
  const g = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a93a3, metalness: .5, roughness: .4 });
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: .7 });
  const footMat = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: .8 });
  const paperMat = new THREE.MeshBasicMaterial({ color: 0xc8ccd4 });
  for (const id of W.CORNER_IDS) {
    const tp = W.worldTagPose(id), s = W.TAGS[id].size;
    const up = tp.R[4] > 0 ? tp : W.pose(W.mul3(tp.R, [-1, 0, 0, 0, -1, 0, 0, 0, 1]), tp.t);
    const gt = new THREE.Group(), gu = new THREE.Group();
    gt.matrixAutoUpdate = gu.matrixAutoUpdate = false; gt.matrix.copy(m4(tp)); gu.matrix.copy(m4(up));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(s * 10 / 8, s * 10 / 8), new THREE.MeshBasicMaterial({ map: tagTex(id), color: 0xe8e8e8 }));
    face.position.z = .002; gt.add(face);
    const ax = new THREE.AxesHelper(s * 1.2); ax.matrixAutoUpdate = false; ax.matrix.copy(m4(tp)); debugGroup.add(ax);
    if (W.TAGS[id].floor) { // a sheet lying on the floor: the paper (caption margin on the tag's -y edge), the tag, a label above
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(s * 1.25 + .04, s * 1.25 + .1), paperMat); paper.position.set(0, -.03, .001); gt.add(paper);
      const lab = label('ID ' + id, '#e8eefc', .13); lab.position.set(0, 0, .3); gt.add(lab);
      g.add(gt); continue;
    }
    const board = new THREE.Mesh(new THREE.BoxGeometry(s * 1.6, s * 1.6, .015), boardMat); board.position.z = -.007;
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(s * 1.6 + .03, s * 1.6 + .03), new THREE.MeshBasicMaterial({ color: 0xbfd4ff, transparent: true, opacity: .35, side: THREE.DoubleSide }));
    edge.position.z = -.016;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, W.CHEST_H + .3, 8), poleMat); pole.position.set(0, (.3 - W.CHEST_H) / 2, -.035);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(.16, .19, .03, 16), footMat); foot.position.set(0, .015 - W.CHEST_H, -.035);
    const glow = new THREE.Mesh(new THREE.RingGeometry(.2, .24, 24), new THREE.MeshBasicMaterial({ color: 0x9fc0ff, transparent: true, opacity: .5, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.set(0, .006 - W.CHEST_H, -.035);
    const lab = label('ID ' + id, '#e8eefc', .13); lab.position.set(0, s * .8 + .13, 0);
    gu.add(board, edge, pole, foot, glow, lab);
    g.add(gt, gu);
  }
  return g;
}

// ---- avatar ----
const between = (m, a, b) => { // unit-height y-axis mesh from a to b
  const d = V().subVectors(b, a), L = Math.max(d.length(), 1e-4);
  m.position.copy(a).addScaledVector(d, .5); m.scale.set(1, L, 1);
  m.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / L));
};
const CYL = new THREE.CylinderGeometry(1, 1, 1, 6); // scaled per limb
const JOINT = new THREE.IcosahedronGeometry(1, 0);
const UPPER = .3, FORE = .3, SHOULDER = [-.1, .07, .21], HIP = [-.1, -.5, .1];
// Standing chest height (m, the phone's mount) sets the body's size; a lower chest is a crouch, never a smaller body.
// People differ, so it is read off the player: the chest height in the first CAPTURE s it is seen (they start standing),
// again after the phone's calibrate. Later only a chest held higher raises it (slowly: a one-frame AR jump does not).
const TALL_MIN = .95, TALL_MAX = 1.7, CAPTURE = .4, TORSO = -HIP[1];
// POSE.show false: the avatars stand upright and follow only the sensors' position and heading (no camera pose, no crouch),
// to check the position on its own. True: the camera pose shapes the body (it never moves it: see poseUpdate).
export const POSE = { show: true };
const legLen = tall => (tall + HIP[1] - .04) * .97; // hip to sole, standing: a little short, so a standing knee stays straight through the breathing bob (3 % longer bent it ~28°, which read as half-crouched)

// The body that is drawn: a wireframe human (three.js's Xbot, a Mixamo rig), loaded once and cloned per avatar. Its bones aim
// at the points the avatar code below computes (those primitive meshes stay hidden and only serve as the rig).
const FIG = Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/utils/SkeletonUtils.js')])
  .then(([{ GLTFLoader }, SU]) => new GLTFLoader().loadAsync(new URL('./assets/models/Xbot.glb', import.meta.url).href)
    .then(g => (mat, root) => makeFig(SU.clone(g.scene), mat, root)))
  .catch(e => { if (typeof window.fetch === 'function' && document.body) console.warn('avatar model:', e); return null; });
const AIM = ['RightArm', 'RightForeArm', 'LeftArm', 'LeftForeArm', 'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'];
function makeFig(obj, mat, root) {
  const b = {};
  obj.traverse(o => { if (o.isBone) b[o.name.replace(/^mixamorig:?/, '')] = o; if (o.isMesh) { o.material = mat; o.frustumCulled = false; } });
  obj.updateMatrixWorld(true);
  const wp = n => b[n].getWorldPosition(V()), hipM = wp('LeftUpLeg').add(wp('RightUpLeg')).multiplyScalar(.5);
  const leg = wp('LeftUpLeg').distanceTo(wp('LeftLeg')) + wp('LeftLeg').distanceTo(wp('LeftFoot'));
  const headBind = b.Head.getWorldQuaternion(new THREE.Quaternion()); // the head's turn in the model's own frame
  const bind = Object.fromEntries(AIM.map(n => [n, b[n].quaternion.clone()]));
  obj.quaternion.setFromAxisAngle(UP, Math.PI / 2); // model: +z forward, +x its left -> body frame: +x forward, +z right
  root.add(obj);
  const pq = new THREE.Quaternion(), wq = new THREE.Quaternion(), dq = new THREE.Quaternion(), cur = V(), tgt = V();
  function aim(n, from, to) { // turn bone n from its bind pose so its child lies along from -> to (root-frame points)
    const bone = b[n]; bone.quaternion.copy(bind[n]);
    if (to.distanceToSquared(from) < 1e-8) return;
    bone.parent.getWorldQuaternion(pq); wq.multiplyQuaternions(pq, bone.quaternion);
    cur.copy(bone.children[0].position).normalize().applyQuaternion(wq);
    tgt.subVectors(to, from).transformDirection(root.matrixWorld);
    dq.setFromUnitVectors(cur, tgt);
    bone.quaternion.copy(pq.invert().multiply(dq.multiply(wq)));
    bone.updateMatrixWorld(true);
  }
  const spineBind = b.Spine.quaternion.clone(), lq = new THREE.Quaternion(), rq = new THREE.Quaternion();
  return function pose(r) { // r: root-frame points of the rig, headQ the head's turn in the body frame
    // size: r.leg (the standing leg, fixed per player: a crouch bends the knees instead of shrinking the body), else the rig's
    // own leg bones (the camera pose: the person's measured bones, which a crouch does not shorten either)
    const sc = (r.leg ?? r.legs.reduce((a, l) => a + l.hip.distanceTo(l.knee) + l.knee.distanceTo(l.foot), 0) / 2) / leg, hip = r.hip ?? V(HIP[0], HIP[1], 0);
    obj.scale.setScalar(sc); obj.position.set(hip.x, hip.y, 0).sub(tgt.copy(hipM).multiplyScalar(sc).applyQuaternion(obj.quaternion));
    root.updateWorldMatrix(true, true);
    b.Spine.quaternion.copy(spineBind);
    if (r.lean) { // bend forward at the waist: turn the spine about the body's right axis (+z), in world terms
      b.Spine.parent.getWorldQuaternion(pq); root.getWorldQuaternion(rq);
      lq.setFromAxisAngle(V(0, 0, 1), -r.lean).premultiply(rq).multiply(rq.clone().invert()); // the turn, in the world frame
      wq.multiplyQuaternions(pq, spineBind); // the spine's bind turn, in the world frame
      b.Spine.quaternion.copy(pq.invert().multiply(lq.multiply(wq)));
      b.Spine.updateMatrixWorld(true);
    }
    aim('RightArm', r.sR, r.eR); aim('RightForeArm', r.eR, r.hR); aim('LeftArm', r.sL, r.eL); aim('LeftForeArm', r.eL, r.hL);
    for (const [side, l] of [['Right', r.legs[1]], ['Left', r.legs[0]]]) {
      aim(side + 'UpLeg', l.hip, l.knee); aim(side + 'Leg', l.knee, l.foot); aim(side + 'Foot', l.foot, l.toe);
    }
    b.Head.parent.getWorldQuaternion(pq); root.getWorldQuaternion(wq);
    b.Head.quaternion.copy(pq.invert().multiply(wq.multiply(r.headQ).multiply(obj.quaternion).multiply(headBind)));
  };
}

function makeAvatar(slot) {
  const color = TEAM[slot], root = new THREE.Group(), world = new THREE.Group();
  root.matrixAutoUpdate = false;
  const suit = new THREE.MeshStandardMaterial({ color, roughness: .55, metalness: .1, flatShading: true, emissive: color, emissiveIntensity: .12 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x252a36, roughness: .7, flatShading: true });
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.4) });
  const visorMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mesh = (geo, mat, parent = root) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };
  const limb = (r, mat, parent) => { const m = mesh(CYL, mat, parent); m.userData.r = r; return m; };
  const setLimb = (m, a, b) => { between(m, a, b); m.scale.x = m.scale.z = m.userData.r; };
  const joint = (r, mat, parent = root) => { const m = mesh(JOINT, mat, parent); m.scale.setScalar(r); return m; };

  const torso = mesh(new THREE.CylinderGeometry(.2, .15, .56, 7), suit); torso.scale.set(.72, 1, 1); torso.position.set(-.1, -.18, 0);
  const belt = mesh(new THREE.CylinderGeometry(.155, .155, .06, 7), dark); belt.scale.set(.75, 1, 1); belt.position.set(-.1, -.44, 0);
  const pelvis = mesh(new THREE.BoxGeometry(.2, .14, .3), dark); pelvis.position.set(-.1, -.53, 0);
  const emblem = mesh(new THREE.CircleGeometry(.055, 6), glow); emblem.position.set(-.1 + .2 * .72 + .004, -.03, 0); emblem.rotation.y = Math.PI / 2;
  const headG = new THREE.Group(); headG.position.set(-.09, .3, 0); root.add(headG);
  mesh(new THREE.IcosahedronGeometry(.13, 1), suit, headG).scale.set(1, 1.08, .95);
  const visor = mesh(new THREE.BoxGeometry(.05, .045, .17), visorMat, headG); visor.position.set(.105, .015, 0);
  mesh(new THREE.ConeGeometry(.035, .14, 4), glow, headG).position.set(-.01, .17, 0); // crest: shows facing from above
  joint(.07, suit).position.set(...SHOULDER);
  joint(.07, suit).position.set(SHOULDER[0], SHOULDER[1], -SHOULDER[2]);
  const armU = limb(.045, suit), armF = limb(.04, suit), elbow = joint(.045, suit), hand = joint(.05, dark);
  const offU = limb(.045, suit), offF = limb(.04, suit), offE = joint(.045, suit), offH = joint(.05, dark);
  const legs = [-1, 1].map(s => ({ s, thigh: limb(.07, dark), shin: limb(.06, dark), knee: joint(.065, dark), boot: mesh(new THREE.BoxGeometry(.22, .08, .11), suit) }));
  // stick (world space)
  const metal = slot === 'A' ? 0xc8ccd2 : 0xd4af37; // A silver, B gold
  const stickMat = new THREE.MeshStandardMaterial({ color: metal, metalness: .85, roughness: .28, emissive: metal, emissiveIntensity: .25 });
  const stick = mesh(new THREE.CylinderGeometry(1, 1, 1, 6), stickMat, world); stick.userData.r = .02;
  const tipMat = new THREE.MeshBasicMaterial({ color: metal });
  const tip = joint(.04, tipMat, world);
  root.traverse(o => { if (o.isMesh) o.visible = false; }); // the rig: only the wireframe figure is drawn
  const wire = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: .55, depthWrite: false });
  let fig = null;
  FIG.then(f => { if (f) fig = f(wire, root); });
  // floating HP bar
  const hpCanvas = Object.assign(document.createElement('canvas'), { width: 320, height: 104 }), hpCtx = hpCanvas.getContext('2d');
  const hpTex = new THREE.CanvasTexture(hpCanvas); hpTex.colorSpace = THREE.SRGBColorSpace;
  const hpSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: hpTex, depthWrite: false, depthTest: false })); hpSprite.renderOrder = 10;
  hpSprite.scale.set(1.4, 1.4 * 104 / 320, 1); hpSprite.center.set(.5, -.15); world.add(hpSprite); // anchored below: stays above the head on screen from any angle
  const facing = V(1, 0, 0); limitSprite(hpSprite, { facing, maxFrac: .18 });
  let hpKey = '';
  function drawHp(hp, online, charge, value = hp) { // a thick bar, the slot and HP above it. hp: 0..100 (bar length), value: the HP number shown
    const key = `${Math.ceil(hp)}|${Math.ceil(value)}|${online}|${Math.round(charge * 10)}`; if (key === hpKey) return; hpKey = key;
    const g = hpCtx, w = 320, h = 104, c = online ? css(color) : '#7a7f8a', bx = 12, bw = w - 24, by = 46, bh = 34;
    g.clearRect(0, 0, w, h);
    g.font = '700 34px system-ui, sans-serif'; g.textBaseline = 'alphabetic'; g.shadowColor = '#000'; g.shadowBlur = 6;
    g.textAlign = 'left'; g.fillStyle = c; g.fillText(slot, bx, by - 10);
    g.textAlign = 'right'; g.fillStyle = '#d8dbe2'; g.fillText(!online ? 'OFFLINE' : hp <= 0 ? 'KO' : String(Math.ceil(value)), bx + bw, by - 10);
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(bx - 3, by - 3, bw + 6, bh + 6);
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(bx, by, bw, bh);
    if (online) {
      g.fillStyle = c; g.fillRect(bx, by, bw * Math.max(0, Math.min(1, hp / 100)), bh);
      if (charge > 0) { g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(bx, by + bh + 5, bw * charge, 6); }
    }
    hpTex.needsUpdate = true;
  }

  const st = { phase: 0, last: null, speed: 0, time: Math.random() * 10, ko: 0, tall: null, cap: [], calibAt: undefined };
  const L = a => v3(a); // body-frame point
  const offColor = new THREE.Color(0x6a6f7a), onColor = new THREE.Color(color);
  let wasOnline = null;

  // the stick (world space), the team colour and the HP bar: the same for both ways of posing the body
  function finish(p, base, tipP) {
    if (base && tipP) {
      const d = V().subVectors(tipP, base).normalize();
      between(stick, base.clone().addScaledVector(d, -.08), tipP); stick.scale.x = stick.scale.z = stick.userData.r;
      tip.position.copy(tipP);
      stickMat.emissiveIntensity = p.charging ? .5 + 1.2 * (p.charge ?? 0) * (.7 + .3 * Math.sin(st.time * 30)) : .25;
      tip.scale.setScalar(.04 * (1 + (p.charging ? (p.charge ?? 0) : 0)));
    }
    stick.visible = tip.visible = !!(base && tipP);
    const online = p.online !== false;
    if (online !== wasOnline) {
      wasOnline = online;
      suit.color.copy(online ? onColor : offColor); suit.emissive.copy(online ? onColor : offColor); suit.emissiveIntensity = online ? .12 : 0;
      glow.color.copy(online ? onColor : offColor).multiplyScalar(1.4);
      wire.color.copy(online ? onColor : offColor);
    }
    drawHp(100 * (p.hp ?? 100) / (p.hpMax || 100), online, p.charging ? (p.charge ?? 0) : 0, p.hp ?? 100);
  }

  // The pose from phone C's picture (p.skel = { joints, vis }, world joints from avatarpose.js) gives the body its shape only:
  // the limbs, the head and the trunk's lean, relative to the person's own trunk, smoothed between the ~15 Hz poses. Where the
  // body stands and which way it faces stay the sensors' (as without the camera), so the pose never moves the player; the
  // height comes from the pose itself (hips over the lowest foot), and the stick and the hand holding it are the sensors'.
  const sm = Array.from({ length: 33 }, () => V()), tmp = V(), X = V(1, 0, 0), Y = V(0, 1, 0);
  const camM = new THREE.Matrix4(), camInv = new THREE.Matrix4(), bodyM = new THREE.Matrix4(), bodyInv = new THREE.Matrix4();
  const headingM = (f, out) => { const fh = V(f.x, 0, f.z).normalize(); return out.makeBasis(fh, Y, V().crossVectors(fh, Y)); }; // x forward, y up, z right
  let smSeen = false;
  function poseUpdate(dt, p) {
    const sk = p.skel, k = smSeen ? 1 - Math.exp(-dt * 20) : 1;
    for (let i = 0; i < 33; i++) if (!smSeen || sk.vis[i] > .3) sm[i].lerp(tmp.fromArray(sk.joints[i]), k);
    smSeen = true; st.time += dt;
    // the person's trunk as the camera sees it
    const shM = V().addVectors(sm[11], sm[12]).multiplyScalar(.5), hpM = V().addVectors(sm[23], sm[24]).multiplyScalar(.5);
    const upv = shM.clone().sub(hpM).normalize();
    const rv = V().subVectors(sm[12], sm[11]); rv.addScaledVector(upv, -rv.dot(upv)).normalize(); // the person's right
    const fv = V().crossVectors(upv, rv).normalize();
    camM.makeBasis(fv, upv, rv).setPosition(shM.clone().addScaledVector(upv, -SHOULDER[1]).addScaledVector(fv, -SHOULDER[0]));
    camInv.copy(camM).invert();
    const loc = i => sm[i].clone().applyMatrix4(camInv); // trunk frame: no position, no heading left in it
    // the avatar: the trunk's lean (its turn off the camera-seen heading) on the sensors' heading, at the sensors' place
    const lean = headingM(fv, new THREE.Matrix4()).transpose().multiply(new THREE.Matrix4().extractRotation(camM));
    const f = [p.body.R[0], p.body.R[3], p.body.R[6]], fs = V(f[0], 0, f[2]).normalize();
    bodyM.multiplyMatrices(headingM(fs, new THREE.Matrix4()), lean);
    let foot = Infinity; for (const i of [27, 28, 29, 30, 31, 32]) foot = Math.min(foot, sm[i].y);
    const hipUp = Math.max(.3, Math.min(1.2, hpM.y - foot)); // hips over the lowest foot point (heel / toe: the floor)
    const hipOff = loc(23).add(loc(24)).multiplyScalar(.5).applyMatrix4(new THREE.Matrix4().extractRotation(bodyM));
    bodyM.setPosition(p.body.t[0], hipUp - hipOff.y, p.body.t[2]);
    bodyInv.copy(bodyM).invert();
    root.matrix.copy(bodyM); root.matrixWorldNeedsUpdate = true;
    torso.scale.y = 1;
    const anchor = (a, ai, i) => a.clone().add(loc(i)).sub(loc(ai)); // avatar anchor a (for landmark ai) + the person's offset to landmark i
    const sR = L(SHOULDER), sL = L([SHOULDER[0], SHOULDER[1], -SHOULDER[2]]);
    let eR = anchor(sR, 12, 14), hR = anchor(sR, 12, 16), eL = anchor(sL, 11, 13), hL = anchor(sL, 11, 15);
    // the stick hand: the camera's hand nearer the sensors' stick base reaches it (the stick is the sensors', in the world)
    if (p.base) {
      const b = p.base.clone().applyMatrix4(bodyInv);
      if (hR.distanceTo(b) <= hL.distanceTo(b)) { hR = b; eR = elbowFor(sR, b, V(-.2, -1, .6)); }
      else { hL = b; eL = elbowFor(sL, b, V(-.2, -1, -.6)); }
    }
    setLimb(armU, sR, eR); setLimb(armF, eR, hR); elbow.position.copy(eR); hand.position.copy(hR);
    setLimb(offU, sL, eL); setLimb(offF, eL, hL); offE.position.copy(eL); offH.position.copy(hL);
    for (const lg of legs) {
      const r = lg.s > 0, hip = V(HIP[0], HIP[1], HIP[2] * lg.s), h0 = r ? 24 : 23;
      const knee = anchor(hip, h0, r ? 26 : 25), foot = anchor(hip, h0, r ? 28 : 27);
      setLimb(lg.thigh, hip, knee); setLimb(lg.shin, knee, foot); lg.knee.position.copy(knee);
      const toe = anchor(hip, h0, r ? 32 : 31), heel = anchor(hip, h0, r ? 30 : 29), dir = toe.clone().sub(heel);
      lg.p = { hip, knee, foot, toe };
      lg.boot.position.copy(toe).add(heel).multiplyScalar(.5).add(V(0, -.02, 0));
      if (dir.lengthSq() > 4e-4) lg.boot.quaternion.setFromUnitVectors(X, dir.normalize()); else lg.boot.quaternion.identity();
    }
    // head: the nose against the ears
    const hf = loc(0).sub(loc(7).add(loc(8)).multiplyScalar(.5));
    headG.rotation.set(0, Math.max(-1.3, Math.min(1.3, Math.atan2(-hf.z, hf.x))), Math.max(-.9, Math.min(.9, Math.atan2(hf.y, Math.hypot(hf.x, hf.z)))), 'YZX');
    fig?.({ sR, eR, hR, sL, eL, hL, legs: legs.map(l => l.p), headQ: headG.quaternion });
    finish(p, p.base, p.tip);
    facing.copy(fs);
    const head = loc(0).applyMatrix4(bodyM);
    hpSprite.position.set(p.body.t[0], Math.max(head.y + .38, 1.2), p.body.t[2]);
    return { x: p.body.t[0], z: p.body.t[2], hp: (p.hp ?? 100) / (p.hpMax || 100), vis: p.online !== false ? 1 : .5 };
  }


  return {
    root, world, slot,
    update(dt, p) {
      const vis = !!p?.body;
      root.visible = vis && !p.hideBody; world.visible = vis; // hideBody: the real skeleton from the camera is drawn instead
      if (!vis) { smSeen = false; st.tall = null; st.cap = []; return null; } // the next one seen starts standing
      if (p.skel && POSE.show) return poseUpdate(dt, p);
      smSeen = false;
      if (p.online !== false) st.time += dt; // offline: no idle breathing / sway, it stands still
      // upright body frame from the forward direction (ignore pitch / roll), feet on the floor
      const f = [p.body.R[0], p.body.R[3], p.body.R[6]], yaw = Math.atan2(-f[2], f[0]);
      let ch = Math.max(.6, Math.min(1.7, p.body.t[1]));
      if (p.calibAt !== st.calibAt) { st.calibAt = p.calibAt; st.tall = null; st.cap = []; }
      if (st.tall == null) { // capturing the standing height: drawn standing meanwhile
        st.cap.push([ch, dt]);
        if (st.cap.reduce((a, c) => a + c[1], 0) >= CAPTURE) { const h = st.cap.map(c => c[0]).sort((a, b) => a - b); st.tall = Math.max(TALL_MIN, Math.min(TALL_MAX, h[h.length >> 1])); st.cap = []; }
      } else if (ch > st.tall) st.tall += (ch - st.tall) * Math.min(1, dt * .5);
      const tall = st.tall ?? Math.max(TALL_MIN, Math.min(TALL_MAX, ch));
      if (!POSE.show) ch = tall; // always standing
      const crouch = Math.max(0, Math.min(1, (tall - ch - .05) / (tall * .4))), lean = .6 * crouch; // rad at the waist
      const hip0 = V(HIP[0] - TORSO * Math.sin(lean), -TORSO * Math.cos(lean), 0); // the hips go back as the chest leans forward
      const bp = W.bodyPose([p.body.t[0], 0, p.body.t[2]], yaw, ch), inv = W.invert(bp);
      const pos = [bp.t[0], bp.t[2]];
      if (st.last) {
        const v = Math.hypot(pos[0] - st.last[0], pos[1] - st.last[1]) / Math.max(dt, 1e-3);
        st.speed += (Math.min(v, 3) - st.speed) * Math.min(1, dt * 8);
      }
      st.last = pos;
      st.phase += dt * (2 + 6 * Math.min(st.speed, 1.5));
      const walk = Math.min(1, st.speed / .6);
      st.ko += ((p.hp ?? 100) <= 0 ? 1 : -1) * dt * 2; st.ko = Math.max(0, Math.min(1, st.ko));
      const bob = .012 * Math.sin(st.time * 2.1) + .02 * walk * Math.abs(Math.sin(st.phase));
      hip0.y = Math.min(hip0.y, -ch + .04 - bob + legLen(tall) * .999); // legs a little short standing: the hips sit that much lower, the feet stay down
      const koTilt = st.ko * 1.2;
      const M = m4(bp).multiply(new THREE.Matrix4().makeTranslation(0, bob - st.ko * .35, 0)).multiply(new THREE.Matrix4().makeRotationZ(-koTilt * .4));
      root.matrix.copy(M); root.matrixWorldNeedsUpdate = true;
      torso.scale.y = 1 + .02 * Math.sin(st.time * 2.1 + 1);

      const base = p.base ? W.apply(inv, p.base.toArray()) : [.3, -.3, .2];
      const tipL = p.tip ? W.apply(inv, p.tip.toArray()) : [1.1, -.3, .2];
      // head: turn a little toward the stick tip
      const look = Math.atan2(-tipL[2], tipL[0]) * .35, nod = Math.atan2(tipL[1] - .3, Math.hypot(tipL[0], tipL[2])) * .3;
      headG.rotation.set(0, Math.max(-.6, Math.min(.6, look)), Math.max(-.4, Math.min(.4, nod)), 'YZX');
      // stick arm: 2-bone IK, elbow pointing down / outward
      const S = L(SHOULDER), Hn = L(base), E = elbowFor(S, Hn, V(-.2, -1, .6));
      setLimb(armU, S, E); setLimb(armF, E, Hn); elbow.position.copy(E); hand.position.copy(Hn);
      // off arm: hangs with a small swing
      const so = L([SHOULDER[0], SHOULDER[1], -SHOULDER[2]]), sw = .18 * walk * Math.sin(st.phase) + .02 * Math.sin(st.time * 1.3);
      const ho = V(-.04 + sw, -.42, -.28), Eo = elbowFor(so, ho, V(-1, -.3, -.4));
      setLimb(offU, so, Eo); setLimb(offF, Eo, ho); offE.position.copy(Eo); offH.position.copy(ho);
      // legs: stride with the walk phase, knees forward
      for (const lg of legs) {
        const hip = V(hip0.x, hip0.y, HIP[2] * lg.s), a = Math.sin(st.phase + (lg.s > 0 ? 0 : Math.PI));
        const foot = V(HIP[0] + .2 * walk * a, -ch + .04 - bob + .05 * walk * Math.max(0, -Math.cos(st.phase + (lg.s > 0 ? 0 : Math.PI))), .12 * lg.s);
        const leg = legLen(tall) / 2, knee = elbowFor(hip, foot, V(1, 0, 0), leg, leg); // fixed bones: nearly straight standing, bent in a crouch
        setLimb(lg.thigh, hip, knee); setLimb(lg.shin, knee, foot); lg.knee.position.copy(knee);
        lg.boot.position.copy(foot).add(V(.04, -.01, 0)); lg.boot.quaternion.identity();
        lg.p = { hip, knee, foot, toe: foot.clone().add(V(.16, -.03, 0)) };
      }
      fig?.({ sR: S, eR: E, hR: Hn, sL: so, eL: Eo, hL: ho, legs: legs.map(l => l.p), headQ: headG.quaternion, leg: legLen(tall), hip: hip0, lean });
      finish(p, p.base, p.tip);
      facing.set(f[0], 0, f[2]).normalize();
      hpSprite.position.set(bp.t[0], ch + .5 + .02 * Math.sin(st.time * 1.7) - st.ko * .3, bp.t[2]);
      return { x: bp.t[0], z: bp.t[2], hp: (p.hp ?? 100) / (p.hpMax || 100), vis: p.online !== false ? 1 : .5 };
    },
  };
}
/** Joint between a (start) and b (end) for two bones of length l1, l2, bending toward `pole` (all body-frame Vector3). */
function elbowFor(a, b, pole, l1 = UPPER, l2 = FORE) {
  const ab = V().subVectors(b, a), d = ab.length(), n = ab.clone().divideScalar(Math.max(d, 1e-4));
  if (d >= l1 + l2) return a.clone().addScaledVector(n, d * l1 / (l1 + l2));
  const x = (d * d + l1 * l1 - l2 * l2) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const perp = pole.clone().addScaledVector(n, -pole.dot(n)); if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0);
  return a.clone().addScaledVector(n, x).addScaledVector(perp.normalize(), h);
}


/**
 * createField(scene, opts) -> { group, background, update(dt, players), setLayoutDebug(on), rebuild(), dispose() }
 * players = { A: { body, base, tip, hp, element, charging, charge, online }, B: ... }; body = world.js pose or null.
 * Only `group` is added to the scene; the integrator sets scene.background = background in 3D views.
 * The arena follows the field by itself: update() notices a setField / setFloorSep (fieldSig) and rebuilds the
 * outline, posts, letters and tags inside the same group (avatars, lights and the floor material are kept).
 * rebuild() forces it now; dispose() frees everything (only needed if the field object is thrown away).
 */
export function createField(scene, opts = {}) {
  const group = new THREE.Group(); group.name = 'field3d';
  const uniforms = {
    uTime: { value: 0 }, uR: { value: 3 }, uX: { value: new THREE.Vector2(-2, 2) },
    uPoly: { value: Array.from({ length: MAXP }, () => new THREE.Vector2()) }, uN: { value: 4 },
    uCA: { value: new THREE.Color(TEAM.A) }, uCB: { value: new THREE.Color(TEAM.B) },
    uSA: { value: new THREE.Vector2() }, uSB: { value: new THREE.Vector2() },
    uP: { value: [new THREE.Vector4(), new THREE.Vector4()] },
  };
  const floor = makeFloor(uniforms);
  const debug = new THREE.Group(); debug.visible = false;
  debug.add(new THREE.AxesHelper(.6));
  group.add(floor, debug);
  let arena = null, debugArena = null, sig = NaN;
  function rebuild() {
    sig = fieldSig();
    const P = W.FIELD.poly.length > MAXP ? W.FIELD.poly.slice(0, MAXP) : W.FIELD.poly, e = fieldExtent(P);
    P.forEach((p, i) => uniforms.uPoly.value[i].set(p[0], p[1])); uniforms.uN.value = P.length;
    uniforms.uR.value = e.R; uniforms.uX.value.set(e.minX, e.maxX);
    uniforms.uSA.value.set(W.START.A.pos[0], W.START.A.pos[2]); uniforms.uSB.value.set(W.START.B.pos[0], W.START.B.pos[2]);
    floor.scale.set(2 * (e.R + 6), 2 * (e.R + 6), 1);
    if (arena) { group.remove(arena); disposeTree(arena); debug.remove(debugArena); disposeTree(debugArena); }
    arena = new THREE.Group(); debugArena = new THREE.Group();
    arena.add(floorText('A', css(TEAM.A), W.START.A.pos[0], W.START.A.pos[2] + .66), floorText('B', css(TEAM.B), W.START.B.pos[0], W.START.B.pos[2] + .66));
    arena.add(makeTags(debugArena));
    for (const [t, x, z, c] of [['+x', e.maxX + .35, 0, '#ff6b6b'], ['+z', 0, e.maxZ + .35, '#6b9bff']]) { const l = label(t, c, .16); l.position.set(x, .12, z); debugArena.add(l); }
    group.add(arena); debug.add(debugArena);
  }
  rebuild();

  // lights (only lit materials here use them; they switch off with the group)
  group.add(new THREE.HemisphereLight(0xa8c0ff, 0x1a1622, 1.6));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.2); key.position.set(2, 6, 4); group.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x8fb8ff, 1.4); rim.position.set(-3, 3, -5); group.add(rim, rim.target);

  const avatars = { A: makeAvatar('A'), B: makeAvatar('B') };
  for (const a of Object.values(avatars)) {
    group.add(a.root, a.world);
    const ax = new THREE.AxesHelper(.4); a.root.add(ax); a.ax = ax; ax.visible = false;
  }

  const background = canvasTex(4, 512, (g, w, h) => {
    g.fillStyle = '#07090d'; g.fillRect(0, 0, w, h);
  });

  scene.add(group);
  return {
    group, background, rebuild,
    update(dt, players = {}) {
      if (fieldSig() !== sig) rebuild();
      uniforms.uTime.value += dt;
      ['A', 'B'].forEach((s, i) => {
        const r = avatars[s].update(dt, players[s]);
        uniforms.uP.value[i].set(r?.x ?? 0, r?.z ?? 0, r?.hp ?? 0, r ? r.vis : 0);
      });
    },
    setLayoutDebug(on) { debug.visible = on; for (const a of Object.values(avatars)) a.ax.visible = on; },
    dispose() { scene.remove(group); disposeTree(group); background.dispose(); },
  };
}

/**
 * createMinimap(canvas) -> { draw(players, shots) }: top-down HUD, x right, z down (as the overview camera sees it).
 * shots = [{ pos: Vector3, owner: { slot }, element }]. Transparent background; draws in canvas pixels.
 * Fits the field outline, the tags and the start marks; the static part is cached and redrawn only when the field
 * (fieldSig) or the canvas size changes.
 */
export function createMinimap(canvas) {
  const g = canvas.getContext('2d'), bg = document.createElement('canvas'), b = bg.getContext('2d');
  let key = '', sig = NaN, k = 1, ox = 0, oz = 0, u = 1;
  const P = (x, z) => [ox + x * k, oz + z * k];
  function drawStatic(w, h) {
    bg.width = w; bg.height = h; sig = fieldSig(); key = w + 'x' + h;
    const poly = W.FIELD.poly, e = fieldExtent(poly), ids = W.CORNER_IDS;
    let x0 = Math.min(e.minX, W.START.A.pos[0] - .4), x1 = Math.max(e.maxX, W.START.B.pos[0] + .4), z0 = e.minZ, z1 = e.maxZ;
    for (const id of ids) { const t = W.TAGS[id].pos; x0 = Math.min(x0, t[0] - .25); x1 = Math.max(x1, t[0] + .25); z0 = Math.min(z0, t[2] - .25); z1 = Math.max(z1, t[2] + .25); }
    const S = Math.min(w, h); u = S / 260;
    const pad = 26 * u; // room for the id labels outside
    k = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (z1 - z0));
    ox = w / 2 - (x0 + x1) / 2 * k; oz = h / 2 - (z0 + z1) / 2 * k;
    b.clearRect(0, 0, w, h);
    b.fillStyle = 'rgba(8,11,20,.62)'; b.beginPath(); b.roundRect(ox + x0 * k - 10 * u, oz + z0 * k - 10 * u, (x1 - x0) * k + 20 * u, (z1 - z0) * k + 20 * u, 12 * u); b.fill();
    const outline = () => { b.beginPath(); poly.forEach((p, i) => b[i ? 'lineTo' : 'moveTo'](...P(p[0], p[1]))); b.closePath(); };
    // inside: lighter fill, 1 m grid and the dashed centre line, clipped to the outline
    b.save(); outline(); b.fillStyle = 'rgba(40,50,80,.35)'; b.fill(); b.clip();
    b.strokeStyle = 'rgba(160,180,220,.13)'; b.lineWidth = 1 * u; b.beginPath();
    for (let x = Math.ceil(e.minX); x <= e.maxX; x++) { b.moveTo(...P(x, e.minZ)); b.lineTo(...P(x, e.maxZ)); }
    for (let z = Math.ceil(e.minZ); z <= e.maxZ; z++) { b.moveTo(...P(e.minX, z)); b.lineTo(...P(e.maxX, z)); }
    b.stroke();
    b.setLineDash([6 * u, 6 * u]); b.strokeStyle = 'rgba(220,230,255,.35)'; b.lineWidth = 1.5 * u;
    b.beginPath(); b.moveTo(...P(0, e.minZ)); b.lineTo(...P(0, e.maxZ)); b.stroke(); b.setLineDash([]);
    b.restore();
    for (const s of ['A', 'B']) { // each half in its team colour
      b.save(); b.beginPath(); b.rect(s === 'A' ? 0 : P(0, 0)[0], 0, s === 'A' ? P(0, 0)[0] : w, h); b.clip();
      outline(); b.strokeStyle = css(TEAM[s]); b.lineWidth = 1.5 * u; b.lineJoin = 'round'; b.stroke(); b.restore();
    }
    for (const s of ['A', 'B']) { b.strokeStyle = css(TEAM[s]); b.globalAlpha = .55; b.lineWidth = 1 * u; b.beginPath(); b.arc(...P(W.START[s].pos[0], W.START[s].pos[2]), .32 * k, 0, 7); b.stroke(); b.globalAlpha = 1; }
    // tags: floor sheets as small turned squares with a tick on the top edge (tag +y), standing ones as a bar along
    // the tag's x axis; id outside, away from the centre
    b.font = `700 ${11 * u}px system-ui, sans-serif`; b.textAlign = 'center'; b.textBaseline = 'middle';
    for (const id of ids) {
      const tp = W.worldTagPose(id), t = W.TAGS[id], ax = [tp.R[0], tp.R[6]], ay = [tp.R[1], tp.R[7]], cx = tp.t[0], cz = tp.t[2];
      if (t.floor) {
        const s = Math.max(t.size * .62, 5 * u / k), Q = (i, j) => P(cx + (ax[0] * i + ay[0] * j) * s, cz + (ax[1] * i + ay[1] * j) * s);
        b.fillStyle = '#f2f4f8'; b.beginPath(); b.moveTo(...Q(-1, -1)); b.lineTo(...Q(1, -1)); b.lineTo(...Q(1, 1)); b.lineTo(...Q(-1, 1)); b.closePath(); b.fill();
        b.strokeStyle = '#0b0e16'; b.lineWidth = 1.5 * u; b.beginPath(); b.moveTo(...Q(0, 0)); b.lineTo(...Q(0, .95)); b.stroke();
      } else {
        const s = t.size * .5 + .08;
        b.strokeStyle = '#f2f4f8'; b.lineWidth = 4 * u; b.beginPath();
        b.moveTo(...P(cx - ax[0] * s, cz - ax[1] * s)); b.lineTo(...P(cx + ax[0] * s, cz + ax[1] * s)); b.stroke();
      }
      const n = Math.hypot(cx, cz) || 1, o = .16 + 13 * u / k;
      b.fillStyle = '#cfd8ea'; b.fillText('ID' + id, ...P(cx + cx / n * o, cz + cz / n * o));
    }
  }
  return {
    draw(players = {}, shots = []) {
      const w = canvas.width, h = canvas.height;
      if (w !== bg.width || h !== bg.height || fieldSig() !== sig || !key) drawStatic(w, h);
      g.clearRect(0, 0, w, h); g.drawImage(bg, 0, 0);
      g.font = `900 ${12 * u}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      // shots
      for (const sh of shots) {
        const [x, y] = P(sh.pos.x, sh.pos.z), c = sh.element === 'fire' ? '#ffb05a' : '#bfe6ff';
        g.fillStyle = c; g.shadowColor = c; g.shadowBlur = 8 * u; g.beginPath(); g.arc(x, y, 4 * u, 0, 7); g.fill(); g.shadowBlur = 0;
      }
      // players (marker size in pixels follows the field scale, but stays readable on a big field)
      for (const s of ['A', 'B']) {
        const p = players[s]; if (!p?.body) continue;
        const c = p.online === false ? '#7a7f8a' : css(TEAM[s]), [x, y] = P(p.body.t[0], p.body.t[2]), r = Math.max(.2 * k, 8 * u);
        if (p.base && p.tip) { g.strokeStyle = c; g.lineWidth = 3 * u; g.lineCap = 'round'; g.beginPath(); g.moveTo(...P(p.base.x, p.base.z)); g.lineTo(...P(p.tip.x, p.tip.z)); g.stroke(); }
        const fx = p.body.R[0], fz = p.body.R[6], fn = Math.hypot(fx, fz) || 1, ux = fx / fn, uz = fz / fn;
        g.fillStyle = c; g.beginPath(); // facing wedge
        g.moveTo(x + ux * r * 1.9, y + uz * r * 1.9); g.lineTo(x - uz * r * .7, y + ux * r * .7); g.lineTo(x + uz * r * .7, y - ux * r * .7); g.fill();
        g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5 * u; g.stroke();
        const hp = Math.max(0, Math.min(1, (p.hp ?? 100) / (p.hpMax || 100)));
        g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 3 * u; g.beginPath(); g.arc(x, y, r + 5 * u, 0, 7); g.stroke();
        g.strokeStyle = c; g.beginPath(); g.arc(x, y, r + 5 * u, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2); g.stroke();
        g.fillStyle = '#0b0e16'; g.fillText(s, x, y + .5 * u);
      }
    },
  };
}
