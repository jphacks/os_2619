// Pure logic, no server: the sensing team's action detectors and phonealign.js fed by the fake world.
import assert from 'node:assert/strict';
import { createActions, eulerRot } from './public/actions.js';
import { createPhoneAlign } from './public/phonealign.js';
import { createSim, due, DT } from './fake-world.mjs';
import { STICK } from './public/world.js';

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

// phonealign, a device whose picture sits turned by 90 / 180 / 270 deg on the ARCore camera frame: found from the tags themselves
{
  const W = await import('./public/world.js');
  const Mz = [0, -1, 0, 1, 0, 0, 0, 0, 1]; // Rz(+90): [x, y] -> [-y, x]
  const rz = k => { let R = W.I3; for (let i = 0; i < k; i++) R = W.mul3(Mz, R); return R; };
  for (const kk of [1, 2, 3]) {
    const sim = createSim({ seed: 4, noise: 1 }), PA = createPhoneAlign(), t0 = 5000 + kk * 100, Rinv = W.tr3(rz(kk));
    for (const s of ['A', 'B']) PA.ingest({ type: 'calib', slot: s, t: t0 });
    let worst = 0, n = 0, last = null;
    while (sim.n * DT < 20) {
      const k = sim.n, t = sim.step(), when = due(k), stamp = t0 + t;
      for (const s of ['A', 'B']) {
        PA.ingest({ slot: s, t: stamp, ...sim.imu(s) });
        if (when.ar) PA.ingest({ slot: s, t: stamp, ...sim.ar(s) });
        if (when.tags) { // what such a device sends: the true camera-frame vectors turned back by kk quarter turns
          const m = sim.tags(s);
          m.tags = m.tags.map(g => ({ ...g, p: W.app3(Rinv, g.p), r: W.toRodrigues(W.mul3(Rinv, W.fromRodrigues(g.r))) }));
          PA.ingest({ slot: s, t: stamp, ...m });
        }
      }
      if (t > 8 && when.tags) {
        const e = PA.estimate(stamp);
        for (const s of ['A', 'B']) { const g = e.slots[s]; if (!g.chest) continue; last = g.camRot; worst = Math.max(worst, Math.hypot(...g.chest.map((v, i) => v - sim.players[s].body.t[i]))); n++; }
      }
    }
    assert.ok(n > 50, `placed ${n} times`);
    assert.equal(last, kk * 90, `camera turn ${last}`);
    assert.ok(worst < 0.15, `turn ${kk * 90}: worst chest error ${worst.toFixed(3)} m`);
    console.log(`phonealign camera turn ${kk * 90} deg found: worst error ${(worst * 100).toFixed(1)} cm`);
  }
}

// stick direction (phonealign, euler + the fixed +Y axis, as actions.js) vs the simulated stick, after Calibrate
{
  const sim = createSim({ seed: 5, noise: 1 }), axis = { A: STICK.axis, B: STICK.axis }, PA = createPhoneAlign({ axis }), t0 = 2000;
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


// scan -> fixed square: the sheets measured in some other frame (turned and shifted), phone C along with them
{
  const W = await import('./public/world.js');
  const th = 0.8, c = Math.cos(th), s = Math.sin(th), rot = p => [c * p[0] + s * p[2] + 0.7, 0, -s * p[0] + c * p[2] - 0.4];
  const tags = Object.fromEntries([0, 1, 2, 3].map(id => [id, { pos: rot(W.TAGS[id].pos), yaw: th }])); // every sheet upright in the fixed frame: turned by th in the scan's
  const camPose = { R: [c, 0, s, 0, 1, 0, -s, 0, c], t: [rot([0.3, 0, 2.5])[0], 3, rot([0.3, 0, 2.5])[2]] }; // sits over (0.3, 3, 2.5) of the fixed frame, as seen from the scan frame
  const fit = W.toFixedFrame(tags, camPose);
  assert.ok(fit.rms < 1e-9, `rms ${fit.rms}`);
  for (const id of [0, 1, 2, 3]) assert.ok(fit.tags[id].pos.every((v, i) => Math.abs(v - W.TAGS[id].pos[i]) < 1e-9));
  assert.ok(Math.abs(fit.tags[0].yaw) < 1e-9, `yaw ${fit.tags[0].yaw}`); // upright again
  assert.ok([0.3, 3, 2.5].every((v, i) => Math.abs(fit.pose.t[i] - v) < 1e-9), `cam ${fit.pose.t}`);
  assert.ok(Math.abs(W.toFixedFrame({ 0: tags[0] }, camPose).pose.t[0] - 0.3) < 1e-9); // one sheet is enough: its turn and centre
  assert.equal(W.toFixedFrame({}, camPose), null);
  console.log('toFixedFrame ok: sheets back in the fixed layout, rms', fit.rms.toExponential(1));
}

// phone C: pose from the fixed tags (extrinsics.js), 4 sheets of 160 mm in the middle seen from 2.5-5 m with 0.5 px of corner noise
{
  const W = await import('./public/world.js'), { solveCamera } = await import('./public/extrinsics.js');
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const CW = 1920, CH = 1080, fov = 40, f = CH / 2 / Math.tan(fov * Math.PI / 360);
  const lookAt = (eye, tgt) => {
    const sub = (a, b) => a.map((v, i) => v - b[i]), cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], nz = a => a.map(v => v / Math.hypot(...a));
    const z = nz(sub(tgt, eye)), x = nz(cr(z, [0, 1, 0])), y = cr(z, x);
    return { R: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: eye };
  };
  let worstPos = 0, worstAng = 0, n = 0;
  for (const [dist, h] of [[2.5, 1.5], [3.5, 1.7], [5, 2.2]]) for (let k = 0; k < 15; k++) {
    const az = (rnd() - .5) * 2, eye = [dist * Math.sin(az), h, dist * Math.cos(az)], pose = lookAt(eye, [0, 0, 0]), inv = W.invert(pose);
    const dets = W.CORNER_IDS.map(id => {
      const tp = W.worldTagPose(id), hh = W.TAGS[id].size / 2;
      return { id, corners: [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([x, y]) => { const c = W.apply(inv, W.apply(tp, [x * hh, y * hh, 0])); return [CW / 2 + f * c[0] / c[2] + 0.5 * gauss(), CH / 2 + f * c[1] / c[2] + 0.5 * gauss()]; }) };
    });
    const r = solveCamera(dets, CW, CH, { fovYGuess: fov, fitFocal: 'auto' });
    assert.ok(r, 'no pose');
    const RR = W.mul3(W.tr3(r.pose.R), pose.R), ang = Math.acos(Math.max(-1, Math.min(1, (RR[0] + RR[4] + RR[8] - 1) / 2))) * 180 / Math.PI;
    worstPos = Math.max(worstPos, Math.hypot(...r.pose.t.map((v, i) => v - eye[i]))); worstAng = Math.max(worstAng, ang); n++;
  }
  assert.ok(worstPos < 0.3 && worstAng < 3, `phone C pose: worst ${worstPos.toFixed(2)} m, ${worstAng.toFixed(1)} deg`);
  console.log(`phone C pose from the fixed tags ok: worst ${(worstPos * 100).toFixed(0)} cm, ${worstAng.toFixed(1)} deg over ${n} views`);
}
