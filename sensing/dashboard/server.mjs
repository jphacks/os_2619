// Phones connect here over WebSocket; their packets are relayed to every open dashboard.
// Run: node server.mjs   then open http://localhost:8000
import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';

const PORT = +process.env.PORT || 8000;
const SLOTS = ['A', 'B'];
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/map.js': ['map.js', 'text/javascript; charset=utf-8'] };

const server = http.createServer(async (req, res) => {
  const f = files[new URL(req.url, 'http://x').pathname];
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': f[1] }).end(await readFile(new URL(f[0], import.meta.url)));
});

const phones = new Map(); // phone id -> { slot, name, ws, seen }
const dashboards = new Set();
const send = (ws, k) => ws.readyState === 1 && ws.send(JSON.stringify(k));
const toDashboards = (data, video) => {
  for (const d of dashboards) if (d.readyState === 1 && !(video && d.bufferedAmount > 2e6)) d.send(data); // slow dashboard: skip frames, never sensor data
};
const status = () => toDashboards(JSON.stringify({ type: 'phones', list: [...phones.values()].map(({ slot, name }) => ({ slot, name })) }));

export const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
wss.on('connection', (ws, req) => {
  let role = null, id = null;
  ws.on('message', (data, isBinary) => {
    const p = id && phones.get(id);
    if (isBinary) {
      if (role === 'video' && p) toDashboards(Buffer.concat([Buffer.from(p.slot), data]), true); // first byte = slot
      return;
    }
    let k;
    try { k = JSON.parse(data); } catch { return; }
    if (k.type === 'ping') {
      if (p && p.ws === ws) p.seen = Date.now();
      return send(ws, { type: 'pong', t0: k.t0, ts: Date.now() / 1000 });
    }
    if (k.type === 'hello') {
      role = String(k.role); id = String(k.id).slice(0, 64);
      if (role === 'dashboard') { dashboards.add(ws); return status(); }
      if (role !== 'phone') return;
      const old = phones.get(id); // same phone reconnecting keeps its slot
      const slot = old?.slot ?? SLOTS.find(s => ![...phones.values()].some(q => q.slot === s));
      if (!slot) { send(ws, { type: 'full' }); return ws.close(); }
      old?.ws.terminate();
      phones.set(id, { slot, name: String(k.name).slice(0, 40), ws, seen: Date.now() });
      console.log(`phone ${slot} (${k.name}) connected from ${req.socket.remoteAddress}`);
      send(ws, { type: 'welcome', slot });
      return status();
    }
    if (role === 'phone' && p && p.ws === ws) { p.seen = Date.now(); k.slot = p.slot; toDashboards(JSON.stringify(k)); }
  });
  ws.on('close', () => {
    dashboards.delete(ws);
    const p = phones.get(id);
    if (role === 'phone' && p?.ws === ws) { phones.delete(id); console.log(`phone ${p.slot} disconnected`); status(); }
  });
});

// a phone that drops off WiFi never sends a close; free its slot after 5 s of silence
setInterval(() => { for (const p of phones.values()) if (Date.now() - p.seen > 5000) p.ws.terminate(); }, 1000).unref();

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`dashboard: http://localhost:${PORT}\nphones: enter one of ${ips.join(', ')}  port ${PORT}`);
});
export { server };
