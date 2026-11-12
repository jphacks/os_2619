// The sword swing heard on the player's own phone: every fast turn of the stick, as the system sees it (the stick IMU's gyro, °/s), plays a
// "ヒュッ" on that player's phone (app.js, swing.wav), louder for a bigger swing. It is feedback that the movement got through, not a game
// action: it sounds in any phase, and whether a shot comes out is still actions.js's Swing (fast, far and stopped dead).
// A swing is one burst of turning: it starts when the speed passes the 小 line, and is heard at its peak (as the speed starts to fall),
// sized by that peak against the 中 and 大 lines. It re-arms once the stick slows below half the 小 line.
// Pure logic, no DOM: app.js and test-swing.mjs both use it.

export const SWING_DEFAULT = { on: true, s: 250, m: 550, l: 900, gap: .18 }; // °/s: the lines of 小 / 中 / 大; gap: s at least between two swings
export const SWING_GAIN = { s: .35, m: .65, l: 1 };                       // how loud each size plays on the phone (the same file)
export const ATTACK_SPEED = 300;                                           // °/s: actions.js's Swing starts above this (a shot also needs 60° and a dead stop)

/** createSwingSense(getCfg) -> { ingest(k) -> null | { slot, tier, peak, t }, speed(slot) -> latest °/s, peak(slot) -> { tier, peak, t } | null } */
export function createSwingSense(getCfg = () => SWING_DEFAULT) {
  const S = {};
  const st = slot => S[slot] ??= { w: 0, t: -9, burst: null, armed: true, lastAt: -9, last: null };
  return {
    ingest(k) {
      if (k?.type !== 'imu' || !Array.isArray(k.gyro)) return null;
      const c = { ...SWING_DEFAULT, ...getCfg() }, s = st(k.slot), w = Math.hypot(...k.gyro);
      const gap = k.t - s.t > .25; s.w = w; s.t = k.t;
      if (gap) { s.burst = null; s.armed = true; }
      if (!s.armed) { if (w < c.s / 2) s.armed = true; return null; }
      if (!s.burst) { if (w >= c.s && k.t - s.lastAt >= c.gap) s.burst = { peak: w }; return null; }
      if (w > s.burst.peak) { s.burst.peak = w; return null; }
      if (w > s.burst.peak * .92) return null; // still at the top: wait for it to start falling
      const peak = s.burst.peak, tier = peak >= c.l ? 'l' : peak >= c.m ? 'm' : 's';
      s.burst = null; s.armed = false; s.lastAt = k.t;
      if (!c.on) return null;
      return s.last = { slot: k.slot, tier, peak, t: k.t };
    },
    speed: slot => S[slot]?.w ?? 0,
    peak: slot => S[slot]?.last ?? null,
  };
}
