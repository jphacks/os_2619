// Stick from the IMU alone: direction from the stick IMU, yaw offset set by the Calibrate press (stick pointing where the chest phone looks), base at the shoulder.
import assert from 'node:assert/strict';
import { createMap, dist, sub, dot, norm, rotY } from './map.js';
import { packets, truth, CORNERS, L } from './sim.mjs';

const c = Object.values(CORNERS).reduce((a, p) => a.map((v, i) => v + p[i] / 4), [0, 0, 0]);
const d = sub(CORNERS[3], CORNERS[0]), th = Math.atan2(d[2], d[0]);
const m = createMap(), t0 = 1000, ang = { A: [], B: [] };
// the swing in sim.mjs is 0.9 sin(2.5 t + phase): pressing Calibrate when it crosses zero = stick straight ahead
const calibAt = { A: null, B: null };
for (const [s, ph] of [['A', 0], ['B', 2]]) { let best = 1e9; for (let t = t0 + 2; t < t0 + 5; t += 1 / 60) { const v = Math.abs(Math.sin(2.5 * t + ph)); if (v < best) { best = v; calibAt[s] = t; } } }
let tB = 0;
for (let i = 0; i < 30 * 40; i++) {
  for (const [s, off] of [['A', 0], ['B', 0.4]]) {
    const t = t0 + (i + off) / 30; if (s === 'B') tB = t;
    if (calibAt[s] != null && t >= calibAt[s]) { m.ingest({ type: 'calib', t, slot: s }); calibAt[s] = null; }
    for (const k of packets(s, t, i % 2 === 0)) m.ingest({ ...k, slot: s });
  }
  const e = m.estimate({ now: tB, L });
  if (i < 30 * 10 || i % 5) continue;
  for (const s of ['A', 'B']) {
    const st = e.sticks[s]; assert.ok(st, `stick ${s}`);
    const T = truth(tB)[s], want = rotY(th, norm(sub(T.tip, T.wrist)));
    ang[s].push(Math.acos(Math.min(1, dot(st.dir, want))) * 180 / Math.PI);
    assert.ok(Math.abs(dist(st.base, st.tip) - L[s]) < 1e-6, 'stick length');
  }
}
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const s of ['A', 'B']) console.log(`${s}: direction error median ${med(ang[s]).toFixed(1)}°, max ${Math.max(...ang[s]).toFixed(1)}°`);
for (const s of ['A', 'B']) assert.ok(Math.max(...ang[s]) < 8, `${s} direction within 8°`);
console.log('sticks ok');
