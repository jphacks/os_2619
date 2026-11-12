// Action detection per player from their packets: the stick IMU (imu) and the chest phone's AR pose (ar).
// Pure logic, no DOM: the dashboard and test-actions.mjs both use it.
// Stick direction: `axis` is the IMU sensor axis along the stick: +Y, pointing to the tip (fixed in the product),
// rotated into the IMU world (z up) by the WitMotion euler angles. Heading is relative to the IMU yaw at the last Calibrate.
import { cross, dot, norm, qrot } from './map.js';

const D = Math.PI / 180;
const CHARGE_RMS = { start: 120, keep: 90 }; // °/s: see the gyro charge below
const DODGE_ACC = 6, DODGE_DT = .08; // m/s², s: see Dodge below
export const ACTIONS = [
  { name: 'Charge', how: 'only while the stick is raised 45° or more; gyro only: starts when the stick moved 120°/s RMS over the last second and changed its turning direction 4+ times (stick circled or shaken at the base), then keeps going at 90°/s and 3+ times; slower than a swing' },
  { name: 'Swing', how: 'stick turns faster than 300°/s through more than 60° and stops dead (from over 250°/s to under 100°/s within 0.12 s); direction plus start and stop position' },
  { name: 'Dodge', how: 'a spike of the chest phone\'s sideways acceleration (across where it faces) over 6 m/s², moving that way; left / right' },
  { name: 'Guard', how: 'stick within 45° of horizontal (above or below) and still (under 60°/s) for 1 s; held upright it does nothing' },
];

/** WitMotion Z-Y-X euler (deg) applied to v: R = Rz(yaw) Ry(pitch) Rx(roll). */
export function eulerRot([r, p, y], [a, b, c]) {
  const cr = Math.cos(r * D), sr = Math.sin(r * D), cp = Math.cos(p * D), sp = Math.sin(p * D), cy = Math.cos(y * D), sy = Math.sin(y * D);
  const b1 = cr * b - sr * c, c1 = sr * b + cr * c; // Rx
  const a2 = cp * a + sp * c1, c2 = -sp * a + cp * c1; // Ry
  return [cy * a2 - sy * b1, sy * a2 + cy * b1, c2]; // Rz
}

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const deg = a => Math.round(a / D);
const where = s => `elev ${deg(s.el)}°, heading ${deg(s.hd)}°`;

export function createActions() {
  const P = {};
  const st = s => P[s] ??= { yaw0: 0, last: null, ring: [], rev: [], sign: [0, 0, 0], chargeOn: false, spinCool: 0, still: null, sw: null, guard: null, guarded: false, ar: [], dodging: false };

  /** Feeds one packet; returns the actions it completes as { t, slot, name, detail, ...data }.
   *  Swing adds dir ('down-left' ...) and power 0..1 (stick speed, 1 at 1000°/s); Dodge adds dir and speed (m/s). */
  function ingest(k, axis = [0, 1, 0]) {
    const S = st(k.slot), out = [], emit = (name, detail, t = k.t, data = {}) => out.push({ t, slot: k.slot, name, detail, ...data });
    if (k.type === 'calib' && S.last) { const d0 = eulerRot(S.last.euler, axis); S.yaw0 = Math.atan2(d0[1], d0[0]) / D; } // heading of the stick itself when Calibrate was pressed
    if (k.type === 'imu') {
      const d = eulerRot(k.euler, axis), w = Math.hypot(...k.gyro);
      const pos = { d, el: Math.asin(Math.max(-1, Math.min(1, d[2]))), hd: wrap(Math.atan2(d[1], d[0]) - S.yaw0 * D) };
      const gap = !S.last || k.t - S.last.t > 0.25, gdt = gap ? 0 : k.t - S.last.t;
      S.last = k;
      // the body's slow turning, taken off the gyro for the charge: walking round or turning while circling the stick must not hide the reversals
      if (gap || !S.gAvg) S.gAvg = [...k.gyro];
      const hp = k.gyro.map((g, i) => g - (S.gAvg[i] += (g - S.gAvg[i]) * Math.min(1, gdt / .4)));

      // Charge: unwrap the tilt direction of the upright stick; one full turn inside 2 s
      if (d[2] > Math.cos(45 * D) && Math.hypot(d[0], d[1]) > 0.1 && !gap) {
        const prev = S.ring.at(-1), a = Math.atan2(d[1], d[0]);
        S.ring.push({ t: k.t, raw: a, a: prev ? prev.a + wrap(a - prev.raw) : a });
        while (S.ring[0].t < k.t - 2) S.ring.shift();
        const turn = S.ring.at(-1).a - S.ring[0].a;
        if (Math.abs(turn) >= 2 * Math.PI) { emit('Charge', turn > 0 ? 'counter-clockwise (from above)' : 'clockwise (from above)'); S.ring = []; }
      } else S.ring = [];

      // Charge, gyro only (the sensor is at the base of the stick, so the angles stay small): how hard the stick moved over the last second, and the turning
      // direction changing. Measured (recordings of one player, 11/4: 20 s each): circling is about 1 turn a second, the same rhythm as walking, so the rhythm says nothing;
      // the size does: 1 s RMS of the gyro with the slow turning taken off is at most 110°/s walking without circling, 120°/s and more circling, walking or not.
      if (gap || d[2] < Math.sin((S.chargeOn ? 30 : 45) * D)) { S.rev = []; S.sign = [0, 0, 0]; S.gw = []; }
      else {
        (S.gw ??= []).push({ t: k.t, e: hp[0] ** 2 + hp[1] ** 2 + hp[2] ** 2 });
        while (S.gw[0].t < k.t - 1) S.gw.shift();
        if (Math.hypot(...hp) > 300) { S.rev = []; S.sign = [0, 0, 0]; } // a swing's speed is no reversal
        else for (let i = 0; i < 3; i++) {
          const g = hp[i];
          if (Math.abs(g) < 30) continue;
          const sg = Math.sign(g);
          if (S.sign[i] && sg !== S.sign[i]) S.rev.push(k.t);
          S.sign[i] = sg;
        }
        while (S.rev.length && S.rev[0] < k.t - 1) S.rev.shift();
      }
      const rms = S.gw?.length ? Math.sqrt(S.gw.reduce((q, w) => q + w.e, 0) / S.gw.length) : 0, seen = S.gw?.length ? k.t - S.gw[0].t : 0;
      const keepOk = S.rev.length >= 3 && rms >= CHARGE_RMS.keep, startOk = S.rev.length >= 4 && rms >= CHARGE_RMS.start && seen >= .5;
      if ((S.chargeOn ? keepOk : startOk) && k.t > S.spinCool) { // keeps firing while the circling goes on: the game drops the charge when it stops
        emit('Charge', `gyro: ${rms.toFixed(0)}°/s, ${S.rev.length} direction changes in 1 s`, k.t, { keep: S.chargeOn }); S.chargeOn = true; S.spinCool = k.t + .15; S.ring = [];
      }
      if (S.chargeOn && !keepOk && k.t - S.spinCool > 2) S.chargeOn = false; // as long as the game keeps a paused charge (2 s): resuming uses the keep rule

      // Swing: starts where the stick was last calm, ends when it slows down again
      if (gap) S.sw = null;
      if (!S.sw && w > 300 && (S.still || S.prev)) S.sw = S.still && k.t - S.still.t < .5 ? { t: S.still.t, from: S.still } : { t: S.prev.t, from: S.prev }; // right out of a charge shake there is no calm moment: start from the sample before
      if (w < 120) S.still = { ...pos, t: k.t };
      S.prev = { ...pos, t: k.t };
      if (S.sw && w > 250) S.sw.fastAt = k.t; // still moving fast: the stop must come right after this (ピタッと)
      if (S.sw && w < 100) {
        const a = S.sw.from, dur = k.t - S.sw.t, ang = Math.acos(Math.max(-1, Math.min(1, dot(a.d, d))));
        const twirl = a.el > 60 * D && pos.el > 60 * D; // stays overhead: that's charging, not a swing
        const dead = k.t - (S.sw.fastAt ?? S.sw.t) <= .12; // a sudden stop, not a slow wind-down (10/18: swing down and stop = fire)
        if (ang > 60 * D && dur < 1.2 && !twirl && dead) {
          const v = pos.el - a.el, h = wrap(pos.hd - a.hd) * Math.cos((pos.el + a.el) / 2), m = Math.hypot(v, h);
          const dir = [Math.abs(v) > 0.4 * m ? (v > 0 ? 'up' : 'down') : '', Math.abs(h) > 0.4 * m ? (h > 0 ? 'left' : 'right') : ''].filter(Boolean).join('-');
          emit('Swing', `${dir}, ${deg(ang)}° in ${(dur * 1000).toFixed(0)} ms · from ${where(a)} · stop ${where(pos)}`, k.t, { dir, power: Math.min(1, ang / dur / (1000 * D)) });
          S.chargeOn = false; S.rev = []; S.sign = [0, 0, 0]; S.gw = []; // a shot ends the charge: its speed must not read as circling
        }
        S.sw = null;
      }
      if (S.sw && k.t - S.sw.t > 1.5) S.sw = null;

      // Guard: stick level and still, reported once per hold
      if (Math.abs(d[2]) < Math.sin(45 * D) && w < 60 && !gap) {
        S.guard ??= k.t;
        if (!S.guarded && k.t - S.guard >= 1) { S.guarded = true; emit('Guard', `held 1 s · ${where(pos)}`, S.guard); }
      } else { S.guard = null; S.guarded = false; }
    }

    if (k.type === 'ar' && k.tracking === 'TRACKING' && k.wp) {
      // Dodge: a spike of the chest's sideways acceleration (across where the chest camera faces), from its horizontal velocity now and
      // DODGE_DT s ago (each over DODGE_DT s, which smooths ARCore's jitter), while it already moves that way. Walking, even fast, does
      // not do it (steady sideways speed, small acceleration); a quick sidestep does.
      S.ar.push({ t: k.t, p: k.wp });
      while (S.ar.length > 1 && S.ar[1].t <= k.t - 3 * DODGE_DT) S.ar.shift();
      const at = t => S.ar.reduce((b, s) => Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b);
      const a0 = at(k.t - 2 * DODGE_DT), a1 = at(k.t - DODGE_DT), d1 = a1.t - a0.t, d2 = k.t - a1.t;
      if (d1 > DODGE_DT / 2 && d2 > DODGE_DT / 2 && k.t - a0.t < 4 * DODGE_DT) {
        const f = qrot(k.wq, [0, 0, -1]), fwd = norm([f[0], 0, f[2]]), right = cross(fwd, [0, 1, 0]);
        const side = p => (p[0] * right[0] + p[2] * right[2]);
        const v1 = (side(a1.p) - side(a0.p)) / d1, v2 = (side(k.wp) - side(a1.p)) / d2, acc = (v2 - v1) / ((d1 + d2) / 2);
        if (!S.dodging && Math.abs(acc) > DODGE_ACC && Math.sign(acc) === Math.sign(v2) && Math.abs(v2) > .4) {
          const dir = acc > 0 ? 'right' : 'left';
          emit('Dodge', `${dir}, ${Math.abs(acc).toFixed(1)} m/s²`, k.t, { dir, side: Math.sign(acc), acc: Math.abs(acc), speed: Math.abs(v2) });
          S.dodging = true; S.dodgeAt = k.t;
        } else if (S.dodging && k.t - S.dodgeAt > .5 && Math.abs(acc) < DODGE_ACC / 3) S.dodging = false; // one dodge per sidestep
      }
    }
    return out;
  }
  return { ingest };
}
