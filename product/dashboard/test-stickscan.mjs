// Stick scan (public/stickscan.js) on synthetic pictures: a printed floor pattern, a 0.9 m stick (r 12 mm, brown with a red band
// near the tip) lying on it tip toward -z, with its shadow, from many angles; noise and exposure differ per picture.
// Checks the cameras from the mahoujin's tag corners, and the model's length, radius, colours and which end is the tip.   node test-stickscan.mjs
process.env.MARKER = 'rune';
const W = await import('./public/world.js'), { buildStick, viewCamera } = await import('./public/stickscan.js');
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const IW = 360, IH = 480, F = 400; // portrait, ~62° vertical like a phone
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function camAt(az, el, dist, target = [0, 0, 0]) {
  const O = [target[0] + dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), target[2] + dist * Math.cos(el) * Math.cos(az)];
  const z = norm(target.map((v, i) => v - O[i])), x = norm(cross(z, [0, 1, 0])), y = cross(z, x);
  return { pose: W.pose(W.fromCols(x, y, z), O), f: F, w: IW, h: IH };
}
// the floor: white paper with black rings and spokes (like the mahoujin's lines) on a grey floor
function floorRGB(x, z) {
  const r = Math.hypot(x, z), a = Math.atan2(z, x);
  if (r > .62) return [110, 105, 100];
  const line = [.15, .3, .45, .58].some(R => Math.abs(r - R) < .004) || (r > .15 && Math.abs(((a / (2 * Math.PI) * 12) % 1 + 1) % 1 - .5) * r * 2 * Math.PI / 12 < .0025);
  return line ? [30, 30, 35] : [235, 232, 225];
}
const STICK = { a: [.05, .45], b: [-.05, -.45], r: .012 }; // grip end a (+z), tip b (-z)
const SL = Math.hypot(STICK.b[0] - STICK.a[0], STICK.b[1] - STICK.a[1]);
const SD = [(STICK.b[0] - STICK.a[0]) / SL, 0, (STICK.b[1] - STICK.a[1]) / SL];
const LIGHT = norm([.4, 1, .3]);
function stickColour(u) { return u > .7 && u < .8 ? [200, 40, 40] : [150, 100, 60]; }
/** Ray O + s d against the stick (an infinite cylinder clipped to its length; ends ignored): { s, n, u } or null. */
function hitStick(O, d) {
  const C = [STICK.a[0], STICK.r, STICK.a[1]], w = O.map((v, i) => v - C[i]);
  const dd = d[0] * SD[0] + d[2] * SD[2], wd = w[0] * SD[0] + w[1] * SD[1] + w[2] * SD[2];
  const dp = d.map((v, i) => v - dd * SD[i]), wp = w.map((v, i) => v - wd * SD[i]);
  const A = dp[0] ** 2 + dp[1] ** 2 + dp[2] ** 2, B = 2 * (dp[0] * wp[0] + dp[1] * wp[1] + dp[2] * wp[2]), Cc = wp[0] ** 2 + wp[1] ** 2 + wp[2] ** 2 - STICK.r ** 2;
  const disc = B * B - 4 * A * Cc; if (disc < 0 || A < 1e-12) return null;
  const s = (-B - Math.sqrt(disc)) / (2 * A); if (s <= 0) return null;
  const P = O.map((v, i) => v + s * d[i]), t = (P[0] - C[0]) * SD[0] + (P[2] - C[2]) * SD[2];
  if (t < 0 || t > SL) return null;
  const n = norm([P[0] - C[0] - t * SD[0], P[1] - C[1], P[2] - C[2] - t * SD[2]]);
  return { s, n, u: t / SL };
}
function render(cam, withStick) {
  const data = new Uint8ClampedArray(IW * IH * 4), R = cam.pose.R, O = cam.pose.t, gain = .85 + .3 * rnd();
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
    const a = (x + .5 - IW / 2) / F, b = (y + .5 - IH / 2) / F;
    const d = norm([R[0] * a + R[1] * b + R[2], R[3] * a + R[4] * b + R[5], R[6] * a + R[7] * b + R[8]]);
    let c = [60, 60, 60];
    const h = withStick && hitStick(O, d);
    if (h) { const sh = .45 + .55 * Math.max(0, h.n[0] * LIGHT[0] + h.n[1] * LIGHT[1] + h.n[2] * LIGHT[2]); c = stickColour(h.u).map(v => v * sh); }
    else if (d[1] < 0) {
      const s = -O[1] / d[1], P = [O[0] + s * d[0], 0, O[2] + s * d[2]];
      c = floorRGB(P[0], P[2]);
      if (withStick && hitStick(P, LIGHT)) c = c.map(v => v * .6); // its shadow
    }
    const p = 4 * (y * IW + x);
    for (let k = 0; k < 3; k++) data[p + k] = c[k] * gain + (rnd() - .5) * 8;
    data[p + 3] = 255;
  }
  return { data, width: IW, height: IH };
}
/** The tag packet the phone would send for this camera: every mahoujin tag in view, corners 0..1. */
function tagsSeen(cam) {
  const T = W.invert(cam.pose), out = [];
  for (const id of W.CORNER_IDS) {
    const tp = W.worldTagPose(id), h = W.TAGS[id].size / 2;
    const c = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([ox, oy]) => { const p = W.apply(T, W.apply(tp, [ox * h, oy * h, 0])); return p[2] > 0 ? [(F * p[0] / p[2] + IW / 2) / IW, (F * p[1] / p[2] + IH / 2) / IH] : null; });
    if (c.every(q => q && q[0] > 0 && q[0] < 1 && q[1] > 0 && q[1] < 1)) out.push({ id, c: c.map(q => q.map(v => v + (rnd() - .5) * .0015)) }); // ~0.5 px noise
  }
  return out;
}
const K = [F / IW, F / IH, .5, .5];

// cameras from the tags
let worst = 0, n = 0;
const mkView = (az, el, dist, withStick) => {
  const truth = camAt(az, el, dist), tags = tagsSeen(truth), cam = viewCamera(tags, K, IW, IH);
  if (cam) { worst = Math.max(worst, Math.hypot(...cam.pose.t.map((v, i) => v - truth.pose.t[i]))); n++; }
  return { img: render(truth, withStick), cam };
};
const t0 = Date.now();
const bg = [0, 1.3, 2.6, 3.9, 5.2].map((az, i) => mkView(az, .9 + .1 * (i % 2), 1.1, false));
const st = [];
for (let i = 0; i < 16; i++) st.push(mkView(i * 2 * Math.PI / 16 + .1, [.55, .85, 1.2][i % 3], 1.0 + .15 * (i % 2), true));
check(n >= 18, `cameras from the tags in ${n} / 21 views`);
check(worst < .02, `camera position error from the tags ${(worst * 1000).toFixed(1)} mm (< 20)`);
console.log(`rendered in ${Date.now() - t0} ms`);

const t1 = Date.now(), m = buildStick(bg, st);
console.log(`built in ${Date.now() - t1} ms: length ${m.length} m, ${m.voxels} voxels, radius ${m.r.map(v => (v * 1000).toFixed(0)).join(' ')} mm`);
check(Math.abs(m.length - SL) < .03, `length ${m.length.toFixed(3)} m (true ${SL.toFixed(3)})`);
const rMid = m.r.slice(5, 35).sort((a, b) => a - b)[15];
check(rMid > .009 && rMid < .017, `radius ${(rMid * 1000).toFixed(1)} mm (true 12)`);
const ring = r => { let c = [0, 0, 0]; for (let a = 0; a < m.around; a++) for (let k = 0; k < 3; k++) c[k] += m.rgb[3 * (r * m.around + a) + k] / m.around; return c.map(Math.round); };
const band = ring(Math.floor(.75 * m.rings)), body = ring(Math.floor(.3 * m.rings));
check(band[0] > band[1] + 80, `band ring (75%) is red: ${band}`);
check(body[0] > body[2] + 40 && body[1] < body[0], `grip side (30%) is brown: ${body}`);
const g25 = ring(Math.floor(.25 * m.rings)); check(g25[0] - g25[1] < 60, `ring 25% is not red (${g25}): the band is on the tip side, ring 0 is the grip`);
check(m.rgb.length === m.rings * m.around * 3 && m.rgb.every(v => v >= 0 && v <= 255), 'rgb fully filled, 0-255');
let threw = false; try { buildStick(bg.slice(0, 2), st); } catch { threw = true; }
check(threw, 'too few background pictures: an error, not a model');
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
