// RuneTags for the mahoujin (魔法陣): one big printed magic circle on the floor carrying 7 tags T0-T6 = ids 0-6, the alternative to
// tag36h11 (world.js MARKER). Plain JS (no deps): the page, the tag worker and node tests use it. Rune.kt / Rune.swift have the same detector.
//
// The print is ../../mahoujin/magic-circle-576808920-A3.pdf (a generator's A3 kit). Its tags are official RUNE-Tag (Bergamasco et al.
// 2011) RUNE-43 markers, IDX 8, 10, 15, 23, 24, 26, 29: 43 sectors x 3 layers of black dots at 4/6, 5/6, 6/6 of 127.82 mm, dot radius =
// layer radius / 17.8 (so every layer looks alike up to scale). Each sector holds a non-empty subset of its 3 slots. RUNE_CODES were read
// off the kit's patch pages (pages 27-33); any two (id, turn) words differ in >= 45 of the 129 bits. Our own detector, not the library.
//
// Marker frame = world.js tag frame: x right, y up as you look at the poster, metres, origin at the tag centre. The patches are never
// turned, so every tag's up is the poster's up. Sector 0 is on +x (as in RUNE-Tag), sectors go clockwise as seen. The detector reports
// the corners of a virtual SQUARE (side RUNE.square) in OpenCV order, from a homography fitted to every dot it read, so everything
// downstream treats a RuneTag like an AprilTag of that size. square = 0.8 x sheet (the Ø 280 mm patch disc), the AprilTag paper rule.
export const RUNE = {
  sheet: 0.28,                     // patch disc diameter: the drawn / rendered square around one tag, m
  square: 0.224,                   // side of the virtual square whose corners are reported (world.js TAGS size before RUNE_SCALE)
  sectors: 43,
  rings: [0.12782, 0.12782 * 5 / 6, 0.12782 * 4 / 6], // layer radii, outer first
  dot: 1 / 17.8,                   // dot radius / layer radius
  circle: 0.4905,                  // tag centres lie on this circle round the mahoujin centre, T0 at 12 o'clock, then clockwise every 1/7 turn
};
export const RUNE_IDS = [0, 1, 2, 3, 4, 5, 6];
// per id (T0-T6), per sector: bit k = layer k (0 outer) has a dot
export const RUNE_CODES = [
  [2, 7, 7, 2, 4, 2, 2, 7, 7, 6, 1, 2, 7, 5, 3, 3, 6, 6, 6, 2, 5, 6, 5, 5, 6, 3, 7, 3, 7, 6, 4, 2, 3, 3, 5, 1, 4, 3, 7, 4, 4, 1, 3],
  [4, 3, 3, 6, 2, 6, 2, 4, 5, 5, 4, 1, 5, 4, 3, 3, 7, 7, 4, 4, 3, 2, 6, 3, 2, 2, 3, 5, 1, 5, 1, 4, 4, 3, 2, 1, 2, 5, 7, 2, 5, 6, 5],
  [2, 2, 2, 7, 5, 7, 3, 7, 1, 6, 6, 5, 4, 6, 2, 4, 3, 4, 4, 5, 2, 3, 1, 2, 3, 2, 5, 2, 5, 6, 6, 5, 1, 4, 4, 7, 2, 5, 6, 1, 3, 2, 4],
  [3, 6, 6, 3, 7, 3, 4, 7, 5, 1, 7, 3, 2, 3, 3, 1, 2, 1, 4, 7, 1, 7, 6, 1, 7, 4, 3, 1, 5, 1, 7, 7, 3, 1, 7, 2, 3, 5, 5, 4, 6, 2, 6],
  [4, 1, 1, 1, 1, 1, 4, 7, 1, 3, 3, 5, 3, 6, 5, 4, 4, 7, 6, 6, 3, 7, 1, 3, 7, 7, 3, 1, 7, 3, 6, 6, 7, 4, 4, 5, 6, 3, 5, 3, 3, 1, 7],
  [6, 1, 1, 1, 1, 1, 4, 2, 3, 1, 4, 3, 3, 5, 7, 7, 3, 3, 7, 6, 4, 5, 7, 4, 5, 6, 1, 2, 6, 1, 7, 6, 1, 7, 3, 1, 1, 2, 5, 1, 4, 6, 2],
  [2, 2, 2, 7, 5, 7, 5, 2, 6, 7, 4, 5, 3, 1, 5, 3, 6, 5, 4, 6, 7, 2, 2, 7, 2, 7, 6, 1, 3, 7, 6, 6, 4, 3, 7, 2, 1, 5, 4, 2, 1, 4, 6],
];
const S = RUNE.sectors, K = RUNE.rings.length, STEP = 2 * Math.PI / S;
/** Centre of slot (ring k, sector j) in the marker frame. */
export const slotPos = (k, j) => { const a = -j * STEP, r = RUNE.rings[k]; return [r * Math.cos(a), r * Math.sin(a)]; };

// ---- drawing: a list of primitives in the marker frame (m), shared by the PDF, the test renderer and the dummy camera ----
//   { t: 'disc', c, r }   { t: 'circle', c, r, w }   { t: 'path', p: [[x, y], ...], w, closed }
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rot = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
/** A futhark-like glyph: a stave plus 1-3 random strokes on a 3 x 4 grid, `h` tall, centred at `c`, its up turned to angle `a`. */
function glyph(r, c, a, h, w) {
  const node = (i, j) => add(c, rot([(i - 1) * h / 3, (j - 1.5) * h / 3], a - Math.PI / 2));
  const out = [{ t: 'path', p: [node(1, 0), node(1, 3)], w }];
  for (let n = 1 + Math.floor(r() * 3); n--;) {
    const j = Math.floor(r() * 3), i = r() < .5 ? 0 : 2, k = r();
    out.push({ t: 'path', p: k < .4 ? [node(1, j), node(i, j + 1)] : k < .7 ? [node(1, j + 1), node(i, j), node(1, j)] : [node(i, j), node(1, j + 1)], w });
  }
  return out;
}
/** Everything printed on patch `id`: the dots, then (art) a thick rune in the middle like the kit's (a stand-in shape, for the tests). */
export function runePrims(id, { art = true } = {}) {
  const out = [], code = RUNE_CODES[id];
  for (let j = 0; j < S; j++) for (let k = 0; k < K; k++) if (code[j] >> k & 1) out.push({ t: 'disc', c: slotPos(k, j), r: RUNE.dot * RUNE.rings[k] });
  return art ? out.concat(glyph(rng(977 * (id + 1)), [0, 0], Math.PI / 2, .1, .009)) : out;
}
/** Ink coverage (0 paper .. 1 black) of the sheet on an n x n grid, row 0 at the top edge (y = +sheet/2). */
export function rasterPrims(prims, n) {
  const ink = new Float32Array(n * n), h = RUNE.sheet / 2, px = RUNE.sheet / n;
  const toPx = v => (v + h) / px, cl = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const paint = (x0, y0, x1, y1, cov) => { // bbox in m, cov(x, y) -> 0..1
    const i0 = Math.max(0, Math.floor(toPx(x0))), i1 = Math.min(n - 1, Math.ceil(toPx(x1))), j0 = Math.max(0, Math.floor(toPx(-y1))), j1 = Math.min(n - 1, Math.ceil(toPx(-y0)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const v = cov((i + .5) * px - h, h - (j + .5) * px); if (v > ink[j * n + i]) ink[j * n + i] = v; }
  };
  const line = (w, d) => Math.min(w, px) / px * cl(.5 + (Math.max(w, px) / 2 - d) / px); // thin lines fade instead of fattening
  const segD = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = cl(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
  for (const p of prims) {
    if (p.t === 'disc') paint(p.c[0] - p.r - px, p.c[1] - p.r - px, p.c[0] + p.r + px, p.c[1] + p.r + px, (x, y) => cl(.5 + (p.r - Math.hypot(x - p.c[0], y - p.c[1])) / px));
    else if (p.t === 'circle') { const e = p.r + p.w + px; paint(p.c[0] - e, p.c[1] - e, p.c[0] + e, p.c[1] + e, (x, y) => line(p.w, Math.abs(Math.hypot(x - p.c[0], y - p.c[1]) - p.r))); }
    else {
      const pts = p.closed ? [...p.p, p.p[0]] : p.p;
      for (let s = 0; s + 1 < pts.length; s++) {
        const a = pts[s], b = pts[s + 1], e = p.w + px;
        paint(Math.min(a[0], b[0]) - e, Math.min(a[1], b[1]) - e, Math.max(a[0], b[0]) + e, Math.max(a[1], b[1]) + e, (x, y) => line(p.w, segD(x, y, a, b)));
      }
    }
  }
  return ink;
}

// ---- small linear algebra ----
/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi): { vals, V } with eigenvectors in the columns of V. */
function jacobi(A) {
  const n = A.length, a = A.map(r => [...r]), V = a.map((_, i) => a.map((_, j) => +(i === j)));
  const tot = a.reduce((s, r) => s + r.reduce((t, v) => t + v * v, 0), 0);
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off <= 1e-30 * tot) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (a[p][q] === 0) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < n; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < n; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
    }
  }
  return { vals: a.map((r, i) => r[i]), V };
}
/** Unit vector minimising |A x| for the rows of A (smallest eigenvector of AᵀA). */
function nullVec(rows) {
  const n = rows[0].length, M = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const r of rows) for (let i = 0; i < n; i++) for (let j = i; j < n; j++) M[i][j] += r[i] * r[j];
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) M[i][j] = M[j][i];
  const { vals, V } = jacobi(M); let m = 0; for (let i = 1; i < n; i++) if (vals[i] < vals[m]) m = i;
  return V.map(r => r[m]);
}
const normalizer = P => { // Hartley: centroid to 0, mean distance sqrt 2
  const mx = P.reduce((s, p) => s + p[0], 0) / P.length, my = P.reduce((s, p) => s + p[1], 0) / P.length;
  const d = P.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / P.length || 1;
  return { s: Math.SQRT2 / d, mx, my };
};
/** Least-squares homography (9 numbers, row-major) mapping src [x, y] to dst [u, v]; >= 4 pairs. */
export function homography(src, dst) {
  const a = normalizer(src), b = normalizer(dst), rows = [];
  src.forEach((p, i) => {
    const x = (p[0] - a.mx) * a.s, y = (p[1] - a.my) * a.s, u = (dst[i][0] - b.mx) * b.s, v = (dst[i][1] - b.my) * b.s;
    rows.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  });
  const h = nullVec(rows);
  // H = Tb^-1 Hn Ta, T = [[s, 0, -s m], [0, s, -s m], [0, 0, 1]]
  const Ta = [a.s, 0, -a.s * a.mx, 0, a.s, -a.s * a.my, 0, 0, 1], Tbi = [1 / b.s, 0, b.mx, 0, 1 / b.s, b.my, 0, 0, 1];
  const m = (A, B) => { const r = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]); return r; };
  const H = m(m(Tbi, h), Ta), s = H[8] || 1;
  return H.map(v => v / s);
}
export const project = (H, x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
/** Ellipse through points: { c, M } with (p - c)ᵀ M (p - c) = 1, or null. */
function fitEllipse(P) {
  const nz = normalizer(P), q = P.map(p => [(p[0] - nz.mx) * nz.s, (p[1] - nz.my) * nz.s]);
  const [A, B, C, D, E, F] = nullVec(q.map(([x, y]) => [x * x, x * y, y * y, x, y, 1]));
  const det = 4 * A * C - B * B; if (!(det > 0)) return null;
  const x0 = (B * E - 2 * C * D) / det, y0 = (B * D - 2 * A * E) / det, f = A * x0 * x0 + B * x0 * y0 + C * y0 * y0 + D * x0 + E * y0 + F;
  if (!(f !== 0)) return null;
  const k = -1 / f, s2 = nz.s * nz.s, M = [A * k * s2, B / 2 * k * s2, C * k * s2]; // [m11, m12, m22] in pixels
  if (!(M[0] > 0 && M[0] * M[2] - M[1] * M[1] > 0)) return null;
  return { c: [x0 / nz.s + nz.mx, y0 / nz.s + nz.my], M };
}
/** Square root of a 2x2 SPD [a, b, c] (= [[a, b], [b, c]]): maps the ellipse (p - c)ᵀ M (p - c) = 1 to the unit circle, orientation kept. */
const sqrtSym = ([a, b, c]) => { const sd = Math.sqrt(a * c - b * b), t = Math.sqrt(a + c + 2 * sd); return [(a + sd) / t, b / t, (c + sd) / t]; };
const mul2 = (m, x, y) => [m[0] * x + m[1] * y, m[1] * x + m[2] * y];

// ---- detection ----
/** Dark blobs that look like filled ellipses: { x, y, cov: [sxx, sxy, syy], n }. g: grey (0-255), w x h. rad: threshold window radius. */
function blobs(g, w, h, rad) {
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; } }
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1), n = (y1 - y0) * (x1 - x0);
      const sum = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
      bin[y * w + x] = g[y * w + x] * n < sum * .85 - 6 * n ? 1 : 0; // clearly darker than the neighbourhood
    }
  }
  const out = [], stack = new Int32Array(w * h), maxN = w * h / 50;
  for (let s = 0; s < w * h; s++) {
    if (bin[s] !== 1) continue;
    let top = 0, n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, edge = false;
    stack[top++] = s; bin[s] = 2;
    while (top) {
      const p = stack[--top], x = p % w, y = (p - x) / w, cx = x + .5, cy = y + .5;
      n++; sx += cx; sy += cy; sxx += cx * cx; sxy += cx * cy; syy += cy * cy;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && bin[p - 1] === 1) { bin[p - 1] = 2; stack[top++] = p - 1; }
      if (x < w - 1 && bin[p + 1] === 1) { bin[p + 1] = 2; stack[top++] = p + 1; }
      if (y > 0 && bin[p - w] === 1) { bin[p - w] = 2; stack[top++] = p - w; }
      if (y < h - 1 && bin[p + w] === 1) { bin[p + w] = 2; stack[top++] = p + w; }
    }
    if (edge || n < 6 || n > maxN) continue;
    const x = sx / n, y = sy / n, cov = [sxx / n - x * x + 1 / 12, sxy / n - x * y, syy / n - y * y + 1 / 12]; // + pixel's own spread
    const tr = cov[0] + cov[2], dt = cov[0] * cov[2] - cov[1] * cov[1], d = Math.sqrt(Math.max(0, tr * tr / 4 - dt)), l1 = tr / 2 + d, l2 = tr / 2 - d;
    if (!(l2 > 0)) continue;
    const fill = n / (4 * Math.PI * Math.sqrt(l1 * l2)); // area / area of the ellipse with the same moments (semi-axes 2 sqrt(l))
    if (fill < .7 || fill > 1.3 || l2 / l1 < .04) continue;
    out.push({ x, y, cov, n, a: 2 * Math.sqrt(l1) });
  }
  return out;
}
/**
 * Detect RuneTags in a grey image (any array of 0-255, w x h): [{ id, corners: [[u,v] x4], err, n, rms }] with corners of the
 * virtual square (side RUNE.square) in OpenCV order, tag (-h,h), (h,h), (h,-h), (-h,-h). err: bits that disagree with the code,
 * n: dots matched, rms: their reprojection error (px).
 */
export function detectRunes(g, w, h, { ids = RUNE_IDS } = {}) {
  const found = new Map();
  for (const rad of [Math.max(4, Math.round(Math.min(w, h) / 40)), Math.round(Math.min(w, h) / 10)]) {
    for (const m of detectPass(blobs(g, w, h, rad), w, h, ids)) {
      const o = found.get(m.id); if (!o || m.n - 2 * m.err > o.n - 2 * o.err) found.set(m.id, m);
    }
  }
  return [...found.values()];
}
const RHO = 1 / RUNE.dot; // ring radius in dot radii, the same on every ring
function detectPass(B, w, h, ids) {
  B.sort((p, q) => q.n - p.n);
  const byX = B.map((b, i) => i).sort((i, j) => B[i].x - B[j].x), xs = byX.map(i => B[i].x);
  const lower = v => { let lo = 0, hi = xs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m + 1; else hi = m; } return lo; };
  const near = (x, y, r, cb) => { for (let t = lower(x - r); t < xs.length && xs[t] <= x + r; t++) if (Math.abs(B[byX[t]].y - y) <= r) cb(byX[t]); };
  const used = new Uint8Array(B.length), out = [];
  for (let si = 0; si < B.length && si < 400; si++) {
    if (used[si]) continue;
    const s = B[si], Mi = sqrtSym(inv2(s.cov)).map(v => v / 2); // whitens the seed dot to radius 1 (a disc of radius r has variance r^2 / 4)
    const reach = 2.8 * RHO * s.a; // the ring diameter in px, generously (s.a: the seed's semi-major axis)
    const cand = [];
    for (let t = lower(s.x - reach); t < xs.length && xs[t] <= s.x + reach; t++) {
      const i = byX[t], b = B[i]; if (i === si || used[i] || Math.abs(b.y - s.y) > reach) continue;
      const p = mul2(Mi, b.x - s.x, b.y - s.y), rs = Math.sqrt(Math.sqrt(det2(mulT(Mi, b.cov)))) * 2; // its radius in seed radii
      if (rs > .78 && rs < 1.28 && Math.hypot(p[0], p[1]) < 2 * RHO * 1.35) cand.push({ i, p });
    }
    if (cand.length < 5) continue;
    cand.sort((a, b) => Math.hypot(...a.p) - Math.hypot(...b.p));
    const near24 = cand.slice(0, 24);
    let best = null;
    for (let a = 0; a < near24.length; a++) for (let b = a + 1; b < near24.length; b++) { // circle through the seed and two more
      const P = near24[a].p, Q = near24[b].p, d = 2 * (P[0] * Q[1] - P[1] * Q[0]); if (Math.abs(d) < 1e-9) continue;
      const pp = P[0] * P[0] + P[1] * P[1], qq = Q[0] * Q[0] + Q[1] * Q[1], c = [(pp * Q[1] - qq * P[1]) / d, (qq * P[0] - pp * Q[0]) / d], R = Math.hypot(...c);
      if (R < .7 * RHO || R > 1.4 * RHO) continue;
      const inl = near24.filter(o => Math.abs(Math.hypot(o.p[0] - c[0], o.p[1] - c[1]) - R) < .12 * R);
      if (!best || inl.length > best.length) best = inl;
    }
    // the nearest 24 cover only an arc of a 43-sector layer: fit an ellipse through them and collect that layer's dots from every
    // candidate (the layers are >= 1/6 apart, so 0.06 keeps the neighbours out)
    for (let it = 0; it < 2 && best && best.length >= 4; it++) {
      const e = fitEllipse([[0, 0], ...best.map(o => o.p)]); if (!e) break;
      const R = sqrtSym(e.M); best = cand.filter(o => Math.abs(Math.hypot(...mul2(R, o.p[0] - e.c[0], o.p[1] - e.c[1])) - 1) < .06);
    }
    if (!best || best.length < 5) continue;
    const ringIdx = [si, ...best.map(o => o.i)], m = readMarker(B, near, ringIdx, w, h, ids);
    if (!m) continue;
    for (const i of m.used) used[i] = 1;
    delete m.used; out.push(m);
  }
  return out;
}
const inv2 = ([a, b, c]) => { const d = a * c - b * b; return [c / d, -b / d, a / d]; };
const det2 = ([a, b, c]) => a * c - b * b;
const mulT = (M, C) => { // M C Mᵀ for symmetric 2x2 [a, b, c]
  const [a, b, c] = M, [p, q, r] = C, x = a * p + b * q, y = a * q + b * r, z = b * p + c * q, u = b * q + c * r;
  return [x * a + y * b, x * b + y * c, z * b + u * c];
};
/** One ring's dots found: order them round the ring, try each ring index, read all 129 slots through the homography, decode. */
function readMarker(B, near, ringIdx, w, h, ids) {
  const P = ringIdx.map(i => [B[i].x, B[i].y]), e = fitEllipse(P);
  if (!e) return null;
  const R = sqrtSym(e.M), ang = P.map(p => { const q = mul2(R, p[0] - e.c[0], p[1] - e.c[1]); return { r: Math.hypot(...q), a: Math.atan2(q[1], q[0]) }; });
  if (ang.some(o => Math.abs(o.r - 1) > .12)) return null;
  // number the dots by the sector gaps between neighbours (image angles grow clockwise as seen, like the sector numbers). Perspective
  // bends the ellipse angles too much to count all 43 sectors round the ring, so take the longest run of neighbours whose gaps read
  // cleanly (1-5 sectors). The numbers are relative: decoding tries every turn.
  const n = P.length, ord = ang.map((o, i) => i).sort((i, j) => ang[i].a - ang[j].a);
  const gaps = ord.map((o, t) => { let g = ang[ord[(t + 1) % n]].a - ang[o].a; if (g <= 0) g += 2 * Math.PI; return g / STEP; });
  const good = gaps.map(g => { const m = Math.round(g); return m >= 1 && m <= 5 && Math.abs(g - m) <= .4; });
  let start = 0, len = n - 1; // all good: every dot, the run starting anywhere
  if (!good.every(Boolean)) {
    len = 0;
    for (let t = 0; t < n; t++) if (!good[(t + n - 1) % n]) { let L = 0; while (good[(t + L) % n]) L++; if (L > len) { len = L; start = t; } }
  }
  if (len < 4) return null;
  const run = [], sec = [];
  for (let t = 0, j = 0; t <= len; t++) { const u = (start + t) % n; run.push(P[ord[u]]); sec.push(j); j += Math.round(gaps[u]); }
  let best = null;
  for (let k = 0; k < K; k++) {
    let H = homography(sec.map(s => slotPos(k, s)), run), read = null;
    for (let it = 0; it < 3; it++) {
      read = readSlots(B, near, H, w, h);
      if (read.hits.length < 6) break;
      H = homography(read.hits.map(o => slotPos(o.k, o.j)), read.hits.map(o => [B[o.i].x, B[o.i].y]));
    }
    if (!read || read.known < 30) continue;
    for (const id of ids) for (let r = 0; r < S; r++) { // observed sector j is the code's sector j + r
      let err = 0;
      for (let jj = 0; jj < S; jj++) for (let kk = 0; kk < K; kk++) { const b = read.bits[kk * S + jj]; if (b >= 0 && b !== (RUNE_CODES[id][(jj + r) % S] >> kk & 1)) err++; }
      if (!best || err < best.err) best = { err, id, r, read, second: best ? Math.min(best.second, best.err) : 99 };
      else if (err < best.second) best.second = err;
    }
  }
  // wrong bits allowed: 1 in 8 of those seen (>= 7); any two words differ in >= 45 of 129, so a right read also wins clearly
  if (!best || best.err > maxErr(best.read.known) || best.second < best.err + 8) return null;
  const code = RUNE_CODES[best.id], fit = hs => homography(hs.map(o => slotPos(o.k, o.j)), hs.map(o => [B[o.i].x, B[o.i].y]));
  // the true sector numbers from here on; read again through the refitted homography, keeping only dots where the code has one
  let hits = best.read.hits.map(o => ({ ...o, j: (o.j + best.r) % S })).filter(o => code[o.j] >> o.k & 1), err = best.err, known = best.read.known;
  for (let it = 0; it < 2 && hits.length >= 8; it++) {
    const rd = readSlots(B, near, fit(hits), w, h);
    err = 0; known = rd.known; for (let k = 0; k < K; k++) for (let j = 0; j < S; j++) { const b = rd.bits[k * S + j]; if (b >= 0 && b !== (code[j] >> k & 1)) err++; }
    hits = rd.hits.filter(o => code[o.j] >> o.k & 1);
  }
  if (hits.length < 8 || err > maxErr(known)) return null;
  const src = hits.map(o => slotPos(o.k, o.j)), dst = hits.map(o => [B[o.i].x, B[o.i].y]), H = fit(hits);
  const rms = Math.sqrt(src.reduce((a, p, i) => { const q = project(H, ...p); return a + (q[0] - dst[i][0]) ** 2 + (q[1] - dst[i][1]) ** 2; }, 0) / src.length);
  const hs = RUNE.square / 2, corners = [[-hs, hs], [hs, hs], [hs, -hs], [-hs, -hs]].map(p => project(H, ...p));
  return { id: best.id, corners, err, n: hits.length, rms, used: [...best.read.hits, ...hits].map(o => o.i) };
}
const maxErr = known => Math.max(7, known >> 3);
/** Look for a dot at every slot through H: bits (1 dot, 0 none, -1 off the picture) and the dots it found. */
function readSlots(B, near, H, w, h) {
  const bits = new Int8Array(S * K).fill(-1), hits = []; let known = 0;
  for (let k = 0; k < K; k++) for (let j = 0; j < S; j++) {
    const [x, y] = slotPos(k, j), c = project(H, x, y);
    const er = Math.hypot(...sub(project(H, x * (1 + RUNE.dot), y * (1 + RUNE.dot)), c)), et = Math.hypot(...sub(project(H, x - y * RUNE.dot, y + x * RUNE.dot), c));
    if (!(c[0] > er && c[1] > er && c[0] < w - er && c[1] < h - er) || !isFinite(er + et)) continue;
    const e = Math.sqrt(er * et);
    if (e < 1.2) continue; // too small to see: unknown, not empty
    known++; bits[k * S + j] = 0;
    const tol = Math.max(1.5, .9 * Math.max(er, et)); let bi = -1, bd = tol;
    near(c[0], c[1], tol, i => {
      const b = B[i], d = Math.hypot(b.x - c[0], b.y - c[1]); if (d >= bd) return;
      const rb = Math.sqrt(b.n / Math.PI); if (rb > .5 * e && rb < 2 * e + 1) { bd = d; bi = i; }
    });
    if (bi >= 0) { bits[k * S + j] = 1; hits.push({ k, j, i: bi }); }
  }
  return { bits, hits, known };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
