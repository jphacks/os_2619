// Serves this folder. The page talks to the sensing server (sensing/dashboard/server.mjs, port 8000) directly.
// Run: node serve.mjs   then open http://localhost:8080   (?host=IP:8000 to point at another PC)
// /cdn/npm/<pkg>@<x.y.z>/<file> is cdn.jsdelivr.net/npm/... cached in vendor/cdn/: fetched once while online, served from disk
// afterwards (venue Wi-Fi down, no Internet at all). `node serve.mjs --prefetch` fills the cache with what the pages use.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = +process.env.PORT || 8080;
const root = fileURLToPath(new URL('.', import.meta.url));
const cache = join(root, 'vendor', 'cdn');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };
const PREFETCH = [
  'npm/three@0.160.0/build/three.module.js', 'npm/three@0.160.0/examples/jsm/controls/OrbitControls.js',
  'npm/js-aruco2@2.0.0/src/cv.js', 'npm/js-aruco2@2.0.0/src/aruco.js', 'npm/js-aruco2@2.0.0/src/dictionaries/apriltag_36h11.js',
];

const pinned = p => /^npm\/(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\/[\w./@-]+$/.test(p) && !p.includes('..'); // exact versions only: the cache never goes stale
async function fromCdn(p) {
  const file = join(cache, p);
  try { return await readFile(file); } catch {}
  const r = await fetch('https://cdn.jsdelivr.net/' + p);
  if (!r.ok) throw new Error(`cdn ${r.status} ${p}`);
  const body = Buffer.from(await r.arrayBuffer());
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, body);
  return body;
}

if (process.argv.includes('--prefetch')) {
  for (const p of PREFETCH) { await fromCdn(p); console.log('cached', p); }
  process.exit(0);
}

http.createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path === '/') path = '/index.html';
  if (path.startsWith('/cdn/')) {
    const p = path.slice(5);
    if (!pinned(p)) return res.writeHead(404).end();
    try { return res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' }).end(await fromCdn(p)); }
    catch (e) { console.warn(e.message); return res.writeHead(502).end(); }
  }
  // the sensing team's pure-logic modules (space map), read from their folder so we always run their latest version
  if (path === '/sensing/map.js') path = '/../sensing/dashboard/map.js';
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(PORT, () => console.log(`effects: http://localhost:${PORT}`));
