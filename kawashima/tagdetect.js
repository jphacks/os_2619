// tag36h11 detection core, shared by the page (extrinsics.js) and the detection worker (tagworker.js): no DOM needed.
// js-aruco2 (tag36h11 dictionary) finds the quads, corners are refined here (edge lines, then a photometric fit of the whole tag).

// js-aruco2 from the serve.mjs cache (cdn/..., works offline once fetched) first, the CDN itself when served by something else
const ARUCO = [new URL('./cdn/npm/js-aruco2@2.0.0/src/', import.meta.url).href, 'https://cdn.jsdelivr.net/npm/js-aruco2@2.0.0/src/'];
const FILES = ['cv.js', 'aruco.js', 'dictionaries/apriltag_36h11.js'];
// js-aruco2's corner 0 is the apriltag-imgs PNG's top-left, OpenCV's corner 0 is that PNG's bottom-right, hence the shift by 2.
const ARUCO_TO_CV = k => (k + 2) % 4;

let detP = null;
const loadScript = src => new Promise((ok, ng) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { s.remove(); ng(new Error('load ' + src)); }; document.head.append(s); });
// workers have no <script>: fetch the text and run it at global scope (js-aruco2 hangs CV / AR on `this`)
const evalScript = async src => { const r = await fetch(src); if (!r.ok) throw new Error('load ' + src); (0, eval)(await r.text()); };
async function loadAruco(base) { for (const f of FILES) await (PAGE ? loadScript : evalScript)(base + f); }
function detector() {
  return (detP ??= (async () => {
    if (!globalThis.AR?.DICTIONARIES?.APRILTAG_36h11) {
      let err;
      for (const base of ARUCO) { try { await loadAruco(base); err = null; break; } catch (e) { err = e; } }
      if (err) { detP = null; throw err; }
    }
    return new globalThis.AR.Detector({ dictionaryName: 'APRILTAG_36h11', maxHammingDistance: 4 }); // accept <= 3 bit errors
  })());
}

const PAGE = typeof document !== 'undefined';
const canvas = (w, h) => PAGE ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h);
// a worker's software (willReadFrequently) OffscreenCanvas rasterises at getImageData, 2-6x slower than its GPU one there
const ctx2d = c => c.getContext('2d', { willReadFrequently: PAGE });
/** RGBA ImageData of a video / canvas / ImageBitmap, with the canvas it was drawn on (upscaled passes redraw from it). */
export function grab(src) {
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  if (!w || !h) return null;
  const c = canvas(w, h);
  const x = ctx2d(c); x.drawImage(src, 0, 0, w, h);
  return Object.assign(x.getImageData(0, 0, w, h), { canvas: c });
}
function upscaled(img, s) { // same frame, s times larger (smooth): small / oblique tags pass js-aruco2's size limits
  const c = canvas(img.width * s, img.height * s);
  const x = ctx2d(c); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(img.canvas, 0, 0, c.width, c.height);
  return x.getImageData(0, 0, c.width, c.height);
}

// ---- sub-pixel corners: fit a line to each edge of the black square (gradient peak along the normal), intersect ----
// Image coordinates are continuous: pixel (i, j) covers [i, i+1) x [j, j+1), its centre is (i + .5, j + .5).
function greyOf(img) {
  const g = new Float32Array(img.width * img.height), d = img.data;
  for (let i = 0; i < g.length; i++) g[i] = .299 * d[4 * i] + .587 * d[4 * i + 1] + .114 * d[4 * i + 2];
  return g;
}
function sampler(g, w, h) {
  return (x, y) => {
    x -= .5; y -= .5;
    const i = Math.max(0, Math.min(w - 2, Math.floor(x))), j = Math.max(0, Math.min(h - 2, Math.floor(y))), fx = x - i, fy = y - j, o = j * w + i;
    return (g[o] * (1 - fx) + g[o + 1] * fx) * (1 - fy) + (g[o + w] * (1 - fx) + g[o + w + 1] * fx) * fy;
  };
}
function refineQuad(I, q) {
  for (let it = 0; it < 3; it++) {
    const lines = [];
    for (let e = 0; e < 4; e++) {
      const a = q[e], b = q[(e + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      const d = [dx / L, dy / L], n = [-d[1], d[0]], r = Math.max(1, Math.min(3, L / 16)); // stay inside the 1-cell border
      const pts = [];
      for (let s = .12 * L; s <= .88 * L; s += .5) {
        const px = a[0] + d[0] * s, py = a[1] + d[1] * s;
        let best = 0, bk = 0; const step = .25, K = Math.ceil(r / step), gr = [];
        for (let k = -K; k <= K; k++) gr.push(I(px + n[0] * (k + .5) * step, py + n[1] * (k + .5) * step) - I(px + n[0] * (k - .5) * step, py + n[1] * (k - .5) * step));
        for (let k = 1; k < gr.length - 1; k++) if (Math.abs(gr[k]) > best) { best = Math.abs(gr[k]); bk = k; }
        if (best < 8 || bk === 0) continue;
        const g0 = Math.abs(gr[bk - 1]), g1 = best, g2 = Math.abs(gr[bk + 1]), den = g0 - 2 * g1 + g2;
        const off = ((bk - K) + (den < 0 ? .5 * (g0 - g2) / den : 0)) * step;
        pts.push([px + n[0] * off, py + n[1] * off, best]);
      }
      if (pts.length < 4) return q;
      // weighted total least squares line: nx x + ny y = c
      let sw = 0, mx = 0, my = 0;
      for (const [x, y, w] of pts) { sw += w; mx += w * x; my += w * y; }
      mx /= sw; my /= sw;
      let sxx = 0, sxy = 0, syy = 0;
      for (const [x, y, w] of pts) { sxx += w * (x - mx) ** 2; sxy += w * (x - mx) * (y - my); syy += w * (y - my) ** 2; }
      const th = .5 * Math.atan2(2 * sxy, sxx - syy), ln = [-Math.sin(th), Math.cos(th)];
      lines.push([ln[0], ln[1], ln[0] * mx + ln[1] * my]);
    }
    const nq = [];
    for (let k = 0; k < 4; k++) { // corner k = edge (k-1) x edge k
      const [a1, b1, c1] = lines[(k + 3) % 4], [a2, b2, c2] = lines[k], det = a1 * b2 - a2 * b1;
      if (Math.abs(det) < 1e-9) return q;
      nq.push([(c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det]);
    }
    if (nq.some((p, k) => Math.hypot(p[0] - q[k][0], p[1] - q[k][1]) > 4)) return q; // refinement ran off: keep the coarse quad
    q = nq;
  }
  return q;
}

// ---- photometric corner refinement: fit the known tag pattern (blurred by sigma) through a homography ----
// Small far tags (cells of ~2 px) blur border and data cells together, which biases any edge-only fit inward.
// Template coords in cells, y down: black square [-4, 4]^2, corner k of OpenCV order at TC[k]; cell (r, c) spans
// x in [c-5, c-4], y in [r-5, r-4] of the 10x10 grid (quiet zone included).
const TC = [[-4, -4], [4, -4], [4, 4], [-4, 4]];
const erf = x => { const a = Math.abs(x), t = 1 / (1 + .3275911 * a); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-a * a); return x < 0 ? -y : y; };
function homog4(src, dst) { // 3x3 row-major, src -> dst
  const A = [], b = [];
  src.forEach(([X, Y], k) => { const [u, v] = dst[k]; A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y], [0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(u, v); });
  const x = solve(A, b); return x && [...x, 1];
}
const NS = 36, SS = Array.from({ length: NS }, (_, i) => -4.85 + i * 9.7 / (NS - 1));
function lm(resid, p, eps, iters = 30) {
  const cost = r => r ? r.reduce((s, v) => s + v * v, 0) : Infinity;
  let r = resid(p), c = cost(r), lam = 1e-3;
  for (let it = 0; it < iters && isFinite(c); it++) {
    const J = p.map((_, k) => { const a = [...p], b = [...p]; a[k] += eps[k]; b[k] -= eps[k]; const ra = resid(a), rb = resid(b); return ra && rb ? ra.map((v, i) => (v - rb[i]) / (2 * eps[k])) : null; });
    if (J.some(j => !j)) break;
    const JtJ = J.map(a => J.map(b => dot2(a, b))), g = J.map(a => -dot2(a, r));
    let ok = false;
    for (let t = 0; t < 8 && !ok; t++) {
      const d = solve(JtJ.map((row, i) => row.map((v, j) => v + (i === j ? lam * (v + 1e-9) : 0))), g);
      if (d) { const p1 = p.map((v, i) => v + d[i]), r1 = resid(p1), c1 = cost(r1); if (c1 < c) { ok = (c - c1) > 1e-9 * c ? 1 : 2; p = p1; r = r1; c = c1; lam /= 5; continue; } }
      lam *= 10;
    }
    if (ok !== 1) break;
  }
  return { p, cost: c, n: r?.length ?? 1 };
}
function photoRefine(I, q, grid) {
  let tKey = NaN, T = null;
  const tmpl = sig => {
    if (sig === tKey) return T;
    const k2 = 1 / (Math.SQRT2 * sig), B = SS.map(x => Array.from({ length: 10 }, (_, c) => .5 * (erf((x - c + 5) * k2) - erf((x - c + 4) * k2))));
    T = new Float64Array(NS * NS);
    for (let i = 0; i < NS; i++) for (let r = 0; r < 10; r++) { const by = B[i][r]; if (by < 1e-6) continue; for (let c = 0; c < 10; c++) if (grid[r][c]) for (let j = 0; j < NS; j++) T[i * NS + j] += by * B[j][c]; }
    tKey = sig; return T;
  };
  const resid = p => {
    const sig = Math.abs(p[8]) + .05, H = homog4(TC, [0, 1, 2, 3].map(k => [p[2 * k], p[2 * k + 1]])); if (!H) return null;
    const t = tmpl(sig), v = new Float64Array(NS * NS);
    for (let i = 0; i < NS; i++) for (let j = 0; j < NS; j++) { const x = SS[j], y = SS[i], w = H[6] * x + H[7] * y + 1; v[i * NS + j] = I((H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w); }
    let st = 0, sv = 0, stt = 0, stv = 0; const n = v.length; // intensity gain / offset in closed form
    for (let i = 0; i < n; i++) { st += t[i]; sv += v[i]; stt += t[i] * t[i]; stv += t[i] * v[i]; }
    const a = (n * stv - st * sv) / (n * stt - st * st), b = (sv - a * st) / n;
    if (!(a > 10)) return null; // lost the pattern
    gain = a;
    return Array.from(v, (x, i) => x - a * t[i] - b);
  };
  let gain = 1;
  const r = lm(resid, [...q.flat(), .4], [.01, .01, .01, .01, .01, .01, .01, .01, .002]);
  resid(r.p); // gain of the final fit
  const nq = [0, 1, 2, 3].map(k => [r.p[2 * k], r.p[2 * k + 1]]), misfit = Math.sqrt(r.cost / r.n) / gain;
  if (nq.some((p, k) => Math.hypot(p[0] - q[k][0], p[1] - q[k][1]) > 3)) return { corners: q, misfit: 1 };
  return { corners: nq, misfit }; // misfit: RMS residual / contrast, ~0.02 clean, large when partly hidden
}
/** 10x10 grid of tag `id` in OpenCV orientation (top-left = OpenCV corner 0), 1 = white. Dictionary bits are PNG row-major. */
function gridOf(det, id) {
  const bits = det.dictionary.codeList[id], g = Array.from({ length: 10 }, (_, r) => Array.from({ length: 10 }, (_, c) => +(r === 0 || r === 9 || c === 0 || c === 9)));
  for (let b = 0; b < 36; b++) g[7 - Math.floor(b / 6)][7 - (b % 6)] = +bits[b];
  return g;
}

/** Detect tag36h11 tags: [{ id, corners: [[u,v] x4] }] with corners in OpenCV order (tag (-h,h), (h,h), (h,-h), (-h,-h)). */
// js-aruco2's detect() with a choice of adaptive-threshold window (its default radius 2 hollows out tags whose
// cells are wider than ~3 px, and small or oblique tags need the upscaled passes).
function arucoDetect(det, img, radius) {
  const CV = globalThis.CV;
  CV.grayscale(img, det.grey);
  CV.adaptiveThreshold(det.grey, det.thres, radius, 7);
  det.contours = CV.findContours(det.thres, det.binary);
  let c = det.findCandidates(det.contours, img.width * .01, .05, 10);
  c = det.clockwiseCorners(c); // no notTooNear: it keeps the paper sheet's outline and drops the tag inside it
  return det.findMarkers(det.grey, c, 49);
}
export const PASSES = [[1, 2], [1, 6], [2, 4], [2, 12], [3, 6], [3, 18], [4, 8]]; // [upscale, threshold radius]

/**
 * Detect tag36h11 tags in a grab()bed frame: [{ id, hamming, coarse, scale, corners: [[u,v] x4], misfit }] with corners in
 * OpenCV order (tag (-h,h), (h,h), (h,-h), (-h,-h)). Tries `passes` in order while some of `ids` are still missing.
 */
export async function detectInImage(img, ids = null, passes = PASSES) {
  const det = await detector(), I = sampler(greyOf(img), img.width, img.height);
  const out = [], big = {};
  for (const [s, rad] of passes) {
    if (ids && ids.every(id => out.some(o => o.id === id))) break;
    for (const m of arucoDetect(det, s === 1 ? img : (big[s] ??= upscaled(img, s)), rad)) {
      if ((ids && !ids.includes(m.id)) || out.some(o => o.id === m.id)) continue;
      const q = [0, 1, 2, 3].map(k => { const c = m.corners[[0, 1, 2, 3].find(j => ARUCO_TO_CV(j) === k)]; return [(c.x + .5) / s, (c.y + .5) / s]; });
      const r = photoRefine(I, refineQuad(I, q), gridOf(det, m.id));
      if (r.misfit < 1) out.push({ id: m.id, hamming: m.hammingDistance, coarse: q, scale: s, ...r });
    }
  }
  return out;
}

// ---- tiny linear algebra (extrinsics.js uses it too) ----
export function solve(A, b) { // Gaussian elimination, A n x n (array of rows)
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) return null;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}
export const dot2 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
