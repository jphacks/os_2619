// Chest phone localisation in the world frame (see world.js).
// world_T_arcam(t) = world_T_origin ∘ calib_T_arcam(t). ARCore gives calib_T_arcam; world_T_origin is a fixed transform
// re-measured every time the phone sees a corner tag (removes ARCore drift). Before the first sighting it is guessed from
// the start mark (the user calibrates standing there). Plain JS, browser + node.
import {
  START, TAGS, CORNER_IDS, PLAYER_TAG, isChestTag, tagScale, app3, pose, compose, invert, apply, fromQuat, toQuat, fromRodrigues,
  cv_T_arcam, arcam_T_cv, worldTagPose, bodyPose, phoneArcamPose,
} from './world.js';

const OTHER = { A: 'B', B: 'A' };
const DEG = Math.PI / 180;

// ---- quaternion helpers ([w,x,y,z], same as world.js fromQuat/toQuat) ----
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const qnorm = q => { const n = Math.hypot(...q); return q.map(v => v / n); };
function slerp(a, b, u) {
  let d = qdot(a, b); if (d < 0) { b = b.map(v => -v); d = -d; }
  if (d > 0.9995) return qnorm(a.map((v, i) => v + u * (b[i] - v)));
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - u) * th) / s, wb = Math.sin(u * th) / s;
  return a.map((v, i) => wa * v + wb * b[i]);
}
/** Weighted pose average: translations averaged, rotations by sign-aligned normalised quaternion sum. */
function meanPose(list) { // [{ p, w }]
  const q0 = toQuat(list[0].p.R), q = [0, 0, 0, 0], t = [0, 0, 0]; let W = 0;
  for (const { p, w } of list) {
    let qi = toQuat(p.R); if (qdot(qi, q0) < 0) qi = qi.map(v => -v);
    for (let i = 0; i < 4; i++) q[i] += w * qi[i];
    for (let i = 0; i < 3; i++) t[i] += w * p.t[i];
    W += w;
  }
  return pose(fromQuat(qnorm(q)), t.map(v => v / W));
}
const lerpPose = (a, b, u) => pose(fromQuat(slerp(toQuat(a.R), toQuat(b.R), u)), a.t.map((v, i) => v + u * (b.t[i] - v)));
/** Rotation angle between two rotation matrices, rad. */
const angle = (A, B) => { let tr = 0; for (let i = 0; i < 9; i++) tr += A[i] * B[i]; // trace(A^T B)
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const arPose = k => pose(fromQuat(qnorm([k.q[3], k.q[0], k.q[1], k.q[2]])), k.p.slice()); // ar.q is [x,y,z,w], rounded on the wire
const startOrigin = slot => phoneArcamPose(bodyPose(START[slot].pos, START[slot].yaw));

/**
 * opts
 * - gain ('auto'): per-fix blend gain into world_T_origin. 'auto' = scalar Kalman gains from the noise/drift figures below
 *   (high right after a gap, low while tags stay in view); a number = fixed complementary filter for rotation and translation.
 * - rotNoise (0.7°/m), posNoise (0.01 m/m): tag pose noise per metre of distance for a 25 cm tag (scaled by tag size).
 * - rotDrift (1°/√s), posDrift (0.02 m/√s): ARCore drift, as random walks of the origin.
 * - maxJump (0.5 m) / maxTurn (20°): outlier gates on the phone pose jump; agree (3) consecutive agreeing outliers are taken.
 * - maxGap (0.06 s): tags↔ar time match; keep (1 s): ar history.
 * - useOpponentObs (false): nudge an unanchored player's position toward the other player's sighting of its chest tag, oppGain (0.3).
 */
export function createLocalizer(opts = {}) {
  const o = { gain: 'auto', rotNoise: 0.7 * DEG, posNoise: 0.01, rotDrift: 1 * DEG, posDrift: 0.02,
    maxJump: 0.5, maxTurn: 20 * DEG, agree: 3, maxGap: 0.06, keep: 1, useOpponentObs: false, oppGain: 0.3, ...opts };
  const S = {};
  const reset = slot => { // ar history is dropped too: poses before calib are in the old origin
    S[slot] = { origin: startOrigin(slot), anchored: false, ar: [], lastFix: null, fixes: 0, err: 0, pending: [], PR: 0, Pt: 0, opponent: null };
  };
  reset('A'); reset('B');

  /** calib_T_arcam at time t: interpolated between neighbours, or nearest within maxGap. */
  function arAt(s, t) {
    const a = s.ar; if (!a.length) return null;
    let i = a.findIndex(k => k.t >= t);
    if (i > 0) { const p = a[i - 1], n = a[i];
      if (n.t - p.t <= 2 * o.maxGap) return lerpPose(p.pose, n.pose, n.t > p.t ? (t - p.t) / (n.t - p.t) : 0); }
    if (i < 0) i = a.length - 1;
    let best = a[i]; if (i > 0 && Math.abs(a[i - 1].t - t) < Math.abs(best.t - t)) best = a[i - 1];
    return Math.abs(best.t - t) <= o.maxGap ? best.pose : null;
  }
  const latest = s => s.ar.length ? s.ar[s.ar.length - 1].pose : null;
  const cvOf = (s, calib) => compose(compose(s.origin, calib), arcam_T_cv); // world_T_cv

  function onAr(s, k) {
    if (k.tracking && k.tracking !== 'TRACKING') return; // stale pose while tracking is lost
    if (!k.p || !k.q) return;
    s.ar.push({ t: k.t, pose: arPose(k) });
    while (s.ar.length > 2 && s.ar[0].t < k.t - o.keep) s.ar.shift();
  }

  function onTags(slot, s, k) {
    const calib = arAt(s, k.t); if (!calib) return;
    const seen = [];
    for (const g of k.tags ?? []) {
      if (!g.p || !g.r || !TAGS[g.id]) continue;
      const cv_T_tag = pose(fromRodrigues(g.r), g.p.map(v => v * tagScale(g.id, g.sz)));
      if (CORNER_IDS.includes(g.id)) {
        const d = Math.max(Math.hypot(...cv_T_tag.t), 0.3), r = d * 0.2 / TAGS[g.id].size; // error grows with distance / tag size
        seen.push({ id: g.id, cv_T_tag, d, r, w: 1 / (r * r) });
      } else if (isChestTag(g.id)) { // worn tags 8-11: always the other player's
        const pos = apply(cvOf(s, calib), cv_T_tag.t);
        s.opponent = { pos, t: k.t, anchored: s.anchored };
        if (o.useOpponentObs && s.anchored) correctFromObs(S[OTHER[slot]], pos, k.t);
      }
    }
    if (seen.length) fix(s, seen, calib, k.t);
  }

  /** Origin translation that puts the tags where they are, given the origin rotation R (tag translations only). */
  function originT(seen, calib, R) {
    const Rcv = compose(compose(pose(R), calib), arcam_T_cv).R, Rc = app3(R, calib.t), t = [0, 0, 0]; let W = 0;
    for (const { id, cv_T_tag, w } of seen) {
      const cam = app3(Rcv, cv_T_tag.t).map((v, i) => TAGS[id].pos[i] - v); // camera position in world
      for (let i = 0; i < 3; i++) t[i] += w * (cam[i] - Rc[i]);
      W += w;
    }
    return t.map(v => v / W);
  }

  // Rotation comes from the tag orientations (noisy: distance x angle error on position), so it is filtered first and
  // the translation is then solved from the tag positions with the filtered rotation.
  function fix(s, seen, calib, t) {
    const m = meanPose(seen.map(({ id, cv_T_tag, w }) =>
      ({ p: compose(compose(compose(worldTagPose(id), invert(cv_T_tag)), cv_T_arcam), invert(calib)), w })));
    const varR = 1 / seen.reduce((a, { r }) => a + 1 / (o.rotNoise * r) ** 2, 0);
    // tag position noise is independent per tag; the rotation error is shared by every tag in the frame, so it is not averaged down
    const W = seen.reduce((a, { w }) => a + w, 0), d2 = seen.reduce((a, { w, d }) => a + w * d * d, 0) / W;
    const varT = PR => 1 / seen.reduce((a, { r }) => a + 1 / (o.posNoise * r) ** 2, 0) + d2 * PR;
    const take = R => { s.origin = pose(R, originT(seen, calib, R)); s.PR = varR; s.Pt = varT(varR); s.pending = []; };
    // judge the jump on the current phone pose, not on the origin (origin errors scale with the lever arm)
    const cur = compose(s.origin, calib), nxt = compose(m, calib);
    if (!s.anchored) { take(m.R); s.anchored = true; s.err = dist(cur.t, compose(s.origin, calib).t); s.lastFix = t; s.fixes++; return; }
    const jump = dist(cur.t, nxt.t), turn = angle(cur.R, nxt.R);
    if (jump > o.maxJump || turn > o.maxTurn) {
      const p = s.pending, last = p[p.length - 1];
      if (last && (dist(last.t, nxt.t) > o.maxJump || angle(last.R, nxt.R) > o.maxTurn)) p.length = 0;
      p.push(nxt);
      if (p.length < o.agree) return;
      take(m.R); // consistent outliers: the old anchor was wrong, take the new one
    } else {
      s.pending = [];
      let gR = o.gain, g = o.gain;
      if (o.gain === 'auto') {
        const dt = Math.max(0, t - s.lastFix);
        s.PR += o.rotDrift ** 2 * dt; s.Pt += o.posDrift ** 2 * dt;
        gR = s.PR / (s.PR + varR); s.PR *= 1 - gR;
        const vt = varT(s.PR); g = s.Pt / (s.Pt + vt); s.Pt *= 1 - g;
      }
      const R = fromQuat(slerp(toQuat(s.origin.R), toQuat(m.R), gR)), tm = originT(seen, calib, R);
      s.origin = pose(R, s.origin.t.map((v, i) => v + g * (tm[i] - v)));
    }
    s.err = dist(cur.t, compose(s.origin, calib).t); s.lastFix = t; s.fixes++;
  }

  // translation-only nudge of an unanchored player toward where the other player saw its chest tag
  function correctFromObs(s, pos, t) {
    if (s.anchored) return;
    const calib = arAt(s, t); if (!calib) return;
    const cur = compose(s.origin, calib).t, d = pos.map((v, i) => o.oppGain * (v - cur[i]));
    s.origin = pose(s.origin.R, s.origin.t.map((v, i) => v + d[i]));
  }

  return {
    onMessage(k) {
      const s = S[k?.slot]; if (!s) return;
      if (k.type === 'ar') onAr(s, k);
      else if (k.type === 'tags') onTags(k.slot, s, k);
      else if (k.type === 'calib') reset(k.slot);
    },
    get(slot) {
      const s = S[slot], calib = latest(s);
      const out = { anchored: s.anchored, world_T_arcam: null, chest: null, yaw: null, body: null, lastFix: s.lastFix, fixes: s.fixes, err: s.err, seen: { opponent: s.opponent } };
      if (!calib) return out;
      const w = compose(s.origin, calib), cv = compose(w, arcam_T_cv);
      const fx = cv.R[2], fz = cv.R[8]; // cv z axis (forward) in world
      out.world_T_arcam = w; out.chest = w.t.slice();
      out.yaw = Math.atan2(-fz, fx);
      out.body = bodyPose(w.t, out.yaw, w.t[1]);
      return out;
    },
    /** world_T_arcam at a past time t (for matching other streams), or null. */
    at(slot, t) { const s = S[slot], c = arAt(s, t); return c ? compose(s.origin, c) : null; },
  };
}
