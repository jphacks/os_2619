// Self-check of server.mjs: the sensing relay protocol on /ws (slots, relay with slot tag, video framing, full server,
// slot reuse on reconnect), phone C on /cam, static files, and http + https on the same port.
// Then the pure-logic modules: actions.js and phonealign.js against fake-world.mjs (a physically consistent sim).
import assert from 'node:assert/strict';
import https from 'node:https';
import WebSocket from 'ws';
process.env.PORT = '18099';
const { server, ready } = await import('./server.mjs');
await ready;

const open = async (hello, path = '/ws') => {
  const ws = new WebSocket('ws://localhost:18099' + path), inbox = [];
  ws.on('message', (d, bin) => inbox.push(bin ? d : JSON.parse(d)));
  await new Promise(r => ws.once('open', r));
  ws.send(JSON.stringify(hello));
  return { ws, inbox };
};
const wait = (f, ms = 1000) => new Promise((res, rej) => {
  const t0 = Date.now(), i = setInterval(() => { const v = f(); if (v) { clearInterval(i); res(v); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 10);
});

// ---- phones A / B: exactly the sensing relay ----
const dash = await open({ type: 'hello', role: 'dashboard' });
const a = await open({ type: 'hello', role: 'phone', id: 'p1', name: 'one' });
assert.equal((await wait(() => a.inbox.find(k => k.type === 'welcome'))).slot, 'A');
const b = await open({ type: 'hello', role: 'phone', id: 'p2', name: 'two' });
assert.equal((await wait(() => b.inbox.find(k => k.type === 'welcome'))).slot, 'B');
const c = await open({ type: 'hello', role: 'phone', id: 'p3', name: 'three' });
await wait(() => c.inbox.find(k => k.type === 'full'));

b.ws.send(JSON.stringify({ type: 'imu', t: 1, euler: [1, 2, 3] }));
const imu = await wait(() => dash.inbox.find(k => k.type === 'imu'));
assert.equal(imu.slot, 'B'); assert.deepEqual(imu.euler, [1, 2, 3]);

const v = await open({ type: 'hello', role: 'video', id: 'p1' });
await new Promise(r => setTimeout(r, 50));
v.ws.send(Buffer.from([0xff, 0xd8, 1, 2]));
const frame = await wait(() => dash.inbox.find(k => Buffer.isBuffer(k)));
assert.deepEqual([...frame], [0x41, 0xff, 0xd8, 1, 2]); // 'A' + jpeg bytes

a.ws.send(JSON.stringify({ type: 'ping', t0: 5 }));
const pong = await wait(() => a.inbox.find(k => k.type === 'pong'));
assert.equal(pong.t0, 5); assert.ok(Math.abs(pong.ts - Date.now() / 1000) < 1);

const a2 = await open({ type: 'hello', role: 'phone', id: 'p1', name: 'one' }); // same id: keeps slot A
assert.equal((await wait(() => a2.inbox.find(k => k.type === 'welcome'))).slot, 'A');
b.ws.close(); // B leaves: slot B is free again
await wait(() => dash.inbox.some(k => k.type === 'phones' && k.list.length === 1));
const d = await open({ type: 'hello', role: 'phone', id: 'p4', name: 'four' });
assert.equal((await wait(() => d.inbox.find(k => k.type === 'welcome'))).slot, 'B');

// ---- phone C: the camera page's socket ----
const disp = await open({ type: 'hello', role: 'display', id: 'd1' }, '/cam');
await wait(() => disp.inbox.find(k => k.type === 'cams' && k.list.length === 0));
const cam = await open({ type: 'hello', role: 'cam', id: 'c1', name: 'iPhone' }, '/cam');
assert.equal((await wait(() => cam.inbox.find(k => k.type === 'welcome'))).displays, 1);
assert.equal((await wait(() => disp.inbox.find(k => k.type === 'cams' && k.list.length === 1))).list[0].name, 'iPhone');
cam.ws.send(JSON.stringify({ type: 'signal', kind: 'sdp', description: 'x' }));
const sig = await wait(() => disp.inbox.find(k => k.type === 'signal'));
assert.equal(sig.from, 'c1'); assert.equal(sig.to, 'd1');
cam.ws.send(Buffer.from([0x43, 9]));
assert.deepEqual([...await wait(() => disp.inbox.find(k => Buffer.isBuffer(k)))], [0x43, 9]);

// ---- static, info, and https on the same port ----
for (const [p, type] of [['/', /html/], ['/cam.html', /html/], ['/world.js', /javascript/], ['/actions.js', /javascript/]]) {
  const r = await fetch('http://localhost:18099' + p);
  assert.equal(r.status, 200, p); assert.match(r.headers.get('content-type'), type);
}
assert.equal((await fetch('http://localhost:18099/../server.mjs')).status, 404);
const info = await (await fetch('http://localhost:18099/info')).json();
assert.equal(info.port, 18099); assert.equal(info.phones.length, 2); assert.equal(info.cams.length, 1);
if (info.https) {
  const body = await new Promise((res, rej) => https.get('https://localhost:18099/cam.html', { rejectUnauthorized: false }, r => {
    let s = ''; r.on('data', d => s += d); r.on('end', () => res(s));
  }).on('error', rej));
  assert.match(body, /getUserMedia/);
  const ws = new WebSocket('wss://localhost:18099/ws', { rejectUnauthorized: false });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.close();
  console.log('https on the same port ok');
} else console.log('https skipped (no openssl)');
console.log('server ok');
for (const file of ['fire-lobe-v2.png','flame-tongue.png','smoke-puff.png','glow.png','spark.png']) {
  const r = await fetch('http://localhost:18099/assets/fire/' + file);
  assert.equal(r.status,200,file);
  assert.match(r.headers.get('content-type'),/image\/png/);
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10],file);
}
for (const file of ['electric-arc-v2.png','electric-burst-v2.png','glow.png','spark.png']) {
  const r = await fetch('http://localhost:18099/assets/thunder/' + file);
  assert.equal(r.status,200,file);
  assert.match(r.headers.get('content-type'),/image\/png/);
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10],file);
}
for (const file of ['aura-wisp.png','plasma-flow.png','electric-filament.png','glow.png','spark.png']) {
  const r = await fetch('http://localhost:18099/assets/charge/' + file);
  assert.equal(r.status,200,file);
  assert.match(r.headers.get('content-type'),/image\/png/);
  const bytes = new Uint8Array(await r.arrayBuffer());
  assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10],file);
}
await import('./test-fire.mjs');
await import('./test-thunder.mjs');
await import('./test-dummy.mjs');

for (const x of [dash, a, c, v, a2, d, disp, cam]) x.ws.terminate();
server.close();
await import('./test-logic.mjs');
process.exit(0);
