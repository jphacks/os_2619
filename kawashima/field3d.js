// Stylized arena for the 3D / drone views: floor, glowing boundary, start rings, tag poles with the real tag images,
// two team-coloured avatars posed from the players' body / stick, and a 2D top-down minimap.
// Everything lives in one group the integrator shows only in 3D views; effects.js renders on top (no depth test).
// World frame and layout: world.js (metres, y up, origin floor centre). Body frame: x forward, y up, z right.
import * as THREE from 'three';
import * as W from './world.js';
import { tagCanvas } from './dummycam.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v3 = a => V(a[0], a[1], a[2]);
const m4 = p => new THREE.Matrix4().set(p.R[0], p.R[1], p.R[2], p.t[0], p.R[3], p.R[4], p.R[5], p.t[1], p.R[6], p.R[7], p.R[8], p.t[2], 0, 0, 0, 1);
const H = W.ARENA.half;
export const TEAM = { A: 0xff7a1a, B: 0x3fc4ff };
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

// ---- floor: one quad, everything analytic (grid, boundary glow, centre line, start rings, player shadows + HP arcs) ----
const FLOOR_VS = `
varying vec2 vP;
void main() { vec4 w = modelMatrix * vec4(position, 1.); vP = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FLOOR_FS = `
uniform float uTime, uH; uniform vec4 uP[2]; uniform vec3 uCA, uCB; uniform vec2 uSA, uSB;
varying vec2 vP;
float aline(float d, float px) { return 1. - smoothstep(.5 * px, 1.5 * px, d); } // ~1.5 px wide line at distance d (px units)
float gridAt(vec2 p, float s) { vec2 q = p / s, g = abs(fract(q - .5) - .5) / fwidth(q); return 1. - min(min(g.x, g.y) / 1.2, 1.); }
float ring(vec2 p, vec2 c, float r, float w) { float d = abs(length(p - c) - r); return 1. - smoothstep(w * .5, w * .5 + fwidth(d) * 1.5, d); }
void main() {
  vec2 p = vP; float r = length(p), box = max(abs(p.x), abs(p.y)), inside = step(box, uH);
  vec3 team = mix(uCA, uCB, smoothstep(-uH * .9, uH * .9, p.x));
  vec3 c = mix(vec3(.028, .034, .052), vec3(.05, .06, .09), inside);
  c += inside * vec3(.035, .04, .06) * exp(-r * r / 5.);                                           // soft centre spot
  c += mix(vec3(.04, .05, .08), vec3(.10, .12, .17), inside) * gridAt(p, .5) * (inside > .5 ? 1. : exp(-(box - uH) * .8));
  c += inside * vec3(.07, .08, .11) * gridAt(p, 1.);
  // boundary: bright core + glow, a light pulse running round it
  float d = box - uH, ang = atan(p.y, p.x);
  float pulse = .75 + .25 * sin(uTime * 2.2 - ang * 4.);
  c += team * (1. - smoothstep(.012, .03, abs(d))) * 1.6 * pulse;
  c += team * exp(-abs(d) * (d < 0. ? 9. : 16.)) * .32 * pulse;
  // centre line (dashed) and circle
  float dash = step(.45, fract(p.y * 2.5 + uTime * .3));
  c += inside * vec3(.55, .6, .7) * aline(abs(p.x) / fwidth(p.x), 1.) * dash * .6;
  c += inside * vec3(.35, .4, .5) * ring(p, vec2(0.), .6, .015) * .6;
  // start rings
  c += uCA * (ring(p, uSA, .32, .03) * .9 + exp(-abs(length(p - uSA) - .32) * 30.) * .2);
  c += uCB * (ring(p, uSB, .32, .03) * .9 + exp(-abs(length(p - uSB) - .32) * 30.) * .2);
  // players: contact shadow, team ring with HP arc (from -z, clockwise seen from above)
  for (int i = 0; i < 2; i++) {
    vec4 P = uP[i]; if (P.w <= 0.) continue;
    vec3 tc = i == 0 ? uCA : uCB;
    vec2 q = p - P.xy; float dq = length(q);
    c *= 1. - .7 * exp(-dq * dq / .045) * P.w;
    float a = fract(atan(q.x, -q.y) / 6.2831853 + .5);
    float on = step(a, P.z);
    c += tc * ring(p, P.xy, .46, .05) * mix(.12, 1.3, on) * P.w;
    c += tc * exp(-abs(dq - .46) * 22.) * .25 * on * P.w;
  }
  float alpha = 1. - smoothstep(4.2, 8.5, r);
  gl_FragColor = vec4(c, alpha);
}`;

// boundary curtain: additive, fades upward, slow scanlines
const WALL_VS = `
varying vec2 vUv; varying float vX;
void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.); vX = w.x; gl_Position = projectionMatrix * viewMatrix * w; }`;
const WALL_FS = `
uniform float uTime, uH; uniform vec3 uCA, uCB; varying vec2 vUv; varying float vX;
void main() {
  vec3 team = mix(uCA, uCB, smoothstep(-uH * .9, uH * .9, vX));
  float f = pow(1. - vUv.y, 2.2), scan = .65 + .35 * step(.5, fract(vUv.y * 7. - uTime * .5));
  gl_FragColor = vec4(team * f * scan * .55, 1.);
}`;

function makeFloor(uniforms) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), new THREE.ShaderMaterial({
    vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, uniforms, transparent: true, depthWrite: true,
    extensions: { derivatives: true },
  }));
  floor.rotation.x = -Math.PI / 2; floor.renderOrder = -1;
  return floor;
}
function makeWalls(uniforms) {
  const g = new THREE.Group(), h = .32;
  const mat = new THREE.ShaderMaterial({ vertexShader: WALL_VS, fragmentShader: WALL_FS, uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  for (const [x, z, ry] of [[0, -H, 0], [0, H, 0], [-H, 0, Math.PI / 2], [H, 0, Math.PI / 2]]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * H, h), mat); m.position.set(x, h / 2, z); m.rotation.y = ry; g.add(m);
  }
  // corner posts
  const post = new THREE.CylinderGeometry(.035, .035, .6, 6);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    if (W.CORNER_IDS.some(id => Math.hypot(W.TAGS[id].pos[0] - sx * H, W.TAGS[id].pos[2] - sz * H) < .3)) continue; // a tag pole stands there
    const m = new THREE.Mesh(post, new THREE.MeshBasicMaterial({ color: new THREE.Color(sx < 0 ? TEAM.A : TEAM.B).multiplyScalar(1.1) }));
    m.position.set(sx * H, .3, sz * H); g.add(m);
  }
  return g;
}
function floorText(text, color, x, z) { // big flat letter on the floor, upright seen from +z
  const tex = canvasTex(128, 128, (g, w, h) => { g.font = '900 100px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color; g.fillText(text, w / 2, h / 2 + 6); });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(.5, .5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: .55, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, .004, z);
  return m;
}

// ---- tag poles: tag plane exactly at worldTagPose (flip respected), board / pole in an upright frame (as dummycam) ----
function makeTags(debugGroup) {
  const g = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a93a3, metalness: .5, roughness: .4 });
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: .7 });
  const footMat = new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: .8 });
  for (const id of W.CORNER_IDS) {
    const tp = W.worldTagPose(id), s = W.TAGS[id].size;
    const up = tp.R[4] > 0 ? tp : W.pose(W.mul3(tp.R, [-1, 0, 0, 0, -1, 0, 0, 0, 1]), tp.t);
    const gt = new THREE.Group(), gu = new THREE.Group();
    gt.matrixAutoUpdate = gu.matrixAutoUpdate = false; gt.matrix.copy(m4(tp)); gu.matrix.copy(m4(up));
    const tex = new THREE.CanvasTexture(tagCanvas(id, 16));
    tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.anisotropy = 4;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(s * 10 / 8, s * 10 / 8), new THREE.MeshBasicMaterial({ map: tex, color: 0xe8e8e8 }));
    face.position.z = .002; gt.add(face);
    if (W.TAGS[id].floor) { // a sheet lying on the floor: just the paper and a label above it
      const lab = label('ID ' + id, '#e8eefc', .13); lab.position.set(0, 0, .3); gt.add(lab);
      const ax = new THREE.AxesHelper(s * 1.2); ax.matrixAutoUpdate = false; ax.matrix.copy(m4(tp)); debugGroup.add(ax);
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
    const ax = new THREE.AxesHelper(s * 1.2); ax.matrixAutoUpdate = false; ax.matrix.copy(m4(tp)); debugGroup.add(ax);
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
  const stickMat = new THREE.MeshStandardMaterial({ color: 0x3a2c22, roughness: .6, emissive: color, emissiveIntensity: .5 });
  const stick = mesh(new THREE.CylinderGeometry(1, 1, 1, 6), stickMat, world); stick.userData.r = .02;
  const tipMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.5) });
  const tip = joint(.04, tipMat, world);
  // floating HP bar
  const hpCanvas = Object.assign(document.createElement('canvas'), { width: 320, height: 88 }), hpCtx = hpCanvas.getContext('2d');
  const hpTex = new THREE.CanvasTexture(hpCanvas); hpTex.colorSpace = THREE.SRGBColorSpace;
  const hpSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: hpTex, depthWrite: false, depthTest: false })); hpSprite.renderOrder = 10;
  hpSprite.scale.set(1, 88 / 320, 1); hpSprite.center.set(.5, -.15); world.add(hpSprite); // anchored below: stays above the head on screen from any angle
  const facing = V(1, 0, 0); limitSprite(hpSprite, { facing });
  let hpKey = '';
  function drawHp(hp, online, charge) {
    const key = `${Math.ceil(hp)}|${online}|${Math.round(charge * 10)}`; if (key === hpKey) return; hpKey = key;
    const g = hpCtx, w = 320, h = 88, c = online ? css(color) : '#7a7f8a';
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(6,8,14,.78)'; g.beginPath(); g.roundRect(2, 6, w - 4, h - 12, 20); g.fill();
    g.lineWidth = 3; g.strokeStyle = c; g.stroke();
    g.font = '900 52px system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillStyle = c; g.fillText(slot, 40, h / 2 + 2);
    const bx = 76, bw = w - bx - 20, bh = 30, by = h / 2 - bh / 2;
    g.fillStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.roundRect(bx, by, bw, bh, 10); g.fill();
    if (online) {
      const f = Math.max(0, Math.min(1, hp / 100)), gr = g.createLinearGradient(bx, 0, bx + bw, 0);
      gr.addColorStop(0, c); gr.addColorStop(1, f < .3 ? '#ff3b3b' : '#ffffff');
      g.fillStyle = hp < 30 ? '#ff4040' : c; g.beginPath(); g.roundRect(bx, by, Math.max(bh * .6, bw * f), bh, 10); g.fill();
      if (charge > 0) { g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(bx, by + bh + 3, bw * charge, 4); }
      g.font = '800 24px system-ui, sans-serif'; g.fillStyle = '#fff'; g.fillText(hp <= 0 ? 'KO' : String(Math.ceil(hp)), bx + bw / 2, h / 2 + 1);
    } else { g.font = '700 24px system-ui, sans-serif'; g.fillStyle = '#c8ccd6'; g.fillText('OFFLINE', bx + bw / 2, h / 2 + 1); }
    hpTex.needsUpdate = true;
  }

  const st = { phase: 0, last: null, speed: 0, time: Math.random() * 10, ko: 0 };
  const L = a => v3(a); // body-frame point
  const offColor = new THREE.Color(0x6a6f7a), onColor = new THREE.Color(color);
  let wasOnline = null;

  return {
    root, world, slot,
    update(dt, p) {
      const vis = !!p?.body;
      root.visible = world.visible = vis;
      if (!vis) return null;
      st.time += dt;
      // upright body frame from the forward direction (ignore pitch / roll), feet on the floor
      const f = [p.body.R[0], p.body.R[3], p.body.R[6]], yaw = Math.atan2(-f[2], f[0]);
      const ch = Math.max(.9, Math.min(1.7, p.body.t[1]));
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
        const hip = V(HIP[0], HIP[1], HIP[2] * lg.s), a = Math.sin(st.phase + (lg.s > 0 ? 0 : Math.PI));
        const foot = V(HIP[0] + .2 * walk * a, -ch + .04 - bob + .05 * walk * Math.max(0, -Math.cos(st.phase + (lg.s > 0 ? 0 : Math.PI))), .12 * lg.s);
        const leg = (ch + HIP[1] - .04) * .515, knee = elbowFor(hip, foot, V(1, 0, 0), leg, leg); // nearly straight when standing
        setLimb(lg.thigh, hip, knee); setLimb(lg.shin, knee, foot); lg.knee.position.copy(knee);
        lg.boot.position.copy(foot).add(V(.04, -.01, 0));
      }
      // stick in world space
      if (p.base && p.tip) {
        const d = V().subVectors(p.tip, p.base).normalize();
        between(stick, p.base.clone().addScaledVector(d, -.08), p.tip); stick.scale.x = stick.scale.z = stick.userData.r;
        tip.position.copy(p.tip);
        stickMat.emissiveIntensity = p.charging ? .8 + 1.2 * (p.charge ?? 0) * (.7 + .3 * Math.sin(st.time * 30)) : .5;
        tip.scale.setScalar(.04 * (1 + (p.charging ? (p.charge ?? 0) : 0)));
      }
      stick.visible = tip.visible = !!(p.base && p.tip);
      const online = p.online !== false;
      if (online !== wasOnline) {
        wasOnline = online;
        suit.color.copy(online ? onColor : offColor); suit.emissive.copy(online ? onColor : offColor); suit.emissiveIntensity = online ? .12 : 0;
        glow.color.copy(online ? onColor : offColor).multiplyScalar(1.4);
      }
      drawHp(p.hp ?? 100, online, p.charging ? (p.charge ?? 0) : 0);
      facing.set(f[0], 0, f[2]).normalize();
      hpSprite.position.set(bp.t[0], ch + .5 + .02 * Math.sin(st.time * 1.7) - st.ko * .3, bp.t[2]);
      return { x: bp.t[0], z: bp.t[2], hp: (p.hp ?? 100) / 100, vis: online ? 1 : .5 };
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
 * createField(scene, opts) -> { group, background, update(dt, players), setLayoutDebug(on) }
 * players = { A: { body, base, tip, hp, element, charging, charge, online }, B: ... }; body = world.js pose or null.
 * Only `group` is added to the scene; the integrator sets scene.background = background in 3D views.
 */
export function createField(scene, opts = {}) {
  const group = new THREE.Group(); group.name = 'field3d';
  const uniforms = {
    uTime: { value: 0 }, uH: { value: H },
    uCA: { value: new THREE.Color(TEAM.A) }, uCB: { value: new THREE.Color(TEAM.B) },
    uSA: { value: new THREE.Vector2(W.START.A.pos[0], W.START.A.pos[2]) }, uSB: { value: new THREE.Vector2(W.START.B.pos[0], W.START.B.pos[2]) },
    uP: { value: [new THREE.Vector4(), new THREE.Vector4()] },
  };
  group.add(makeFloor(uniforms), makeWalls(uniforms));
  group.add(floorText('A', css(TEAM.A), W.START.A.pos[0], W.START.A.pos[2] + .66), floorText('B', css(TEAM.B), W.START.B.pos[0], W.START.B.pos[2] + .66));
  const debug = new THREE.Group(); debug.visible = false;
  group.add(makeTags(debug), debug);
  debug.add(new THREE.AxesHelper(.6));
  for (const [t, x, z, c] of [['+x', 2.35, 0, '#ff6b6b'], ['+z', 0, 2.35, '#6b9bff']]) { const l = label(t, c, .16); l.position.set(x, .12, z); debug.add(l); }

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
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#05070d'); gr.addColorStop(.45, '#0d1322'); gr.addColorStop(.62, '#121a2c'); gr.addColorStop(1, '#040508');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });

  scene.add(group);
  return {
    group, background,
    update(dt, players = {}) {
      uniforms.uTime.value += dt;
      ['A', 'B'].forEach((s, i) => {
        const r = avatars[s].update(dt, players[s]);
        uniforms.uP.value[i].set(r?.x ?? 0, r?.z ?? 0, r?.hp ?? 0, r ? r.vis : 0);
      });
    },
    setLayoutDebug(on) { debug.visible = on; for (const a of Object.values(avatars)) a.ax.visible = on; },
  };
}

/**
 * createMinimap(canvas) -> { draw(players, shots) }: top-down HUD, x right, z down (as the overview camera sees it).
 * shots = [{ pos: Vector3, owner: { slot }, element }]. Transparent background; draws in canvas pixels.
 */
export function createMinimap(canvas) {
  const g = canvas.getContext('2d');
  return {
    draw(players = {}, shots = []) {
      const w = canvas.width, h = canvas.height, S = Math.min(w, h), k = S * .74 / (2 * H), cx = w / 2, cy = h / 2;
      const P = (x, z) => [cx + x * k, cy + z * k], u = S / 260;
      g.clearRect(0, 0, w, h);
      // arena
      g.fillStyle = 'rgba(8,11,20,.62)'; g.beginPath(); g.roundRect(cx - H * k - 10 * u, cy - H * k - 10 * u, 2 * H * k + 20 * u, 2 * H * k + 20 * u, 12 * u); g.fill();
      g.strokeStyle = 'rgba(160,180,220,.13)'; g.lineWidth = 1 * u; g.beginPath();
      for (let x = -H + 1; x < H; x++) { g.moveTo(...P(x, -H)); g.lineTo(...P(x, H)); g.moveTo(...P(-H, x)); g.lineTo(...P(H, x)); }
      g.stroke();
      const grad = g.createLinearGradient(...P(-H, 0), ...P(H, 0)); grad.addColorStop(0, css(TEAM.A)); grad.addColorStop(1, css(TEAM.B));
      g.strokeStyle = grad; g.lineWidth = 3 * u; g.strokeRect(cx - H * k, cy - H * k, 2 * H * k, 2 * H * k);
      g.setLineDash([6 * u, 6 * u]); g.strokeStyle = 'rgba(220,230,255,.35)'; g.lineWidth = 1.5 * u;
      g.beginPath(); g.moveTo(...P(0, -H)); g.lineTo(...P(0, H)); g.stroke(); g.setLineDash([]);
      for (const s of ['A', 'B']) { g.strokeStyle = css(TEAM[s]); g.globalAlpha = .55; g.lineWidth = 2 * u; g.beginPath(); g.arc(...P(W.START[s].pos[0], W.START[s].pos[2]), .32 * k, 0, 7); g.stroke(); g.globalAlpha = 1; }
      // tags: a bar along the tag's x axis, id outside the arena
      g.font = `700 ${11 * u}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const id of W.CORNER_IDS) {
        const tp = W.worldTagPose(id), s = W.TAGS[id].size * .5 + .08, ax = [tp.R[0], tp.R[6]];
        g.strokeStyle = '#f2f4f8'; g.lineWidth = 4 * u; g.beginPath();
        g.moveTo(...P(tp.t[0] - ax[0] * s, tp.t[2] - ax[1] * s)); g.lineTo(...P(tp.t[0] + ax[0] * s, tp.t[2] + ax[1] * s)); g.stroke();
        const n = Math.hypot(tp.t[0], tp.t[2]) || 1, o = .3;
        g.fillStyle = '#cfd8ea'; g.fillText('ID' + id, ...P(tp.t[0] * (1 + o / n), tp.t[2] * (1 + o / n)));
      }
      // shots
      for (const sh of shots) {
        const [x, y] = P(sh.pos.x, sh.pos.z), c = sh.element === 'fire' ? '#ffb05a' : '#bfe6ff';
        g.fillStyle = c; g.shadowColor = c; g.shadowBlur = 8 * u; g.beginPath(); g.arc(x, y, 4 * u, 0, 7); g.fill(); g.shadowBlur = 0;
      }
      // players
      for (const s of ['A', 'B']) {
        const p = players[s]; if (!p?.body) continue;
        const c = p.online === false ? '#7a7f8a' : css(TEAM[s]), [x, y] = P(p.body.t[0], p.body.t[2]), r = .2 * k;
        if (p.base && p.tip) { g.strokeStyle = c; g.lineWidth = 3 * u; g.lineCap = 'round'; g.beginPath(); g.moveTo(...P(p.base.x, p.base.z)); g.lineTo(...P(p.tip.x, p.tip.z)); g.stroke(); }
        const fx = p.body.R[0], fz = p.body.R[6], fn = Math.hypot(fx, fz) || 1, ux = fx / fn, uz = fz / fn;
        g.fillStyle = c; g.beginPath(); // facing wedge
        g.moveTo(x + ux * r * 1.9, y + uz * r * 1.9); g.lineTo(x - uz * r * .7, y + ux * r * .7); g.lineTo(x + uz * r * .7, y - ux * r * .7); g.fill();
        g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5 * u; g.stroke();
        const hp = Math.max(0, Math.min(1, (p.hp ?? 100) / 100));
        g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 3 * u; g.beginPath(); g.arc(x, y, r + 5 * u, 0, 7); g.stroke();
        g.strokeStyle = hp < .3 ? '#ff4a4a' : c; g.beginPath(); g.arc(x, y, r + 5 * u, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2); g.stroke();
        g.fillStyle = '#0b0e16'; g.font = `900 ${12 * u}px system-ui, sans-serif`; g.fillText(s, x, y + .5 * u);
      }
    },
  };
}
