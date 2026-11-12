// Self-check of the saved sticks: volume → power / speed (stick-stats.js), and the /sticks endpoints with the 'stick' / 'sticks' messages.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stickVolume, statsFromVolume, stickElement, REF_VOLUME, ELEMENTS } from './public/stick-stats.js';

// a straight stick of length L and radius r (m) as a v 3 model: a cylinder of π r² L
const rod = (L, r, n = 9) => ({ v: 3, length: L, r: [r, r], tip: n - 1, nodes: Array.from({ length: n }, (_, i) => [0, -L / 2 + L * i / (n - 1)]), edges: Array.from({ length: n - 1 }, (_, i) => [i, i + 1]) });
// ---- volume ----
assert.ok(Math.abs(stickVolume(rod(1, .01)) - Math.PI * 1e-4) < 1e-9, 'cylinder volume');
const Y = rod(.9, .01); Y.nodes.push([.15, .1]); Y.edges.push([4, 9]); // a branch from the middle
assert.ok(stickVolume(Y) > stickVolume(rod(.9, .01)), 'a branch adds wood');
{ const t = rod(1, .01); t.r = [.02, .01]; assert.ok(Math.abs(stickVolume(t) - Math.PI / 3 * (4e-4 + 2e-4 + 1e-4)) < 1e-9, 'taper: a cone frustum'); }
// ---- balance: bigger is stronger and slower, power x speed² the same for every stick, ×1 at REF_VOLUME ----
assert.deepEqual(statsFromVolume(REF_VOLUME), { power: 1, speed: 1 });
let last = null;
for (const cm3 of [20, 80, 150, 250, 350, 500, 800, 1400, 3000]) {
  const s = statsFromVolume(cm3 * 1e-6);
  if (last) { assert.ok(s.power >= last.power, `${cm3} cm³ hits at least as hard`); assert.ok(s.speed <= last.speed, `${cm3} cm³ is not faster`); }
  assert.ok(Math.abs(s.power * s.speed ** 2 - 1) < .03, `${cm3} cm³: power × speed² = ${(s.power * s.speed ** 2).toFixed(3)}`);
  assert.ok(s.power >= .65 && s.power <= 1.55 && s.speed >= .8 && s.speed <= 1.25, `${cm3} cm³ in range: ${JSON.stringify(s)}`);
  last = s;
}
assert.ok(statsFromVolume(1400e-6).speed > .8, 'a big stick is only a little slower');
const seen = new Set(); for (let seed = 0; seed < 200; seed++) { assert.equal(stickElement(seed), stickElement(seed)); seen.add(stickElement(seed)); }
assert.equal(seen.size, ELEMENTS.length);
console.log('stick stats ok');

// ---- server: /sticks round trip (data and rules in a temp folder) ----
const dir = mkdtempSync(join(tmpdir(), 'sticks-'));
process.env.PORT = '18098'; process.env.DATA_DIR = dir; process.env.RULES_FILE = join(dir, 'rules.json'); process.env.NO_TLS = '1';
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
await wait(() => inbox.find(k => k.type === 'stick' && k.slot === 'A' && k.model === null)); // on hello: each slot's model
const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64');
// a built model for slot A: saved, assigned to A, its model sent to the pages
const big = rod(1, .015), small = rod(.8, .006);
let r = await json('/sticks', { model: big, image: jpeg, slot: 'A' });
assert.equal(r.status, 200);
const rec = await r.json();
assert.match(rec.id, /^[a-z0-9]{8,32}$/); assert.ok(rec.name.length > 0); assert.ok(ELEMENTS.includes(rec.element)); assert.equal(rec.element, stickElement(rec.seed));
assert.deepEqual(rec.stats, statsFromVolume(stickVolume(big))); assert.equal(rec.volume, Math.round(stickVolume(big) * 1e6));
assert.equal(rec.image, `/sticks/img/${rec.id}.jpg`);
const pic = await fetch(base + rec.image); assert.equal(pic.status, 200); assert.match(pic.headers.get('content-type'), /jpeg/);
let k = await wait(() => inbox.find(k => k.type === 'sticks' && k.A?.id === rec.id));
assert.deepEqual(k.A.stats, rec.stats);
await wait(() => inbox.find(k => k.type === 'stick' && k.slot === 'A' && k.model?.length === 1));
// one without a slot or a photo: saved only
const rec2 = await (await json('/sticks', { name: '細い枝', model: small })).json();
assert.equal(rec2.name, '細い枝'); assert.equal(rec2.image, undefined);
assert.ok(rec2.stats.power < rec.stats.power && rec2.stats.speed > rec.stats.speed, 'the thin stick is weaker and faster');
assert.equal((await (await json('/sticks/assign')).json()).B, null);
// trust boundary
assert.equal((await json('/sticks', { model: { ...big, v: 2 } })).status, 400);
assert.equal((await json('/sticks', { model: { ...big, edges: [[0, 99]] } })).status, 400);
assert.equal((await json('/sticks', { model: big, slot: 'C' })).status, 400);
assert.equal((await json('/sticks', { model: big, image: 'data:image/png;base64,AAAA' })).status, 400);
assert.equal((await json('/sticks', { model: big, image: 'data:image/jpeg;base64,' + 'A'.repeat(1.6e6) })).status, 413);
assert.equal((await json('/sticks/img/..%2Fx.jpg')).status, 404);
assert.equal((await json('/sticks/assign', { A: 'nope' })).status, 400);
assert.equal((await (await json('/sticks')).json()).length, 2);
// assigning sends the slot's model too
r = await json('/sticks/assign', { B: rec2.id }); assert.equal(r.status, 200);
await wait(() => inbox.find(k => k.type === 'sticks' && k.A?.id === rec.id && k.B?.id === rec2.id));
await wait(() => inbox.find(k => k.type === 'stick' && k.slot === 'B' && k.model?.length === .8));
{ // editing by hand: element and stats stick; out-of-range stats are clamped; old keys are ignored; null goes back to the volume's
  let e = await (await json('/sticks/' + rec.id, { element: 'wind', stats: { power: 9, speed: .1 } }, 'PATCH')).json();
  assert.equal(e.element, 'wind'); assert.deepEqual(e.stats, { power: 2, speed: .5 });
  const as = await (await json('/sticks/assign')).json(); assert.equal(as.A.stats.power, 2); // the players' sticks carry the edit
  assert.equal((await json('/sticks/' + rec.id, { element: 'earth' }, 'PATCH')).status, 400);
  assert.equal((await json('/sticks/' + rec.id, { stats: { power: 1 } }, 'PATCH')).status, 400);
  e = await (await json('/sticks/' + rec.id, { stats: null }, 'PATCH')).json(); assert.equal(e.custom, undefined); assert.deepEqual(e.stats, rec.stats);
}
// deleting an assigned stick frees its slot and its model
assert.equal((await json('/sticks/' + rec2.id, undefined, 'DELETE')).status, 200);
await wait(() => inbox.find(k => k.type === 'sticks' && k.A?.id === rec.id && k.B === null));
await wait(() => inbox.filter(k => k.type === 'stick' && k.slot === 'B').at(-1)?.model === null);
assert.equal((await (await json('/sticks')).json()).length, 1);
// a phone gets its slot's model on hello
const phone = new WebSocket('ws://localhost:18098/ws'), pin = [];
phone.on('message', d => pin.push(JSON.parse(d)));
await new Promise(r => phone.once('open', r));
phone.send(JSON.stringify({ type: 'hello', role: 'phone', id: 'p1', name: 'test' }));
await wait(() => pin.find(k => k.type === 'stick' && k.slot === 'A' && k.model?.length === 1));
console.log('sticks server ok');

phone.terminate(); dash.terminate(); server.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
