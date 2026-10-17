// Physically consistent fake phones: one shared sim of the arena, each phone sends what a real chest phone would see.
// Run: node kawashima/fake-world.mjs [host=localhost:8000] [--drift [scale]] [--noise scale] [--seed n]
// Extra debug stream (real phones don't send it): {type:'truth', chest, yaw, base, tip, dir, swinging}.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  START, STICK, TAGS, CORNER_IDS, PLAYER_TAG, tagScale, mul3, tr3, app3, pose, compose, invert, apply,
  fromCols, fromQuat, toQuat, fromRodrigues, toRodrigues, bodyPose, worldTagPose, phoneArcamPose, arcam_T_cv,
} from './world.js';

export const DT = 0.01;            // sim tick, s (100 Hz)
export const CAM = { w: 480, h: 640, fx: 500, fy: 500, cx: 240, cy: 320 }; // portrait chest camera
const HOLD = 2, RAMP = 3;          // stand still at START (calibration), then blend motion in
const LIM = 1.7, G = 9.81, D2R = Math.PI / 180;

// ---- small helpers ----
const mulberry32 = s => () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const smooth = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
const ease = u => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2; // peak slope pi/2
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const qmul = ([a, b, c, d], [e, f, g, h]) => [a * e - b * f - c * g - d * h, a * f + b * e + c * h - d * g, a * g - b * h + c * e + d * f, a * h + b * g - c * f + d * e];
const qaxis = (ax, ang) => [Math.cos(ang / 2), ...ax.map(v => v * Math.sin(ang / 2))];
const qslerp = (a, b, u) => {
  let d = a.reduce((s, v, i) => s + v * b[i], 0);
  if (d < 0) { b = b.map(v => -v); d = -d; }
  if (d > 0.9995) { const q = a.map((v, i) => v + (b[i] - v) * u), n = Math.hypot(...q); return q.map(v => v / n); }
  const th = Math.acos(d), s = Math.sin(th), ka = Math.sin((1 - u) * th) / s, kb = Math.sin(u * th) / s;
  return a.map((v, i) => ka * v + kb * b[i]);
};
const qangle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((s, v, i) => s + v * b[i], 0))));
/** Rotation vector via the quaternion: world.js toRodrigues loses the axis near 180 deg, where a facing tag sits. */
const rodrigues = R => { const [w, ...v] = toQuat(R), s = Math.hypot(...v); return s < 1e-12 ? [0, 0, 0] : v.map(x => x * 2 * Math.atan2(s, w) / s); };
const r3 = v => Math.round(v * 1e4) / 1e4, r6 = v => Math.round(v * 1e6) / 1e6;

// IMU frame from STICK: columns = stick axis, up, axis x up (in IMU coords)
const IMU_M = fromCols(STICK.axis, STICK.up, cross(STICK.axis, STICK.up));
const BODY_R_IMU0 = tr3(IMU_M);    // body_R_imu when held forward and level (body: x fwd, y up, z right)
const Q_B0 = toQuat(BODY_R_IMU0);
/** Stick orientation in the body frame: azimuth a (+ = right), elevation e (+ = up), roll about the stick. */
const qStick = (a, e, roll) => qmul(qaxis([0, 1, 0], -a), qmul(qaxis([0, 0, 1], e), qmul(qaxis([1, 0, 0], roll), Q_B0)));
/** world_R_imu at calibration: standing at START, stick forward and level. */
export const calibImu = slot => mul3(bodyPose(START[slot].pos, START[slot].yaw).R, BODY_R_IMU0);

export function createSim({ seed = 1, drift = 0, noise = 1 } = {}) {
  const rnd = mulberry32(seed), U = (a, b) => a + (b - a) * rnd();
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const ph = () => U(0, 2 * Math.PI);
  const F = { c: [ph(), ph(), ph(), ph()], d: [ph(), ph()], th: [ph(), ph(), ph()] }; // shared motion phases
  const players = {};
  for (const slot of ['A', 'B']) {
    const origin = phoneArcamPose(bodyPose(START[slot].pos, START[slot].yaw));
    const upCal = app3(tr3(origin.R), [0, 1, 0]), dh = U(0, 2 * Math.PI);
    players[slot] = {
      slot, opp: slot === 'A' ? 'B' : 'A', origin, W0: calibImu(slot),
      ph: Array.from({ length: 10 }, ph), nextSwing: HOLD + RAMP + U(0.5, 3), swing: null,
      drift: { up: upCal, v: app3(tr3(origin.R), [Math.cos(dh), 0, Math.sin(dh)]) }, // drift direction in calib frame
      hist: [],
    };
  }
  let t = 0, n = 0;

  function positions(t) {
    const tau = Math.max(0, t - HOLD), A = smooth(tau / RAMP), s = Math.sin;
    const c = [A * (0.25 * s(0.13 * tau + F.c[0]) - 0.25 * s(F.c[0])), A * (0.25 * s(0.11 * tau + F.c[1]) - 0.25 * s(F.c[1]))];
    const d = 2.4 + A * (-0.4 + 0.6 * s(0.29 * tau + F.d[0]) + 0.35 * s(0.83 * tau + F.d[1]));
    const th = A * (1.3 * s(0.07 * tau + F.th[0]) + 0.8 * s(0.17 * tau + F.th[1]) + 0.3 * s(0.4 * tau + F.th[2]));
    const u = [Math.cos(th), -Math.sin(th)], perp = [-u[1], u[0]]; // A -> B direction in (x, z), and sideways
    const out = {};
    for (const [slot, sg] of [['A', -1], ['B', 1]]) {
      const P = players[slot].ph, strafe = A * 0.15 * s(0.6 * tau + P[0]), fwd = A * 0.1 * s(0.45 * tau + P[1]);
      let x = c[0] + sg * (d / 2 - fwd) * u[0] + strafe * perp[0], z = c[1] + sg * (d / 2 - fwd) * u[1] + strafe * perp[1];
      out[slot] = [Math.max(-LIM, Math.min(LIM, x)), 0, Math.max(-LIM, Math.min(LIM, z))];
    }
    return { out, A, tau };
  }

  function stickBody(p, t, A, tau) { // stick orientation in the body frame (quaternion) and swinging flag
    const P = p.ph, s = Math.sin;
    const idle = qStick(A * (0.12 * s(1.1 * tau + P[2]) + 0.05 * s(2.3 * tau + P[3])),
      A * (0.08 + 0.1 * s(0.9 * tau + P[4])), A * 0.15 * s(0.7 * tau + P[5]));
    if (!p.swing && t >= p.nextSwing) {
      const a0 = U(-0.6, 0.6), r0 = U(-0.5, 0.5);
      const Q0 = qStick(a0, U(0.9, 1.3), r0), Q1 = qStick(-0.8 * a0 + U(-0.3, 0.3), U(-0.6, -0.2), r0 + U(-0.8, 0.8));
      const peak = U(600, 1200) * D2R, Ts = qangle(Q0, Q1) * Math.PI / 2 / peak;
      p.swing = { t0: t, Tw: U(0.25, 0.4), Ts, Tr: U(0.4, 0.6), Q0, Q1 };
    }
    const w = p.swing;
    if (!w) return { q: idle, swinging: false };
    const u = t - w.t0;
    if (u < w.Tw) return { q: qslerp(idle, w.Q0, ease(u / w.Tw)), swinging: false };
    if (u < w.Tw + w.Ts) return { q: qslerp(w.Q0, w.Q1, ease((u - w.Tw) / w.Ts)), swinging: true };
    if (u < w.Tw + w.Ts + w.Tr) return { q: qslerp(w.Q1, idle, ease((u - w.Tw - w.Ts) / w.Tr)), swinging: false };
    p.swing = null; p.nextSwing = t + U(1.5, 4);
    return { q: idle, swinging: false };
  }

  function step() {
    t = n++ * DT;
    const { out, A, tau } = positions(t);
    for (const p of Object.values(players)) {
      const me = out[p.slot], op = out[p.opp], v = [op[0] - me[0], op[2] - me[2]];
      const look = A * (0.17 * Math.sin(0.5 * tau + p.ph[6]) + 0.07 * Math.sin(1.7 * tau + p.ph[7]) + 0.8 * Math.sin(0.11 * tau + p.ph[8]) ** 3);
      p.pos = me;
      p.yaw = Math.atan2(-v[1], v[0]) + look;
      if (t === 0) p.yaw = START[p.slot].yaw; // exact calibration pose
      p.body = bodyPose(p.pos, p.yaw);
      const sb = stickBody(p, t, A, tau);
      p.swinging = sb.swinging;
      const Rimu = mul3(p.body.R, fromQuat(sb.q));
      p.dir = app3(Rimu, STICK.axis);
      p.base = apply(p.body, [STICK.hand.fwd, STICK.hand.up, STICK.hand.right]);
      const imuPos = p.base.map((b, i) => b + 0.2 * p.dir[i]); // sensor sits 20 cm up the stick
      p.hist.push({ R: Rimu, x: imuPos }); if (p.hist.length > 3) p.hist.shift();
      const h = p.hist, k = h.length - 1;
      p.Rimu = Rimu;
      p.gyro = k ? toRodrigues(mul3(tr3(h[k - 1].R), Rimu)).map(w => w / DT / D2R) : [0, 0, 0];
      const a = k > 1 ? [0, 1, 2].map(i => (h[k].x[i] - 2 * h[k - 1].x[i] + h[k - 2].x[i]) / DT / DT) : [0, 0, 0];
      p.acc = app3(tr3(Rimu), [a[0], a[1] + G, a[2]]).map(v => Math.max(-156, Math.min(156, v)));
    }
    return t;
  }

  // ---- what each phone sends ----
  function imu(slot) {
    const p = players[slot], R = mul3(tr3(p.W0), p.Rimu), q = toQuat(R);
    const euler = [Math.atan2(R[7], R[8]), Math.asin(Math.max(-1, Math.min(1, -R[6]))), Math.atan2(R[3], R[0])].map(v => r3(v / D2R));
    return {
      type: 'imu', euler, acc: p.acc.map(v => r3(v + 0.05 * noise * gauss())), gyro: p.gyro.map(v => r3(v + 0.3 * noise * gauss())),
      q: (q[0] < 0 ? q.map(v => -v) : q).map(r6),
    };
  }
  function ar(slot) {
    const p = players[slot];
    let est = compose(invert(p.origin), phoneArcamPose(p.body)); // calib_T_arcam
    if (drift) {
      const D = pose(fromRodrigues(p.drift.up.map(v => v * drift * 0.5 * D2R * t)), p.drift.v.map(v => v * drift * 0.01 * t));
      est = compose(D, est);
    }
    const [w, x, y, z] = toQuat(est.R);
    return { type: 'ar', tracking: 'TRACKING', reason: 'NONE', p: est.t.map(r3), q: [x, y, z, w].map(r6), planes: 2 };
  }
  const project = c => [(CAM.fx * c[0] / c[2] + CAM.cx) / CAM.w, (CAM.fy * c[1] / c[2] + CAM.cy) / CAM.h];
  function tags(slot) {
    const p = players[slot], o = players[p.opp];
    const cv_T_world = invert(compose(phoneArcamPose(p.body), arcam_T_cv)), list = [];
    for (const id of [...CORNER_IDS, PLAYER_TAG[o.slot]]) {
      const cT = compose(cv_T_world, worldTagPose(id, o.body)), c = cT.t, dist = Math.hypot(...c);
      if (c[2] < 0.2 || dist > 6) continue;
      const [u, v] = project(c);
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      if (cT.R[2] * -c[0] + cT.R[5] * -c[1] + cT.R[8] * -c[2] <= 0) continue; // tag +z must point at the camera
      const h = TAGS[id].size / 2;
      const corners = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => project(apply(cT, [x, y, 0]))
        .map((q, i) => r3(q + 0.5 * noise * gauss() / (i ? CAM.h : CAM.w))));
      const tn = c.map(x => x + 0.01 * noise * gauss());
      const Rn = noise ? mul3(cT.R, fromRodrigues([gauss(), gauss(), gauss()].map(x => x * 0.5 * D2R * noise / Math.sqrt(3)))) : cT.R;
      list.push({ id, c: corners, p: tn.map(x => r3(x / tagScale(id))), r: rodrigues(Rn).map(r6) });
    }
    return { type: 'tags', tags: list };
  }
  function truth(slot) {
    const p = players[slot];
    return {
      type: 'truth', chest: p.body.t.map(r3), yaw: r3(p.yaw), base: p.base.map(r3),
      tip: p.base.map((b, i) => r3(b + p.dir[i] * STICK.len)), dir: p.dir.map(r3), swinging: p.swinging,
    };
  }
  return { players, step, imu, ar, tags, truth, get t() { return t; }, get n() { return n; } };
}

/** Messages due at tick n (100 Hz): imu every tick, ar + truth at 30 Hz, tags at 15 Hz. */
export function due(n) {
  const at = hz => Math.floor(n * DT * hz) !== Math.floor((n - 1) * DT * hz) || n === 0;
  return { ar: at(30), truth: at(30), tags: at(15) };
}

// ---- live ----
function main() {
  const args = process.argv.slice(2), flag = (k, dflt) => {
    const i = args.indexOf(k); if (i < 0) return undefined;
    const v = +args[i + 1]; if (Number.isFinite(v)) { args.splice(i, 2); return v; } args.splice(i, 1); return dflt;
  };
  const drift = flag('--drift', 1) ?? 0, noise = flag('--noise', 1) ?? 1, seed = flag('--seed', 1) ?? (Date.now() & 0xffff);
  const host = args[0] ?? 'localhost:8000';
  const WebSocket = createRequire(new URL('../sensing/dashboard/package.json', import.meta.url))('ws');
  const sim = createSim({ seed, drift, noise });
  const phones = { A: { ws: null, ok: false }, B: { ws: null, ok: false } };
  let t0 = null; // wall clock of sim t = 0; set once both phones are welcomed (they calibrate at START)
  console.log(`fake-world -> ws://${host}/ws  drift ${drift}  noise ${noise}  seed ${seed}`);

  function connect(slot) {
    const ph = phones[slot], ws = ph.ws = new WebSocket(`ws://${host}/ws`);
    const send = k => ws.readyState === 1 && ws.send(JSON.stringify(k));
    let ping;
    ws.on('open', () => {
      send({ type: 'hello', role: 'phone', id: `fake-world-${slot}`, name: `Fake world ${slot}` });
      ping = setInterval(() => send({ type: 'ping', t0: Date.now() / 1000 }), 1000);
    });
    ws.on('message', data => {
      let k; try { k = JSON.parse(data); } catch { return; }
      if (k.type === 'full') console.log(`${slot}: server full`);
      if (k.type !== 'welcome') return;
      if (k.slot !== slot) console.log(`${slot}: warning, server gave slot ${k.slot} (another phone connected first?)`);
      console.log(`${slot}: welcome, slot ${k.slot}`);
      ph.ok = true; ph.send = send;
      if (slot === 'A' && !phones.B.ws) connect('B');
      if (t0 === null && phones.A.ok && phones.B.ok) { // both standing at START: calibrate, then start moving
        t0 = Date.now() / 1000;
        for (const p of Object.values(phones)) p.send({ t: t0, type: 'calib' });
      }
    });
    ws.on('close', () => {
      clearInterval(ping); ph.ok = false;
      setTimeout(function retry() { slot === 'B' && !phones.A.ok ? setTimeout(retry, 500) : connect(slot); }, 1000); // B waits for A: keeps slots deterministic
    });
    ws.on('error', () => {});
  }
  connect('A');

  setInterval(() => {
    if (t0 === null) return;
    const now = Date.now() / 1000;
    while (sim.n * DT <= now - t0) {
      const n = sim.n, t = sim.step(), when = due(n), stamp = r3(t0 + t);
      for (const slot of ['A', 'B']) {
        const s = phones[slot].ok && phones[slot].send; if (!s) continue;
        s({ t: stamp, ...sim.imu(slot) });
        if (when.ar) s({ t: stamp, ...sim.ar(slot) });
        if (when.truth) s({ t: stamp, ...sim.truth(slot) });
        if (when.tags) s({ t: stamp, ...sim.tags(slot) });
      }
    }
  }, 10);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
