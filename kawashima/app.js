// Third-person camera video + Three.js effects placed from the phones' sensor data.
// Frames and the arena layout live in world.js. Players are located by localize.js (corner tags + ARCore),
// the third-person camera by extrinsics.js (corner tags in its own picture) or by hand with the sliders.
import * as THREE from 'three';
import * as W from './world.js';
import { createLocalizer } from './localize.js';
import { createFx } from './effects.js';
import { calibrateCamera, toThreeCamera, detectTags, solveCamera } from './extrinsics.js';
import { createDrone } from './drone.js';
import { createField, createMinimap } from './field3d.js';
import { createMap } from '/sensing/map.js'; // the sensing team's space map: each phone's view of the opponent's body

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v3 = a => V(a[0], a[1], a[2]);
const params = new URLSearchParams(location.search);
// ---- sound (audio.js): loaded lazily so a missing / failing module never stops the picture ----
let sfx = null;
import('./audio.js').then(M => { sfx = M.createAudio(); sfx.load(); }).catch(e => console.warn('audio', e));
const panOf = v => { // world x across the field -> stereo pan -1..1 (the camera looks along -z, so +x is screen right)
  const xs = W.FIELD.poly.map(q => q[0]), a = Math.min(...xs), b = Math.max(...xs);
  return Math.max(-1, Math.min(1, ((v.x - a) / ((b - a) || 1)) * 2 - 1));
};
const now = () => performance.now() / 1000;

// ---- settings (kept in localStorage) ----
// where the iPhone should go (NOTES.md): 3.5 m in front of the centre (whole arena in a ~70° wide picture), 1.7 m up or
// higher, tilted down to see the floor tags 2.5 m away as well as the players' heads
const GUIDE_CAM = { x: 0, y: 1.7, z: 3.5, yaw: 0, pitch: -16, roll: 0, fov: 45 };
const SIDE = { left: '左', right: '右' };
function tagPlace(id) { // where a fixed tag goes, in words
  const [x, y, z] = W.TAGS[id].pos, m = v => `${+Math.abs(v).toFixed(2)}m`, lr = `中心から${x < 0 ? '左' : '右'}へ${m(x)}`;
  return W.TAGS[id].floor ? `${lr}${z ? `・${z > 0 ? '手前' : '奥'}へ${m(z)}` : ''}の床`
    : `${x < 0 ? '左' : '右'}端（${lr}）・中心の高さ ${y}m`;
}
const DEFAULTS = {
  cam: { ...GUIDE_CAM }, // manual camera, fov = vertical degrees
  tagCam: null,     // result of calibrateCamera, used when camMode === 'tags'
  camMode: 'manual',
  aim: 'stick',     // 'stick': along the stick, 'eye': eye -> stick tip
  swingDps: 400,    // provisional swing trigger until the sensor team sends actions
  debug: false,     // grid / tags / capsules in the main view
  view: 'pip',      // 'pip' | 'full3d' | 'off'
  drone: 'auto',    // drone camera mode for the 3D view (D cycles)
  minimap: true,    // top-down map in the corner (M)
  useTruth: false,  // fake-world only: place players from the simulator's ground truth
  fpv: null,        // 'A' | 'B': show that chest phone's own camera picture, camera placed by localize.js
  anchors: true,    // in the phone view, a flame on every fixed tag: it sits on the paper when the registration is right
  posSrc: 'camera', // where the players' positions come from: 'camera' (pose estimation on the third-person video),
                    // 'phones' (chest phones: ARCore + tags, localize.js) or 'start' (fixed at the start marks)
  hand: 'R',        // which wrist holds the stick when positions come from the camera
  tagMode: 4,       // map4 layout: scan with 2 sheets (ids 0 / 1 mark the A / B ends) or 4 sheets (ids 0-3 at the corners)
  skeleton: false,
  skelSrc: 'both',  // skeletons in 3D from 'camera' (third-person video), 'phones' (opponent's chest camera) or 'both'  // the camera-tracked skeletons over the video too (they always show in the 3D views)
};
const STORE = params.has('dummy') ? '-dummy' : ''; // the dummy room keeps its own settings: its scans must never leak into the real setup
const load = () => { try { return JSON.parse(localStorage.getItem('fx-cfg2' + STORE)) ?? {}; } catch { return {}; } };
const saved = load();
const cfg = { ...DEFAULTS, ...saved, cam: { ...DEFAULTS.cam, ...saved.cam } };
const save = () => { try { localStorage.setItem('fx-cfg2' + STORE, JSON.stringify(cfg)); } catch {} };

// ---- renderer / scene / cameras ----
const canvas = document.getElementById('gl'), video = document.getElementById('video'), stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.SRGBColorSpace;
const DARK = new THREE.Color(0x0d0f14);
const camera = new THREE.PerspectiveCamera(cfg.cam.fov, 16 / 9, 0.05, 100);
camera.rotation.order = 'YXZ';
const overCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 100);
overCam.position.set(0, 5.5, 6.5);
const drone = createDrone(overCam, canvas, { mode: cfg.drone });
let field = createField(scene); // arena + avatars, only shown in the 3D views
field.group.visible = false;
const minimapCanvas = Object.assign(document.createElement('canvas'), { id: 'minimap' });
stage.append(minimapCanvas);
const minimap = createMinimap(minimapCanvas);
let aspect = 16 / 9, videoAspect = 16 / 9, W_px = 1, H_px = 1;

function applyCam() {
  if (cfg.fpv) { /* placed every frame from the phone's pose */ }
  else if (cfg.camMode === 'tags' && cfg.tagCam) toThreeCamera(cfg.tagCam, camera);
  else {
    const c = cfg.cam, d = THREE.MathUtils.degToRad;
    camera.position.set(c.x, c.y, c.z);
    camera.rotation.set(d(c.pitch), d(c.yaw), d(c.roll));
    camera.fov = c.fov;
  }
  camera.aspect = aspect; camera.updateProjectionMatrix();
  camHelper.update();
}
function resize() {
  aspect = cfg.fpv && phoneCanvas.width ? phoneCanvas.width / phoneCanvas.height : videoAspect;
  const w = Math.min(innerWidth, innerHeight * aspect), h = w / aspect;
  stage.style.width = w + 'px'; stage.style.height = h + 'px';
  // no more pixels than the camera picture: at DPR 2 the canvas was 3024x1701 (+MSAA) behind a 1920x1080 video
  renderer.setPixelRatio(Math.min(devicePixelRatio, Math.max(1, (cfg.fpv ? phoneCanvas.width : video.videoWidth || 1920) / w)));
  renderer.setSize(w, h, false);
  W_px = w; H_px = h;
  const m = Math.round(Math.min(w, h) * .28 * devicePixelRatio);
  minimapCanvas.width = minimapCanvas.height = m;
  fx.setSize(w, h);
  applyCam();
}

const fx = createFx(renderer, scene, camera);
let shake = 0;
fx.opts.onShake = a => { shake = Math.max(shake, a); };

// ---- 3D world: arena, tags, phones, third-person camera (always in the 3D view, in the main view with G) ----
const world3d = new THREE.Group(); scene.add(world3d);
const toMat = p => new THREE.Matrix4().set(p.R[0], p.R[1], p.R[2], p.t[0], p.R[3], p.R[4], p.R[5], p.t[1], p.R[6], p.R[7], p.R[8], p.t[2], 0, 0, 0, 1);
world3d.add(new THREE.GridHelper(W.ARENA.half * 2, 8, 0x888888, 0x444444));
const tags3d = new THREE.Group(); world3d.add(tags3d);
function buildTags3d() { // again whenever a scan measures where the floor tags really are
  tags3d.clear();
  for (const id of W.CORNER_IDS) {
    const p = W.worldTagPose(id), size = W.TAGS[id].size;
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    tag.matrixAutoUpdate = false; tag.matrix.copy(toMat(p));
    tags3d.add(tag);
    if (W.TAGS[id].floor) continue;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, p.t[1]), new THREE.MeshBasicMaterial({ color: 0x777777 }));
    pole.position.set(p.t[0], p.t[1] / 2, p.t[2]);
    tags3d.add(pole);
  }
}
buildTags3d();
const camHelper = new THREE.CameraHelper(camera); world3d.add(camHelper);

// ---- players ----
function makePlayer(slot, element) {
  const color = element === 'fire' ? 0xff7a1a : 0x6cc8ff;
  const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(.3, 1.2, 4, 12), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: .3 }));
  const stick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(), V()]), new THREE.LineBasicMaterial({ color }));
  const ghost = new THREE.Mesh(new THREE.SphereGeometry(.08), new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true })); // simulator truth
  const seen = new THREE.Mesh(new THREE.OctahedronGeometry(.07), new THREE.MeshBasicMaterial({ color: 0xff00ff })); // where the opponent saw my chest tag
  world3d.add(capsule, stick, ghost, seen);
  return { slot, element, hp: 100, online: false, imu: null, truth: null, charge: 0, charging: false,
    body: null, chest: V(), base: V(), tip: V(), dir: V(), lastShot: 0, capsule, stick, ghost, seen, hud: document.querySelector('.hud.' + slot) };
}
const players = { A: makePlayer('A', 'fire'), B: makePlayer('B', 'thunder') };
const other = p => p === players.A ? players.B : players.A;
const loc = createLocalizer();

const rotQ = ([w, x, y, z], [a, b, c]) => { // rotate v by quaternion [w, x, y, z]
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const IMU_SIDE = cross(W.STICK.axis, W.STICK.up);

function updatePlayer(p) {
  const L = loc.get(p.slot), st = W.START[p.slot];
  const T = p.truth;
  const pt = cfg.posSrc === 'camera' ? tracker?.get(p.slot) : null;
  p.body = cfg.useTruth && T ? W.bodyPose(T.chest, T.yaw, T.chest[1])
    : cfg.posSrc === 'camera' ? (pt?.foot ? W.bodyPose(pt.foot, pt.yaw ?? st.yaw, pt.chest?.[1] ?? W.CHEST_H) : p.body ?? W.bodyPose(st.pos, st.yaw))
    : cfg.posSrc === 'phones' ? L.body ?? W.bodyPose(st.pos, st.yaw) : W.bodyPose(st.pos, st.yaw);
  p.chest.copy(v3(p.body.t));
  p.capsule.position.copy(p.chest).setY(p.chest.y - .45);
  // hand in the body frame (x fwd, y up, z right); stick direction from the IMU, tared at the start mark facing the opponent
  const h = W.STICK.hand;
  const wrist = pt?.seen && pt.wrist?.[cfg.hand];
  p.base.copy(v3(wrist ?? W.apply(p.body, [h.fwd, h.up, h.right]))); // the camera sees the hand: use it
  if (p.imu) {
    const v = rotQ(p.imu.q, W.STICK.axis);
    p.dir.copy(v3(W.app3(W.bodyPose(st.pos, st.yaw).R, [dot(v, W.STICK.axis), dot(v, W.STICK.up), dot(v, IMU_SIDE)]))).normalize();
  } else p.dir.copy(v3(W.app3(p.body.R, [1, 0, 0])));
  p.tip.copy(p.base).addScaledVector(p.dir, W.STICK.len);
  p.stick.geometry.setFromPoints([p.base, p.tip]);
  p.ghost.visible = !!T; if (T) p.ghost.position.copy(v3(T.chest));
  const s = loc.get(other(p).slot).seen?.opponent;
  p.seen.visible = !!s && now() - s.t < 1; // s.t is PC time; the check only hides stale marks
  if (s) p.seen.position.copy(v3(s.pos));
  if (match.phase !== 'setup' && (p.online || p.imu || match.phase === 'demo')) { // no effects while setting up
    fx.aura(p.element, p.base, p.tip, p.charging ? .6 + .4 * p.charge : .5);
    if (p.charging) fx.charge(p.element, p.tip, p.charge);
    sfx?.aura(p.slot, p.element, match.paused ? 0 : p.charging ? .6 + .4 * p.charge : .4, panOf(p.chest));
  } else sfx?.aura(p.slot, p.element, 0, 0);
}

// ---- game ----
const shots = [];
let winner = null;

function shoot(p, power = .5) {
  if (!canAct() || now() - p.lastShot < .6) return;
  p.lastShot = now();
  const foe = other(p);
  if (power >= 1) { // full charge: special move straight at the opponent
    fx.special(p.element, p.tip.clone(), foe.chest.clone()); sfx?.special(p.element, panOf(p.tip));
    drone.event('special', { owner: p.slot, from: p.tip.clone(), to: foe.chest.clone() });
    return damage(foe, p, 35);
  }
  const aim = match.phase === 'demo' ? foe.chest.clone().sub(p.tip).normalize()
    : cfg.aim === 'eye' ? p.tip.clone().sub(p.chest.clone().add(V(0, .35, 0))).normalize() : p.dir.clone();
  drone.event('shot', { owner: p.slot, pos: p.tip.clone(), dir: aim.clone() }); sfx?.shot(p.element, panOf(p.tip), power);
  shots.push({ id: fx.shot(p.element, p.tip.clone(), aim.clone(), power), owner: p, element: p.element, pos: p.tip.clone(), vel: aim.multiplyScalar(9), power, born: now() });
}
function damage(foe, from, n) {
  flash(from.element);
  if (match.phase !== 'fight' || params.has('test')) return; // setting up / demo / ?test: hits show but HP never drops
  foe.hp = Math.max(0, foe.hp - n);
  if (foe.hp === 0) finish(from);
}
function stepShots(dt) {
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i], foe = other(s.owner);
    s.pos.addScaledVector(s.vel, dt);
    fx.moveShot(s.id, s.pos);
    // hit: distance to the opponent's vertical body segment (capsule radius .3 + shot radius .15)
    const a = foe.chest.clone().setY(foe.chest.y - 1.05), b = foe.chest.clone().setY(foe.chest.y + .15);
    const hit = new THREE.Line3(a, b).closestPointToPoint(s.pos, true, V()).distanceTo(s.pos) < .45;
    if (hit) { fx.hit(s.owner.element, s.pos.clone(), s.power); sfx?.hit(s.owner.element, panOf(s.pos), s.power); drone.event('hit', { target: foe.slot, pos: s.pos.clone(), power: s.power }); damage(foe, s.owner, Math.round(10 + 20 * s.power)); }
    if (hit || now() - s.born > 1.5) { fx.endShot(s.id); shots.splice(i, 1); }
  }
}
function stepCharge(dt) {
  for (const p of Object.values(players)) if (p.charging) {
    const full = p.charge < 1;
    p.charge = Math.min(1, p.charge + dt / 1.5);
    if (full && p.charge === 1) drone.event('charge', { owner: p.slot, level: 1 });
  }
}
function reset() { for (const p of Object.values(players)) { p.hp = 100; p.charge = 0; p.charging = false; } for (const s of shots) fx.endShot(s.id); shots.length = 0; winner = null; }

// ---- match flow: setup -> demo / countdown -> fight -> result. Driven by keys 1-4 here or by admin.html ----
// setup: shots work for checking but nothing counts. demo: both fire on their own (also ?demo). fight: HP and timer count.
const match = { phase: 'setup', ready: false, paused: false, sec: 90, left: 90, until: 0, fightAt: -9 };
// ready: the third-person camera was scanned (calibrated from every fixed tag) in this session; demo and fight wait for it
const canAct = () => !match.paused && (match.phase === 'demo' || match.phase === 'fight');
function setPhase(ph) {
  if ((ph === 'fight' || ph === 'demo') && !match.ready) { status.extra = 'スキャンが済んでいないので始められない。タグを置いて「タグでカメラ合わせ」(K)'; return; }
  reset();
  match.paused = false;
  if (ph === 'fight') { match.phase = 'countdown'; match.until = now() + 3; } else match.phase = ph;
}
function finish(w) { winner = w; match.phase = 'result'; for (const p of Object.values(players)) p.charging = false; }
function stepMatch(dt) {
  if (match.phase === 'countdown' && now() >= match.until) { match.phase = 'fight'; match.left = match.sec; match.fightAt = now(); }
  if (match.phase !== 'fight' || match.paused) return;
  match.left = Math.max(0, match.left - dt);
  const { A, B } = players;
  if (match.left === 0) finish(A.hp === B.hp ? null : A.hp > B.hp ? A : B); // time up: more HP wins, equal is a draw
}
setInterval(() => {
  if (match.phase !== 'demo' || match.paused) return;
  shoot(players.A, Math.random() * .9); setTimeout(() => shoot(players.B, Math.random() * .9), 400);
}, 800);

const flashEl = document.getElementById('flash');
function flash(el) {
  flashEl.style.transition = 'none'; flashEl.style.opacity = .5;
  flashEl.style.background = el === 'fire' ? 'radial-gradient(#ff7a1a, transparent 70%)' : 'radial-gradient(#bfe8ff, transparent 70%)';
  requestAnimationFrame(() => { flashEl.style.transition = 'opacity .35s'; flashEl.style.opacity = 0; });
}

// ---- sensing server link (same protocol as sensing/dashboard) ----
const host = params.get('host') ?? `${location.hostname}:8000`;
let linkState = 'connecting', dummy = null;
function connect() {
  const ws = new WebSocket(`ws://${host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', role: 'dashboard', id: 'kawashima-fx' })); linkState = 'connected'; };
  ws.onclose = () => { linkState = 'disconnected, retrying'; for (const p of Object.values(players)) p.online = false; setTimeout(connect, 1000); };
  ws.onmessage = m => {
    if (typeof m.data !== 'string') return onPhoneJpeg(m.data); // chest-camera JPEGs, first byte = slot
    const k = JSON.parse(m.data);
    if (k.type === 'phones') { for (const p of Object.values(players)) p.online = k.list.some(q => q.slot === p.slot); return; }
    const p = players[k.slot]; if (!p) return;
    loc.onMessage(k); smap.ingest(k);
    if (k.type === 'tags') fitIntrinsics(k);
    if (k.type === 'imu') {
      p.imu = k;
      const dps = Math.hypot(...k.gyro);
      if (dps > cfg.swingDps) shoot(p, Math.min(.9, dps / (2 * cfg.swingDps)));
    } else if (k.type === 'truth') { p.truth = k; dummy?.setTruth(k.slot, k); }
    else if (k.type === 'calib') p.imu = null;
  };
}

// ---- third-person camera: iPhone via Continuity Camera, or ?dummy for the rendered test room ----
const status = { extra: '' };
async function startVideo(deviceId) {
  try {
    video.srcObject?.getTracks().forEach(t => t.stop());
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 1920, height: 1080 } });
    try { localStorage.setItem('fx-cam', deviceId ?? ''); } catch {}
  } catch (e) { status.extra = e.name === 'OverconstrainedError' ? 'カメラ: 前回の iPhone が見えない。ケーブルを挿し直すと自動でつながる' : 'camera: ' + e.message; }
  fillDevices();
}
// the iPhone (Continuity Camera) drops out now and then: when the remembered camera comes back, switch to it by itself
navigator.mediaDevices.addEventListener?.('devicechange', async () => {
  const want = localStorage.getItem('fx-cam'), cur = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  if (!want || want === cur || params.has('dummy')) return;
  if ((await navigator.mediaDevices.enumerateDevices()).some(d => d.deviceId === want)) startVideo(want);
});
async function startDummy() {
  const { createDummyCam } = await import('./dummycam.js');
  dummy = createDummyCam({ width: 1920, height: 1080 }); // same size as the iPhone picture, so small far sheets behave alike
  video.srcObject = dummy.stream;
  setTimeout(calibrate, 1500); // the dummy room never moves: calibrate once it has rendered
}
video.onloadedmetadata = () => { video.play(); videoAspect = video.videoWidth / video.videoHeight; resize(); };

// Floor sheets: their spacing is measured, not assumed. Each sheet alone gives a camera pose; for a trial focal length the
// two poses say how far apart the sheets are. Keep the focal length where the two-sheet fit is best (flat, same way up),
// then refine the focal with both sheets.
function fitFloor(tags, width, height) {
  if (W.FLOOR_IDS.length !== 2 || !W.FLOOR_IDS.every(id => tags.some(t => t.id === id))) return null;
  const keep = W.TAGS[W.FLOOR_IDS[0]].pos[0] * 2 * Math.sign(W.TAGS[W.FLOOR_IDS[0]].pos[0]);
  let best = null;
  for (let fov = 12; fov <= 90; fov += 1) {
    const c = W.FLOOR_IDS.map(id => { const r = solveCamera(tags.filter(t => t.id === id), width, height, { fovYGuess: fov, fitFocal: false }); return r && W.compose(W.invert(r.pose), W.worldTagPose(id)); });
    if (!c[0] || !c[1]) continue;
    const gap = Math.hypot(...c[0].t.map((v, i) => v - c[1].t[i]));
    W.setFloorSep(gap);
    const r = solveCamera(tags, width, height, { fovYGuess: fov, fitFocal: false });
    if (r && (!best || r.reprojErrPx < best.err)) best = { fov, gap, err: r.reprojErrPx };
  }
  if (!best || best.gap < .3 || best.gap > 8) { W.setFloorSep(keep); return null; }
  W.setFloorSep(best.gap);
  const r = solveCamera(tags, width, height, { fovYGuess: best.fov, fitFocal: true });
  return r && { ...r, floorSep: best.gap };
}
function relayout() { // tag positions / the field outline changed: redraw everything built from them
  buildTags3d(); buildGuide(); // field3d.js notices the change itself (it compares a signature every frame)
}
W.onFieldChange(() => relayout());

// map4: four sheets anywhere on the floor -> the field is whatever they outline (fieldmap.js measures it)
const fieldKey = 'fx-field-' + W.LAYOUT + STORE;
let fieldScanned = false, scannedIds = null; // ids the last scan measured (an unseen sheet keeps a placeholder spot)
function applyField(f) { fieldScanned = true; if (f.tags && Object.keys(f.tags).length) scannedIds = Object.keys(f.tags).map(Number); W.setField(f); }
try { const f = JSON.parse(localStorage.getItem(fieldKey)); if (f?.poly) queueMicrotask(() => applyField(f)); } catch {}
const saveField = () => { try { localStorage.setItem(fieldKey, JSON.stringify({ poly: W.FIELD.poly, tags: Object.fromEntries((scannedIds ?? W.CORNER_IDS).map(id => [id, { pos: W.TAGS[id].pos, yaw: W.TAGS[id].yaw ?? 0 }])) })); } catch {} };
async function scanMap() {
  status.extra = '4枚のタグをスキャン中…';
  let FM; try { FM = await import('./fieldmap.js'); } catch (e) { status.extra = 'スキャン失敗：fieldmap.js を読み込めない ' + e.message; return; }
  const need = modeIds();
  const m = await FM.scanField(dummy?.canvas ?? video, { fovYGuess: cfg.tagCam?.fovY ?? cfg.cam.fov, mode: cfg.tagMode });
  if (!m) { status.extra = `スキャン失敗：床のタグ（ID ${need.join('・')}）が${cfg.tagMode === 2 ? '2枚' : '3枚以上'}見えていない。カメラを高くするか、遠いタグを近づける`; return; }
  applyField({ poly: m.poly, tags: m.tags }); saveField();
  cfg.tagCam = m.cam; cfg.camMode = 'tags'; save(); applyCam();
  const xs = m.poly.map(q => q[0]), zs = m.poly.map(q => q[1]), size = `${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}m × ${(Math.max(...zs) - Math.min(...zs)).toFixed(1)}m`;
  const good = need.every(id => m.ids.includes(id)) && m.reprojErrPx < 4;
  if (good) match.ready = true;
  status.extra = good ? `スキャン完了：タグ ${m.ids.join(',')}  フィールド 約${size}  誤差 ${m.reprojErrPx.toFixed(1)}px  縦画角 ${m.fovY.toFixed(1)}°。試合を始められる`
    : `スキャン不十分：${!need.every(id => m.ids.includes(id)) ? `タグが${m.ids.length}枚しか見えていない` : `誤差 ${m.reprojErrPx.toFixed(1)}px が大きい`}${m.warnings?.length ? '（' + m.warnings.join('、') + '）' : ''}。置き方を直してもう一度`;
}
const modeIds = () => W.LAYOUT === 'map4' && cfg.tagMode === 2 ? [0, 1] : W.CORNER_IDS;
async function calibrate() {
  if (W.LAYOUT === 'map4') return scanMap();
  status.extra = 'タグでカメラ合わせ中…';
  let r = await calibrateCamera(dummy?.canvas ?? video, { fovYGuess: cfg.cam.fov });
  if (!r) { status.extra = 'スキャン失敗：固定タグが見つからない'; return; }
  const fl = fitFloor(r.tags, r.width, r.height);
  if (fl) { r = { ...fl, tags: r.tags }; try { localStorage.setItem('fx-tagsep', fl.floorSep.toFixed(3)); } catch {} relayout(); }
  cfg.tagCam = r; cfg.camMode = 'tags'; save(); applyCam();
  const missing = W.CORNER_IDS.filter(id => !r.ids.includes(id)), good = !missing.length && r.reprojErrPx < 4;
  if (good) match.ready = true;
  const gap = r.floorSep ? `  タグの間隔 ${r.floorSep.toFixed(2)}m（実測）` : '';
  status.extra = good ? `スキャン完了：タグ ${r.ids.join(',')}  誤差 ${r.reprojErrPx.toFixed(1)}px  縦画角 ${r.fovY.toFixed(1)}°${gap}。試合を始められる`
    : `スキャン不十分：${missing.length ? `ID ${missing.join(',')} が見えていない` : `誤差 ${r.reprojErrPx.toFixed(1)}px が大きい`}。置き方を直してもう一度`;
}

// ---- positions from the third-person picture (posetrack.js), only loaded when that source is chosen ----
let tracker = null, trackerLoading = false;
async function syncTracker() {
  if (cfg.posSrc !== 'camera') { tracker?.stop(); tracker = null; return; }
  if (tracker || trackerLoading) return;
  trackerLoading = true;
  try {
    const P = await import('./posetrack.js');
    tracker = P.createPoseTracker({ video, // the dummy room also plays into this <video>
      getCamera: () => cfg.camMode === 'tags' ? cfg.tagCam : null });
    await tracker.start();
  } catch (e) { status.extra = '骨格推定を読み込めない: ' + e.message; tracker = null; } finally { trackerLoading = false; }
}

// ---- tracked skeletons in 3D: MediaPipe's 33 joints placed in the world by posetrack.js ----
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], [0, 11], [0, 12]];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
const skels = Object.fromEntries(['A', 'B'].map(slot => {
  const color = slot === 'A' ? 0xffa060 : 0x8fd8ff, pos = new Float32Array(99);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(BONES.flat());
  const jg = new THREE.BufferGeometry(); jg.setAttribute('position', g.getAttribute('position')); jg.setIndex(JOINTS);
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false }));
  const dots = new THREE.Points(jg, new THREE.PointsMaterial({ color, size: .07, transparent: true, depthTest: false }));
  lines.renderOrder = dots.renderOrder = 15; lines.frustumCulled = dots.frustumCulled = false;
  const grp = new THREE.Group(); grp.add(lines, dots); grp.visible = false; scene.add(grp);
  return [slot, { grp, pos, attr: g.getAttribute('position') }];
}));
function updateSkels() {
  for (const slot of ['A', 'B']) {
    const k = skels[slot], s = cfg.posSrc === 'camera' ? tracker?.get(slot) : null;
    k.has = !!(s?.seen && s.skel);
    if (!k.has) continue;
    k.pos.set(s.skel); k.attr.needsUpdate = true;
  }
}
// phone-side bodies: map.js puts what each chest camera sees of the opponent into its room frame (centre of the floor
// tags). Our world sits on the same floor tags (fieldmap.js), so a yaw + shift fitted on the shared tag ids maps one to the other.
const smap = createMap();
const phoneSk = Object.fromEntries(['A', 'B'].map(slot => {
  const pos = new Float32Array(BONES.length * 6), g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: slot === 'A' ? 0xffd2a8 : 0xd2f0ff, transparent: true, opacity: .75, depthTest: false }));
  lines.renderOrder = 14; lines.frustumCulled = false; lines.visible = false; scene.add(lines);
  return [slot, { lines, pos, attr: g.getAttribute('position'), has: false }];
}));
let phoneEst = null, phoneEstAt = 0, roomToWorld = null;
function fitRoom(corners) { // 2D Procrustes (yaw + shift) from map.js room coords onto our measured floor tags
  const pairs = corners.filter(c => W.TAGS[c.id]?.floor && fieldScanned).map(c => [c.p, W.TAGS[c.id].pos]);
  if (pairs.length < 2) return null;
  const m = i => pairs.reduce((a, q) => [a[0] + q[i][0] / pairs.length, a[1] + q[i][2] / pairs.length], [0, 0]), ma = m(0), mb = m(1);
  let sc = 0, ss = 0;
  for (const [a, b] of pairs) { const A = [a[0] - ma[0], a[2] - ma[1]], B = [b[0] - mb[0], b[2] - mb[1]]; sc += A[0] * B[0] + A[1] * B[1]; ss += A[0] * B[1] - A[1] * B[0]; }
  const th = Math.atan2(ss, sc), c = Math.cos(th), s = Math.sin(th);
  return p => [c * (p[0] - ma[0]) - s * (p[2] - ma[1]) + mb[0], p[1], s * (p[0] - ma[0]) + c * (p[2] - ma[1]) + mb[1]];
}
function updatePhoneSkels() {
  if (cfg.skelSrc === 'camera') { for (const k of Object.values(phoneSk)) k.has = false; return; }
  if (now() - phoneEstAt > .1) {
    phoneEstAt = now();
    try { phoneEst = smap.estimate({ now: Date.now() / 1000 }); roomToWorld = fitRoom(phoneEst.corners ?? []); } catch { phoneEst = null; }
  }
  for (const slot of ['A', 'B']) {
    const k = phoneSk[slot], b = roomToWorld && phoneEst?.bodies?.[slot];
    k.has = !!b; if (!b) continue;
    BONES.forEach(([i, j], n) => { // a bone with a hidden end collapses to a point
      const p = b[i] && b[j] ? [roomToWorld(b[i]), roomToWorld(b[j])] : [[0, -50, 0], [0, -50, 0]];
      k.pos.set(p[0], n * 6); k.pos.set(p[1], n * 6 + 3);
    });
    k.attr.needsUpdate = true;
  }
}
const showSkels = on => {
  for (const k of Object.values(skels)) k.grp.visible = on && k.has && cfg.skelSrc !== 'phones';
  for (const k of Object.values(phoneSk)) k.lines.visible = on && k.has;
};

// ---- phone view (F): a chest phone's own picture as the background, the camera at that phone's located pose ----
const phoneCanvas = document.createElement('canvas'), phoneCtx = phoneCanvas.getContext('2d');
const phoneTex = new THREE.CanvasTexture(phoneCanvas);
phoneTex.colorSpace = THREE.SRGBColorSpace;
let decoding = false;
async function onPhoneJpeg(buf) {
  if (decoding || String.fromCharCode(new Uint8Array(buf, 0, 1)[0]) !== cfg.fpv) return; // busy: drop the frame
  decoding = true;
  try {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(buf, 1)], { type: 'image/jpeg' }));
    const sized = phoneCanvas.width !== bmp.width || phoneCanvas.height !== bmp.height;
    if (sized) { phoneCanvas.width = bmp.width; phoneCanvas.height = bmp.height; phoneTex.dispose(); }
    phoneCtx.drawImage(bmp, 0, 0); bmp.close();
    phoneTex.needsUpdate = true;
    if (sized) resize();
  } catch {} finally { decoding = false; }
}

// The phones don't send their intrinsics, but every tag gives 4 image corners and their 3D points in the same camera
// frame: fit u = a·X/Z + b, v = c·Y/Z + d (normalised image coords) and take the vertical fov from c.
const intr = { A: null, B: null };
function fitIntrinsics(k) {
  const h = W.PHONE_TAG_SIZE / 2, ys = [], vs = [];
  for (const g of k.tags) {
    if (!g.p || !g.r || g.c?.length !== 4) continue;
    const R = W.fromRodrigues(g.r);
    [[-h, h], [h, h], [h, -h], [-h, -h]].forEach(([x, y], i) => {
      const X = W.apply(W.pose(R, g.p), [x, y, 0]);
      if (X[2] > .05) { ys.push(X[1] / X[2]); vs.push(g.c[i][1]); }
    });
  }
  if (ys.length < 4) return;
  const n = ys.length, my = ys.reduce((a, b) => a + b) / n, mv = vs.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (ys[i] - my) * (vs[i] - mv); sxx += (ys[i] - my) ** 2; }
  if (sxx < 1e-4) return; // corners too close together to fit
  const fov = 2 * Math.atan(.5 / (sxy / sxx)) * 180 / Math.PI;
  if (fov > 20 && fov < 120) intr[k.slot] = intr[k.slot] ? .9 * intr[k.slot] + .1 * fov : fov;
}

function placePhoneCamera(slot) {
  const L = loc.get(slot); if (!L.world_T_arcam) return;
  const P = W.compose(L.world_T_arcam, W.arcam_T_cv), R = P.R;
  // OpenCV camera (x right, y down, z forward) -> Three.js camera (x right, y up, looks down -z)
  new THREE.Matrix4().set(R[0], -R[1], -R[2], P.t[0], R[3], -R[4], -R[5], P.t[1], R[6], -R[7], -R[8], P.t[2], 0, 0, 0, 1)
    .decompose(camera.position, camera.quaternion, camera.scale);
  camera.fov = intr[slot] ?? 60; camera.aspect = aspect; camera.updateProjectionMatrix();
}
function tagAnchors() {
  for (const id of W.CORNER_IDS) {
    const t = W.worldTagPose(id).t, s = W.TAGS[id].size / 2;
    fx.aura('fire', V(t[0], t[1] - s, t[2]), V(t[0], t[1] + s, t[2]), .4, 'tag' + id);
  }
}

// ---- setup guide: where the tags, the start marks and the arena go, drawn over the video while the phase is 'setup' ----
// Before calibration the camera is GUIDE_CAM (the recommended iPhone spot): turn the iPhone until the real tags sit in
// the frames. After K the camera is the calibrated one, so frames and real tags overlap when everything is right.
const guide = new THREE.Group(); scene.add(guide);
const onTop = m => { m.depthTest = false; m.transparent = true; return m; };
function label(text, color, h = .16) {
  const c = document.createElement('canvas'), g = c.getContext('2d'), font = 'bold 44px system-ui, sans-serif';
  g.font = font; const lines = text.split('\n'), w = Math.max(...lines.map(l => g.measureText(l).width)) + 36;
  c.width = w; c.height = 58 * lines.length + 14;
  g.fillStyle = 'rgba(0,0,0,.72)'; g.beginPath(); g.roundRect(0, 0, c.width, c.height, 14); g.fill();
  g.font = font; g.fillStyle = color; g.textBaseline = 'top';
  lines.forEach((l, i) => g.fillText(l, 18, 12 + 58 * i));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(onTop(new THREE.SpriteMaterial({ map: tex })));
  s.scale.set(h * lines.length * c.width / c.height, h * lines.length, 1); s.renderOrder = 20;
  return s;
}
function strip(a, b, color, w = .05) { // flat band on the floor from a to b
  const d = b.clone().sub(a), m = new THREE.Mesh(new THREE.PlaneGeometry(d.length(), w), onTop(new THREE.MeshBasicMaterial({ color, opacity: .85 })));
  m.rotation.set(-Math.PI / 2, 0, -Math.atan2(d.z, d.x)); m.position.copy(a).add(b).multiplyScalar(.5).setY(.005); m.renderOrder = 10;
  return m;
}
function buildGuide() {
  guide.clear();
  const unknown = W.LAYOUT === 'map4' && !fieldScanned; // sheets not scanned yet: nothing to draw where they are
  if (unknown) return;
  const c = W.FIELD.poly.map(([x, z]) => V(x, 0, z));
  c.forEach((p, i) => guide.add(strip(p, c[(i + 1) % c.length], 0xffffff)));
  guide.add(strip(V(-.3, 0, 0), V(.3, 0, 0), 0xffffff, .03), strip(V(0, 0, -.3), V(0, 0, .3), 0xffffff, .03));
  for (const [slot, color, css] of [['A', 0xff7a1a, '#ffb070'], ['B', 0x6cc8ff, '#a8dcff']]) {
    const st = W.START[slot], ring = new THREE.Mesh(new THREE.RingGeometry(.26, .32, 48), onTop(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, opacity: .9 })));
    ring.rotation.x = -Math.PI / 2; ring.position.set(st.pos[0], .006, st.pos[2]); ring.renderOrder = 10;
    const tip = v3(W.apply(W.bodyPose(st.pos, st.yaw, .006), [.55, 0, 0])); // which way they face
    const lb = label(`${slot} の立ち位置`, css, .13); lb.position.set(st.pos[0], .25, st.pos[2]);
    guide.add(ring, strip(v3(st.pos), tip, color, .04), lb);
  }
  for (const id of W.CORNER_IDS) {
    if (scannedIds && !scannedIds.includes(id)) continue;
    const p = W.worldTagPose(id), s = W.TAGS[id].size, h = s / 2, M = toMat(p);
    const sq = [[-h, h], [h, h], [h, -h], [-h, -h], [-h, h]].map(([x, y]) => V(x, y, 0).applyMatrix4(M));
    const frame = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sq), onTop(new THREE.LineBasicMaterial({ color: 0x3ddc84 })));
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(s, s), onTop(new THREE.MeshBasicMaterial({ color: 0x3ddc84, opacity: .25, side: THREE.DoubleSide })));
    fill.matrixAutoUpdate = false; fill.matrix.copy(M);
    frame.renderOrder = fill.renderOrder = 11;
    guide.add(frame, fill);
    if (W.TAGS[id].floor) { // lying on the floor: the frame is the spot, the label floats above it
      const lb = label(W.LAYOUT === 'map4' ? `ID ${id}` : `ID ${id} をここの床に\n文字の行を手前（カメラ側）に`, '#9ff0c0', .085);
      lb.position.set(p.t[0], .35, p.t[2]); guide.add(lb);
      continue;
    }
    const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(p.t[0], 0, p.t[2]), V(p.t[0], p.t[1] - h, p.t[2])]), onTop(new THREE.LineDashedMaterial({ color: 0x3ddc84, dashSize: .08, gapSize: .06 })));
    pole.computeLineDistances();
    const side = p.t[0] < 0 ? '左' : '右', face = p.t[0] < 0 ? '右' : '左';
    const lb = label(`ID ${id} をここに\n${side}端・中心の高さ ${p.t[1]}m・${face}向き`, '#9ff0c0', .085);
    lb.position.set(p.t[0] * .72, p.t[1] - h - .2, p.t[2]);
    const foot = strip(V(p.t[0] - .15, 0, p.t[2]), V(p.t[0] + .15, 0, p.t[2]), 0x3ddc84, .3);
    pole.renderOrder = 11;
    guide.add(pole, foot, lb);
  }
}
buildGuide();
// live check of the tags while setting up: which ids the iPhone sees, and on which side of the picture
const seenTags = { list: [], at: 0, busy: false, ms: 0 };
const PLAYER_IDS = Object.values(W.PLAYER_TAG);
async function checkTags() {
  const setup = match.phase === 'setup', chest = cfg.posSrc === 'camera' && tracker;
  if (seenTags.busy || (!setup && !chest) || dummy || !video.videoWidth) return;
  seenTags.busy = true; const t0 = performance.now();
  try {
    const d = await detectTags(video, setup ? null : PLAYER_IDS, { passes: [[1, 2], [1, 6]] }); // off the main thread (tagworker.js)
    seenTags.list = d.map(o => ({ id: o.id, corners: o.corners, w: d.width, h: d.height })); seenTags.at = now();
    // chest tags 10 (A) / 11 (B) in the third-person picture tell the pose tracker who is who
    tracker?.setHints?.(seenTags.list.filter(o => PLAYER_IDS.includes(o.id)).map(o => ({
      slot: o.id === W.PLAYER_TAG.A ? 'A' : 'B', u: o.corners.reduce((a, c) => a + c[0] / 4, 0), v: o.corners.reduce((a, c) => a + c[1] / 4, 0), t: now() })));
  } catch {} finally { seenTags.busy = false; seenTags.ms = performance.now() - t0; }
}
setInterval(checkTags, 600); // detection runs in tagworker.js now: only createImageBitmap here
const guideCanvas = Object.assign(document.createElement('canvas'), { id: 'guide2d' }), guideCtx = guideCanvas.getContext('2d');
stage.append(guideCanvas);
const guideEl = document.getElementById('guide');
function tagChecks() {
  return modeIds().map(id => {
    const want = W.LAYOUT === 'map4' ? null /* the scan names the left sheet A, whatever its id */ : W.TAGS[id].pos[0] < 0 ? 'left' : 'right', d = seenTags.list.find(o => o.id === id); // map4: anywhere
    const u = d && d.corners.reduce((a, c) => a + c[0], 0) / 4 / d.w;
    return { id, want, seen: !!d, side: d ? (u < .5 ? 'left' : 'right') : null, px: d ? Math.hypot(d.corners[0][0] - d.corners[1][0], d.corners[0][1] - d.corners[1][1]) : 0 };
  });
}
let guideDrawn = true;
function drawGuide2d(show) {
  const w = Math.round(W_px * devicePixelRatio), h = Math.round(H_px * devicePixelRatio);
  if (guideCanvas.width !== w || guideCanvas.height !== h) { guideCanvas.width = w; guideCanvas.height = h; }
  const draw = show && now() - seenTags.at <= 3;
  if (draw || guideDrawn) guideCtx.clearRect(0, 0, w, h); // a 5 MP clear every frame for nothing otherwise
  guideDrawn = draw;
  guideCanvas.style.display = show ? '' : 'none';
  guideEl.style.display = 'none'; // no text panel on the players' screen: the tag check lives on admin.html
  if (!draw) return;
  for (const d of seenTags.list) { // what the detector found right now, on the live picture
    const k = w / d.w, ok = W.TAGS[d.id]?.pos;
    guideCtx.strokeStyle = ok ? '#3ddc84' : '#ffcc4d'; guideCtx.lineWidth = 4 * devicePixelRatio;
    guideCtx.beginPath(); d.corners.forEach(([x, y], i) => guideCtx[i ? 'lineTo' : 'moveTo'](x * k, y * k)); guideCtx.closePath(); guideCtx.stroke();
    const [x, y] = d.corners.reduce(([a, b], c) => [a + c[0] / 4, b + c[1] / 4], [0, 0]);
    guideCtx.font = `bold ${16 * devicePixelRatio}px system-ui`; guideCtx.fillStyle = guideCtx.strokeStyle; guideCtx.textAlign = 'center';
    guideCtx.fillText(`ID ${d.id} 検出`, x * k, Math.min(...d.corners.map(c => c[1])) * k - 8 * devicePixelRatio);
  }
}
let guideTextAt = 0;
function updateGuideText() {
  if (now() - guideTextAt < .4) return; guideTextAt = now();
  const tc = cfg.camMode === 'tags' && cfg.tagCam, checks = tagChecks();
  const row = c => {
    const where = W.LAYOUT !== 'map4' ? tagPlace(c.id) : cfg.tagMode === 2 ? '好きな場所の床。左に置いた方が A の端になる' : '好きな場所の床（4枚でだいたい四角形の角になるように）';
    const st = !c.seen ? '<b class="ng">見えていない</b>' : c.want && c.side !== c.want ? `<b class="warn">画面の${SIDE[c.side]}に見えている：左右が逆かも</b>` : c.px < 14 ? '<b class="warn">小さすぎる：iPhoneを近づける</b>' : '<b class="ok">OK</b>';
    return `<li>ID ${c.id}：${where}　${st}</li>`;
  };
  const camLine = tc ? `合わせ済み：iPhone は中心から手前 ${tc.pose.t[2].toFixed(2)}m、横 ${tc.pose.t[0].toFixed(2)}m、高さ ${tc.pose.t[1].toFixed(2)}m にあると計算（目安は ${GUIDE_CAM.z}m・0m・${GUIDE_CAM.y}m）`
    : W.LAYOUT === 'map4' ? `タグは測らなくてよい。${cfg.tagMode}枚の位置と向き、カメラの画角はスキャンで測る` : '緑の枠に実物のタグが重なるように、iPhone の位置と向きを動かす';
  guideEl.innerHTML = `<h4>設置ガイド（準備中）</h4><ol>${checks.map(row).join('')}
    <li>iPhone：${W.LAYOUT === 'map4' ? `${cfg.tagMode}枚とフィールド全体が映る位置` : `中心から手前へ ${GUIDE_CAM.z}m`}、高さ ${GUIDE_CAM.y}m 以上（高いほど床のタグが見やすい）・横向きで少し見下ろす</li></ol>
    <p>${camLine}</p>${match.ready ? '<p><b class="ok">スキャン完了：試合を始められます</b></p>' : '<p class="dim">全部 OK になったら、人がいない状態で「タグでカメラ合わせ」(K) でスキャンする。スキャンが済むと試合を始められる</p>'}`;
}

// ---- settings panel (C) ----
const panel = document.getElementById('panel');
function slider(label, get, set, min, max, step) {
  const l = document.createElement('label');
  l.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
  const [inp, out] = [l.querySelector('input'), l.querySelector('output')];
  inp.value = get(); out.textContent = get();
  inp.oninput = () => { set(+inp.value); out.textContent = inp.value; applyCam(); save(); };
  return l;
}
function select(label, key, options) {
  const l = document.createElement('label');
  l.innerHTML = `<span>${label}</span><select>${options.map(o => `<option>${o}</option>`).join('')}</select><span></span>`;
  const s = l.querySelector('select'); s.value = cfg[key];
  s.onchange = () => { cfg[key] = s.value; save(); applyCam(); };
  return l;
}
const h3 = t => Object.assign(document.createElement('h3'), { textContent: t });
const camSel = Object.assign(document.createElement('select'), { onchange: e => startVideo(e.target.value) });
async function fillDevices() {
  const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const cur = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  devices = list.map(d => ({ id: d.deviceId, label: d.label || 'camera' }));
  camSel.innerHTML = list.map(d => `<option value="${d.deviceId}" ${d.deviceId === cur ? 'selected' : ''}>${d.label || 'camera'}</option>`).join('');
}
function buildPanel() {
  const c = cfg.cam, manual = set => v => { set(v); cfg.camMode = 'manual'; };
  panel.append(h3('3人称カメラ'), camSel,
    Object.assign(document.createElement('button'), { textContent: '角のタグでカメラ合わせ (K)', onclick: calibrate }),
    select('合わせ方', 'camMode', ['tags', 'manual']),
    h3('手動合わせ（スライダーを触ると manual になる）'),
    slider('x', () => c.x, manual(v => c.x = v), -5, 5, .01), slider('y', () => c.y, manual(v => c.y = v), 0, 4, .01), slider('z', () => c.z, manual(v => c.z = v), -2, 10, .01),
    slider('yaw', () => c.yaw, manual(v => c.yaw = v), -90, 90, .1), slider('pitch', () => c.pitch, manual(v => c.pitch = v), -60, 30, .1), slider('roll', () => c.roll, manual(v => c.roll = v), -20, 20, .1),
    slider('fov(縦)', () => c.fov, manual(v => c.fov = v), 20, 100, .1),
    h3('ゲーム'),
    slider('振り判定 deg/s', () => cfg.swingDps, v => cfg.swingDps = v, 100, 1500, 10),
    select('狙い', 'aim', ['stick', 'eye']),
    Object.assign(document.createElement('div'), { className: 'keys', innerHTML:
      '1 準備中 / 2 デモ / 3 試合開始 / 4 一時停止 / R やり直し（管理画面は admin.html）<br>C パネル / G デバッグ表示 / V 3Dビュー切替 / D ドローン視点の切替 / M ミニマップ / K タグでカメラ合わせ / T 正解位置(ダミー)<br>F スマホ視点(A→B→切) / H タグ位置の目印<br>Space A発射 / Enter B発射 / Q・P 長押しで溜め(A・B)' }));
}

// ---- commands: the same set from the keys here and from admin.html (BroadcastChannel, same browser) ----
const VIEWS = ['pip', 'full3d', 'off'], TOGGLES = ['debug', 'minimap', 'useTruth', 'anchors', 'skeleton'];
function command(c) {
  const p = players[c.slot];
  switch (c.cmd) {
    case 'phase': return setPhase(c.phase);
    case 'pause': if (match.phase === 'fight' || match.phase === 'demo') match.paused = !match.paused; return;
    case 'reset': return setPhase(match.phase === 'result' || match.phase === 'countdown' ? 'fight' : match.phase); // again from the top
    case 'matchSec': match.sec = Math.max(10, +c.value || 90); if (match.phase !== 'fight') match.left = match.sec; return;
    case 'calibrate': return calibrate();
    case 'camera': return startVideo(c.value);
    case 'camMode': cfg.camMode = c.value; break;
    case 'tagMode': cfg.tagMode = +c.value === 2 ? 2 : 4; match.ready = false; save(); return;
    case 'skelSrc': cfg.skelSrc = ['camera', 'phones', 'both'].includes(c.value) ? c.value : 'both'; break;
    case 'posSrc': cfg.posSrc = c.value; save(); return syncTracker();
    case 'hand': cfg.hand = c.value === 'L' ? 'L' : 'R'; break;
    case 'swap': tracker?.setSwap?.(); return;
    case 'forceReady': match.ready = true; status.extra = 'スキャンを省いて開始可能にした（前回の合わせ結果を使う）'; return;
    case 'guideCam': cfg.cam = { ...GUIDE_CAM, fov: cfg.tagCam?.fovY ?? GUIDE_CAM.fov }; cfg.camMode = 'manual'; break; // show the guide from the recommended iPhone spot
    case 'view': cfg.view = VIEWS.includes(c.value) ? c.value : VIEWS[(VIEWS.indexOf(cfg.view) + 1) % 3]; break;
    case 'drone': if (c.value) drone.setMode(c.value); else drone.next(); cfg.drone = drone.mode; break;
    case 'toggle': if (TOGGLES.includes(c.key)) cfg[c.key] = !cfg[c.key]; break;
    case 'fpv': cfg.fpv = 'value' in c ? c.value : { null: 'A', A: 'B', B: null }[cfg.fpv]; save(); return resize();
    case 'set': if (c.key === 'swingDps') cfg.swingDps = +c.value; else if (c.key === 'aim') cfg.aim = c.value; break;
    case 'shoot': if (p) shoot(p, c.power ?? .5); return;
    case 'charge': if (!p) return;
      if (c.on) { if (!canAct()) return; p.charging = true; p.charge = 0; }
      else if (p.charging) { p.charging = false; p.lastShot = 0; shoot(p, p.charge); p.charge = 0; }
      return;
    case 'panel': return panel.classList.toggle('open');
    case 'volume': return sfx?.setVolume(c.bus, Math.max(0, Math.min(1, +c.value)));
    case 'mute': return sfx?.setMuted(!sfx.muted);
    case 'sound': { // admin test buttons
      const T = { shotFire: () => sfx.shot('fire', 0, .6), shotThunder: () => sfx.shot('thunder', 0, .6), hitFire: () => sfx.hit('fire', 0, .7), hitThunder: () => sfx.hit('thunder', 0, .7),
        specialFire: () => sfx.special('fire', 0), specialThunder: () => sfx.special('thunder', 0), charge: () => { sfx.charge('A', true, 0, 0); setTimeout(() => sfx.charge('A', false), 1500); },
        bgm: () => { sfx.bgm(true); setTimeout(() => match.phase !== 'demo' && match.phase !== 'fight' && sfx.bgm(false), 4000); } };
      return sfx && T[c.name]?.();
    }
    default: return;
  }
  save(); applyCam();
}
const KEYS = { 1: { cmd: 'phase', phase: 'setup' }, 2: { cmd: 'phase', phase: 'demo' }, 3: { cmd: 'phase', phase: 'fight' }, 4: { cmd: 'pause' },
  c: { cmd: 'panel' }, g: { cmd: 'toggle', key: 'debug' }, d: { cmd: 'drone' }, m: { cmd: 'toggle', key: 'minimap' }, v: { cmd: 'view' },
  k: { cmd: 'calibrate' }, t: { cmd: 'toggle', key: 'useTruth' }, f: { cmd: 'fpv' }, h: { cmd: 'toggle', key: 'anchors' },
  ' ': { cmd: 'shoot', slot: 'A' }, Enter: { cmd: 'shoot', slot: 'B' }, r: { cmd: 'reset' } };
const held = { q: 'A', p: 'B' };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.repeat) return;
  if (e.key === ' ') e.preventDefault();
  if (held[e.key]) command({ cmd: 'charge', slot: held[e.key], on: true });
  else if (KEYS[e.key]) command(KEYS[e.key]);
});
addEventListener('keyup', e => { if (held[e.key]) command({ cmd: 'charge', slot: held[e.key], on: false }); });

const bus = new BroadcastChannel('bou-battle');
const DISPLAY_ID = Math.random().toString(36).slice(2, 8); // admin.html follows one display when several are open
bus.onmessage = e => command(e.data);
let devices = [];
navigator.mediaDevices.addEventListener?.('devicechange', fillDevices);
function publish() { // state for admin.html, a few times a second
  const L = s => { const l = loc.get(s); return { anchored: l.anchored, fixes: l.fixes, err: l.err }; };
  const tc = cfg.tagCam;
  bus.postMessage({ type: 'state', id: DISPLAY_ID, visible: !document.hidden, born: performance.timeOrigin, phase: match.phase, ready: match.ready, paused: match.paused, left: match.left, sec: match.sec, until: Math.max(0, match.until - now()),
    winner: winner?.slot ?? null,
    players: Object.fromEntries(Object.values(players).map(p => [p.slot, { hp: p.hp, online: p.online, imu: !!p.imu, fake: !!p.truth, charge: p.charge, charging: p.charging, loc: L(p.slot) }])),
    link: linkState, host, camMode: cfg.camMode, tagCam: tc && { ids: tc.ids, err: tc.reprojErrPx, fov: tc.fovY, t: tc.pose.t }, camMsg: status.extra,
    video: { w: video.videoWidth, h: video.videoHeight, label: video.srcObject?.getVideoTracks()[0]?.label ?? '', id: video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId }, devices,
    view: cfg.view, drone: drone.mode, shot: drone.shot, fpv: cfg.fpv, fovPhone: intr,
    audio: sfx && { unlocked: sfx.unlocked, loaded: sfx.loaded, muted: sfx.muted, vol: sfx.volumes },
    posSrc: cfg.posSrc, hand: cfg.hand, skelSrc: cfg.skelSrc, phoneBodies: { A: phoneSk.A.has, B: phoneSk.B.has, aligned: !!roomToWorld, warn: phoneEst?.warn?.slice(0, 2) ?? [] }, tagMode: cfg.tagMode, layout: W.LAYOUT, pose: tracker ? { ms: tracker.ms, hz: tracker.hz, ready: tracker.ready, A: !!tracker.get('A')?.seen, B: !!tracker.get('B')?.seen } : null,
    field: { scanned: fieldScanned, poly: W.FIELD.poly }, setupTags: tagChecks(), tagCheckMs: Math.round(seenTags.ms), toggles: Object.fromEntries(TOGGLES.map(k => [k, cfg[k]])), swingDps: cfg.swingDps, aim: cfg.aim, layout: W.LAYOUT, fps: Math.round(fps) });
}
setInterval(publish, 250);
// a small picture of this screen for the admin page (drawn right after a render, so the WebGL buffer is still there)

// ---- main loop ----
const banner = document.getElementById('banner'), statusEl = document.getElementById('status'), pipLabel = document.getElementById('pipLabel');
function locText(slot) {
  const L = loc.get(slot);
  return `${slot}: ${L.anchored ? `タグ固定 ${L.fixes}回 ずれ${(L.err * 100).toFixed(0)}cm` : '未固定(開始位置)'}`;
}
const timerEl = document.getElementById('timer'), phaseEl = document.getElementById('phase');
const PHASE_LABEL = { setup: '準備中', demo: 'デモ', countdown: '', fight: '', result: '' };
function bannerText(t) {
  if (match.paused) return '一時停止';
  if (match.phase === 'countdown') return String(Math.ceil(match.until - t));
  if (match.phase === 'fight' && t - match.fightAt < .9) return 'FIGHT!';
  if (match.phase === 'result') return winner ? `${winner.slot} WIN!` : 'DRAW';
  return '';
}
let last = now(), fps = 60;
const FPS_CAP = +(params.get('fps') ?? 60); // 120 Hz laptop screens: half the work for no visible loss (?fps=0: uncapped)
function frame(ts = 0) {
  if (FPS_CAP && ts && ts - (frame.at ?? -1e9) < 1000 / FPS_CAP - 2) return requestAnimationFrame(frame);
  frame.at = ts;
  const t = now(), raw = t - last, dt = Math.min(.05, raw); last = t;
  fps = .95 * fps + .05 / Math.max(raw, 1e-3);
  stepMatch(raw);
  for (const p of Object.values(players)) {
    updatePlayer(p);
    p.hud.querySelector('.bar i').style.width = p.hp + '%';
    p.hud.querySelector('.off').textContent = p.online ? '' : 'offline';
  }
  if (cfg.fpv) { placePhoneCamera(cfg.fpv); if (cfg.anchors) tagAnchors(); }
  stepCharge(dt); stepShots(dt); fx.step(dt); updateSkels(); updatePhoneSkels();
  if (sfx) { // sound follows the state every frame (cheap: audio.js only touches parameters on change)
    for (const p of Object.values(players)) sfx.charge(p.slot, p.charging && canAct(), p.charge, panOf(p.tip));
    sfx.bgm(['demo', 'countdown', 'fight'].includes(match.phase) && !match.paused);
  }
  const yawOf = b => Math.atan2(-b.R[6], b.R[0]); // body x axis = forward
  drone.update(dt, Object.fromEntries(Object.values(players).map(p => [p.slot, { chest: p.chest, yaw: yawOf(p.body), tip: p.tip }])));
  field.update(dt, Object.fromEntries(Object.values(players).map(p => [p.slot,
    { body: p.body, base: p.base, tip: p.tip, hp: p.hp, element: p.element, charging: p.charging, charge: p.charge, online: p.online || !!p.imu, hideBody: (skels[p.slot].has && cfg.skelSrc !== 'phones') || phoneSk[p.slot].has }])));
  const mapOn = cfg.minimap && match.phase !== 'setup'; // the setup guide needs that corner
  minimapCanvas.style.display = mapOn ? '' : 'none';
  if (mapOn) minimap.draw(players, shots);
  const bt = bannerText(t);
  banner.style.display = bt ? 'grid' : 'none';
  banner.textContent = bt;
  const showTimer = match.phase === 'fight' || match.phase === 'result';
  timerEl.style.display = showTimer ? '' : 'none';
  if (showTimer) timerEl.textContent = `${Math.floor(Math.ceil(match.left) / 60)}:${String(Math.ceil(match.left) % 60).padStart(2, '0')}`;
  phaseEl.textContent = match.phase === 'setup' && match.ready ? '準備完了' : PHASE_LABEL[match.phase] ?? '';
  phaseEl.style.display = phaseEl.textContent ? '' : 'none';
  statusEl.style.display = cfg.debug ? '' : 'none'; // the operator reads all of this on admin.html
  const guiding = match.phase === 'setup' && !cfg.fpv && cfg.view !== 'full3d';
  dummy?.showPlayers(match.phase !== 'setup'); // the dummy room is scanned empty, like the real one
  drawGuide2d(guiding);
  statusEl.textContent = `${cfg.view !== 'off' ? `ドローン:${drone.mode}(${drone.shot})  ` : ''}server ${host}: ${linkState}  ${locText('A')}  ${locText('B')}  カメラ:${cfg.fpv ? `スマホ${cfg.fpv}視点 fov ${intr[cfg.fpv]?.toFixed(1) ?? '推定待ち'}°` : cfg.camMode}${cfg.useTruth ? '  [正解位置]' : ''}  ${status.extra}`;
  pipLabel.style.display = cfg.view === 'pip' && cfg.debug ? '' : 'none';
  const sx = (Math.random() - .5) * 24 * shake, sy = (Math.random() - .5) * 24 * shake;
  stage.style.transform = `translate(calc(-50% + ${sx}px), calc(-50% + ${sy}px))`;
  shake = shake < .01 ? 0 : shake * Math.exp(-8 * dt);

  renderer.setScissorTest(false);
  if (cfg.view === 'full3d') { // drone view with effects + bloom: fx renders through `camera`, so borrow it for a frame
    scene.background = field.background; field.group.visible = true; world3d.visible = cfg.debug; camHelper.visible = false; guide.visible = false; showSkels(true);
    overCam.aspect = aspect; overCam.updateProjectionMatrix();
    const keep = { p: camera.position.clone(), q: camera.quaternion.clone(), fov: camera.fov };
    camera.position.copy(overCam.position); camera.quaternion.copy(overCam.quaternion); camera.fov = overCam.fov; camera.updateProjectionMatrix();
    renderer.setViewport(0, 0, W_px, H_px); fx.render();
    camera.position.copy(keep.p); camera.quaternion.copy(keep.q); camera.fov = keep.fov; camera.updateProjectionMatrix();
  } else {
    scene.background = cfg.fpv ? phoneTex : videoTex; field.group.visible = false; world3d.visible = cfg.debug; camHelper.visible = false; guide.visible = guiding; showSkels(cfg.skeleton && !cfg.fpv);
    fx.render();
    guide.visible = false;
    if (cfg.view === 'pip') { // drone view in the bottom-right corner (no bloom)
      const w = W_px * .3, h = H_px * .3;
      scene.background = field.background; field.group.visible = true; world3d.visible = cfg.debug; camHelper.visible = cfg.debug;
      overCam.aspect = w / h; overCam.updateProjectionMatrix();
      renderer.setScissorTest(true); renderer.setScissor(W_px - w - 8, 8, w, h); renderer.setViewport(W_px - w - 8, 8, w, h);
      showSkels(true); renderer.render(scene, overCam);
      renderer.setScissorTest(false); renderer.setViewport(0, 0, W_px, H_px);
    }
  }
  requestAnimationFrame(frame);
}

buildPanel();
addEventListener('resize', resize);
resize();
connect();
if (params.has('dummy')) startDummy(); else startVideo(localStorage.getItem('fx-cam') || undefined);
video.addEventListener('playing', syncTracker, { once: true });
frame();
