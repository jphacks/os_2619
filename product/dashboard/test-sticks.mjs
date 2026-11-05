// Self-check of the stick scan: shape analysis on synthetic photos, seed → element / stats, and the /sticks endpoints.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeStick } from './public/stick-analyze.js';
import { stickStats, stickElement, stickRarity, ELEMENTS, STATS } from './public/stick-stats.js';

// ---- shape: a plain floor with brown capsules drawn on it ----
const img = (W, H, segs) => {
  const d = new Uint8ClampedArray(W * H * 4); let s = 1;
  for (let i = 0; i < W * H; i++) { s = (s * 16807) % 2147483647; const n = s % 15; d.set([200 + n, 190 + n, 170 + n, 255], i * 4); }
  for (const [x0, y0, x1, y1, r] of segs) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const vx = x1 - x0, vy = y1 - y0, t = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / (vx * vx + vy * vy)));
    if (Math.hypot(x - x0 - t * vx, y - y0 - t * vy) <= r) d.set([90, 60, 30, 255], (y * W + x) * 4);
  }
  return { data: d, width: W, height: H };
};
const poly = (pts, r) => pts.slice(1).map((p, i) => [...pts[i], ...p, r]);
const wave = Array.from({ length: 21 }, (_, i) => [40 + i * 16, 150 + 60 * Math.sin(i / 3)]);
const shapes = {
  straight: [[60, 150, 340, 150, 10]],
  thin: [[30, 150, 370, 160, 4]],
  Y: [[200, 280, 200, 150, 8], [200, 150, 110, 40, 8], [200, 150, 300, 40, 8]],
  curvyFork: [...poly(wave, 6), [...wave[6], 180, 30, 5], [...wave[16], 330, 280, 5]],
};
const res = Object.fromEntries(Object.entries(shapes).map(([k, segs]) => [k, analyzeStick(img(400, 300, segs))]));
for (const [k, r] of Object.entries(res)) console.log(k.padEnd(10), r.shapeScore, JSON.stringify(r.features));
assert.equal(res.straight.features.branches, 0);
assert.equal(res.Y.features.branches, 1);
assert.ok(res.curvyFork.features.branches >= 2);
assert.ok(res.straight.shapeScore < res.Y.shapeScore && res.thin.shapeScore < res.Y.shapeScore);
assert.ok(res.Y.shapeScore < res.curvyFork.shapeScore);
assert.ok(res.curvyFork.features.tortuosity > 1.2);
// rarity before luck: straight ★1–2, Y ★3+
for (const seed of [1, 2, 3, 4, 99, 12345]) {
  assert.ok(stickRarity(seed, res.straight.shapeScore) <= 2);
  assert.ok(stickRarity(seed, res.thin.shapeScore) <= 3);
  assert.ok(stickRarity(seed, res.curvyFork.shapeScore) >= 3);
}

// ---- seed → element, stats ----
const seen = new Set();
for (let i = 0; i < 400; i++) {
  const seed = (Math.random() * 2 ** 32) >>> 0, rarity = 1 + i % 5, mul = [.7, .9, 1, 1.15, 1.3];
  assert.equal(stickElement(seed), stickElement(seed)); seen.add(stickElement(seed));
  const s = stickStats(seed, rarity, mul);
  assert.deepEqual(s, stickStats(seed, rarity, mul));
  assert.deepEqual(Object.keys(s), STATS);
  for (const v of Object.values(s)) assert.ok(v >= .7 && v <= 1.3, v);
  assert.ok(Math.abs(Object.values(s).reduce((a, b) => a + b) / 4 - mul[rarity - 1]) < 1e-9);
}
assert.equal(seen.size, ELEMENTS.length);
assert.ok(new Set([1, 2, 3].map(seed => stickStats(seed, 3).power)).size === 3, 'same rarity, different seed → different stats');
const flat = stickStats(7, 2, [1, 1, 1, 1, 1]); assert.ok(Math.max(...Object.values(flat)) > 1.05); // spread even when the mean is 1
const wild = stickStats(7, 5, [1, 1, 1, 1, 9]); for (const v of Object.values(wild)) assert.equal(v, 1.3); // 9 is clamped to 1.3
assert.deepEqual(stickStats(7, 1, 'junk'), stickStats(7, 1)); // bad rarityMul → defaults
console.log('stick analysis + stats ok');

// ---- server: /sticks round trip (data and rules in a temp folder) ----
const dir = mkdtempSync(join(tmpdir(), 'sticks-'));
process.env.PORT = '18098'; process.env.DATA_DIR = dir; process.env.RULES_FILE = join(dir, 'rules.json'); process.env.NO_TLS = '1';
writeFileSync(process.env.RULES_FILE, JSON.stringify({ hp: 80, rarityMul: [1, 1, 1, 1, 1] }));
const { server, ready } = await import('./server.mjs');
await ready;
const { default: WebSocket } = await import('ws');
const base = 'http://localhost:18098';
const json = (p, body, method = body ? 'POST' : 'GET') => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const dash = new WebSocket('ws://localhost:18098/ws'), inbox = [];
dash.on('message', d => inbox.push(JSON.parse(d)));
await new Promise(r => dash.once('open', r));
dash.send(JSON.stringify({ type: 'hello', role: 'dashboard', id: 'd' }));
const wait = (f, ms = 1000) => new Promise((ok, no) => { const t0 = Date.now(), i = setInterval(() => { const v = f(); if (v) { clearInterval(i); ok(v); } else if (Date.now() - t0 > ms) { clearInterval(i); no(new Error('timeout')); } }, 10); });
await wait(() => inbox.find(k => k.type === 'sticks' && k.A === null && k.B === null));

const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64');
let r = await json('/sticks', { name: 'Yの枝', features: res.Y.features, image: jpeg });
assert.equal(r.status, 200);
const rec = await r.json();
assert.match(rec.id, /^[a-z0-9]{8,32}$/); assert.equal(rec.name, 'Yの枝'); assert.ok(ELEMENTS.includes(rec.element));
assert.equal(rec.element, stickElement(rec.seed)); assert.equal(rec.rarity, stickRarity(rec.seed, res.Y.shapeScore));
assert.deepEqual(rec.stats, stickStats(rec.seed, rec.rarity));
assert.equal(rec.image, `/sticks/img/${rec.id}.jpg`);
const pic = await fetch(base + rec.image); assert.equal(pic.status, 200); assert.match(pic.headers.get('content-type'), /jpeg/);
const rec2 = await (await json('/sticks', { features: res.straight.features, image: jpeg })).json();
assert.notEqual(rec2.seed, rec.seed); assert.ok(rec2.name.length > 0);
// trust boundary
assert.equal((await json('/sticks', { features: { ...res.Y.features, branches: -1 }, image: jpeg })).status, 400);
{ // a busy or empty photo is clamped, not refused (it was a 400 on a real photo)
  const r = await json('/sticks', { features: { ...res.Y.features, branches: 80, ends: 140, tortuosity: 0 }, image: jpeg });
  assert.equal(r.status, 200); const k = await r.json();
  assert.equal(k.features.branches, 50); assert.equal(k.features.tortuosity, 1);
  await fetch(base + '/sticks/' + k.id, { method: 'DELETE' });
}
assert.equal((await json('/sticks', { features: res.Y.features, image: 'data:image/png;base64,AAAA' })).status, 400);
assert.equal((await json('/sticks', { features: res.Y.features, image: 'data:image/jpeg;base64,' + 'A'.repeat(1.6e6) })).status, 413);
assert.equal((await json('/sticks/img/..%2Fx.jpg')).status, 404);
assert.equal((await json('/sticks/assign', { A: 'nope' })).status, 400);

assert.equal((await (await json('/sticks')).json()).length, 2);
r = await json('/sticks/assign', { A: rec.id, B: rec2.id }); assert.equal(r.status, 200);

let k = await wait(() => inbox.find(k => k.type === 'sticks' && k.A?.id === rec.id && k.B?.id === rec2.id));
assert.deepEqual(k.A.stats, rec.stats);
// changing rarityMul (through /rules, keeping the other keys) recomputes the saved sticks' stats and tells the dashboards
const mul = [1.2, 1.2, 1.2, 1.2, 1.2];
assert.equal((await json('/rules', { hp: 80, rarityMul: mul })).status, 200);
k = await wait(() => inbox.find(k => k.type === 'sticks' && k.A?.stats.hp === stickStats(rec.seed, rec.rarity, mul).hp));
assert.deepEqual((await (await json('/sticks')).json()).find(s => s.id === rec.id).stats, stickStats(rec.seed, rec.rarity, mul));
assert.deepEqual(await (await json('/sticks/assign')).json(), { A: { ...rec, stats: stickStats(rec.seed, rec.rarity, mul) }, B: { ...rec2, stats: stickStats(rec2.seed, rec2.rarity, mul) } });
// the dashboard's own save (no rarityMul in the body) keeps the one sticks.html set
assert.equal((await json('/rules', { hp: 90 })).status, 200);
assert.deepEqual((await (await json('/rules')).json()).rarityMul, mul);
// deleting an assigned stick frees its slot
assert.equal((await json('/sticks/' + rec2.id, undefined, 'DELETE')).status, 200);
await wait(() => inbox.find(k => k.type === 'sticks' && k.A?.id === rec.id && k.B === null));
assert.equal((await fetch(base + rec2.image)).status, 404);
assert.equal((await json('/sticks/assign', { B: null })).status, 200);
assert.equal((await (await json('/sticks')).json()).length, 1);
{ // editing by hand: element, rarity and stats stick; out-of-range stats are clamped; null goes back to the rolled ones
  let e = await (await json('/sticks/' + rec.id, { element: 'wind', rarity: 5, stats: { hp: 1.8, power: 9, speed: .1, charge: 1 } }, 'PATCH')).json();
  assert.equal(e.element, 'wind'); assert.equal(e.rarity, 5); assert.deepEqual(e.stats, { hp: 1.8, power: 2, speed: .5, charge: 1 });
  const as = await (await json('/sticks/assign')).json(); assert.equal(as.A.stats.hp, 1.8); // the players' sticks carry the edit
  assert.equal((await json('/sticks/' + rec.id, { element: 'earth' }, 'PATCH')).status, 400);
  assert.equal((await json('/sticks/' + rec.id, { rarity: 6 }, 'PATCH')).status, 400);
  e = await (await json('/sticks/' + rec.id, { stats: null }, 'PATCH')).json(); assert.equal(e.custom, undefined); assert.notEqual(e.stats.hp, 1.8);
}
console.log('sticks server ok');

dash.terminate(); server.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
