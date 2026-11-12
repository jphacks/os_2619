// Stick scan: the 3D shape of a (natural, mostly brown) stick from phone photos of it lying on the (black and white) mahoujin.
// The phone (Scan button: Android Scan.kt, iOS Scan.swift) sends { type: 'scan', step, n, k, tags, jpg, w, h } packets:
//   step 'stick' a picture of the stick lying on the sheets, tip toward T0 / -z; 'start' / 'done' / 'cancel' around them.
//   stickui.js decodes the pictures and calls buildStick() here on 'done'.
// Method: every picture's camera from the sheets' tags (extrinsics.js solveCamera); per picture a mask of what is neither the white paper
// nor the black print (stickMask); a voxel hull above the floor carved from the masks (coarse,
// then fine near the survivors); its largest blob seen from above turned into a tree (skeleton): the longest path is the stick, the
// parts reaching off it are branches, so a Y-shaped branch stays a Y. Thickness is two numbers: at the grip and at the tip.
// Plain JS, no deps: the page and node tests (test-stickscan.mjs) share it.
import * as W from './world.js';
import { solveCamera } from './extrinsics.js';

export const SCAN = {
  radius: .6,    // the volume searched: inside this circle round the sheets' centre (the mahoujin paper; a brown floor outside stays out)
  top: .07,      // and 0 < y < top (m)
  coarse: .006, fine: .002, // voxel sides, m
  minY: .002,
  branchMin: .03, // skeleton: a part reaching this far past the wood it leaves is a branch (m)
  maxBranches: 24, nodeStep: .015, // the tree's nodes about this far apart (m)
  gap: .025, minPiece: 20, // pieces of the hull this close to the stick join it (a thin branch breaks where a few views miss it); smaller ones (cells) are specks
  minViews: 6,
  miss: .12,     // a voxel stays though this share of the views that see it miss it in their mask (pose / mask errors)
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
  const allow = Math.max(1, Math.floor(SCAN.miss * vs.length));
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
 * model: { v: 3, length (m), r: [grip, tip] radius (m), nodes: [[side, along]] (m; along -length/2 at the grip .. +length/2 at the tip,
 *          side across it, lying flat), edges: [[i, j]] node pairs joined by wood, tip: the tip's node (nodes 0..tip are the stick's own
 *          line, grip to tip; the rest are branches), views }
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
  // every surviving voxel: skeleton() keeps the stick's pieces and drops the specks
  const P = [];
  for (let id = 0; id < keepF.length; id++) if (keepF[id]) { const fk = id % fn, fj = ((id / fn) | 0) % fy, fi = (id / fn / fy) | 0; P.push([-half + (fi + .5) * fine, (fj + .5) * fine, -half + (fk + .5) * fine]); }
  if (P.length < 50) throw new Error('棒が見つかりません（魔法陣の白黒以外のものが写っていない）');
  return { ...skeleton(P), views: vs.length };
}

const smooth = (a, k) => a.map((_, i) => { let s = 0, n = 0; for (let d = -k; d <= k; d++) if (a[i + d] !== undefined) { s += a[i + d]; n++; } return s / n; });
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * The blob as a tree lying on the floor. Its footprint (seen from above) gives the shape: the longest path through it is the stick
 * (grip -> tip, the tip toward T0 / -z), then each part reaching farther than SCAN.branchMin off what is found so far is a branch.
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
  const zOf = c => xz(c)[1];
  if (zOf(path[0]) < zOf(path[path.length - 1])) path.reverse(); // grip first; the tip lies toward -z
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
  return { v: 3, length: +L.toFixed(3), r: [+rad(path.slice(0, q)).toFixed(4), +rad(path.slice(-q)).toFixed(4)], tip, nodes, edges, voxels: P.length };
}
