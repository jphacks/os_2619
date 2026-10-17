// 生の3D情報: everything the phones send, placed in the FIELD world by phonealign.js and drawn as it is (no game logic).
// Opens from the admin page in its own tab; connects to the relay itself and reads the display's shared settings from
// localStorage (field scan 'fx-field-<layout>', third-person camera in 'fx-cfg2'). Light: geometries are allocated once
// and their BufferAttributes rewritten in place; the estimate runs at 15 Hz, the panel text at 4 Hz, only on change.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as W from './world.js';
import { createPhoneAlign } from './phonealign.js';
import { toThreeCamera } from './extrinsics.js';

const params = new URLSearchParams(location.search);
const STORE = params.has('dummy') ? '-dummy' : '', SIM = params.has('sim'); // ?sim: field = the fake phones' room (sim.mjs)
const FIELD_KEY = 'fx-field-' + W.LAYOUT + STORE, CFG_KEY = 'fx-cfg2' + STORE;
const SLOTS = ['A', 'B'], OTHER = { A: 'B', B: 'A' };
const COL = { A: 0xff9a4d, B: 0x6cc8ff, tag: 0x3ddc84, chest: 0xff4df0, ghost: 0xc9c9c9, cam: 0xffd23d, grid: 0x3a4150 };
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], [0, 11], [0, 12]];
const HIDE = [0, -50, 0]; // a bone with a missing end collapses to a point far below the floor
const DEG = Math.PI / 180;
const $ = id => document.getElementById(id);
const nowS = () => Date.now() / 1000;

// ---- shared settings from the display (same origin, same Chrome) ----
let fieldScanned = false, tagCam = null;
function loadField() {
  if (SIM) { // ?sim: the room of sensing/dashboard/sim.mjs (fake-phone.mjs), in the setField convention: origin at the tag centroid,
    // +x from A's side to B's; sim tag axes (x [1,0,0], y [0,0,-1], z up) are world.js floor yaw 0; its tags are 0.15 m
    const C = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 0, 2.6], 3: [0, 0, 2.6] }, tags = {};
    // the sim computes tags[].p with its true 0.15 m size (as if that were typed into the phone), so no rescale: tagScale must be 1
    for (const id in C) { W.TAGS[id].size = W.PHONE_TAG_SIZE; tags[id] = { pos: [C[id][0] - 2, 0, C[id][2] - 1.3], yaw: 0 }; }
    for (const s of SLOTS) W.TAGS[W.PLAYER_TAG[s]].size = W.PHONE_TAG_SIZE; // chest tags likewise
    fieldScanned = true; W.setField({ poly: [0, 1, 2, 3].map(id => [tags[id].pos[0], tags[id].pos[2]]), tags }); return;
  }
  try { const f = JSON.parse(localStorage.getItem(FIELD_KEY)); if (f?.poly) { fieldScanned = true; W.setField(f); } } catch {}
}
function loadCam() { try { tagCam = JSON.parse(localStorage.getItem(CFG_KEY))?.tagCam ?? null; } catch { tagCam = null; } placeTagCam(); }
addEventListener('storage', e => { if (e.key === FIELD_KEY) loadField(); else if (e.key === CFG_KEY) loadCam(); }); // the admin rescans: follow live

// ---- scene ----
const canvas = $('gl'), view = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0d0f14);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
camera.position.set(3.5, 3.2, 5.5);
const controls = new OrbitControls(camera, canvas); controls.target.set(0, 0.8, 0); controls.enableDamping = true; controls.dampingFactor = .12;
function resize() { const w = view.clientWidth, h = view.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

const toMat = (p, m = new THREE.Matrix4()) => m.set(p.R[0], p.R[1], p.R[2], p.t[0], p.R[3], p.R[4], p.R[5], p.t[1], p.R[6], p.R[7], p.R[8], p.t[2], 0, 0, 0, 1);
const lineMat = (color, extra = {}) => new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false, ...extra });
/** LineSegments over a preallocated buffer of `segs` segments; write(i, a, b) sets one, draw(n) shows the first n. */
function segs(n, mat, vertexColors = false) {
  const pos = new Float32Array(n * 6), g = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3); g.setAttribute('position', attr);
  let col = null; if (vertexColors) { col = new THREE.BufferAttribute(new Float32Array(n * 6), 3); g.setAttribute('color', col); }
  const obj = new THREE.LineSegments(g, mat); obj.frustumCulled = false; obj.renderOrder = 10;
  const c = new THREE.Color();
  return {
    obj, pos,
    write(i, a, b, color) { pos.set(a, i * 6); pos.set(b, i * 6 + 3); if (col && color != null) { c.set(color); const o = i * 6, A = col.array; A[o] = A[o + 3] = c.r; A[o + 1] = A[o + 4] = c.g; A[o + 2] = A[o + 5] = c.b; } },
    draw(k) { g.setDrawRange(0, k * 2); attr.needsUpdate = true; if (col) col.needsUpdate = true; },
  };
}
/** A dashed LineSegments needs per-vertex line distances: filled by hand so no attribute is reallocated per update. */
function dashedSegs(n, color) {
  const s = segs(n, new THREE.LineDashedMaterial({ color, dashSize: .06, gapSize: .04, transparent: true, opacity: .8, depthTest: false }));
  const ld = new THREE.BufferAttribute(new Float32Array(n * 2), 1); s.obj.geometry.setAttribute('lineDistance', ld);
  const w = s.write; s.write = (i, a, b) => { w(i, a, b); ld.array[i * 2] = 0; ld.array[i * 2 + 1] = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
  const d = s.draw; s.draw = k => { d(k); ld.needsUpdate = true; };
  return s;
}
function label(text, color = '#e7e9ee', size = .22) { // a sprite with the text; built on (rare) field changes only
  const c = document.createElement('canvas'), ctx = c.getContext('2d'); c.width = 128; c.height = 64;
  ctx.font = 'bold 40px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color; ctx.fillText(text, 64, 32);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(size * 2, size, 1); sp.renderOrder = 20; return sp;
}

// static-ish world: grid, field outline, field tags (rebuilt when the field changes)
const world = new THREE.Group(); scene.add(world);
world.add(new THREE.GridHelper(8, 16, COL.grid, 0x242a36));
world.add(new THREE.AxesHelper(.5));
const fieldGrp = new THREE.Group(); world.add(fieldGrp);
const tagsGrp = new THREE.Group(); world.add(tagsGrp);
let standing = false;
function buildField() {
  fieldGrp.clear(); tagsGrp.clear();
  const P = W.FIELD.poly, pts = [...P, P[0]].map(([x, z]) => new THREE.Vector3(x, .005, z));
  fieldGrp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(0xffffff, { opacity: .7 })));
  for (const s of SLOTS) { const m = label(s, s === 'A' ? '#ff9a4d' : '#6cc8ff', .3); m.position.set(W.START[s].pos[0], .15, W.START[s].pos[2]); fieldGrp.add(m); }
  standing = false;
  for (const id of W.CORNER_IDS) {
    const p = W.worldTagPose(id), size = W.TAGS[id].size, t = W.TAGS[id]; if (t.stand) standing = true;
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: COL.tag, side: THREE.DoubleSide, transparent: true, opacity: .55 }));
    tag.matrixAutoUpdate = false; toMat(p, tag.matrix);
    const ax = new THREE.AxesHelper(size * .6); ax.matrixAutoUpdate = false; ax.matrix.copy(tag.matrix); // printed x (red) / y (green) / normal (blue)
    const l = label(String(id), '#3ddc84'); l.position.set(p.t[0], p.t[1] + (t.stand ? size * .8 : .18), p.t[2]);
    tagsGrp.add(tag, ax, l);
    if (t.stand) { const pole = new THREE.Mesh(new THREE.CylinderGeometry(.01, .01, p.t[1]), new THREE.MeshBasicMaterial({ color: 0x666e7c })); pole.position.set(p.t[0], p.t[1] / 2, p.t[2]); tagsGrp.add(pole); }
  }
  legendNote();
}
W.onFieldChange(buildField);

// third-person camera (the scan result in fx-cfg2)
const tpCam = new THREE.PerspectiveCamera(45, 16 / 9, .2, 2.5), tpHelper = new THREE.CameraHelper(tpCam);
tpHelper.setColors?.(new THREE.Color(COL.cam), new THREE.Color(COL.cam), new THREE.Color(COL.cam), new THREE.Color(0xffffff), new THREE.Color(0x8888ff));
world.add(tpHelper); tpHelper.visible = false;
const tpLabel = label('3人称カメラ', '#ffd23d', .28); world.add(tpLabel); tpLabel.visible = false;
function placeTagCam() {
  tpHelper.visible = tpLabel.visible = !!tagCam;
  if (!tagCam) return;
  toThreeCamera(tagCam, tpCam); tpCam.near = .2; tpCam.far = 2.5; tpCam.updateProjectionMatrix(); tpHelper.update();
  tpLabel.position.set(tagCam.pose.t[0], tagCam.pose.t[1] + .25, tagCam.pose.t[2]);
}

// ---- per-source drawables (preallocated) ----
const TRAIL_N = 200, RAY_N = 24;
const src = {};
for (const s of SLOTS) {
  const color = COL[s];
  const trailPos = new Float32Array(TRAIL_N * 3), tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  const trail = new THREE.Line(tg, lineMat(color, { opacity: .6 })); trail.frustumCulled = false;
  const frustum = segs(8, lineMat(color));
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), .5, color, .12, .07);
  const chest = new THREE.Mesh(new THREE.PlaneGeometry(.18, .18), new THREE.MeshBasicMaterial({ color: COL.chest, side: THREE.DoubleSide, transparent: true, opacity: .7 })); chest.matrixAutoUpdate = false;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(.05, 12, 8), new THREE.MeshBasicMaterial({ color }));
  const seen = new THREE.Mesh(new THREE.OctahedronGeometry(.06), new THREE.MeshBasicMaterial({ color: COL.chest, wireframe: true })); // where the other phone saw my chest tag
  const stick = segs(1, lineMat(color, { linewidth: 2 }));
  const stickTip = new THREE.Mesh(new THREE.SphereGeometry(.04, 10, 6), new THREE.MeshBasicMaterial({ color }));
  const body = segs(BONES.length, lineMat(color, { opacity: .9 }));
  const tip = new THREE.Mesh(new THREE.OctahedronGeometry(.05), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const ghostBody = dashedSegs(BONES.length, COL.ghost);
  const ghost = new THREE.Mesh(new THREE.SphereGeometry(.09, 10, 6), new THREE.MeshBasicMaterial({ color: COL.ghost, wireframe: true, transparent: true, opacity: .6 }));
  const ghostTip = new THREE.Mesh(new THREE.OctahedronGeometry(.05), new THREE.MeshBasicMaterial({ color: COL.ghost, wireframe: true }));
  const grp = new THREE.Group(); grp.add(trail, frustum.obj, arrow, chest, dot, seen); scene.add(grp);
  const stickGrp = new THREE.Group(); stickGrp.add(stick.obj, stickTip); scene.add(stickGrp);
  const bodyGrp = new THREE.Group(); bodyGrp.add(body.obj); scene.add(bodyGrp);
  const tipGrp = new THREE.Group(); tipGrp.add(tip); scene.add(tipGrp);
  const ghostGrp = new THREE.Group(); ghostGrp.add(ghostBody.obj, ghost, ghostTip); scene.add(ghostGrp);
  src[s] = { grp, trail, trailPos, tg, frustum, arrow, chest, dot, seen, stickGrp, stick, stickTip, bodyGrp, body, tipGrp, tip, ghostGrp, ghostBody, ghost, ghostTip };
}
const rays = segs(RAY_N, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .8, depthTest: false }), true); scene.add(rays.obj);

// ---- legend / toggles ----
const TOGGLES = [
  ['phoneA', 'スマホ A（AR 軌跡・向き・胸タグ）', 'var(--a)'], ['phoneB', 'スマホ B（AR 軌跡・向き・胸タグ）', 'var(--b)'],
  ['rays', 'タグの観測（緑=フィールド、桃=胸）', 'var(--tag)'], ['imu', 'IMU の棒の向き（胸から）', 'var(--fg)'],
  ['bodies', '相手の骨格（胸カメラの推定）', 'var(--fg)'], ['tips', '棒の先端（色追跡）', '#fff'],
  ['mapjs', 'センサー班 map.js の推定（点線）', 'dash'], ['tags', 'フィールドのタグ・3人称カメラ', 'var(--cam)'], ['grid', 'グリッド', 'var(--dim)'],
];
const on = Object.fromEntries(TOGGLES.map(([k]) => [k, true]));
try { Object.assign(on, JSON.parse(localStorage.getItem('fx-space-toggles') ?? '{}')); } catch {}
const legend = $('legend');
for (const [k, text, color] of TOGGLES) {
  const l = document.createElement('label'), cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: on[k] });
  cb.onchange = () => { on[k] = cb.checked; try { localStorage.setItem('fx-space-toggles', JSON.stringify(on)); } catch {} };
  const sw = document.createElement('i'); if (color === 'dash') sw.className = 'dash'; else sw.style.background = color;
  l.append(cb, sw, text); legend.append(l);
}
const note = document.createElement('div'); note.className = 'note'; legend.append(note);
function legendNote() {
  note.textContent = standing ? '立てたタグ: map.js は床タグだけで部屋を決めるので、点線の推定は照合できない（立てたタグを胸タグと取り違える）' : fieldScanned ? '' : 'フィールド未スキャン: 仮の位置で表示';
}

// ---- data: relay -> phonealign (+ map.js for comparison) ----
const PA = createPhoneAlign();
let smap = null, smapWarn = null;
import('/sensing/map.js').then(M => { smap = M.createMap(); }).catch(e => { smapWarn = 'map.js を読み込めない: ' + e.message; });
const lat = { A: {}, B: {} }, last = { A: {}, B: {} }, phones = { A: null, B: null };
const SAME_ORIGIN = ['8002', '8443'].includes(location.port) || location.protocol === 'https:';
const relayUrl = params.get('host') ? `ws://${params.get('host')}/ws` : SAME_ORIGIN ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` : `ws://${location.hostname}:8000/ws`;
$('hostLabel').textContent = relayUrl;
let linkState = 'connecting';
function connect() {
  const ws = new WebSocket(relayUrl); ws.binaryType = 'arraybuffer';
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', role: 'dashboard', id: 'kawashima-space' })); linkState = 'connected'; };
  ws.onclose = () => { linkState = 'disconnected'; setTimeout(connect, 1000); };
  ws.onmessage = m => {
    if (typeof m.data !== 'string') return; // chest-camera JPEGs: not shown here
    let k; try { k = JSON.parse(m.data); } catch { return; }
    PA.ingest(k); smap?.ingest(k);
    if (k.type === 'phones') { for (const s of SLOTS) phones[s] = k.list.find(q => q.slot === s) ?? null; return; }
    if (!lat[k.slot]) return;
    if (k.t) lat[k.slot][k.type] = nowS() - k.t;
    last[k.slot][k.type] = k;
  };
}
connect();

// map.js room -> our world: yaw + shift fitted on the shared FLOOR tags (same as app.js fitRoom); null when it cannot be done
function fitRoom(corners) {
  const pairs = (corners ?? []).filter(c => W.TAGS[c.id]?.floor && fieldScanned).map(c => [c.p, W.TAGS[c.id].pos]);
  if (pairs.length < 2) return null;
  const m = i => pairs.reduce((a, q) => [a[0] + q[i][0] / pairs.length, a[1] + q[i][2] / pairs.length], [0, 0]), ma = m(0), mb = m(1);
  let sc = 0, ss = 0;
  for (const [a, b] of pairs) { const A = [a[0] - ma[0], a[2] - ma[1]], B = [b[0] - mb[0], b[2] - mb[1]]; sc += A[0] * B[0] + A[1] * B[1]; ss += A[0] * B[1] - A[1] * B[0]; }
  const th = Math.atan2(ss, sc), c = Math.cos(th), s = Math.sin(th);
  return p => [c * (p[0] - ma[0]) - s * (p[2] - ma[1]) + mb[0], p[1], s * (p[0] - ma[0]) + c * (p[2] - ma[1]) + mb[1]];
}

// ---- per-estimate scene update (15 Hz) ----
const V = new THREE.Vector3(), V2 = new THREE.Vector3(), tmpM = new THREE.Matrix4();
let est = null, ghostEst = null, roomToWorld = null, estAt = 0, ghostAt = 0;
function frustumOf(g, k) { // the phone camera's view pyramid: 0.4 m deep, from the intrinsics (cx, cy at the centre)
  const cam = g.cam; if (!cam) return null;
  const Wcv = W.compose(cam, W.arcam_T_cv), K = k ?? [1.04, .78, .5, .5], z = .4, hx = .5 / K[0] * z, hy = .5 / K[1] * z;
  return { o: Wcv.t, c: [[-hx, -hy, z], [hx, -hy, z], [hx, hy, z], [-hx, hy, z]].map(p => W.apply(Wcv, p)) };
}
function updateScene(t) {
  est = PA.estimate(t);
  let nRays = 0;
  for (const s of SLOTS) {
    const d = src[s], g = est.slots[s], show = on['phone' + s];
    d.grp.visible = show && !!g.chest;
    if (d.grp.visible) {
      const n = Math.min(TRAIL_N, g.trail.length), off = g.trail.length - n;
      for (let i = 0; i < n; i++) d.trailPos.set(g.trail[off + i], i * 3);
      d.tg.setDrawRange(0, n); d.tg.attributes.position.needsUpdate = true; d.trail.visible = n > 1;
      d.dot.position.set(...g.chest);
      const f = frustumOf(g, g.k);
      if (f) { for (let i = 0; i < 4; i++) { d.frustum.write(i, f.o, f.c[i]); d.frustum.write(4 + i, f.c[i], f.c[(i + 1) % 4]); } d.frustum.draw(8); }
      d.frustum.obj.visible = !!f;
      d.arrow.visible = !!g.fwd;
      if (g.fwd) { d.arrow.position.set(...g.chest); d.arrow.setDirection(V.set(...g.fwd)); }
      d.chest.visible = g.yaw != null;
      if (d.chest.visible) toMat(W.chestTagPose(W.bodyPose(g.chest, g.yaw, g.chest[1])), d.chest.matrix);
      d.seen.visible = !!g.seenBy; if (g.seenBy) d.seen.position.set(...g.seenBy.p);
      if (on.rays && g.sightings) for (const q of g.sightings) { if (nRays >= RAY_N) break; rays.write(nRays++, g.chest, q.p, W.TAGS[q.id]?.pos ? COL.tag : COL.chest); }
    }
    // IMU stick from the chest (hand offset on the body frame)
    const sk = est.stick[s]; d.stickGrp.visible = on.imu && !!sk?.base;
    if (d.stickGrp.visible) { const tip = sk.base.map((v, i) => v + sk.dir[i] * W.STICK.len); d.stick.write(0, sk.base, tip); d.stick.draw(1); d.stickTip.position.set(...tip); }
    // what the OTHER phone sees of s: body and tip
    const b = est.bodies[s]; d.bodyGrp.visible = on.bodies && !!b;
    if (d.bodyGrp.visible) { BONES.forEach(([i, j], n) => b[i] && b[j] ? d.body.write(n, b[i], b[j]) : d.body.write(n, HIDE, HIDE)); d.body.draw(BONES.length); }
    const tp = est.tips[s]; d.tipGrp.visible = on.tips && !!tp;
    if (d.tipGrp.visible) d.tip.position.set(...tp.p);
  }
  rays.draw(nRays); rays.obj.visible = on.rays && nRays > 0;
  // map.js ghost (4 Hz is plenty for a comparison)
  if (smap && on.mapjs && t - ghostAt > .25) {
    ghostAt = t;
    try { ghostEst = smap.estimate({ now: t, L: { A: W.STICK.len, B: W.STICK.len } }); roomToWorld = fitRoom(ghostEst.corners); } catch { ghostEst = null; roomToWorld = null; }
  }
  for (const s of SLOTS) {
    const d = src[s], ok = on.mapjs && roomToWorld && ghostEst;
    d.ghostGrp.visible = !!ok; if (!ok) continue;
    const p = ghostEst.people[s]; d.ghost.visible = !!p; if (p) d.ghost.position.set(...roomToWorld(p.p));
    const b = ghostEst.bodies[s]; d.ghostBody.obj.visible = !!b;
    if (b) { BONES.forEach(([i, j], n) => b[i] && b[j] ? d.ghostBody.write(n, roomToWorld(b[i]), roomToWorld(b[j])) : d.ghostBody.write(n, HIDE, HIDE)); d.ghostBody.draw(BONES.length); }
    const tp = ghostEst.tips[s]; d.ghostTip.visible = !!tp; if (tp) d.ghostTip.position.set(...roomToWorld(tp.p));
  }
  world.children[0].visible = on.grid; tagsGrp.visible = on.tags; tpHelper.visible = tpLabel.visible = on.tags && !!tagCam;
}

// ---- right panel: raw numbers, 4 Hz, DOM touched only when the text changes ----
const panel = $('panel'), cells = new Map(), shown = new Map();
function section(title, rows) {
  const h = document.createElement('h3'); h.textContent = title; panel.append(h);
  const tb = document.createElement('table');
  for (const [key, name, cls] of rows) {
    const tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td'); b.className = 'v' + (cls ? ' ' + cls : '');
    a.textContent = name; tr.append(a, b); tb.append(tr); cells.set(key, b);
  }
  panel.append(tb);
}
const put = (key, text) => { if (shown.get(key) !== text) { shown.set(key, text); cells.get(key).textContent = text; } };
const f2 = v => v == null || !isFinite(v) ? '-' : v.toFixed(2), f1 = v => v == null || !isFinite(v) ? '-' : v.toFixed(1), f0 = v => v == null || !isFinite(v) ? '-' : v.toFixed(0);
const vec = (v, d = 2) => v ? '[' + v.map(x => x.toFixed(d)).join(', ') + ']' : '-';
const ms = v => v == null ? '-' : (v * 1000).toFixed(0) + ' ms';
for (const s of SLOTS) section(`スマホ ${s}`, [
  [s + 'name', '接続', s], [s + 'src', '位置の元'], [s + 'align', '合わせ θ / t'], [s + 'fit', '残差 / 観測数'], [s + 'chest', '胸 [x,y,z]'], [s + 'yaw', '向き yaw'],
  [s + 'check', '胸タグ照合'], [s + 'wp', 'ar.wp'], [s + 'wq', 'ar.wq'], [s + 'hz', '受信 Hz'], [s + 'lat', '遅延'], [s + 'k', '内部パラメータ k'], [s + 'fov', '画角 (横×縦)'], [s + 'tags', '見えているタグ'], [s + 'imu', 'IMU 棒の向き'], [s + 'body', '相手から見た骨格'],
]);
section('3人称カメラ・フィールド', [['camT', 'カメラ位置'], ['camFov', '縦画角 / 解像度'], ['camErr', 'スキャン誤差'], ['field', 'フィールド'], ['ftags', 'タグ配置'], ['mapjs', 'map.js の推定'], ['warn', '注意', 'warn']]);
function updatePanel(t) {
  if (!est) return;
  for (const s of SLOTS) {
    const g = est.slots[s], L = lat[s], k = last[s];
    put(s + 'name', phones[s] ? `${phones[s].name ?? ''} (${g.online ? 'online' : '-'})` : 'なし');
    put(s + 'src', g.src === 'ar' ? `ARCore 世界を合わせた (wp/wq)${g.aligned ? '' : '、観測 3 未満'}` : g.src === 'localize' ? '旧アプリ: localize.js（キャリブ基準 p/q）' : g.src === 'tag' ? '相手の胸タグ観測のみ' : '-');
    put(s + 'align', g.theta == null ? '-' : `${(g.theta / DEG).toFixed(1)}°  ${vec(g.t)}`);
    put(s + 'fit', g.src === 'localize' ? `ずれ ${f0(g.rms * 100)} cm / 固定 ${g.fixes} 回` : `${f1(g.rms == null ? null : g.rms * 100)} cm / ${g.n} 回（採用 ${g.used ?? '-'}）${g.lastFix ? `  最終 ${f1(t - g.lastFix)} s 前` : ''}`);
    put(s + 'chest', vec(g.chest));
    put(s + 'yaw', g.yaw == null ? '-' : `${(g.yaw / DEG).toFixed(1)}°  fwd ${vec(g.fwd)}`);
    put(s + 'check', g.check == null ? '-' : `${g.check.toFixed(1)} cm（${f1(t - g.checkT)} s 前、${OTHER[s]} が見た胸タグとの差）`);
    put(s + 'wp', vec(k.ar?.wp, 3)); put(s + 'wq', vec(k.ar?.wq, 3));
    put(s + 'hz', ['ar', 'tags', 'imu', 'pose', 'color'].map(ty => `${ty} ${f0(g.hz[ty])}`).join('  '));
    put(s + 'lat', ['ar', 'tags', 'imu'].map(ty => `${ty} ${ms(L[ty])}`).join('  '));
    put(s + 'k', vec(g.k, 3));
    put(s + 'fov', g.k ? `${(2 * Math.atan(.5 / g.k[0]) / DEG).toFixed(0)}° × ${(2 * Math.atan(.5 / g.k[1]) / DEG).toFixed(0)}°` : '-');
    put(s + 'tags', g.sightings?.length ? g.sightings.map(q => `${q.id}:${q.d.toFixed(2)}m`).join(' ') : k.tags && t - k.tags.t < .5 ? `${k.tags.tags?.length ?? 0} 枚（AR 時刻合わず）` : '-');
    const sk = est.stick[s]; put(s + 'imu', sk ? `${vec(sk.dir)} ${sk.src === 'calib-ar' ? '(キャリブ時の AR 向き基準)' : '(開始位置の向き基準)'}` : k.imu ? 'q あり' : '-');
    const b = est.bodies[s]; put(s + 'body', b ? `${b.filter(Boolean).length}/33 点${est.tips[s] ? `  先端 ${vec(est.tips[s].p)} (${est.tips[s].src})` : ''}` : '-');
  }
  put('camT', tagCam ? vec(tagCam.pose.t) : 'なし（fx-cfg2 に tagCam がない）');
  put('camFov', tagCam ? `${f1(tagCam.fovY)}° / ${tagCam.width}×${tagCam.height}` : '-');
  put('camErr', tagCam ? `${f1(tagCam.reprojErrPx)} px  タグ ${tagCam.ids?.join(',') ?? ''}` : '-');
  const xs = W.FIELD.poly.map(p => p[0]), zs = W.FIELD.poly.map(p => p[1]);
  put('field', `${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} m × ${(Math.max(...zs) - Math.min(...zs)).toFixed(2)} m${SIM ? '（?sim: fake-phone の部屋）' : fieldScanned ? '' : '（未スキャン・仮）'}`);
  put('ftags', W.CORNER_IDS.map(id => `${id}:${W.TAGS[id].stand ? '立' : '床'}${vec(W.TAGS[id].pos, 1)}`).join(' '));
  put('mapjs', smapWarn ?? (!smap ? '読み込み中' : standing ? '照合不可（立てたタグ）' : roomToWorld ? `照合済  ${ghostEst?.align ? `残差 ${f1(ghostEst.align.rms * 100)} cm` : ''} 床タグ ${ghostEst?.corners?.length ?? 0}` : '床タグ 2 枚以上を両スマホが見るまで照合できない'));
  put('warn', [...(est.warn ?? []), ...(ghostEst?.warn ?? []).slice(0, 2)].join('；'));
  $('link').textContent = linkState === 'connected' ? '中継に接続' : '中継に未接続（再試行中）'; $('link').className = linkState === 'connected' ? 'ok' : 'ng';
  $('fieldLabel').textContent = `layout ${W.LAYOUT}${STORE}${SIM ? ' sim' : ''}`;
}

// ---- loop: estimate 15 Hz, panel 4 Hz, render ≤ 60 fps ----
loadField(); if (!fieldScanned) buildField(); loadCam();
let lastEst = 0, lastPanel = 0, lastFrame = 0, fps = 60;
function frame(ts) {
  requestAnimationFrame(frame);
  if (ts - lastFrame < 1000 / 60 - 2) return;
  fps = .95 * fps + .05 * 1000 / Math.max(1, ts - lastFrame); lastFrame = ts;
  const t = nowS();
  if (t - lastEst > 1 / 15) { lastEst = t; updateScene(t); }
  if (t - lastPanel > .25) { lastPanel = t; updatePanel(t); $('fps').textContent = `${fps.toFixed(0)} fps`; }
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
