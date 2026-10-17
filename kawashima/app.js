// Third-person camera video + Three.js effects placed from the phones' sensor data.
// World frame: metres, y up, origin on the floor between the players. A stands at -x facing +x, B at +x facing -x.
import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const AX = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
const params = new URLSearchParams(location.search);

// ---- settings (kept in localStorage) ----
const DEFAULTS = {
  cam: { x: 0, y: 1.4, z: 4, yaw: 0, pitch: -8, roll: 0, fov: 50 }, // fov = vertical, degrees
  gap: 3,          // distance between the two start marks, m
  chestH: 1.3,     // chest phone height at calibration, m
  stickLen: 0.8,   // known stick length, m
  arUp: '-x',      // ARCore camera-pose axis that points up when the chest phone is worn (portrait, sensor at 90°): to check on hardware
  imuStick: '+x',  // IMU axis along the stick
  imuUp: '+z',     // IMU axis pointing up in the calibration pose (stick held forward, level)
  aim: 'stick',    // 'stick': along the stick, 'eye': eye -> stick tip
  swingDps: 400,   // provisional swing trigger until the sensor team sends actions
  debug: true,
};
const load = () => { try { return JSON.parse(localStorage.getItem('fx-cfg')) ?? {}; } catch { return {}; } };
const saved = load();
const cfg = { ...DEFAULTS, ...saved, cam: { ...DEFAULTS.cam, ...saved.cam } };
const save = () => { try { localStorage.setItem('fx-cfg', JSON.stringify(cfg)); } catch {} };

// ---- renderer / scene ----
const canvas = document.getElementById('gl'), video = document.getElementById('video'), stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(cfg.cam.fov, 16 / 9, 0.05, 100);
camera.rotation.order = 'YXZ';
let aspect = 16 / 9;

function applyCam() {
  const c = cfg.cam, d = THREE.MathUtils.degToRad;
  camera.position.set(c.x, c.y, c.z);
  camera.rotation.set(d(c.pitch), d(c.yaw), d(c.roll));
  camera.fov = c.fov; camera.aspect = aspect; camera.updateProjectionMatrix();
  particles.material.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(d(c.fov) / 2));
}
function resize() {
  const w = Math.min(innerWidth, innerHeight * aspect), h = w / aspect;
  stage.style.width = w + 'px'; stage.style.height = h + 'px';
  renderer.setSize(w, h, false);
  applyCam();
}

// debug helpers: floor grid, start marks, hit capsules
const debug = new THREE.Group(); scene.add(debug);
debug.add(new THREE.GridHelper(8, 16, 0x888888, 0x444444));

// ---- particles: one additive point cloud for everything ----
const N = 6000;
const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
const vel = new Float32Array(N * 3), life = new Float32Array(N), maxLife = new Float32Array(N), grav = new Float32Array(N);
let cursor = 0;
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
const particles = new THREE.Points(geo, new THREE.ShaderMaterial({
  uniforms: { scale: { value: 500 } },
  vertexShader: `attribute vec3 color; attribute float size; attribute float alpha; uniform float scale; varying vec3 vC; varying float vA;
    void main() { vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; varying float vA;
    void main() { float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); gl_FragColor = vec4(vC, a * vA); }`,
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
}));
particles.frustumCulled = false;
scene.add(particles);

function emit(p, v, color, s, l, g = 0) {
  const i = cursor; cursor = (cursor + 1) % N;
  pos.set([p.x, p.y, p.z], i * 3); vel.set([v.x, v.y, v.z], i * 3); col.set([color.r, color.g, color.b], i * 3);
  size[i] = s; life[i] = maxLife[i] = l; grav[i] = g;
}
function stepParticles(dt) {
  for (let i = 0; i < N; i++) {
    if (life[i] <= 0) { alpha[i] = 0; continue; }
    life[i] -= dt;
    const k = i * 3, drag = Math.exp(-2 * dt);
    vel[k + 1] += grav[i] * dt;
    vel[k] *= drag; vel[k + 1] *= drag; vel[k + 2] *= drag;
    pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
    alpha[i] = Math.max(0, life[i] / maxLife[i]);
  }
  for (const a of ['position', 'color', 'size', 'alpha']) geo.attributes[a].needsUpdate = true;
}
const rnd = (s = 1) => V((Math.random() - .5) * s, (Math.random() - .5) * s, (Math.random() - .5) * s);

// per-element looks: aura on the stick, trail of a projectile, burst on hit
const ELEMENTS = {
  fire: {
    aura(p) { emit(p.clone().add(rnd(.06)), rnd(.3).add(V(0, .6, 0)), new THREE.Color().setHSL(.05 + Math.random() * .06, 1, .55), .09, .5, .8); },
    trail(p) { for (let j = 0; j < 6; j++) emit(p.clone().add(rnd(.12)), rnd(.8).add(V(0, .5, 0)), new THREE.Color().setHSL(.02 + Math.random() * .1, 1, .5), .22, .6, .6); },
    burst(p) { for (let j = 0; j < 200; j++) emit(p.clone(), rnd(1).normalize().multiplyScalar(1 + Math.random() * 4), new THREE.Color().setHSL(.03 + Math.random() * .08, 1, .55), .25, .9, -2); },
  },
  thunder: {
    aura(p) { if (Math.random() < .5) emit(p.clone().add(rnd(.1)), rnd(2), new THREE.Color().setHSL(.55 + Math.random() * .08, 1, .7), .05, .15); },
    trail(p) { for (let j = 0; j < 6; j++) emit(p.clone().add(rnd(.25)), rnd(4), new THREE.Color().setHSL(.55 + Math.random() * .1, 1, .55 + Math.random() * .4), .1, .25); },
    burst(p) { for (let j = 0; j < 200; j++) emit(p.clone(), rnd(1).normalize().multiplyScalar(2 + Math.random() * 6), new THREE.Color().setHSL(.56, 1, .6 + Math.random() * .4), .12, .4); },
  },
};

// ---- players ----
function makePlayer(slot, side, element) {
  const facing = V(-side, 0, 0); // A (side -1) faces +x
  const stick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(), V()]), new THREE.LineBasicMaterial({ color: element === 'fire' ? 0xffa040 : 0x80d0ff }));
  const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(.3, 1.2, 4, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: .25 }));
  const mark = new THREE.Mesh(new THREE.RingGeometry(.25, .3, 32), new THREE.MeshBasicMaterial({ color: element === 'fire' ? 0xff7a1a : 0x6cc8ff, side: THREE.DoubleSide }));
  mark.rotation.x = -Math.PI / 2;
  debug.add(stick, capsule, mark);
  return { slot, side, element, facing, right: V().crossVectors(facing, UP), hp: 100, online: false, ar: null, imu: null,
    chest: V(), base: V(), tip: V(), dir: V(), lastShot: 0, stick, capsule, mark, hud: document.querySelector('.hud.' + slot) };
}
const players = { A: makePlayer('A', -1, 'fire'), B: makePlayer('B', 1, 'thunder') };
const other = p => p === players.A ? players.B : players.A;

const rotQ = ([w, x, y, z], [a, b, c]) => { // rotate v by quaternion [w, x, y, z]
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// v in a sensor frame whose forward F and up U are known at calibration -> player-local forward/up/right -> world
function toWorld(p, v, F, U) {
  const R = cross(F, U);
  return V().addScaledVector(p.facing, dot(v, F)).addScaledVector(UP, dot(v, U)).addScaledVector(p.right, dot(v, R));
}

function updatePlayer(p) {
  const start = V(p.side * cfg.gap / 2, 0, 0);
  p.mark.position.copy(start).setY(.01);
  // chest: start mark + ARCore displacement since calibration (camera looks down its -Z)
  p.chest.copy(start).setY(cfg.chestH);
  if (p.ar) p.chest.add(toWorld(p, p.ar.p, [0, 0, -1], AX[cfg.arUp]));
  p.capsule.position.copy(p.chest).setY(p.chest.y - .45);
  // stick: hand held in front of the chest, direction from the IMU (identity = held forward, level)
  p.base.copy(p.chest).addScaledVector(p.facing, .3).addScaledVector(p.right, .2).addScaledVector(UP, -.3);
  p.dir.copy(p.imu ? toWorld(p, rotQ(p.imu.q, AX[cfg.imuStick]), AX[cfg.imuStick], AX[cfg.imuUp]) : p.facing).normalize();
  p.tip.copy(p.base).addScaledVector(p.dir, cfg.stickLen);
  p.stick.geometry.setFromPoints([p.base, p.tip]);
  if (p.online || p.imu) for (let j = 0; j < 3; j++) ELEMENTS[p.element].aura(p.base.clone().lerp(p.tip, .6 + .4 * Math.random()));
}

// ---- game ----
const shots = [];
let winner = null;
const now = () => performance.now() / 1000;

function shoot(p, power = .5) {
  if (winner || now() - p.lastShot < .6) return;
  p.lastShot = now();
  const aim = params.has('demo') ? other(p).chest.clone().sub(p.tip).normalize() : cfg.aim === 'eye' ? p.tip.clone().sub(p.chest.clone().addScaledVector(UP, .35)).normalize() : p.dir.clone();
  shots.push({ owner: p, pos: p.tip.clone(), vel: aim.multiplyScalar(9), power, born: now() });
}
function stepShots(dt) {
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i], foe = other(s.owner);
    s.pos.addScaledVector(s.vel, dt);
    ELEMENTS[s.owner.element].trail(s.pos);
    // hit: distance to the opponent's vertical body segment (capsule radius .3 + shot radius .15)
    const a = foe.chest.clone().setY(foe.chest.y - 1.05), b = foe.chest.clone().setY(foe.chest.y + .15);
    const hit = new THREE.Line3(a, b).closestPointToPoint(s.pos, true, V()).distanceTo(s.pos) < .45;
    if (hit) {
      ELEMENTS[s.owner.element].burst(s.pos);
      foe.hp = Math.max(0, foe.hp - Math.round(10 + 20 * s.power));
      flash(s.owner.element);
      if (foe.hp === 0) winner = s.owner;
    }
    if (hit || now() - s.born > 1.5) shots.splice(i, 1);
  }
}
// ?demo: both players fire on their own, to check effects and hits without phones or keys
if (params.has('demo')) setInterval(() => { shoot(players.A, Math.random()); setTimeout(() => shoot(players.B, Math.random()), 400); if (winner) setTimeout(reset, 1500); }, 800);
function reset() { for (const p of Object.values(players)) p.hp = 100; shots.length = 0; winner = null; }

const flashEl = document.getElementById('flash');
function flash(el) {
  flashEl.style.transition = 'none'; flashEl.style.opacity = .5;
  flashEl.style.background = el === 'fire' ? 'radial-gradient(#ff7a1a, transparent 70%)' : 'radial-gradient(#bfe8ff, transparent 70%)';
  requestAnimationFrame(() => { flashEl.style.transition = 'opacity .35s'; flashEl.style.opacity = 0; });
}

// ---- sensing server link (same protocol as sensing/dashboard) ----
const host = params.get('host') ?? `${location.hostname}:8000`;
let linkState = 'connecting';
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
    if (k.type === 'imu') {
      p.imu = k;
      const dps = Math.hypot(...k.gyro);
      if (dps > cfg.swingDps) shoot(p, Math.min(1, dps / (2 * cfg.swingDps)));
    } else if (k.type === 'ar' && k.tracking === 'TRACKING') p.ar = k;
    else if (k.type === 'calib') { p.ar = null; p.imu = null; }
  };
}

// ---- third-person camera (iPhone via Continuity Camera, or any webcam) ----
async function startVideo(deviceId) {
  try {
    video.srcObject?.getTracks().forEach(t => t.stop());
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 1920, height: 1080 } });
    localStorage.setItem('fx-cam', deviceId ?? '');
  } catch (e) { status.extra = 'camera: ' + e.message; }
  fillDevices();
}
video.onloadedmetadata = () => { aspect = video.videoWidth / video.videoHeight; resize(); };

// ---- settings panel (C) ----
const panel = document.getElementById('panel');
const status = { extra: '' };
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
  s.onchange = () => { cfg[key] = s.value; save(); };
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
  const c = cfg.cam;
  panel.append(h3('3人称カメラ'), camSel,
    h3('カメラ位置合わせ（グリッドと床の目印を重ねる）'),
    slider('x', () => c.x, v => c.x = v, -5, 5, .01), slider('y', () => c.y, v => c.y = v, 0, 4, .01), slider('z', () => c.z, v => c.z = v, -2, 10, .01),
    slider('yaw', () => c.yaw, v => c.yaw = v, -90, 90, .1), slider('pitch', () => c.pitch, v => c.pitch = v, -60, 30, .1), slider('roll', () => c.roll, v => c.roll = v, -20, 20, .1),
    slider('fov(縦)', () => c.fov, v => c.fov = v, 20, 100, .1),
    h3('立ち位置・棒'),
    slider('開始位置の間隔', () => cfg.gap, v => cfg.gap = v, 1, 6, .05), slider('胸の高さ', () => cfg.chestH, v => cfg.chestH = v, .8, 1.8, .01),
    slider('棒の長さ', () => cfg.stickLen, v => cfg.stickLen = v, .2, 1.5, .01), slider('振り判定 deg/s', () => cfg.swingDps, v => cfg.swingDps = v, 100, 1500, 10),
    select('狙い', 'aim', ['stick', 'eye']),
    h3('センサー軸（実機で確認）'),
    select('AR 上方向', 'arUp', Object.keys(AX)), select('IMU 棒方向', 'imuStick', Object.keys(AX)), select('IMU 上方向', 'imuUp', Object.keys(AX)),
    Object.assign(document.createElement('div'), { className: 'keys', innerHTML: 'C パネル / G デバッグ表示 / Space A発射 / Enter B発射 / R リセット' }));
}

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'c') panel.classList.toggle('open');
  else if (e.key === 'g') { cfg.debug = !cfg.debug; save(); }
  else if (e.key === ' ') { e.preventDefault(); shoot(players.A); }
  else if (e.key === 'Enter') shoot(players.B);
  else if (e.key === 'r') reset();
});

// ---- main loop ----
const banner = document.getElementById('banner'), statusEl = document.getElementById('status');
let last = now();
function frame() {
  const t = now(), dt = Math.min(.05, t - last); last = t;
  for (const p of Object.values(players)) {
    updatePlayer(p);
    p.hud.querySelector('.bar i').style.width = p.hp + '%';
    p.hud.querySelector('.off').textContent = p.online ? '' : 'offline';
  }
  stepShots(dt); stepParticles(dt);
  debug.visible = cfg.debug;
  banner.style.display = winner ? 'grid' : 'none';
  banner.textContent = winner ? `${winner.slot} WIN!` : '';
  statusEl.textContent = `server ${host}: ${linkState}  ${status.extra}`;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

buildPanel();
addEventListener('resize', resize);
resize();
connect();
startVideo(localStorage.getItem('fx-cam') || undefined);
frame();
