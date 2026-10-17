// Both players' positions straight from the third-person camera picture (MediaPipe Pose Landmarker, 2 poses), so effects
// sit on the people by construction. Needs a floor calibration (extrinsics.js result) for world positions; without one
// only the 2D results are filled in.
//
// createPoseTracker({ video, getCamera, hz = 15, worker = true }) -> { start(), stop(), get('A' | 'B'), setSwap(), ms, hz, ready }
//   get(slot) -> { seen, age, t, img: { pts: { name: [u, v, vis] }, all: [[u, v, vis] x 33] }, foot: [x, 0, z],
//                  chest: [x, y, z], yaw, yaw3, yaw2, wrist: { L, R }, conf, footFrom } (world fields null without a camera)
// Inference runs in a classic Web Worker by default (detectForVideo is synchronous and its GPU readback blocks whichever
// thread calls it; the docs recommend a worker for live input). Main thread only grabs a downscaled ImageBitmap per tick.
import { CHEST_H } from './world.js';

export const MP_VER = '1.0.1'; // >= 2 weeks old on 2026-10-17 (1.1.x are days old)
const MP = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
export const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const OPTS = { runningMode: 'VIDEO', numPoses: 2, minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5 };
const IN_W = 640;            // frame width sent to the model: its detector works at 224 px anyway, so this only saves upload
const HOLD = .4;             // s a lost person is still reported (occluded by the other for a moment)
const CHEST_DROP = .1;       // m below the shoulder line
const FOOT_H = .05;          // m, height of the ankle/heel points above the floor
const GATE = { m: 1.0, img: .25 }; // assignment: past this a new detection would rather go to a lost slot
const N = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };

// ---- worker: a classic one (the bundle's wasm loader needs importScripts, which module workers lack) ----
const workerSrc = (opts, delegates) => `
importScripts('${MP}/vision_bundle.js');
let lm = null, lastTs = 0;
const ready = (async () => {
  const fs = await Vision.FilesetResolver.forVisionTasks('${MP}/wasm');
  const mk = delegate => Vision.PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: '${MODEL}', delegate }, ...${JSON.stringify(opts)} });
  for (const d of ${JSON.stringify(delegates)}) try { lm = await mk(d); return d; } catch (e) { if (d === 'CPU') throw e; }
})();
ready.then(d => postMessage({ type: 'ready', delegate: d }), e => postMessage({ type: 'error', msg: String(e) }));
onmessage = async ({ data: { bmp, t } }) => {
  await ready;
  const ts = Math.max(lastTs + 1, Math.round(t * 1000)); lastTs = ts; // VIDEO mode wants strictly increasing ms
  let r, t0 = performance.now();
  try { r = lm.detectForVideo(bmp, ts); } catch (e) { postMessage({ type: 'fail', t, msg: String(e) }); return; } finally { bmp.close(); }
  const ms = performance.now() - t0;
  const poses = r.landmarks.map((p, i) => ({ lm: Float32Array.from(p.flatMap(q => [q.x, q.y, q.z, q.visibility ?? 1])), wl: Float32Array.from(r.worldLandmarks[i].flatMap(q => [q.x, q.y, q.z])) }));
  postMessage({ type: 'res', t, ms, poses }, poses.flatMap(p => [p.lm.buffer, p.wl.buffer]));
};`;

// ---- small vector maths (world.js frames: y up) ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
/** Pixel (video px) -> world ray { o, d } through a calibration result (world_T_cam, OpenCV cam frame). */
export function pixelRay(cam, u, v, vw, vh) {
  const sx = cam.width / vw, sy = cam.height / vh, f = cam.focalPx ?? cam.height / 2 / Math.tan(cam.fovY * Math.PI / 360);
  return { o: cam.pose.t, d: mv(cam.pose.R, [(u * sx - cam.width / 2) / f, (v * sy - cam.height / 2) / f, 1]), dc: [(u * sx - cam.width / 2) / f, (v * sy - cam.height / 2) / f, 1] };
}
/** Ray meets the horizontal plane y = h (null when it points away from it). Same maths as fieldmap.imageToFloor. */
export function rayAtHeight({ o, d }, h) { const s = (h - o[1]) / d[1]; return s > 0 ? [o[0] + s * d[0], h, o[2] + s * d[2]] : null; }
/** Point on the vertical line through (x, z) closest to the ray. */
export function rayToVertical({ o, d }, x, z) {
  const w = [o[0] - x, o[1], o[2] - z], a = dot(d, d), b = d[1], dd = dot(d, w), den = a - b * b;
  return den < 1e-9 ? null : [x, (a * w[1] - b * dd) / den, z];
}
/** Ray meets the vertical plane through p facing the camera (normal = horizontal camera -> p). */
export function rayToFacingPlane({ o, d }, p) {
  const n = [p[0] - o[0], 0, p[2] - o[2]], s = dot(n, sub(p, o)) / dot(n, d);
  return s > 0 ? [o[0] + s * d[0], o[1] + s * d[1], o[2] + s * d[2]] : null;
}

// ---- One Euro filter (Casiez 2012): low lag when moving, heavy smoothing when still ----
const alpha = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
class OneEuro {
  constructor(minCut = 1.2, beta = .8, dCut = 1) { Object.assign(this, { minCut, beta, dCut, x: null, dx: null, t: 0 }); }
  reset() { this.x = null; }
  f(v, t) {
    if (!this.x || t - this.t > 1) { this.x = [...v]; this.dx = v.map(() => 0); this.t = t; return [...v]; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dx = v.map((q, i) => (q - this.x[i]) / dt), ad = alpha(this.dCut, dt);
    this.dx = dx.map((q, i) => this.dx[i] + ad * (q - this.dx[i]));
    const sp = Math.hypot(...this.dx), a = alpha(this.minCut + this.beta * sp, dt);
    return (this.x = v.map((q, i) => this.x[i] + a * (q - this.x[i])));
  }
}
const filters = () => ({ foot: new OneEuro(), chest: new OneEuro(), L: new OneEuro(), R: new OneEuro(), yaw: new OneEuro(1, .5), yaw2: new OneEuro(1, .5), yaw3: new OneEuro(1, .5) });
const empty = () => ({ seen: false, age: Infinity, t: 0, img: null, foot: null, chest: null, yaw: null, yaw2: null, yaw3: null, wrist: null, conf: 0, footFrom: null, skel: null, skelVis: null });

// ---- one raw pose -> per-person measurement ----
export function measure(p, vw, vh, cam) {
  const P = i => [p.lm[4 * i] * vw, p.lm[4 * i + 1] * vh, p.lm[4 * i + 3]];
  const all = Array.from({ length: 33 }, (_, i) => P(i)), pts = Object.fromEntries(Object.entries(N).map(([k, i]) => [k, all[i]]));
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.min(a[2], b[2])];
  const sh = mid(pts.lSh, pts.rSh), hip = mid(pts.lHip, pts.rHip);
  const feetVis = Math.min(pts.lAnk[2], pts.rAnk[2], pts.lHeel[2], pts.rHeel[2]);
  const feet = [pts.lAnk, pts.rAnk, pts.lHeel, pts.rHeel].reduce((s, q) => [s[0] + q[0] / 4, s[1] + q[1] / 4], [0, 0]);
  const conf = (pts.lSh[2] + pts.rSh[2] + pts.lHip[2] + pts.rHip[2]) / 4;
  const m = { img: { pts, all, sh, hip, feet }, conf, foot: null, chest: null, wrist: null, yaw2: null, yaw3: null, key: null };
  // identity key without a camera: feet (or hips) in image-height units
  const kp = feetVis > .3 ? feet : hip; m.key = [kp[0] / vh, 0, kp[1] / vh];
  if (!cam) return m;
  const ray = (q) => pixelRay(cam, q[0], q[1], vw, vh);
  // feet off-screen / hidden: hips at a typical height are a rougher but still usable floor point
  let foot = feetVis > .3 ? rayAtHeight(ray(feet), FOOT_H) : null; m.footFrom = 'feet';
  if (!foot) { foot = rayAtHeight(ray(hip), .95); m.footFrom = 'hip'; }
  if (!foot) return m;
  foot[1] = 0; m.foot = foot; m.key = foot;
  const c = rayToVertical(ray(sh), foot[0], foot[2]);
  m.chest = c ? [c[0], Math.max(.5, c[1] - CHEST_DROP), c[2]] : [foot[0], CHEST_H, foot[2]];
  const wr = q => rayToFacingPlane(ray(q), foot) ?? [foot[0], m.chest[1], foot[2]];
  m.wrist = { L: wr(pts.lWr), R: wr(pts.rWr) };
  // yaw from the right-shoulder direction r (body z): forward = up x r = (r.z, 0, -r.x) -> yaw = atan2(r.x, r.z)
  const a2 = rayAtHeight(ray(pts.lSh), m.chest[1] + CHEST_DROP), b2 = rayAtHeight(ray(pts.rSh), m.chest[1] + CHEST_DROP);
  if (a2 && b2) m.yaw2 = Math.atan2(b2[0] - a2[0], b2[2] - a2[2]); // degenerate when side-on (shoulders overlap in the picture)
  // world landmarks: camera-aligned metric frame of the person's crop (x right, y down, z away = OpenCV). The crop looks
  // along the ray to the hips, not the optical axis, so turn z onto that ray first, then into the world.
  const W = i => [p.wl[3 * i], p.wl[3 * i + 1], p.wl[3 * i + 2]], rs = sub(W(N.rSh), W(N.lSh));
  const r = mv(cam.pose.R, toRay(ray(hip).dc, rs));
  m.yaw3 = Math.atan2(r[0], r[2]);
  // whole skeleton in the world: the model's metric hip-centred shape, turned like r, hung at the hips above `foot`,
  // then lifted / lowered so the lowest visible foot point touches the floor
  const hipW = rayToVertical(ray(hip), foot[0], foot[2]) ?? [foot[0], .95, foot[2]], dc = ray(hip).dc;
  const sk = new Float32Array(99);
  for (let i = 0; i < 33; i++) { const q = mv(cam.pose.R, toRay(dc, W(i))); sk[3 * i] = hipW[0] + q[0]; sk[3 * i + 1] = hipW[1] + q[1]; sk[3 * i + 2] = hipW[2] + q[2]; }
  if (feetVis > .3) { let lo = Infinity; for (const i of [N.lAnk, N.rAnk, N.lHeel, N.rHeel]) lo = Math.min(lo, sk[3 * i + 1]); for (let i = 0; i < 33; i++) sk[3 * i + 1] -= lo - FOOT_H * .5; }
  m.skel = sk; m.skelVis = Float32Array.from({ length: 33 }, (_, i) => p.lm[4 * i + 3]);
  return m;
}
function toRay(dc, v) { // minimal rotation taking [0,0,1] to dc, applied to v (Rodrigues)
  const n = Math.hypot(...dc), z = dc.map(q => q / n), k = [-z[1], z[0], 0], s = Math.hypot(k[0], k[1]), c = z[2];
  if (s < 1e-9) return v;
  const u = [k[0] / s, k[1] / s, 0], uv = dot(u, v), x = [u[1] * v[2], -u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return v.map((q, i) => q * c + x[i] * s + u[i] * uv * (1 - c));
}

export function createPoseTracker({ video, getCamera = () => null, hz = 15, worker = true, delegate: want = 'GPU', numPoses = 2 } = {}) {
  const opts = { ...OPTS, numPoses }, dels = want === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
  const st = { A: empty(), B: empty() }, flt = { A: filters(), B: filters() }, trk = { A: null, B: null }; // trk: { key, t, x }
  let hints = []; // [{ slot, u, v, t }] chest-tag centres in video pixels, t on this module's clock (performance.now()/1000)
  let timer = null, busy = false, lm = null, wk = null, ready = false, delegate = null, err = null, lastVT = -1;
  const avg = { ms: 0, main: 0, post: 0, lat: 0, n: 0, ticks: [] };
  const ema = (k, v) => (avg[k] = avg.n < 1 ? v : avg[k] + .1 * (v - avg[k]));

  const init = (async () => {
    try {
      if (worker) {
        wk = new Worker(URL.createObjectURL(new Blob([workerSrc(opts, dels)], { type: 'text/javascript' })));
        await new Promise((ok, ng) => wk.onmessage = ({ data: d }) => d.type === 'ready' ? (delegate = d.delegate, ok()) : ng(new Error(d.msg)));
        wk.onmessage = ({ data: d }) => d.type === 'res' ? onResult(d.poses, d.t, d.ms) : d.type === 'fail' && (err = d.msg, busy = false);
        wk.onerror = e => { err = e.message; busy = false; };
      } else {
        const V = await import(`${MP}/vision_bundle.mjs`), fs = await V.FilesetResolver.forVisionTasks(`${MP}/wasm`);
        const mk = delegate => V.PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: MODEL, delegate }, ...opts });
        for (const d of dels) try { lm = await mk(d); delegate = d; break; } catch (e) { if (d === 'CPU') throw e; }
      }
      ready = true;
    } catch (e) { err = String(e); console.error('posetrack', e); }
  })();

  let sentAt = 0, lastTs = 0;
  async function tick() {
    if (!ready || busy || video.readyState < 2 || !video.videoWidth) return;
    if (video.currentTime === lastVT) return; // no new frame since last time
    lastVT = video.currentTime; busy = true;
    const t = performance.now() / 1000, t0 = performance.now();
    try {
      if (wk) {
        const s = Math.min(1, IN_W / video.videoWidth);
        const bmp = await createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * s), resizeHeight: Math.round(video.videoHeight * s), resizeQuality: 'low' });
        sentAt = performance.now(); ema('main', sentAt - t0);
        wk.postMessage({ bmp, t }, [bmp]);
      } else {
        const ts = lastTs = Math.max(lastTs + 1, Math.round(t * 1000)), r = lm.detectForVideo(video, ts), ms = performance.now() - t0;
        const poses = r.landmarks.map((p, i) => ({ lm: Float32Array.from(p.flatMap(q => [q.x, q.y, q.z, q.visibility ?? 1])), wl: Float32Array.from(r.worldLandmarks[i].flatMap(q => [q.x, q.y, q.z])) }));
        onResult(poses, t, ms);
        ema('main', performance.now() - t0);
      }
    } catch (e) { busy = false; err = String(e); }
  }

  function onResult(poses, t, ms) {
    const t1 = performance.now();
    ema('ms', ms); if (wk) ema('lat', t1 - sentAt);
    avg.ticks.push(t); while (avg.ticks.length && avg.ticks[0] < t - 2) avg.ticks.shift();
    const cam = getCamera?.() ?? null, vw = video.videoWidth, vh = video.videoHeight;
    let ms_ = poses.map(p => measure(p, vw, vh, cam)).filter(m => m.conf > .3);
    // the model sometimes returns the same person twice: drop a pose whose hips sit on another's
    ms_ = ms_.filter((m, i) => !ms_.some((o, j) => j < i && Math.hypot(o.img.hip[0] - m.img.hip[0], o.img.hip[1] - m.img.hip[1]) < .05 * vh));
    assign(ms_.slice(0, 2), t, cam ? GATE.m : GATE.img, vw / vh);
    ema('post', performance.now() - t1); // measure + assign + filters, on the main thread in both modes
    avg.n++; busy = false;
  }

  // identity: 2x2 assignment on floor position (image position without a camera). Lost slots cost GATE (+distance to
  // their last place), never-seen slots additionally prefer their side of the picture (A left).
  function assign(ds, t, gate, aspect) {
    const cost = (s, m) => {
      const k = trk[s], alive = k && t - k.t <= HOLD;
      if (alive) { const dt = t - k.t; return Math.hypot(k.key[0] + k.v[0] * dt - m.key[0], k.key[2] + k.v[2] * dt - m.key[2]); } // constant velocity: two people crossing keep their labels
      if (k) return gate + .5 * Math.hypot(k.key[0] - m.key[0], k.key[2] - m.key[2]);
      const left = m.img.hip[0] / (aspect * video.videoHeight) < .5;
      return 2 * gate + ((s === 'A') === left ? 0 : gate);
    };
    let pick = {};
    // chest tags seen by the third-person camera (setHints): a tag inside a person's torso names that person outright
    const torso = (m, u, v) => {
      const q = [m.img.pts.lSh, m.img.pts.rSh, m.img.pts.lHip, m.img.pts.rHip], xs = q.map(p => p[0]), ys = q.map(p => p[1]);
      const pad = .25 * (Math.max(...xs) - Math.min(...xs)) + 4;
      return u > Math.min(...xs) - pad && u < Math.max(...xs) + pad && v > Math.min(...ys) - pad && v < Math.max(...ys) + pad;
    };
    for (const h of hints) if (t - h.t < 1) { const m = ds.find(d => torso(d, h.u, h.v)); if (m) pick[h.slot] = m; }
    if (pick.A && pick.A === pick.B) pick = {}; // both tags on one body: ignore the hints this time
    const rest = ds.filter(d => d !== pick.A && d !== pick.B), free = ['A', 'B'].filter(s => !pick[s]);
    if (free.length === 1 && rest.length) pick[free[0]] = rest.sort((a, b) => cost(free[0], a) - cost(free[0], b))[0];
    if (free.length === 2) {
      if (ds.length === 2) pick = cost('A', ds[0]) + cost('B', ds[1]) <= cost('A', ds[1]) + cost('B', ds[0]) ? { A: ds[0], B: ds[1] } : { A: ds[1], B: ds[0] };
      else if (ds.length === 1) pick = cost('A', ds[0]) <= cost('B', ds[0]) ? { A: ds[0] } : { B: ds[0] };
    }
    for (const s of ['A', 'B']) {
      const m = pick[s], o = st[s], F = flt[s];
      if (!m) { o.age = trk[s] ? t - trk[s].t : Infinity; o.seen = o.age <= HOLD; continue; }
      if (trk[s] && t - trk[s].t > HOLD) for (const f of Object.values(F)) f.reset(); // reappeared: do not glide from the old place
      const k = trk[s], dt = k ? t - k.t : 1;
      const v = dt > 0 && dt <= HOLD ? m.key.map((q, i) => .5 * k.v[i] + .5 * (q - k.key[i]) / dt) : [0, 0, 0];
      trk[s] = { key: m.key, t, v: v.map(q => Math.max(-3 * gate, Math.min(3 * gate, q))) }; // cap: one bad frame must not fling the prediction
      const fy = (f, y) => { if (y == null) return null; const v = f.f([Math.cos(y), Math.sin(y)], t); return Math.atan2(v[1], v[0]); };
      Object.assign(o, {
        seen: true, age: 0, t, img: m.img, conf: m.conf, footFrom: m.footFrom ?? null,
        foot: m.foot && F.foot.f(m.foot, t), chest: m.chest && F.chest.f(m.chest, t),
        wrist: m.wrist && { L: F.L.f(m.wrist.L, t), R: F.R.f(m.wrist.R, t) },
        yaw2: fy(F.yaw2, m.yaw2), yaw3: fy(F.yaw3, m.yaw3),
      });
      o.yaw = o.yaw3 ?? o.yaw2;
      if (m.skel) { // light exponential smoothing in place (33 joints: a One Euro each would cost more than it gives)
        if (!o.skel || o.age > 0 || !k) o.skel = Float32Array.from(m.skel); else for (let i = 0; i < 99; i++) o.skel[i] += .55 * (m.skel[i] - o.skel[i]);
        o.skelVis = m.skelVis;
      } else o.skel = null;
    }
  }

  return {
    start() { if (!timer) timer = setInterval(tick, 1000 / hz); return init; },
    stop() { clearInterval(timer); timer = null; },
    get: slot => st[slot],
    setHints(h) { hints = h; },
    setSwap() { for (const o of [st, flt, trk]) [o.A, o.B] = [o.B, o.A]; },
    dispose() { this.stop(); wk?.terminate(); lm?.close(); },
    get ms() { return avg.ms; },          // inference only (in the worker, or on the main thread when worker = false)
    get mainMs() { return avg.main; },    // main-thread cost per tick
    get latMs() { return avg.lat; },      // grab -> result, worker mode
    get postMs() { return avg.post; },    // result handling (main thread)
    get hz() { return avg.ticks.length > 1 ? (avg.ticks.length - 1) / (avg.ticks.at(-1) - avg.ticks[0]) : 0; },
    get ready() { return ready; }, get delegate() { return delegate; }, get error() { return err; },
    worker: !!worker,
  };
}
