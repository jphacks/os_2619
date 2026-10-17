// The one process to start on the PC:  node server.mjs   (npm start)
//  :8002 http  + :8443 https  — same pages as serve.mjs (phones only allow getUserMedia on a secure origin, hence https)
//  /ws on both   — reverse-proxied to the sensing team's relay on :8000 (spawned here when nothing listens there), so a
//                  phone may enter 8000 or 8002, and our https pages can use wss://IP:8443/ws without mixed-content errors
//  /cam on both  — our signalling + fallback relay for the third-person camera phone (see "cam" below)
//  /ca.crt /ca.pem /trust.html — the local CA the phones must trust once;  /info — JSON for the admin page
// Env: PORT (8002), TLS_PORT (8443), RELAY_PORT (8000), OPENSSL (path to openssl).  Certificates are made with the openssl CLI
// into cert/ (gitignored). Without openssl (plain Windows) only http :8002 runs: everything works except the camera phone page.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle as serveStatic, root } from './serve.mjs';

const PORT = +process.env.PORT || 8002, TLS_PORT = +process.env.TLS_PORT || 8443, RELAY_PORT = +process.env.RELAY_PORT || 8000; // RELAY_PORT only for tests: phones type 8000
const relayPath = fileURLToPath(new URL('../sensing/dashboard/server.mjs', import.meta.url));
const { WebSocketServer, WebSocket } = createRequire(relayPath)('ws'); // their installed copy: no npm install on our side
const lan = ip => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const ips = () => Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address)
  .sort((a, b) => lan(b) - lan(a)); // Wi-Fi/LAN address first: that is the one phones can reach

// ---- certificates: one CA per machine (phones trust it once), a server cert re-issued whenever this Mac's IPs change ----
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
    // iOS rules for a leaf it will accept: SAN present, serverAuth EKU, SHA-256, RSA>=2048, validity <= 825 days (we stay under Apple's 398 too)
    writeFileSync(cf('server.cnf'), `subjectAltName=${want.join(',')}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n`);
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', cf('server.key'), '-out', cf('server.csr'), '-subj', '/CN=bou-battle/O=bou-battle');
    openssl('x509', '-req', '-sha256', '-days', '397', '-in', cf('server.csr'), '-CA', cf('ca.pem'), '-CAkey', cf('ca.key'), '-CAcreateserial', '-out', cf('server.pem'), '-extfile', cf('server.cnf'));
    console.log(`cert: issued server certificate for ${want.join(' ')}`);
  }
  return { key: readFileSync(cf('server.key')), cert: readFileSync(cf('server.pem')), ca: readFileSync(cf('ca.pem')), fingerprint: ca.fingerprint256, sans: want.join() };
}
let tls = null;
try { tls = OPENSSL ? ensureCerts() : null; } catch (e) { console.warn('cert:', e.message); }
if (!tls) console.warn(`cert: ${OPENSSL ? 'could not make certificates' : 'openssl not found'} → https :${TLS_PORT} is off. Everything else works;
      the camera phone page needs https. Fix: install Git for Windows (it ships openssl) or set OPENSSL=path\\to\\openssl.exe`);

// ---- sensing relay (:8000): use the one already running, otherwise run theirs as a child and keep it alive ----
let child = null, relayAlive = false, relaySpawned = false, quitting = false;
const probe = port => new Promise(r => {
  const s = net.connect(port, '127.0.0.1');
  s.setTimeout(500); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); s.once('timeout', () => { s.destroy(); r(false); });
});
async function ensureRelay() {
  relayAlive = await probe(RELAY_PORT);
  if (relayAlive || child || quitting) return;
  console.log(`relay: nothing on :${RELAY_PORT}, starting sensing/dashboard/server.mjs`);
  child = spawn(process.execPath, [relayPath], { cwd: dirname(relayPath), env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  relaySpawned = true;
  for (const s of [child.stdout, child.stderr]) s.on('data', d => process.stdout.write(String(d).replace(/^(?=.)/gm, '[relay] ')));
  child.on('exit', (code, sig) => { child = null; if (!quitting) { console.warn(`relay: exited (${sig ?? code}), restarting in 1 s`); setTimeout(ensureRelay, 1000); } });
}
// the relay tells any dashboard its phone list right after hello: ask, take the first answer, hang up
const relayPhones = () => new Promise(r => {
  let done = false; const fin = v => { if (done) return; done = true; r(v); try { ws.close(); } catch {} };
  const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/ws`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'dashboard', id: 'server-info' })));
  ws.on('message', (d, bin) => { if (bin) return; try { const k = JSON.parse(d); if (k.type === 'phones') fin(k.list); } catch {} });
  ws.on('error', () => fin(undefined)); ws.on('close', () => fin(undefined)); setTimeout(() => fin(undefined), 700);
});
// raw WebSocket upgrade → relay. Node already parsed the request, so re-emit the request line + original headers and pipe bytes both ways
function proxyUpgrade(req, socket, head) {
  const up = net.connect(RELAY_PORT, '127.0.0.1', () => {
    const h = req.rawHeaders, lines = [];
    for (let i = 0; i < h.length; i += 2) lines.push(`${h[i]}: ${h[i + 1]}`);
    lines.push(`X-Forwarded-For: ${socket.remoteAddress}`, `X-Forwarded-Proto: ${socket.encrypted ? 'wss' : 'ws'}`);
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => { if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
  socket.on('error', () => up.destroy());
  up.on('close', () => socket.destroy()); socket.on('close', () => up.destroy());
}

// ---- cam: third-person camera phone ("cam") ↔ display pages. JSON text {type:...} plus binary frames as a fallback transport ----
//  hello {role:'cam'|'display', id, name}   one cam only, the newest wins and the old one gets {type:'replaced'}
//  signal {...}                             cam → every display (or the one in `to`), display → cam; `from` is set by us
//  binary                                   cam → every display (dropped for a display whose socket is >2 MB behind)
//  cams {list:[{id,name,since}]}            to displays on every change and right after their hello
//  displays {count}                         to the cam when displays come and go (so it knows it should (re)offer)
//  ping {t0} → pong {t0, ts}
const camWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
let cam = null; // { ws, id, name, since }
const displays = new Map(); // ws -> { id, name }
const send = (ws, k) => ws.readyState === 1 && ws.send(JSON.stringify(k));
const camList = () => ({ type: 'cams', list: cam ? [{ id: cam.id, name: cam.name, since: cam.since }] : [] });
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
      cam = { ws, id, name, since: Date.now() };
      console.log(`cam: "${name}" (${id}) from ${req.socket.remoteAddress}`);
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
    if (cam?.ws === ws) { cam = null; console.log(`cam: ${id} disconnected`); toDisplays(JSON.stringify(camList())); }
  });
});

// ---- http(s) ----
async function info() {
  const list = ips(), ip = list[0] ?? 'localhost';
  relayAlive = await probe(RELAY_PORT); // live, not the 3 s poll: the admin page asks right after we spawned it
  const phones = relayAlive ? await relayPhones() : undefined;
  return {
    ips: list, port: PORT, tlsPort: tls ? TLS_PORT : null, https: !!tls, relayPort: RELAY_PORT, relayAlive, relaySpawned, cams: camList().list, ...(phones && { phones }),
    certFingerprint: tls?.fingerprint ?? null,
    urls: { // trust/ca over plain http: before the CA is installed every https URL shows a warning on the phone
      display: `http://${ip}:${PORT}/`, admin: `http://${ip}:${PORT}/admin.html`, camera: `https://${ip}:${TLS_PORT}/cam.html`,
      trust: `http://${ip}:${PORT}/trust.html`, ca: `http://${ip}:${PORT}/ca.crt`, sensorApp: `${ip}:${RELAY_PORT}`, ws: `wss://${ip}:${TLS_PORT}/ws`, cam: `wss://${ip}:${TLS_PORT}/cam`,
    },
  };
}
async function onRequest(req, res) {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if ((path === '/ca.pem' || path === '/ca.crt') && tls) return res.writeHead(200, { 'content-type': path.endsWith('.pem') ? 'application/x-pem-file' : 'application/x-x509-ca-cert', 'cache-control': 'no-store' }).end(tls.ca);
    if (path === '/info') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end(JSON.stringify(await info()));
    await serveStatic(req, res);
  } catch (e) { console.warn(e.message); if (!res.headersSent) res.writeHead(500).end(); }
}
function onUpgrade(req, socket, head) {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/cam') return camWss.handleUpgrade(req, socket, head, ws => camWss.emit('connection', ws, req));
  if (path === '/ws') return proxyUpgrade(req, socket, head);
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
}
const plain = http.createServer(onRequest).on('upgrade', onUpgrade);
const secure = tls && https.createServer({ key: tls.key, cert: tls.cert }, onRequest).on('upgrade', onUpgrade);
const servers = [[plain, PORT], ...(secure ? [[secure, TLS_PORT]] : [])];
for (const [s, p] of servers) s.on('error', e => { console.error(`cannot listen on :${p}: ${e.code} (set PORT / TLS_PORT, or stop the other process)`); process.exit(1); });

// Wi-Fi changed → new IP → re-issue the leaf and swap it in without restarting (new connections get the new cert)
setInterval(() => {
  if (!tls || wantSans().join() === tls.sans) return;
  try { tls = ensureCerts(); secure.setSecureContext({ key: tls.key, cert: tls.cert }); console.log('cert: IPs changed, now', ips().join(' ')); } catch (e) { console.warn('cert:', e.message); }
}, 10e3).unref();

await ensureRelay();
setInterval(ensureRelay, 3000).unref();
await Promise.all(servers.map(([s, p]) => new Promise(r => s.listen(p, r))));
{
  const list = ips(), ip = list[0] ?? 'localhost';
  console.log([
    `bou-battle server   IPs: ${list.join(', ') || '(none: no network)'}`,
    `  display    http://${ip}:${PORT}/           admin  http://${ip}:${PORT}/admin.html`,
    tls ? `  camera     https://${ip}:${TLS_PORT}/cam.html   (phone: install the CA from the trust page first)` : `  camera     (off: no https without openssl)`,
    ...(tls ? [`  trust/CA   http://${ip}:${PORT}/trust.html    http://${ip}:${PORT}/ca.crt    sha256 ${tls.fingerprint}`] : []),
    `  sensor app ${ip}:${RELAY_PORT}  (relay ${relaySpawned ? 'spawned by us' : relayAlive ? 'already running, using it' : 'NOT running'}; also via ws://${ip}:${PORT}/ws${tls ? ` and wss://${ip}:${TLS_PORT}/ws` : ''})`,
    `  cam socket ws://${ip}:${PORT}/cam${tls ? `   wss://${ip}:${TLS_PORT}/cam` : ''}      info http://${ip}:${PORT}/info`,
  ].join('\n'));
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { quitting = true; child?.kill(); process.exit(0); });
