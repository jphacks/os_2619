// node --test kawashima/test/fieldmap.test.mjs
// Synthetic one-view field scans: random floor-sheet layouts, cameras and focal lengths -> solveFieldMap -> errors.
// Runs under map4 whatever LAYOUT the shell set (the sheet sizes come from that table).
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.LAYOUT = 'map4';
const W = await import('../world.js');
const { solveFieldMap, imageToFloor, floorToImage } = await import('../fieldmap.js');
const { projectWorld } = await import('../extrinsics.js');

const DEG = Math.PI / 180, IMG = [1920, 1080];
let seed = 3;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const uni = (a, b) => a + (b - a) * rand();
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const OBJ = [[-1, 1], [1, 1], [1, -1], [-1, -1]];

// camera at eye looking at target, rolled; returns world_T_cam (cv frame)
function lookAt(eye, target, roll = 0) {
  const z = norm(target.map((v, i) => v - eye[i])), x0 = norm(cross(z, [0, 1, 0])), y0 = cross(z, x0);
  const c = Math.cos(roll), s = Math.sin(roll), x = x0.map((v, i) => c * v + s * y0[i]), y = cross(z, x);
  return W.pose(W.fromCols(x, y, z), eye);
}
const project = (camPose, f, P) => { const p = W.apply(W.invert(camPose), P); return [f * p[0] / p[2] + IMG[0] / 2, f * p[1] / p[2] + IMG[1] / 2, p[2]]; };
const corners = (t, h) => { const c = Math.cos(t.yaw), s = Math.sin(t.yaw); return OBJ.map(([ox, oy]) => [t.pos[0] + h * (ox * c - oy * s), 0, t.pos[2] + h * (-ox * s - oy * c)]); };

/** One synthetic scene; null if some sheet is out of frame or too thin to detect (< minPx). */
function scene({ across = uni(1.5, 7), height = uni(.8, 2.5), back = uni(2, 6), fov = uni(25, 75), noise = .3, minPx = 6, drop = null, eyeOverride, targetOverride } = {}) {
  const depth = across * uni(.5, 1.1), tags = {};
  const corner = [[1, 1], [-1, 1], [-1, -1], [1, -1]]; // ids 0-3 roughly at the corners, shuffled per scene
  const perm = [0, 1, 2, 3].sort(() => rand() - .5);
  perm.forEach((id, k) => {
    const [sx, sz] = corner[k];
    tags[id] = { pos: [sx * across / 2 + uni(-.12, .12) * across, 0, sz * depth / 2 + uni(-.12, .12) * depth], yaw: uni(-Math.PI, Math.PI) };
  });
  const eye = eyeOverride ?? [uni(-.5, .5), height, depth / 2 + back], target = targetOverride ?? [uni(-.3, .3), 0, uni(-.3, .3)];
  const cam = lookAt(eye, target, uni(-3, 3) * DEG), f = IMG[1] / 2 / Math.tan(fov * DEG / 2);
  const dets = [];
  for (const id of [0, 1, 2, 3]) {
    if (id === drop) continue;
    const uv = corners(tags[id], W.TAGS[id].size / 2).map(P => project(cam, f, P));
    if (uv.some(([u, v, d]) => d <= 0 || u < 5 || v < 5 || u > IMG[0] - 5 || v > IMG[1] - 5)) return null;
    const e = k => Math.hypot(uv[k][0] - uv[(k + 1) % 4][0], uv[k][1] - uv[(k + 1) % 4][1]);
    const area = Math.abs(uv.reduce((s, p, k) => s + p[0] * uv[(k + 1) % 4][1] - uv[(k + 1) % 4][0] * p[1], 0)) / 2;
    if (area / Math.max(e(0), e(1), e(2), e(3)) < minPx) return null; // thin side of the quad
    dets.push({ id, corners: uv.map(([u, v]) => [u + noise * gauss(), v + noise * gauss()]) });
  }
  return { tags, cam, f, fov, dets, across, height, back };
}

const need = o => { for (let i = 0; i < 2000; i++) { const s = scene(o); if (s) return s; } throw new Error('no scene fits ' + JSON.stringify(o)); };

// Errors after the best 2-D rigid alignment of the solver's world to the truth's (the output frame is defined from
// the sheets themselves, its convention is checked separately)
function errors(sc, res) {
  const ids = res.ids, P = ids.map(id => res.tags[id].pos), Q = ids.map(id => sc.tags[id].pos);
  const mp = [0, 2].map(a => P.reduce((s, p) => s + p[a], 0) / P.length), mq = [0, 2].map(a => Q.reduce((s, p) => s + p[a], 0) / Q.length);
  let sxx = 0, sxz = 0; // rotation about y taking P to Q
  P.forEach((p, i) => { const a = [p[0] - mp[0], p[2] - mp[1]], b = [Q[i][0] - mq[0], Q[i][2] - mq[1]]; sxx += a[0] * b[0] + a[1] * b[1]; sxz += a[0] * b[1] - a[1] * b[0]; });
  const th = Math.atan2(sxz, sxx), c = Math.cos(th), s = Math.sin(th);
  const map = p => [c * (p[0] - mp[0]) - s * (p[2] - mp[1]) + mq[0], p[1], s * (p[0] - mp[0]) + c * (p[2] - mp[1]) + mq[1]];
  const pos = ids.map((id, i) => { const m = map(P[i]); return Math.hypot(m[0] - Q[i][0], m[2] - Q[i][2]); });
  // a direction at angle a (x, -z) turns by -th in (x, z) rotation terms: yaw_truth = yaw_res - th
  const yaw = ids.map(id => Math.abs(wrap(res.tags[id].yaw - th - sc.tags[id].yaw)));
  const camP = map(res.cam.pose.t), camE = Math.hypot(...camP.map((v, i) => v - sc.cam.t[i]));
  return { pos: Math.max(...pos), yaw: Math.max(...yaw) / DEG, fov: Math.abs(res.fovY - sc.fov), cam: camE };
}

const stats = a => { const s = [...a].sort((x, y) => x - y); return { med: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * .9)], max: s[s.length - 1] }; };

test('random 4-sheet layouts: positions, yaws, focal and camera recovered', () => {
  const E = { pos: [], yaw: [], fov: [], cam: [] }, times = [], rows = []; let tries = 0, fails = 0;
  while (rows.length < 60 && tries++ < 5000) {
    const sc = scene(); if (!sc) continue;
    const t0 = performance.now(), res = solveFieldMap(sc.dets, ...IMG, { fovYGuess: 45 }); times.push(performance.now() - t0);
    if (!res || !res.cam.focalFitted) { fails++; rows.push(null); continue; }
    const e = errors(sc, res); for (const k in E) E[k].push(e[k]);
    rows.push({ ...e, across: sc.across, h: sc.height, back: sc.back, fov0: sc.fov });
  }
  const pr = (k, s, u) => `${k.padEnd(18)} ${s.med.toFixed(2).padStart(7)} ${s.p90.toFixed(2).padStart(7)} ${s.max.toFixed(2).padStart(7)}  ${u}`;
  console.log(`\n${rows.length} scenes (${fails} without a fitted focal), 1920x1080, corner noise 0.3 px`);
  console.log('error'.padEnd(18) + '     med     p90     max');
  const sP = stats(E.pos.map(v => v * 100)), sY = stats(E.yaw), sF = stats(E.fov), sC = stats(E.cam.map(v => v * 100));
  console.log(pr('tag position', sP, 'cm (worst sheet per scene)')); console.log(pr('tag yaw', sY, 'deg (worst sheet)'));
  console.log(pr('vertical fov', sF, 'deg')); console.log(pr('camera position', sC, 'cm'));
  const tm = stats(times); console.log(pr('solve time', tm, 'ms'));
  const worst = rows.filter(Boolean).sort((a, b) => b.pos - a.pos).slice(0, 3);
  for (const w of worst) console.log(`  worst: ${(w.pos * 100).toFixed(1)} cm, fov err ${w.fov.toFixed(2)}° — field ${w.across.toFixed(1)} m, cam h ${w.h.toFixed(1)} m, back ${w.back.toFixed(1)} m, fov ${w.fov0.toFixed(0)}°`);
  assert.ok(fails <= rows.length * .05, `${fails} failures`);
  assert.ok(sP.med < 3, 'median position error < 3 cm');
  assert.ok(sF.med < 1, 'median fov error < 1°');
  assert.ok(sY.med < 2, 'median yaw error < 2°');
  assert.ok(tm.med < 50, 'median solve < 50 ms');
});

test("today's camera (fov 28°, 3 m field, 5 m back) is solved to cm", () => {
  seed = 11;
  const sc = need({ across: 3, height: 1.6, back: 5, fov: 28, minPx: 8 });
  const res = solveFieldMap(sc.dets, ...IMG, { fovYGuess: 45 }), e = errors(sc, res);
  console.log(`today-like: pos ${(e.pos * 100).toFixed(1)} cm, yaw ${e.yaw.toFixed(2)}°, fov ${res.fovY.toFixed(2)}° (true 28), cam ${(e.cam * 100).toFixed(1)} cm, reproj ${res.reprojErrPx.toFixed(2)} px`);
  assert.ok(res.cam.focalFitted && e.pos < .03 && e.fov < 1);
});

test('world-frame convention: centroid origin, A side left in the picture, CCW poly, consistent with world.js', () => {
  seed = 21;
  const sc = need({ across: 4, height: 1.8, back: 3, fov: 50 });
  const res = solveFieldMap(sc.dets, ...IMG);
  const P = res.poly; let a2 = 0, gx = 0, gz = 0;
  P.forEach(([x0, z0], k) => { const [x1, z1] = P[(k + 1) % P.length], cr = x0 * z1 - x1 * z0; a2 += cr; gx += (x0 + x1) * cr; gz += (z0 + z1) * cr; });
  assert.ok(Math.hypot(gx / (3 * a2), gz / (3 * a2)) < 1e-6, 'origin at the outline centroid');
  assert.ok(a2 < 0, 'CCW seen from above (x right, -z up on the page) is negative area in (x, z)');
  for (const id of res.ids) assert.ok(res.poly.some(([x, z]) => Math.hypot(x - res.tags[id].pos[0], z - res.tags[id].pos[2]) < 1e-9));
  const u = id => sc.dets.find(d => d.id === id).corners.reduce((s, c) => s + c[0], 0) / 4;
  const byU = [...res.ids].sort((a, b) => u(a) - u(b));
  const mx = ids => ids.reduce((s, id) => s + res.tags[id].pos[0], 0) / 2;
  assert.ok(mx(byU.slice(0, 2)) < 0 && mx(byU.slice(2)) > 0, 'left sheets at -x');
  assert.ok(res.cam.pose.t[1] > 0, 'camera above the floor (y up)');
  // feed it to world.js: worldTagPose + projectWorld must reproduce the detected corners
  W.setField(res);
  let worst = 0;
  for (const d of sc.dets) {
    const tp = W.worldTagPose(d.id), h = W.TAGS[d.id].size / 2;
    OBJ.forEach(([ox, oy], k) => { const p = projectWorld(res.cam, W.apply(tp, [ox * h, oy * h, 0])); worst = Math.max(worst, Math.hypot(p[0] - d.corners[k][0], p[1] - d.corners[k][1])); });
  }
  assert.ok(worst < 1.5, `world.js reprojection ${worst.toFixed(2)} px`);
  assert.ok(W.START.A.pos[0] < 0 && W.START.B.pos[0] > 0);
});

test('imageToFloor / floorToImage round trip', () => {
  seed = 31;
  const sc = need({ across: 3, fov: 40 });
  const res = solveFieldMap(sc.dets, ...IMG);
  for (const P of [[0, 0, 0], [1.2, 0, -.7], [-.5, 1.3, .4]]) {
    const [u, v, d] = floorToImage(res.cam, P); assert.ok(d > 0);
    const Q = imageToFloor(res.cam, u, v, P[1]); assert.ok(Q && Math.hypot(...Q.map((x, i) => x - P[i])) < 1e-9);
  }
  assert.equal(imageToFloor(res.cam, IMG[0] / 2, -5000, 0), null, 'a ray above the horizon never meets the floor');
});

test('3 sheets: a triangle and a warning; fewer: null', () => {
  seed = 41;
  const E = [];
  for (let n = 0; n < 15; n++) {
    const sc = need({ drop: n % 4 });
    const res = solveFieldMap(sc.dets, ...IMG);
    assert.ok(res && res.poly.length === 3 && res.warnings.some(w => /3 sheets/.test(w)));
    if (res.cam.focalFitted) E.push(errors(sc, res));
  }
  const sP = stats(E.map(e => e.pos * 100)), sF = stats(E.map(e => e.fov));
  console.log(`3 sheets (${E.length}/15 fitted focal): pos med ${sP.med.toFixed(2)} max ${sP.max.toFixed(2)} cm, fov med ${sF.med.toFixed(2)} max ${sF.max.toFixed(2)}°`);
  assert.ok(sP.med < 5);
  const sc = need();
  assert.equal(solveFieldMap(sc.dets.slice(0, 2), ...IMG), null);
});

test('near fronto-parallel view: no garbage (sane positions, focal warning or a fitted focal)', () => {
  seed = 51;
  for (const tilt of [0, 3, 6]) { // camera straight above the field centre, tilted a few degrees
    const sc = need({ across: 1.8, fov: 60, eyeOverride: [0, 3.2, 0], targetOverride: [0, 0, -3.2 * Math.tan(tilt * DEG) - 1e-3] });
    const res = solveFieldMap(sc.dets, ...IMG, { fovYGuess: 45 });
    if (!res) { console.log(`fronto-parallel tilt ${tilt}°: null`); continue; }
    const e = errors(sc, res);
    console.log(`fronto-parallel tilt ${tilt}°: focal ${res.cam.focalFitted ? 'fitted' : 'guessed'} fov ${res.fovY.toFixed(1)}° (true 60), pos ${(e.pos * 100).toFixed(1)} cm, yaw ${e.yaw.toFixed(1)}°, ${res.warnings.join('; ')}`);
    assert.ok(e.pos < .1, 'positions within 10 cm');
    assert.ok(res.cam.focalFitted ? e.fov < 5 : res.warnings.length > 0);
  }
});
