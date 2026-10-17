// Field map from ONE third-person view: four floor sheets (ids 0-3) lying anywhere, each turned any way, nothing
// measured. Recovers the camera focal, the camera pose and each sheet's floor (x, z, yaw); the known black-square
// sizes (world.js TAGS) fix the metric scale. Square pixels, principal point at the image centre, no distortion.
//
// Method (MarkerMapper, Muñoz-Salinas et al. 2018: per-marker poses to start, then one global reprojection fit):
//  1. per tag, its homography from the 4 corners (pixels about the principal point), once;
//  2. sweep the vertical fov. At each focal take both IPPE poses per tag (Collins & Bartoli 2014: a square's pose is
//     two-fold, a reflection about the line of sight, and at oblique / far views both fit equally well), keep the
//     per-tag choice whose normals agree best (all sheets lie on one floor) rather than the lowest single-tag error,
//     snap every tag onto the common plane and score the corner reprojection error;
//  3. LM over [log f, camera 6-dof, per tag (x, z, yaw) on the floor] from the best few focals, the largest tag
//     fixed at the floor origin (gauge), re-expressed afterwards;
//  4. world frame of setField: origin at the outline's area centroid, y up (toward the camera), +x from A's side
//     (the two sheets further left in the picture) to B's side. Mode 2 (only sheets 0 and 1, at the A and B ends):
//     origin at their midpoint, +x from the left one to the right one, poly a rectangle between them.
// The focal is observable because the floor's homography across the whole field gives 2 constraints on the
// intrinsics (Zhang); a camera looking straight down at the floor (fronto-parallel) cannot fix it, so when its
// 1-sigma exceeds FOV_SIGMA_MAX the fit is redone with fovYGuess and a warning (positions stay right: the in-plane
// distances scale with the tag sizes, not with f).
import * as W from './world.js';
import { detectTags } from './extrinsics.js';

export const FIELD_IDS = [0, 1, 2, 3];
export const PAIR_IDS = [0, 1]; // mode 2: the A-end and B-end sheets
const OBJ = [[-1, 1], [1, 1], [1, -1], [-1, -1]]; // tag-frame corners, OpenCV / detectTags order
const FOV_SIGMA_MAX = 1.5; // deg
// mode 2: two sheets often leave the focal loosely fixed (sigma 1.5-3°) yet still far closer than a 45° guess, which
// at an oblique view scales the sheet distance with it (tests: 10-30 cm off): keep the fit up to here, with a warning
const FOV_SIGMA_MAX2 = 3.5;
const DEG = Math.PI / 180;
const fToFov = (f, h) => 2 * Math.atan(h / 2 / f) / DEG;
const fovToF = (fov, h) => h / 2 / Math.tan(fov * DEG / 2);

// ---- tiny linear algebra (private copies: extrinsics.js keeps its own) ----
function solve(A, b) { // Gaussian elimination with partial pivoting, A n x n rows
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
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const col = (R, c) => [R[c], R[3 + c], R[6 + c]];
const rotBetween = (a, b) => { // minimal rotation taking unit a to unit b
  const ax = cross(a, b), s = Math.hypot(...ax), c = dot(a, b);
  return s < 1e-12 ? W.I3 : W.fromRodrigues(ax.map(v => v / s * Math.atan2(s, c)));
};
function homog(src, dst) { // 3x3 row-major, src -> dst, 4 points
  const A = [], b = [];
  src.forEach(([X, Y], k) => { const [u, v] = dst[k]; A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y], [0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(u, v); });
  const x = solve(A, b); return x && [...x, 1];
}

// ---- IPPE: both poses of a small square from its homography (normalised image coords) ----
// J = d(image)/d(plane) at the tag centre, whose image is v = (p, q). With Rv taking z to the ray through v,
// J = B A / tz where B = [I | -v] Rv[:, :2] and A = the top-left 2x2 of Rv^T R: so A is B^-1 J scaled to unit
// largest singular value, and the third row of R' = Rv^T R is fixed up to one common sign: the two solutions.
function ippe(Hp, f, obj, uvn) {
  const H = [Hp[0] / f, Hp[1] / f, Hp[2] / f, Hp[3] / f, Hp[4] / f, Hp[5] / f, Hp[6], Hp[7], Hp[8]];
  const p = H[2] / H[8], q = H[5] / H[8];
  const j00 = (H[0] - H[6] * p) / H[8], j01 = (H[1] - H[7] * p) / H[8], j10 = (H[3] - H[6] * q) / H[8], j11 = (H[4] - H[7] * q) / H[8];
  const Rv = rotBetween([0, 0, 1], norm([p, q, 1]));
  const b00 = Rv[0] - p * Rv[6], b01 = Rv[1] - p * Rv[7], b10 = Rv[3] - q * Rv[6], b11 = Rv[4] - q * Rv[7], bd = b00 * b11 - b01 * b10;
  const i00 = b11 / bd, i01 = -b01 / bd, i10 = -b10 / bd, i11 = b00 / bd;
  let a00 = i00 * j00 + i01 * j10, a01 = i00 * j01 + i01 * j11, a10 = i10 * j00 + i11 * j10, a11 = i10 * j01 + i11 * j11;
  const t00 = a00 * a00 + a10 * a10, t01 = a00 * a01 + a10 * a11, t11 = a01 * a01 + a11 * a11;
  const g = Math.sqrt(.5 * (t00 + t11 + Math.sqrt((t00 - t11) ** 2 + 4 * t01 * t01)));
  a00 /= g; a01 /= g; a10 /= g; a11 /= g;
  const b0 = Math.sqrt(Math.max(0, 1 - a00 * a00 - a10 * a10));
  let b1 = Math.sqrt(Math.max(0, 1 - a01 * a01 - a11 * a11));
  if (a00 * a01 + a10 * a11 > 0) b1 = -b1; // columns orthogonal: b0 b1 = -(a00 a01 + a10 a11)
  const out = [];
  for (const sg of [1, -1]) {
    const c1 = norm([a00, a10, sg * b0]); let c2 = [a01, a11, sg * b1];
    c2 = norm(c2.map((v, i) => v - dot(c1, c2) * c1[i]));
    const R = W.mul3(Rv, W.fromCols(c1, c2, cross(c1, c2))), t = transl(R, obj, uvn);
    if (t && t[2] > 0) out.push({ R, t });
  }
  return out;
}
function transl(R, obj, uvn) { // least-squares t for a known rotation: x (R P + t)_z = (R P + t)_x, same for y
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  obj.forEach((P, k) => {
    const rp = W.app3(R, P), [x, y] = uvn[k];
    for (const [row, rhs] of [[[1, 0, -x], x * rp[2] - rp[0]], [[0, 1, -y], y * rp[2] - rp[1]]])
      for (let i = 0; i < 3; i++) { b[i] += row[i] * rhs; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; }
  });
  return solve(A, b);
}

// ---- the floor model: cam_T_floor and per tag (x, z, yaw), floor frame y up, world.js floor-tag convention ----
function tagCorners(h, x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return OBJ.map(([ox, oy]) => [x + h * (ox * c - oy * s), 0, z + h * (-ox * s - oy * c)]);
}
function reproj(R, t, f, tags, poses) { // residuals in px, null if a corner is behind the camera
  const r = [];
  tags.forEach((tg, i) => {
    const [x, z, yaw] = poses[i];
    tagCorners(tg.h, x, z, yaw).forEach((P, k) => {
      const p = W.app3(R, P); p[0] += t[0]; p[1] += t[1]; p[2] += t[2];
      if (p[2] <= 1e-6) { r.push(NaN, NaN); return; }
      r.push(f * p[0] / p[2] - tg.uv[k][0], f * p[1] / p[2] - tg.uv[k][1]);
    });
  });
  return r.some(Number.isNaN) ? null : r;
}

// Initial pose at focal f: both IPPE poses per tag, the combination with the most consistent normals, every tag
// snapped onto the common plane, the floor frame on tag g. Returns { R, t, poses, cost, spread } or null.
function initAt(f, tags, g) {
  const cands = tags.map(tg => ippe(tg.Hp, f, tg.obj, tg.uv.map(([u, v]) => [u / f, v / f])));
  if (cands.some(c => !c.length)) return null;
  let best = null;
  const n = tags.length, combos = 1 << n;
  for (let m = 0; m < combos; m++) {
    const pick = cands.map((c, i) => c[(m >> i) & 1]); if (pick.some(p => !p)) continue;
    const ns = pick.map(p => col(p.R, 2)), nb = norm(ns.reduce((s, v) => s.map((x, i) => x + v[i]), [0, 0, 0]));
    const spread = Math.max(...ns.map(v => Math.acos(Math.min(1, dot(v, nb)))));
    if (!best || spread < best.spread) best = { pick, nb, spread };
  }
  if (!best) return null;
  const { pick, nb } = best, d = pick.reduce((s, p) => s + dot(nb, p.t), 0) / n; // plane nb . X = d (< 0: faces the camera)
  if (!(d < 0)) return null;
  const snapped = pick.map(p => ({ R: W.mul3(rotBetween(col(p.R, 2), nb), p.R), t: p.t.map(v => v * d / dot(nb, p.t)) }));
  // floor axes in cam: x = tag g's x, y = up = tag z, z = -tag y (yaw 0 sheet: top edge toward -z)
  const G = snapped[g], X = col(G.R, 0), R = W.fromCols(X, nb, cross(X, nb)), Rt = W.tr3(R), t = G.t;
  const poses = snapped.map(p => {
    const c = W.app3(Rt, p.t.map((v, i) => v - t[i])), xf = W.app3(Rt, col(p.R, 0));
    return [c[0], c[2], Math.atan2(-xf[2], xf[0])];
  });
  const r = reproj(R, t, f, tags, poses);
  return r && { R, t, poses, cost: r.reduce((s, v) => s + v * v, 0), spread: best.spread };
}

// LM over [log f?, rotation increment 3, translation 3, (x, z, yaw) of every tag but g]. Numeric central Jacobian.
function refine(init, f0, tags, g, fitF) {
  const o = fitF ? 1 : 0, free = tags.map((_, i) => i).filter(i => i !== g);
  const unpack = p => {
    const f = fitF ? f0 * Math.exp(p[0]) : f0, R = W.mul3(W.fromRodrigues(p.slice(o, o + 3)), init.R);
    const t = init.t.map((v, i) => v + p[o + 3 + i]), poses = init.poses.map(q => [...q]);
    free.forEach((i, k) => { poses[i] = p.slice(o + 6 + 3 * k, o + 9 + 3 * k); });
    poses[g] = [0, 0, 0];
    return { f, R, t, poses };
  };
  const resid = p => { const m = unpack(p); return reproj(m.R, m.t, m.f, tags, m.poses); };
  const cost = r => r ? r.reduce((s, v) => s + v * v, 0) : Infinity;
  let p = [...(fitF ? [0] : []), 0, 0, 0, 0, 0, 0, ...free.flatMap(i => init.poses[i])];
  const eps = p.map((_, k) => k < o ? 1e-6 : k < o + 3 ? 1e-7 : 1e-7);
  let r = resid(p), c = cost(r), lam = 1e-3, JtJ = null;
  for (let it = 0; it < 60 && isFinite(c); it++) {
    const J = [];
    for (let k = 0; k < p.length; k++) {
      const a = [...p], b = [...p]; a[k] += eps[k]; b[k] -= eps[k];
      const ra = resid(a), rb = resid(b); if (!ra || !rb) return { ...unpack(p), cost: c, JtJ, n: r.length };
      J.push(ra.map((v, i) => (v - rb[i]) / (2 * eps[k])));
    }
    JtJ = J.map(a => J.map(b => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }));
    const gr = J.map(a => { let s = 0; for (let i = 0; i < a.length; i++) s -= a[i] * r[i]; return s; });
    let ok = 0;
    for (let tries = 0; tries < 10 && !ok; tries++) {
      const d = solve(JtJ.map((row, i) => row.map((v, j) => v + (i === j ? lam * (v + 1e-9) : 0))), gr);
      if (d) {
        const p1 = p.map((v, i) => v + d[i]), r1 = resid(p1), c1 = cost(r1);
        if (c1 < c) { ok = (c - c1) > 1e-10 * c ? 1 : 2; p = p1; r = r1; c = c1; lam = Math.max(1e-9, lam / 5); break; }
      }
      lam *= 10;
    }
    if (ok !== 1) break;
  }
  return { ...unpack(p), cost: c, JtJ, n: r.length };
}

/**
 * solveFieldMap(dets, width, height, { fovYGuess, mode }) -> null or { cam, tags, poly, fovY, reprojErrPx, ids, warnings }.
 * dets: [{ id, corners: [[u,v] x4] }] in OpenCV corner order (detectTags / calibrateCamera).
 * mode 4 (default): needs >= 3 of ids 0-3, the sheets are the field's corners.
 * mode 2: uses only ids 0 and 1 (both needed), which mark the A end (further left in the picture) and the B end:
 *   origin at their midpoint, +x from A's sheet to B's; poly = a rectangle whose x = ±L/2 edges pass through the
 *   two centres (L = their distance), depth D = clamp(0.6 L, 1.5, 3) m centred on z = 0. The focal is fitted the
 *   same way (two coplanar sheets still constrain the floor homography), only less firmly: more face-on fallbacks.
 * cam: calibrateCamera's shape ({ pose: world_T_cam, OpenCV cam frame, fovY, focalPx, width, height, ids,
 *      reprojErrPx, focalFitted, fovSigma }), so toThreeCamera / projectWorld work on it.
 * tags: { id: { pos: [x, 0, z], yaw } } in world.js worldTagPose's floor convention -> setField({ poly, tags }).
 * poly: the tag centres (mode 4) [[x, z] x N] counter-clockwise seen from above (y toward the viewer): +x, then -z, -x, +z.
 */
export function solveFieldMap(dets, width, height, { fovYGuess = 45, mode = 4 } = {}) {
  const warnings = [], seen = new Set(), use = mode === 2 ? PAIR_IDS : FIELD_IDS;
  const ds = dets.filter(d => use.includes(d.id) && W.TAGS[d.id]?.size && !seen.has(d.id) && seen.add(d.id));
  if (ds.length < (mode === 2 ? 2 : 3)) return null;
  if (ds.length === 3) warnings.push('only 3 sheets seen: the field is their triangle');
  const cx = width / 2, cy = height / 2;
  const tags = ds.map(d => {
    const h = W.TAGS[d.id].size / 2, obj = OBJ.map(([x, y]) => [x * h, y * h, 0]), uv = d.corners.map(([u, v]) => [u - cx, v - cy]);
    return { id: d.id, h, obj, uv, Hp: homog(obj, uv), area: Math.abs(uv.reduce((s, p, k) => { const q = uv[(k + 1) % 4]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2 };
  });
  if (tags.some(t => !t.Hp)) return null;
  const g = tags.reduce((b, t, i) => t.area > tags[b].area ? i : b, 0); // gauge: the best-seen tag

  // focal sweep (log-spaced fov 12..100°), then LM from the best local minima of the sweep score
  const sweep = [];
  for (let fov = 12; fov <= 100; fov *= 1.04) { const f = fovToF(fov, height), s = initAt(f, tags, g); if (s) sweep.push({ f, ...s }); }
  if (!sweep.length) return null;
  const minima = sweep.filter((s, i) => (!sweep[i - 1] || s.cost <= sweep[i - 1].cost) && (!sweep[i + 1] || s.cost <= sweep[i + 1].cost))
    .sort((a, b) => a.cost - b.cost).slice(0, 3);
  let best = null;
  for (const s of minima) { const r = refine(s, s.f, tags, g, true); if (!best || r.cost < best.cost) best = { ...r, spread: s.spread }; }

  // focal pinned down? 1-sigma of the fov from the LM normal matrix (corner noise >= 0.2 px)
  const sPx = Math.max(.2, Math.sqrt(best.cost / best.n));
  const colF = best.JtJ && solve(best.JtJ, best.JtJ.map((_, i) => +(i === 0)));
  const sLogF = colF ? Math.sqrt(Math.max(0, colF[0])) * sPx : Infinity;
  let fovSigma = Math.abs(fToFov(best.f * Math.exp(-sLogF), height) - fToFov(best.f, height)), focalFitted = true;
  const fovFit = fToFov(best.f, height);
  if (fovSigma >= FOV_SIGMA_MAX && fovSigma < FOV_SIGMA_MAX2 && mode === 2 && fovFit >= 12 && fovFit <= 100)
    warnings.push(`focal only loosely fixed by two sheets: fov ${fovFit.toFixed(1)} ± ${fovSigma.toFixed(1)}°`);
  else if (!(fovSigma < FOV_SIGMA_MAX) || fovFit < 12 || fovFit > 100) {
    const f = fovToF(fovYGuess, height), s = initAt(f, tags, g);
    if (!s) return null;
    best = { ...refine(s, f, tags, g, false), spread: s.spread }; focalFitted = false;
    warnings.push(`focal not measurable from this view (floor seen nearly face-on, fov ${fovFit.toFixed(1)} ± ${fovSigma.toFixed(1)}°): using fovYGuess ${fovYGuess}°`);
  }
  const reprojErrPx = Math.sqrt(best.cost / (best.n / 2)); // RMS per corner, as calibrateCamera reports it
  if (reprojErrPx > 2) warnings.push(`large reprojection error ${reprojErrPx.toFixed(1)} px: a sheet moved, is not flat, or was misdetected`);
  if (best.spread > 20 * DEG) warnings.push(`sheet normals disagreed by up to ${(best.spread / DEG).toFixed(0)}° before the joint fit`);

  // ---- world frame (setField convention) ----
  const flT = W.invert({ R: best.R, t: best.t }); // floor_T_cam
  if (flT.t[1] <= 0) return null; // the camera must be above the floor it sees (tags face it, so this holds)
  const C = best.poses.map(([x, z]) => [x, z]);
  const imgU = tags.map(t => t.uv.reduce((s, p) => s + p[0], 0) / 4);
  let dir;
  if (tags.length === 2) { const [a, b] = imgU[0] < imgU[1] ? [0, 1] : [1, 0]; dir = [C[b][0] - C[a][0], C[b][1] - C[a][1]]; }
  else if (tags.length >= 4) { // A's side = the two sheets further left in the picture
    const o = imgU.map((u, i) => [u, i]).sort((a, b) => a[0] - b[0]).map(a => a[1]);
    const m = ids => [0, 1].map(a => ids.reduce((s, i) => s + C[i][a], 0) / ids.length);
    const A = m(o.slice(0, 2)), B = m(o.slice(-2));
    dir = [B[0] - A[0], B[1] - A[1]];
  } else { const rx = flT.R; dir = [rx[0], rx[6]]; } // 3 sheets: the camera's right along the floor
  const dn = Math.hypot(...dir); dir = dir.map(v => v / dn);
  // order around the outline in the floor frame (a rotation about y keeps the winding): angle of (x, -z) increasing
  const mean = [0, 1].map(a => C.reduce((s, p) => s + p[a], 0) / C.length);
  const order = C.map((p, i) => i).sort((i, j) => Math.atan2(-(C[i][1] - mean[1]), C[i][0] - mean[0]) - Math.atan2(-(C[j][1] - mean[1]), C[j][0] - mean[0]));
  let A2 = 0, gx = 0, gz = 0; // area centroid of the outline
  order.forEach((i, k) => { const [x0, z0] = C[i], [x1, z1] = C[order[(k + 1) % order.length]], cr = x0 * z1 - x1 * z0; A2 += cr; gx += (x0 + x1) * cr; gz += (z0 + z1) * cr; });
  const org = tags.length === 2 ? mean : Math.abs(A2) > 1e-9 ? [gx / (3 * A2), gz / (3 * A2)] : mean;
  const fl_T_world = W.pose(W.fromCols([dir[0], 0, dir[1]], [0, 1, 0], [-dir[1], 0, dir[0]]), [org[0], 0, org[1]]);
  const world_T_fl = W.invert(fl_T_world), world_T_cam = W.compose(world_T_fl, flT);
  const toW = ([x, z]) => { const p = W.apply(world_T_fl, [x, 0, z]); return [p[0], p[2]]; };
  const out = {};
  tags.forEach((t, i) => {
    const [x, z, yaw] = best.poses[i], [X, Z] = toW([x, z]);
    const xw = W.app3(world_T_fl.R, [Math.cos(yaw), 0, -Math.sin(yaw)]);
    out[t.id] = { pos: [X, 0, Z], yaw: Math.atan2(-xw[2], xw[0]) };
  });
  const ids = tags.map(t => t.id), fovY = fToFov(best.f, height);
  const cam = { pose: world_T_cam, fovY, focalPx: best.f, width, height, ids, reprojErrPx, focalFitted, fovSigma: focalFitted ? fovSigma : null };
  let poly = order.map(i => toW(C[i]));
  if (tags.length === 2) { // A and B ends: the rectangle between them, same winding as above
    const L = Math.hypot(C[1][0] - C[0][0], C[1][1] - C[0][1]), x = L / 2, z = Math.min(3, Math.max(1.5, .6 * L)) / 2;
    poly = [[x, -z], [-x, -z], [-x, z], [x, z]];
  }
  return { cam, tags: out, poly, fovY, reprojErrPx, ids, warnings };
}

/**
 * scanField(videoOrCanvas, { fovYGuess, mode, frames, intervalMs }) -> Promise of solveFieldMap's result (plus dets) or null.
 * Like calibrateCamera: `frames` frames `intervalMs` apart (tripod), each tag's corners averaged over the frames it
 * fit the pattern well in, so someone walking past a sheet for a moment does not lose it.
 */
const MAX_MISFIT = .15;
export async function scanField(videoOrCanvas, { fovYGuess = 45, mode = 4, frames = 5, intervalMs = 150 } = {}) {
  const acc = {}; let size = null;
  for (let i = 0; i < frames; i++) {
    if (i) await new Promise(r => setTimeout(r, intervalMs));
    const dets = await detectTags(videoOrCanvas, mode === 2 ? PAIR_IDS : FIELD_IDS);
    if (dets.width) size = [dets.width, dets.height];
    for (const d of dets) (acc[d.id] ??= []).push(d);
  }
  if (!size) return null;
  const dets = [];
  for (const [id, ds] of Object.entries(acc)) {
    const m0 = Math.min(...ds.map(d => d.misfit)), ok = ds.filter(d => d.misfit <= Math.max(1.5 * m0, m0 + .02));
    if (m0 > MAX_MISFIT) continue;
    dets.push({ id: +id, corners: [0, 1, 2, 3].map(k => [0, 1].map(a => ok.reduce((s, d) => s + d.corners[k][a], 0) / ok.length)), seen: ok.length, misfit: m0 });
  }
  const r = solveFieldMap(dets, size[0], size[1], { fovYGuess, mode });
  return r && { ...r, dets };
}

/** Pixel (u, v) -> the point at height y where its ray from the camera meets that horizontal plane, or null. */
export function imageToFloor(cam, u, v, y = 0) {
  const f = cam.focalPx ?? fovToF(cam.fovY, cam.height), P = cam.pose;
  const d = W.app3(P.R, [(u - cam.width / 2) / f, (v - cam.height / 2) / f, 1]);
  if (Math.abs(d[1]) < 1e-12) return null;
  const s = (y - P.t[1]) / d[1];
  return s > 0 ? [P.t[0] + s * d[0], y, P.t[2] + s * d[2]] : null;
}
/** World point -> [u, v, depth] in the camera picture (depth <= 0: behind the camera). */
export function floorToImage(cam, P) {
  const f = cam.focalPx ?? fovToF(cam.fovY, cam.height), p = W.apply(W.invert(cam.pose), P);
  return [f * p[0] / p[2] + cam.width / 2, f * p[1] / p[2] + cam.height / 2, p[2]];
}
