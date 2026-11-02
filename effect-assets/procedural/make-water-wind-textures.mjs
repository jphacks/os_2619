// Procedural water / wind textures (deterministic: the same script always writes the same bytes).
//   node effect-assets/procedural/make-water-wind-textures.mjs
// Two kinds:
//  - tileable data maps for the scrolling mesh shaders (water-flow, water-foam, wind-streak): grey = value, alpha 255,
//    they wrap in both directions so the shader can scroll them along a column / funnel / ribbon (UV panning, as in the
//    Season waterfall and Unity nature-shader breakdowns)
//  - sprites (water-splash, water-drop, leaf): grey = brightness, alpha = coverage, soft noisy edges
// Writes effect-assets/textures/ and copies each file to product/dashboard/public/assets/<folder>/.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const textures = join(here, '..', 'textures');
const pub = join(here, '..', '..', 'product', 'dashboard', 'public', 'assets');

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const clamp = v => Math.max(0, Math.min(1, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function mulberry(a) { return () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// periodic value noise: lattice px × py, wraps over [0, 1)²
function lattice(px, py, seed) {
  const r = mulberry(seed), g = Float32Array.from({ length: px * py }, r);
  return (x, y) => {
    const fx = (x - Math.floor(x)) * px, fy = (y - Math.floor(y)) * py, ix = Math.floor(fx), iy = Math.floor(fy);
    let u = fx - ix, v = fy - iy; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
    const x1 = (ix + 1) % px, y1 = (iy + 1) % py;
    const a = g[iy * px + ix], b = g[iy * px + x1], c = g[y1 * px + ix], d = g[y1 * px + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fbm(px, py, oct, seed) {
  const L = Array.from({ length: oct }, (_, i) => lattice(px << i, py << i, seed + i * 101));
  return (x, y) => { let s = 0, a = .5, n = 0; for (const f of L) { s += a * f(x, y); n += a; a *= .5; } return s / n; };
}
// periodic Worley noise: F1, F2 of n jittered points per cell on a c × c grid
function worley(c, seed) {
  const r = mulberry(seed), pts = Array.from({ length: c * c }, () => [r(), r()]);
  return (x, y) => {
    const fx = (x - Math.floor(x)) * c, fy = (y - Math.floor(y)) * c, ix = Math.floor(fx), iy = Math.floor(fy);
    let f1 = 9, f2 = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j, p = pts[((cy + c) % c) * c + ((cx + c) % c)];
      const d = Math.hypot(cx + p[0] - fx, cy + p[1] - fy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  };
}
function normalise(a) { let lo = 1e9, hi = -1e9; for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); } for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / (hi - lo); return a; }
function dataMap(w, h, f) { // grey = f, alpha opaque
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = f(x / w, y / h);
  normalise(v);
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { const g = Math.round(v[i] * 255); out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g; out[i * 4 + 3] = 255; }
  return out;
}
function sprite(w, h, f, ss = 2) { // f(x, y) in [-1, 1]² → [v, a]
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0, a = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const [vv, aa] = f(((x + (i + .5) / ss) / w) * 2 - 1, 1 - ((y + (j + .5) / ss) / h) * 2);
      v += vv * aa; a += aa;
    }
    const o = (y * w + x) * 4, al = a / (ss * ss), g = Math.round(clamp(a > 0 ? v / a : 0) * 255);
    out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = Math.round(clamp(al) * 255);
  }
  return out;
}

// ---- data maps ----
// water-flow: long vertical streaks (x varies fast, y slow) with a broken, warped second layer. Scroll it along v.
const flowA = fbm(16, 2, 4, 11), flowB = fbm(32, 4, 3, 23), warp = fbm(4, 4, 3, 31);
const waterFlow = dataMap(256, 256, (x, y) => {
  const wx = x + (warp(x, y) - .5) * .12;
  const a = flowA(wx, y), b = flowB(wx * 1 + .3, y);
  return Math.pow(a, 1.6) * .7 + Math.pow(b, 2) * .5;
});
// water-foam: white water. Inverted Worley cell edges (bubbles packed together), broken up by an fbm mask
const wo = worley(9, 41), wo2 = worley(19, 43), foamMask = fbm(4, 4, 4, 47);
const waterFoam = dataMap(256, 256, (x, y) => {
  const [a1, a2] = wo(x, y), [b1, b2] = wo2(x, y);
  const edge = 1 - smooth(0, .22, a2 - a1), edge2 = 1 - smooth(0, .18, b2 - b1);
  const m = smooth(.35, .75, foamMask(x, y));
  return (edge * .65 + edge2 * .45) * (.25 + .75 * m) + m * .25;
});
// wind-streak: thin horizontal streaks of random length, tapered at both ends, wrapping in x. Scroll it along u.
const streaks = (() => {
  const r = mulberry(61), out = [];
  for (let i = 0; i < 70; i++) out.push({ y: r(), x: r(), len: .15 + .55 * r(), w: .003 + .012 * r() * r(), b: .35 + .65 * r() });
  return out;
})();
const windStreak = dataMap(256, 256, (x, y) => {
  let s = 0;
  for (const k of streaks) {
    let dy = Math.abs(y - k.y); dy = Math.min(dy, 1 - dy);
    if (dy > k.w * 4) continue;
    let dx = (x - k.x + 1) % 1; if (dx > k.len) continue;
    const u = dx / k.len, taper = Math.sin(Math.PI * u) ** .8 * (.4 + .6 * u); // brighter towards the head
    s += Math.exp(-(dy * dy) / (k.w * k.w * taper * taper + 1e-6)) * taper * k.b;
  }
  return Math.min(1.2, s);
});

// ---- sprites ----
// water-splash: a crown / sheet of water thrown up from a point at the bottom centre: ragged fingers of water, beads at their tips
const sn = fbm(8, 8, 4, 71), fingers = (() => { const r = mulberry(73); return Array.from({ length: 11 }, (_, i) => ({ a: -.95 + i / 10 * 1.9 + (r() - .5) * .15, len: .6 + .45 * r(), w: .09 + .08 * r() })); })();
const waterSplash = sprite(256, 256, (x, y) => {
  const py = y + .95, r = Math.hypot(x, py), th = Math.atan2(x, py); // angle from straight up
  const n = sn(x * .5 + .5, y * .5 + .5);
  let v = 0, a = 0;
  // the sheet: a fan between the fingers, thinning with height
  const sheet = smooth(1.15, .8, Math.abs(th)) * smooth(1.05 + .35 * n, .5, r) * smooth(.02, .2, r);
  a = Math.max(a, sheet * smooth(.25, .6, n + .25 * (1 - r))); v = Math.max(v, .45 + .3 * n);
  for (const f of fingers) {
    const d = Math.abs(th - f.a) * r, L = f.len * (1.4 + .2 * n);
    const body = smooth(f.w * (1.1 - .6 * r / L) * (.6 + .8 * n), 0, d) * smooth(L, L * .8, r);
    if (body > a) { a = body; v = .7 + .3 * (1 - d / f.w); }
    const tip = Math.hypot(x - Math.sin(f.a) * L * 1.04, py - Math.cos(f.a) * L * 1.04), br = f.w * .9; // a bead at the tip
    const bead = smooth(br, br * .6, tip);
    if (bead > .01) { a = Math.max(a, bead); v = Math.max(v, .85 + .15 * smooth(br * .5, 0, Math.hypot(x - Math.sin(f.a) * L * 1.04 + br * .3, py - Math.cos(f.a) * L * 1.04 - br * .3))); }
  }
  return [v, a];
});
// water-drop: a bead with a tail (points up the texture: head at +y), dark-ish body, bright rim and a glint
const waterDrop = sprite(64, 128, (x, y) => {
  const head = .55, hr = .38, d = Math.hypot(x / hr, (y - head) / hr);
  const tail = y < head ? smooth(1, .9, Math.abs(x) / (hr * (.15 + .85 * smooth(-1, head, y)))) * smooth(-1, -.6, y) : 0;
  const a = Math.max(smooth(1, .85, d), tail);
  const rim = smooth(.55, .95, d), glint = Math.exp(-((x + .13) ** 2 + (y - head - .14) ** 2) * 160);
  return [Math.min(1, .35 + .45 * rim + glint), a];
});
// leaf: a pointed oval, midrib and veins, a short stem; grey shading (the shader tints it)
const ln = fbm(4, 4, 3, 83);
const leaf = sprite(64, 64, (x, y) => {
  const u = (y + .85) / 1.7, w = Math.sin(Math.PI * clamp(u)) ** .8 * .48 * (1 - .25 * u);
  const body = smooth(w, w * .85, Math.abs(x)) * (u > 0 && u < 1 ? 1 : 0);
  const stem = smooth(.04, .02, Math.abs(x)) * smooth(-1, -.95, y) * smooth(-.8, -.85, y);
  const rib = Math.exp(-x * x * 900);
  const vf = ((((y + .9) - Math.abs(x) * 1.1) * 4.5 % 1) + 1) % 1 - .5; // diagonal side veins
  const vein = Math.exp(-vf * vf * 60) * smooth(w, 0, Math.abs(x)) * .25;
  const a = Math.max(body, stem);
  return [clamp(.45 + .25 * ln(x * .5 + .5, y * .5 + .5) + rib * .35 + vein - .2 * Math.abs(x) / Math.max(w, .01)), a];
});

const FILES = [
  ['water-flow.png', 256, 256, waterFlow, ['water', 'wind']],
  ['water-foam.png', 256, 256, waterFoam, ['water']],
  ['wind-streak.png', 256, 256, windStreak, ['wind', 'water']],
  ['water-splash.png', 256, 256, waterSplash, ['water']],
  ['water-drop.png', 64, 128, waterDrop, ['water']],
  ['leaf.png', 64, 64, leaf, ['wind']],
];
mkdirSync(textures, { recursive: true });
for (const [name, w, h, data, folders] of FILES) {
  const b = png(w, h, data);
  writeFileSync(join(textures, name), b);
  for (const d of folders) { mkdirSync(join(pub, d), { recursive: true }); writeFileSync(join(pub, d, name), b); }
  console.log(name, b.length);
}
