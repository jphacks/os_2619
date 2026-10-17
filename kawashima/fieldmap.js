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
// Standing sheets (mount 'stand'): the same pipeline with each sheet upright about a common up, per sheet
// (x, y, z, yaw) and a 90° spin picked at the start (its tag axis closest to image-up); the agreement of the sheets'
// up directions picks the IPPE solutions. Sheets spread in depth or turned to different yaws fix the focal well;
// all in one plane facing the camera is the weak case (same sigma fallback).
import * as W from './world.js';
import { detectTags } from './extrinsics.js';

export const FIELD_IDS = [0, 1, 2, 3];
export const PAIR_IDS = [0, 1]; // mode 2: the A-end and B-end sheets
const OBJ = [[-1, 1], [1, 1], [1, -1], [-1, -1]]; // tag-frame corners, OpenCV / detectTags order
const FOV_SIGMA_MAX = 1.5; // deg
// mode 2: two sheets often leave the focal loosely fixed (sigma 1.5-3°) yet still far closer than a 45° guess, which
// at an oblique view scales the sheet distance with it (tests: 10-30 cm off): keep the fit up to here, with a warning
const FOV_SIGMA_MAX2 = 3.5;
// standing sheets: no hard fallback but a soft prior on the focal (see solveFieldMap); prior residuals are scaled so
// that one sigma counts as PRIOR_PX, the corner noise
const FOV_PRIOR_SIGMA = 15, PRIOR_PX = .3; // deg, px
// standing sheets: equal-height prior, 1 px of misfit per HEIGHT_W⁻¹ m off the common height (σ ≈ 2 cm at 0.3 px noise)
const HEIGHT_W = PRIOR_PX / .02, HEIGHT_SPREAD_MAX = .15; // m
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
function reproj(R, t, f, tags, poses, cornersOf) { // residuals in px, null if a corner is behind the camera
  const r = [];
  tags.forEach((tg, i) => {
    cornersOf(i, poses[i]).forEach((P, k) => {
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
  const cornersOf = (i, [x, z, yaw]) => tagCorners(tags[i].h, x, z, yaw), r = reproj(R, t, f, tags, poses, cornersOf);
  return r && [{ R, t, poses, cornersOf, k: 3, cost: r.reduce((s, v) => s + v * v, 0), spread: best.spread }];
}

// ---- the standing model: per sheet (x, y, z, yaw) upright about the frame's y (up), spin k fixed per sheet ----
// world.js stand convention: yaw 0 faces +z; base axes x = [cos, 0, -sin], y = up, z = normal [sin, 0, cos];
// spin k turns the tag frame k·90° about its normal: x_k = cos(kπ/2) x + sin(kπ/2) y, y_k = -sin(kπ/2) x + cos(kπ/2) y.
// A sheet's up is +y_tag (k 0), +x_tag (k 1), -y_tag (k 2) or -x_tag (k 3).
const SPIN_CS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
function standCorners(h, k, [x, y, z, yaw]) {
  const c = Math.cos(yaw), s = Math.sin(yaw), [ck, sk] = SPIN_CS[k];
  const xb = [c, 0, -s], xk = [ck * xb[0], sk, ck * xb[2]], yk = [-sk * xb[0], ck, -sk * xb[2]];
  return OBJ.map(([ox, oy]) => [x + h * (ox * xk[0] + oy * yk[0]), y + h * (ox * xk[1] + oy * yk[1]), z + h * (ox * xk[2] + oy * yk[2])]);
}
// Initial poses at focal f: both IPPE poses per sheet, each sheet's up = its tag axis closest to image-up (spin),
// the combinations whose ups agree best (all sheets stand on one floor), each sheet turned so its up is the common
// up. The two best combinations are kept: sheets that all face the camera in one plane agree either way, and only
// the joint fit (perspective across the whole spread) tells the two apart.
function initStand(f, tags, g) {
  const cands = tags.map(tg => ippe(tg.Hp, f, tg.obj, tg.uv.map(([u, v]) => [u / f, v / f])).map(p => {
    const ax = [col(p.R, 1), col(p.R, 0), col(p.R, 1).map(v => -v), col(p.R, 0).map(v => -v)];
    const k = ax.reduce((b, a, i) => -a[1] > -ax[b][1] ? i : b, 0); // image-up = -y of the OpenCV camera
    return { ...p, up: ax[k], k };
  }));
  if (cands.some(c => !c.length)) return null;
  const combos = [];
  for (let m = 0; m < 1 << tags.length; m++) {
    const pick = cands.map((c, i) => c[(m >> i) & 1]); if (pick.some(p => !p)) continue;
    const ub = norm(pick.reduce((s, p) => s.map((x, i) => x + p.up[i]), [0, 0, 0]));
    combos.push({ pick, ub, spread: Math.max(...pick.map(p => Math.acos(Math.min(1, dot(p.up, ub))))) });
  }
  // a sheet facing the camera keeps its up under the IPPE flip when the flip is a turn left / right (yaw), so ups only
  // rule out the tilted solutions: among the combinations whose ups agree to within 3° of the best, rank by the
  // reprojection after snapping (each sheet's own perspective then decides its yaw)
  const minSpread = Math.min(...combos.map(c => c.spread)), out = [];
  for (const { pick, ub, spread } of combos.filter(c => c.spread <= minSpread + 3 * DEG)) {
    const snapped = pick.map(p => ({ R: W.mul3(rotBetween(p.up, ub), p.R), t: p.t, k: p.k }));
    const ng = col(snapped[g].R, 2), Z = norm(ng.map((v, i) => v - dot(ng, ub) * ub[i])), R = W.fromCols(cross(ub, Z), ub, Z), Rt = W.tr3(R), t = snapped[g].t;
    const poses = snapped.map(p => {
      const c = W.app3(Rt, p.t.map((v, i) => v - t[i])), n = W.app3(Rt, col(p.R, 2));
      return [c[0], c[1], c[2], Math.atan2(n[0], n[2])];
    });
    const spins = snapped.map(p => p.k), cornersOf = (i, q) => standCorners(tags[i].h, spins[i], q), r = reproj(R, t, f, tags, poses, cornersOf);
    if (r) out.push({ R, t, poses, cornersOf, spins, k: 4, cost: r.reduce((s, v) => s + v * v, 0), spread });
  }
  return out.length ? out.sort((a, b) => a.cost - b.cost).slice(0, 2) : null;
}

// LM over [log f?, rotation increment 3, translation 3, the pose (init.k numbers) of every tag but g]. Numeric
// central Jacobian.
function refine(init, f0, tags, g, fitF) {
  const o = fitF ? 1 : 0, K = init.k, free = tags.map((_, i) => i).filter(i => i !== g);
  const unpack = p => {
    const f = fitF ? f0 * Math.exp(p[0]) : f0, R = W.mul3(W.fromRodrigues(p.slice(o, o + 3)), init.R);
    const t = init.t.map((v, i) => v + p[o + 3 + i]), poses = init.poses.map(q => [...q]);
    free.forEach((i, k) => { poses[i] = p.slice(o + 6 + K * k, o + 6 + K * (k + 1)); });
    poses[g] = Array(K).fill(0);
    return { f, R, t, poses };
  };
  const resid = p => { // reprojection, then the optional prior's residuals (init.prior(poses), already in px units)
    const m = unpack(p), r = reproj(m.R, m.t, m.f, tags, m.poses, init.cornersOf);
    return r && init.prior ? r.concat(init.prior(m.poses, m.f)) : r;
  };
  const nR = 8 * tags.length, done = (p, c, JtJ, r) => { const rr = r.slice(0, nR); return { ...unpack(p), cost: rr.reduce((s, v) => s + v * v, 0), total: c, JtJ, n: nR }; };
  const cost = r => r ? r.reduce((s, v) => s + v * v, 0) : Infinity;
  let p = [...(fitF ? [0] : []), 0, 0, 0, 0, 0, 0, ...free.flatMap(i => init.poses[i])];
  const eps = p.map((_, k) => k < o ? 1e-6 : k < o + 3 ? 1e-7 : 1e-7);
  let r = resid(p), c = cost(r), lam = 1e-3, JtJ = null;
  for (let it = 0; it < 60 && isFinite(c); it++) {
    const J = [];
    for (let k = 0; k < p.length; k++) {
      const a = [...p], b = [...p]; a[k] += eps[k]; b[k] -= eps[k];
      const ra = resid(a), rb = resid(b); if (!ra || !rb) return done(p, c, JtJ, r);
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
  return done(p, c, JtJ, r);
}

/**
 * solveFieldMap(dets, width, height, { fovYGuess, mode, mount, tagHeight }) -> null or { cam, tags, poly, fovY, reprojErrPx, ids, warnings }.
 * dets: [{ id, corners: [[u,v] x4] }] in OpenCV corner order (detectTags / calibrateCamera).
 * mode 4 (default): needs >= 3 of ids 0-3, the sheets are the field's corners.
 * mode 2: uses only ids 0 and 1 (both needed), which mark the A end (further left in the picture) and the B end:
 *   origin at their midpoint, +x from A's sheet to B's; poly = a rectangle whose x = ±L/2 edges pass through the
 *   two centres (L = their distance), depth D = clamp(0.6 L, 1.5, 3) m centred on z = 0. The focal is fitted the
 *   same way (two coplanar sheets still constrain the floor homography), only less firmly: more face-on fallbacks.
 * cam: calibrateCamera's shape ({ pose: world_T_cam, OpenCV cam frame, fovY, focalPx, width, height, ids,
 *      reprojErrPx, focalFitted, fovSigma }), so toThreeCamera / projectWorld work on it.
 * mount 'floor' (default): sheets lying face up. tags: { id: { pos: [x, 0, z], yaw } } (worldTagPose floor convention).
 * mount 'stand': sheets taped upright (normal horizontal), facing anywhere, each possibly turned by 90° steps on its
 *   stand. The floor is not seen: every sheet centre is assumed tagHeight above it (y = 0 at their mean height minus
 *   tagHeight; heightSpread reported, warned over 0.15 m). tags: { id: { pos: [x, y, z] (sheet centre), yaw (0 =
 *   facing +z), spin (0-3, tag frame turned spin·90° about its normal), stand: true } } (worldTagPose stand
 *   convention). poly / A side / 2-sheet rectangle as for the floor, from the sheets' floor footprints (x, z).
 * Either result goes straight to setField({ poly, tags }).
 * poly: the tag centres (mode 4) [[x, z] x N] counter-clockwise seen from above (y toward the viewer): +x, then -z, -x, +z.
 */
export function solveFieldMap(dets, width, height, { fovYGuess = 45, mode = 4, mount = 'floor', tagHeight = 1.0 } = {}) {
  const warnings = [], seen = new Set(), use = mode === 2 ? PAIR_IDS : FIELD_IDS, stand = mount === 'stand';
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
  const initFn = stand ? initStand : initAt;

  // focal sweep (log-spaced fov 12..100°), then LM from the best local minima of the sweep score
  const sweep = [];
  for (let fov = 12; fov <= 100; fov *= 1.04) {
    const f = fovToF(fov, height), s = initFn(f, tags, g);
    if (s) sweep.push({ f, inits: s, cost: Math.min(...s.map(q => q.cost)) });
  }
  if (!sweep.length) return null;
  const minima = sweep.filter((s, i) => (!sweep[i - 1] || s.cost <= sweep[i - 1].cost) && (!sweep[i + 1] || s.cost <= sweep[i + 1].cost))
    .sort((a, b) => a.cost - b.cost).slice(0, 3);
  const fitAll = (cands, fitF) => cands.map(({ f, s }) => ({ ...refine(s, f, tags, g, fitF), spread: s.spread, spins: s.spins, cornersOf: s.cornersOf }))
    .sort((a, b) => a.total - b.total);
  const fitBest = (cands, fitF) => fitAll(cands, fitF)[0];
  const free = fitAll(minima.flatMap(m => m.inits.map(s => ({ f: m.f, s }))), true);
  let best = free[0];
  // standing: one sheet alone fixes its depth only through its own size (∝ f), so free sheets barely constrain the
  // focal, and unlike the floor a wrong focal distorts the layout badly (a hard 45° fallback put sheets 0.3-2 m off
  // in tests). So refit with priors: (a) the sheets are taped at one height (tagHeight): when the free fit agrees
  // (spread < HEIGHT_SPREAD_MAX), the centres lie on one horizontal plane, which pins the focal like the floor does;
  // (b) a weak prior fovYGuess ± FOV_PRIOR_SIGMA, which only matters when the view leaves the focal loose.
  const heights = b => b.poses.map(q => q[1]), spreadOf = ys => Math.max(...ys) - Math.min(...ys);
  const freeSpread = stand ? spreadOf(heights(best)) : 0, usePrior = stand && freeSpread < HEIGHT_SPREAD_MAX;
  if (stand) {
    const fg = fovToF(fovYGuess, height), sLn = FOV_PRIOR_SIGMA * DEG / Math.sin(fovYGuess * DEG); // σ of ln f
    const prior = (ps, ff) => {
      const m = ps.reduce((s, q) => s + q[1], 0) / ps.length;
      return [...(usePrior ? ps.map(q => (q[1] - m) * HEIGHT_W) : []), Math.log(ff / fg) / sLn * PRIOR_PX];
    };
    // from every free fit, not just the best: under the priors another basin may win
    best = fitBest(free.map(b => ({ f: b.f, s: { R: b.R, t: b.t, poses: b.poses, cornersOf: b.cornersOf, spins: b.spins, k: 4, spread: b.spread, prior } })), true);
    // a small sheet seen near face-on has two yaws (IPPE's turn left / right) that fit almost equally, and LM cannot
    // cross between them: try each sheet mirrored about its line of sight, keep what lowers the total cost
    for (let i = 0; i < tags.length; i++) {
      const b = best, C = W.app3(W.tr3(b.R), b.t).map(v => -v), poses = b.poses.map(q => [...q]);
      poses[i][3] = 2 * Math.atan2(C[0] - poses[i][0], C[2] - poses[i][2]) - poses[i][3];
      let R = b.R;
      if (i === g) { // re-gauge: turn the frame about up so the mirrored gauge sheet has yaw 0 again
        const a = poses[g][3], c = Math.cos(a), sn = Math.sin(a);
        for (const q of poses) { const [x, z] = [q[0], q[2]]; q[0] = c * x - sn * z; q[2] = sn * x + c * z; q[3] -= a; }
        R = W.mul3(b.R, [c, 0, sn, 0, 1, 0, -sn, 0, c]);
      }
      const r = fitBest([{ f: b.f, s: { R, t: b.t, poses, cornersOf: b.cornersOf, spins: b.spins, k: 4, spread: b.spread, prior } }], true);
      if (r.total < b.total) best = r;
    }
  }

  // focal pinned down? 1-sigma of the fov from the LM normal matrix (corner noise >= 0.2 px)
  const sPx = Math.max(.2, Math.sqrt(best.cost / best.n));
  const colF = best.JtJ && solve(best.JtJ, best.JtJ.map((_, i) => +(i === 0)));
  const sLogF = colF ? Math.sqrt(Math.max(0, colF[0])) * sPx : Infinity;
  let fovSigma = Math.abs(fToFov(best.f * Math.exp(-sLogF), height) - fToFov(best.f, height)), focalFitted = true;
  const fovFit = fToFov(best.f, height);
  if (stand) { if (fovSigma >= FOV_SIGMA_MAX) warnings.push(`focal only loosely fixed by the standing sheets: fov ${fovFit.toFixed(1)} ± ${fovSigma.toFixed(1)}° (pulled toward fovYGuess ${fovYGuess}°)`); }
  else if (fovSigma >= FOV_SIGMA_MAX && fovSigma < FOV_SIGMA_MAX2 && mode === 2 && fovFit >= 12 && fovFit <= 100)
    warnings.push(`focal only loosely fixed by two sheets: fov ${fovFit.toFixed(1)} ± ${fovSigma.toFixed(1)}°`);
  else if (!(fovSigma < FOV_SIGMA_MAX) || fovFit < 12 || fovFit > 100) {
    const f = fovToF(fovYGuess, height), s = initFn(f, tags, g);
    if (!s) return null;
    best = fitBest(s.map(q => ({ f, s: q })), false); focalFitted = false;
    warnings.push(`focal not measurable from this view (floor seen nearly face-on, fov ${fovFit.toFixed(1)} ± ${fovSigma.toFixed(1)}°): using fovYGuess ${fovYGuess}°`);
  }
  const reprojErrPx = Math.sqrt(best.cost / (best.n / 2)); // RMS per corner, as calibrateCamera reports it
  if (reprojErrPx > 2) warnings.push(`large reprojection error ${reprojErrPx.toFixed(1)} px: a sheet moved, is not ${stand ? 'upright' : 'flat'}, or was misdetected`);
  if (best.spread > 20 * DEG) warnings.push(`sheet ${stand ? 'up directions' : 'normals'} disagreed by up to ${(best.spread / DEG).toFixed(0)}° before the joint fit`);

  // standing: the floor is not seen; every sheet centre is taken to be tagHeight above it
  let floorY = 0;
  if (stand) {
    const ys = heights(best), spread = usePrior ? freeSpread : spreadOf(ys); // the prior squeezes them: report the free fit's
    floorY = ys.reduce((s, v) => s + v, 0) / ys.length - tagHeight;
    best.heightSpread = spread;
    if (spread > .15) warnings.push(`タグの高さがそろっていない: sheet centres differ by ${spread.toFixed(2)} m in height (each should be ${tagHeight.toFixed(2)} m above the floor)`);
  }

  // ---- world frame (setField convention) ----
  const flT = W.invert({ R: best.R, t: best.t }); // floor_T_cam
  if (!stand && flT.t[1] <= 0) return null; // the camera must be above the floor it sees (tags face it, so this holds)
  if (stand && flT.t[1] <= floorY) warnings.push('the camera comes out below the floor: check tagHeight');
  const C = best.poses.map(q => stand ? [q[0], q[2]] : [q[0], q[1]]); // floor footprints
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
  const fl_T_world = W.pose(W.fromCols([dir[0], 0, dir[1]], [0, 1, 0], [-dir[1], 0, dir[0]]), [org[0], floorY, org[1]]);
  const world_T_fl = W.invert(fl_T_world), world_T_cam = W.compose(world_T_fl, flT);
  const toW = ([x, z]) => { const p = W.apply(world_T_fl, [x, floorY, z]); return [p[0], p[2]]; };
  const out = {};
  tags.forEach((t, i) => {
    const q = best.poses[i];
    if (stand) {
      const P = W.apply(world_T_fl, q.slice(0, 3)), n = W.app3(world_T_fl.R, [Math.sin(q[3]), 0, Math.cos(q[3])]);
      out[t.id] = { pos: P, yaw: Math.atan2(n[0], n[2]), spin: best.spins[i], stand: true };
    } else {
      const [x, z, yaw] = q, [X, Z] = toW([x, z]), xw = W.app3(world_T_fl.R, [Math.cos(yaw), 0, -Math.sin(yaw)]);
      out[t.id] = { pos: [X, 0, Z], yaw: Math.atan2(-xw[2], xw[0]) };
    }
  });
  const ids = tags.map(t => t.id), fovY = fToFov(best.f, height);
  const cam = { pose: world_T_cam, fovY, focalPx: best.f, width, height, ids, reprojErrPx, focalFitted, fovSigma: focalFitted ? fovSigma : null };
  let poly = order.map(i => toW(C[i]));
  if (tags.length === 2) { // A and B ends: the rectangle between them, same winding as above
    const L = Math.hypot(C[1][0] - C[0][0], C[1][1] - C[0][1]), x = L / 2, z = Math.min(3, Math.max(1.5, .6 * L)) / 2;
    poly = [[x, -z], [-x, -z], [-x, z], [x, z]];
  }
  const res = { cam, tags: out, poly, fovY, reprojErrPx, ids, warnings };
  if (stand) res.heightSpread = best.heightSpread;
  return res;
}

/**
 * scanField(videoOrCanvas, { fovYGuess, mode, mount, tagHeight, frames, intervalMs }) -> Promise of solveFieldMap's result (plus dets) or null.
 * Like calibrateCamera: `frames` frames `intervalMs` apart (tripod), each tag's corners averaged over the frames it
 * fit the pattern well in, so someone walking past a sheet for a moment does not lose it.
 */
const MAX_MISFIT = .15;
export async function scanField(videoOrCanvas, { fovYGuess = 45, mode = 4, mount = 'floor', tagHeight = 1.0, frames = 5, intervalMs = 150 } = {}) {
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
  const r = solveFieldMap(dets, size[0], size[1], { fovYGuess, mode, mount, tagHeight });
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
