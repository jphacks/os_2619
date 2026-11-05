// Stick scan: the 3D shape of a (natural, mostly brown) stick from phone photos of it lying on the (black and white) mahoujin.
// The phone (Scan button: Android Scan.kt, iOS Scan.swift) sends { type: 'scan', step, n, k, tags, jpg, w, h } packets:
//   step 'stick' a picture of the stick lying on the sheets, tip toward T0 / -z; 'start' / 'done' / 'cancel' around them.
//   stickui.js decodes the pictures and calls buildStick() here on 'done'.
// Method: every picture's camera from the sheets' tags (extrinsics.js solveCamera); per picture a mask of what is neither the white paper
// nor the black print (stickMask); a voxel hull above the floor carved from the masks (coarse,
// then fine near the survivors); its largest blob turned into a generalised cylinder along its main axis: per ring the centre (so a bent
// stick stays bent) and the radius at AROUND angles (so knots and taper show). The underside is never seen: it mirrors the top.
// Plain JS, no deps: the page and node tests (test-stickscan.mjs) share it.
import * as W from './world.js';
import { solveCamera } from './extrinsics.js';

export const SCAN = {
  radius: .6,    // the volume searched: inside this circle round the sheets' centre (the mahoujin paper; a brown floor outside stays out)
  top: .07,      // and 0 < y < top (m)
  coarse: .006, fine: .002, // voxel sides, m
  minY: .002,
  rings: 64, around: 16,
  minViews: 6,
  colour: .06,   // stickMask: coloured = chroma this much above the picture's usual (the paper's white balance)
  paper: .75, ink: .3, // stickMask: brighter than this x the paper's level is paper, darker than this x is ink (when without colour)
};

/** A picture's camera from its tags (corners 0..1) and intrinsics k [fx/w, fy/h, cx/w, cy/h], for a w x h picture. null if < 2 sheets. */
export function viewCamera(tags, k, w, h) {
  const dets = (tags ?? []).filter(t => W.CORNER_IDS.includes(t.id) && t.c?.length === 4).map(t => ({ id: t.id, corners: t.c.map(([u, v]) => [u * w, v * h]) }));
  if (dets.length < 2) return null;
  // shortcut: solveCamera puts the principal point at the centre (phones are within ~1%); pass k's cx, cy through if poses come out skewed
  const fovY = 2 * Math.atan(h / 2 / (k[1] * h)) * 180 / Math.PI;
  const r = solveCamera(dets, w, h, { fovYGuess: fovY, fitFocal: false });
  if (!r?.pose || !(r.reprojErrPx < 4)) return null;
  return { pose: r.pose, f: r.focalPx, w, h, err: r.reprojErrPx };
}

// ---- projection: view = { img: { data RGBA, width, height }, cam: { pose: world_T_cam (OpenCV cam), f, w, h } } ----
function prep(v) {
  const T = W.invert(v.cam.pose);
  return { img: v.img, W: v.img.width, H: v.img.height, R: T.R, t: T.t, O: v.cam.pose.t, f: v.cam.f * v.img.width / v.cam.w, cx: v.img.width / 2, cy: v.img.height / 2 };
}
/** Pixel index of world point (x, y, z) in view v, or -1 outside / behind. */
function px(v, x, y, z) {
  const R = v.R, Z = R[6] * x + R[7] * y + R[8] * z + v.t[2];
  if (Z < .05) return -1;
  const u = Math.floor((R[0] * x + R[1] * y + R[2] * z + v.t[0]) * v.f / Z + v.cx), w = Math.floor((R[3] * x + R[4] * y + R[5] * z + v.t[1]) * v.f / Z + v.cy);
  return u < 0 || w < 0 || u >= v.W || w >= v.H ? -1 : w * v.W + u;
}

/**
 * 1 where the picture shows the stick: what is neither the white paper nor the black print. A natural stick is not all brown (grey bark,
 * pale or dark patches), so: anything coloured, or any mid tone that is not an edge between paper and ink (a print line's blurred border).
 * Levels follow the picture's own exposure and white balance (most of it is paper). A stick as white as the paper is not found.
 */
export function stickMask(img) {
  const d = img.data, Wd = img.width, Ht = img.height, n = Wd * Ht;
  const lum = new Float32Array(n), chr = new Float32Array(n), ls = [], cs = [];
  for (let p = 0; p < n; p++) {
    const r = d[4 * p], g = d[4 * p + 1], b = d[4 * p + 2], l = r + g + b;
    lum[p] = l; chr[p] = (Math.max(r, g, b) - Math.min(r, g, b)) / (l + 30); // +30: dark pixels' colour is mostly noise
    if ((p & 15) === 0) { ls.push(l); cs.push(chr[p]); }
  }
  ls.sort((a, b) => a - b); cs.sort((a, b) => a - b);
  const paper = ls[Math.floor(.9 * ls.length)], cut = Math.max(.08, cs[cs.length >> 1] + SCAN.colour);
  const kind = new Uint8Array(n); // 0 mid tone, 1 paper, 2 ink (both without colour)
  for (let p = 0; p < n; p++) if (chr[p] <= cut) kind[p] = lum[p] > SCAN.paper * paper ? 1 : lum[p] < SCAN.ink * paper ? 2 : 0;
  const m = new Uint8Array(n);
  for (let y = 0; y < Ht; y++) for (let x = 0; x < Wd; x++) {
    const p = y * Wd + x;
    if (chr[p] > cut) { m[p] = lum[p] > .1 * paper ? 1 : 0; continue; }
    if (kind[p]) continue;
    let nearPaper = false, nearInk = false; // a print edge has both within 2 px
    for (let dy = -2; dy <= 2 && !(nearPaper && nearInk); dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= Wd || yy >= Ht) continue;
      const k = kind[yy * Wd + xx]; if (k === 1) nearPaper = true; else if (k === 2) nearInk = true;
    }
    m[p] = nearPaper && nearInk ? 0 : 1;
  }
  return m;
}

/** Inside the hull at (x, y, z)? The stick in all views that see it there, but a few (pose / mask errors). */
function inHull(vs, ms, x, y, z) {
  const allow = Math.max(1, Math.floor(.12 * vs.length));
  let seen = 0, out = 0;
  for (let i = 0; i < vs.length; i++) {
    const p = px(vs[i], x, y, z); if (p < 0) continue;
    seen++; if (!ms[i][p] && ++out > allow) return false;
  }
  return seen >= 4;
}

/**
 * buildStick(views) -> model, or throws an Error saying what is missing.
 * views: { img: { data RGBA, width, height }, cam: viewCamera(...) }. The stick lies on the sheets with its tip toward -z (T0).
 * model: { v: 2, length (m), rings, around, c: [rings x (side, up)] centre offset from the straight axis (m),
 *          r: [rings x around] radius (m) at angle 2 pi j / around from up toward side; ring 0 is the grip end, the last the tip, views }
 */
export function buildStick(views) {
  const vs = views.filter(v => v.cam).map(prep);
  if (vs.length < SCAN.minViews) throw new Error(`棒の写真が足りません（${vs.length} / ${SCAN.minViews}）`);
  const ms = vs.map(v => stickMask(v.img));
  const { radius: RAD, top, coarse, fine, minY } = SCAN, half = RAD;

  // coarse carve over the whole volume
  const cn = Math.ceil(2 * half / coarse), cy = Math.ceil(top / coarse), keepC = new Uint8Array(cn * cy * cn);
  for (let i = 0; i < cn; i++) for (let k = 0; k < cn; k++) {
    const x = -half + (i + .5) * coarse, z = -half + (k + .5) * coarse; if (x * x + z * z > RAD * RAD) continue;
    for (let j = 0; j < cy; j++) if (inHull(vs, ms, x, (j + .5) * coarse, z)) keepC[(i * cy + j) * cn + k] = 1;
  }
  // fine carve inside the coarse survivors grown by one coarse cell
  const fn = Math.ceil(2 * half / fine), fy = Math.ceil(top / fine), q = Math.round(coarse / fine);
  const keepF = new Uint8Array(fn * fy * fn), tried = new Uint8Array(fn * fy * fn);
  for (let i = 0; i < cn; i++) for (let j = 0; j < cy; j++) for (let k = 0; k < cn; k++) {
    if (!keepC[(i * cy + j) * cn + k]) continue;
    for (let fi = Math.max(0, (i - 1) * q); fi < Math.min(fn, (i + 2) * q); fi++)
      for (let fj = Math.max(0, (j - 1) * q); fj < Math.min(fy, (j + 2) * q); fj++)
        for (let fk = Math.max(0, (k - 1) * q); fk < Math.min(fn, (k + 2) * q); fk++) {
          const id = (fi * fy + fj) * fn + fk; if (tried[id]) continue; tried[id] = 1;
          const y = (fj + .5) * fine; if (y < minY) continue;
          if (inHull(vs, ms, -half + (fi + .5) * fine, y, -half + (fk + .5) * fine)) keepF[id] = 1;
        }
  }
  // the largest 26-connected blob
  let best = [];
  const seen = tried.fill(0);
  for (let s = 0; s < keepF.length; s++) {
    if (!keepF[s] || seen[s]) continue;
    const blob = [s]; seen[s] = 1;
    for (let h = 0; h < blob.length; h++) {
      const id = blob[h], fk = id % fn, fj = ((id / fn) | 0) % fy, fi = (id / fn / fy) | 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const ii = fi + a, jj = fj + b, kk = fk + c; if (ii < 0 || jj < 0 || kk < 0 || ii >= fn || jj >= fy || kk >= fn) continue;
        const nb = (ii * fy + jj) * fn + kk; if (keepF[nb] && !seen[nb]) { seen[nb] = 1; blob.push(nb); }
      }
    }
    if (blob.length > best.length) best = blob;
  }
  if (best.length < 50) throw new Error('棒が見つかりません（魔法陣の白黒以外のものが写っていない）');
  const P = best.map(id => { const fk = id % fn, fj = ((id / fn) | 0) % fy, fi = (id / fn / fy) | 0; return [-half + (fi + .5) * fine, (fj + .5) * fine, -half + (fk + .5) * fine]; });
  return { ...profile(P), views: vs.length };
}

const smooth = (a, k) => a.map((_, i) => { let s = 0, n = 0; for (let d = -k; d <= k; d++) if (a[i + d] !== undefined) { s += a[i + d]; n++; } return s / n; });
const median3 = a => a.map((v, i) => [a[i - 1] ?? v, v, a[i + 1] ?? v].sort((x, y) => x - y)[1]);
/** Fill NaNs from the nearest known neighbours (linear in between, flat past the ends); all unknown: fallback. */
function fillGaps(a, fallback) {
  const known = a.map((v, i) => isNaN(v) ? -1 : i).filter(i => i >= 0);
  if (!known.length) return a.map(() => fallback);
  return a.map((v, i) => {
    if (!isNaN(v)) return v;
    let lo = -1, hi = -1; for (const k of known) { if (k < i) lo = k; else if (hi < 0) hi = k; }
    if (lo < 0) return a[hi]; if (hi < 0) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (i - lo) / (hi - lo);
  });
}

/** The blob as a generalised cylinder: main axis on the floor (tip toward -z), per ring the centre and the radius at each angle. */
function profile(P) {
  const { fine, rings: N, around: A } = SCAN;
  let mx = 0, mz = 0; for (const p of P) { mx += p[0]; mz += p[2]; } mx /= P.length; mz /= P.length;
  let xx = 0, zz = 0, xz = 0; for (const p of P) { const x = p[0] - mx, z = p[2] - mz; xx += x * x; zz += z * z; xz += x * z; }
  const th = .5 * Math.atan2(2 * xz, xx - zz); let ax = Math.cos(th), az = Math.sin(th);
  if (az > 0) { ax = -ax; az = -az; } // ring 0 = grip, the last ring = tip, which lies toward T0 (-z)
  const sx = -az, sz = ax; // horizontal, across the stick ("side")
  const S = P.map(p => (p[0] - mx) * ax + (p[2] - mz) * az), Lat = P.map(p => (p[0] - mx) * sx + (p[2] - mz) * sz);
  let s0 = Infinity, s1 = -Infinity; for (const s of S) { if (s < s0) s0 = s; if (s > s1) s1 = s; }
  s0 -= fine / 2; s1 += fine / 2;
  const L = s1 - s0, ringOf = s => Math.min(N - 1, Math.floor((s - s0) / L * N));
  if (L < .1 || L > 2) throw new Error(`棒の長さが変です（${(L * 100).toFixed(0)} cm）`);
  const members = Array.from({ length: N }, () => []);
  P.forEach((p, i) => members[ringOf(S[i])].push(i));

  // per ring: the top, the width of the upper half (the floor and the hidden underside never touch it), so the centre
  let cLat = new Array(N).fill(NaN), cUp = new Array(N).fill(NaN);
  for (let r = 0; r < N; r++) {
    const m = members[r]; if (!m.length) continue;
    let topY = 0; for (const i of m) topY = Math.max(topY, P[i][1] + fine / 2);
    let lo = Infinity, hi = -Infinity; for (const i of m) if (P[i][1] >= topY / 2) { lo = Math.min(lo, Lat[i]); hi = Math.max(hi, Lat[i]); }
    const r0 = Math.min((hi - lo + fine) / 2, topY / 2);
    cLat[r] = (lo + hi) / 2; cUp[r] = topY - r0;
  }
  cLat = smooth(median3(fillGaps(cLat, 0)), 2); cUp = smooth(median3(fillGaps(cUp, .01)), 2);

  // radius per angle: the farthest voxel from the centre in each angular bin of the upper half, mirrored below
  const rad = Array.from({ length: N }, () => new Array(A).fill(NaN));
  for (let r = 0; r < N; r++) for (const i of members[r]) {
    const dl = Lat[i] - cLat[r], du = P[i][1] - cUp[r]; if (du < -fine) continue;
    const a = ((Math.round(Math.atan2(dl, du) / (2 * Math.PI) * A) % A) + A) % A, d = Math.hypot(dl, du) + fine / 2;
    if (!(rad[r][a] >= d)) rad[r][a] = d;
  }
  for (let r = 0; r < N; r++) for (let a = 0; a < A; a++) if (a > A / 4 && a < 3 * A / 4) rad[r][a] = rad[r][(A / 2 - a + A) % A]; // the underside mirrors the top
  // gaps around the ring, then along the stick; smoothed along the stick (no shrink: the strict mask already trims the edge pixels)
  for (let r = 0; r < N; r++) rad[r] = fillGaps([...rad[r], ...rad[r], ...rad[r]], NaN).slice(A, 2 * A);
  for (let a = 0; a < A; a++) {
    const col = smooth(median3(fillGaps(rad.map(row => row[a]), .01).map(v => Math.max(fine, v))), 1);
    for (let r = 0; r < N; r++) rad[r][a] = col[r];
  }
  const upMean = cUp.reduce((s, v) => s + v, 0) / N;
  return {
    v: 2, length: +L.toFixed(3), rings: N, around: A,
    c: cLat.flatMap((l, r) => [+l.toFixed(4), +(cUp[r] - upMean).toFixed(4)]),
    r: rad.flat().map(v => +v.toFixed(4)), voxels: P.length,
  };
}
