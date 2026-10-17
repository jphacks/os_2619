// Self-check: slot assignment, relay with slot tag, video framing, full server, slot reuse on reconnect.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
process.env.PORT = '18099';
const { server, wss } = await import('./server.mjs');
await new Promise(r => server.listening ? r() : server.once('listening', r));

const url = 'ws://localhost:18099/ws';
const open = async (hello) => {
  const ws = new WebSocket(url), inbox = [];
  ws.on('message', (d, bin) => inbox.push(bin ? d : JSON.parse(d)));
  await new Promise(r => ws.once('open', r));
  ws.send(JSON.stringify(hello));
  return { ws, inbox };
};
const wait = (f, ms = 1000) => new Promise((res, rej) => {
  const t0 = Date.now(), i = setInterval(() => { const v = f(); if (v) { clearInterval(i); res(v); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 10);
});

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

const pong = await (async () => { a.ws.send(JSON.stringify({ type: 'ping', t0: 5 })); return wait(() => a.inbox.find(k => k.type === 'pong')); })();
assert.equal(pong.t0, 5); assert.ok(Math.abs(pong.ts - Date.now() / 1000) < 1);

// phone A reconnects with the same id: keeps slot A, old socket is dropped
const a2 = await open({ type: 'hello', role: 'phone', id: 'p1', name: 'one' });
assert.equal((await wait(() => a2.inbox.find(k => k.type === 'welcome'))).slot, 'A');
// B leaves: slot B becomes free for a new phone
b.ws.close();
await wait(() => dash.inbox.some(k => k.type === 'phones' && k.list.length === 1));
const d = await open({ type: 'hello', role: 'phone', id: 'p4', name: 'four' });
assert.equal((await wait(() => d.inbox.find(k => k.type === 'welcome'))).slot, 'B');

const js = await fetch('http://localhost:18099/map.js');
assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);

console.log('server ok');
for (const x of wss.clients) x.terminate();
server.close(); process.exit(0);
