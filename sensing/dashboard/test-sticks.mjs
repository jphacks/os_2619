// Stick estimation: camera tip, hand + IMU, chest phone + IMU. After a warm-up with full vision (the IMU yaw offsets are learned from camera-seen tips),
// the phones stop seeing the tip, then stop seeing the hands too, and the stick must still follow the truth.
import assert from 'node:assert/strict';
import { createMap, dist, sub, rotY } from './map.js';
import { packets, truth, CORNERS, L } from './sim.mjs';

const c = Object.values(CORNERS).reduce((a, p) => a.map((v, i) => v + p[i] / 4), [0, 0, 0]);
const d = sub(CORNERS[3], CORNERS[0]), toRoom = v => rotY(Math.atan2(d[2], d[0]), sub(v, c));
const m = createMap(), t0 = 1000, err = {};
let tB = 0;
for (let i = 0; i < 30 * 50; i++) {
  const phase = i < 30 * 20 ? 'camera' : i < 30 * 35 ? 'hand + sensor' : 'sensor'; // what the phones can still see
  for (const [s, off] of [['A', 0], ['B', 0.4]]) {
    const t = t0 + (i + off) / 30; if (s === 'B') tB = t;
    for (const k of packets(s, t, true)) {
      if (phase !== 'camera' && k.type === 'color') k.found = false;
      if (phase === 'sensor' && k.type === 'pose') k.found = false;
      m.ingest({ ...k, slot: s });
    }
  }
  const e = m.estimate({ now: tB, L });
  if (i < 30 * 14 || i % 5) continue; // from when the yaw offsets have settled
  for (const s of ['A', 'B']) {
    const st = e.sticks[s]; if (!st) continue;
    (err[st.src] ??= []).push(dist(st.tip, toRoom(truth(tB)[s].tip)));
  }
}
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const [k, a] of Object.entries(err)) console.log(`${k}: n ${a.length}, median ${(med(a) * 100).toFixed(1)} cm, max ${(Math.max(...a) * 100).toFixed(1)} cm`);
for (const k of ['camera', 'hand + sensor', 'sensor']) assert.ok(err[k]?.length > 30, `${k} used`);
assert.ok(med(err.camera) < 0.1, 'camera tip');
assert.ok(med(err['hand + sensor']) < 0.1, 'hand + sensor within 10 cm');
assert.ok(med(err.sensor) < 0.15, 'sensor only within 15 cm');
console.log('sticks ok');
