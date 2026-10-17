// Synthetic two-person scene with known geometry, for fake-phone.mjs and test-map.mjs.
// Room: y up, floor y = 0, AprilTags 0-3 on the floor corners, 10/11 on A/B's chest mounts. A and B face each other and swing sticks.
// Each phone's ARCore world is gravity-aligned with its own yaw and origin, like the real thing.
import { add, sub, mul, dot, cross, norm, rotY } from './public/map.js';

export const TAG = 0.15, K = [1.04, 0.78, 0.5, 0.5], L = { A: 1.0, B: 0.8 };
export const CORNERS = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 0, 2.6], 3: [0, 0, 2.6] }, CHEST = { A: 10, B: 11 };
const TARGET = { A: [0, 220, 220], B: [115, 220, 200] }; // tip colour of each person's stick (OpenCV HSV)
const WORLD = { A: { psi: 0.7, tau: [0.3, -1.2, -0.5] }, B: { psi: -2.1, tau: [2, -1.1, 1] } }; // room = rotY(psi, w) + tau
const UP = [0, 1, 0], other = s => s === 'A' ? 'B' : 'A';

export function truth(t) {
  const chest = { A: [1 + 0.5 * Math.sin(0.3 * t), 1.3, 1.3 + 0.4 * Math.sin(0.5 * t)], B: [3 + 0.4 * Math.sin(0.4 * t + 1), 1.35, 1.3 + 0.45 * Math.cos(0.35 * t)] };
  const out = {};
  for (const s of ['A', 'B']) {
    const c = chest[s], d = sub(chest[other(s)], c), f = norm([d[0], 0, d[2]]), r = cross(f, UP);
    const pitch = -0.17, fc = add(mul(f, Math.cos(pitch)), mul(UP, Math.sin(pitch))), rc = norm(cross(fc, UP));
    const wrist = add(c, add(mul(f, 0.3), add(mul(r, 0.2), mul(UP, -0.3))));
    const sw = 0.9 * Math.sin(2.5 * t + (s === 'A' ? 0 : 2));
    const dir = norm(add(add(mul(f, Math.cos(sw)), mul(r, 0.8 * Math.sin(sw))), mul(UP, 0.3 + 0.3 * Math.sin(1.7 * t))));
    out[s] = { chest: c, fwd: f, right: r, cam: { r: rc, d: cross(fc, rc), f: fc }, wrist, tip: add(wrist, mul(dir, L[s])), tag: add(c, mul(UP, -0.06)) };
  }
  return out;
}

function quat(cx, cy, cz) { // rotation matrix with these columns -> [x, y, z, w]
  const [m00, m10, m20] = cx, [m01, m11, m21] = cy, [m02, m12, m22] = cz, tr = m00 + m11 + m22;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, S / 4]; }
  if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; return [S / 4, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S]; }
  if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / S, S / 4, (m12 + m21) / S, (m02 - m20) / S]; }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2; return [(m02 + m20) / S, (m12 + m21) / S, S / 4, (m10 - m01) / S];
}
const rodrigues = ([x, y, z, w]) => { const s = Math.hypot(x, y, z), th = 2 * Math.atan2(s, w); return s < 1e-9 ? [0, 0, 0] : [x / s * th, y / s * th, z / s * th]; };

/** What phone s sends at time t: always `ar`; with vision also tags, and colour (opponent's stick tip). */
export function packets(s, t, vision = true) {
  const T = truth(t), me = T[s], o = T[other(s)], W = WORLD[s], cam = me.cam;
  const dirW = v => rotY(-W.psi, v), wp = dirW(sub(me.chest, W.tau));
  const wq = quat(dirW(cam.d), dirW(cam.r), dirW(mul(cam.f, -1))); // ARCore camera axes = (portrait down, right, back)
  const out = [{ type: 'ar', t, tracking: 'TRACKING', reason: 'NONE', p: wp, q: wq, wp, wq, planes: 2 }];
  if (!vision) return out;

  const dirCam = v => [dot(v, cam.r), dot(v, cam.d), dot(v, cam.f)], inCam = v => dirCam(sub(v, me.chest));
  const proj = v => { const c = inCam(v); return c[2] > 0.1 ? [K[0] * c[0] / c[2] + K[2], K[1] * c[1] / c[2] + K[3]] : null; };
  const inImg = q => q && q[0] >= 0 && q[0] <= 1 && q[1] >= 0 && q[1] <= 1;
  const tags = [];
  const tag = (id, P, x, y, z) => {
    if (inCam(P)[2] < 0.3 || dot(z, norm(sub(me.chest, P))) < 0.26) return; // behind or more than 75° oblique
    const h = TAG / 2, c = [[-h, h], [h, h], [h, -h], [-h, -h]].map(([a, b]) => proj(add(P, add(mul(x, a), mul(y, b)))));
    if (c.every(inImg)) tags.push({ id, c, p: inCam(P), r: rodrigues(quat(dirCam(x), dirCam(y), dirCam(z))) });
  };
  for (const [id, P] of Object.entries(CORNERS)) tag(+id, P, [1, 0, 0], [0, 0, -1], UP);
  tag(CHEST[other(s)], o.tag, cross(UP, o.fwd), UP, o.fwd);
  out.push({ type: 'tags', t, k: K, tags });

  const tp = proj(o.tip), target = TARGET[other(s)];
  out.push(inImg(tp) ? { type: 'color', t, target, found: true, x: tp[0], y: tp[1], area: 0.003, box: [tp[0] - 0.02, tp[1] - 0.02, 0.04, 0.04] } : { type: 'color', t, target, found: false });
  return out;
}
