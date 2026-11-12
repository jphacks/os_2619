// armik.js: the two bones keep their lengths, and the elbow goes where a person's does (VRArmIK's rules): down for a fist held forward and low,
// out to the side for a fist across the body, back and down for a fist by the hip; the clavicle lifts for a fist overhead; easing keeps it from flipping.
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'three' ? { url: ${JSON.stringify(new URL('./vendor/cdn/npm/three@0.160.0/build/three.module.js', import.meta.url).href)}, shortCircuit: true } : n(s, c); }`));
const THREE = await import('three'), { solveArm } = await import('./public/armik.js');
const V = (x, y, z) => new THREE.Vector3(x, y, z), fwd = V(1, 0, 0), up = V(0, 1, 0), out = V(0, 0, 1); // the right arm: out = the body's right
const root = V(0, 0, .05), shoulder = V(0, 0, .2), upper = .3, fore = .3;
const solve = (t, state = {}) => solveArm({ root, shoulder, fwd, up, out, upper, fore, target: t, state });
const rel = (r, t) => ({ e: r.elbow.clone().sub(r.shoulder.clone().lerp(t, .5)) }); // the elbow off the shoulder-fist line's middle
for (const t of [V(.4, -.2, .25), V(.3, 0, -.05), V(-.1, -.45, .3), V(.2, .4, .2), V(.25, .1, .2)]) {
  const r = solve(t);
  assert.ok(Math.abs(r.elbow.distanceTo(r.shoulder) - upper) < 1e-6, 'upper arm keeps its length');
  if (!r.stretch) assert.ok(Math.abs(r.elbow.distanceTo(t) - fore) < 1e-6, 'forearm keeps its length');
}
{ const t = V(.45, -.25, .25), { e } = rel(solve(t), t); assert.ok(e.y < -.02, 'fist forward and low: the elbow below, got ' + e.y.toFixed(3)); }
{ const t = V(.3, -.05, -.05), { e } = rel(solve(t), t); assert.ok(e.z > .03, 'fist across the body: the elbow out to the side, got ' + e.z.toFixed(3)); }
{ const t = V(.05, -.35, .25), { e } = rel(solve(t), t); assert.ok(e.x < -.01 && e.y <= .02, 'fist by the hip, near the shoulder: the elbow back, got ' + e.x.toFixed(3)); }
{ const r = solve(V(.2, .5, .2)); assert.ok(r.shoulder.y > shoulder.y + .01, 'fist overhead: the clavicle lifts the shoulder'); }
{ const t = V(.9, 0, .2), r = solve(t); assert.ok(r.shoulder.x > shoulder.x && r.stretch > 0, 'out of reach: the shoulder follows a little, the rest stretches'); }
{ // easing: a sudden jump of the fist turns the elbow over a few frames, not at once
  const st = {}; solveArm({ root, shoulder, fwd, up, out, upper, fore, target: V(.45, -.25, .25), state: st, dt: 1 / 60 });
  const a0 = st.angle; solveArm({ root, shoulder, fwd, up, out, upper, fore, target: V(.3, -.05, -.05), state: st, dt: 1 / 60 });
  const a1 = st.angle; solveArm({ root, shoulder, fwd, up, out, upper, fore, target: V(.3, -.05, -.05), state: {}, dt: 0 });
  assert.ok(Math.abs(a1 - a0) > 0 && Math.abs(a1 - a0) < 40, 'eased: part of the way in one frame, got ' + (a1 - a0).toFixed(1));
}
console.log('armik ok: lengths kept, elbow down / out / back as a person\'s, clavicle lifts overhead, shoulder follows out of reach, eased');
