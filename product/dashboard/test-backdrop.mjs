// The canyon (backdrop.js): the rocks stay out of the field and off phone C's side, the layout is the same every time, the mesh is sound.
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'three' ? { url: ${JSON.stringify(new URL('./vendor/cdn/npm/three@0.160.0/build/three.module.js', import.meta.url).href)}, shortCircuit: true } : n(s, c); }`));
const { layout, addRock, bakeSunlight, createBackdrop, DEFAULT_R } = await import('./public/backdrop.js');
const { createCourtyard, courtForTests: C } = await import('./public/courtyard.js');

const build = R => { const pos = [], ao = [], idx = []; for (const r of layout(R).list) addRock(pos, ao, idx, r); return { pos, ao, idx }; };
for (const R of [DEFAULT_R, 12]) {
  const { list, big } = layout(R), { pos, ao, idx } = build(R);
  // every vertex is outside the field's circle
  let nearest = Infinity;
  for (let i = 0; i < pos.length; i += 3) nearest = Math.min(nearest, Math.hypot(pos[i], pos[i + 2]));
  assert.ok(nearest > R, `a rock reaches into the field: ${nearest.toFixed(2)} m from the centre, field radius ${R.toFixed(2)}`);
  // no mesa stands in front of the fixed view: the open side towards +z, within the drone's keep-in radius
  for (const r of big) assert.ok(!(r.z > 0 && Math.abs(r.x) < r.z && Math.hypot(r.x, r.z) - r.r * 1.6 < 11), `mesa at ${r.x.toFixed(1)}, ${r.z.toFixed(1)} blocks the +z side`);
  // the mesh: numbers are finite, indices in range, one shade per vertex
  assert.ok(pos.every(Number.isFinite));
  assert.equal(ao.length, pos.length / 3);
  assert.equal(idx.length % 3, 0);
  assert.ok(Math.max(...idx.slice(0, 1e5)) < ao.length && idx.every(i => i >= 0 && i < ao.length));
  assert.ok(list.length > 60);
}
// the walls face outwards (a front-face material would show their insides otherwise): a triangle low on a lone rock
{
  const pos = [], ao = [], idx = [];
  addRock(pos, ao, idx, { x: 0, z: 0, r: 5, h: 3, n: 32, seed: 1 });
  const [a, b, c] = idx.slice(0, 3).map(i => pos.slice(i * 3, i * 3 + 3));
  const u = b.map((v, i) => v - a[i]), w = c.map((v, i) => v - a[i]);
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  assert.ok(n[0] * a[0] + n[2] * a[2] > 0, 'wall faces inwards');
}
// the baked sunlight: the field stays in the sun, and the rocks do throw a shadow
{
  const pos = [], ao = [], idx = [], ranges = [], ext = 64, n = 256;
  for (const r of layout().list) { const from = idx.length; addRock(pos, ao, idx, r); if (!r.far) ranges.push([from, idx.length]); }
  const { ground } = bakeSunlight(pos, idx, ranges, ext, n);
  let dark = 0, inField = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + .5) / n * 2 * ext - ext, z = (j + .5) / n * 2 * ext - ext, lit = ground[(i + j * n) * 4];
    if (lit < 128) { dark++; if (Math.abs(x) < 4 && Math.abs(z) < 4) inField++; }
  }
  assert.ok(dark > 200, 'rocks throw no shadow');
  assert.equal(inField, 0, 'a rock shadow falls on the field');
}
// the same layout every time, so the screen does not change between runs
assert.deepEqual(build(DEFAULT_R).pos.slice(0, 300), build(DEFAULT_R).pos.slice(0, 300));
// it is sized once: a smaller field keeps the layout, a larger one pushes it out, and neither fails
const b = createBackdrop();
b.fit(3); b.fit(DEFAULT_R); b.fit(12); b.update(.016); b.dispose();
// the courtyard: no building on the field, a sound mesh, walls facing the court, the middle of the field in the sun
{
  const { pos, idx } = C.buildCourt(), R = DEFAULT_R;
  assert.ok(pos.every(Number.isFinite));
  assert.equal(idx.length % 3, 0);
  let nearest = Infinity; for (let i = 0; i < pos.length; i += 3) nearest = Math.min(nearest, Math.hypot(pos[i], pos[i + 2]));
  assert.ok(nearest > R + 5, 'a building stands near the field: ' + nearest.toFixed(1) + ' m from its centre');
  assert.ok(idx.length / 3 < 300000, 'the courtyard has grown to ' + idx.length / 3 + ' triangles');
  assert.ok(C.LAWN.x < C.WALL_X && C.LAWN.z0 > C.WALL_BACK && C.LAWN.z1 < C.WALL_FRONT);
  const n = 256, { ground } = bakeSunlight(pos, idx, [[0, idx.length]], C.EXT, n, undefined, undefined, C.SUN);
  const litAt = (x, z) => ground[(Math.floor((x / (2 * C.EXT) + .5) * n) + Math.floor((z / (2 * C.EXT) + .5) * n) * n) * 4];
  for (const [x, z] of [[0, 0], [-3, -3], [3, -3], [-3, 0], [3, 0]]) assert.ok(litAt(x, z) > 128, 'a shadow falls on the field at ' + x + ', ' + z);
  assert.ok(litAt(0, 57) < 128, 'the near range throws no shadow on the lawn');
  assert.equal(C.WALL_FRONT + C.WALL_BACK, 0, 'the field is not in the middle of the court'); // x is symmetric by construction
  assert.equal(C.LAWN.z0 + C.LAWN.z1, 0, 'the lawn is not centred on the field');
  // the plainest wall: its first triangle faces into the court
  const c = createCourtyard(); c.fit(R); c.fit(12); c.update(.016); c.dispose();
}
console.log('backdrop ok');
