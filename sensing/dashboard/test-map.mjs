// Self-check of the space map against the synthetic scene: people, room frame and stick tips, compared in room coordinates.
import assert from 'node:assert/strict';
import { createMap, dist, sub, rotY } from './map.js';
import { packets, truth, CORNERS, L } from './sim.mjs';

// the room frame map.js should build: centre of the floor tags, +x from tag 0 towards its nearest tag (3)
const c = Object.values(CORNERS).reduce((a, p) => a.map((v, i) => v + p[i] / 4), [0, 0, 0]);
const d = sub(CORNERS[3], CORNERS[0]), toRoom = v => rotY(Math.atan2(d[2], d[0]), sub(v, c));

const m = createMap(), t0 = 1000, err = { A: [], B: [], tipA: [], tipB: [] };
let tA = 0, tB = 0, seed = 1;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 1073741823.5 - 1; // deterministic, -1..1
for (let i = 0; i < 30 * 40; i++) {
  for (const [s, off] of [['A', 0], ['B', 0.4]]) { // the phones' frames are not simultaneous
    const t = t0 + (i + off) / 30; if (s === 'A') tA = t; else tB = t;
    for (const k of packets(s, t, i % 2 === 0)) {
      if (k.type === 'tags') for (const g of k.tags) g.p = g.p.map(v => v * (1 + 0.01 * rnd()) + 0.005 * rnd()); // ~1% depth, 5 mm jitter
      m.ingest({ ...k, slot: s });
    }
  }
  const e = m.estimate({ now: tB, L }); // every frame, like the dashboard: the stick sensors' yaw offsets are learned inside estimate()
  if (i < 30 * 13 || i % 15) continue; // A-B alignment and the sticks' yaw offsets settle in the first ~12 s
  assert.ok(e.aligned, `aligned at ${i}`); assert.equal(e.corners.length, 4); assert.deepEqual(e.warn, []);
  err.A.push(dist(e.people.A.p, toRoom(truth(tA).A.chest)));
  err.B.push(dist(e.people.B.p, toRoom(truth(tB).B.chest)));
  for (const s of ['A', 'B']) if (e.tips[s]) err['tip' + s].push(dist(e.tips[s].p, toRoom(truth(e.tips[s].t)[s].tip)));
}
const q = (a, f) => [...a].sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];
for (const [k, a] of Object.entries(err)) console.log(`${k}: n ${a.length}, median ${(q(a, 0.5) * 100).toFixed(1)} cm, max ${(q(a, 1) * 100).toFixed(1)} cm`);
assert.ok(q(err.A, 1) < 0.05 && q(err.B, 1) < 0.05, 'people within 5 cm');
for (const k of ['tipA', 'tipB']) { assert.ok(err[k].length > 20, `${k} seen`); assert.ok(q(err[k], 0.5) < 0.1 && q(err[k], 1) < 0.25, `${k} median under 10 cm, no flips`); }
console.log('map ok');
