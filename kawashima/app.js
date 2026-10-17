// Third-person camera video + Three.js effects placed from the phones' sensor data.
// Frames and the arena layout live in world.js. Players are located by localize.js (corner tags + ARCore),
// the third-person camera by extrinsics.js (corner tags in its own picture) or by hand with the sliders.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as W from './world.js';
import { createLocalizer } from './localize.js';
import { createFx } from './effects.js';
import { calibrateCamera, toThreeCamera } from './extrinsics.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v3 = a => V(a[0], a[1], a[2]);
const params = new URLSearchParams(location.search);
const now = () => performance.now() / 1000;

// ---- settings (kept in localStorage) ----
const DEFAULTS = {
  cam: { x: 0, y: 1.4, z: 4, yaw: 0, pitch: -8, roll: 0, fov: 50 }, // manual camera, fov = vertical degrees
  tagCam: null,     // result of calibrateCamera, used when camMode === 'tags'
  camMode: 'manual',
  aim: 'stick',     // 'stick': along the stick, 'eye': eye -> stick tip
  swingDps: 400,    // provisional swing trigger until the sensor team sends actions
  debug: false,     // grid / tags / capsules in the main view
  view: 'pip',      // 'pip' | 'full3d' | 'off'
  useTruth: false,  // fake-world only: place players from the simulator's ground truth
};
const load = () => { try { return JSON.parse(localStorage.getItem('fx-cfg2')) ?? {}; } catch { return {}; } };
const saved = load();
const cfg = { ...DEFAULTS, ...saved, cam: { ...DEFAULTS.cam, ...saved.cam } };
const save = () => { try { localStorage.setItem('fx-cfg2', JSON.stringify(cfg)); } catch {} };

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
const orbit = new OrbitControls(overCam, canvas);
orbit.target.set(0, 1, 0); orbit.update();
let aspect = 16 / 9, W_px = 1, H_px = 1;

function applyCam() {
  if (cfg.camMode === 'tags' && cfg.tagCam) toThreeCamera(cfg.tagCam, camera);
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
  const w = Math.min(innerWidth, innerHeight * aspect), h = w / aspect;
  stage.style.width = w + 'px'; stage.style.height = h + 'px';
  renderer.setSize(w, h, false);
  W_px = w; H_px = h;
  fx.setSize(w, h);
  applyCam();
}

const fx = createFx(renderer, scene, camera);

// ---- 3D world: arena, tags, phones, third-person camera (always in the 3D view, in the main view with G) ----
const world3d = new THREE.Group(); scene.add(world3d);
const toMat = p => new THREE.Matrix4().set(p.R[0], p.R[1], p.R[2], p.t[0], p.R[3], p.R[4], p.R[5], p.t[1], p.R[6], p.R[7], p.R[8], p.t[2], 0, 0, 0, 1);
world3d.add(new THREE.GridHelper(W.ARENA.half * 2, 8, 0x888888, 0x444444));
for (const id of W.CORNER_IDS) {
  const p = W.worldTagPose(id), size = W.TAGS[id].size;
  const tag = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  tag.matrixAutoUpdate = false; tag.matrix.copy(toMat(p));
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, p.t[1]), new THREE.MeshBasicMaterial({ color: 0x777777 }));
  pole.position.set(p.t[0], p.t[1] / 2, p.t[2]);
  world3d.add(tag, pole);
}
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
  p.body = cfg.useTruth && T ? W.bodyPose(T.chest, T.yaw, T.chest[1]) : L.body ?? W.bodyPose(st.pos, st.yaw);
  p.chest.copy(v3(p.body.t));
  p.capsule.position.copy(p.chest).setY(p.chest.y - .45);
  // hand in the body frame (x fwd, y up, z right); stick direction from the IMU, tared at the start mark facing the opponent
  const h = W.STICK.hand;
  p.base.copy(v3(W.apply(p.body, [h.fwd, h.up, h.right])));
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
  if (p.online || p.imu || params.has('demo')) {
    fx.aura(p.element, p.base, p.tip, p.charging ? .6 + .4 * p.charge : .5);
    if (p.charging) fx.charge(p.element, p.tip, p.charge);
  }
}

// ---- game ----
const shots = [];
let winner = null;

function shoot(p, power = .5) {
  if (winner || now() - p.lastShot < .6) return;
  p.lastShot = now();
  const foe = other(p);
  if (power >= 1) { // full charge: special move straight at the opponent
    fx.special(p.element, p.tip.clone(), foe.chest.clone());
    return damage(foe, p, 35);
  }
  const aim = params.has('demo') ? foe.chest.clone().sub(p.tip).normalize()
    : cfg.aim === 'eye' ? p.tip.clone().sub(p.chest.clone().add(V(0, .35, 0))).normalize() : p.dir.clone();
  shots.push({ id: fx.shot(p.element, p.tip.clone(), aim.clone(), power), owner: p, pos: p.tip.clone(), vel: aim.multiplyScalar(9), power, born: now() });
}
function damage(foe, from, n) {
  foe.hp = Math.max(0, foe.hp - n);
  flash(from.element);
  if (foe.hp === 0) winner = from;
}
function stepShots(dt) {
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i], foe = other(s.owner);
    s.pos.addScaledVector(s.vel, dt);
    fx.moveShot(s.id, s.pos);
    // hit: distance to the opponent's vertical body segment (capsule radius .3 + shot radius .15)
    const a = foe.chest.clone().setY(foe.chest.y - 1.05), b = foe.chest.clone().setY(foe.chest.y + .15);
    const hit = new THREE.Line3(a, b).closestPointToPoint(s.pos, true, V()).distanceTo(s.pos) < .45;
    if (hit) { fx.hit(s.owner.element, s.pos.clone(), s.power); damage(foe, s.owner, Math.round(10 + 20 * s.power)); }
    if (hit || now() - s.born > 1.5) { fx.endShot(s.id); shots.splice(i, 1); }
  }
}
function stepCharge(dt) {
  for (const p of Object.values(players)) if (p.charging) p.charge = Math.min(1, p.charge + dt / 1.5);
}
function reset() { for (const p of Object.values(players)) { p.hp = 100; p.charge = 0; p.charging = false; } for (const s of shots) fx.endShot(s.id); shots.length = 0; winner = null; }

// ?demo: both players fire on their own, to check effects and hits without phones or keys
if (params.has('demo')) setInterval(() => { shoot(players.A, Math.random() * .9); setTimeout(() => shoot(players.B, Math.random() * .9), 400); if (winner) setTimeout(reset, 1500); }, 800);

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
    if (typeof m.data !== 'string') return; // chest-camera JPEGs: not used here
    const k = JSON.parse(m.data);
    if (k.type === 'phones') { for (const p of Object.values(players)) p.online = k.list.some(q => q.slot === p.slot); return; }
    const p = players[k.slot]; if (!p) return;
    loc.onMessage(k);
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
  } catch (e) { status.extra = 'camera: ' + e.message; }
  fillDevices();
}
async function startDummy() {
  const { createDummyCam } = await import('./dummycam.js');
  dummy = createDummyCam({ width: 1280, height: 720 });
  video.srcObject = dummy.stream;
  setTimeout(calibrate, 1500); // the dummy room never moves: calibrate once it has rendered
}
video.onloadedmetadata = () => { video.play(); aspect = video.videoWidth / video.videoHeight; resize(); };

async function calibrate() {
  status.extra = 'タグでカメラ合わせ中…';
  const r = await calibrateCamera(dummy?.canvas ?? video, { fovYGuess: cfg.cam.fov });
  if (!r) { status.extra = '角のタグが見つからない'; return; }
  cfg.tagCam = r; cfg.camMode = 'tags'; save(); applyCam();
  status.extra = `カメラ合わせ完了: タグ ${r.ids.join(',')}  再投影誤差 ${r.reprojErrPx.toFixed(1)}px  fov ${r.fovY.toFixed(1)}°`;
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
      'C パネル / G デバッグ表示 / V 3Dビュー切替 / K タグでカメラ合わせ / T 正解位置(ダミー)<br>Space A発射 / Enter B発射 / Q・P 長押しで溜め(A・B) / R リセット' }));
}

const held = { q: players.A, p: players.B };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.repeat) return;
  if (held[e.key]) { held[e.key].charging = true; held[e.key].charge = 0; }
  else if (e.key === 'c') panel.classList.toggle('open');
  else if (e.key === 'g') { cfg.debug = !cfg.debug; save(); }
  else if (e.key === 'v') { cfg.view = { pip: 'full3d', full3d: 'off', off: 'pip' }[cfg.view]; save(); }
  else if (e.key === 'k') calibrate();
  else if (e.key === 't') { cfg.useTruth = !cfg.useTruth; save(); }
  else if (e.key === ' ') { e.preventDefault(); shoot(players.A); }
  else if (e.key === 'Enter') shoot(players.B);
  else if (e.key === 'r') reset();
});
addEventListener('keyup', e => {
  const p = held[e.key]; if (!p?.charging) return;
  p.charging = false; p.lastShot = 0; shoot(p, p.charge); p.charge = 0;
});

// ---- main loop ----
const banner = document.getElementById('banner'), statusEl = document.getElementById('status'), pipLabel = document.getElementById('pipLabel');
function locText(slot) {
  const L = loc.get(slot);
  return `${slot}: ${L.anchored ? `タグ固定 ${L.fixes}回 ずれ${(L.err * 100).toFixed(0)}cm` : '未固定(開始位置)'}`;
}
let last = now();
function frame() {
  const t = now(), dt = Math.min(.05, t - last); last = t;
  for (const p of Object.values(players)) {
    updatePlayer(p);
    p.hud.querySelector('.bar i').style.width = p.hp + '%';
    p.hud.querySelector('.off').textContent = p.online ? '' : 'offline';
  }
  stepCharge(dt); stepShots(dt); fx.step(dt);
  banner.style.display = winner ? 'grid' : 'none';
  banner.textContent = winner ? `${winner.slot} WIN!` : '';
  statusEl.textContent = `server ${host}: ${linkState}  ${locText('A')}  ${locText('B')}  カメラ:${cfg.camMode}${cfg.useTruth ? '  [正解位置]' : ''}  ${status.extra}`;
  pipLabel.style.display = cfg.view === 'pip' ? '' : 'none';

  renderer.setScissorTest(false);
  if (cfg.view === 'full3d') {
    scene.background = DARK; world3d.visible = true; camHelper.visible = true;
    overCam.aspect = aspect; overCam.updateProjectionMatrix();
    renderer.setViewport(0, 0, W_px, H_px); renderer.render(scene, overCam);
  } else {
    scene.background = videoTex; world3d.visible = cfg.debug; camHelper.visible = false;
    fx.render();
    if (cfg.view === 'pip') { // 3D view in the bottom-right corner
      const w = W_px * .3, h = H_px * .3;
      scene.background = DARK; world3d.visible = true; camHelper.visible = true;
      overCam.aspect = w / h; overCam.updateProjectionMatrix();
      renderer.setScissorTest(true); renderer.setScissor(W_px - w - 8, 8, w, h); renderer.setViewport(W_px - w - 8, 8, w, h);
      renderer.render(scene, overCam);
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
frame();
