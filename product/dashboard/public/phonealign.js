// Every phone's data in the FIELD world (world.js): ARCore poses, AprilTag sightings, IMU stick.
// Plain JS (node + browser), no DOM.
//
// Each phone's raw ARCore world (`ar.wp` / `wq`) is gravity-aligned (y up) but has its own yaw and origin, so
// world_T_ar = rotY(θ) + t (4 numbers) per phone. Every sighting of a FIELD tag (ids with a known world pose, floor or
// standing) gives two point pairs: the tag centre, and the point 0.5 m along the tag's most horizontal printed axis
// (a single tag then already pins θ). Pairs over a sliding window are fitted by weighted least squares with median
// outlier rejection (as sensing/dashboard/map.js robustFit). Unlike map.js we know the tag ids and poses, so standing
// field tags are never mistaken for chest mounts, and no shared room frame is needed: each phone is placed alone.
// A phone that sends no wp/wq (old app) falls back to localize.js (calibration-relative p/q): src 'localize'.
import * as W from './world.js';
import { createLocalizer } from './localize.js';
import { eulerRot } from './actions.js';

const OTHER = { A: 'B', B: 'A' };
const KEEP = 20;          // s of AR history and tag sightings kept for the fit
const TRAIL = 15;         // s of trail
const AXIS_M = 0.5;       // m along the tag axis for the yaw-pinning point
const MIN_ALIGN = 3;      // sightings before `aligned`
const MIN_CHEST = 8;      // chest-tag sightings before they may place a phone
const MIN_SPREAD = 0.5;   // m, how far apart those sightings must be (they pin the turn)

// ---- vector helpers (allocating; only used off the per-message hot path or on small inputs) ----
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const rotY = (th, v) => { const c = Math.cos(th), s = Math.sin(th); return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]; };
const rotYMat = th => { const c = Math.cos(th), s = Math.sin(th); return [c, 0, s, 0, 1, 0, -s, 0, c]; }; // = rotY as a world.js matrix
// ARCore quaternion [x,y,z,w] rotating v
const qrot = ([x, y, z, w], v) => { const u = [x, y, z], c = cross(u, v); return add(v, add(mul(c, 2 * w), mul(cross(u, c), 2))); };
const rodr = (r, v) => { // rotate v by a Rodrigues vector
  const th = Math.hypot(r[0], r[1], r[2]); if (th < 1e-9) return v;
  const k = mul(r, 1 / th), c = Math.cos(th);
  return add(add(mul(v, c), mul(cross(k, v), Math.sin(th))), mul(k, dot(k, v) * (1 - c)));
};
// ARCore camera axes follow the landscape sensor; the portrait image is turned 90°: cv (x right, y down, z fwd) = ar (Y, X, -Z).
// Same as world.js CV_FROM_AR and map.js swap; its own inverse.
const swap = v => [v[1], v[0], -v[2]];
const camToWorld = (pose, v) => add(pose.p, qrot(pose.q, swap(v)));  // cv point -> phone's AR world
const camDir = (pose, v) => qrot(pose.q, swap(v));                   // cv direction -> AR world
const apply = (T, v) => add(rotY(T.th, v), T.t);
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));

/** Weighted least squares a ≈ rotY(th, b) + t over pairs { a, b, w }. */
function fit4(c) {
  let Wt = 0, ma = [0, 0, 0], mb = [0, 0, 0];
  for (const e of c) { Wt += e.w; ma = add(ma, mul(e.a, e.w)); mb = add(mb, mul(e.b, e.w)); }
  ma = mul(ma, 1 / Wt); mb = mul(mb, 1 / Wt);
  let sc = 0, ss = 0;
  for (const e of c) {
    const A = sub(e.a, ma), B = sub(e.b, mb);
    sc += e.w * (A[0] * B[0] + A[2] * B[2]); ss += e.w * (A[0] * B[2] - A[2] * B[0]);
  }
  const th = Math.atan2(ss, sc), T = { th, t: sub(ma, rotY(th, mb)) };
  T.rms = Math.sqrt(c.reduce((s, e) => s + e.w * dist(e.a, apply(T, e.b)) ** 2, 0) / Wt);
  T.n = c.length;
  return T;
}
/** fit4 with bad tag poses dropped: residual over max(15 cm, 3 x median), three rounds (map.js robustFit). */
function robustFit(c) {
  if (c.length < 2) return null;
  let T = fit4(c);
  for (let i = 0; i < 3; i++) {
    const r = c.map(e => dist(e.a, apply(T, e.b))), med = [...r].sort((x, y) => x - y)[r.length >> 1];
    const keep = c.filter((_, j) => r[j] <= Math.max(0.15, 3 * med));
    if (keep.length === c.length || keep.length < 2) break;
    c = keep; T = fit4(c);
  }
  T.used = c.length;
  return T;
}

/**
 * createPhoneAlign({ keep = 20, minAlign = 3, localizer, axis }) -> { ingest(k), get(slot), estimate(now), onFieldChange() }
 * - ingest(k): every relayed message (k.slot A/B; types ar, tags, imu, color, calib, phones).
 * - get(slot): { how: 'field'|'chest'|null (what placed this phone), src: 'ar'|'localize'|'tag'|null, aligned, theta, t, rms, n, used, lastFix, world_T_ar, chest, fwd, yaw, cam (world_T_arcam),
 *   trail, check (cm, this phone's own position vs where the other phone saw its chest tag), checkT, seenBy (that sighting, world),
 *   sightings (last tags message: [{ id, p (world), R (tag axes in world, 3x3 row-major), d }]), k, online, calibAt, hz, lastT }.
 * - estimate(now): { slots: { A, B }, stick: { A: { dir, base, src } }, warn }; stick[s] is s's own IMU stick.
 * - onFieldChange(): the field tags moved (setField): refit from the stored sightings. Also subscribed to world.onFieldChange.
 */
export function createPhoneAlign(opts = {}) {
  const o = { keep: KEEP, minAlign: MIN_ALIGN, ...opts };
  const loc = o.localizer ?? createLocalizer();
  const S = {};
  for (const s of ['A', 'B']) S[s] = {
    ar: [], trail: [], sight: [], T: null, Tf: null, how: null, dirty: false, fDirty: false, fixes: 0, lastFix: null, oldApp: false, online: false,
    k: null, imu: null, color: null, seen: [], lastTags: null, calibAt: null, calibPose: null, yaw0: 0,
    rate: { ar: 0, tags: 0, imu: 0, color: 0 }, cnt: { ar: 0, tags: 0, imu: 0, color: 0 }, cntAt: 0, lastT: 0,
  };

  /** AR pose of phone s at time t (own AR world), interpolated; null across a gap. Same shape as the wire: { p, q [x,y,z,w] }. */
  function poseAt(s, t) {
    const a = S[s].ar; if (!a.length) return null;
    let lo = 0, hi = a.length - 1;
    if (t <= a[0].t) return a[0].t - t < 0.05 ? a[0] : null;
    if (t >= a[hi].t) return t - a[hi].t < 0.05 ? a[hi] : null;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m].t <= t) lo = m; else hi = m; }
    const p = a[lo], q = a[hi];
    if (q.t - p.t > 0.2) return null; // tracking gap
    const f = (t - p.t) / (q.t - p.t), sg = p.q[0] * q.q[0] + p.q[1] * q.q[1] + p.q[2] * q.q[2] + p.q[3] * q.q[3] < 0 ? -1 : 1;
    const qq = p.q.map((v, i) => v + f * (sg * q.q[i] - v)), n = Math.hypot(...qq);
    return { t, p: add(p.p, mul(sub(q.p, p.p), f)), q: qq.map(v => v / n) };
  }
  const latest = s => S[s].ar.length ? S[s].ar[S[s].ar.length - 1] : null;

  // world pose of every field tag, cached until the field changes: centre + the most horizontal of its printed x / y axes
  let tagW = null;
  function tagWorld() {
    if (tagW) return tagW;
    tagW = {};
    for (const id of W.CORNER_IDS) {
      const P = W.worldTagPose(id), R = P.R, hx = Math.hypot(R[0], R[6]), hy = Math.hypot(R[1], R[7]);
      const ax = hx >= hy ? 'x' : 'y', col = ax === 'x' ? [R[0], R[3], R[6]] : [R[1], R[4], R[7]];
      tagW[id] = { c: P.t, ax, axis: add(P.t, mul(col, AXIS_M)), known: !!W.TAGS[id].yawKnown };
    }
    return tagW;
  }
  const fieldChanged = () => { tagW = null; for (const s of ['A', 'B']) S[s].fDirty = S[s].dirty = true; };
  W.onFieldChange(fieldChanged);

  /** Fit from the phone's own sightings of field tags (known world poses): the accurate way. */
  function fitField(s) {
    const st = S[s]; if (!st.sight.length) return null;
    // The sheets' positions are fixed, but how each paper was turned is only known after a scan: until then only the centres count
    // (they need two different sheets to pin the turn), and a sheet's printed axes join in only once its turn is known.
    const tw = tagWorld(), pairs = [], ids = new Set();
    for (const g of st.sight) {
      const tg = tw[g.id]; if (!tg) continue;
      ids.add(g.id);
      pairs.push({ a: tg.c, b: g.b, w: g.w });
      if (tg.known) pairs.push({ a: tg.axis, b: add(g.b, mul(tg.ax === 'x' ? g.bx : g.by, AXIS_M)), w: g.w * 0.5 });
    }
    if (ids.size < 2 && ![...ids].some(id => tw[id].known)) return null; // one centre cannot give the turn
    const T = robustFit(pairs);
    if (T) T.n = st.sight.length; // n = tag sightings (fit4 counted pairs)
    return T;
  }
  const fieldT = s => { const st = S[s]; if (st.fDirty) { st.fDirty = false; st.Tf = fitField(s); } return st.Tf; };

  /** Fit from the OTHER phone's sightings of this phone's chest tag: the other phone is placed by the field tags, so each
   *  sighting says where this phone was (a), and its own AR pose at that instant says where it was in its own world (b).
   *  Needs the sightings to be spread out (one point cannot give the turn); null until they are. */
  function fitChest(s) {
    const ob = OTHER[s], To = fieldT(ob); if (!To || To.n < o.minAlign) return null;
    const pairs = [];
    for (const v of S[ob].seen) {
      const at = poseAt(s, v.t); if (!at) continue;
      pairs.push({ a: apply(To, v.b), b: at.p, w: 0.5 / Math.max(0.5, v.d) ** 2 });
    }
    if (pairs.length < MIN_CHEST) return null;
    const m = [0, 1, 2].map(i => pairs.reduce((x, e) => x + e.a[i] / pairs.length, 0));
    if (Math.max(...pairs.map(e => Math.hypot(e.a[0] - m[0], e.a[2] - m[2]))) < MIN_SPREAD) return null;
    const T = robustFit(pairs);
    if (T) T.n = pairs.length;
    return T;
  }

  /** Field tags decide; the chest-tag fit only stands in while the field fit is missing or too thin. */
  function refit(s) {
    const st = S[s]; st.dirty = false;
    const Tf = fieldT(s); st.T = Tf; st.how = Tf ? 'field' : null;
    if (!Tf || Tf.n < o.minAlign) { const C = fitChest(s); if (C) { st.T = C; st.how = 'chest'; } }
  }
  const T = s => { if (S[s].dirty) refit(s); return S[s].T; }; // lazy: one fit per batch of sightings, however often get() runs

  function ingest(k) {
    if (k?.type === 'phones') { for (const s of ['A', 'B']) S[s].online = k.list?.some(q => q.slot === s) ?? false; return; }
    const s = k?.slot, st = S[s]; if (!st) return;
    loc.onMessage(k); // the fallback runs alongside; cheap
    if (k.type in st.cnt) { // message rates, 1 s buckets
      st.cnt[k.type]++;
      const nowS = k.t ?? 0;
      if (nowS - st.cntAt >= 1) { for (const ty in st.cnt) { st.rate[ty] = st.cnt[ty] / Math.max(1e-3, nowS - st.cntAt); st.cnt[ty] = 0; } st.cntAt = nowS; }
    }
    if (k.t > st.lastT) st.lastT = k.t;
    switch (k.type) {
      case 'ar': {
        if (!k.wp || !k.wq) { st.oldApp = true; return; }
        st.oldApp = false;
        if (k.tracking && k.tracking !== 'TRACKING') return;
        if (st.ar.length && k.t <= st.ar[st.ar.length - 1].t) return;
        st.ar.push({ t: k.t, p: k.wp, q: k.wq });
        while (st.ar[0].t < k.t - o.keep) st.ar.shift();
        if (!st.trail.length || k.t - st.trail[st.trail.length - 1].t > 0.1) st.trail.push({ t: k.t, p: k.wp });
        while (st.trail[0].t < k.t - TRAIL) st.trail.shift();
        return;
      }
      case 'tags': {
        if (k.k) st.k = k.k;
        const pose = poseAt(s, k.t); if (!pose) return;
        const last = [];
        for (const g of k.tags ?? []) {
          if (!g.p || !g.r) continue;
          const sc = W.tagScale(g.id, g.sz), p = [g.p[0] * sc, g.p[1] * sc, g.p[2] * sc], d = Math.hypot(p[0], p[1], p[2]);
          if (!(d > 0.1 && d < 10)) continue;
          const b = camToWorld(pose, p);
          last.push({ id: g.id, b, d, bx: camDir(pose, rodr(g.r, [1, 0, 0])), by: camDir(pose, rodr(g.r, [0, 1, 0])) });
          if (W.TAGS[g.id]?.pos) { // a field tag: two pairs for the fit (centre; axes kept so the field can change later)
            const w = 1 / Math.max(0.5, d) ** 2;
            st.sight.push({ t: k.t, id: g.id, b, bx: camDir(pose, rodr(g.r, [1, 0, 0])), by: camDir(pose, rodr(g.r, [0, 1, 0])), w, d });
            st.fixes++; st.lastFix = k.t; st.fDirty = st.dirty = true; S[OTHER[s]].dirty = true;
          } else if (W.isChestTag(g.id)) { // a chest tag (8-11) is worn by the other player: a phone cannot see its own
            st.seen.push({ t: k.t, b, d }); S[OTHER[s]].dirty = true;
            while (st.seen[0].t < k.t - o.keep) st.seen.shift();
          }
        }
        while (st.sight.length && st.sight[0].t < k.t - o.keep) st.sight.shift();
        if (st.sight.length > 1500) st.sight.splice(0, st.sight.length - 1500); // hot phone at 30 Hz x 4 tags: bound the fit cost
        st.lastTags = { t: k.t, list: last };
        return;
      }
      case 'imu': st.imu = k; return;
      case 'color': if (k.side !== 'me') st.color = k; return; // 'opp' (or the old app's single target)
      case 'calib': { // IMU tare + AR origin reset on the phone; the raw ARCore world does not move, so the fit stays
        st.calibAt = k.t; st.calibPose = latest(s); st.yaw0 = st.imu?.euler ? Math.atan2(...stickH(st.imu.euler, s)) : 0; st.imu = null; return; // heading 0 = where the stick pointed at Calibrate (as actions.js)
      }
    }
  }

  /** World position of the other phone's latest chest-tag sighting of slot s (seen by OTHER[s]), or null. */
  function seenBy(s, maxAge = 0.5, now = Infinity) {
    const ob = OTHER[s], v = S[ob].seen[S[ob].seen.length - 1], To = T(ob);
    if (!v || !To || now - v.t > maxAge) return null;
    return { t: v.t, p: apply(To, v.b), d: v.d };
  }

  function get(slot, now = Date.now() / 1000) { // now: PC seconds (the k.t clock), for freshness
    const st = S[slot];
    const out = { src: null, aligned: false, theta: null, t: null, rms: null, n: 0, used: 0, fixes: st.fixes, lastFix: st.lastFix, world_T_ar: null,
      chest: null, fwd: null, yaw: null, cam: null, trail: [], check: null, checkT: null, seenBy: null, sightings: [], k: st.k, online: st.online,
      calibAt: st.calibAt, how: st.how, hz: st.rate, lastT: st.lastT, oldApp: st.oldApp };
    if (st.oldApp) { // old app: calibration-relative p/q only -> localize.js
      const L = loc.get(slot);
      out.src = 'localize'; out.aligned = L.anchored; out.fixes = L.fixes; out.lastFix = L.lastFix; out.rms = L.err;
      if (L.chest) {
        out.chest = L.chest; out.yaw = L.yaw; out.fwd = [Math.cos(L.yaw), 0, -Math.sin(L.yaw)]; out.cam = L.world_T_arcam;
      }
      return out;
    }
    const Ts = T(slot), a = latest(slot);
    out.how = st.how; // 'field' | 'chest' (placed by the other phone's sightings of the chest tag) | null
    const sb = seenBy(slot, 0.5, now);
    out.seenBy = sb;
    if (Ts) {
      out.theta = Ts.th; out.t = Ts.t; out.rms = Ts.rms; out.n = Ts.n; out.used = Ts.used;
      out.aligned = Ts.n >= o.minAlign;
      out.world_T_ar = { R: rotYMat(Ts.th), t: Ts.t };
      out.trail = st.trail.map(e => apply(Ts, e.p));
      if (st.lastTags && now - st.lastTags.t < 0.5) out.sightings = st.lastTags.list.map(g => { // where the phone sees the tag, in the field world, with its turn
        const x = rotY(Ts.th, g.bx), y = rotY(Ts.th, g.by);
        return { id: g.id, p: apply(Ts, g.b), d: g.d, R: W.fromCols(x, y, cross(x, y)) };
      });
    }
    if (Ts && a) {
      out.src = 'ar';
      out.chest = apply(Ts, a.p);
      const f = rotY(Ts.th, qrot(a.q, [0, 0, -1])); // ARCore camera looks along its -z
      out.fwd = norm([f[0], 0, f[2]]);
      out.yaw = Math.atan2(-out.fwd[2], out.fwd[0]);
      const Rq = W.fromQuat([a.q[3], a.q[0], a.q[1], a.q[2]]);
      out.cam = { R: W.mul3(out.world_T_ar.R, Rq), t: out.chest };
      // cross-check: my AR position at the instant the other phone saw my chest tag, vs where it saw the tag
      const ob = OTHER[slot], v = S[ob].seen[S[ob].seen.length - 1], To = T(ob), at = v && poseAt(slot, v.t);
      if (at && To) { out.check = dist(apply(Ts, at.p), apply(To, v.b)) * 100; out.checkT = v.t; }
    } else if (sb) { // not placed by own AR: where the other phone sees the chest tag
      out.src = 'tag'; out.chest = sb.p;
    }
    return out;
  }

  const IMU_SIDE = cross(W.STICK.axis, W.STICK.up);
  const rotQw = ([w, x, y, z], v) => qrot([x, y, z, w], v); // imu.q is [w,x,y,z]
  const stickH = (euler, s) => { const d = eulerRot(euler, o.axis?.[s] ?? W.STICK.axis); return [d[1], d[0]]; }; // atan2 args: horizontal heading of the stick

  /** Stick direction in the body frame at calibration (x forward, y up, z right).
   *  With euler (WitMotion, gravity-referenced, z up): the same sums as the sensing team's detectors (actions.js), using the
   *  fixed stick axis (IMU +Y; opts.axis[s] may override it) - so the swing that is detected and the
   *  direction it fires along come from one definition. Elevation is absolute; heading is relative to the yaw at Calibrate.
   *  Without euler: imu.q, tared with the stick forward and level, and the default axis. */
  function stickBody(s, st) {
    const axis = o.axis?.[s] ?? W.STICK.axis;
    if (st.imu.euler) {
      const d = eulerRot(st.imu.euler, axis), el = Math.asin(Math.max(-1, Math.min(1, d[2])));
      const hd = Math.atan2(d[1], d[0]) - st.yaw0; // + = turned left (counter-clockwise seen from above)
      return [Math.cos(el) * Math.cos(hd), Math.sin(el), -Math.cos(el) * Math.sin(hd)];
    }
    if (!st.imu.q) return null;
    const v = rotQw(st.imu.q, W.STICK.axis);
    return [dot(v, W.STICK.axis), dot(v, W.STICK.up), dot(v, IMU_SIDE)];
  }
  /** Stick direction in the field world: the body frame at calibration is turned to the world by the phone's yaw at
   *  calibration (AR, aligned later via θ), else by the START mark's yaw (app.js updatePlayer convention). */
  function stick(s, g) {
    const st = S[s]; if (!st.imu) return null;
    const body = stickBody(s, st); if (!body) return null;
    let yaw0 = W.START[s].yaw, src = 'start';
    if (st.calibPose && g.theta != null) { const f = rotY(g.theta, qrot(st.calibPose.q, [0, 0, -1])); yaw0 = Math.atan2(-f[2], f[0]); src = 'calib-ar'; }
    const dir = W.app3(W.bodyPose([0, 0, 0], yaw0).R, body);
    const h = W.STICK.hand, base = g.chest ? W.apply(W.bodyPose(g.chest, g.yaw ?? yaw0, g.chest[1]), [h.fwd, h.up, h.right]) : null;
    return { dir, base, src };
  }

  /** Everything at once; `now` in PC seconds (k.t clock). */
  function estimate(now = Date.now() / 1000) {
    const slots = { A: get('A', now), B: get('B', now) }, warn = [], stickOut = {};
    for (const s of ['A', 'B']) {
      stickOut[s] = stick(s, slots[s]);
      const st = S[s];
      if (st.oldApp) warn.push(`phone ${s}: app sends no gravity-aligned pose (wp/wq): using localize.js`);
      else if (latest(s) && !st.k) warn.push(`phone ${s}: no camera intrinsics yet`);
    }
    return { slots, stick: stickOut, warn };
  }

  return { ingest, get, estimate, onFieldChange: fieldChanged, poseAt, localizer: loc };
}
