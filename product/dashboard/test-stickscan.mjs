// Stick scan (public/stickscan.js) on synthetic pictures: a black and white printed floor and a natural 0.9 m stick (brown bark with grey
// patches, dark streaks, a pale knot) lying on it with its shadow, tip toward
// -z: tapered (r 15 mm at the grip to 8 mm at the tip), a knot (+6 mm) at 30 %, bowed 25 mm sideways. Many angles, noise, a warm white
// balance that differs per picture. Checks the cameras from the mahoujin's tag corners, then the model's length, radius, knot, taper, bow
// and which end is the tip.   node test-stickscan.mjs
process.env.MARKER = 'rune';
const W = await import('./public/world.js'), { buildStick, viewCamera } = await import('./public/stickscan.js');
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const IW = 360, IH = 480, F = 400; // portrait, ~62° vertical like a phone
const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function camAt(az, el, dist, target = [0, 0, 0]) {
  const O = [target[0] + dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), target[2] + dist * Math.cos(el) * Math.cos(az)];
  const z = norm(target.map((v, i) => v - O[i])), x = norm(cross(z, [0, 1, 0])), y = cross(z, x);
  return { pose: W.pose(W.fromCols(x, y, z), O), f: F, w: IW, h: IH };
}
// the floor: white paper with black rings and spokes (like the mahoujin's lines), a grey floor round it
function floorRGB(x, z) {
  const r = Math.hypot(x, z), a = Math.atan2(z, x);
  if (r > .62) return [110, 110, 110];
  const line = [.15, .3, .45, .58].some(R => Math.abs(r - R) < .004) || (r > .15 && Math.abs(((a / (2 * Math.PI) * 12) % 1 + 1) % 1 - .5) * r * 2 * Math.PI / 12 < .0025);
  return line ? [30, 30, 30] : [235, 235, 235];
}
// the stick: a chain of capsules along a bowed centre line, resting on the floor (centre height = radius)
const A0 = [.05, .45], A1 = [-.05, -.45], SL = Math.hypot(A1[0] - A0[0], A1[1] - A0[1]);
const AX = [(A1[0] - A0[0]) / SL, (A1[1] - A0[1]) / SL], SIDE = [-AX[1], AX[0]];
const rTrue = t => .015 - .007 * t + .006 * Math.exp(-(((t - .3) / .03) ** 2));
const bow = t => .025 * Math.sin(Math.PI * t);
const SEG = 80, pts = Array.from({ length: SEG + 1 }, (_, i) => { const t = i / SEG, r = rTrue(t); return [A0[0] + AX[0] * t * SL + SIDE[0] * bow(t), r, A0[1] + AX[1] * t * SL + SIDE[1] * bow(t)]; });
const caps = pts.slice(1).map((b, i) => ({ a: pts[i], b, r: (rTrue(i / SEG) + rTrue((i + 1) / SEG)) / 2 }));
function capsule(ro, rd, { a, b, r }) { // ray / capsule (iq): distance or -1
  const ba = b.map((v, i) => v - a[i]), oa = ro.map((v, i) => v - a[i]);
  const baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa), rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  const A = baba - bard * bard, B = baba * rdoa - baoa * bard, C = baba * oaoa - baoa * baoa - r * r * baba;
  let h = B * B - A * C; if (h < 0) return -1;
  const t = (-B - Math.sqrt(h)) / A, y = baoa + t * bard;
  if (y > 0 && y < baba) return t;
  const oc = y <= 0 ? oa : ro.map((v, i) => v - b[i]), b2 = dot(rd, oc), c2 = dot(oc, oc) - r * r;
  h = b2 * b2 - c2; return h > 0 ? -b2 - Math.sqrt(h) : -1;
}
const LIGHT = norm([.4, 1, .3]);
// a natural stick: brown bark with grey patches, dark streaks, and a pale knot
function bark([x, y, z]) {
  const u = ((x - A0[0]) * AX[0] + (z - A0[1]) * AX[1]) / SL, w = Math.sin(x * 140 + y * 300) * Math.cos(z * 90 - y * 200);
  if (Math.abs(u - .3) < .02) return [200, 182, 150];
  if (w > .45) return [118, 115, 108];
  if (w < -.6) return [70, 48, 30];
  return [140, 92, 52];
}
const BOUND = { a: [A0[0], .012, A0[1]], b: [A1[0], .012, A1[1]], r: .06 }; // around the whole stick: most rays miss it
function hitStick(O, d) {
  const bb = BOUND.b.map((v, i) => v - BOUND.a[i]), ub = Math.max(0, Math.min(1, dot(O.map((v, i) => v - BOUND.a[i]), bb) / dot(bb, bb)));
  if (Math.hypot(...O.map((v, i) => v - BOUND.a[i] - ub * bb[i])) > BOUND.r && capsule(O, d, BOUND) < 0) return null; // starts outside, misses
  let best = Infinity, cap = null;
  for (const c of caps) { const t = capsule(O, d, c); if (t > 0 && t < best) { best = t; cap = c; } }
  if (!cap) return null;
  const P = O.map((v, i) => v + best * d[i]), ba = cap.b.map((v, i) => v - cap.a[i]);
  const u = Math.max(0, Math.min(1, dot(P.map((v, i) => v - cap.a[i]), ba) / dot(ba, ba)));
  return { n: norm(P.map((v, i) => v - cap.a[i] - u * ba[i])), P };
}
function render(cam) {
  const data = new Uint8ClampedArray(IW * IH * 4), R = cam.pose.R, O = cam.pose.t, gain = .85 + .3 * rnd(), warmth = 1 + .08 * rnd(); // a warm white balance
  for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
    const a = (x + .5 - IW / 2) / F, b = (y + .5 - IH / 2) / F;
    const d = norm([R[0] * a + R[1] * b + R[2], R[3] * a + R[4] * b + R[5], R[6] * a + R[7] * b + R[8]]);
    let c = [60, 60, 60];
    const h = hitStick(O, d);
    if (h) { const sh = .35 + .65 * Math.max(0, dot(h.n, LIGHT)); c = bark(h.P).map(v => v * sh); }
    else if (d[1] < 0) {
      const s = -O[1] / d[1], P = [O[0] + s * d[0], 0, O[2] + s * d[2]];
      c = floorRGB(P[0], P[2]);
      if (hitStick(P, LIGHT)) c = c.map(v => v * .55); // its shadow on the paper
    }
    const p = 4 * (y * IW + x);
    data[p] = c[0] * gain * warmth + (rnd() - .5) * 8; data[p + 1] = c[1] * gain + (rnd() - .5) * 8; data[p + 2] = c[2] * gain / warmth + (rnd() - .5) * 8;
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

let worst = 0, n = 0;
const t0 = Date.now(), views = [];
for (let i = 0; i < 24; i++) {
  const truth = camAt(i * 2 * Math.PI / 24 + .1, [.5, .8, 1.15][i % 3], 1.0 + .15 * (i % 2)), cam = viewCamera(tagsSeen(truth), K, IW, IH);
  if (cam) { worst = Math.max(worst, Math.hypot(...cam.pose.t.map((v, k) => v - truth.pose.t[k]))); n++; }
  views.push({ img: render(truth), cam });
}
check(n >= 20, `cameras from the tags in ${n} / 24 views`);
check(worst < .02, `camera position error from the tags ${(worst * 1000).toFixed(1)} mm (< 20)`);
console.log(`rendered in ${Date.now() - t0} ms`);

const t1 = Date.now(), m = buildStick(views);
const ringR = r => m.r.slice(r * m.around, (r + 1) * m.around), upR = r => { const a = ringR(r); return (a[0] + a[m.around / 4] + a[3 * m.around / 4]) / 3; }; // top and both sides: what the views see
const tOf = r => (r + .5) / m.rings;
console.log(`built in ${Date.now() - t1} ms: length ${m.length} m, ${m.voxels} voxels`);
console.log('radius mm  ' + Array.from({ length: m.rings }, (_, r) => (upR(r) * 1000).toFixed(0)).join(' '));
console.log('true   mm  ' + Array.from({ length: m.rings }, (_, r) => (rTrue(tOf(r)) * 1000).toFixed(0)).join(' '));
const LEN = SL + rTrue(0) + rTrue(1); // the capsules' round ends stick out by their radius
check(Math.abs(m.length - LEN) < .01, `length ${m.length.toFixed(3)} m (true ${LEN.toFixed(3)}, end to end)`);
const inner = Array.from({ length: m.rings }, (_, r) => r).filter(r => r >= 2 && r < m.rings - 2);
const err = inner.reduce((s, r) => s + Math.abs(upR(r) - rTrue(tOf(r))), 0) / inner.length;
const bias = inner.reduce((s, r) => s + upR(r) - rTrue(tOf(r)), 0) / inner.length;
check(err < .0015, `mean radius error ${(err * 1000).toFixed(2)} mm (< 1.5), bias ${(bias * 1000).toFixed(2)} mm`);
const at = t => Math.min(m.rings - 1, Math.floor(t * m.rings));
check(upR(at(.3)) > upR(at(.2)) + .003, `knot at 30 %: ${(upR(at(.3)) * 1000).toFixed(1)} mm vs ${(upR(at(.2)) * 1000).toFixed(1)} at 20 %`);
check(upR(at(.1)) > upR(at(.9)) + .004, `taper: grip ${(upR(at(.1)) * 1000).toFixed(1)} mm, tip ${(upR(at(.9)) * 1000).toFixed(1)} mm (ring 0 is the grip)`);
const lat = r => m.c[2 * r], sag = Math.abs(lat(at(.5)) - (lat(at(.05)) + lat(at(.95))) / 2), trueSag = bow(.5) - (bow(.05) + bow(.95)) / 2;
check(Math.abs(sag - trueSag) < .006, `bow ${(sag * 1000).toFixed(1)} mm (true ${(trueSag * 1000).toFixed(1)})`);
check(m.r.length === m.rings * m.around && m.c.length === 2 * m.rings && m.r.every(v => v > 0 && v < .1), 'model arrays complete');
let threw = false; try { buildStick(views.slice(0, 3)); } catch { threw = true; }
check(threw, 'too few pictures: an error, not a model');
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
