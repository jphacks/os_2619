// Third-person camera extrinsics (and focal length) from the corner AprilTags in its own picture.
// Detection: js-aruco2 (tag36h11 dictionary), corners refined here (edge lines, then a photometric fit of the whole tag). Pose: homography init + LM over
// pose (+ focal when >= 2 tags, which never share a plane). Square pixels, principal point at the image centre.
// Result pose is world_T_cam with cam = OpenCV frame (x right, y down, z forward), world.js pose format.
import * as W from './world.js';

const ARUCO = 'https://cdn.jsdelivr.net/npm/js-aruco2@2.0.0/src/';
// tag frame corners in OpenCV / Vision.kt order. js-aruco2's corner 0 is the apriltag-imgs PNG's top-left,
// OpenCV's corner 0 is that PNG's bottom-right, hence the shift by 2.
const OBJ = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
const ARUCO_TO_CV = k => (k + 2) % 4;

let detP = null;
const loadScript = src => new Promise((ok, ng) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => ng(new Error('load ' + src)); document.head.append(s); });
function detector() {
  return (detP ??= (async () => {
    if (!globalThis.AR?.DICTIONARIES?.APRILTAG_36h11) for (const f of ['cv.js', 'aruco.js', 'dictionaries/apriltag_36h11.js']) await loadScript(ARUCO + f);
    return new globalThis.AR.Detector({ dictionaryName: 'APRILTAG_36h11', maxHammingDistance: 4 }); // accept <= 3 bit errors
  })());
}

function grab(src) {
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  if (!w || !h) return null;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, w, h);
  return x.getImageData(0, 0, w, h);
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
export async function detectTags(videoOrCanvas, ids = null) {
  const img = grab(videoOrCanvas); if (!img) return [];
  const det = await detector(), I = sampler(greyOf(img), img.width, img.height);
  const out = [];
  for (const m of det.detect(img)) {
    if (ids && !ids.includes(m.id)) continue;
    const q = [0, 1, 2, 3].map(k => { const c = m.corners[[0, 1, 2, 3].find(j => ARUCO_TO_CV(j) === k)]; return [c.x + .5, c.y + .5]; });
    out.push({ id: m.id, hamming: m.hammingDistance, coarse: q, ...photoRefine(I, refineQuad(I, q), gridOf(det, m.id)) });
  }
  return Object.assign(out, { width: img.width, height: img.height });
}

// ---- tiny linear algebra ----
function solve(A, b) { // Gaussian elimination, A n x n (array of rows)
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
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function orthonormal(R) { // nearest rotation via a few polar iterations R <- (R + R^-T) / 2
  for (let i = 0; i < 8; i++) {
    const c0 = [R[0], R[3], R[6]], c1 = [R[1], R[4], R[7]], c2 = [R[2], R[5], R[8]], det = dot(c0, cross(c1, c2));
    const it = [cross(c1, c2), cross(c2, c0), cross(c0, c1)].map(v => v.map(x => x / det)); // rows of R^-1 = cols of R^-T
    R = R.map((v, k) => .5 * (v + it[k % 3][Math.floor(k / 3)]));
  }
  return R;
}

/** cam_T_tag from 4 corners via homography (normalised image coords). */
function tagPoseFromHomography(corners, h, f, cx, cy) {
  const A = [], b = [];
  OBJ.forEach(([ox, oy], k) => {
    const X = ox * h, Y = oy * h, u = (corners[k][0] - cx) / f, v = (corners[k][1] - cy) / f;
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u);
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v);
  });
  const x = solve(A, b); if (!x) return null;
  const H = [...x, 1], c0 = [H[0], H[3], H[6]], c1 = [H[1], H[4], H[7]], c2 = [H[2], H[5], H[8]];
  let s = 2 / (Math.hypot(...c0) + Math.hypot(...c1));
  if (c2[2] * s < 0) s = -s; // tag in front of the camera
  const r0 = c0.map(v => v * s), r1 = c1.map(v => v * s);
  return W.pose(orthonormal(W.fromCols(r0, r1, cross(r0, r1))), c2.map(v => v * s));
}

const expSO3 = W.fromRodrigues;
function project(camT, f, cx, cy, P) { const p = W.apply(camT, P); return [f * p[0] / p[2] + cx, f * p[1] / p[2] + cy, p[2]]; }

/** Levenberg-Marquardt over a left-multiplied rotation increment, translation and (optionally) log focal. */
function refine(camT, f, pts, cx, cy, fitF) {
  const n = fitF ? 7 : 6;
  const resid = (T, ff) => { const r = []; for (const { P, uv } of pts) { const p = project(T, ff, cx, cy, P); if (p[2] <= 0) return null; r.push(p[0] - uv[0], p[1] - uv[1]); } return r; };
  const step = (T, ff, d) => [{ R: W.mul3(expSO3(d.slice(0, 3)), T.R), t: T.t.map((v, i) => v + d[3 + i]) }, fitF ? ff * Math.exp(d[6]) : ff];
  const cost = r => r ? r.reduce((s, v) => s + v * v, 0) : Infinity;
  let r = resid(camT, f), c = cost(r), lam = 1e-3;
  for (let it = 0; it < 100 && isFinite(c); it++) {
    const J = []; // numeric Jacobian, columns
    for (let k = 0; k < n; k++) {
      const e = 1e-6, d = Array(7).fill(0); d[k] = e;
      const [T1, f1] = step(camT, f, d), r1 = resid(T1, f1); d[k] = -e;
      const [T2, f2] = step(camT, f, d), r2 = resid(T2, f2);
      if (!r1 || !r2) return { camT, f, cost: c };
      J.push(r1.map((v, i) => (v - r2[i]) / (2 * e)));
    }
    const JtJ = J.map(a => J.map(b => dot2(a, b))), Jtr = J.map(a => -dot2(a, r));
    let improved = false;
    for (let tries = 0; tries < 10; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => v + (i === j ? lam * (v + 1e-9) : 0)));
      const d = solve(A, Jtr); if (!d) { lam *= 10; continue; }
      while (d.length < 7) d.push(0);
      const [T1, f1] = step(camT, f, d), r1 = resid(T1, f1), c1 = cost(r1);
      if (c1 < c) {
        const done = (c - c1) < 1e-10 * c;
        camT = T1; f = f1; r = r1; c = c1; lam = Math.max(1e-9, lam / 5); improved = true;
        camT.R = orthonormal(camT.R);
        if (done) return { camT, f, cost: c };
        break;
      }
      lam *= 10;
    }
    if (!improved) break;
  }
  return { camT, f, cost: c };
}
const dot2 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

const fToFov = (f, h) => 2 * Math.atan(h / 2 / f) * 180 / Math.PI;
const fovToF = (fov, h) => h / 2 / Math.tan(fov * Math.PI / 360);

/** Pose from detections already in hand (see detectTags). Same result shape as calibrateCamera. */
export function solveCamera(dets, width, height, { fovYGuess = 55, fitFocal = 'auto' } = {}) {
  const tags = dets.filter(d => W.CORNER_IDS.includes(d.id));
  if (!tags.length) return null;
  const cx = width / 2, cy = height / 2, pts = [];
  for (const d of tags) {
    const tp = W.worldTagPose(d.id), h = W.TAGS[d.id].size / 2;
    OBJ.forEach(([ox, oy], k) => pts.push({ P: W.apply(tp, [ox * h, oy * h, 0]), uv: d.corners[k] }));
  }
  const fitF = fitFocal === 'auto' ? tags.length >= 2 : !!fitFocal;
  let best = null;
  const f0 = fovToF(fovYGuess, height);
  for (const fi of fitF ? [f0, f0 * .8, f0 * 1.25] : [f0]) for (const d of tags) {
    const ct = tagPoseFromHomography(d.corners, W.TAGS[d.id].size / 2, fi, cx, cy); if (!ct) continue;
    const camT = W.compose(ct, W.invert(W.worldTagPose(d.id)));
    const r = refine(camT, fi, pts, cx, cy, fitF);
    if (!best || r.cost < best.cost) best = r;
  }
  if (!best || !isFinite(best.cost)) return null;
  const p = W.invert(best.camT);
  return {
    pose: { R: p.R, t: p.t }, fovY: fToFov(best.f, height), focalPx: best.f, width, height,
    ids: tags.map(d => d.id), reprojErrPx: Math.sqrt(best.cost / pts.length), focalFitted: fitF,
  };
}

/**
 * calibrateCamera(videoOrCanvas, { fovYGuess, frames, intervalMs }) -> { pose: world_T_cam (OpenCV cam frame), fovY, focalPx,
 * width, height, ids, reprojErrPx, focalFitted, tags } or null when no corner tag is seen. reprojErrPx is the RMS per corner.
 * Looks at `frames` frames `intervalMs` apart (tripod: the camera is still) and averages each tag's corners over the
 * frames it was seen in, so a player walking in front of a tag for a moment does not lose it.
 */
const MAX_MISFIT = .15;
export async function calibrateCamera(videoOrCanvas, { fovYGuess = 55, fitFocal = 'auto', frames = 5, intervalMs = 150 } = {}) {
  const acc = {}; let size = null;
  for (let i = 0; i < frames; i++) {
    if (i) await new Promise(r => setTimeout(r, intervalMs));
    const dets = await detectTags(videoOrCanvas, W.CORNER_IDS);
    if (dets.width) size = [dets.width, dets.height];
    for (const d of dets) (acc[d.id] ??= []).push(d);
  }
  // per tag: drop the frames where it fit the pattern badly (partly hidden), average the rest
  const tags = [];
  for (const [id, ds] of Object.entries(acc)) {
    const m0 = Math.min(...ds.map(d => d.misfit)), ok = ds.filter(d => d.misfit <= Math.max(1.5 * m0, m0 + .02));
    if (m0 > MAX_MISFIT) continue;
    tags.push({ id: +id, corners: [0, 1, 2, 3].map(k => [0, 1].map(a => ok.reduce((s, d) => s + d.corners[k][a], 0) / ok.length)), seen: ok.length, misfit: m0 });
  }
  if (!tags.length) return null;
  const r = solveCamera(tags, size[0], size[1], { fovYGuess, fitFocal });
  return r && { ...r, tags };
}

/** Place a THREE.PerspectiveCamera from a calibrateCamera result (three's camera = cv frame turned 180° about x). */
export function toThreeCamera(result, camera) {
  const R = W.mul3(result.pose.R, [1, 0, 0, 0, -1, 0, 0, 0, -1]), [w, x, y, z] = W.toQuat(R);
  camera.position.set(...result.pose.t);
  camera.quaternion.set(x, y, z, w).normalize();
  camera.fov = result.fovY;
  if (result.width && result.height) camera.aspect = result.width / result.height;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return camera;
}

/** Project world points through a result (or a dummy cam's truePose + size), for overlays and checks. */
export function projectWorld(result, P) {
  const camT = W.invert(result.pose ?? result), f = result.focalPx ?? fovToF(result.fovY, result.height);
  return project(camT, f, result.width / 2, result.height / 2, P);
}
