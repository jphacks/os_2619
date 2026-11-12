// The one process on the PC:  node server.mjs   (npm start)   → http://localhost:8000
// Everything is on port 8000. The first byte of each connection says which protocol it speaks: 0x16 is a TLS handshake
// (https / wss, needed by the camera phone's browser for getUserMedia), anything else is plain http / ws.
//  /ws    phones A and B (the SensorLink app) and the dashboards. Same protocol as sensing/dashboard/server.mjs:
//         slots A / B, packets relayed with `slot` added, ping → pong, `phones` list. Phones A / B send no picture.
//  /cam   phone C, the third-person camera (cam.html + camlink.js): WebRTC signalling and a JPEG fallback relay
//  /sticks  scanned branches (sticks.html): records, photos, which one players A / B use, sent to dashboards as { type: 'sticks' }
//  /marker.js  the floor sheets' marker (april | rune), saved in settings.json;  /info  JSON for the dashboard;  /ca.crt /ca.pem  the local CA phone C trusts once (trust.html)
//  /cdn/npm/<pkg>@<x.y.z>/<file>  cdn.jsdelivr.net cached in vendor/cdn/ (works offline once fetched)
//  /cdn/mp-models/<path>.task      MediaPipe's models (storage.googleapis.com/mediapipe-models), cached the same way
// Env: PORT (8000), OPENSSL (path to openssl). Without openssl only plain http runs: everything but phone C's page works.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { stickStats, stickElement, stickRarity, cleanRarityMul } from './public/stick-stats.js';
import { shapeScore } from './public/stick-analyze.js';

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
const phones = new Map(); // phone id -> { slot, name, ws, seen, addr, since, n: { msg, bytes } (since the last stats line), gap }
// A phone is dropped after SILENCE ms with nothing from it. 5 s was too short on a two-hop link (phone -> hotspot -> this
// PC as another hotspot client): a slow stretch could hold the pings back that long.
const SILENCE = 10e3;
const hms = () => new Date().toLocaleTimeString('ja-JP', { hour12: false });
const log = (...a) => console.log(hms(), ...a);
const alive = p => { const t = Date.now(); p.gap = Math.max(p.gap ?? 0, t - p.seen); p.seen = t; };
const dashboards = new Set();
const toDashboards = data => { for (const d of dashboards) if (d.readyState === 1) d.send(data); };
const phoneList = () => [...phones.values()].map(({ slot, name, addr }) => ({ slot, name, addr }));
const status = () => toDashboards(JSON.stringify({ type: 'phones', list: phoneList() }));
// Sensor recording (to tune the charge detector on real motion): a dashboard's { type: 'record', label, sec } writes every phone's imu and ar packets, one JSON a line with the
// server's receive time rx, to recordings/<label>-<time>.jsonl (not in git) for sec s; { type: 'record' } stops early. Dashboards hear { type: 'recording', on, label, sec | file, n }.
const RECORD_LABELS = ['walk', 'walk-circle', 'still-circle'];
let rec = null;
function stopRecording() {
  if (!rec) return;
  const { label, file, n, out, timer } = rec; rec = null; clearTimeout(timer);
  out.end(() => { log(`recording: ${n} packets in recordings/${file}`); toDashboards(JSON.stringify({ type: 'recording', on: false, label, file, n })); });
}
function startRecording(label, sec) {
  if (rec || !RECORD_LABELS.includes(label)) return;
  const s = Math.min(Math.max(+sec || 20, 1), 120), dir = join(root, 'recordings'), file = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  mkdirSync(dir, { recursive: true });
  rec = { label, file, n: 0, out: createWriteStream(join(dir, file)), timer: setTimeout(stopRecording, s * 1000) };
  toDashboards(JSON.stringify({ type: 'recording', on: true, label, sec: s }));
}
// The floor sheets' marker, one choice for every page and phone (public/marker.js): saved in settings.json, served as /marker.js,
// sent to phones in `welcome` and to everyone as { type: 'marker' } when a dashboard switches it ({ type: 'setMarker', marker }).
const settingsFile = join(root, 'settings.json');
let settings = {}; try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch {}
let marker = ['april', 'rune'].includes(process.env.MARKER) ? process.env.MARKER : settings.marker === 'rune' ? 'rune' : 'april';
// the mahoujin's printed / designed size (world.js RUNE_SCALE), measured after assembly: { type: 'setRuneScale', scale }
const okScale = v => +v > .5 && +v < 2;
let runeScale = okScale(process.env.RUNE_SCALE) ? +process.env.RUNE_SCALE : okScale(settings.runeScale) ? +settings.runeScale : 0.975; // measured: 100 mm on the PDF printed 97.5 mm
function saveSettings() { try { writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.warn('settings:', e.message); } }
const markerMsg = () => JSON.stringify({ type: 'marker', marker, runeScale });
function setMarker(m) {
  if (!['april', 'rune'].includes(m) || m === marker) return;
  marker = m; settings.marker = m; saveSettings();
  log(`marker: ${m === 'rune' ? 'RuneTag' : 'AprilTag'} for the floor sheets`);
  const k = markerMsg();
  toDashboards(k); for (const p of phones.values()) if (p.ws.readyState === 1) p.ws.send(k);
}
function setRuneScale(v) {
  if (!okScale(v) || +v === runeScale) return;
  runeScale = settings.runeScale = +v; saveSettings();
  log(`mahoujin scale ${runeScale}`);
  toDashboards(markerMsg()); // the phones measure at the designed size; the pages rescale
}

// The scanned stick models (public/stickscan.js), one per slot, built by a dashboard from a phone's 'scan' pictures: sticks.json next to
// this file (not in git). A dashboard sends { type: 'setStick', slot, model | null }; every dashboard (now and on hello) and the slot's
// phone get { type: 'stick', slot, model }.
const sticksFile = join(root, 'sticks.json');
// v 3 only (a tree: nodes [side, along], edges, thickness r [grip, tip]); older models (v 1 colours, v 2 rings) are dropped on load
const okStick = m => m && typeof m === 'object' && m.v === 3 && m.length > .1 && m.length < 2
  && Array.isArray(m.r) && m.r.length === 2 && m.r.every(v => v > 0 && v < .2)
  && Array.isArray(m.nodes) && m.nodes.length >= 2 && m.nodes.length <= 1024
  && m.nodes.every(n => Array.isArray(n) && n.length === 2 && Math.abs(n[0]) < 1 && Math.abs(n[1]) <= m.length)
  && Number.isInteger(m.tip) && m.tip > 0 && m.tip < m.nodes.length
  && Array.isArray(m.edges) && m.edges.length <= 1024
  && m.edges.every(e => Array.isArray(e) && e.length === 2 && e.every(i => Number.isInteger(i) && i >= 0 && i < m.nodes.length) && e[0] !== e[1]);
let sticks = {}; try { sticks = Object.fromEntries(Object.entries(JSON.parse(readFileSync(sticksFile, 'utf8')) ?? {}).filter(([, m]) => okStick(m))); } catch {}
function setStick(slot, model) {
  if (!SLOTS.includes(slot) || (model !== null && !okStick(model))) return;
  if (model) sticks[slot] = model; else delete sticks[slot];
  try { writeFileSync(sticksFile, JSON.stringify(sticks)); } catch (e) { console.warn('sticks:', e.message); }
  log(model ? `stick ${slot}: model saved, ${model.length} m` : `stick ${slot}: model removed`);
  const k = JSON.stringify({ type: 'stick', slot, model: model ?? null });
  toDashboards(k); for (const p of phones.values()) if (p.slot === slot && p.ws.readyState === 1) p.ws.send(k);
}

let matchPhase = 'setup'; // the dashboard's game phase (setup / countdown / fight / result)
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
wss.on('connection', (ws, req) => {
  let role = null, id = null;
  const dbg = process.env.NET_DEBUG && lanAddr(req.socket.remoteAddress), port = req.socket.remotePort;
  if (dbg) { log(`net ${port} ws open`); ws.on('close', (c, r) => log(`net ${port} ws close ${c} ${r}`)); ws.on('error', e => log(`net ${port} ws error ${e.message}`)); }
  // The phone's first ping fits in a small packet, but the hello and sensor data behind it ride in full 1500-byte
  // packets. On a link with a smaller MTU that drops them silently (seen on a Windows hotspot: 1492), the phone says
  // "connected" while nothing reaches us. A socket that pinged yet never said hello is that case.
  let heard = false;
  const noHello = setTimeout(() => {
    if (heard && role === null && ws.readyState === 1) log(`phone at ${req.socket.remoteAddress?.replace(/^::ffff:/, '')} pings but its hello never arrives: large packets are being dropped on the way (MTU). Fix on the PC: sudo ifconfig en0 mtu 1400 (macOS) / netsh interface ipv4 set subinterface "Wi-Fi" mtu=1400 store=persistent (Windows)`);
  }, 5e3);
  ws.on('close', () => clearTimeout(noHello));
  ws.on('message', (data, isBinary) => {
    heard = true;
    if (dbg && (ws.__n = (ws.__n ?? 0) + 1) <= 12 && !(isBinary && ws.__n > 2)) log(`net ${port} ws message #${ws.__n}: ${isBinary ? `binary ${data.length} B` : String(data).slice(0, 120)}`);
    const p = id && phones.get(id);
    if (isBinary) return;
    let k;
    try { k = JSON.parse(data); } catch { return; }
    if (k.type === 'ping') {
      if (p && p.ws === ws) alive(p);
      return send(ws, { type: 'pong', t0: k.t0, ts: Date.now() / 1000 });
    }
    if (k.type === 'hello') {
      role = String(k.role); id = String(k.id).slice(0, 64);
      if (role === 'dashboard') { dashboards.add(ws); send(ws, { type: 'marker', marker, runeScale }); for (const [slot, model] of Object.entries(sticks)) send(ws, { type: 'stick', slot, model }); ws.send(sticksMsg()); return status(); }
      if (role !== 'phone') return;
      const old = phones.get(id); // same phone reconnecting keeps its slot
      const slot = old?.slot ?? SLOTS.find(s => ![...phones.values()].some(q => q.slot === s));
      if (!slot) { send(ws, { type: 'full' }); return ws.close(); }
      old?.ws.terminate();
      phones.set(id, { slot, name: String(k.name).slice(0, 40), ws, seen: Date.now(), since: Date.now(), gap: 0, n: { msg: 0, bytes: 0 }, addr: req.socket.remoteAddress?.replace(/^::ffff:/, '') });
      log(`phone ${slot} (${k.name}) connected from ${req.socket.remoteAddress}`);
      send(ws, { type: 'welcome', slot, marker });
      send(ws, { type: 'match', phase: matchPhase });
      return status();
    }
    if (k.type === 'setMarker' && role === 'dashboard') return setMarker(k.marker);
    if (k.type === 'match' && role === 'dashboard') { // the phones grey out 枝 while a match runs
      const ph = String(k.phase).slice(0, 16); if (ph === matchPhase) return;
      matchPhase = ph; const m = JSON.stringify({ type: 'match', phase: ph });
      for (const q of phones.values()) if (q.ws.readyState === 1) q.ws.send(m);
      return;
    }
    if (k.type === 'setRuneScale' && role === 'dashboard') return setRuneScale(k.scale);
    if (k.type === 'record') { if (role === 'dashboard') { if (k.label) startRecording(k.label, k.sec); else stopRecording(); } return; }
    if (k.type === 'vibrate') { // { type: 'vibrate', slot, kind: 'charge' | 'win' | 'off', (charge:) element, tier, level } from a dashboard goes to that slot's phone
      if (role !== 'dashboard' || !['charge', 'win', 'off'].includes(k.kind)) return;
      const m = k.kind === 'charge' ? { type: 'vibrate', kind: 'charge', element: String(k.element ?? ''), tier: ['s', 'm', 'l'].includes(k.tier) ? k.tier : 's', level: Math.max(0, Math.min(1, +k.level || 0)) } : { type: 'vibrate', kind: k.kind };
      for (const q of phones.values()) if (q.slot === k.slot) send(q.ws, m);
      return;
    }
    if (k.type === 'sfx') { // a game sound for that slot's phone (app.js phoneSound): { kind: 'chargeFail' } or { voices: [{ file, gain, rate, offset, dur, rel, fade }] }
      if (role !== 'dashboard') return;
      const num = (x, lo, hi, d = 0) => Number.isFinite(+x) ? Math.max(lo, Math.min(hi, +x)) : d;
      const m = k.kind === 'chargeFail' ? { type: 'sfx', kind: 'chargeFail' } : { type: 'sfx', voices: (Array.isArray(k.voices) ? k.voices : []).slice(0, 4)
        .filter(v => PHONE_SFX.has(v?.file)).map(v => ({ file: v.file, gain: num(v.gain, 0, 1), rate: num(v.rate, .25, 4, 1), offset: num(v.offset, 0, 10), dur: num(v.dur, 0, 10), rel: num(v.rel, 0, 2, .25),
          fade: Array.isArray(v.fade) ? [num(v.fade[0], 0, 10), num(v.fade[1], 0, 10)] : null })) };
      if (m.kind || m.voices.length) for (const q of phones.values()) if (q.slot === k.slot) send(q.ws, m);
      return;
    }
    if (k.type === 'flash') { // a hit: { type: 'flash', slot, ms } from a dashboard lights the torch of that slot's phone
      if (role !== 'dashboard') return;
      const ms = Math.min(+k.ms || 0, 2000);
      if (ms > 0) for (const q of phones.values()) if (q.slot === k.slot) send(q.ws, { type: 'flash', ms });
      return;
    }
    if (k.type === 'setStick' && role === 'dashboard') return setStick(k.slot, k.model);
    if (role === 'phone' && p && p.ws === ws) { alive(p); p.n.msg++; p.n.bytes += data.length; k.slot = p.slot; toDashboards(JSON.stringify(k)); if (rec && (k.type === 'imu' || k.type === 'ar')) { rec.out.write(JSON.stringify({ ...k, rx: Date.now() / 1000 }) + '\n'); rec.n++; } }
  });
  ws.on('close', (code, reason) => {
    dashboards.delete(ws);
    const p = phones.get(id);
    if (role === 'phone' && p?.ws === ws) {
      phones.delete(id);
      log(`phone ${p.slot} disconnected after ${((Date.now() - p.since) / 1000).toFixed(1)} s (${p.dropped ? `nothing for ${(p.dropped / 1000).toFixed(1)} s` : `close ${code}${reason?.length ? ' ' + reason : ''}`})`);
      status();
    }
  });
});
// a phone that drops off WiFi never sends a close; free its slot after SILENCE of nothing from it
setInterval(() => { for (const p of phones.values()) { const q = Date.now() - p.seen; if (q > SILENCE && !p.dropped) { p.dropped = q; p.ws.terminate(); } } }, 1000).unref();
// every 10 s per phone: messages / s and KB / s, the longest silence (this tells a link that is saturated, with pings
// stuck behind the data, from one that is quiet or gone)
setInterval(() => {
  for (const p of phones.values()) {
    log(`phone ${p.slot}: ${(p.n.msg / 10).toFixed(0)} msg/s ${(p.n.bytes / 10240).toFixed(0)} KB/s, longest gap ${((p.gap ?? 0) / 1000).toFixed(1)} s`);
    p.n = { msg: 0, bytes: 0 }; p.gap = 0;
  }
}, 10e3).unref();

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
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
// exact versions only: the cache never goes stale. mp-models/... is MediaPipe's model bucket (versioned paths too)
const pinned = p => (/^npm\/(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\/[\w./@-]+$/.test(p) || /^mp-models\/[\w-]+\/[\w-]+\/[\w-]+\/\d+\/[\w-]+\.task$/.test(p)) && !p.includes('..');
const upstream = p => p.startsWith('mp-models/') ? 'https://storage.googleapis.com/mediapipe-models/' + p.slice(10) : 'https://cdn.jsdelivr.net/' + p;
const fetching = new Map(); // p -> promise: on a slow uplink the browser asks again before the first download ends; fetch it once
async function fromCdn(p) {
  const file = join(cdnCache, p);
  try { return await readFile(file); } catch {}
  if (fetching.has(p)) return fetching.get(p);
  const job = (async () => {
    const t0 = Date.now(); log(`cdn: downloading ${p}`);
    const r = await fetch(upstream(p));
    if (!r.ok) throw new Error(`cdn ${r.status} ${p}`);
    const size = +r.headers.get('content-length') || 0, parts = []; let got = 0, said = Date.now();
    for await (const c of r.body) { // a 10 MB file takes minutes on a slow uplink: say how far it is every 10 s
      parts.push(c); got += c.length;
      if (Date.now() - said > 10e3) { said = Date.now(); log(`cdn: ${p} ${(got / 1048576).toFixed(1)}${size ? ` / ${(size / 1048576).toFixed(1)}` : ''} MB, ${(got / 1024 / ((said - t0) / 1000)).toFixed(0)} KB/s`); }
    }
    const body = Buffer.concat(parts);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, body);
    log(`cdn: ${p} ${(body.length / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s (kept in vendor/cdn)`);
    return body;
  })().finally(() => fetching.delete(p));
  fetching.set(p, job);
  return job;
}
function info(host) {
  const list = ips(), ip = list[0] ?? 'localhost', base = `${ip}:${PORT}`;
  return {
    ips: list, port: PORT, https: !!tls, certFingerprint: tls?.fingerprint ?? null, phones: phoneList(), cams: camList().list, dashboards: dashboards.size, marker,
    urls: { dashboard: `http://${base}/`, camera: `https://${base}/cam.html`, trust: `http://${base}/trust.html`, ca: `http://${base}/ca.crt`, sensorApp: base, host },
  };
}
// the game screen's numbers saved on this PC (rules.json next to server.mjs, not in git): GET -> them (404 when none), POST <- them
const RULES_FILE = process.env.RULES_FILE ?? join(root, 'rules.json');
async function rulesFile(req, res) {
  const json = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (req.method === 'GET') { let body; try { body = await readFile(RULES_FILE); } catch { return res.writeHead(404, json).end('null'); } return res.writeHead(200, json).end(body); }
  if (req.method !== 'POST') return res.writeHead(405).end();
  let body = ''; for await (const c of req) { body += c; if (body.length > 64e3) return res.writeHead(413).end(); }
  try { const r = JSON.parse(body); if (!r || typeof r !== 'object' || Array.isArray(r)) throw 0;
    if (!('rarityMul' in r)) r.rarityMul = rarityMul; // only sticks.html sends it; the dashboard's save keeps it
    await writeFile(RULES_FILE, JSON.stringify(r, null, 2)); log('rules: saved to rules.json');
    rarityMul = cleanRarityMul(r.rarityMul); toDashboards(sticksMsg()); // the players' sticks' stats follow rules.rarityMul
    return res.writeHead(200, json).end('{"ok":true}'); }
  catch { return res.writeHead(400, json).end('{"ok":false}'); }
}

// ---- /sticks: branches scanned on sticks.html. The browser measures the shape (stick-analyze.js) and sends the features;
// here they are checked, the score recomputed, and a new random seed picks the luck, element and stats (stick-stats.js).
//  GET /sticks → records   POST /sticks {name?, features, image: jpeg data URL} → the new record   DELETE /sticks/<id>
//  PATCH /sticks/<id> {name?, element?, rarity? 1-5, stats?: {hp, power, speed, charge} (0.5-2) | null = back to the rolled ones}
//  GET /sticks/assign → {A, B}   POST /sticks/assign {A?: id|null, B?: id|null}   GET /sticks/img/<id>.jpg
// Stored in DATA_DIR (data/, not in git): sticks.json {sticks, assign} and sticks/<id>.jpg. Stats are never trusted from the
// file: they are recomputed from (seed, rarity, rules.rarityMul) on the way out, so a new rarityMul changes every stick.
const DATA_DIR = process.env.DATA_DIR ?? join(root, 'data'), STICKS_FILE = join(DATA_DIR, 'sticks.json'), IMG_DIR = join(DATA_DIR, 'sticks');
let db = { sticks: [], assign: { A: null, B: null } };
try { const d = JSON.parse(readFileSync(STICKS_FILE, 'utf8')); db = { sticks: Array.isArray(d.sticks) ? d.sticks : [], assign: { A: d.assign?.A ?? null, B: d.assign?.B ?? null } }; } catch {}
let rarityMul = cleanRarityMul(null); try { rarityMul = cleanRarityMul(JSON.parse(readFileSync(RULES_FILE, 'utf8')).rarityMul); } catch {}
const ID = /^[a-z0-9]{8,32}$/;
const byId = id => db.sticks.find(s => s.id === id) ?? null;
// stats: the admin's own values (PATCH, s.custom) or, without them, from (seed, rarity, rarityMul)
const withStats = s => s && { ...s, stats: s.custom ? { ...s.custom } : stickStats(s.seed, s.rarity, rarityMul) };
const ELEMENTS = ['fire', 'thunder', 'water', 'wind'], STAT_KEYS = ['hp', 'power', 'speed', 'charge'], STAT_RANGE = [.5, 2];
// the game sounds a phone has (Android res/raw, iOS bundle): what { type: 'sfx' } may name
const PHONE_SFX = new Set(['fire', 'lightning', 'water', 'wind'].flatMap(e => [1, 2, 3].map(i => e + i)).concat(['guard', 'guard_reflect', 'swing'])); // swing: the sword swing (swing-sense.js)
const assigned = () => ({ A: withStats(byId(db.assign.A)), B: withStats(byId(db.assign.B)) });
const sticksMsg = () => JSON.stringify({ type: 'sticks', ...assigned() });
const saveDb = () => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(STICKS_FILE, JSON.stringify(db, null, 2)); }; // sync: two saves never interleave
// feature -> [min, max, integer]: anything else in the body is dropped
const FEATURES = { branches: [0, 50, 1], ends: [0, 100, 1], tortuosity: [1, 50], aspect: [0, 1000], thickness: [0, 1000], length: [0, 5000], coverage: [0, 1] };
function cleanFeatures(f) {
  if (!f || typeof f !== 'object') return null;
  const out = {};
  // a busy photo gives real but large counts (many branches / ends), an empty one tortuosity 0: clamp those into range.
  // Only what the analyzer never makes (negative, not a finite number, a fraction for a count) is refused.
  for (const [k, [lo, hi, int]] of Object.entries(FEATURES)) { const v = f[k]; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (int && !Number.isInteger(v))) return null; out[k] = Math.min(hi, Math.max(lo, v)); }
  return out;
}
// null when over max; the rest is still read (up to 8 × max) so the client gets the 413 instead of a reset
async function body(req, max) { let b = '', n = 0; for await (const c of req) { n += c.length; if (n > 8 * max) return req.destroy(), null; if (n <= max) b += c; } return n > max ? null : b; }
async function sticksRoute(req, res, path) {
  const json = (code, v) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(v));
  const img = path.match(/^\/sticks\/img\/([a-z0-9]+)\.jpg$/);
  if (img && req.method === 'GET') {
    if (!ID.test(img[1])) return res.writeHead(404).end();
    let jpg; try { jpg = await readFile(join(IMG_DIR, img[1] + '.jpg')); } catch { return res.writeHead(404).end(); }
    return res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' }).end(jpg);
  }
  if (path === '/sticks/assign') {
    if (req.method === 'GET') return json(200, assigned());
    if (req.method !== 'POST') return res.writeHead(405).end();
    let k; try { k = JSON.parse(await body(req, 1e3)); } catch {}
    if (!k || typeof k !== 'object') return json(400, { ok: false });
    for (const s of ['A', 'B']) if (s in k && k[s] !== null && !byId(k[s])) return json(400, { ok: false, error: `no stick ${s}` });
    for (const s of ['A', 'B']) if (s in k) db.assign[s] = k[s];
    saveDb(); toDashboards(sticksMsg()); log(`sticks: A ${db.assign.A ?? '-'}, B ${db.assign.B ?? '-'}`);
    return json(200, assigned());
  }
  if (path === '/sticks') {
    if (req.method === 'GET') return json(200, db.sticks.map(withStats));
    if (req.method !== 'POST') return res.writeHead(405).end();
    const b = await body(req, 1.5e6); if (b === null) return json(413, { ok: false, error: 'too big' });
    let k; try { k = JSON.parse(b); } catch {}
    const features = cleanFeatures(k?.features);
    const m = typeof k?.image === 'string' && k.image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
    const jpg = m && Buffer.from(m[1], 'base64');
    if (!features || !jpg || jpg.length > 1048576 || jpg[0] !== 0xff || jpg[1] !== 0xd8) { log(`sticks: refused (${!features ? 'features ' + JSON.stringify(k?.features) : 'image'})`); return json(400, { ok: false, error: 'features or image' }); }
    const id = Date.now().toString(36) + randomBytes(3).toString('hex'), seed = randomBytes(4).readUInt32LE(), rarity = stickRarity(seed, shapeScore(features));
    const name = String(k.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || `枝 ${db.sticks.length + 1}`;
    const rec = { id, createdAt: new Date().toISOString(), name, seed, rarity, element: stickElement(seed), stats: stickStats(seed, rarity, rarityMul), features, image: `/sticks/img/${id}.jpg` };
    await mkdir(IMG_DIR, { recursive: true }); await writeFile(join(IMG_DIR, id + '.jpg'), jpg);
    db.sticks.push(rec); saveDb(); log(`sticks: scanned ${id} ★${rarity} ${rec.element}`);
    return json(200, rec);
  }
  const del = path.match(/^\/sticks\/([a-z0-9]+)$/);
  if (del && req.method === 'PATCH') { // the admin edits a stick by hand
    const s = ID.test(del[1]) && byId(del[1]); if (!s) return json(404, { ok: false });
    const b = await body(req, 4096); let k; try { k = JSON.parse(b); } catch {}
    if (!k || typeof k !== 'object') return json(400, { ok: false });
    if ('element' in k && !ELEMENTS.includes(k.element)) return json(400, { ok: false, error: 'element' });
    if ('rarity' in k && !(Number.isInteger(k.rarity) && k.rarity >= 1 && k.rarity <= 5)) return json(400, { ok: false, error: 'rarity' });
    let custom;
    if (k.stats === null) custom = null;
    else if ('stats' in k) {
      if (!k.stats || typeof k.stats !== 'object' || !STAT_KEYS.every(n => typeof k.stats[n] === 'number' && Number.isFinite(k.stats[n]))) return json(400, { ok: false, error: 'stats' });
      custom = Object.fromEntries(STAT_KEYS.map(n => [n, +Math.min(STAT_RANGE[1], Math.max(STAT_RANGE[0], k.stats[n])).toFixed(2)]));
    }
    if ('name' in k) s.name = String(k.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || s.name;
    if ('element' in k) s.element = k.element;
    if ('rarity' in k) s.rarity = k.rarity;
    if (custom === null) delete s.custom; else if (custom) s.custom = custom;
    saveDb(); log(`sticks: edited ${s.id}`);
    if (['A', 'B'].some(x => db.assign[x] === s.id)) toDashboards(sticksMsg());
    return json(200, withStats(s));
  }
  if (del && req.method === 'DELETE') {
    if (!ID.test(del[1]) || !byId(del[1])) return json(404, { ok: false });
    db.sticks = db.sticks.filter(s => s.id !== del[1]);
    const was = ['A', 'B'].filter(s => db.assign[s] === del[1]); for (const s of was) db.assign[s] = null;
    saveDb(); rmSync(join(IMG_DIR, del[1] + '.jpg'), { force: true });
    if (was.length) toDashboards(sticksMsg());
    return json(200, { ok: true });
  }
  return res.writeHead(404).end();
}
async function onRequest(req, res) {
  try {
    // posix: '/' stays '/' on Windows too; backslashes become '/' first so they can't climb out of the folder
    let path = posix.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\\/g, '/')).replace(/^(\.\.[/\\])+/, '');
    if ((path === '/ca.pem' || path === '/ca.crt') && tls) return res.writeHead(200, { 'content-type': path.endsWith('.pem') ? 'application/x-pem-file' : 'application/x-x509-ca-cert', 'cache-control': 'no-store' }).end(tls.ca);
    if (path === '/marker.js') return res.writeHead(200, { 'content-type': types['.js'], 'cache-control': 'no-store' }).end(`export const MARKER = '${marker}', RUNE_SCALE = ${runeScale}; // server.mjs settings\n`);
    if (path === '/info') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(info(req.headers.host)));
    if (path === '/rules') return rulesFile(req, res);
    if (path === '/sticks' || path.startsWith('/sticks/')) return sticksRoute(req, res, path);
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
const lanAddr = a => !/^(::1|127\.)/.test(a?.replace(/^::ffff:/, '') ?? '');
function onUpgrade(req, socket, head) {
  const path = new URL(req.url, 'http://x').pathname, to = path === '/ws' ? wss : path === '/cam' ? camWss : null;
  if (process.env.NET_DEBUG && lanAddr(socket.remoteAddress)) {
    log(`net ${socket.remoteAddress?.replace(/^::ffff:/, '')}:${socket.remotePort} upgrade ${req.url} headers ${JSON.stringify(req.headers)}`);
    socket.once('close', () => log(`net ${socket.remotePort} upgraded socket closed, wrote ${socket.bytesWritten} B`));
  }
  if (!to) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  to.handleUpgrade(req, socket, head, ws => to.emit('connection', ws, req));
}
const plain = http.createServer(onRequest).on('upgrade', onUpgrade);
const secure = tls && https.createServer({ key: tls.key, cert: tls.cert }, onRequest).on('upgrade', onUpgrade);

// one port, two protocols: peek at the first byte and hand the socket to the matching server
const front = net.createServer(sock => {
  if (process.env.NET_DEBUG) { // NET_DEBUG=1: every TCP connection from the LAN — when it opens, its first bytes, when it ends
    const who = `${sock.remoteAddress?.replace(/^::ffff:/, '')}:${sock.remotePort}`, t0 = Date.now(), ms = () => Date.now() - t0;
    if (!/^(::1|127\.)/.test(sock.remoteAddress?.replace(/^::ffff:/, '') ?? '')) {
      log(`net ${who} open`);
      sock.once('data', b => log(`net ${who} first data after ${ms()} ms: ${b.length} B ${JSON.stringify(b.subarray(0, 60).toString('latin1'))}`));
      sock.on('close', () => log(`net ${who} closed after ${ms()} ms, read ${sock.bytesRead} B, wrote ${sock.bytesWritten} B`));
    }
  }
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
