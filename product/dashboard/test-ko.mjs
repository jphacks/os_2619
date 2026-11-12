// The end of a match: the character breaks at the joints (ko-shatter.js) and the show's timeline (ko-show.js).
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return s === 'three' ? { url: ${JSON.stringify(new URL('./vendor/cdn/npm/three@0.160.0/build/three.module.js', import.meta.url).href)}, shortCircuit: true } : n(s, c); }`));
const THREE = await import('three');
const { bakeTriangles, chunk, createShatter, SHATTER } = await import('./public/ko-shatter.js');
const { timeline, rankOf, KO } = await import('./public/ko-show.js');

// a two-bone skinned box: the top half on Head, the bottom half on L_Thigh, plus an unskinned stick
const geo = new THREE.BoxGeometry(.4, 1.6, .3, 1, 4, 1).translate(0, .8, 0), n = geo.attributes.position.count;
const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
for (let i = 0; i < n; i++) { si[4 * i] = geo.attributes.position.getY(i) > .8 ? 0 : 1; sw[4 * i] = 1; }
geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
const head = Object.assign(new THREE.Bone(), { name: 'Head' }), thigh = Object.assign(new THREE.Bone(), { name: 'L_Thigh' });
const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial()), root = new THREE.Group();
root.add(mesh, head, thigh); mesh.bind(new THREE.Skeleton([head, thigh]));
const stick = new THREE.Mesh(new THREE.CylinderGeometry(.02, .02, 1), new THREE.MeshBasicMaterial()); stick.position.set(.5, 1, 0); root.add(stick);
const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); hidden.visible = false; root.add(hidden);
root.position.set(2, 0, 0);

{ // one piece per body part, nothing lost, nothing hidden taken
  const baked = bakeTriangles([root]);
  assert.equal(baked.length, 2, 'the skinned body and the stick; the hidden mesh is left out');
  const pieces = chunk(baked);
  assert.equal(pieces.length, 3, 'head, thigh, stick');
  const tris = pieces.reduce((a, p) => a + p.parts.reduce((b, q) => b + q.pos.length / 9, 0), 0);
  assert.equal(tris, baked.reduce((a, b) => a + b.pos.length / 9, 0), 'every triangle in exactly one piece');
  const ys = pieces.map(p => p.center.y).sort((a, b) => a - b);
  assert.ok(ys[2] > 1 && ys[0] < .8, 'the head piece above the thigh piece');
  assert.ok(pieces.every(p => Math.abs(p.center.x - 2) < .6), 'baked in world space');
}
{ // they fly out, land on the floor, and are gone after their life
  const parent = new THREE.Group(), sh = createShatter(parent, { random: () => .5 });
  sh.burst([root], new THREE.Vector3(1.5, 1, 0), new THREE.Vector3(1, 0, 0));
  assert.equal(sh.count, 3);
  for (let t = 0; t < 1; t += 1 / 60) sh.step(1 / 60);
  for (const c of sh.group.children) assert.ok(c.position.y >= 0, 'never below the floor');
  assert.ok(sh.group.children.every(c => c.position.x > 2), 'blown away from the blow');
  for (let t = 0; t < SHATTER.life * 1.2; t += 1 / 60) sh.step(1 / 60);
  assert.equal(sh.count, 0); assert.equal(sh.group.children.length, 0);
}
{ // KO: frozen, then slow, then normal; the backdrop gone before the results; the results on the winner
  const at = t => timeline(t, true);
  assert.equal(at(.1).scale, 0, 'hit stop'); assert.ok(at(.1).zoom > 1.5, 'rushed in'); assert.equal(at(.1).k, 1); assert.equal(at(.1).burst, false);
  assert.equal(at(KO.stop + .1).scale, KO.slow, 'slow motion after the break'); assert.ok(at(KO.stop + .01).burst);
  assert.equal(at(KO.result - .1).scale, 1); assert.equal(at(KO.result - .1).k, 0, 'backdrop gone');
  assert.ok(at(KO.stamp + .1).stamp && !at(KO.result + .1).stamp, 'K.O. stamped, then the results');
  assert.equal(at(KO.result + 2).on, 'winner'); assert.ok(Math.abs(at(KO.result + 2).zoom - KO.resultZoom) < 1e-9);
  for (let t = 0; t < 5; t += .01) { const s = at(t); assert.ok(s.scale >= 0 && s.scale <= 1 && s.zoom >= 1 && s.k >= 0 && s.k <= 1, `in range at ${t}`); }
}
{ // time up: no hit stop, no backdrop
  const s = timeline(.2, false); assert.equal(s.scale, 1); assert.equal(s.k, 0); assert.ok(s.stamp);
  assert.ok(timeline(KO.timeup + .1, false).result);
}
{ // rank
  assert.equal(rankOf(null), '');
  assert.equal(rankOf({ hp: 90, hpMax: 100, hits: 5, shots: 8 }), 'S');
  assert.equal(rankOf({ hp: 90, hpMax: 100, hits: 1, shots: 8 }), 'A');
  assert.equal(rankOf({ hp: 10, hpMax: 100, hits: 1, shots: 8 }), 'C');
}
console.log('test-ko: ok (joints, flight, timeline, rank)');
