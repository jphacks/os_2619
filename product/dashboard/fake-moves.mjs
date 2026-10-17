// Scripted fake phones: both players stand still at their START marks and A works through a fixed list of stick moves
// (swings without charging, charges of three lengths, a too-slow circle), so the sensing detectors (actions.js) and the
// game rules can be watched one move at a time. B stands still with the stick held low in front.
// Run: node fake-moves.mjs [host=localhost:8000] [--once]      (then 試合開始 on the dashboard; the list repeats)
// Uses fake-world.mjs's simulator for everything a phone sends (AR pose, tags, IMU packet format) and only overrides
// where the players stand and how the sticks move, so fake-world.mjs itself is untouched.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSim, DT, due } from './fake-world.mjs';
import { START, STICK, bodyPose, mul3, tr3, app3, apply, fromCols, toQuat, fromQuat, toRodrigues } from './public/world.js';

const D = Math.PI / 180, G = 9.81;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const qmul = ([a, b, c, d], [e, f, g, h]) => [a * e - b * f - c * g - d * h, a * f + b * e + c * h - d * g, a * g - b * h + c * e + d * f, a * h + b * g - c * f + d * e];
const qaxis = (ax, ang) => [Math.cos(ang / 2), ...ax.map(v => v * Math.sin(ang / 2))];
const Q_B0 = toQuat(tr3(fromCols(STICK.axis, STICK.up, cross(STICK.axis, STICK.up)))); // as fake-world.mjs
/** Stick in the body frame: azimuth a (+ = right), elevation e (+ = up), degrees. Same convention as fake-world.mjs. */
const qStick = (a, e) => qmul(qaxis([0, 1, 0], -a * D), qmul(qaxis([0, 0, 1], e * D), Q_B0));
const ease = u => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;

// ---- the script (A). Each step: seconds, a function u -> { a, e } (u 0..1 over the step), and what to say ----
const IDLE = { a: 0, e: 25 }; // stick in front, raised a little (level and still for 1 s would read as the sensing team's Guard)
const hold = (sec, p) => ({ sec, at: () => p });
const move = (sec, p0, p1) => ({ sec, at: u => ({ a: p0.a + (p1.a - p0.a) * ease(u), e: p0.e + (p1.e - p0.e) * ease(u) }) });
const circle = (sec, turns, e = 70) => ({ sec, at: u => ({ a: 360 * turns * u, e }) }); // upright cone: the tip circles
const UP = { a: 0, e: 70 }, FWD_LOW = { a: 0, e: -10 }, LEFT = { a: -80, e: 5 }, RIGHT = { a: 15, e: 5 };
const swingDown = [move(.6, IDLE, UP), hold(.4, UP), move(.12, UP, FWD_LOW), hold(.8, FWD_LOW), move(.6, FWD_LOW, IDLE)];
/** charge: raise, circle `turns` turns at 1.5 s a turn (the detector needs one full turn within 2 s), still 0.3 s, swing down */
const charged = turns => [move(.6, IDLE, UP), circle(1.5 * turns, turns), hold(.3, UP), move(.12, UP, FWD_LOW), hold(.8, FWD_LOW), move(.6, FWD_LOW, IDLE)];
const SCRIPT = [
  { say: '構えて待つ', steps: [hold(3, IDLE)] },
  { say: '溜めなしで振り下ろす（上から前へ、0.12 秒）', steps: swingDown },
  { say: '溜めなしで横に払う（左から正面の少し右へ）', steps: [move(.6, IDLE, LEFT), hold(.4, LEFT), move(.12, LEFT, RIGHT), hold(.8, RIGHT), move(.25, RIGHT, IDLE)] },
  { say: '溜め 小：1周回して（1.5 秒）すぐ振る → 溜め時間 約 0.4 秒', steps: charged(1) },
  { say: '溜め 中：3周回して（4.5 秒）振る → 溜め時間 約 3.4 秒', steps: charged(3) },
  { say: '溜め 大：5周回して（7.5 秒）振る → 溜め時間 約 6.4 秒', steps: charged(5) },
  { say: 'ゆっくり回す（1周 3 秒）：溜めにならないはず。そのあと振る', steps: [move(.6, IDLE, UP), circle(3, 1), hold(.3, UP), move(.12, UP, FWD_LOW), hold(.8, FWD_LOW), move(.6, FWD_LOW, IDLE)] },
  { say: '構えて待つ（次の周へ）', steps: [hold(2, IDLE)] },
];
const flat = SCRIPT.flatMap((s, i) => s.steps.map((st, j) => ({ ...st, say: j === 0 ? s.say : null, n: i })));
export const LEN = flat.reduce((s, x) => s + x.sec, 0);
export function stickAt(t) { // A's stick at script time t (looped); also returns the line to announce when a move starts
  let u = ((t % LEN) + LEN) % LEN;
  for (const st of flat) { if (u < st.sec) return { ...st.at(u / st.sec), step: st }; u -= st.sec; }
  return { ...IDLE, step: null };
}

// ---- override the simulator's players after each step ----
export const HOLD = 2; // fake-world stands still at START for its first 2 s (calibration); the script starts after that
export function pin(sim, t) {
  for (const p of Object.values(sim.players)) {
    p.pos = START[p.slot].pos.slice(); p.yaw = START[p.slot].yaw;
    p.body = bodyPose(p.pos, p.yaw);
    const s = p.slot === 'A' && t > HOLD ? stickAt(t - HOLD) : IDLE;
    const Rimu = mul3(p.body.R, fromQuat(qStick(s.a, s.e)));
    p.dir = app3(Rimu, STICK.axis);
    p.base = apply(p.body, [STICK.hand.fwd, STICK.hand.up, STICK.hand.right]);
    const imuPos = p.base.map((b, i) => b + 0.2 * p.dir[i]);
    (p.mh ??= []).push({ R: Rimu, x: imuPos }); if (p.mh.length > 3) p.mh.shift();
    const h = p.mh, k = h.length - 1;
    p.Rimu = Rimu;
    p.gyro = k ? toRodrigues(mul3(tr3(h[k - 1].R), Rimu)).map(w => w / DT / D) : [0, 0, 0];
    const acc = k > 1 ? [0, 1, 2].map(i => (h[k].x[i] - 2 * h[k - 1].x[i] + h[k - 2].x[i]) / DT / DT) : [0, 0, 0];
    p.acc = app3(tr3(Rimu), [acc[0], acc[1] + G, acc[2]]).map(v => Math.max(-156, Math.min(156, v)));
    p.swinging = false;
  }
}

function main() {
  const args = process.argv.slice(2), once = args.includes('--once'), host = args.find(a => !a.startsWith('--')) ?? 'localhost:8000';
  const WebSocket = createRequire(import.meta.url)('ws');
  const sim = createSim({ seed: 1, noise: 1 });
  const phones = { A: { ok: false }, B: { ok: false } };
  let t0 = null, lastSay = null, lap = 0;
  console.log(`fake-moves -> ws://${host}/ws   1周 ${LEN.toFixed(1)} 秒。ダッシュボードで「試合開始」を押してから見る`);
  function connect(slot) {
    const ph = phones[slot], ws = new WebSocket(`ws://${host}/ws`);
    const send = k => ws.readyState === 1 && ws.send(JSON.stringify(k));
    ws.on('open', () => send({ type: 'hello', role: 'phone', id: `fake-moves-${slot}`, name: `Fake moves ${slot}` }));
    ws.on('message', data => {
      let k; try { k = JSON.parse(data); } catch { return; }
      if (k.type !== 'welcome') return;
      console.log(`${slot}: welcome, slot ${k.slot}`);
      ph.ok = true; ph.send = send;
      if (slot === 'A') connect('B');
      if (t0 === null && phones.A.ok && phones.B.ok) { t0 = Date.now() / 1000; for (const p of Object.values(phones)) p.send({ t: t0, type: 'calib' }); }
    });
    ws.on('close', () => { ph.ok = false; });
    ws.on('error', () => {});
  }
  connect('A');
  setInterval(() => {
    if (t0 === null) return;
    const now = Date.now() / 1000;
    while (sim.n * DT <= now - t0) {
      const n = sim.n, t = sim.step(), when = due(n), stamp = Math.round((t0 + t) * 1000) / 1000;
      pin(sim, t);
      if (t > HOLD) {
        const st = stickAt(t - HOLD).step, l = Math.floor((t - HOLD) / LEN);
        if (l !== lap) { lap = l; if (once) process.exit(0); }
        if (st?.say && st !== lastSay) { lastSay = st; console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })}  A: ${st.say}`); }
      }
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
