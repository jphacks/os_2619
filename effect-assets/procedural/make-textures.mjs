// Procedural effect textures: shapes the painted textures/ PNGs do not cover (star flare, spiky hit burst, PK diamond,
// Spark-style corona, shock ring). Deterministic: the same script always writes the same bytes.
//   node effect-assets/procedural/make-textures.mjs
// Writes straight RGBA PNGs (grey = brightness, alpha = coverage) to effect-assets/textures/ and copies each one into the
// product/dashboard/public/assets/<module>/ folders that use it.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const textures = join(here, '..', 'textures');
const pub = join(here, '..', '..', 'product', 'dashboard', 'public', 'assets');

// ---- PNG ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- helpers ----
const clamp = v => Math.max(0, Math.min(1, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function mulberry(a) { return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
/** f(x, y) in [-1, 1]² → { v: brightness 0..1, a: alpha 0..1 }, supersampled 3×3 for clean edges. */
function render(w, h, f, ss = 3) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0, a = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const r = f(((x + (i + .5) / ss) / w) * 2 - 1, 1 - ((y + (j + .5) / ss) / h) * 2);
      v += r.v * r.a; a += r.a;
    }
    a /= ss * ss; v = a > 0 ? v / (ss * ss) / a : 0;
    const o = (y * w + x) * 4, g = Math.round(clamp(v) * 255);
    out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = Math.round(clamp(a) * 255);
  }
  return out;
}

// ---- shapes ----
/** Lens star: 4 long rays, 4 shorter diagonals, a hot centre. Palutena's flash, Firaga's hit flash. */
function starFlare(x, y) {
  const r = Math.hypot(x, y), t = Math.atan2(y, x);
  let rays = 0;
  for (let k = 0; k < 8; k++) {
    const main = k % 2 === 0, ang = k * Math.PI / 4, len = main ? 1 : .5, width = main ? .016 : .011;
    const d = Math.abs(angDiff(t, ang)) * r;
    rays = Math.max(rays, Math.exp(-(d * d) / (width * width * (1 + 3 * r))) * Math.pow(clamp(1 - r / len), main ? 1.4 : 1.8));
  }
  const core = Math.exp(-r * r / .006), halo = Math.exp(-r * r / .03) * .5;
  const a = clamp(Math.max(rays, core, halo));
  return { v: clamp(.7 + .3 * Math.max(core, rays)), a };
}
/** Comic hit burst: irregular sharp spikes, white centre fading to light grey at the tips. */
function spikeBurst(seed, spikes, inner) {
  // a closed polygon alternating tip / valley vertices, straight edges like a hand-drawn hit star
  const R = mulberry(seed), poly = [];
  for (let i = 0; i < spikes; i++) {
    const a = (i + (R() - .5) * .35) / spikes * Math.PI * 2, big = R() < .45, len = big ? .8 + R() * .18 : .55 + R() * .2;
    const v = (i + .5 + (R() - .5) * .3) / spikes * Math.PI * 2, vr = inner * (.85 + R() * .3);
    poly.push([Math.cos(a) * len, Math.sin(a) * len], [Math.cos(v) * vr, Math.sin(v) * vr]);
  }
  return (x, y) => {
    let inside = false, d = 9;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      const ex = xj - xi, ey = yj - yi, t = clamp(((x - xi) * ex + (y - yi) * ey) / (ex * ex + ey * ey));
      d = Math.min(d, Math.hypot(x - xi - ex * t, y - yi - ey * t));
    }
    const sd = inside ? d : -d, a = clamp(sd / (1.5 / 256) + .5), r = Math.hypot(x, y);
    // brightness: hot core, slightly darker toward the tips, a thin bright rim inside the outline
    const v = clamp(1 - .38 * smooth(.08, .85, r) + .25 * Math.exp(-sd * sd / .0004));
    return { v, a };
  };
}
/** PK diamond: a tall rhombus with a hot centre and a thin glow. */
function diamond(x, y) {
  const d = Math.abs(x) / .5 + Math.abs(y) / .92, body = clamp((1 - d) / .03 + .5);
  const glow = Math.exp(-Math.max(0, d - 1) * 9) * .35;
  return { v: clamp(.78 + .22 * (1 - d)), a: clamp(Math.max(body, glow)) };
}
/** Spark ball corona: a thin rim with short irregular saw teeth pointing outward. */
function corona(seed) {
  const R = mulberry(seed), teeth = 34, len = Array.from({ length: teeth }, () => .1 + R() * .17);
  return (x, y) => {
    const r = Math.hypot(x, y); let t = Math.atan2(y, x); if (t < 0) t += Math.PI * 2;
    const f = t / (Math.PI * 2) * teeth, i = Math.floor(f), u = f - i, tri = 1 - Math.abs(u * 2 - 1);
    const base = .66, tip = base + len[i % teeth] * tri;
    const tooth = clamp((tip - r) / .012 + .5) * clamp((r - base + .02) / .012 + .5);
    const rim = Math.exp(-((r - base) ** 2) / .0012), inner = Math.exp(-((r - base) ** 2) / .02) * .35 * (r < base ? 1 : 0);
    return { v: clamp(.75 + .25 * rim), a: clamp(Math.max(tooth * .95, rim, inner)) };
  };
}
/** Thin soft shock ring for floor rings and expanding hit rings. */
function shockRing(x, y) {
  const r = Math.hypot(x, y), d = r - .86;
  const a = Math.exp(-(d * d) / .0016) + Math.exp(-(d * d) / .012) * .35 * (r < .86 ? 1 : .4);
  return { v: clamp(.7 + .3 * Math.exp(-(d * d) / .0016)), a: clamp(a) };
}

const jobs = [
  { name: 'star-flare.png', w: 512, h: 512, f: starFlare, to: ['fire', 'thunder', 'charge'] },
  { name: 'spike-burst.png', w: 512, h: 512, f: spikeBurst(7, 17, .42), to: ['fire', 'thunder', 'charge'] },
  { name: 'spike-burst-2.png', w: 512, h: 512, f: spikeBurst(23, 13, .36), to: ['thunder'] },
  { name: 'pk-diamond.png', w: 128, h: 128, f: diamond, to: ['fire'] },
  { name: 'spark-corona.png', w: 512, h: 512, f: corona(11), to: ['charge'] },
  { name: 'shock-ring.png', w: 512, h: 512, f: shockRing, to: ['fire', 'charge'] },
];
for (const j of jobs) {
  const data = png(j.w, j.h, render(j.w, j.h, j.f));
  writeFileSync(join(textures, j.name), data);
  for (const m of j.to) { mkdirSync(join(pub, m), { recursive: true }); writeFileSync(join(pub, m, j.name), data); }
  console.log(j.name, j.w + 'x' + j.h, data.length, 'bytes →', j.to.join(', '));
}
