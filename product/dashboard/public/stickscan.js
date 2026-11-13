// Stick scan: the 3D shape of a (natural, mostly brown) stick from phone photos of it lying on the (black and white) mahoujin.
// The phone (Scan button: Android Scan.kt, iOS Scan.swift) sends { type: 'scan', step, n, k, tags, jpg, w, h } packets:
//   step 'stick' a picture of the stick lying on the sheets, its grip (handle) end toward tag T0 (id 0); 'start' / 'done' / 'cancel' around them.
//   stickui.js decodes the pictures and calls buildStick() here on 'done'.
// Method: every picture's camera from the sheets' tags (extrinsics.js solveCamera); per picture a mask of the stick: where the printed
// design (public/mahoujin-design.bin.gz, matched to the real, slightly distorted print) has no ink, whatever is not paper (designMask);
// without the design, what is neither the white paper nor the black print (stickMask); a voxel hull above the floor carved from the masks (coarse,
// then fine near the survivors); its largest blob seen from above turned into a tree (skeleton): the longest path is the stick, the
// parts reaching off it are branches, so a Y-shaped branch stays a Y. Thickness is two numbers: at the grip and at the tip.
// Plain JS, no deps: the page and node tests (test-stickscan.mjs) share it.
import * as W from './world.js';
import { solveCamera } from './extrinsics.js';
import { RUNE, RUNE_IDS } from './runetag.js';

export const SCAN = {
  radius: .6,    // the volume searched: inside this circle round the sheets' centre (the mahoujin paper; a brown floor outside stays out)
  top: .15,      // and 0 < y < top (m): a branched stick rests on its branches, its middle well off the floor
  coarse: .006, fine: .002, // voxel sides, m
  minY: .002,
  branchMin: .03, // skeleton: a part reaching this far past the wood it leaves is a branch (m)
  maxBranches: 24, nodeStep: .015, // the tree's nodes about this far apart (m)
  gap: .025, minPiece: 20, // pieces of the hull this close to the stick join it (a thin branch breaks where a few views miss it); smaller ones (cells) are specks
  minViews: 6,
  miss: .12,     // a voxel stays though this share of the views that see it miss it in their mask (pose / mask errors)
  minSeen: .25,  // and only when this share of all the views judge it (see it against the print)
  colour: .06,   // stickMask: coloured = chroma this much above the picture's usual (the paper's white balance)
  paper: .75, ink: .3, // stickMask: brighter than this x the paper's level is paper, darker than this x is ink (when without colour)
  floorCell: .002, inkTol: 0, darker: .15, solid: .7, // designMask: grid (m); the print's darkest within this many cells (0: the matched print is close enough); the stick is this
                 // much darker; on the tag patches design ink over solid (within one cell) is not judged (designMask)
  minTop: .005,  // skeleton: footprint cells lower than this are the floor misread (a print line), not wood (m)
  // the model's length (and its nodes along it) x this, to correct the scale against sticks of known length. 1: a 116 cm stick that came
  // out 86 cm had lost its ends over the tag patches' dots (now unknown there, not 'no stick'); the real scans now come out 107-118 cm.
  // Set it from a stick measured by hand if they still come out short or long.
  lengthScale: 1,
  alignTile: 40, alignSearch: 12, // floorModel: the print matched to the design in tiles of this many cells, up to this many cells off
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
export function stickMask(img, lv = levels(img)) {
  const Wd = img.width, Ht = img.height, n = Wd * Ht, { lum, chr, paper, cut } = lv;
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

/** A picture's brightness (r + g + b) and colour per pixel, its paper level (most of it is paper) and its colour cut (stickMask). */
function levels(img) {
  const d = img.data, n = img.width * img.height, lum = new Float32Array(n), chr = new Float32Array(n), ls = [], cs = [];
  for (let p = 0; p < n; p++) {
    const r = d[4 * p], g = d[4 * p + 1], b = d[4 * p + 2], l = r + g + b;
    lum[p] = l; chr[p] = (Math.max(r, g, b) - Math.min(r, g, b)) / (l + 30); // +30: dark pixels' colour is mostly noise
    if ((p & 15) === 0) { ls.push(l); cs.push(chr[p]); }
  }
  ls.sort((a, b) => a - b); cs.sort((a, b) => a - b);
  return { lum, chr, paper: ls[Math.floor(.9 * ls.length)], cut: Math.max(.08, cs[cs.length >> 1] + SCAN.colour) };
}

// ---- the printed design: where the mahoujin has ink, a dark stick cannot be told from the print; everywhere else it can ----
/**
 * The design file's bytes, gunzipped (public/mahoujin-design.bin.gz, made by tools/build-mahoujin-design.py from the kit) ->
 * { w, h, cx, cy, r, ink }: 1 mm per pixel, row 0 toward T0, centre (cx, cy), ink 0 paper .. 255 full, r the printed radius (mm).
 */
export function parseDesign(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), w = dv.getUint16(0, true), h = dv.getUint16(2, true);
  if (b.length !== 8 + w * h) throw new Error('mahoujin design: wrong size');
  const cx = dv.getUint16(4, true), cy = dv.getUint16(6, true), ink = b.subarray(8);
  let r2 = 0; for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) if (ink[v * w + u] > 128) r2 = Math.max(r2, (u - cx) ** 2 + (v - cy) ** 2);
  return { w, h, cx, cy, r: Math.sqrt(r2), ink };
}
// The design on the floor (world.js runeTagPos: T0 at -x, T1 clockwise from it seen from above): x = -up, z = -right, in mm x RUNE_SCALE.
const designPx = (D, x, z, s) => [D.cx - z * 1000 / s, D.cy + x * 1000 / s];

/**
 * What the floor should look like, on a grid of SCAN.floorCell: how dark the print is there at most (E: 1 - brightness / the paper's,
 * the darkest within SCAN.inkTol cells), so a pixel clearly darker than that is the stick, even a black one on the paper or a grey line. The real mahoujin is not the design exactly (sheets glued a little off,
 * paper stretched or wrinkled, patches not quite on their tags): the cameras' average view of the floor is matched to the design tile by
 * tile (SCAN.alignTile, up to SCAN.alignSearch off) and the design shifted by the smoothed field before use. Returns { n, g, R, E, shift }.
 */
export function floorModel(vs, D) {
  const { floorCell: g, alignTile: T, alignSearch: S, inkTol } = SCAN, s = W.RUNE_SCALE;
  const R = D.r * s / 1000, n = Math.ceil(2 * R / g), at = i => -R + (i + .5) * g, inside = (i, j) => at(i) ** 2 + at(j) ** 2 < R * R;
  // the design on the grid (i along x, j along z): its mean ink over the cell
  const P = new Float32Array(n * n), k = Math.max(1, Math.round(g * 1000 / s));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [u0, v0] = designPx(D, at(i), at(j), s); let sum = 0, cnt = 0;
    for (let dv = 0; dv < k; dv++) for (let du = 0; du < k; du++) {
      const u = Math.floor(u0 - k / 2 + du + .5), v = Math.floor(v0 - k / 2 + dv + .5);
      if (u >= 0 && v >= 0 && u < D.w && v < D.h) { sum += D.ink[v * D.w + u]; cnt++; }
    }
    P[j * n + i] = cnt ? sum / cnt / 255 : 0;
  }
  // what the cameras saw there: darkness (1 - brightness / the picture's paper level), averaged over the views that see the cell
  const F = new Float32Array(n * n), C = new Uint16Array(n * n);
  for (const v of vs) {
    const { lum, paper } = levels(v.img);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (!inside(i, j)) continue;
      const p = px(v, at(i), 0, at(j)); if (p < 0) continue;
      F[j * n + i] += 1 - Math.min(1, lum[p] / paper); C[j * n + i]++;
    }
  }
  for (let c = 0; c < n * n; c++) if (C[c]) F[c] /= C[c];
  // per tile: the design shift (cells) that best matches F (normalised correlation), searched every 2 cells then refined
  const nt = Math.ceil(n / T), sx = new Float32Array(nt * nt), sz = new Float32Array(nt * nt), ok = new Uint8Array(nt * nt);
  const ncc = (i0, j0, dx, dz) => {
    let n0 = 0, a = 0, b = 0, aa = 0, bb = 0, ab = 0;
    for (let j = j0; j < Math.min(n, j0 + T); j++) for (let i = i0; i < Math.min(n, i0 + T); i++) {
      const c = j * n + i; if (!C[c]) continue;
      const ii = i + dx, jj = j + dz; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const x = F[c], y = P[jj * n + ii]; n0++; a += x; b += y; aa += x * x; bb += y * y; ab += x * y;
    }
    if (n0 < T * T / 3) return { r: -1, vb: 0 };
    const va = aa - a * a / n0, vb = bb - b * b / n0;
    return { r: va > 0 && vb > 0 ? (ab - a * b / n0) / Math.sqrt(va * vb) : -1, vb: vb / n0 };
  };
  for (let tj = 0; tj < nt; tj++) for (let ti = 0; ti < nt; ti++) {
    const i0 = ti * T, j0 = tj * T;
    if (ncc(i0, j0, 0, 0).vb < .005) continue; // no print to match here (blank paper, or outside the circle)
    let best = { r: -1 }, bx = 0, bz = 0;
    for (let dz = -S; dz <= S; dz += 2) for (let dx = -S; dx <= S; dx += 2) { const q = ncc(i0, j0, dx, dz); if (q.r > best.r) { best = q; bx = dx; bz = dz; } }
    for (const [ex, ez] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) { const q = ncc(i0, j0, bx + ex, bz + ez); if (q.r > best.r) { best = q; bx += ex; bz += ez; } }
    if (best.r < .3) continue;
    sx[tj * nt + ti] = bx; sz[tj * nt + ti] = bz; ok[tj * nt + ti] = 1;
  }
  // the field: outliers out (3 x 3 median over the matched tiles), gaps filled from their neighbours, then bilinear between tile centres
  const med = a => { const t = []; for (let tj = 0; tj < nt; tj++) for (let ti = 0; ti < nt; ti++) {
    const v = []; for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) { const q = (tj + b) * nt + ti + c; if (tj + b >= 0 && ti + c >= 0 && tj + b < nt && ti + c < nt && ok[q]) v.push(a[q]); }
    t.push(v.length ? median(v) : 0);
  } return Float32Array.from(t); };
  const mx = med(sx), mz = med(sz), have = Uint8Array.from(ok, (o, q) => o || [-1, 1, -nt, nt].some(d => ok[q + d]) ? 1 : 0);
  for (let pass = 0; pass < 2 * nt && have.includes(0); pass++) {
    const nx = Float32Array.from(mx), nz = Float32Array.from(mz), nh = Uint8Array.from(have);
    for (let q = 0; q < nt * nt; q++) {
      if (have[q]) continue;
      let cx = 0, cz = 0, c = 0; const ti = q % nt;
      for (const d of [-1, 1, -nt, nt]) { const r = q + d; if (r < 0 || r >= nt * nt || (d === -1 && ti === 0) || (d === 1 && ti === nt - 1) || !have[r]) continue; cx += mx[r]; cz += mz[r]; c++; }
      if (c) { nx[q] = cx / c; nz[q] = cz / c; nh[q] = 1; }
    }
    mx.set(nx); mz.set(nz); have.set(nh);
  }
  const field = (a, i, j) => { // bilinear between tile centres
    const u = Math.min(nt - 1, Math.max(0, (i + .5) / T - .5)), w = Math.min(nt - 1, Math.max(0, (j + .5) / T - .5));
    const u0 = Math.floor(u), w0 = Math.floor(w), u1 = Math.min(nt - 1, u0 + 1), w1 = Math.min(nt - 1, w0 + 1), fu = u - u0, fw = w - w0;
    return (a[w0 * nt + u0] * (1 - fu) + a[w0 * nt + u1] * fu) * (1 - fw) + (a[w1 * nt + u0] * (1 - fu) + a[w1 * nt + u1] * fu) * fw;
  };
  // the print where it really is (the design shifted by the field), its darkest within inkTol cells (pose and field errors). E: the
  // darkness to expect, as the cameras see the print on average (F ~ a + b x design ink, least squares). A near, sharp view sees black
  // ink darker than that average. On the tag patches (glued on by hand, a few mm off the poster's own dots, so the field misses them)
  // solid ink (design ink over SCAN.solid within one cell) is not judged (designMask: unknown), or their dots pass for the stick. Elsewhere not: a
  // dense band of letters would hide the stick crossing it. Flat misreads left over: skeleton minTop.
  const Pw = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const ii = Math.round(i + field(mx, i, j)), jj = Math.round(j + field(mz, i, j));
    if (ii >= 0 && jj >= 0 && ii < n && jj < n) Pw[j * n + i] = P[jj * n + ii];
  }
  let sn = 0, sp = 0, sf = 0, spp = 0, spf = 0;
  for (let c = 0; c < n * n; c++) if (C[c]) { sn++; sp += Pw[c]; sf += F[c]; spp += Pw[c] * Pw[c]; spf += Pw[c] * F[c]; }
  const fb = (spf - sp * sf / sn) / (spp - sp * sp / sn || 1), fa = (sf - fb * sp) / sn;
  const E1 = new Float32Array(n * n), E = new Float32Array(n * n), solid = new Uint8Array(n * n);
  const tags = RUNE_IDS.map(W.runeTagPos), patch = (RUNE.sheet / 2 * s) ** 2, onPatch = (i, j) => tags.some(t => (at(i) - t[0]) ** 2 + (at(j) - t[2]) ** 2 < patch);
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    if (!onPatch(i, j)) continue;
    for (let d = 0; d < 9 && !solid[j * n + i]; d++) if (Pw[(j + (d / 3 | 0) - 1) * n + i + d % 3 - 1] > SCAN.solid) solid[j * n + i] = 1;
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let v = 0; for (let d = -inkTol; d <= inkTol; d++) v = Math.max(v, Pw[j * n + Math.min(n - 1, Math.max(0, i + d))]); E1[j * n + i] = v; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let v = 0; for (let d = -inkTol; d <= inkTol; d++) v = Math.max(v, E1[Math.min(n - 1, Math.max(0, j + d)) * n + i]); E[j * n + i] = fa + fb * v; }
  const matched = ok.reduce((a, b) => a + b, 0);
  let worst = 0; for (let q = 0; q < nt * nt; q++) if (ok[q]) worst = Math.max(worst, Math.hypot(mx[q], mz[q]) * g);
  return { n, g, R, E, solid, paper: fa, shift: { tiles: matched, maxMm: +(worst * 1000).toFixed(1), at: (x, z) => { const i = (x + R) / g - .5, j = (z + R) / g - .5; return [field(mx, i, j) * g, field(mz, i, j) * g]; } } };
}

/**
 * stickMask with the design: on the print (a pixel's ray meets the floor inside it) the stick is whatever is clearly darker than the
 * print there (floorModel E), however dark or grey its bark, or coloured where the print is plain paper. Over black ink nothing is
 * taken (the other views see the stick off it). Off the print (the floor round the mahoujin, or above the horizon) 2: unknown, the
 * hull neither keeps nor carves by that view (the carpet looks like bark; taken as wood it kept empty space high near the edge).
 */
export function designMask(v, fm) {
  const { lum, chr, paper, cut } = levels(v.img), { n, g, R, E } = fm, m = new Uint8Array(v.W * v.H);
  const Rt = v.R, O = v.O, Rin = (R - .01) ** 2;
  for (let y = 0; y < v.H; y++) for (let x = 0; x < v.W; x++) {
    const a = (x + .5 - v.cx) / v.f, b = (y + .5 - v.cy) / v.f;
    const p = y * v.W + x, dy = Rt[1] * a + Rt[4] * b + Rt[7]; if (dy >= 0) { m[p] = 2; continue; } // the ray (world) never meets the floor
    const s = -O[1] / dy, X = O[0] + s * (Rt[0] * a + Rt[3] * b + Rt[6]), Z = O[2] + s * (Rt[2] * a + Rt[5] * b + Rt[8]);
    if (X * X + Z * Z > Rin) { m[p] = 2; continue; }
    const i = Math.floor((X + R) / g), j = Math.floor((Z + R) / g);
    if (fm.solid[j * n + i]) { m[p] = 2; continue; } // over a tag patch's dots a dark stick cannot be told from the print: this view does not judge
      // here (it was 'no stick', and a stick laid grip toward T0 lost its end over the dots: 116 cm came out 86)
    const e = E[j * n + i], o = 1 - lum[p] / paper; // expected and seen darkness
    m[p] = o > Math.max(e + SCAN.darker, 1 - SCAN.paper) || (chr[p] > cut && e < fm.paper + SCAN.darker) ? 1 : 0; // colour only where the print is plain paper
  }
  return m;
}

/** Inside the hull at (x, y, z)? The stick in all views that see it there, but a few (pose / mask errors). */
function inHull(vs, ms, x, y, z) {
  const allow = Math.max(1, Math.floor(SCAN.miss * vs.length));
  let seen = 0, out = 0;
  for (let i = 0; i < vs.length; i++) {
    const p = px(vs[i], x, y, z); if (p < 0) continue;
    if (ms[i][p] === 2) continue; // designMask: this view sees only the floor round the print behind it
    seen++; if (!ms[i][p] && ++out > allow) return false;
  }
  // judged by enough views, and missed by few of them (a spot most views see against the carpet is not judged)
  return seen >= Math.max(4, SCAN.minSeen * vs.length) && out <= Math.max(1, SCAN.miss * seen);
}

/**
 * buildStick(views, design?) -> model, or throws an Error saying what is missing.
 * views: { img: { data RGBA, width, height }, cam: viewCamera(...) }. The stick lies on the sheets with its grip end toward tag T0 (id 0).
 * design: parseDesign(...) of the mahoujin's print; with it a stick as dark as the print is found too (designMask), without it stickMask.
 * model: { v: 3, length (m), r: [grip, tip] radius (m), place: [x, z, ax, az] where it lay (its middle and grip -> tip direction, mahoujin frame),
 *          nodes: [[side, along]] (m; along -length/2 at the grip .. +length/2 at the tip,
 *          side across it, lying flat), edges: [[i, j]] node pairs joined by wood, tip: the tip's node (nodes 0..tip are the stick's own
 *          line, grip to tip; the rest are branches), views }
 */
export function buildStick(views, design = null) {
  const vs = views.filter(v => v.cam).map(prep);
  if (vs.length < SCAN.minViews) throw new Error(`棒の写真が足りません（${vs.length} / ${SCAN.minViews}）`);
  const fm = design && floorModel(vs, design), ms = vs.map(v => fm ? designMask(v, fm) : stickMask(v.img));
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
  // every surviving voxel: skeleton() keeps the stick's pieces and drops the specks
  const P = [];
  for (let id = 0; id < keepF.length; id++) if (keepF[id]) { const fk = id % fn, fj = ((id / fn) | 0) % fy, fi = (id / fn / fy) | 0; P.push([-half + (fi + .5) * fine, (fj + .5) * fine, -half + (fk + .5) * fine]); }
  if (P.length < 50) throw new Error('棒が見つかりません（魔法陣の白黒以外のものが写っていない）');
  const m = skeleton(P), k = SCAN.lengthScale;
  if (k !== 1) { m.length = +(m.length * k).toFixed(3); m.nodes = m.nodes.map(([s, a]) => [s, +(a * k).toFixed(4)]); } // along the stick only: the thickness is measured right
  return { ...m, views: vs.length, ...(fm && { printShiftMm: fm.shift.maxMm }) };
}

const smooth = (a, k) => a.map((_, i) => { let s = 0, n = 0; for (let d = -k; d <= k; d++) if (a[i + d] !== undefined) { s += a[i + d]; n++; } return s / n; });
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * The blob as a tree lying on the floor. Its footprint (seen from above) gives the shape: the longest path through it is the stick
 * (grip -> tip, the grip the end nearer tag T0), then each part reaching farther than SCAN.branchMin off what is found so far is a branch.
 * Thickness is two numbers, at the grip and at the tip: the footprint's half width there, or half the height if that is smaller.
 */
function skeleton(P) {
  const { fine, branchMin, maxBranches, nodeStep } = SCAN;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
  const gw = Math.round((x1 - x0) / fine) + 3, gh = Math.round((z1 - z0) / fine) + 3; // a free cell all round
  const cell = p => (Math.round((p[0] - x0) / fine) + 1) + (Math.round((p[2] - z0) / fine) + 1) * gw;
  const xz = c => [x0 + (c % gw - 1) * fine, z0 + (((c / gw) | 0) - 1) * fine];
  const top = new Float32Array(gw * gh); // highest voxel's top, 0 = empty
  for (const p of P) { const c = cell(p); top[c] = Math.max(top[c], p[1] + fine / 2); }
  for (let c = 0; c < top.length; c++) if (top[c] < SCAN.minTop) top[c] = 0;
  const NB = [-1, 1, -gw, gw, -gw - 1, -gw + 1, gw - 1, gw + 1];
  // the footprint's pieces: the biggest is the stick; the others within SCAN.gap of what is kept join it along a bridge, the rest go
  const piece = new Int32Array(gw * gh).fill(-1), size = [];
  for (let c = 0; c < top.length; c++) if (top[c] && piece[c] < 0) {
    const q = [c], k = size.length; piece[c] = k;
    for (let h = 0; h < q.length; h++) for (const d of NB) { const n = q[h] + d; if (top[n] && piece[n] < 0) { piece[n] = k; q.push(n); } }
    size.push(q.length);
  }
  const kept = new Uint8Array(size.length); kept[size.indexOf(Math.max(...size))] = 1;
  for (let more = true; more;) {
    more = false;
    const dist = new Int32Array(gw * gh).fill(-1), from = new Int32Array(gw * gh).fill(-1), q = [];
    for (let c = 0; c < top.length; c++) if (top[c] && kept[piece[c]]) { dist[c] = 0; q.push(c); }
    for (let h = 0; h < q.length && !more; h++) {
      if (dist[q[h]] * fine >= SCAN.gap) break;
      for (const d of NB) {
        const n = q[h] + d; if (n < 0 || n >= top.length || dist[n] >= 0) continue;
        dist[n] = dist[q[h]] + 1; from[n] = q[h];
        if (top[n] && !kept[piece[n]] && size[piece[n]] >= SCAN.minPiece) { // reached a piece: bridge to it
          kept[piece[n]] = 1; for (let c = from[n]; dist[c] > 0; c = from[c]) { top[c] = fine; piece[c] = piece[n]; }
          more = true; break;
        }
        q.push(n);
      }
    }
  }
  for (let c = 0; c < top.length; c++) if (top[c] && !kept[piece[c]]) top[c] = 0;
  // distance to the nearest empty cell (two-pass chamfer, in cells): the half width
  const dt = new Float32Array(gw * gh).map((_, c) => top[c] ? 1e9 : 0), D2 = Math.SQRT2;
  for (let c = gw + 1; c < gw * gh; c++) if (dt[c]) dt[c] = Math.min(dt[c], dt[c - 1] + 1, dt[c - gw] + 1, dt[c - gw - 1] + D2, dt[c - gw + 1] + D2);
  for (let c = gw * gh - gw - 2; c >= 0; c--) if (dt[c]) dt[c] = Math.min(dt[c], dt[c + 1] + 1, dt[c + gw] + 1, dt[c + gw + 1] + D2, dt[c + gw - 1] + D2);
  const bfs = sources => { // steps through the footprint from the sources: farthest cell, and the way back
    const dist = new Int32Array(gw * gh).fill(-1), from = new Int32Array(gw * gh).fill(-1), q = [...sources];
    for (const s of sources) dist[s] = 0;
    for (let h = 0; h < q.length; h++) for (const d of NB) { const n = q[h] + d; if (top[n] && dist[n] < 0) { dist[n] = dist[q[h]] + 1; from[n] = q[h]; q.push(n); } }
    return { far: q[q.length - 1], dist, from };
  };
  const centre = c => { // shortest paths hug the footprint's edge: the cell nearby farthest from it (the ridge) instead
    let best = c; for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) { const n = c + dx + dz * gw; if (n >= 0 && n < dt.length && dt[n] > dt[best]) best = n; }
    return best;
  };
  const trace = (from, c) => { const path = [c]; while (from[c] >= 0) path.push(c = from[c]); return path; }; // c back to its source
  const start = top.findIndex(v => v > 0);
  const ends = bfs([start]), main = bfs([ends.far]), path = trace(main.from, main.far); // the longest path, end to end
  const t0 = W.runeTagPos(0), toT0 = c => { const [x, z] = xz(c); return Math.hypot(x - t0[0], z - t0[2]); };
  if (toT0(path[0]) > toT0(path[path.length - 1])) path.reverse(); // grip first: the stick is laid with its grip end toward tag T0
  // the frame: along the grip -> tip line, side across it
  const G = xz(path[0]), T = xz(path[path.length - 1]), gl = Math.hypot(T[0] - G[0], T[1] - G[1]) || 1;
  const ax = (T[0] - G[0]) / gl, az = (T[1] - G[1]) / gl, sx = -az, sz = ax;
  let s0 = Infinity, s1 = -Infinity;
  for (let c = 0; c < top.length; c++) if (top[c]) { const [x, z] = xz(c), s = x * ax + z * az; s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
  s0 -= fine / 2; s1 += fine / 2;
  const L = s1 - s0, mid = (s0 + s1) / 2, mx = G[0] + ax * (mid - (G[0] * ax + G[1] * az)), mz = G[1] + az * (mid - (G[0] * ax + G[1] * az));
  if (L < .1 || L > 2) throw new Error(`棒の長さが変です（${(L * 100).toFixed(0)} cm）`);
  const local = ([x, z]) => [(x - mx) * sx + (z - mz) * sz, (x - mx) * ax + (z - mz) * az]; // [side, along], m

  const nodes = [], edges = [], on = new Uint8Array(gw * gh);
  /** A path of cells as nodes about nodeStep apart (smoothed: no staircase), joined to node `join` at its first end (-1: none). */
  function addPath(cells, join) {
    for (const c of cells) on[c] = 1;
    const mid = cells.map(centre), xs = smooth(mid.map(c => xz(c)[0]), 3), zs = smooth(mid.map(c => xz(c)[1]), 3), k = Math.max(1, Math.round(nodeStep / fine));
    const idx = cells.map((_, i) => i).filter(i => i % k === 0 || i === cells.length - 1);
    let prev = join;
    for (const i of (join >= 0 ? idx.slice(1) : idx)) {
      nodes.push(local([xs[i], zs[i]]).map(v => +v.toFixed(4)));
      if (prev >= 0) edges.push([prev, nodes.length - 1]);
      prev = nodes.length - 1;
    }
  }
  addPath(path, -1);
  const tip = nodes.length - 1;
  for (let b = 0, tries = 0; b < maxBranches && tries < 4 * maxBranches; tries++) {
    const r = bfs([...on.keys()].filter(c => on[c]));
    if (r.dist[r.far] * fine < branchMin) break;
    const cells = trace(r.from, r.far).reverse(); // from where it leaves the tree out to its end
    // its reach past the wood it leaves (the tree's line runs along one edge, so up to the whole width): too short is a bump, not a branch
    if ((r.dist[r.far] - 2 * dt[centre(cells[0])]) * fine < branchMin) { for (const c of cells) on[c] = 1; continue; }
    b++;
    const [js, ja] = local(xz(cells[0]));
    let join = 0, best = Infinity; nodes.forEach(([s, a], i) => { const d = Math.hypot(s - js, a - ja); if (d < best) { best = d; join = i; } });
    addPath(cells, join);
  }
  // thickness from the path's first and last quarters
  const rad = cs => Math.min(.1, Math.max(fine, median(cs.map(centre).map(c => Math.min(dt[c] * fine, top[c] / 2)))));
  const q = Math.max(1, Math.round(path.length / 4));
  // place: where it lay in the mahoujin's frame (m, y up): its middle (x, z) and its grip -> tip direction (x, z); side = (-az, ax)
  return { v: 3, length: +L.toFixed(3), r: [+rad(path.slice(0, q)).toFixed(4), +rad(path.slice(-q)).toFixed(4)], tip, nodes, edges, voxels: P.length, place: [mx, mz, ax, az].map(v => +v.toFixed(4)) };
}
