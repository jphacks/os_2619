// Recognition on the third-person picture, for the final screen only (2D, image coordinates; the game keeps its sensor positions).
//  - pose: MediaPipe Pose Landmarker (2 people, with a person mask each), in a classic Web Worker
//  - hands: the pose's own hand points (wrist, pinky, index, thumb); a hand model would see ~15 px hands at 3.5 m
//  - stick: from each hand, the straight thin line that differs from both of its sides (findStick), helped by the
//    sensor's stick direction projected into the picture and by last frame's answer. YOLO's COCO classes have no stick.
// A / B: the sensor chest positions projected into the picture (setHints), else continuity, else A = left.
// Ported in part from kawashima/posetrack.js (worker loading, timestamps).

export const MP_VER = '1.0.1'; // >= 2 weeks old on 2026-10-18 (1.1.x are days old)
export const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const IN_W = 960;  // frame width sent to the worker: the pose model resizes anyway, the stick search needs the pixels
const HOLD = .5;   // s a lost person keeps its slot
export const LM = { lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lPi: 17, rPi: 18, lIx: 19, rIx: 20, lTh: 21, rTh: 22, lHip: 23, rHip: 24 };

/**
 * The stick held by the hand at (hx, hy), in an RGBA image px (W x H): searched over all directions except back along the
 * forearm (toward the elbow ex, ey). ppm: image px per metre near the person. o: { len (m), prior (angle, rad) | null,
 * prev (angle) | null }. Returns { a (rad, image y down), len (px), conf (0..1) }. Self-contained: it also runs in the worker.
 */
export function findStick(px, W, H, hx, hy, ex, ey, ppm, o) {
  const TAU = 14, L = Math.max(30, o.len * ppm), dpx = Math.max(2, .035 * ppm), off = dpx * .9 + 1.5;
  const r0 = Math.max(4, .07 * ppm), r1 = 1.3 * L, step = Math.max(1, dpx * .5), back = Math.atan2(ey - hy, ex - hx);
  const at = (x, y) => { x = x | 0; y = y | 0; return x < 0 || y < 0 || x >= W || y >= H ? -1 : (y * W + x) * 4; };
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  function run(a) {
    const c = Math.cos(a), s = Math.sin(a), nx = -s * off, ny = c * off, ax = -s * dpx * .3, ay = c * dpx * .3;
    let acc = 0, best = 0, end = r0;
    for (let r = r0; r <= r1; r += step) {
      const x = hx + c * r, y = hy + s * r, k1 = at(x + nx, y + ny), k2 = at(x - nx, y - ny);
      const ka = at(x - ax, y - ay), kb = at(x, y), kc = at(x + ax, y + ay);
      if (k1 < 0 || k2 < 0 || ka < 0 || kc < 0) break;
      let d1 = 0, d2 = 0, l0 = 0, l1 = 0, l2 = 0;
      for (let ch = 0; ch < 3; ch++) {
        const m = (px[ka + ch] + px[kb + ch] + px[kc + ch]) / 3;
        d1 += Math.abs(m - px[k1 + ch]); d2 += Math.abs(m - px[k2 + ch]); l0 += m; l1 += px[k1 + ch]; l2 += px[k2 + ch];
      }
      let resp = Math.min(d1, d2) / 3;
      if ((l0 - l1) * (l0 - l2) < 0) resp *= .3; // an edge (darker on one side, lighter on the other), not a line
      acc += resp - TAU;
      if (acc > best) { best = acc; end = r; }
      if (acc < best - TAU * 8) break; // well past the end of the stick
    }
    return { best, end };
  }
  const near = (a, b, w) => b == null ? 0 : Math.exp(-((wrap(a - b) / w) ** 2));
  const weigh = (a, r) => r.best * (1 + .6 * near(a, o.prior, .35) + .4 * near(a, o.prev, .25));
  let top = null;
  for (let a = -Math.PI; a < Math.PI; a += .044) { // 2.5°
    if (Math.abs(wrap(a - back)) < .6) continue;
    const r = run(a), w = weigh(a, r);
    if (!top || w > top.w) top = { a, w, ...r };
  }
  if (!top) return null;
  for (let a = top.a - .044; a <= top.a + .044; a += .009) { const r = run(a), w = weigh(a, r); if (w > top.w) top = { a, w, ...r }; }
  return { a: wrap(top.a), len: top.end, conf: Math.min(1, top.best / (L * TAU)) };
}

/** Image px per metre near a person from the shoulder-to-hip length (~0.5 m), pts as [x, y, vis] in px. */
export function pxPerMetre(P) {
  const sh = [(P[LM.lSh][0] + P[LM.rSh][0]) / 2, (P[LM.lSh][1] + P[LM.rSh][1]) / 2], hp = [(P[LM.lHip][0] + P[LM.rHip][0]) / 2, (P[LM.lHip][1] + P[LM.rHip][1]) / 2];
  return Math.max(20, Math.hypot(sh[0] - hp[0], sh[1] - hp[1]) / .5);
}
/** Hand centre (px) from the pose's hand points of side 'l' / 'r', and its elbow. */
export function handOf(P, side) {
  const ids = [LM[side + 'Wr'], LM[side + 'Pi'], LM[side + 'Ix'], LM[side + 'Th']], n = ids.length;
  return { x: ids.reduce((s, i) => s + P[i][0], 0) / n, y: ids.reduce((s, i) => s + P[i][1], 0) / n, vis: P[LM[side + 'Wr']][2], ex: P[LM[side + 'El']][0], ey: P[LM[side + 'El']][1] };
}

// ---- worker: pose + masks + sticks on one frame ----
export const workerSrc = (mp, model) => `
importScripts('${mp}/vision_bundle.js');
const LM = ${JSON.stringify(LM)};
${findStick.toString()}
${pxPerMetre.toString()}
${handOf.toString()}
let lm = null, lastTs = 0, delegate = null, cv = null, cx = null;
const ready = (async () => {
  const fs = await Vision.FilesetResolver.forVisionTasks('${mp}/wasm');
  const mk = d => Vision.PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: '${model}', delegate: d }, runningMode: 'VIDEO', numPoses: 2,
    minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5, outputSegmentationMasks: true });
  for (const d of ['GPU', 'CPU']) try { lm = await mk(d); delegate = d; return d; } catch (e) { if (d === 'CPU') throw e; }
})();
ready.then(d => postMessage({ type: 'ready', delegate: d }), e => postMessage({ type: 'error', msg: String(e) }));
onmessage = async ({ data: { bmp, t, len, priors, sticks } }) => {
  try { await ready; } catch { bmp.close(); return; }
  const W = bmp.width, H = bmp.height, t0 = performance.now();
  const ts = Math.max(lastTs + 1, Math.round(t * 1000)); lastTs = ts; // VIDEO mode wants strictly increasing ms
  let r;
  try { r = lm.detectForVideo(bmp, ts); } catch (e) { bmp.close(); postMessage({ type: 'fail', msg: String(e) }); return; }
  const msPose = performance.now() - t0;
  if (!cv || cv.width !== W || cv.height !== H) { cv = new OffscreenCanvas(W, H); cx = cv.getContext('2d', { willReadFrequently: true }); }
  cx.drawImage(bmp, 0, 0); bmp.close();
  const px = r.landmarks.length ? cx.getImageData(0, 0, W, H).data : null;
  const near = (list, h, ppm) => { let b = null; for (const q of list ?? []) { const d = Math.hypot(q.x * W - h.x, q.y * H - h.y); if (d < .3 * ppm && (!b || d < b.d)) b = { d, a: q.a }; } return b?.a ?? null; };
  const persons = r.landmarks.map((p, i) => {
    const P = p.map(q => [q.x * W, q.y * H, q.visibility ?? 1]);
    let stick = null;
    if (Math.min(P[LM.lSh][2], P[LM.rSh][2], P[LM.lHip][2], P[LM.rHip][2]) > .3) {
      const ppm = pxPerMetre(P);
      for (const side of ['l', 'r']) {
        const h = handOf(P, side); if (h.vis < .3) continue;
        const s = findStick(px, W, H, h.x, h.y, h.ex, h.ey, ppm, { len, prior: near(priors, h, ppm), prev: near(sticks, h, ppm) });
        if (s && (!stick || s.conf > stick.conf)) stick = { ...s, side, x0: h.x / W, y0: h.y / H, x1: (h.x + Math.cos(s.a) * s.len) / W, y1: (h.y + Math.sin(s.a) * s.len) / H };
      }
    }
    let mask = null; const m = r.segmentationMasks?.[i];
    if (m) { // half resolution, 0..255
      const f = m.getAsFloat32Array(), mw = m.width, w = mw >> 1, h = m.height >> 1, d = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = f[(2 * y) * mw + 2 * x] * 255;
      mask = { w, h, d };
    }
    return { lm: Float32Array.from(p.flatMap(q => [q.x, q.y, q.visibility ?? 1])), stick, mask };
  });
  for (const m of r.segmentationMasks ?? []) m.close();
  postMessage({ type: 'res', t, ms: performance.now() - t0, msPose, persons }, persons.flatMap(p => [p.lm.buffer, ...(p.mask ? [p.mask.d.buffer] : [])]));
};`;

/**
 * createVision({ getSource }) -> { want(on), setHints({ A, B }), state, persons: { A, B } }
 * getSource(): the video (or the dummy room's canvas) to read. hints: per slot { chest: [u, v] (0..1), stick: { x, y, a } |
 * null } from the sensors. persons[slot]: { t, pts: [[u, v, vis] x 33] (0..1), stick: { x0, y0, x1, y1, conf, side } | null,
 * mask: { w, h, d } | null } or null. state: { ready, delegate, error, hz, ms, seq }.
 */
export function createVision({ getSource, hz = 15, stickLen = () => 1 }) {
  const S = { ready: false, delegate: null, error: null, hz: 0, ms: 0, msPose: 0, seq: 0, on: false };
  const persons = { A: null, B: null };
  let wk = null, busy = false, timer = null, hints = {}, ticks = [], lastKey = null;
  const base = `${location.origin}/cdn/npm/@mediapipe/tasks-vision@${MP_VER}`; // server.mjs caches the CDN (offline once fetched)

  function boot() {
    if (wk) return;
    wk = new Worker(URL.createObjectURL(new Blob([workerSrc(base, MODEL)], { type: 'text/javascript' })));
    wk.onmessage = ({ data: d }) => {
      if (d.type === 'ready') { S.ready = true; S.delegate = d.delegate; }
      else if (d.type === 'error') { S.error = 'MediaPipe を読み込めない: ' + d.msg; busy = false; }
      else if (d.type === 'fail') { S.error = d.msg; busy = false; }
      else if (d.type === 'res') onResult(d);
    };
    wk.onerror = e => { S.error = e.message; busy = false; };
  }
  async function tick() {
    if (!S.on || busy || !S.ready && wk) return;
    boot(); if (!S.ready) return;
    const src = getSource(), w = src?.videoWidth || src?.width, h = src?.videoHeight || src?.height;
    if (!w || !h || (src.readyState != null && src.readyState < 2)) return;
    const key = src.currentTime ?? performance.now(); if (key === lastKey) return; lastKey = key; // no new video frame
    busy = true;
    try {
      const s = Math.min(1, IN_W / w), bmp = await createImageBitmap(src, { resizeWidth: Math.round(w * s), resizeHeight: Math.round(h * s), resizeQuality: 'medium' });
      const pr = Object.values(hints).map(x => x?.stick).filter(Boolean);
      const st = Object.values(persons).filter(p => p?.stick).map(p => ({ x: p.stick.x0, y: p.stick.y0, a: Math.atan2((p.stick.y1 - p.stick.y0) * h, (p.stick.x1 - p.stick.x0) * w) }));
      wk.postMessage({ bmp, t: performance.now() / 1000, len: stickLen(), priors: pr, sticks: st }, [bmp]);
    } catch (e) { busy = false; S.error = String(e); }
  }
  function onResult({ t, ms, msPose, persons: list }) {
    busy = false; S.error = null; S.seq++;
    S.ms += .1 * (ms - S.ms); S.msPose += .1 * (msPose - S.msPose);
    ticks.push(t); while (ticks[0] < t - 2) ticks.shift(); S.hz = ticks.length > 1 ? (ticks.length - 1) / (t - ticks[0]) : 0;
    const ps = list.map(p => ({ t, pts: Array.from({ length: 33 }, (_, i) => [p.lm[3 * i], p.lm[3 * i + 1], p.lm[3 * i + 2]]), stick: p.stick, mask: p.mask }))
      .filter(p => (p.pts[LM.lSh][2] + p.pts[LM.rSh][2] + p.pts[LM.lHip][2] + p.pts[LM.rHip][2]) / 4 > .3);
    for (const p of ps) p.key = [(p.pts[LM.lSh][0] + p.pts[LM.rSh][0]) / 2, (p.pts[LM.lSh][1] + p.pts[LM.rSh][1]) / 2];
    const pick = assignSlots(ps, persons, hints, t);
    for (const s of ['A', 'B']) {
      if (pick[s]) persons[s] = pick[s];
      else if (persons[s] && t - persons[s].t > HOLD) persons[s] = null;
    }
  }
  return {
    want(on) { S.on = on; if (on && !timer) { boot(); timer = setInterval(tick, 1000 / hz); } if (!on && timer) { clearInterval(timer); timer = null; } },
    setHints(h) { hints = h; },
    persons, state: S,
  };
}

/** A / B for the people found: sensor chest hints first, then where each slot was last, then A = the left one. */
export function assignSlots(ps, last, hints, t) {
  const cost = (s, p) => {
    const h = hints[s]?.chest; if (h) return Math.hypot(h[0] - p.key[0], h[1] - p.key[1]);
    const l = last[s]; if (l && t - l.t <= HOLD) return Math.hypot(l.key[0] - p.key[0], l.key[1] - p.key[1]) + .05;
    return 1 + ((s === 'A') === (p.key[0] < .5) ? 0 : .5);
  };
  if (ps.length >= 2) {
    const [a, b] = ps;
    return cost('A', a) + cost('B', b) <= cost('A', b) + cost('B', a) ? { A: a, B: b } : { A: b, B: a };
  }
  if (ps.length === 1) return cost('A', ps[0]) <= cost('B', ps[0]) ? { A: ps[0] } : { B: ps[0] };
  return {};
}
