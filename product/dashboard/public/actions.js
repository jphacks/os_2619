// Action detection per player from their packets: the stick IMU (imu) and the chest phone's AR pose (ar).
// Pure logic, no DOM: the dashboard and test-actions.mjs both use it.
// Stick direction: `axis` is the IMU sensor axis along the stick: +Y, pointing to the tip (fixed in the product),
// rotated into the IMU world (z up) by the WitMotion euler angles. Heading is relative to the IMU yaw at the last Calibrate.
import { cross, dot, norm, qrot } from './map.js';

const D = Math.PI / 180;
export const ACTIONS = [
  { name: 'Charge', how: 'gyro only: starts when the turning direction changes 5+ times within 1 s past 60°/s (stick circled or shaken at the base), then keeps going while it changes 4+ times past 30°/s; slower than a swing' },
  { name: 'Swing', how: 'stick turns faster than 300°/s through more than 60° and stops dead (from over 250°/s to under 100°/s within 0.12 s); direction plus start and stop position' },
  { name: 'Dodge', how: 'chest phone moves faster than 1.2 m/s; left / right / back / forward' },
  { name: 'Guard', how: 'stick within 20° of horizontal and still (under 60°/s) for 1 s' },
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
  const st = s => P[s] ??= { yaw0: 0, last: null, ring: [], rev: [], sign: [0, 0, 0], revBig: [], signBig: [0, 0, 0], chargeOn: false, spinCool: 0, still: null, sw: null, guard: null, guarded: false, ar: [], dodging: false };

  /** Feeds one packet; returns the actions it completes as { t, slot, name, detail, ...data }.
   *  Swing adds dir ('down-left' ...) and power 0..1 (stick speed, 1 at 1000°/s); Dodge adds dir and speed (m/s). */
  function ingest(k, axis = [0, 1, 0]) {
    const S = st(k.slot), out = [], emit = (name, detail, t = k.t, data = {}) => out.push({ t, slot: k.slot, name, detail, ...data });
    if (k.type === 'calib' && S.last) { const d0 = eulerRot(S.last.euler, axis); S.yaw0 = Math.atan2(d0[1], d0[0]) / D; } // heading of the stick itself when Calibrate was pressed
    if (k.type === 'imu') {
      const d = eulerRot(k.euler, axis), w = Math.hypot(...k.gyro);
      const pos = { d, el: Math.asin(Math.max(-1, Math.min(1, d[2]))), hd: wrap(Math.atan2(d[1], d[0]) - S.yaw0 * D) };
      const gap = !S.last || k.t - S.last.t > 0.25;
      S.last = k;

      // Charge: unwrap the tilt direction of the upright stick; one full turn inside 2 s
      if (d[2] > Math.cos(45 * D) && Math.hypot(d[0], d[1]) > 0.1 && !gap) {
        const prev = S.ring.at(-1), a = Math.atan2(d[1], d[0]);
        S.ring.push({ t: k.t, raw: a, a: prev ? prev.a + wrap(a - prev.raw) : a });
        while (S.ring[0].t < k.t - 2) S.ring.shift();
        const turn = S.ring.at(-1).a - S.ring[0].a;
        if (Math.abs(turn) >= 2 * Math.PI) { emit('Charge', turn > 0 ? 'counter-clockwise (from above)' : 'clockwise (from above)'); S.ring = []; }
      } else S.ring = [];

      // Charge, gyro only (the sensor is at the base of the stick, so the angles stay small): what shows is the turning direction
      // changing again and again. Count sign reversals of each gyro axis (past a dead band) in the last second; swing speed resets it.
      // 10/18: a held stick's tremor sometimes started a charge. Starting needs bigger, more frequent reversals; keeping it does not
      if (gap || w > 300) { S.rev = []; S.sign = [0, 0, 0]; S.revBig = []; S.signBig = [0, 0, 0]; }
      else {
        for (const [rev, sign, band] of [[S.rev, S.sign, 30], [S.revBig, S.signBig, 60]]) {
          for (let i = 0; i < 3; i++) {
            const g = k.gyro[i];
            if (Math.abs(g) < band) continue;
            const sg = Math.sign(g);
            if (sign[i] && sg !== sign[i]) rev.push(k.t);
            sign[i] = sg;
          }
          while (rev.length && rev[0] < k.t - 1) rev.shift();
        }
        if ((S.chargeOn ? S.rev.length >= 4 : S.revBig.length >= 5) && k.t > S.spinCool) { // keeps firing while the shaking goes on: the game drops the charge when it stops
          emit('Charge', `gyro: ${S.rev.length} direction changes in 1 s`, k.t, { keep: S.chargeOn }); S.chargeOn = true; S.spinCool = k.t + .15; S.ring = [];
        }
      }
      if (S.chargeOn && S.rev.length < 4 && k.t - S.spinCool > 2) S.chargeOn = false; // as long as the game keeps a paused charge (2 s): resuming uses the keep rule

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
        }
        S.sw = null;
      }
      if (S.sw && k.t - S.sw.t > 1.5) S.sw = null;

      // Guard: stick level and still, reported once per hold
      if (Math.abs(d[2]) < Math.sin(20 * D) && w < 60 && !gap) {
        S.guard ??= k.t;
        if (!S.guarded && k.t - S.guard >= 1) { S.guarded = true; emit('Guard', `held 1 s · ${where(pos)}`, S.guard); }
      } else { S.guard = null; S.guarded = false; }
    }

    if (k.type === 'ar' && k.tracking === 'TRACKING' && k.wp) {
      // Dodge: horizontal chest speed over the last ~0.15 s, labelled relative to where the chest camera faces
      S.ar.push({ t: k.t, p: k.wp });
      while (S.ar.length > 1 && S.ar[1].t <= k.t - 0.15) S.ar.shift();
      const o = S.ar[0], dt = k.t - o.t;
      if (dt >= 0.1 && dt < 0.4) {
        const v = [(k.wp[0] - o.p[0]) / dt, 0, (k.wp[2] - o.p[2]) / dt], sp = Math.hypot(...v);
        if (sp > 1.2 && !S.dodging) {
          const f = qrot(k.wq, [0, 0, -1]), fwd = norm([f[0], 0, f[2]]), right = cross(fwd, [0, 1, 0]);
          const r = dot(v, right), fw = dot(v, fwd);
          const dir = Math.abs(r) > Math.abs(fw) ? (r > 0 ? 'right' : 'left') : (fw > 0 ? 'forward' : 'back');
          emit('Dodge', `${dir}, ${sp.toFixed(1)} m/s`, k.t, { dir, speed: sp });
          S.dodging = true;
        } else if (sp < 0.6) S.dodging = false; // one dodge per burst: re-arms once the chest slows down
      }
    }
    return out;
  }
  return { ingest };
}
