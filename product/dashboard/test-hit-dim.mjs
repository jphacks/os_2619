// The background's darkening around a 大 shot (hit-dim.js): dark as it leaves, lighter once it has flown far, darker at once at the hit, and always back to nothing.
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'three' ? { url: ${JSON.stringify(new URL('./vendor/cdn/npm/three@0.160.0/build/three.module.js', import.meta.url).href)}, shortCircuit: true } : n(s, c); }`));
const THREE = await import('three');
const { createHitDim, DIM } = await import('./public/hit-dim.js');
const V = x => new THREE.Vector3(x, 1, 0), near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m}: ${a}, expected ${b}`);
const run = (d, sec, dt = 1 / 60) => { for (let t = 0; t < sec; t += dt) d.step(dt); };

{ // nothing flying, nothing dark
  const d = createHitDim(); run(d, 1); near(d.level, 0, 'idle');
}
{ // it leaves: up to cast within the rise, not at once
  const d = createHitDim(); d.shot(1, V(0));
  d.step(DIM.rise / 2); near(d.level, DIM.cast / 2, 'half the rise');
  run(d, DIM.rise); near(d.level, DIM.cast, 'after the rise');
}
{ // unchanged up to 4 m, then 10 % lighter a metre: the distance decides, however long it took
  const at = (x, sec) => { const d = createHitDim(); d.shot(1, V(0)); run(d, .2); d.move(1, V(x)); run(d, sec); return d.level; };
  near(at(2, 1), .6, 'at 2 m');
  near(at(4, 1), .6, 'at 4 m');
  near(at(5, 1), .5, 'at 5 m');
  near(at(5, 3), .5, 'at 5 m, a slower ball');
  near(at(9, 1), .1, 'at 9 m');
  near(at(10, 1), 0, 'at 10 m');
  near(at(12, 1), 0, 'past 10 m');
}
{ // a curved path counts along the path, not as the straight line back to the start
  const d = createHitDim(); d.shot(1, V(0)); run(d, .2);
  d.move(1, V(3)); d.move(1, V(0)); run(d, 1); near(d.level, .4, 'there and back');
}
{ // a hit: all at once, then back over 2 s
  const d = createHitDim(); d.shot(1, V(0)); run(d, .2);
  d.hit(); d.end(1); near(d.level, .9, 'at the hit');
  d.step(1); near(d.level, .45, 'half way back, at 1 s');
  d.step(1.01); near(d.level, 0, 'back, at 2 s');
}
{ // into the floor early: gone within the fall, no jump
  const d = createHitDim(); d.shot(1, V(0)); run(d, .2); d.end(1);
  d.step(DIM.fall / 2); near(d.level, DIM.cast / 2, 'half way down');
  d.step(DIM.fall / 2 + .01); near(d.level, 0, 'gone');
}
{ // two at once: the darker one, never the sum
  const d = createHitDim(); d.shot(1, V(0)); d.shot(2, V(0)); run(d, .2); near(d.level, DIM.cast, 'two flying');
  d.hit(); d.hit(); near(d.level, DIM.hit, 'two hits');
  d.end(1); d.end(2); run(d, DIM.back + .1); near(d.level, 0, 'both gone');
}
console.log('test-hit-dim: ok');
