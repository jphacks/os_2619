// LAYOUT=map4 node --test kawashima/test/phonealign.test.mjs
// Synthetic scene built from world.js: two players walk and turn; each phone has its own random gravity-aligned ARCore
// world (yaw + origin) and sends ar (wp/wq), tags (field tags floor OR standing, the other's chest tag), pose, color,
// imu. Checks the alignment (theta, t), chest / yaw error, the chest-tag cross-check, body and tip projection, the IMU
// stick, the old-app fallback and a field change.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../world.js';
import { createPhoneAlign } from '../phonealign.js';

const { pose, compose, invert, apply, mul3, tr3, app3, fromCols, toQuat, fromRodrigues, bodyPose, worldTagPose, chestTagPose, phoneArcamPose, arcam_T_cv, cv_T_arcam, tagScale, PLAYER_TAG, START, STICK } = W;
// the scene is a measured map4 field (setField); under another LAYOUT (the suite runs with LAYOUT=full) these are skipped
const test = (name, fn) => nodeTest(name, { skip: W.LAYOUT !== 'map4' && 'needs LAYOUT=map4' }, fn);

const DEG = Math.PI / 180;
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const rotY = a => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotX = a => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotZ = a => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const col = (R, c) => [R[c], R[3 + c], R[6 + c]];
const r4 = v => Math.round(v * 1e4) / 1e4;
const srt = a => [...a].sort((x, y) => x - y), pc = (a, f) => a.length ? srt(a)[Math.floor(f * (a.length - 1))] : NaN;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const stats = a => ({ n: a.length, mean: +mean(a).toFixed(2), p50: +pc(a, .5).toFixed(2), p95: +pc(a, .95).toFixed(2), max: +Math.max(...a).toFixed(2) });

// ---- synthetic fields (setField shape): four sheets roughly at the corners, random turns ----
const XZ = [[1.6, 1.4], [-1.5, 1.5], [-1.4, -1.6], [1.5, -1.5]];
const floorField = () => ({ poly: XZ, tags: Object.fromEntries(XZ.map(([x, z], id) => [id, { pos: [x, 0, z], yaw: (rand() - .5) * 2 * Math.PI }])) });
// standing: centre 1.0 m up, facing the arena centre (normal = [sin yaw, 0, cos yaw]), turned spin x 90° on the stand
const standField = () => ({ poly: XZ, tags: Object.fromEntries(XZ.map(([x, z], id) => [id, { pos: [x, 1.0, z], yaw: Math.atan2(-x, -z) + (rand() - .5) * 30 * DEG, spin: Math.floor(rand() * 4), stand: true }])) });

// ---- players: small loops, torso turning; A faces +x, B -x on average ----
function truth(slot, t) {
  const s = slot === 'A' ? -1 : 1, w = 2 * Math.PI / 12;
  const pos = [s * 0.9 + 0.5 * Math.cos(w * t + (s > 0 ? 1 : 0)), 0, 0.6 * Math.sin(w * t + (s > 0 ? 1 : 0))];
  const yaw = (slot === 'A' ? 0 : Math.PI) + 50 * DEG * Math.sin(2 * Math.PI * t / 7 + (s > 0 ? 2 : 0));
  return bodyPose(pos, yaw);
}
const yawOf = b => Math.atan2(-b.R[6], b.R[0]);
const PITCH = 12 * DEG; // chest mount looks a little down
const CAM = { w: 480, h: 640, fx: 500, fy: 500, cx: 240, cy: 320 }, K = [CAM.fx / CAM.w, CAM.fy / CAM.h, .5, .5];
const project = c => c[2] > 0.1 ? [(CAM.fx * c[0] / c[2] + CAM.cx) / CAM.w, (CAM.fy * c[1] / c[2] + CAM.cy) / CAM.h] : null;
const inImg = q => q && q[0] >= 0 && q[0] <= 1 && q[1] >= 0 && q[1] <= 1;
/** world_T_cv of slot's chest phone (pitched down). */
const camOf = body => compose(compose(phoneArcamPose(body), arcam_T_cv), pose(rotX(-PITCH)));
/** 33 MediaPipe-ish landmarks of a body in the world (sim.mjs body(), in our frame). */
function landmarks(body) {
  const f = col(body.R, 0), u = col(body.R, 1), r = col(body.R, 2), c = body.t;
  const at = (rr, uu, ff) => [0, 1, 2].map(i => c[i] + r[i] * rr + u[i] * uu + f[i] * ff);
  const lm = Array(33).fill(at(0, .35, .08));
  Object.assign(lm, { 11: at(-.18, .05, 0), 12: at(.18, .05, 0), 13: at(-.22, -.2, .1), 15: at(-.2, -.4, .2), 16: at(STICK.hand.right, STICK.hand.up, STICK.hand.fwd),
    23: at(-.12, -.45, 0), 24: at(.12, -.45, 0), 25: at(-.12, -.9, .05), 26: at(.12, -.9, .05), 27: at(-.12, -1.25, 0), 28: at(.12, -1.25, 0) });
  lm[14] = [0, 1, 2].map(i => (lm[12][i] + lm[16][i]) / 2 - .05 * u[i]);
  for (const [i, j] of [[17, 15], [19, 15], [21, 15], [18, 16], [20, 16], [22, 16], [29, 27], [31, 27], [30, 28], [32, 28]]) lm[i] = lm[j];
  return lm;
}
// IMU: stick orientation in the body frame (azimuth a, elevation e) over the tare pose BODY_R_IMU0
const IMU_M = fromCols(STICK.axis, STICK.up, cross(STICK.axis, STICK.up)), BODY_R_IMU0 = tr3(IMU_M);
const stickBody = t => mul3(mul3(rotY(-0.9 * Math.sin(1.3 * t)), rotZ(0.4 * Math.sin(0.9 * t) + 0.2)), BODY_R_IMU0); // swings ±50° sideways, as sim.mjs

/**
 * Run the scene. opts: field ('floor'|'stand'), dur s, noise 0/1, calibYaw (deg off the START yaw at calibration), oldApp
 * (no wp/wq), tagWindow(t) -> bool field tags visible, hook(P, t).
 */
function run({ field = 'floor', dur = 30, noise = 1, calibOff = 15 * DEG, oldApp = false, tagWindow = () => true, seed: sd = 7, settle = 3, hook } = {}) {
  seed = sd;
  W.setField(field === 'floor' ? floorField() : standField());
  const P = createPhoneAlign();
  // each phone's ARCore world: ar_T_world = rotY(psi) + tau (unknown to the estimator)
  const AR = { A: pose(rotY(rand() * 2 * Math.PI), [2 * gauss(), 1 + gauss(), 2 * gauss()]), B: pose(rotY(rand() * 2 * Math.PI), [2 * gauss(), 1 + gauss(), 2 * gauss()]) };
  const trueT = s => { const Tw = invert(AR[s]); return { th: Math.atan2(Tw.R[2], Tw.R[0]), t: Tw.t }; }; // world_T_ar
  // calibration: standing near the start mark, torso turned calibOff from the START yaw, stick forward and level
  const calibBody = s => bodyPose(START[s].pos, START[s].yaw + (s === 'A' ? calibOff : -calibOff));
  const W0 = { A: mul3(calibBody('A').R, BODY_R_IMU0), B: mul3(calibBody('B').R, BODY_R_IMU0) };
  const E = { A: mk(), B: mk() };
  function mk() { return { th: [], t: [], chest: [], yaw: [], check: [], body: [], tip: [], stick: [], src: {} }; }
  const dt = 1 / 30, T0 = 1000;
  const tagsFrom = (slot, body, t) => {
    const Wcv = camOf(body), cvw = invert(Wcv), other = slot === 'A' ? 'B' : 'A', list = [];
    const ids = [...(tagWindow(t) ? W.CORNER_IDS : []), PLAYER_TAG[other]];
    for (const id of ids) {
      const wt = W.TAGS[id].pos ? worldTagPose(id) : chestTagPose(truth(other, t));
      const c = compose(cvw, wt), p = c.t, d = Math.hypot(...p);
      if (p[2] < 0.3 || d > 5 || !inImg(project(p))) continue;
      const n = col(c.R, 2); if (-(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / d < Math.cos(70 * DEG)) continue; // too oblique
      const R = noise ? mul3(fromRodrigues([0, 1, 2].map(() => 0.5 * DEG * d * gauss())), c.R) : c.R; // ~0.5°/m
      const pn = p.map(v => v + (noise ? 0.004 * d * gauss() : 0));
      list.push({ id, p: pn.map(v => r4(v / tagScale(id))), r: W.toRodrigues(R).map(r4) });
    }
    return list;
  };
  for (let i = 0; i * dt < dur; i++) {
    const t = T0 + i * dt, ts = i * dt;
    for (const slot of ['A', 'B']) {
      const other = slot === 'A' ? 'B' : 'A';
      const body = i === 0 ? calibBody(slot) : truth(slot, ts), Wcv = camOf(body);
      const Warcam = compose(Wcv, cv_T_arcam), arT = compose(AR[slot], Warcam), q = toQuat(arT.R);
      const jit = () => (noise ? 0.002 * gauss() : 0), wp = arT.t.map(v => r4(v + jit())), wq = [q[1], q[2], q[3], q[0]].map(r4);
      const calibRel = compose(invert(compose(AR[slot], compose(camOf(calibBody(slot)), cv_T_arcam))), arT), qc = toQuat(calibRel.R); // old app: p/q since calibration
      P.ingest(oldApp ? { type: 'ar', slot, t, tracking: 'TRACKING', p: calibRel.t.map(r4), q: [qc[1], qc[2], qc[3], qc[0]].map(r4) }
        : { type: 'ar', slot, t, tracking: 'TRACKING', p: calibRel.t.map(r4), q: [qc[1], qc[2], qc[3], qc[0]].map(r4), wp, wq });
      // IMU: body_R_imu over the tare at calibration
      const Rimu = mul3(body.R, i === 0 ? BODY_R_IMU0 : stickBody(ts)), qi = toQuat(mul3(tr3(W0[slot]), Rimu));
      P.ingest({ type: 'imu', slot, t, q: qi, gyro: [0, 0, 0], acc: [0, 0, 0] });
      if (i === 0) { P.ingest({ type: 'calib', slot, t }); continue; }
      if (i % 2) continue; // detectors at 15 Hz
      P.ingest({ type: 'tags', slot, t, k: K, tags: tagsFrom(slot, body, ts) });
      // the opponent's body and stick tip as this phone sees them
      const ob = truth(other, ts), lm = landmarks(ob), cvw = invert(Wcv);
      const cl = lm.map(p => apply(cvw, p)), hip = (cl[23][2] + cl[24][2]) / 2;
      P.ingest({ type: 'pose', slot, t, found: true, lm: cl.map(c => { const uv = project(c); return uv ? [uv[0] + (noise ? .003 * gauss() : 0), uv[1] + (noise ? .003 * gauss() : 0), (c[2] - hip) * K[0] / hip + (noise ? .01 * gauss() : 0), inImg(uv) ? .9 : .1] : [0, 0, 0, 0]; }) });
      const dirO = app3(mul3(ob.R, stickBody(ts)), STICK.axis), tipO = lm[16].map((v, k) => v + STICK.len * dirO[k]), tp = project(apply(cvw, tipO));
      P.ingest(inImg(tp) ? { type: 'color', slot, t, side: 'opp', found: true, x: tp[0] + (noise ? .003 * gauss() : 0), y: tp[1] + (noise ? .003 * gauss() : 0) } : { type: 'color', slot, t, side: 'opp', found: false });
      hook?.(P, ts, slot);
    }
    if (i % 2 || i === 0) continue;
    const est = P.estimate(T0 + ts);
    for (const slot of ['A', 'B']) {
      const g = est.slots[slot], e = E[slot], body = truth(slot, ts), other = slot === 'A' ? 'B' : 'A';
      e.src[g.src] = (e.src[g.src] ?? 0) + 1;
      if (!g.aligned || ts < settle) continue;
      const tt = trueT(slot);
      if (g.theta != null) { e.th.push(Math.abs(wrap(g.theta - tt.th)) / DEG); e.t.push(dist(g.t, tt.t) * 100); }
      e.chest.push(dist(g.chest, body.t) * 100);
      e.yaw.push(Math.abs(wrap(g.yaw - yawOf(body))) / DEG);
      if (g.check != null && Math.abs(g.checkT - (T0 + ts)) < .01) e.check.push(g.check);
      const b = est.bodies[slot], lm = landmarks(body);
      if (b) { const errs = b.map((p, k) => p && dist(p, lm[k]) * 100).filter(v => v != null); if (errs.length) e.body.push(pc(errs, .5)); }
      const tip = est.tips[slot];
      if (tip && Math.abs(tip.t - (T0 + ts)) < .01) { const d = app3(mul3(body.R, stickBody(ts)), STICK.axis); e.tip.push(dist(tip.p, lm[16].map((v, k) => v + STICK.len * d[k])) * 100); }
      const sk = est.stick[slot];
      if (sk) { const d = app3(mul3(body.R, stickBody(ts)), STICK.axis); e.stick.push(Math.acos(Math.min(1, d[0] * sk.dir[0] + d[1] * sk.dir[1] + d[2] * sk.dir[2])) / DEG); e.stickSrc = sk.src; }
    }
  }
  return { P, E, trueT };
}
const report = (name, E) => { for (const s of ['A', 'B']) { const e = E[s];
  console.log(`${name} ${s}: theta deg ${JSON.stringify(stats(e.th))} t cm ${JSON.stringify(stats(e.t))}\n   chest cm ${JSON.stringify(stats(e.chest))} yaw deg ${JSON.stringify(stats(e.yaw))}\n   check cm ${JSON.stringify(stats(e.check))} body cm(p50/frame) ${JSON.stringify(stats(e.body))} tip cm ${JSON.stringify(stats(e.tip))} stick deg ${JSON.stringify(stats(e.stick))} ${e.stickSrc} src ${JSON.stringify(e.src)}`); } };

test('floor tags: alignment, chest, cross-check, body, tip, IMU stick', () => {
  const { E } = run({ field: 'floor' });
  report('floor', E);
  for (const s of ['A', 'B']) {
    const e = E[s];
    assert.ok(e.th.length > 100, `${s} aligned most of the run (${e.th.length})`);
    assert.ok(pc(e.th, .95) < 1.5 && pc(e.t, .95) < 5, `${s} alignment theta p95 ${pc(e.th, .95)} deg, t p95 ${pc(e.t, .95)} cm`);
    assert.ok(pc(e.chest, .95) < 5 && mean(e.chest) < 3, `${s} chest p95 ${pc(e.chest, .95)} cm`);
    assert.ok(pc(e.yaw, .95) < 2, `${s} yaw p95 ${pc(e.yaw, .95)} deg`);
    assert.ok(e.check.length > 50 && pc(e.check, .95) < 8, `${s} check n ${e.check.length} p95 ${pc(e.check, .95)} cm`);
    assert.ok(e.body.length > 50 && pc(e.body, .95) < 15, `${s} body n ${e.body.length} p95 ${pc(e.body, .95)} cm`);
    assert.ok(e.tip.length > 30 && pc(e.tip, .5) < 10, `${s} tip n ${e.tip.length} p50 ${pc(e.tip, .5)} cm`);
    assert.ok(pc(e.stick, .95) < 1 && e.stickSrc === 'calib-ar', `${s} stick p95 ${pc(e.stick, .95)} deg (${e.stickSrc})`);
  }
});

test('standing tags (turned on their stands): same accuracy', () => {
  const { E } = run({ field: 'stand', seed: 11 });
  report('stand', E);
  for (const s of ['A', 'B']) {
    const e = E[s];
    assert.ok(e.th.length > 100, `${s} aligned most of the run (${e.th.length})`);
    assert.ok(pc(e.th, .95) < 1.5 && pc(e.t, .95) < 5, `${s} alignment theta p95 ${pc(e.th, .95)} deg, t p95 ${pc(e.t, .95)} cm`);
    assert.ok(pc(e.chest, .95) < 5, `${s} chest p95 ${pc(e.chest, .95)} cm`);
    assert.ok(pc(e.yaw, .95) < 2, `${s} yaw p95 ${pc(e.yaw, .95)} deg`);
    assert.ok(e.check.length > 50 && pc(e.check, .95) < 8, `${s} check p95 ${pc(e.check, .95)} cm`);
  }
});

test('noise-free: exact to rounding', () => {
  const { E } = run({ field: 'stand', noise: 0, seed: 3, dur: 12 });
  for (const s of ['A', 'B']) assert.ok(Math.max(...E[s].chest) < 0.3 && Math.max(...E[s].th) < 0.1, `${s} chest ${Math.max(...E[s].chest)} cm theta ${Math.max(...E[s].th)}`);
});

test('tags only early on: alignment keeps placing the phone from AR alone', () => {
  const { E } = run({ field: 'floor', dur: 25, tagWindow: t => t < 6, seed: 5 });
  for (const s of ['A', 'B']) assert.ok(E[s].chest.length > 200 && pc(E[s].chest, .95) < 6, `${s} n ${E[s].chest.length} p95 ${pc(E[s].chest, .95)}`);
});

test('old app (no wp/wq): falls back to localize.js, src "localize"', () => {
  const { E } = run({ field: 'floor', oldApp: true, dur: 15, seed: 2 });
  for (const s of ['A', 'B']) {
    assert.ok(E[s].src.localize > 50 && !E[s].src.ar, `${s} src ${JSON.stringify(E[s].src)}`);
    assert.ok(pc(E[s].chest, .95) < 8, `${s} chest p95 ${pc(E[s].chest, .95)} cm`);
  }
});

test('onFieldChange: the stored sightings are refitted onto the new tag poses', () => {
  const { P, E, trueT } = run({ field: 'floor', dur: 8, seed: 9 });
  const before = P.get('A', 1000 + 8);
  assert.ok(before.aligned && E.A.chest.length);
  // the whole field moves 1 m along +x and turns 10°: the phone must follow without new sightings
  const f = { poly: W.FIELD.poly.map(([x, z]) => [x + 1, z]), tags: {} };
  for (const id of W.CORNER_IDS) f.tags[id] = { pos: [W.TAGS[id].pos[0] + 1, 0, W.TAGS[id].pos[2]], yaw: W.TAGS[id].yaw };
  W.setField(f); // phonealign subscribes to world.onFieldChange
  const after = P.get('A', 1000 + 8);
  assert.ok(Math.abs(after.chest[0] - before.chest[0] - 1) < 0.05 && Math.abs(after.chest[2] - before.chest[2]) < 0.05, `moved ${after.chest} vs ${before.chest}`);
  P.onFieldChange(); assert.ok(P.get('A').aligned);
});

test('one sighting pins theta (axis point), aligned only from 3', () => {
  W.setField(floorField());
  const P = createPhoneAlign(), body = bodyPose([-0.9, 0, 0], 0.6), Wcv = camOf(body), arT = compose(Wcv, cv_T_arcam), q = toQuat(arT.R);
  P.ingest({ type: 'ar', slot: 'A', t: 1, tracking: 'TRACKING', wp: arT.t, wq: [q[1], q[2], q[3], q[0]] }); // AR world = FIELD world: theta 0, t 0
  const ids = W.CORNER_IDS.map(id => ({ id, c: compose(invert(Wcv), worldTagPose(id)) })).filter(({ c }) => c.t[2] > 0.3 && inImg(project(c.t)));
  assert.ok(ids.length, 'a tag in view');
  const g1 = ids[0];
  P.ingest({ type: 'tags', slot: 'A', t: 1, k: K, tags: [{ id: g1.id, p: g1.c.t.map(v => v / tagScale(g1.id)), r: W.toRodrigues(g1.c.R) }] });
  let g = P.get('A', 1);
  assert.ok(!g.aligned && g.n === 1 && Math.abs(g.theta) < 1e-6 && dist(g.t, [0, 0, 0]) < 1e-6 && dist(g.chest, body.t) < 1e-6, `one sighting: theta ${g.theta} t ${g.t}`);
  for (const t of [1.1, 1.2]) {
    P.ingest({ type: 'ar', slot: 'A', t, tracking: 'TRACKING', wp: arT.t, wq: [q[1], q[2], q[3], q[0]] });
    P.ingest({ type: 'tags', slot: 'A', t, k: K, tags: [{ id: g1.id, p: g1.c.t.map(v => v / tagScale(g1.id)), r: W.toRodrigues(g1.c.R) }] });
  }
  g = P.get('A', 1.2);
  assert.ok(g.aligned && g.n === 3 && g.src === 'ar', 'aligned after 3');
  assert.ok(g.sightings.length === 1 && dist(g.sightings[0].p, worldTagPose(g1.id).t) < 1e-6, 'sighting mapped to the tag');
});
