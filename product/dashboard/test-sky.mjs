// The clock (sky.js): the default hour is the looks' own afternoon, the day wraps, the light never drops low enough to shade the field.
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'three' ? { url: ${JSON.stringify(new URL('./vendor/cdn/npm/three@0.160.0/build/three.module.js', import.meta.url).href)}, shortCircuit: true } : n(s, c); }`));
const S = await import('./public/sky.js');
const { bakeSunlight, layout, addRock, SUN_DIR } = await import('./public/backdrop.js');
const { courtForTests: C } = await import('./public/courtyard.js');
const close = (a, b, e = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < e);
// at the default hour nothing changes: the look's own sky, sun and light
for (const anchor of [C.SUN, SUN_DIR]) {
  const t = S.timeOfDay(S.DEFAULT_HOUR, anchor);
  assert.equal(t.day, 1); assert.ok(close(t.sun, [1, 1, 1]) && close(t.amb, [1, 1, 1]));
  assert.ok(close(t.lightDir, [anchor.x, anchor.y, anchor.z]) && close(t.sunDir, [anchor.x, anchor.y, anchor.z]), 'the default sun moved');
}
// the day wraps, every value is finite, the light is always above the horizon, the night has stars and a moon above it
assert.deepEqual(S.paletteAt(0), S.paletteAt(24));
for (let h = 0; h <= 24; h += .25) {
  const t = S.timeOfDay(h, C.SUN);
  for (const k of ['hor', 'mid', 'zen', 'glow', 'cloud', 'sun', 'amb', 'haze', 'lightDir', 'sunDir', 'moonDir']) assert.ok(t[k].length === 3 && t[k].every(Number.isFinite), k + ' at ' + h);
  assert.ok(t.lightDir[1] > .3, 'the light comes from too low at ' + h);
  assert.ok(Math.abs(Math.hypot(...t.lightDir) - 1) < 1e-9);
}
assert.ok(S.timeOfDay(0, C.SUN).stars === 1 && S.timeOfDay(0, C.SUN).moonDir[1] > 0 && S.timeOfDay(12, C.SUN).stars === 0);
assert.ok(S.timeOfDay(17.6, C.SUN).sunDir[1] > 0 && S.timeOfDay(20, C.SUN).sunDir[1] < 0, 'the sun sets between 17:36 and 20:00');
assert.equal(S.clock(14), '14:00'); assert.equal(S.clock(17.75), '17:45'); assert.equal(S.clock(24), '0:00');
// the middle of the field stays in the sun at every hour, in both looks
const rock = { pos: [], idx: [], ranges: [] }; for (const r of layout().list) { const f = rock.idx.length; addRock(rock.pos, [], rock.idx, r); if (!r.far) rock.ranges.push([f, rock.idx.length]); }
const court = C.buildCourt();
for (const [name, g, ranges, ext, anchor, opt] of [['court', court, [[0, court.idx.length]], C.EXT, C.SUN, {}], ['rock', rock, rock.ranges, 64, SUN_DIR, { sweep: -1 }]]) {
  for (let h = 5; h <= 20; h += 1) {
    const L = S.timeOfDay(h, anchor, opt).lightDir, n = 128, { ground } = bakeSunlight(g.pos, g.idx, ranges, ext, n, undefined, undefined, { x: L[0], y: L[1], z: L[2] });
    for (const [x, z] of [[0, 0], [-2, 0], [2, 0], [0, -2]]) assert.ok(ground[(Math.floor((x / (2 * ext) + .5) * n) + Math.floor((z / (2 * ext) + .5) * n) * n) * 4] > 128, `${name}: a shadow on the field at ${h} h (${x}, ${z})`);
  }
}
console.log('sky ok');
