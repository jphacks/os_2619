// Dummy third-person camera: a rendered "real room" (floor, corner-tag poles, two players with sticks) seen from a
// tripod, as a MediaStream. Stands in for the iPhone so effects and tag calibration can be tested without hardware.
// Tags are real tag36h11 bitmaps at the exact world.js poses, so a real detector reads them.
// Camera pose convention (same as extrinsics.js): world_T_cam with cam = OpenCV frame (x right, y down, z forward).
import * as THREE from 'three'; // resolved by the page's importmap (local ./cdn copy on index.html)
import * as W from './world.js';
import { createDummyMotion } from './dummy-motion.js';
import { RUNE, runePrims } from './runetag.js';

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
  if (W.isRune(id)) return runeCanvas(id, Math.max(10 * cell, 640));
  const g = tagGrid(id), cv = document.createElement('canvas');
  cv.width = cv.height = 10 * cell;
  const x = cv.getContext('2d');
  for (let r = 0; r < 10; r++) for (let k = 0; k < 10; k++) { x.fillStyle = g[r][k] ? '#fff' : '#000'; x.fillRect(k * cell, r * cell, cell, cell); }
  return cv;
}

/** The whole printed RuneTag sheet (250 mm, = TAGS[id].size x 10/8 like a tag's paper) on an n x n canvas. */
function runeCanvas(id, n) {
  const cv = document.createElement('canvas'), x = cv.getContext('2d'), k = n / RUNE.sheet;
  cv.width = cv.height = n;
  x.fillStyle = '#fff'; x.fillRect(0, 0, n, n);
  x.setTransform(k, 0, 0, -k, n / 2, n / 2); // marker frame (m, y up) -> pixels
  x.fillStyle = x.strokeStyle = '#000'; x.lineCap = x.lineJoin = 'round';
  for (const p of runePrims(id)) {
    x.beginPath();
    if (p.t === 'path') { p.p.forEach((q, i) => x[i ? 'lineTo' : 'moveTo'](...q)); if (p.closed) x.closePath(); }
    else x.arc(p.c[0], p.c[1], p.r, 0, 2 * Math.PI);
    if (p.t === 'disc') x.fill(); else { x.lineWidth = p.w; x.stroke(); }
  }
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

// ---- the room's truth layout ----
// The page's TAGS are the *believed* layout: a scan (setField) overwrites them. The dummy room is the real world, so it
// keeps its own copy, taken when this module loads (before any scan), and never reads TAGS / FIELD again.
const BASE_TAGS = JSON.parse(JSON.stringify(W.TAGS));
/** world_T_tag of a truth tag (same conventions as world.js worldTagPose, but on our copy). */
function truthPose(t) {
  if (t.floor) { const a = (t.yaw ?? 0) + (t.flip ? Math.PI : 0), c = Math.cos(a), s = Math.sin(a); return W.pose(W.fromCols([c, 0, -s], [-s, 0, -c], [0, 1, 0]), t.pos); }
  const n = Math.hypot(t.pos[0], t.pos[2]), z = [-t.pos[0] / n, 0, -t.pos[2] / n], x = [z[2], 0, -z[0]];
  return t.flip ? W.pose(W.fromCols(x.map(v => -v), [0, -1, 0], z), t.pos) : W.pose(W.fromCols(x, [0, 1, 0], z), t.pos);
}
/**
 * Truth layout: { tags: { id: { size, pos, floor, yaw, flip, player } }, poly: [[x, z]...], start: { A: [x, 0, z], B } }.
 * floorTags ({ id: { pos: [x, 0, z], yaw } }) moves sheets (map4: all four). With >= 3 floor sheets the field outline is
 * the sheets' quadrilateral (in angle order round their middle), otherwise the layout's square. Start marks as setField.
 */
export function truthLayout(floorTags = null) {
  const tags = JSON.parse(JSON.stringify(BASE_TAGS));
  for (const [id, t] of Object.entries(floorTags ?? {})) tags[id] = { size: tags[id]?.size ?? t.size ?? .16, ...tags[id], pos: [t.pos[0], 0, t.pos[2]], yaw: t.yaw ?? 0, floor: true, flip: false };
  const sheets = Object.values(tags).filter(t => t.floor && t.pos);
  let poly;
  if (sheets.length >= 3 && !W.FIXED_FIELD) { // (the fixed middle square of map4 is not the play area: that stays the ARENA square)
    const mx = sheets.reduce((a, t) => a + t.pos[0], 0) / sheets.length, mz = sheets.reduce((a, t) => a + t.pos[2], 0) / sheets.length;
    poly = sheets.map(t => [t.pos[0], t.pos[2]]).sort((p, q) => Math.atan2(p[1] - mz, p[0] - mx) - Math.atan2(q[1] - mz, q[0] - mx));
  } else { const H = 2; poly = [[-H, -H], [H, -H], [H, H], [-H, H]]; } // the layouts' 4 m square (ARENA.half before any scan)
  const xs = poly.map(p => p[0]), minX = Math.min(...xs), maxX = Math.max(...xs), inset = Math.min(.9, (maxX - minX) * .22);
  return { tags, poly, start: { A: [minX + inset, 0, 0], B: [maxX - inset, 0, 0] } };
}
/**
 * A believable random map4 room for tests, deterministic per seed: ids 0-3 at the corners as in world.js (0 B-near,
 * 1 A-near, 2 A-far, 3 B-far; near = +z, the camera side), 2-6 m wide and 2-4.5 m deep, each corner jittered so no edge
 * is axis-aligned, every sheet turned at random. Already in the scanned field's frame: origin at the outline's area
 * centroid and +x from the middle of the A side (1, 2) to the middle of the B side (0, 3), so a scan should give it back.
 */
export function randomMap4(seed = 1) {
  let s = (seed * 2654435761) % 2147483647 || 1; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4; i++) r();
  const wx = 2 + 4 * r(), dz = 2 + 2.5 * r(), j = () => (r() - .5) * .36;
  let P = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => [sx * wx / 2 + j() * wx * .5, sz * dz / 2 + j() * dz * .5]);
  const ma = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2], mb = [(P[0][0] + P[3][0]) / 2, (P[0][1] + P[3][1]) / 2];
  const a = -Math.atan2(mb[1] - ma[1], mb[0] - ma[0]), c = Math.cos(a), sn = Math.sin(a);
  P = P.map(([x, z]) => [c * x - sn * z, sn * x + c * z]); // A->B along +x (rotation about y in the x-z plane)
  let A = 0, cx = 0, cz = 0; // area centroid
  for (let i = 0; i < 4; i++) { const [x0, z0] = P[i], [x1, z1] = P[(i + 1) % 4], k = x0 * z1 - x1 * z0; A += k; cx += (x0 + x1) * k; cz += (z0 + z1) * k; }
  cx /= 3 * A; cz /= 3 * A;
  return Object.fromEntries(P.map(([x, z], id) => [id, { pos: [x - cx, 0, z - cz], yaw: (r() * 2 - 1) * Math.PI }]));
}
/**
 * Test fields for the *-test pages: 'square' (null: keep world.js's default), 'thin' (6 m x 2.5 m), 'small' (2 m x 2 m),
 * a number = randomMap4(seed). Returns { poly, tags } ready for world.js setField (an oracle scan of that room), or null.
 */
export function fieldPreset(name) {
  if (name == null || name === '' || name === 'square') return null;
  const rect = (w, d) => Object.fromEntries([[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sz], id) => [id, { pos: [sx * w / 2, 0, sz * d / 2], yaw: [.3, -.5, 2.4, -2][id] }]));
  const tags = name === 'thin' ? rect(6, 2.5) : name === 'small' ? rect(2, 2) : Number.isFinite(+name) ? randomMap4(+name) : null;
  return tags && { poly: truthLayout(tags).poly, tags };
}
/**
 * Tripod pose that frames a truth layout: ~3.5 m in front of the field centre (+z, the camera side), 1.7 m up, looking
 * down at it; further back when the near edge would not fit the width of a fovY / aspect view.
 */
export function framingPose(layout, { fovY = 55, aspect = 16 / 9 } = {}) {
  const pts = [...layout.poly, ...Object.values(layout.tags).filter(t => t.pos).map(t => [t.pos[0], t.pos[2]])];
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2, hx = (Math.max(...xs) - Math.min(...xs)) / 2;
  const th = Math.tan(fovY * Math.PI / 360) * aspect * .9, d = Math.max(3.5, Math.max(...zs) - cz + (hx + .2) / th);
  return lookAtPose([cx + .2, 1.7 + .12 * (d - 3.5), cz + d], [cx, 0, cz - .2], 1.5); // a little off-centre and rolled, as a real tripod would be
}
const STANDING_POSE = lookAtPose([0.2, 1.75, 3.4], [0, 0.6, 0], 1.5);
// Standing layouts: deliberately not app.js's default slider camera (0, 1.4, 4, pitch -8, fov 50). Placed so today's side
// tags (x = +-2) are seen at <= 60° from their normal and >= 40 px tall at 720p: from z = 4.2 they are ~68° off and too
// thin to decode. Floor layouts (map4 / floor): framingPose of the placeholder layout (3.5 m in front, 1.7 m up).
export const DEFAULT_POSE = Object.values(BASE_TAGS).some(t => t.floor) ? framingPose(truthLayout()) : STANDING_POSE;

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
function makePlayer(color) {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: .8 }), skin = new THREE.MeshStandardMaterial({ color: 0xe0b08a, roughness: .7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d36, roughness: .9 });
  // body frame of world.bodyPose: x forward, y up, z right; origin at the chest
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(.17, .5, 6, 16), mat); torso.position.set(-.18, -.12, 0); body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.12, 20, 14), skin); head.position.set(-.16, .38, 0); body.add(head);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.07, .75, 4, 10), dark); leg.position.set(-.18, -.85, .09 * s); body.add(leg);
  }
  const offArm = new THREE.Mesh(new THREE.CapsuleGeometry(.05, .5, 4, 10), mat); offArm.position.set(-.18, -.15, -.24); body.add(offArm);
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

// Fallback motion when no truth arrives: the two players sidestep around the room's start marks, face each other and swing.

/**
 * createDummyCam({ width, height, fovY, pose, host, players, floorTags })
 *   -> { stream, canvas, truePose, truth, setPose, setTruth, render, showPlayers, stop }
 * pose: world_T_cam (OpenCV cam frame); default DEFAULT_POSE, or framingPose of the room when floorTags is given.
 * truePose = { R, t, fovY }. truth = truthLayout(floorTags): where the room's tags / outline / start marks really are
 * (compare a scan with it). floorTags: { id: { pos, yaw } } truth sheets, e.g. randomMap4(seed).
 * host: optional 'localhost:8000' to read truth itself (app.js already relays truth through setTruth, so leave it off
 * there). render(timeSec) draws one frame now.
 */
export function createDummyCam({ width = 1280, height = 720, fovY = 55, pose = null, host = null, players: showPlayers = true, floorTags = null, externalClock = false } = {}) {
  const room = truthLayout(floorTags), T = room.tags;
  pose ??= floorTags ? framingPose(room, { fovY, aspect: width / height }) : DEFAULT_POSE;
  room.zAmp = Math.min(.5, (Math.max(...room.poly.map(p => p[1])) - Math.min(...room.poly.map(p => p[1]))) * .15);
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
  // tape on the floor along the truth outline (map4: sheet to sheet, stopping short of the paper)
  const tape = new THREE.MeshStandardMaterial({ color: 0xf2d24b, roughness: .6 }), sheetAt = (x, z) => Object.values(T).some(t => t.floor && Math.hypot(t.pos[0] - x, t.pos[2] - z) < .05);
  room.poly.forEach(([ax, az], i) => {
    const [bx, bz] = room.poly[(i + 1) % room.poly.length], L = Math.hypot(bx - ax, bz - az), cut = (sheetAt(ax, az) ? .25 : 0) + (sheetAt(bx, bz) ? .25 : 0);
    const t = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(.05, L - cut), .05), tape);
    t.rotation.set(-Math.PI / 2, 0, -Math.atan2(bz - az, bx - ax)); t.position.set((ax + bx) / 2, .002, (az + bz) / 2); scene.add(t);
  });
  for (const s of ['A', 'B']) { // start marks
    const m = new THREE.Mesh(new THREE.RingGeometry(.12, .16, 24), tape); m.rotation.x = -Math.PI / 2; m.position.set(room.start[s][0], .003, room.start[s][2]); scene.add(m);
  }

  // fixed tags on poles: tag plane exactly at worldTagPose (flip: the sheet is upright, the tag frame turned 180°),
  // board and pole behind it in an upright frame
  const paperMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: .9 });
  for (const id of Object.keys(T).filter(id => T[id].pos)) {
    const tp = truthPose(T[id]), s = T[id].size, g = new THREE.Group(), gu = new THREE.Group();
    const up = tp.R[4] > 0 ? tp : W.pose(W.mul3(tp.R, [-1, 0, 0, 0, -1, 0, 0, 0, 1]), tp.t);
    g.matrixAutoUpdate = gu.matrixAutoUpdate = false; g.matrix.copy(m4(tp)); gu.matrix.copy(m4(up)); scene.add(g, gu);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(s * 10 / 8, s * 10 / 8), new THREE.MeshStandardMaterial({ map: tagTex(id), roughness: .9 }));
    if (T[id].floor) { // a sheet lying on the floor: tag on its paper (caption margin on the tag's -y edge)
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(s * 1.25 + .04, s * 1.25 + .1), paperMat); paper.position.set(0, -.03, .001); paper.receiveShadow = true;
      face.position.z = .002; g.add(paper, face); continue;
    }
    const board = new THREE.Mesh(new THREE.BoxGeometry(s * 1.5, s * 1.5, .012), new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: .9 }));
    board.position.z = -.0065; board.castShadow = true;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, W.CHEST_H + .3, 12), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: .6, roughness: .4 }));
    pole.position.set(0, (.3 - W.CHEST_H) / 2, -.035); pole.castShadow = true;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(.18, .2, .03, 24), new THREE.MeshStandardMaterial({ color: 0x30343a }));
    foot.position.set(0, .015 - W.CHEST_H, -.035);
    g.add(face); gu.add(board, pole, foot);
  }

  const players = { A: makePlayer(0xd2532a), B: makePlayer(0x2f7fd0) };
  for (const p of Object.values(players)) { p.group.traverse(o => { if (o.isMesh) o.castShadow = true; }); p.group.visible = showPlayers; scene.add(p.group); }
  const motion = createDummyMotion(room);
  const setTruth = (slot, k) => motion.setTruth(slot, k);
  let frame = null;

  function render(time = performance.now() / 1000) {
    frame = motion.sample(time);
    for (const s of ['A', 'B']) players[s].set(frame.players[s]);
    renderer.render(scene, camera);
  }

  let raf = 0, ws = null, alive = true;
  const loop = () => { render(); raf = requestAnimationFrame(loop); };
  if (externalClock) render(); else loop();
  if (host) (function connect() {
    if (!alive) return;
    ws = new WebSocket(`ws://${host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'dashboard', id: 'kawashima-dummycam' }));
    ws.onmessage = m => { if (typeof m.data !== 'string') return; const k = JSON.parse(m.data); if (k.type === 'truth') setTruth(k.slot, k); };
    ws.onclose = () => setTimeout(connect, 1000);
  })();

  const stream = canvas.captureStream(30);
  return {
    stream, canvas, render, setTruth, truth: room,
    get frame() { return frame; },
    showPlayers(on) { for (const p of Object.values(players)) p.group.visible = on; }, // off = empty arena, as when calibrating
    truePose, setPose,
    stop() { alive = false; cancelAnimationFrame(raf); ws?.close(); stream.getTracks().forEach(t => t.stop()); renderer.dispose(); },
  };
}
