// The sword swing sound's trigger (swing-sense.js): one sound per burst of turning, at its peak, sized by the peak; held, slow and gappy input stay quiet.
import assert from 'node:assert/strict';
import { createSwingSense, SWING_DEFAULT as C } from './public/swing-sense.js';

const run = (sense, speeds, t0 = 0, dt = .01, slot = 'A') => speeds.flatMap((w, i) => { const e = sense.ingest({ type: 'imu', slot, t: t0 + i * dt, gyro: [w, 0, 0] }); return e ? [e] : []; });
const ON = () => ({ ...C, on: true }); // the sound switched on (off by default, 11/13)
const burst = (peak, n = 10) => [...Array.from({ length: n }, (_, i) => peak * (i + 1) / n), ...Array.from({ length: n }, (_, i) => peak * (1 - (i + 1) / n))];

{ // one swing, one sound, at its peak, sized by it
  for (const [peak, tier] of [[C.s + 20, 's'], [C.m + 20, 'm'], [C.l + 50, 'l']]) {
    const e = run(createSwingSense(ON), burst(peak));
    assert.equal(e.length, 1, `one sound for ${peak}`); assert.equal(e[0].tier, tier); assert.ok(Math.abs(e[0].peak - peak) < 1e-9);
    assert.ok(e[0].t > .09 && e[0].t < .13, 'right after the peak');
  }
}
{ // slow turning: nothing
  assert.equal(run(createSwingSense(ON), burst(C.s - 30)).length, 0);
}
{ // two swings in a row, each heard; a wobble at the top is not a second swing
  const e = run(createSwingSense(ON), [...burst(700), 20, 20, ...burst(700)]);
  assert.equal(e.length, 2);
  const wob = run(createSwingSense(ON), [100, 400, 650, 640, 660, 300, 50]);
  assert.equal(wob.length, 1);
}
{ // held fast (a spin): one sound, then quiet until it slows down
  const e = run(createSwingSense(ON), [100, 500, 800, 700, 650, 640, 660, 650, 700, 650]);
  assert.equal(e.length, 1);
}
{ // switched off: quiet; the players are apart
  assert.equal(run(createSwingSense(() => ({ on: false })), burst(900)).length, 0);
  assert.equal(run(createSwingSense(), burst(900)).length, 0, 'off by default');
  const s = createSwingSense(ON); run(s, burst(900), 0, .01, 'A');
  assert.equal(run(s, burst(900), 0, .01, 'B').length, 1, 'B has its own swing');
}
{ // the lines follow the settings
  const s = createSwingSense(() => ({ on: true, s: 100, m: 200, l: 300 }));
  assert.equal(run(s, burst(320))[0].tier, 'l');
}
console.log('test-swing: ok (one per swing, sized by its peak, quiet when slow / off)');
