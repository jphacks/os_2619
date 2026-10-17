// Dummy third-person camera: a rendered "real room" (floor, corner-tag poles, two players with sticks) seen from a
// tripod, as a MediaStream. Stands in for the iPhone so effects and tag calibration can be tested without hardware.
// Tags are real tag36h11 bitmaps at the exact world.js poses, so a real detector reads them.
// Camera pose convention (same as extrinsics.js): world_T_cam with cam = OpenCV frame (x right, y down, z forward).
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import * as W from './world.js';

// ---- tag36h11 ----
// Codes for ids 0-11 (AprilRobotics Tag36h11.java; same as js-aruco2 / OpenCV DICT_APRILTAG_36h11).
// Bit 35 (MSB) .. bit 0 = data cells row-major from the top-left of the upright apriltag-imgs PNG, 1 = white.
const TAG36H11 = [0xd5d628584, 0xd97f18b49, 0xdd280910e, 0xe479e9c98, 0xebcbca822, 0xf31dab3ac,
  0x56a5d085, 0x10652e1d4, 0x22b1dfead, 0x265ad0472, 0x34fe91b86, 0x3ff962cd5];

/**
 * 10x10 cell grid (1 = white): 1-cell white quiet zone, 1-cell black border, 6x6 data.
 * Oriented the way OpenCV's DICT_APRILTAG_36h11 sees it (= apriltag-imgs PNG turned 180°): OpenCV's corner 0, which
 * sensing Vision.kt maps to tag (-h, h), is this grid's top-left. Checked with cv2 4.13 (generateImageMarker match).
 */
export function tagGrid(id) {
  const c = TAG36H11[id], g = Array.from({ length: 10 }, (_, r) => Array.from({ length: 10 }, (_, k) => +(r === 0 || r === 9 || k === 0 || k === 9)));
  for (let b = 0; b < 36; b++) {
    const r = 2 + Math.floor(b / 6), k = 2 + (b % 6);
    g[9 - r][9 - k] = Math.floor(c / 2 ** (35 - b)) % 2; // 180° turn of the PNG layout
  }
  return g;
}
/** Tag image on a canvas, `cell` px per cell (10 cells incl. quiet zone). Print it so the black square is TAGS[id].size. */
export function tagCanvas(id, cell = 32) {
  const g = tagGrid(id), cv = document.createElement('canvas');
  cv.width = cv.height = 10 * cell;
  const x = cv.getContext('2d');
  for (let r = 0; r < 10; r++) for (let k = 0; k < 10; k++) { x.fillStyle = g[r][k] ? '#fff' : '#000'; x.fillRect(k * cell, r * cell, cell, cell); }
  return cv;
}

// ---- small helpers ----
const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);
const m4 = p => new THREE.Matrix4().set(p.R[0], p.R[1], p.R[2], p.t[0], p.R[3], p.R[4], p.R[5], p.t[1], p.R[6], p.R[7], p.R[8], p.t[2], 0, 0, 0, 1);
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, s = 1) => a.map((x, i) => x + s * b[i]);

/** world_T_cam (OpenCV cam frame) for a camera at `pos` looking at `target`, rolled `rollDeg` about its view axis. */
export function lookAtPose(pos, target, rollDeg = 0) {
  const z = norm(add(target, pos, -1)), x0 = norm(cross(z, [0, 1, 0])), y0 = cross(z, x0); // y0 = down
  const a = rollDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const x = add(x0.map(v => v * c), y0, s), y = add(y0.map(v => v * c), x0, -s);
  return W.pose(W.fromCols(x, y, z), [...pos]);
}
// Deliberately not app.js's default slider camera (0, 1.4, 4, pitch -8, fov 50). Placed so today's side tags (x = +-2)
// are seen at <= 60° from their normal and >= 40 px tall at 720p: from z = 4.2 they are ~68° off and too thin to decode.
export const DEFAULT_POSE = lookAtPose([0.3, 1.7, 2.9], [0, 1.0, -0.6], 2.5);

function canvasTex(w, h, draw, repeat) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}
// Seeded noise so the room looks the same every run
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function woodFloor() {
  return canvasTex(512, 512, (x, w, h) => {
    const n = 8, ph = h / n;
    for (let i = 0; i < n; i++) {
      const off = rnd() * w;
      for (let j = -1; j < 3; j++) {
        const l = 130 + rnd() * 40;
        x.fillStyle = `rgb(${l + 20},${l * .78 | 0},${l * .55 | 0})`;
        x.fillRect(off + j * w / 2, i * ph, w / 2 - 2, ph - 2);
      }
      for (let k = 0; k < 40; k++) { x.strokeStyle = `rgba(60,35,15,${.05 + rnd() * .08})`; x.beginPath(); const yy = i * ph + rnd() * ph; x.moveTo(0, yy); x.lineTo(w, yy + rnd() * 4 - 2); x.stroke(); }
    }
  }, [6, 6]);
}

// ---- players ----
function makePlayer(color, tagId) {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: .8 }), skin = new THREE.MeshStandardMaterial({ color: 0xe0b08a, roughness: .7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d36, roughness: .9 });
  // body frame of world.bodyPose: x forward, y up, z right; origin at the chest tag
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(.17, .5, 6, 16), mat); torso.position.set(-.18, -.12, 0); body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.12, 20, 14), skin); head.position.set(-.16, .38, 0); body.add(head);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.07, .75, 4, 10), dark); leg.position.set(-.18, -.85, .09 * s); body.add(leg);
  }
  const offArm = new THREE.Mesh(new THREE.CapsuleGeometry(.05, .5, 4, 10), mat); offArm.position.set(-.18, -.15, -.24); body.add(offArm);
  const tagMat = new THREE.MeshBasicMaterial({ map: tagTex(tagId) }), sz = W.TAGS[tagId].size * 10 / 8;
  const tag = new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), tagMat); tag.matrixAutoUpdate = false; g.add(tag);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, 1, 10), mat), stick = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, 1, 10), new THREE.MeshStandardMaterial({ color: 0xd8c08a, roughness: .5 }));
  const hand = new THREE.Mesh(new THREE.SphereGeometry(.05, 12, 8), skin);
  g.add(arm, stick, hand);
  body.matrixAutoUpdate = false;
  const between = (m, a, b) => { // cylinder (axis y, length 1) from a to b
    const d = new THREE.Vector3().subVectors(b, a), L = d.length();
    m.position.copy(a).addScaledVector(d, .5); m.scale.set(1, L, 1);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  };
  return {
    group: g,
    set(t) {
      const bp = W.bodyPose(t.chest, t.yaw, t.chest[1]);
      body.matrix.copy(m4(bp));
      const tp = W.chestTagPose(bp); tp.t = W.apply(tp, [0, 0, .005]); // just proud of the chest
      tag.matrix.copy(m4(tp));
      const shoulder = v3(W.apply(bp, [-.15, .15, .22])), base = v3(t.base), tip = v3(t.tip);
      between(arm, shoulder, base); between(stick, base.clone().addScaledVector(new THREE.Vector3().subVectors(base, tip).normalize(), .1), tip);
      hand.position.copy(base);
    },
  };
}
const tagTexCache = {};
function tagTex(id) {
  if (tagTexCache[id]) return tagTexCache[id];
  const t = new THREE.CanvasTexture(tagCanvas(id, 32));
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.NearestFilter;
  return (tagTexCache[id] = t);
}

// Fallback motion when no truth arrives: the two players sidestep, face each other and swing.
function synthTruth(slot, time) {
  const s = slot === 'A' ? -1 : 1, ph = slot === 'A' ? 0 : 1.7;
  const chest = [s * (1.2 + .25 * Math.sin(.6 * time + ph)), W.CHEST_H + .03 * Math.sin(2.6 * time + ph), .5 * Math.sin(.45 * time + ph)];
  const other = [-s * 1.2, 0, .5 * Math.sin(.45 * time + (slot === 'A' ? 1.7 : 0))];
  const yaw = Math.atan2(-(other[2] - chest[2]), other[0] - chest[0]);
  const bp = W.bodyPose(chest, yaw, chest[1]), h = W.STICK.hand;
  const base = W.apply(bp, [h.fwd, h.up, h.right]);
  const sw = (time * .8 + ph) % 3, swinging = sw < .5;
  const el = swinging ? 1.2 - 4.4 * sw : .9 * Math.sin(1.5 * time + ph) + .3, az = .3 * Math.sin(time + ph);
  const dir = W.app3(bp.R, [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]);
  return { type: 'truth', slot, chest, yaw, base, tip: add(base, dir, W.STICK.len), dir, swinging };
}

/**
 * createDummyCam({ width, height, fovY, pose, host, players }) -> { stream, canvas, truePose, setPose, setTruth, render, showPlayers, stop }
 * pose: world_T_cam (OpenCV cam frame). truePose = { R, t, fovY }. host: optional 'localhost:8000' to read truth itself
 * (app.js already relays truth through setTruth, so leave it off there). render(timeSec) draws one frame now.
 */
export function createDummyCam({ width = 1280, height = 720, fovY = 55, pose = DEFAULT_POSE, host = null, players: showPlayers = true } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x3a3f47);

  // camera: three's camera frame is the cv frame turned 180° about x
  const camera = new THREE.PerspectiveCamera(fovY, width / height, .05, 60);
  camera.matrixAutoUpdate = false;
  const truePose = { R: [], t: [], fovY };
  const setPose = p => { // world_T_cam (cv frame)
    camera.matrix.copy(m4(W.pose(W.mul3(p.R, [1, 0, 0, 0, -1, 0, 0, 0, -1]), p.t))); camera.matrixWorldNeedsUpdate = true;
    truePose.R = [...p.R]; truePose.t = [...p.t];
  };
  setPose(pose);

  // lights
  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x504030, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(2.5, 6, 3); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 });
  scene.add(sun);

  // room: wood floor, walls, a few boxes
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ map: woodFloor(), roughness: .85 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const wallMat = c => new THREE.MeshStandardMaterial({ color: c, roughness: .95 });
  for (const [x, z, ry, c] of [[0, -5.5, 0, 0xc9c3b8], [-5.5, 0, Math.PI / 2, 0xbfc6c9], [5.5, 0, -Math.PI / 2, 0xbfc6c9], [0, 7, Math.PI, 0xc9c3b8]]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(14, 4), wallMat(c)); w.position.set(x, 2, z); w.rotation.y = ry; w.receiveShadow = true; scene.add(w);
  }
  const win = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.3), new THREE.MeshBasicMaterial({ color: 0xdfeefa })); win.position.set(-2.8, 1.9, -5.49); scene.add(win);
  for (const [x, z, w, h, d, c] of [[3.6, -4.6, 1.6, .8, .7, 0x6b5a48], [-4.6, -2.5, .6, 1.1, 1.2, 0x48566b], [4.4, 1.5, .5, .5, .5, 0x8a6f4d]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat(c)); b.position.set(x, h / 2, z); b.castShadow = b.receiveShadow = true; scene.add(b);
  }
  // tape on the floor around the arena
  const H = W.ARENA.half, tape = new THREE.MeshStandardMaterial({ color: 0xf2d24b, roughness: .6 });
  for (const [x, z, w, d] of [[0, -H, 2 * H, .05], [0, H, 2 * H, .05], [-H, 0, .05, 2 * H], [H, 0, .05, 2 * H]]) {
    const t = new THREE.Mesh(new THREE.PlaneGeometry(w, d), tape); t.rotation.x = -Math.PI / 2; t.position.set(x, .002, z); scene.add(t);
  }
  for (const s of ['A', 'B']) { // start marks
    const m = new THREE.Mesh(new THREE.RingGeometry(.12, .16, 24), tape); m.rotation.x = -Math.PI / 2; m.position.set(W.START[s].pos[0], .003, W.START[s].pos[2]); scene.add(m);
  }

  // fixed tags on poles: tag plane exactly at worldTagPose (flip: the sheet is upright, the tag frame turned 180°),
  // board and pole behind it in an upright frame
  for (const id of W.CORNER_IDS) {
    const tp = W.worldTagPose(id), s = W.TAGS[id].size, g = new THREE.Group(), gu = new THREE.Group();
    const up = tp.R[4] > 0 ? tp : W.pose(W.mul3(tp.R, [-1, 0, 0, 0, -1, 0, 0, 0, 1]), tp.t);
    g.matrixAutoUpdate = gu.matrixAutoUpdate = false; g.matrix.copy(m4(tp)); gu.matrix.copy(m4(up)); scene.add(g, gu);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(s * 10 / 8, s * 10 / 8), new THREE.MeshStandardMaterial({ map: tagTex(id), roughness: .9 }));
    const board = new THREE.Mesh(new THREE.BoxGeometry(s * 1.5, s * 1.5, .012), new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: .9 }));
    board.position.z = -.0065; board.castShadow = true;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, W.CHEST_H + .3, 12), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: .6, roughness: .4 }));
    pole.position.set(0, (.3 - W.CHEST_H) / 2, -.035); pole.castShadow = true;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(.18, .2, .03, 24), new THREE.MeshStandardMaterial({ color: 0x30343a }));
    foot.position.set(0, .015 - W.CHEST_H, -.035);
    g.add(face); gu.add(board, pole, foot);
  }

  const players = { A: makePlayer(0xd2532a, W.PLAYER_TAG.A), B: makePlayer(0x2f7fd0, W.PLAYER_TAG.B) };
  for (const p of Object.values(players)) { p.group.traverse(o => { if (o.isMesh) o.castShadow = true; }); p.group.visible = showPlayers; scene.add(p.group); }
  const truth = { A: null, B: null }, last = { A: -1e9, B: -1e9 };
  const setTruth = (slot, k) => { if (!truth.hasOwnProperty(slot)) return; truth[slot] = k; last[slot] = performance.now(); };

  function render(time = performance.now() / 1000) {
    for (const s of ['A', 'B']) players[s].set(performance.now() - last[s] < 1000 ? truth[s] : synthTruth(s, time));
    renderer.render(scene, camera);
  }

  let raf = 0, ws = null, alive = true;
  const loop = () => { render(); raf = requestAnimationFrame(loop); };
  loop();
  if (host) (function connect() {
    if (!alive) return;
    ws = new WebSocket(`ws://${host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'dashboard', id: 'kawashima-dummycam' }));
    ws.onmessage = m => { if (typeof m.data !== 'string') return; const k = JSON.parse(m.data); if (k.type === 'truth') setTruth(k.slot, k); };
    ws.onclose = () => setTimeout(connect, 1000);
  })();

  const stream = canvas.captureStream(30);
  return {
    stream, canvas, render, setTruth,
    showPlayers(on) { for (const p of Object.values(players)) p.group.visible = on; }, // off = empty arena, as when calibrating
    truePose, setPose,
    stop() { alive = false; cancelAnimationFrame(raf); ws?.close(); stream.getTracks().forEach(t => t.stop()); renderer.dispose(); },
  };
}
