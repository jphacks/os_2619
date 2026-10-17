// The one process on the PC:  node server.mjs   (npm start)   → http://localhost:8000
// Everything is on port 8000. The first byte of each connection says which protocol it speaks: 0x16 is a TLS handshake
// (https / wss, needed by the camera phone's browser for getUserMedia), anything else is plain http / ws.
//  /ws    phones A and B (the SensorLink app) and the dashboards. Same protocol as sensing/dashboard/server.mjs:
//         slots A / B, packets relayed with `slot` added, video as binary (first byte = slot), ping → pong, `phones` list.
//  /cam   phone C, the third-person camera (cam.html + camlink.js): WebRTC signalling and a JPEG fallback relay
//  /info  JSON for the dashboard;  /ca.crt /ca.pem  the local CA phone C trusts once (trust.html)
//  /cdn/npm/<pkg>@<x.y.z>/<file>  cdn.jsdelivr.net cached in vendor/cdn/ (works offline once fetched)
// Env: PORT (8000), OPENSSL (path to openssl). Without openssl only plain http runs: everything but phone C's page works.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = +process.env.PORT || 8000;
const root = fileURLToPath(new URL('.', import.meta.url));
const pub = join(root, 'public'), cdnCache = join(root, 'vendor', 'cdn');
const lan = ip => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const ips = () => Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address)
  .sort((a, b) => lan(b) - lan(a)); // Wi-Fi/LAN address first: that is the one phones can reach

// ---- certificates: one CA per machine (phone C trusts it once), a server cert re-issued whenever the IPs change ----
const certDir = join(root, 'cert'), cf = n => join(certDir, n);
// openssl: PATH first, then where Git for Windows keeps it (Windows has none of its own)
const OPENSSL = [process.env.OPENSSL, 'openssl', ...(process.platform === 'win32' ? [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'usr', 'bin', 'openssl.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'usr', 'bin', 'openssl.exe'),
] : [])].filter(Boolean).find(b => { try { execFileSync(b, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } });
const openssl = (...a) => execFileSync(OPENSSL, a, { stdio: ['ignore', 'ignore', 'pipe'] });
const wantSans = () => ['DNS:localhost', 'IP:127.0.0.1', ...ips().map(ip => 'IP:' + ip)];
function ensureCerts() {
  mkdirSync(certDir, { recursive: true });
  if (!existsSync(cf('ca.key')) || !existsSync(cf('ca.pem'))) {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', cf('ca.key'), '-out', cf('ca.pem'),
      '-subj', '/CN=bou-battle local CA/O=bou-battle', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
    rmSync(cf('server.pem'), { force: true }); // old leaf was signed by a CA that no longer exists
    console.log('cert: made a new local CA (phones that trusted the old one must trust again)');
  }
  const ca = new X509Certificate(readFileSync(cf('ca.pem')));
  const want = wantSans();
  let cur = null;
  try { cur = new X509Certificate(readFileSync(cf('server.pem'))); } catch {}
  const have = cur?.subjectAltName?.split(', ').map(s => s.replace('IP Address:', 'IP:')) ?? [];
  const ok = cur && cur.checkIssued(ca) && existsSync(cf('server.key')) && have.join() === want.join() && Date.parse(cur.validTo) - Date.now() > 30 * 864e5;
  if (!ok) {
    // iOS rules for a leaf it will accept: SAN present, serverAuth EKU, SHA-256, RSA>=2048, validity <= 398 days
    writeFileSync(cf('server.cnf'), `subjectAltName=${want.join(',')}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n`);
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', cf('server.key'), '-out', cf('server.csr'), '-subj', '/CN=bou-battle/O=bou-battle');
    openssl('x509', '-req', '-sha256', '-days', '397', '-in', cf('server.csr'), '-CA', cf('ca.pem'), '-CAkey', cf('ca.key'), '-CAcreateserial', '-out', cf('server.pem'), '-extfile', cf('server.cnf'));
    console.log(`cert: issued server certificate for ${want.join(' ')}`);
  }
  return { key: readFileSync(cf('server.key')), cert: readFileSync(cf('server.pem')), ca: readFileSync(cf('ca.pem')), fingerprint: ca.fingerprint256, sans: want.join() };
}
let tls = null;
if (!process.env.NO_TLS) try { tls = OPENSSL ? ensureCerts() : null; } catch (e) { console.warn('cert:', e.message); }
if (!tls) console.warn(`cert: ${OPENSSL ? 'could not make certificates' : 'openssl not found'} → https is off. Phone C's camera page needs it.
      Fix: install Git for Windows (it ships openssl) or set OPENSSL=path\\to\\openssl.exe`);

const send = (ws, k) => ws.readyState === 1 && ws.send(JSON.stringify(k));

// ---- /ws: phones A and B + dashboards (sensing/dashboard/server.mjs, unchanged protocol) ----
const SLOTS = ['A', 'B'];
const phones = new Map(); // phone id -> { slot, name, ws, seen, addr }
const dashboards = new Set();
const toDashboards = (data, video) => {
  for (const d of dashboards) if (d.readyState === 1 && !(video && d.bufferedAmount > 2e6)) d.send(data); // slow dashboard: skip frames, never sensor data
};
const phoneList = () => [...phones.values()].map(({ slot, name, addr }) => ({ slot, name, addr }));
const status = () => toDashboards(JSON.stringify({ type: 'phones', list: phoneList() }));

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
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
      phones.set(id, { slot, name: String(k.name).slice(0, 40), ws, seen: Date.now(), addr: req.socket.remoteAddress?.replace(/^::ffff:/, '') });
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

// ---- /cam: phone C (third-person camera) ↔ display pages (kawashima/server.mjs protocol) ----
//  hello {role:'cam'|'display', id, name}   one cam only, the newest wins and the old one gets {type:'replaced'}
//  signal {...}                             cam → every display (or the one in `to`), display → cam; `from` is set here
//  binary                                   cam → every display (dropped for a display whose socket is >2 MB behind)
//  cams {list:[{id,name,since}]}            to displays on every change and right after their hello
//  displays {count}                         to the cam when displays come and go (so it knows it should (re)offer)
const camWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
let cam = null; // { ws, id, name, since, addr }
const displays = new Map(); // ws -> { id, name }
const camList = () => ({ type: 'cams', list: cam ? [{ id: cam.id, name: cam.name, since: cam.since, addr: cam.addr }] : [] });
const toDisplays = (data, binary) => { for (const d of displays.keys()) if (d.readyState === 1 && !(binary && d.bufferedAmount > 2e6)) d.send(data); };
const tellCam = () => cam && send(cam.ws, { type: 'displays', count: displays.size });
camWss.on('connection', (ws, req) => {
  let role = null, id = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) { if (role === 'cam' && cam?.ws === ws) toDisplays(data, true); return; }
    let k; try { k = JSON.parse(data); } catch { return; }
    if (k.type === 'ping') return send(ws, { type: 'pong', t0: k.t0, ts: Date.now() / 1000 });
    if (k.type === 'hello') {
      role = String(k.role); id = String(k.id ?? Math.random().toString(36).slice(2, 10)).slice(0, 64);
      const name = String(k.name ?? '').slice(0, 40);
      if (role === 'display') { displays.set(ws, { id, name }); send(ws, camList()); return tellCam(); }
      if (role !== 'cam') return;
      if (cam && cam.ws !== ws) { send(cam.ws, { type: 'replaced' }); cam.ws.close(); }
      cam = { ws, id, name, since: Date.now(), addr: req.socket.remoteAddress?.replace(/^::ffff:/, '') };
      console.log(`phone C (camera "${name}") connected from ${req.socket.remoteAddress}`);
      send(ws, { type: 'welcome', displays: displays.size });
      return toDisplays(JSON.stringify(camList()));
    }
    if (k.type === 'signal') {
      k.from = id;
      if (role === 'cam' && cam?.ws === ws) { for (const [d, m] of displays) if (!k.to || m.id === k.to) send(d, { ...k, to: m.id }); }
      else if (role === 'display' && cam) send(cam.ws, { ...k, to: cam.id });
    }
  });
  ws.on('close', () => {
    if (displays.delete(ws)) tellCam();
    if (cam?.ws === ws) { cam = null; console.log('phone C disconnected'); toDisplays(JSON.stringify(camList())); }
  });
});

// ---- static files + the CDN cache ----
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };
const pinned = p => /^npm\/(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\/[\w./@-]+$/.test(p) && !p.includes('..'); // exact versions only: the cache never goes stale
async function fromCdn(p) {
  const file = join(cdnCache, p);
  try { return await readFile(file); } catch {}
  const r = await fetch('https://cdn.jsdelivr.net/' + p);
  if (!r.ok) throw new Error(`cdn ${r.status} ${p}`);
  const body = Buffer.from(await r.arrayBuffer());
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, body);
  return body;
}
function info(host) {
  const list = ips(), ip = list[0] ?? 'localhost', base = `${ip}:${PORT}`;
  return {
    ips: list, port: PORT, https: !!tls, certFingerprint: tls?.fingerprint ?? null, phones: phoneList(), cams: camList().list, dashboards: dashboards.size,
    urls: { dashboard: `http://${base}/`, camera: `https://${base}/cam.html`, trust: `http://${base}/trust.html`, ca: `http://${base}/ca.crt`, sensorApp: base, host },
  };
}
async function onRequest(req, res) {
  try {
    // posix: '/' stays '/' on Windows too; backslashes become '/' first so they can't climb out of the folder
    let path = posix.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\\/g, '/')).replace(/^(\.\.[/\\])+/, '');
    if ((path === '/ca.pem' || path === '/ca.crt') && tls) return res.writeHead(200, { 'content-type': path.endsWith('.pem') ? 'application/x-pem-file' : 'application/x-x509-ca-cert', 'cache-control': 'no-store' }).end(tls.ca);
    if (path === '/info') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(info(req.headers.host)));
    if (path.startsWith('/cdn/')) {
      const p = path.slice(5);
      if (!pinned(p)) return res.writeHead(404).end();
      try { const body = await fromCdn(p); return res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' }).end(body); }
      catch (e) { console.warn(e.message); return res.writeHead(502).end(); }
    }
    if (path === '/') path = '/index.html';
    let body; try { body = await readFile(join(pub, path)); } catch { return res.writeHead(404).end(); }
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
  } catch (e) { console.warn(e.message); if (!res.headersSent) res.writeHead(500).end(); }
}
function onUpgrade(req, socket, head) {
  const path = new URL(req.url, 'http://x').pathname, to = path === '/ws' ? wss : path === '/cam' ? camWss : null;
  if (!to) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  to.handleUpgrade(req, socket, head, ws => to.emit('connection', ws, req));
}
const plain = http.createServer(onRequest).on('upgrade', onUpgrade);
const secure = tls && https.createServer({ key: tls.key, cert: tls.cert }, onRequest).on('upgrade', onUpgrade);

// one port, two protocols: peek at the first byte and hand the socket to the matching server
const front = net.createServer(sock => {
  sock.once('data', buf => {
    sock.pause(); sock.unshift(buf);
    (buf[0] === 0x16 && secure ? secure : plain).emit('connection', sock);
    process.nextTick(() => sock.resume());
  });
  sock.on('error', () => {});
});
front.on('error', e => { console.error(`cannot listen on :${PORT}: ${e.code} (set PORT, or stop the other process, e.g. sensing or kawashima servers)`); process.exit(1); });

// Wi-Fi changed → new IP → re-issue the leaf and swap it in without restarting (new connections get the new cert)
setInterval(() => {
  if (!tls || wantSans().join() === tls.sans) return;
  try { tls = ensureCerts(); secure.setSecureContext({ key: tls.key, cert: tls.cert }); console.log('cert: IPs changed, now', ips().join(' ')); } catch (e) { console.warn('cert:', e.message); }
}, 10e3).unref();

export const ready = new Promise(r => front.listen(PORT, r)).then(() => {
  const ip = ips()[0] ?? 'localhost';
  console.log([
    `ダッシュボード  http://localhost:${PORT}/   (LAN: http://${ip}:${PORT}/)   IPs: ${ips().join(', ') || '(no network)'}`,
    `  スマホ A・B   SensorLink アプリに IP ${ip}  ポート ${PORT}`,
    tls ? `  スマホ C      https://${ip}:${PORT}/cam.html   (初回は http://${ip}:${PORT}/trust.html で証明書を信頼)` : '  スマホ C      (https が無効: openssl が見つからない)',
  ].join('\n'));
});
export { front as server };
