// node --test kawashima/test/localize.test.mjs
// Synthetic two-player run built from world.js: ground truth -> ar/tags messages (noise, ARCore drift) -> localizer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START, TAGS, CORNER_IDS, PLAYER_TAG, tagScale, pose, compose, invert, apply, fromRodrigues, toRodrigues, toQuat, mul3,
  cv_T_arcam, arcam_T_cv, worldTagPose, bodyPose, chestTagPose, phoneArcamPose,
} from '../world.js';
import { createLocalizer } from '../localize.js';

const DEG = Math.PI / 180;
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const rotY = a => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotX = a => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const r4 = v => Math.round(v * 1e4) / 1e4;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// players walk small loops, turning their torso; A faces +x, B faces -x on average
function truth(slot, t) {
  const s = slot === 'A' ? -1 : 1, w = 2 * Math.PI / 12;
  const pos = [s * 0.9 + 0.5 * Math.cos(w * t + (s > 0 ? 1 : 0)), 0, 0.6 * Math.sin(w * t + (s > 0 ? 1 : 0))];
  const yaw = (slot === 'A' ? 0 : Math.PI) + 50 * DEG * Math.sin(2 * Math.PI * t / 7 + (s > 0 ? 2 : 0));
  return bodyPose(pos, yaw);
}

// cv_T_tag as seen from world_T_cv, or null if out of view
function see(world_T_cv, world_T_tag) {
  const c = compose(invert(world_T_cv), world_T_tag), p = c.t, d = Math.hypot(...p);
  if (p[2] < 0.3 || d > 5) return null;
  if (Math.abs(Math.atan2(p[0], p[2])) > 30 * DEG || Math.abs(Math.atan2(p[1], p[2])) > 40 * DEG) return null; // portrait FOV
  const n = [c.R[2], c.R[5], c.R[8]]; // tag normal in cv
  if (-(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / d < Math.cos(70 * DEG)) return null;
  return c;
}

/**
 * Run the sim. opts: dur s, drift { yaw deg/s, v m/s }, tagWindow(t) -> bool corners allowed, noise on/off, loc options.
 * Returns per-slot error stats after the first fix plus the localizer.
 */
function run({ dur = 30, drift = { yaw: 0, v: 0 }, tagWindow = () => true, noise = true, loc = {}, cornersFor = ['A', 'B'], settle = 2, seed: sd = 7, hook } = {}) {
  seed = sd;
  const L = createLocalizer(loc);
  // true calibration pose: a bit off the start mark, phone tilted
  const origin = {
    A: (() => { const b = phoneArcamPose(bodyPose([-1.1, 0, 0.08], 4 * DEG)); return pose(mul3(b.R, rotX(5 * DEG)), b.t); })(),
    B: (() => { const b = phoneArcamPose(bodyPose([1.3, 0, -0.05], Math.PI - 3 * DEG)); return pose(mul3(b.R, rotX(-4 * DEG)), b.t); })(),
  };
  const mk = () => ({ e: [], y: [], opp: [], vis: 0, n: 0, fix0: null, first: null });
  const stats = { A: mk(), B: mk() };
  const dt = 1 / 30;
  for (let i = 0; i * dt < dur; i++) {
    const t = 100 + i * dt;
    for (const slot of ['A', 'B']) {
      const other = slot === 'A' ? 'B' : 'A';
      const W = phoneArcamPose(truth(slot, i * dt)), Wcv = compose(W, arcam_T_cv);
      // ARCore drift: world-frame rotation about the calibration point + translation, growing with time
      const o = origin[slot], a = drift.yaw * DEG * i * dt, dir = slot === 'A' ? [1, 0, 0.5] : [-0.5, 0, 1];
      const nd = Math.hypot(...dir), dv = dir.map(v => v / nd * drift.v * i * dt);
      const D = compose(pose(rotY(a), o.t.map((v, k) => v + dv[k])), pose(undefined, o.t.map(v => -v)));
      const rep = compose(invert(o), compose(D, W));
      const q = toQuat(rep.R), jit = () => (noise ? 0.002 * gauss() : 0);
      L.onMessage({ type: 'ar', slot, t, tracking: 'TRACKING', p: rep.t.map(v => r4(v + jit())), q: [q[1], q[2], q[3], q[0]].map(r4) }); // rounded like the phone
      if (i % 2) continue; // detector at 15 Hz, same frame as the ar sample
      const tags = [];
      const ids = [...(tagWindow(i * dt) && cornersFor.includes(slot) ? CORNER_IDS : []), PLAYER_TAG[other]];
      for (const id of ids) {
        const wt = TAGS[id].pos ? worldTagPose(id) : chestTagPose(truth(other, i * dt));
        const c = see(Wcv, wt); if (!c) continue;
        const d = Math.hypot(...c.t);
        const R = noise ? mul3(fromRodrigues([0, 1, 2].map(() => 0.5 * DEG * d * gauss())), c.R) : c.R; // ~0.5°/m
        const p = c.t.map(v => v + (noise ? 0.004 * d * gauss() : 0));
        tags.push({ id, p: p.map(v => v / tagScale(id)), r: toRodrigues(R) });
      }
      stats[slot].n++; if (tags.some(g => CORNER_IDS.includes(g.id))) stats[slot].vis++;
      L.onMessage({ type: 'tags', slot, t, tags });
      const g = L.get(slot);
      const st = stats[slot];
      if (g.anchored && st.fix0 === null) { st.fix0 = i * dt; st.first = dist(g.chest, W.t); }
      if (g.anchored && i * dt - st.fix0 >= settle) {
        stats[slot].e.push(dist(g.chest, W.t));
        stats[slot].y.push(Math.abs(wrap(g.yaw - truthYaw(slot, i * dt))));
      }
      const op = g.seen.opponent;
      if (op && op.t === t && st.fix0 !== null && i * dt - st.fix0 >= settle) stats[slot].opp.push(dist(op.pos, truth(other, i * dt).t));
      hook?.(L, slot, i * dt, W);
    }
  }
  const sum = s => {
    const srt = a => [...a].sort((x, y) => x - y), pc = (a, f) => a.length ? srt(a)[Math.floor(f * (a.length - 1))] : NaN;
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    return { firstCm: s.first * 100, maxCm: Math.max(...s.e) * 100, meanCm: mean(s.e) * 100, p95Cm: pc(s.e, 0.95) * 100, finalCm: s.e.at(-1) * 100,
      yawMaxDeg: Math.max(...s.y) / DEG, yawMeanDeg: mean(s.y) / DEG, oppMaxCm: Math.max(...s.opp) * 100, oppMeanCm: mean(s.opp) * 100, oppP95Cm: pc(s.opp, 0.95) * 100,
      oppN: s.opp.length, vis: s.vis / s.n };
  };
  return { L, A: sum(stats.A), B: sum(stats.B) };
}
const truthYaw = (slot, t) => { const b = truth(slot, t); return Math.atan2(-b.R[6], b.R[0]); };
const fmt = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +v.toFixed(2)]));

// single-message helpers: phone calibrated exactly on A's start mark
const O = phoneArcamPose(bodyPose(START.A.pos, START.A.yaw));
const arMsg = (t, W) => { const c = compose(invert(O), W), q = toQuat(c.R); return { type: 'ar', slot: 'A', t, p: c.t, q: [q[1], q[2], q[3], q[0]] }; };
const tagMsg = (t, Wcv, id = 1) => { const c = see(Wcv, worldTagPose(id)); assert.ok(c, 'tag in view');
  return { type: 'tags', slot: 'A', t, tags: [{ id, p: c.t.map(v => v / tagScale(id)), r: toRodrigues(c.R) }] }; };
const W1 = phoneArcamPose(bodyPose([-1.2, 0, 0], 0.55)); // turned toward corner 1

test('unanchored START guess, anchored after first corner sighting, calib resets', () => {
  const L = createLocalizer();
  assert.equal(L.get('A').anchored, false);
  assert.equal(L.get('A').chest, null);
  L.onMessage(arMsg(1, W1));
  let g = L.get('A');
  assert.ok(dist(g.chest, W1.t) < 1e-9 && Math.abs(g.yaw - 0.55) < 1e-9, 'start guess');
  L.onMessage(tagMsg(1.01, compose(W1, arcam_T_cv)));
  g = L.get('A');
  assert.equal(g.anchored, true); assert.equal(g.fixes, 1); assert.equal(g.lastFix, 1.01);
  assert.ok(dist(g.chest, W1.t) < 1e-6);
  L.onMessage({ type: 'calib', slot: 'A', t: 2 });
  g = L.get('A');
  assert.equal(g.anchored, false); assert.equal(g.chest, null);
});

// Max error is a noise tail: with the default drift figures (tuned for the 1°/s stress case below) single-seed max sits
// around 4-5.5 cm, so it is checked as p95 / mean over several seeds; with drift figures that match a drift-free ARCore
// the filter averages longer and the max stays under 5 cm.
test('noise, no drift: chest < 5 cm (p95, default opts; max, matched drift opts), 5 seeds', () => {
  const quiet = { rotDrift: 0.3 * DEG, posDrift: 0.005 };
  for (let seed = 1; seed <= 5; seed++) {
    const r = run({ dur: 30, seed }), q = run({ dur: 30, seed, loc: quiet });
    console.log(`no drift seed ${seed}`, 'A', fmt(r.A), 'B', fmt(r.B), 'quiet max A', q.A.maxCm.toFixed(2), 'B', q.B.maxCm.toFixed(2));
    for (const s of ['A', 'B']) {
      assert.ok(r[s].p95Cm < 5 && r[s].meanCm < 3 && r[s].maxCm < 7, `${s} seed ${seed} p95 ${r[s].p95Cm} max ${r[s].maxCm}`);
      assert.ok(q[s].maxCm < 5, `${s} seed ${seed} quiet max ${q[s].maxCm}`);
      assert.ok(r[s].yawMaxDeg < 2, `${s} yaw ${r[s].yawMaxDeg}`);
      assert.ok(r[s].oppP95Cm < 5 && r[s].oppMeanCm < 3 && r[s].oppN > 50, `${s} opp ${r[s].oppP95Cm} n ${r[s].oppN}`);
    }
  }
});

test('drift 1°/s + 2 cm/s: bounded with corners ~30% of the time, grows without', () => {
  const drift = { yaw: 1, v: 0.02 };
  const win = t => (t % 3.3) < 1.1;
  const r = run({ dur: 40, drift, tagWindow: win });
  const none = run({ dur: 40, drift, tagWindow: t => t < 0.5 }); // one early sighting, then dead reckoning
  console.log('drift + 30% tags', 'A', fmt(r.A), 'B', fmt(r.B));
  console.log('drift, no tags  ', 'A', fmt(none.A), 'B', fmt(none.B));
  for (const s of ['A', 'B']) {
    assert.ok(r[s].vis > 0.2 && r[s].vis < 0.4, `${s} visibility ${r[s].vis}`);
    assert.ok(r[s].maxCm < 15, `${s} max ${r[s].maxCm}`);
    assert.ok(r[s].yawMaxDeg < 5, `${s} yaw ${r[s].yawMaxDeg}`);
    assert.ok(none[s].finalCm > 3 * r[s].maxCm, `${s} no-tag final ${none[s].finalCm}`);
  }
});

test('outlier rejected, then accepted when 3 consecutive agree', () => {
  const L = createLocalizer();
  const Wcv = compose(W1, arcam_T_cv), off = compose(pose(undefined, [0, 0, -1]), Wcv); // tag read as if 1 m along -z
  L.onMessage(arMsg(1, W1)); L.onMessage(tagMsg(1, Wcv));
  L.onMessage(arMsg(2, W1)); L.onMessage(tagMsg(2, off));
  assert.ok(dist(L.get('A').chest, W1.t) < 1e-6, 'single outlier ignored');
  for (const t of [3, 4]) { L.onMessage(arMsg(t, W1)); L.onMessage(tagMsg(t, off)); }
  const g = L.get('A');
  assert.ok(dist(g.chest, off.t) < 1e-6 && Math.abs(g.err - 1) < 1e-6, 'three agreeing outliers taken');
});

test('ar sample too far from tags time is skipped', () => {
  const L = createLocalizer();
  L.onMessage(arMsg(1, W1)); L.onMessage(tagMsg(1.2, compose(W1, arcam_T_cv)));
  assert.equal(L.get('A').anchored, false);
});

test('useOpponentObs pulls an unanchored player toward where the other saw it', () => {
  const opts = { dur: 20, cornersFor: ['A'] };
  const off = run(opts), on = run({ ...opts, loc: { useOpponentObs: true } });
  // B is never anchored: measure its chest error at the end directly
  const errB = r => { const g = r.L.get('B'); return dist(g.chest, phoneArcamPose(truth('B', 20 - 1 / 30)).t) * 100; };
  console.log('B unanchored, end error cm: without obs', errB(off).toFixed(2), 'with obs', errB(on).toFixed(2));
  assert.equal(on.L.get('B').anchored, false);
  assert.ok(errB(on) < 5 && errB(on) < errB(off), `${errB(on)} vs ${errB(off)}`);
});
