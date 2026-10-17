// Pure logic, no server: the sensing team's action detectors and phonealign.js fed by the fake world.
import assert from 'node:assert/strict';
import { createActions, eulerRot } from './public/actions.js';
import { createPhoneAlign } from './public/phonealign.js';
import { createSim, due, DT } from './fake-world.mjs';
import { PLAYER_TAG } from './public/world.js';

// actions: a fast downward swing of a stick whose sensor X is along it fires one Swing
{
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  assert.ok(close(eulerRot([0, 0, 90], [1, 0, 0]), [0, 1, 0]));
  const A = createActions(), ev = [];
  let t = 100;
  const run = (dur, f) => { for (let i = 0; i < dur * 100; i++, t += 0.01) ev.push(...A.ingest({ type: 'imu', slot: 'A', t, ...f(i / (dur * 100)) }, [1, 0, 0])); };
  run(0.5, () => ({ euler: [0, -60, 0], gyro: [0, 0, 0] }));
  run(0.2, u => ({ euler: [0, -60 + 90 * u, 0], gyro: [0, 450, 0] }));
  run(0.5, () => ({ euler: [0, 30, 0], gyro: [0, 0, 0] }));
  assert.deepEqual(ev.map(e => e.name), ['Swing']);
  assert.equal(ev[0].dir, 'down');
  console.log('actions ok');
}

// phonealign: 20 s of the fake world (raw ARCore frames with their own yaw / origin) -> chest positions in the field world
{
  const sim = createSim({ seed: 3, noise: 1 }), PA = createPhoneAlign(), t0 = 1000;
  for (const s of ['A', 'B']) PA.ingest({ type: 'calib', slot: s, t: t0 });
  let worst = 0, n = 0;
  while (sim.n * DT < 20) {
    const k = sim.n, t = sim.step(), when = due(k), stamp = t0 + t;
    for (const s of ['A', 'B']) {
      PA.ingest({ slot: s, t: stamp, ...sim.imu(s) });
      if (when.ar) PA.ingest({ slot: s, t: stamp, ...sim.ar(s) });
      if (when.tags) PA.ingest({ slot: s, t: stamp, ...sim.tags(s) });
    }
    if (t > 5 && when.tags) {
      const e = PA.estimate(stamp);
      for (const s of ['A', 'B']) {
        const g = e.slots[s]; if (!g.chest) continue;
        const truth = sim.players[s].body.t, err = Math.hypot(...g.chest.map((v, i) => v - truth[i]));
        worst = Math.max(worst, err); n++;
      }
    }
  }
  assert.ok(n > 100, `placed ${n} times`);
  assert.ok(worst < 0.15, `worst chest error ${worst.toFixed(3)} m`);
  console.log(`phonealign ok: worst chest error ${(worst * 100).toFixed(1)} cm over ${n} estimates`);
}

// stick direction (phonealign, euler + the connection screen's axis, as actions.js) vs the simulated stick, after Calibrate
{
  const sim = createSim({ seed: 5, noise: 1 }), axis = { A: [1, 0, 0], B: [1, 0, 0] }, PA = createPhoneAlign({ axis }), t0 = 2000;
  let worst = 0, n = 0, sum = 0;
  while (sim.n * DT < 15) {
    const k = sim.n, t = sim.step(), when = due(k), stamp = t0 + t;
    for (const s of ['A', 'B']) {
      PA.ingest({ slot: s, t: stamp, ...sim.imu(s) });
      if (k === 0) PA.ingest({ type: 'calib', slot: s, t: stamp });
      if (when.ar) PA.ingest({ slot: s, t: stamp, ...sim.ar(s) });
      if (when.tags) PA.ingest({ slot: s, t: stamp, ...sim.tags(s) });
    }
    if (t > 5 && when.tags) {
      const e = PA.estimate(stamp);
      for (const s of ['A', 'B']) {
        const d = e.stick[s]?.dir, truth = sim.players[s].dir; if (!d) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, d[0] * truth[0] + d[1] * truth[1] + d[2] * truth[2]))) * 180 / Math.PI;
        worst = Math.max(worst, ang); sum += ang; n++;
      }
    }
  }
  assert.ok(n > 100, `compared ${n} times`);
  assert.ok(sum / n < 5, `mean stick direction error ${(sum / n).toFixed(1)}°`);
  console.log(`stick direction ok: mean ${(sum / n).toFixed(1)}°, worst ${worst.toFixed(1)}° over ${n} estimates`);
}

// phonealign, chest tags only for B: B never sees a field tag (it sits behind a pillar), but A does and A sees B's chest tag
{
  const sim = createSim({ seed: 3, noise: 1 }), PA = createPhoneAlign(), t0 = 3000;
  for (const s of ['A', 'B']) PA.ingest({ type: 'calib', slot: s, t: t0 });
  let worst = 0, n = 0, how = null;
  while (sim.n * DT < 25) {
    const k = sim.n, t = sim.step(), when = due(k), stamp = t0 + t;
    for (const s of ['A', 'B']) {
      PA.ingest({ slot: s, t: stamp, ...sim.imu(s) });
      if (when.ar) PA.ingest({ slot: s, t: stamp, ...sim.ar(s) });
      if (when.tags) {
        const m = sim.tags(s);
        if (s === 'B') m.tags = m.tags.filter(g => g.id === PLAYER_TAG.A); // nothing of the field
        PA.ingest({ slot: s, t: stamp, ...m });
      }
    }
    if (t > 12 && when.tags) {
      const g = PA.estimate(stamp).slots.B; if (!g.chest) continue;
      how = g.how; worst = Math.max(worst, Math.hypot(...g.chest.map((v, i) => v - sim.players.B.body.t[i]))); n++;
    }
  }
  assert.equal(how, 'chest');
  assert.ok(n > 50, `placed ${n} times`);
  assert.ok(worst < 0.15, `worst chest-only error ${worst.toFixed(3)} m`);
  console.log(`phonealign chest tags ok: worst error ${(worst * 100).toFixed(1)} cm over ${n} estimates`);
}
