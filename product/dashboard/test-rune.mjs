// RuneTag detector (public/runetag.js) on synthetic pictures: the printed sheets (magic circle included) rendered in perspective
// at many distances, tilts and turns, blurred and noisy. Checks the id and the virtual square's corners, and that nothing is found
// where there is no sheet.   node test-rune.mjs
import { RUNE, RUNE_IDS, runePrims, rasterPrims, detectRunes, project } from './public/runetag.js';

const TEX = 1000, tex = RUNE_IDS.map(id => rasterPrims(runePrims(id), TEX));
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

/** Rotation from yaw (about the sheet normal), tilt (about the camera x axis) and a turn about the view axis. */
function camHomography({ f, w, h, dist, tilt, spin, roll, off = [0, 0] }) {
  const c = Math.cos, s = Math.sin;
  // tag frame -> cam: sheet facing the camera (tag z toward the camera = cam -z), y up = cam -y; then spin about the normal,
  // tilt about cam x, roll about cam z
  const Rs = [c(spin), -s(spin), 0, s(spin), c(spin), 0, 0, 0, 1];
  const F = [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const Rt = [1, 0, 0, 0, c(tilt), -s(tilt), 0, s(tilt), c(tilt)];
  const Rr = [c(roll), -s(roll), 0, s(roll), c(roll), 0, 0, 0, 1];
  const m = (A, B) => { const r = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]); return r; };
  const R = m(Rr, m(Rt, m(F, Rs))), t = [off[0], off[1], dist];
  // H = K [r1 r2 t]
  const K = [f, 0, w / 2, 0, f, h / 2, 0, 0, 1], B = [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]];
  return m(K, B);
}
const inv3 = m => {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, Bv = -(d * i - f * g), C = d * h - e * g, det = a * A + b * Bv + c * C;
  return [A, -(b * i - c * h), b * f - c * e, Bv, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
};
function render(id, H, w, h, { noise = 4, blur = true } = {}) {
  const Hi = inv3(H), g = new Float32Array(w * h), half = RUNE.sheet / 2, T = id === null ? null : tex[id];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const [X, Y] = project(Hi, x + (sx + .5) / 3, y + (sy + .5) / 3);
      if (T && Math.abs(X) < half && Math.abs(Y) < half) {
        const i = Math.min(TEX - 1, Math.floor((X + half) / RUNE.sheet * TEX)), j = Math.min(TEX - 1, Math.floor((half - Y) / RUNE.sheet * TEX));
        acc += 225 - 195 * T[j * TEX + i];
      } else acc += 95 + 25 * Math.sin(x * .05) * Math.sin(y * .043); // a floor with some texture
    }
    g[y * w + x] = acc / 9;
  }
  let out = g;
  if (blur) { out = new Float32Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += g[(y + j) * w + x + i] * (i || j ? (i && j ? 1 : 2) : 4); out[y * w + x] = s / 16; } }
  return out.map(v => Math.max(0, Math.min(255, v + noise * gauss())));
}

let fails = 0, n = 0;
const check = (ok, msg) => { n++; if (!ok) { fails++; console.log('FAIL', msg); } };
const cams = [{ w: 480, h: 640, f: 500 }, { w: 1280, h: 720, f: 1000 }];
const cases = [];
for (const cam of cams) for (const dist of [0.7, 1.3, 2.2, 3.2]) for (const tilt of [0, 35, 55, 68]) cases.push({ ...cam, dist, tilt: tilt * Math.PI / 180, spin: rnd() * 2 * Math.PI, roll: (rnd() - .5) * .6, id: Math.floor(rnd() * 4) });
const t0 = Date.now(); const miss = [];
for (const c of cases) {
  const H = camHomography(c), px = Math.hypot(...[0, 1].map(i => project(H, RUNE.sheet / 2, 0)[i] - project(H, -RUNE.sheet / 2, 0)[i]));
  const g = render(c.id, H, c.w, c.h), got = detectRunes(g, c.w, c.h), hs = RUNE.square / 2;
  const truth = [[-hs, hs], [hs, hs], [hs, -hs], [-hs, -hs]].map(p => project(H, ...p));
  const m = got.find(o => o.id === c.id), wrong = got.filter(o => o.id !== c.id);
  const err = m ? Math.max(...m.corners.map((q, i) => Math.hypot(q[0] - truth[i][0], q[1] - truth[i][1]))) : null;
  const tag = `${c.w}x${c.h} d=${c.dist} tilt=${(c.tilt * 180 / Math.PI).toFixed(0)} id=${c.id} sheet=${px.toFixed(0)}px`;
  check(!wrong.length, `${tag}: false ids ${wrong.map(o => o.id)}`);
  if (!m) { miss.push(tag); continue; }
  check(err < Math.max(1.5, px / 150), `${tag}: corner error ${err.toFixed(2)} px`);
  console.log(`ok ${tag}: err ${err.toFixed(2)} px, ${m.n} dots, ${m.err} bad bits, rms ${m.rms.toFixed(2)}`);
}
// must-find: every sheet at least ~110 px across and tilted <= 55°; farther / steeper ones are reported but not required
for (const t of miss) { const px = +t.match(/sheet=(\d+)/)[1], tilt = +t.match(/tilt=(\d+)/)[1]; console.log('miss', t); check(px < 110 || tilt > 55, `${t}: not found`); }
for (const cam of cams) { const g = render(null, camHomography({ ...cam, dist: 1, tilt: 0, spin: 0, roll: 0 }), cam.w, cam.h, { noise: 12 }); check(!detectRunes(g, cam.w, cam.h).length, 'found a tag in an empty picture'); }
console.log(`${cases.length - miss.length}/${cases.length} found, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// End to end in RuneTag mode: phone C's picture of the four map4 sheets (250 mm, edge to edge) -> tagdetect.js -> extrinsics.js pose
{
  process.env.MARKER = 'rune';
  const W = await import('./public/world.js'), { detectInImage } = await import('./public/tagdetect.js'), { solveCamera } = await import('./public/extrinsics.js');
  check(W.MARKER === 'rune' && Math.abs(W.TAGS[0].size - W.PRINTED.rune * .8) < 1e-12 && W.TAG_PITCH === W.PRINTED.rune, 'world.js did not switch to RuneTag');
  // the app measures a RuneTag at its drawn 200 mm square; the 246 mm print makes it 196.8 mm, so distances scale by 0.984 (not 1/1.12)
  check(Math.abs(W.tagScale(0, RUNE.square) - W.PRINTED.rune / RUNE.sheet) < 1e-12, `RuneTag distance factor ${W.tagScale(0, RUNE.square)}`);
  const CW = 1920, CH = 1080, fov = 40, f = CH / 2 / Math.tan(fov * Math.PI / 360), K = [f, 0, CW / 2, 0, f, CH / 2, 0, 0, 1];
  const lookAt = (eye, tgt) => {
    const sub = (a, b) => a.map((v, i) => v - b[i]), cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], nz = a => a.map(v => v / Math.hypot(...a));
    const z = nz(sub(tgt, eye)), x = nz(cr(z, [0, 1, 0])), y = cr(z, x);
    return { R: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]], t: eye };
  };
  const m3 = (A, B) => { const r = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]); return r; };
  let worstPos = 0, worstAng = 0, views = 0;
  for (const [dist, hgt, az] of [[2.5, 1.5, .3], [3.5, 1.7, -.5], [4.5, 2.0, .1]]) {
    const eye = [dist * Math.sin(az), hgt, dist * Math.cos(az)], pose = lookAt(eye, [0, 0, 0]), inv = W.invert(pose);
    const Hs = W.CORNER_IDS.map(id => { const ct = W.compose(inv, W.worldTagPose(id)), R = ct.R, t = ct.t; return { id, Hi: inv3(m3(K, [R[0], R[1], t[0], R[3], R[4], t[1], R[6], R[7], t[2]])) }; });
    const data = new Uint8ClampedArray(CW * CH * 4), half = W.PRINTED.rune / 2; // printed (and measured) at 246 mm, not the drawn 250
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      let acc = 0;
      for (let s = 0; s < 4; s++) {
        const u = x + .25 + .5 * (s & 1), v = y + .25 + .5 * (s >> 1); let val = 90 + 20 * Math.sin(u * .03) * Math.sin(v * .021);
        for (const { id, Hi } of Hs) { const [X, Y] = project(Hi, u, v); if (Math.abs(X) < half && Math.abs(Y) < half) { val = 225 - 195 * tex[id][Math.min(TEX - 1, Math.floor((half - Y) / (2 * half) * TEX)) * TEX + Math.min(TEX - 1, Math.floor((X + half) / (2 * half) * TEX))]; break; } }
        acc += val;
      }
      const g = acc / 4 + 3 * gauss(), o = 4 * (y * CW + x); data[o] = data[o + 1] = data[o + 2] = g; data[o + 3] = 255;
    }
    const t1 = Date.now(), dets = await detectInImage({ width: CW, height: CH, data }, W.CORNER_IDS), ms = Date.now() - t1;
    // 4.5 m from 2 m up the far sheets are seen at ~70° from their normal: the inner dots blur away, 2 of 4 still read
    check(dets.length >= (dist > 4 ? 2 : 4), `phone C at ${dist} m: found ${dets.map(d => d.id)}`);
    const r = solveCamera(dets, CW, CH, { fovYGuess: fov, fitFocal: 'auto' });
    if (!r) { check(false, 'no pose'); continue; }
    const RR = W.mul3(W.tr3(r.pose.R), pose.R), ang = Math.acos(Math.max(-1, Math.min(1, (RR[0] + RR[4] + RR[8] - 1) / 2))) * 180 / Math.PI;
    const pe = Math.hypot(...r.pose.t.map((v, i) => v - eye[i]));
    worstPos = Math.max(worstPos, pe); worstAng = Math.max(worstAng, ang); views++;
    console.log(`phone C ${dist} m: ${dets.length} sheets in ${ms} ms, pose off ${(pe * 100).toFixed(1)} cm ${ang.toFixed(2)} deg, fovY ${r.fovY?.toFixed(1)}`);
  }
  check(worstPos < 0.1 && worstAng < 1, `phone C pose from RuneTags: worst ${worstPos.toFixed(3)} m ${worstAng.toFixed(2)} deg`);
}
console.log(`${n - fails}/${n} checks passed`);
process.exit(fails ? 1 : 0);
