// The shape of a branch photographed on a plain background (floor, table, paper), from its RGBA pixels. Pure: runs in node too.
// Steps (the usual binary-shape pipeline): background colour from the border → per-pixel colour distance → Otsu threshold →
// largest 8-connected component, small holes filled → Zhang-Suen thinning → spur pruning (Gonzalez & Woods: erode the
// end points L times, regrow from what is left) → end / branch points by crossing number, the longest path, width.
const LONG = 256;

export function analyzeStick({ data, width, height }) {
  // box-downscale to <= LONG px on the long side
  const k = Math.max(1, Math.ceil(Math.max(width, height) / LONG)), W = Math.floor(width / k), H = Math.floor(height / k), N = W * H;
  const rgb = new Float32Array(N * 3);
  for (let y = 0; y < H * k; y++) for (let x = 0; x < W * k; x++) {
    const s = (y * width + x) * 4, d = (Math.floor(y / k) * W + Math.floor(x / k)) * 3;
    for (let c = 0; c < 3; c++) rgb[d + c] += data[s + c] / (k * k);
  }
  // background = median colour of the border
  const border = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) border.push(y * W, y * W + W - 1);
  const bg = [0, 1, 2].map(c => { const v = border.map(i => rgb[i * 3 + c]).sort((a, b) => a - b); return v[v.length >> 1]; });
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) dist[i] = Math.hypot(rgb[i * 3] - bg[0], rgb[i * 3 + 1] - bg[1], rgb[i * 3 + 2] - bg[2]);
  const th = Math.max(25, otsu(dist)); // never below 25: a nearly empty photo must not turn its noise into a stick
  let mask = new Uint8Array(N); for (let i = 0; i < N; i++) mask[i] = dist[i] > th;
  mask = largest(mask, W, H);
  fillHoles(mask, W, H, N / 200);
  let area = 0; for (const v of mask) area += v;
  const sk = prune(thin(mask, W, H), W, H, 8);

  let skLen = 0, ends = 0; const junc = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (sk[i]) { skLen++; const t = kind(sk, W, H, i); if (t === 1) ends++; else if (t === 3) junc[i] = 1; }
  const branches = components(junc, W, H); // touching junction pixels are one branch point
  const main = longestPath(sk, W, H);
  const thickness = area / Math.max(1, skLen);
  const features = {
    branches, ends,
    tortuosity: +(main.len / Math.max(1, main.chord)).toFixed(3),
    aspect: +(main.len / Math.max(1, thickness)).toFixed(2),
    thickness: +thickness.toFixed(2), length: +main.len.toFixed(1), coverage: +(area / N).toFixed(4),
  };
  return { features, shapeScore: shapeScore(features) };
}

const c01 = x => Math.max(0, Math.min(1, x));
/** 0..1 "how cool": forks first, then bends, slenderness, extra tips. Recomputed by the server from the features. */
export const shapeScore = f => +c01(.45 * c01(f.branches / 2) + .25 * c01((f.tortuosity - 1) / .5) + .2 * c01((f.aspect - 6) / 24) + .1 * c01((f.ends - 2) / 3)).toFixed(3);

/** Short Japanese reasons for the rarity, from the features. */
export function stickReasons(f) {
  return [
    f.branches ? `枝分かれ ${f.branches}` : '枝分かれ なし',
    f.tortuosity > 1.3 ? '曲がり 強め' : f.tortuosity > 1.1 ? '曲がり 少し' : 'まっすぐ',
    f.aspect > 20 ? '細長い' : f.aspect < 8 ? '太め' : null,
  ].filter(Boolean);
}

function otsu(v) {
  const hist = new Float64Array(256), max = 442;
  for (const x of v) hist[Math.min(255, Math.floor(x / max * 256))]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, at = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = v.length - wB; if (!wF) break;
    sB += t * hist[t];
    const between = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (between > best) { best = between; at = t; }
  }
  return (at + 1) * max / 256;
}

const N8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // P2..P9, clockwise from north
const nb = (m, W, H, i) => N8.map(([dx, dy]) => { const x = i % W + dx, y = (i / W | 0) + dy; return x >= 0 && y >= 0 && x < W && y < H ? m[y * W + x] : 0; });
// 1 = end point, 3 = branch point, 2 = on a line (crossing number: 0→1 steps around the 8 neighbours)
function kind(m, W, H, i) {
  const p = nb(m, W, H, i); let cn = 0, n = 0;
  for (let j = 0; j < 8; j++) { n += p[j]; if (!p[j] && p[(j + 1) % 8]) cn++; }
  return n <= 1 || cn === 1 ? 1 : cn >= 3 ? 3 : 2;
}

// flood fill labels; conn 8 or 4. Returns label array and sizes.
function label(m, W, H, conn = 8) {
  const lab = new Int32Array(W * H).fill(-1), sizes = [], q = new Int32Array(W * H), steps = conn === 8 ? N8 : [N8[0], N8[2], N8[4], N8[6]];
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const id = sizes.length; let h = 0, t = 0; q[t++] = s; lab[s] = id;
    while (h < t) {
      const i = q[h++], x = i % W, y = i / W | 0;
      for (const [dx, dy] of steps) { const X = x + dx, Y = y + dy, j = Y * W + X; if (X >= 0 && Y >= 0 && X < W && Y < H && m[j] && lab[j] < 0) { lab[j] = id; q[t++] = j; } }
    }
    sizes.push(t);
  }
  return { lab, sizes };
}
const components = (m, W, H) => label(m, W, H).sizes.length;
function largest(m, W, H) {
  const { lab, sizes } = label(m, W, H); if (!sizes.length) return m;
  const big = sizes.indexOf(Math.max(...sizes)), out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = lab[i] === big;
  return out;
}
// background pockets that don't touch the border and are small (bark texture, glare) become stick
function fillHoles(m, W, H, maxSize) {
  const inv = m.map(v => 1 - v), { lab, sizes } = label(inv, W, H, 4), edge = new Set();
  for (let x = 0; x < W; x++) edge.add(lab[x]).add(lab[(H - 1) * W + x]);
  for (let y = 0; y < H; y++) edge.add(lab[y * W]).add(lab[y * W + W - 1]);
  for (let i = 0; i < m.length; i++) if (lab[i] >= 0 && !edge.has(lab[i]) && sizes[lab[i]] < maxSize) m[i] = 1;
}

// Zhang & Suen (1984) thinning
function thin(src, W, H) {
  const m = src.slice();
  for (let changed = true; changed;) {
    changed = false;
    for (const step of [0, 1]) {
      const del = [];
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue;
        const p = nb(m, W, H, i), n = p.reduce((a, b) => a + b);
        let a = 0; for (let j = 0; j < 8; j++) if (!p[j] && p[(j + 1) % 8]) a++;
        const [p2, , p4, , p6, , p8] = p;
        if (n < 2 || n > 6 || a !== 1) continue;
        if (step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        del.push(i);
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  return m;
}

// spurs shorter than L px go; the main branches' tips are regrown inside the original skeleton
function prune(sk, W, H, L) {
  let m = sk.slice();
  for (let n = 0; n < L; n++) { const e = []; for (let i = 0; i < m.length; i++) if (m[i] && kind(m, W, H, i) === 1) e.push(i); for (const i of e) m[i] = 0; }
  let front = []; for (let i = 0; i < m.length; i++) if (m[i] && kind(m, W, H, i) === 1) front.push(i);
  for (let n = 0; n < L && front.length; n++) {
    const next = [];
    for (const i of front) for (const [dx, dy] of N8) {
      const x = i % W + dx, y = (i / W | 0) + dy, j = y * W + x;
      if (x >= 0 && y >= 0 && x < W && y < H && sk[j] && !m[j]) { m[j] = 1; next.push(j); }
    }
    front = next;
  }
  return m;
}

// the skeleton's longest path (two BFS), its length in px (diagonal steps √2) and the straight distance between its ends
function longestPath(m, W, H) {
  const start = m.indexOf(1); if (start < 0) return { len: 0, chord: 0 };
  const bfs = s => {
    const par = new Int32Array(m.length).fill(-2), q = [s]; par[s] = -1; let last = s;
    for (let h = 0; h < q.length; h++) {
      const i = q[h]; last = i;
      for (const [dx, dy] of N8) { const x = i % W + dx, y = (i / W | 0) + dy, j = y * W + x; if (x >= 0 && y >= 0 && x < W && y < H && m[j] && par[j] === -2) { par[j] = i; q.push(j); } }
    }
    return { last, par };
  };
  const a = bfs(start).last, { last: b, par } = bfs(a);
  let len = 0; for (let i = b; par[i] >= 0; i = par[i]) len += Math.hypot(i % W - par[i] % W, (i / W | 0) - (par[i] / W | 0));
  return { len, chord: Math.hypot(a % W - b % W, (a / W | 0) - (b / W | 0)) };
}
