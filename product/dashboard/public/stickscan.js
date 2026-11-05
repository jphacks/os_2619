// Stick scan: a 3D model of a stick from phone photos of it lying on the floor sheets (the mahoujin, or the AprilTag squares).
// The phone (Scan button: Android Scan.kt, iOS Scan.swift) sends { type: 'scan', step, n, k, tags, jpg, w, h } packets:
//   step 'bg'    the empty sheets from around (the background), 'stick' the stick lying on them, tip toward T0 / -z,
//   'start' / 'done' / 'cancel' around them. stickui.js decodes the pictures and calls buildStick() here on 'done'.
// Method: every picture's camera from the sheets' tags (extrinsics.js solveCamera); the empty floor's colour on a plane grid (median
// over the background views); per stick view a mask of what differs from that floor; a voxel hull above the floor carved from the
// masks (coarse, then fine near the survivors); its largest blob straightened into a profile along its main axis: RINGS radii and
// AROUND colours per ring (a small texture). Plain JS, no deps: the page and node tests (test-stickscan.mjs) share it.
import * as W from './world.js';
import { solveCamera } from './extrinsics.js';

export const SCAN = {
  half: .65,     // the volume searched: |x|, |z| <= half (m), around the sheets' centre
  top: .072,     // and 0 < y < top
  coarse: .006, fine: .003, plane: .004, // voxel sides and the floor grid's cell, m
  minY: .006,    // voxels lower than this are left out of the blob (floor print / shadow noise lives there): sticks thinner than 6 mm are lost
  rings: 40, around: 8,
  minBg: 3, minStick: 6,
};
const UNK = 2; // mask values: 0 floor, 1 something else, UNK no floor known there

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
  return { img: v.img, W: v.img.width, H: v.img.height, R: T.R, t: T.t, Rw: v.cam.pose.R, O: v.cam.pose.t, f: v.cam.f * v.img.width / v.cam.w, cx: v.img.width / 2, cy: v.img.height / 2 };
}
/** Pixel index of world point (x, y, z) in view v, or -1 outside / behind. */
function px(v, x, y, z) {
  const R = v.R, Z = R[6] * x + R[7] * y + R[8] * z + v.t[2];
  if (Z < .05) return -1;
  const u = Math.floor((R[0] * x + R[1] * y + R[2] * z + v.t[0]) * v.f / Z + v.cx), w = Math.floor((R[3] * x + R[4] * y + R[5] * z + v.t[1]) * v.f / Z + v.cy);
  return u < 0 || w < 0 || u >= v.W || w >= v.H ? -1 : w * v.W + u;
}
const med = (a, n) => { const s = a.slice(0, n).sort((p, q) => p - q); return s[n >> 1]; };

/** The empty floor: median colour per plane cell over the background views. */
function floorGrid(bgs) {
  const { half, plane } = SCAN, n = Math.ceil(2 * half / plane), rgb = new Uint8Array(n * n * 3), ok = new Uint8Array(n * n);
  const r = new Array(bgs.length), g = new Array(bgs.length), b = new Array(bgs.length);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -half + (i + .5) * plane, z = -half + (j + .5) * plane; let c = 0;
    for (const v of bgs) { const p = px(v, x, 0, z); if (p < 0) continue; const d = v.img.data; r[c] = d[4 * p]; g[c] = d[4 * p + 1]; b[c] = d[4 * p + 2]; c++; }
    if (!c) continue;
    const k = j * n + i; ok[k] = 1; rgb[3 * k] = med(r, c); rgb[3 * k + 1] = med(g, c); rgb[3 * k + 2] = med(b, c);
  }
  // per cell, the darkest / brightest of its 3x3 neighbours: a picture a few px off the floor's position still matches it at print edges
  const lo = new Float32Array(n * n), hi = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let a = Infinity, z = -Infinity;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const k = jj * n + ii; if (!ok[k]) continue;
      const l = rgb[3 * k] + rgb[3 * k + 1] + rgb[3 * k + 2]; if (l < a) a = l; if (l > z) z = l;
    }
    lo[j * n + i] = a; hi[j * n + i] = z;
  }
  return { n, rgb, ok, lo, hi };
}

/** 1 where view v shows something other than the floor, 0 floor, UNK where the floor is not known. Grown by 1 px (the carving keeps doubtful voxels). */
function stickMask(v, fl) {
  const { half, plane } = SCAN, { n, rgb, ok, lo, hi } = fl, d = v.img.data, Wd = v.W, Ht = v.H, R = v.Rw, O = v.O;
  const cell = new Int32Array(Wd * Ht).fill(-1), ratios = [];
  for (let y = 0; y < Ht; y++) for (let x = 0; x < Wd; x++) {
    const a = (x + .5 - v.cx) / v.f, b = (y + .5 - v.cy) / v.f;
    const dy = R[3] * a + R[4] * b + R[5]; if (dy >= -1e-6) continue; // ray never reaches the floor
    const s = -O[1] / dy, X = O[0] + s * (R[0] * a + R[1] * b + R[2]), Z = O[2] + s * (R[6] * a + R[7] * b + R[8]);
    const i = Math.floor((X + half) / plane), j = Math.floor((Z + half) / plane);
    if (i < 0 || j < 0 || i >= n || j >= n || !ok[j * n + i]) continue;
    const p = y * Wd + x, k = j * n + i; cell[p] = k;
    if ((p & 7) === 0) ratios.push((d[4 * p] + d[4 * p + 1] + d[4 * p + 2] + 3) / (rgb[3 * k] + rgb[3 * k + 1] + rgb[3 * k + 2] + 3));
  }
  const gain = ratios.length ? med(ratios, ratios.length) : 1; // exposure differs from picture to picture
  const m = new Uint8Array(Wd * Ht).fill(UNK);
  for (let p = 0; p < m.length; p++) {
    const k = cell[p]; if (k < 0) continue;
    const ra = d[4 * p], ga = d[4 * p + 1], ba = d[4 * p + 2], la = ra + ga + ba;
    // brightness: much darker than the darkest floor nearby (a shadow is ~0.5-0.7x) or much brighter than the brightest
    let fg = (la < .45 * gain * lo[k] && gain * lo[k] - la > 90) || la > 1.5 * gain * hi[k] + 60;
    if (!fg && la > 120) { // colour: chromaticity against the nearest-looking of the 3x3 floor cells
      const re = rgb[3 * k], ge = rgb[3 * k + 1], be = rgb[3 * k + 2], le = re + ge + be;
      if (le > 120) {
        const cd = (r2, g2, b2, l2) => Math.abs(ra / la - r2 / l2) + Math.abs(ga / la - g2 / l2) + Math.abs(ba / la - b2 / l2);
        if (cd(re, ge, be, le) > .12) {
          let best = Infinity; const i = k % n, j = (k / n) | 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            const q = jj * n + ii, l2 = rgb[3 * q] + rgb[3 * q + 1] + rgb[3 * q + 2]; if (!ok[q] || l2 <= 120) continue;
            best = Math.min(best, cd(rgb[3 * q], rgb[3 * q + 1], rgb[3 * q + 2], l2));
          }
          fg = best > .12;
        }
      }
    }
    m[p] = fg ? 1 : 0;
  }
  const out = m.slice();
  for (let y = 1; y < Ht - 1; y++) for (let x = 1; x < Wd - 1; x++) {
    const p = y * Wd + x;
    if (m[p] !== 1 && (m[p - 1] === 1 || m[p + 1] === 1 || m[p - Wd] === 1 || m[p + Wd] === 1)) out[p] = 1;
  }
  return out;
}

/** Inside the hull at (x, y, z)? Seen as "not floor" by all views that see it there, but a few (pose / mask errors). */
function inHull(vs, ms, x, y, z) {
  const allow = Math.max(1, Math.floor(.15 * vs.length));
  let seen = 0, out = 0;
  for (let i = 0; i < vs.length; i++) {
    const p = px(vs[i], x, y, z); if (p < 0) continue;
    const m = ms[i][p]; if (m === UNK) continue;
    seen++; if (m === 0 && ++out > allow) return false;
  }
  return seen >= 3;
}

/**
 * buildStick(bgViews, stickViews) -> model, or throws an Error saying what is missing.
 * views: { img: { data RGBA, width, height }, cam: viewCamera(...) }. The stick lies on the sheets with its tip toward -z (T0).
 * model: { v: 1, length (m), rings, around, r: [rings] radius (m) from the grip end (ring 0) to the tip, rgb: [rings * around * 3]
 *          sRGB 0-255, ring-major, around starting on top and turning over the stick's right side, views: { bg, stick }, voxels }
 */
export function buildStick(bgViews, stickViews) {
  const bgs = bgViews.filter(v => v.cam).map(prep), vs = stickViews.filter(v => v.cam).map(prep);
  if (bgs.length < SCAN.minBg) throw new Error(`床だけの写真が足りません（${bgs.length} / ${SCAN.minBg}）`);
  if (vs.length < SCAN.minStick) throw new Error(`棒を置いた写真が足りません（${vs.length} / ${SCAN.minStick}）`);
  const fl = floorGrid(bgs), ms = vs.map(v => stickMask(v, fl));
  const { half, top, coarse, fine, minY } = SCAN;

  // coarse carve over the whole volume
  const cn = Math.ceil(2 * half / coarse), cy = Math.ceil(top / coarse), keepC = new Uint8Array(cn * cy * cn);
  for (let i = 0; i < cn; i++) for (let k = 0; k < cn; k++) for (let j = 0; j < cy; j++)
    if (inHull(vs, ms, -half + (i + .5) * coarse, (j + .5) * coarse, -half + (k + .5) * coarse)) keepC[(i * cy + j) * cn + k] = 1;
  // fine carve inside the coarse survivors grown by one coarse cell
  const fn = Math.ceil(2 * half / fine), fy = Math.ceil(top / fine), keepF = new Uint8Array(fn * fy * fn), tried = new Uint8Array(fn * fy * fn), q = Math.round(coarse / fine);
  for (let i = 0; i < cn; i++) for (let j = 0; j < cy; j++) for (let k = 0; k < cn; k++) {
    if (!keepC[(i * cy + j) * cn + k]) continue;
    for (let fi = (i - 1) * q; fi < (i + 2) * q; fi++) for (let fj = Math.max(0, (j - 1) * q); fj < Math.min(fy, (j + 2) * q); fj++) for (let fk = (k - 1) * q; fk < (k + 2) * q; fk++) {
      if (fi < 0 || fk < 0 || fi >= fn || fk >= fn) continue;
      const id = (fi * fy + fj) * fn + fk; if (tried[id]) continue; tried[id] = 1;
      const y = (fj + .5) * fine; if (y < minY) continue;
      if (inHull(vs, ms, -half + (fi + .5) * fine, y, -half + (fk + .5) * fine)) keepF[id] = 1;
    }
  }
  // the largest 26-connected blob
  let best = [];
  const seen = new Uint8Array(keepF.length);
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
  if (best.length < 20) throw new Error('棒が見つかりません（床だけの写真と違う所がない）');
  const P = best.map(id => { const fk = id % fn, fj = ((id / fn) | 0) % fy, fi = (id / fn / fy) | 0; return [-half + (fi + .5) * fine, (fj + .5) * fine, -half + (fk + .5) * fine]; });
  return { ...profile(P, vs, ms), views: { bg: bgs.length, stick: vs.length } };
}

/** The blob straightened: main axis on the floor (tip toward -z), radius and colours per ring. */
function profile(P, vs, ms) {
  const { fine, rings: N, around: A } = SCAN;
  let mx = 0, mz = 0; for (const p of P) { mx += p[0]; mz += p[2]; } mx /= P.length; mz /= P.length;
  let xx = 0, zz = 0, xz = 0; for (const p of P) { const x = p[0] - mx, z = p[2] - mz; xx += x * x; zz += z * z; xz += x * z; }
  const th = .5 * Math.atan2(2 * xz, xx - zz); let ax = Math.cos(th), az = Math.sin(th);
  if (az > 0) { ax = -ax; az = -az; } // ring 0 = grip, the last ring = tip, which lies toward T0 (-z)
  const px_ = -az, pz = ax; // horizontal, across the stick
  const S = P.map(p => (p[0] - mx) * ax + (p[2] - mz) * az), Lat = P.map(p => (p[0] - mx) * px_ + (p[2] - mz) * pz);
  let s0 = Infinity, s1 = -Infinity; for (const s of S) { if (s < s0) s0 = s; if (s > s1) s1 = s; }
  s0 -= fine / 2; s1 += fine / 2;
  const L = s1 - s0, ring = s => Math.min(N - 1, Math.floor((s - s0) / L * N));
  if (L < .1 || L > 2) throw new Error(`棒の長さが変です（${(L * 100).toFixed(0)} cm）`);
  const topY = new Array(N).fill(0);
  P.forEach((p, i) => { const r = ring(S[i]); topY[r] = Math.max(topY[r], p[1] + fine / 2); });
  const lo = new Array(N).fill(Infinity), hi = new Array(N).fill(-Infinity);
  P.forEach((p, i) => { const r = ring(S[i]); if (p[1] >= topY[r] / 2) { lo[r] = Math.min(lo[r], Lat[i]); hi[r] = Math.max(hi[r], Lat[i]); } }); // the upper half: no shadow below
  // a hull is never thinner than the stick: the narrower of its width (upper half) and its height, less the half voxel and px the masks grew by
  let rad = topY.map((t, r) => t ? Math.max(fine, Math.min((hi[r] - lo[r] + fine) / 2, t / 2) - fine / 2) : NaN), mid = lo.map((l, r) => (l + hi[r]) / 2);
  const fill = a => a.map((v, r) => { if (!isNaN(v)) return v; for (let d = 1; d < N; d++) { const u = a[r - d] ?? NaN, w = a[r + d] ?? NaN; if (!isNaN(u) || !isNaN(w)) return isNaN(u) ? w : isNaN(w) ? u : (u + w) / 2; } return .01; });
  rad = fill(rad); mid = fill(mid);
  rad = rad.map((v, r) => [rad[r - 1] ?? v, v, rad[r + 1] ?? v].sort((a, b) => a - b)[1]); // median of 3: one odd ring

  // colours: points on the surface (a little inside it) facing a camera, inside that view's stick mask
  const rgb = new Array(N * A * 3).fill(-1), cr = [], cg = [], cb = [];
  for (let r = 0; r < N; r++) {
    const s = s0 + (r + .5) / N * L, R = rad[r], cx = mx + s * ax + mid[r] * px_, cz = mz + s * az + mid[r] * pz;
    for (let a = 0; a < A; a++) {
      const ph = 2 * Math.PI * a / A, nx = Math.sin(ph) * px_, ny = Math.cos(ph), nz = Math.sin(ph) * pz;
      const x = cx + .7 * R * nx, y = R + .7 * R * ny, z = cz + .7 * R * nz; let c = 0;
      vs.forEach((v, i) => {
        const ox = v.O[0] - x, oy = v.O[1] - y, oz = v.O[2] - z;
        if (ox * nx + oy * ny + oz * nz < .3 * Math.hypot(ox, oy, oz)) return; // facing away or grazing
        const p = px(v, x, y, z); if (p < 0 || ms[i][p] !== 1) return;
        const d = v.img.data; cr[c] = d[4 * p]; cg[c] = d[4 * p + 1]; cb[c] = d[4 * p + 2]; c++;
      });
      if (c) { const o = 3 * (r * A + a); rgb[o] = med(cr, c); rgb[o + 1] = med(cg, c); rgb[o + 2] = med(cb, c); }
    }
  }
  // never seen (the underside, a hidden end): the nearest seen angle on the ring, else the nearest ring, else grey
  for (let r = 0; r < N; r++) for (let a = 0; a < A; a++) {
    const o = 3 * (r * A + a); if (rgb[o] >= 0) continue;
    for (let d = 1; d <= A / 2 && rgb[o] < 0; d++) for (const b of [a - d, a + d]) {
      const q = 3 * (r * A + ((b % A) + A) % A); if (rgb[o] < 0 && rgb[q] >= 0) for (let c = 0; c < 3; c++) rgb[o + c] = rgb[q + c];
    }
  }
  for (let r = 0; r < N; r++) for (let a = 0; a < A; a++) {
    const o = 3 * (r * A + a); if (rgb[o] >= 0) continue;
    for (let d = 1; d < N && rgb[o] < 0; d++) for (const q of [r - d, r + d]) {
      const qo = 3 * (q * A + a); if (rgb[o] < 0 && q >= 0 && q < N && rgb[qo] >= 0) for (let c = 0; c < 3; c++) rgb[o + c] = rgb[qo + c];
    }
    if (rgb[o] < 0) rgb[o] = rgb[o + 1] = rgb[o + 2] = 160;
  }
  return { v: 1, length: +L.toFixed(3), rings: N, around: A, r: rad.map(v => +v.toFixed(4)), rgb, views: { stick: vs.length }, voxels: P.length };
}
