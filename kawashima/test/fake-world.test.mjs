// Headless check of fake-world.mjs against the world.js conventions.
// Run: node kawashima/test/fake-world.test.mjs
import assert from 'node:assert/strict';
import { createSim, calibImu, due, DT } from '../fake-world.mjs';
import {
  START, STICK, TAGS, CORNER_IDS, PLAYER_TAG, tagScale, mul3, tr3, app3, compose, invert, pose,
  fromQuat, fromRodrigues, bodyPose, worldTagPose, phoneArcamPose, arcam_T_cv,
} from '../world.js';

const SECS = 120;
const nq = q => { const n = Math.hypot(...q); return q.map(v => v / n); }; // wire values are rounded
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const angErr = (Ra, Rb) => { const M = mul3(tr3(Ra), Rb); return Math.acos(Math.max(-1, Math.min(1, (M[0] + M[4] + M[8] - 1) / 2))) * 180 / Math.PI; };
const stats = a => { const s = [...a].sort((x, y) => x - y); return { mean: a.reduce((x, y) => x + y, 0) / a.length, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] }; };
const fmt = o => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(', ');

for (const noise of [1, 0]) {
  const sim = createSim({ seed: 7, noise });
  const e = { tagPos: [], tagRot: [], arPos: [], arRot: [], dir: [] };
  const seen = { A: { corner: 0, chest: 0, frames: 0 }, B: { corner: 0, chest: 0, frames: 0 } };
  let minSep = Infinity, maxAbs = 0, gyroPeak = { A: 0, B: 0 }, swings = { A: 0, B: 0 }, wasSw = { A: false, B: false };
  const W0 = { A: calibImu('A'), B: calibImu('B') };
  for (let n = 0; n < SECS / DT; n++) {
    const t = sim.step(), when = due(n), P = sim.players;
    minSep = Math.min(minSep, dist(P.A.pos, P.B.pos));
    for (const slot of ['A', 'B']) {
      const tr = sim.truth(slot), body = bodyPose([tr.chest[0], 0, tr.chest[2]], tr.yaw);
      maxAbs = Math.max(maxAbs, Math.abs(tr.chest[0]), Math.abs(tr.chest[2]));
      if (tr.swinging && !wasSw[slot]) swings[slot]++;
      wasSw[slot] = tr.swinging;
      if (n === 0) { // calibration instant: exactly at START, q = identity, AR at origin
        assert.ok(dist(tr.chest, bodyPose(START[slot].pos, START[slot].yaw).t) < 1e-9);
        assert.deepEqual(sim.imu(slot).q.map(Math.abs), [1, 0, 0, 0]);
      }
      // (c) imu q -> stick direction through the calibration frame
      const im = sim.imu(slot), dir = app3(mul3(W0[slot], fromQuat(nq(im.q))), STICK.axis);
      e.dir.push(dist(dir, tr.dir));
      gyroPeak[slot] = Math.max(gyroPeak[slot], Math.hypot(...im.gyro));
      if (when.ar) { // (b) world_T_arcam = origin o calib_T_arcam
        const a = sim.ar(slot), [x, y, z, w] = a.q;
        const origin = phoneArcamPose(bodyPose(START[slot].pos, START[slot].yaw));
        const est = compose(origin, pose(fromQuat(nq([w, x, y, z])), a.p)), ref = phoneArcamPose(body);
        e.arPos.push(dist(est.t, ref.t)); e.arRot.push(angErr(est.R, ref.R));
      }
      if (when.tags) { // (a) camera pose from a tag sighting
        const tg = sim.tags(slot).tags, ref = compose(phoneArcamPose(body), arcam_T_cv);
        seen[slot].frames++;
        if (tg.some(k => CORNER_IDS.includes(k.id))) seen[slot].corner++;
        if (tg.some(k => k.id === PLAYER_TAG[slot === 'A' ? 'B' : 'A'])) seen[slot].chest++;
        assert.ok(!tg.some(k => k.id === PLAYER_TAG[slot]), 'own chest tag must never be seen');
        for (const k of tg) {
          assert.equal(k.c.length, 4);
          if (!CORNER_IDS.includes(k.id)) continue;
          const cv_T_tag = pose(fromRodrigues(k.r), k.p.map(v => v * tagScale(k.id)));
          const est = compose(worldTagPose(k.id), invert(cv_T_tag));
          e.tagPos.push(dist(est.t, ref.t)); e.tagRot.push(angErr(est.R, ref.R));
          // corner order: (-h,h) top-left, (h,h) top-right in the image (tag upright, y down in image);
          // a flipped print (official orientation) puts corner 0 bottom-right, as on the real 10/17 sheets
          const s = TAGS[k.id].flip ? -1 : 1;
          assert.ok(s * (k.c[1][0] - k.c[0][0]) > 0 && s * (k.c[3][1] - k.c[0][1]) > 0, `corner order id ${k.id}`);
        }
      }
    }
  }
  const S = Object.fromEntries(Object.entries(e).map(([k, v]) => [k, stats(v)]));
  console.log(`\n--- noise ${noise}, ${SECS} s sim ---`);
  console.log(`(a) cam from corner tag: pos m ${fmt(S.tagPos)} | rot deg ${fmt(S.tagRot)}  (n=${e.tagPos.length})`);
  console.log(`(b) world_T_arcam via ar: pos m ${fmt(S.arPos)} | rot deg ${fmt(S.arRot)}`);
  console.log(`(c) stick dir from imu q: ${fmt(S.dir)}`);
  for (const s of ['A', 'B']) console.log(`(d) ${s}: corner tag seen ${(100 * seen[s].corner / seen[s].frames).toFixed(1)}%, opponent chest tag ${(100 * seen[s].chest / seen[s].frames).toFixed(1)}%, swings ${swings[s]}, gyro peak ${gyroPeak[s].toFixed(0)} deg/s`);
  console.log(`min separation ${minSep.toFixed(2)} m, max |x|,|z| ${maxAbs.toFixed(2)} m`);

  const tol = noise ? { p: 0.15, r: 2 } : { p: 1e-3, r: 0.05 };
  assert.ok(S.tagPos.p95 < tol.p && S.tagRot.p95 < tol.r, '(a) tag reconstruction');
  assert.ok(S.arPos.max < 1e-3 && S.arRot.max < 0.05, '(b) ar');
  assert.ok(S.dir.max < 1e-3, '(c) imu dir');
  for (const s of ['A', 'B']) {
    assert.ok(seen[s].corner / seen[s].frames > 0.2, `(d) ${s} corners`);
    assert.ok(seen[s].chest > 0, `(d) ${s} chest`);
    assert.ok(gyroPeak[s] > 550 && gyroPeak[s] < 1500, `${s} gyro peak`);
  }
  assert.ok(minSep > 0.8 && maxAbs <= 1.7);
}

// drift: AR estimate departs from truth, truth itself does not
{
  const sim = createSim({ seed: 7, drift: 1 });
  for (let n = 0; n < 30 / DT; n++) sim.step();
  const p = sim.players.A, a = sim.ar('A'), [x, y, z, w] = a.q;
  const est = compose(p.origin, pose(fromQuat(nq([w, x, y, z])), a.p)), ref = phoneArcamPose(p.body);
  console.log(`\ndrift after 30 s: ${dist(est.t, ref.t).toFixed(3)} m, ${angErr(est.R, ref.R).toFixed(2)} deg`);
  assert.ok(Math.abs(angErr(est.R, ref.R) - 15) < 0.5);
}
console.log('\nok');
