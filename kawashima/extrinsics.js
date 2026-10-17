// Third-person camera extrinsics (and focal length) from the corner AprilTags in its own picture.
// Detection: tagdetect.js (js-aruco2 + sub-pixel / photometric corner refinement), off the main thread in tagworker.js. Pose: homography init + LM over
// pose (+ focal when >= 2 tags, which never share a plane). Square pixels, principal point at the image centre.
// Result pose is world_T_cam with cam = OpenCV frame (x right, y down, z forward), world.js pose format.
import * as W from './world.js';
import { grab, detectInImage, PASSES, solve, dot2 } from './tagdetect.js';

// tag frame corners in OpenCV / Vision.kt order
const OBJ = [[-1, 1], [1, 1], [1, -1], [-1, -1]];

// ---- detection runs in a worker (tagworker.js): js-aruco2 on a 1920x1080 frame takes 70-250 ms, which on the main thread
// drops 5-15 frames at a time. The frame goes over as an ImageBitmap (transferred, no copy); the main thread only pays
// createImageBitmap. Same code (tagdetect.js) either side, so results match the main-thread path.
let worker = null, workerOk = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
const pending = new Map(); let seq = 0;
function tagWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./tagworker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: m }) => { const p = pending.get(m.n); if (!p) return; pending.delete(m.n); m.err ? p.ng(new Error(m.err)) : p.ok(m); };
  worker.onerror = e => { e.preventDefault?.(); workerOk = false; worker = null; for (const p of pending.values()) p.ng(new Error('tag worker failed')); pending.clear(); };
  return worker;
}
async function detectInWorker(src, ids, passes) {
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  if (!w || !h) return [];
  const bmp = await createImageBitmap(src), n = ++seq;
  const m = await new Promise((ok, ng) => { pending.set(n, { ok, ng }); tagWorker().postMessage({ n, bmp, ids, passes }, [bmp]); });
  return Object.assign(m.out, { width: m.width, height: m.height });
}

/**
 * Detect tag36h11 tags: [{ id, corners: [[u,v] x4], misfit, scale }] with corners in OpenCV order
 * (tag (-h,h), (h,h), (h,-h), (-h,-h)). Tries PASSES in order while some of `ids` are still missing.
 * Runs in the worker unless { worker: false } or workers are unavailable (then on this thread, as before).
 */
export async function detectTags(videoOrCanvas, ids = null, { passes = PASSES, worker: useWorker = true } = {}) {
  if (useWorker && workerOk) {
    try { return await detectInWorker(videoOrCanvas, ids, passes); }
    catch (e) { console.warn('tag worker:', e.message, '- detecting on the main thread'); } // results first, smoothness second
  }
  const img = grab(videoOrCanvas); if (!img) return [];
  return Object.assign(await detectInImage(img, ids, passes), { width: img.width, height: img.height });
}

// ---- tiny linear algebra ----
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
  let r = resid(camT, f), c = cost(r), lam = 1e-3, JtJ = null;
  for (let it = 0; it < 100 && isFinite(c); it++) {
    const J = []; // numeric Jacobian, columns
    for (let k = 0; k < n; k++) {
      const e = 1e-6, d = Array(7).fill(0); d[k] = e;
      const [T1, f1] = step(camT, f, d), r1 = resid(T1, f1); d[k] = -e;
      const [T2, f2] = step(camT, f, d), r2 = resid(T2, f2);
      if (!r1 || !r2) return { camT, f, cost: c, JtJ };
      J.push(r1.map((v, i) => (v - r2[i]) / (2 * e)));
    }
    JtJ = J.map(a => J.map(b => dot2(a, b))); const Jtr = J.map(a => -dot2(a, r));
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
        if (done) return { camT, f, cost: c, JtJ };
        break;
      }
      lam *= 10;
    }
    if (!improved) break;
  }
  return { camT, f, cost: c, JtJ };
}

const fToFov = (f, h) => 2 * Math.atan(h / 2 / f) * 180 / Math.PI;
const fovToF = (fov, h) => h / 2 / Math.tan(fov * Math.PI / 360);

const FOV_SIGMA_MAX = 1; // deg
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
  // focal only when it is pinned down: 1-sigma of the fitted fov (corner noise >= 0.2 px) under FOV_SIGMA_MAX, else redo with the guess
  let fovSigma = null;
  if (fitF) {
    const e6 = [0, 0, 0, 0, 0, 0, 1], col = best.JtJ && solve(best.JtJ, e6), sPx = Math.max(.2, Math.sqrt(best.cost / pts.length));
    const sLogF = col ? Math.sqrt(Math.max(0, col[6])) * sPx : Infinity, fov = fToFov(best.f, height);
    fovSigma = Math.abs(fToFov(best.f * Math.exp(-sLogF), height) - fov);
    if (!(fovSigma < FOV_SIGMA_MAX) || fov < 15 || fov > 130) return { ...solveCamera(dets, width, height, { fovYGuess, fitFocal: false }), fovSigma };
  }
  const p = W.invert(best.camT);
  return {
    pose: { R: p.R, t: p.t }, fovY: fToFov(best.f, height), focalPx: best.f, width, height,
    ids: tags.map(d => d.id), reprojErrPx: Math.sqrt(best.cost / pts.length), focalFitted: fitF, fovSigma,
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
