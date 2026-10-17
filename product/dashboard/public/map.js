// Best-guess shared 3D map from both phones: ARCore poses, AprilTags (floor corners + chest mounts), stick-tip colour, opponent pose.
// Pure logic, no DOM: the dashboard and test-map.mjs both use it.
// Frames: each phone's ARCore world is gravity-aligned (y up) with its own yaw and origin. B's world is fitted onto A's (yaw + shift)
// from chest-tag sightings and shared floor tags; the room frame then sits on the floor tags (origin = their centre, y = 0 on the floor).

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = a => mul(a, 1 / (Math.hypot(...a) || 1));
export const dist = (a, b) => Math.hypot(...sub(a, b));
export const rotY = (th, v) => { const c = Math.cos(th), s = Math.sin(th); return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]; };
export const qrot = ([x, y, z, w], v) => { const u = [x, y, z], c = cross(u, v); return add(v, add(mul(c, 2 * w), mul(cross(u, c), 2))); };
const qinv = q => [-q[0], -q[1], -q[2], q[3]];
const rodr = (r, v) => { // rotate v by a Rodrigues vector
  const th = Math.hypot(...r); if (th < 1e-9) return v;
  const k = mul(r, 1 / th), c = Math.cos(th);
  return add(add(mul(v, c), mul(cross(k, v), Math.sin(th))), mul(k, dot(k, v) * (1 - c)));
};
// ARCore camera axes follow the landscape sensor image; the phone rotates it 90° CW, so OpenCV portrait (x right, y down, z fwd) = ARCore (Y, X, -Z).
// The swap is its own inverse.
const swap = ([a, b, c]) => [b, a, -c];
const camToWorld = (pose, v) => add(pose.p, qrot(pose.q, swap(v)));
const worldToCam = (pose, p) => swap(qrot(qinv(pose.q), sub(p, pose.p)));
const apply = (T, v) => add(rotY(T.th, v), T.t);
const unapply = (T, v) => rotY(-T.th, sub(v, T.t));
const ID = { th: 0, t: [0, 0, 0] };

const FLOOR_COS = Math.cos(35 * Math.PI / 180); // tag normal within 35° of vertical = floor tag
const HIP_BELOW_CHEST = 0.4; // m, chest mount to hip midpoint (MediaPipe pose depth origin)
const K0 = [1.04, 0.78, 0.5, 0.5]; // fx/W, fy/H, cx/W, cy/H guess for apps that don't send intrinsics
const KEEP = 20; // s of AR history and chest sightings used for the A<->B fit
const other = s => s === 'A' ? 'B' : 'A';

/** Weighted least-squares yaw + translation with a ≈ rotY(th, b) + t. */
function fit4(c) {
  let W = 0, ma = [0, 0, 0], mb = [0, 0, 0];
  for (const e of c) { W += e.w; ma = add(ma, mul(e.a, e.w)); mb = add(mb, mul(e.b, e.w)); }
  ma = mul(ma, 1 / W); mb = mul(mb, 1 / W);
  let sc = 0, ss = 0, sp = 0;
  for (const e of c) {
    const A = sub(e.a, ma), B = sub(e.b, mb);
    sc += e.w * (A[0] * B[0] + A[2] * B[2]); ss += e.w * (A[0] * B[2] - A[2] * B[0]); sp += e.w * (B[0] ** 2 + B[2] ** 2);
  }
  const th = Math.atan2(ss, sc), T = { th, t: sub(ma, rotY(th, mb)) };
  T.rms = Math.sqrt(c.reduce((s, e) => s + e.w * dist(e.a, apply(T, e.b)) ** 2, 0) / W);
  T.spread = Math.sqrt(sp / W); // horizontal spread of the points: too small and the yaw is a guess
  T.n = c.length;
  return T;
}

/** fit4 with outliers (bad tag poses) dropped. */
function robustFit(c) {
  if (c.length < 2) return null;
  let T = fit4(c);
  for (let i = 0; i < 3; i++) {
    const r = c.map(e => dist(e.a, apply(T, e.b))), med = [...r].sort((x, y) => x - y)[r.length >> 1];
    const keep = c.filter((_, j) => r[j] <= Math.max(0.15, 3 * med));
    if (keep.length === c.length || keep.length < 2) break;
    c = keep; T = fit4(c);
  }
  return T;
}

export function createMap() {
  const slots = {};
  for (const s of ['A', 'B']) slots[s] = { ar: [], trail: [], floor: {}, seen: [], k: null, color: null, pose: null, lastTip: null, oldApp: false };

  /** Camera pose of phone s at time t, interpolated, in its own AR world. */
  function poseAt(s, t) {
    const a = slots[s].ar; if (!a.length) return null;
    let lo = 0, hi = a.length - 1;
    if (t <= a[0].t) return a[0].t - t < 0.05 ? a[0] : null;
    if (t >= a[hi].t) return t - a[hi].t < 0.05 ? a[hi] : null;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m].t <= t) lo = m; else hi = m; }
    const p = a[lo], q = a[hi];
    if (q.t - p.t > 0.2) return null; // tracking gap
    const f = (t - p.t) / (q.t - p.t), sg = p.q.reduce((s, v, i) => s + v * q.q[i], 0) < 0 ? -1 : 1;
    const qq = p.q.map((v, i) => v + f * (sg * q.q[i] - v)), n = Math.hypot(...qq);
    return { t, p: add(p.p, mul(sub(q.p, p.p), f)), q: qq.map(v => v / n) };
  }

  function ingest(k) {
    const s = slots[k.slot]; if (!s) return;
    if (k.type === 'ar') {
      if (!k.wp) { s.oldApp = true; return; }
      if (k.tracking !== 'TRACKING' || (s.ar.length && k.t <= s.ar.at(-1).t)) return;
      s.ar.push({ t: k.t, p: k.wp, q: k.wq });
      while (s.ar[0].t < k.t - KEEP) s.ar.shift();
      if (!s.trail.length || k.t - s.trail.at(-1).t > 0.1) s.trail.push({ t: k.t, p: k.wp });
      while (s.trail[0].t < k.t - 15) s.trail.shift();
    } else if (k.type === 'tags') {
      if (k.k) s.k = k.k;
      const pose = poseAt(k.slot, k.t); if (!pose) return;
      for (const g of k.tags) {
        if (!g.p) continue;
        const d = Math.hypot(...g.p); if (d > 6) continue;
        const p = camToWorld(pose, g.p), n = qrot(pose.q, swap(rodr(g.r, [0, 0, 1])));
        if (Math.abs(n[1]) > FLOOR_COS) {
          const x = qrot(pose.q, swap(rodr(g.r, [1, 0, 0]))), xh = norm([x[0], 0, x[2]]);
          const f = s.floor[g.id] ??= { p, x: xh, n: 0 };
          const a = Math.max(1 / ++f.n, 0.05); // running mean, then a slow EMA so ARCore drift is followed
          f.p = add(f.p, mul(sub(p, f.p), a)); f.x = add(f.x, mul(sub(xh, f.x), a));
        } // any other standing tag is fixed in the room, not a chest mount: ignored here
      }
    } else if (k.type === 'color') s.color = k;
    else if (k.type === 'pose') s.pose = k;
  }

  /** Everything in room coordinates (m): x/z on the floor, y up from the floor. L = stick length per holder. */
  function estimate({ now, L = {} }) {
    const warn = [];
    const live = s => { const a = slots[s].ar.at(-1); return a && now - a.t < 1 ? a : null; };
    for (const s of ['A', 'B']) {
      if (slots[s].oldApp) warn.push(`phone ${s}: app sends no gravity-aligned pose (wp/wq); rebuild it`);
      else if (live(s) && !slots[s].k) warn.push(`phone ${s}: no camera intrinsics yet, using a guess`);
    }

    // 1. B's AR world onto A's: chest sighting <-> the other phone's own AR position at the same instant, plus shared floor tags
    const corr = [];
    for (const s of ['A', 'B']) for (const v of slots[s].seen) {
      const op = poseAt(other(s), v.t); if (!op) continue;
      const w = 1 / Math.max(1, v.d) ** 2; // tag depth error grows ~d²
      corr.push(s === 'A' ? { a: v.p, b: op.p, w } : { a: op.p, b: v.p, w });
    }
    let shared = 0;
    for (const id in slots.A.floor) {
      const fa = slots.A.floor[id], fb = slots.B.floor[id]; if (!fb) continue;
      shared++; // the point 0.5 m along the tag's printed x axis pins the yaw even from one tag
      corr.push({ a: fa.p, b: fb.p, w: 10 }, { a: add(fa.p, mul(norm(fa.x), 0.5)), b: add(fb.p, mul(norm(fb.x), 0.5)), w: 5 });
    }
    const T = robustFit(corr), aligned = !!T && T.spread > 0.15;
    const ref = live('A') || !live('B') ? 'A' : 'B';
    const toM = { A: null, B: null };
    toM[ref] = ID;
    if (aligned) toM[other(ref)] = ref === 'A' ? T : { th: -T.th, t: rotY(-T.th, mul(T.t, -1)) };
    const M = (s, v) => apply(toM[s], v), Md = (s, v) => rotY(toM[s].th, v);

    // 2. room frame from the floor tags
    const acc = {};
    for (const s of ['A', 'B']) {
      if (!toM[s]) continue;
      for (const [id, f] of Object.entries(slots[s].floor)) {
        const w = Math.min(f.n, 50), e = acc[id] ??= { id: +id, p: [0, 0, 0], x: [0, 0, 0], w: 0 };
        e.p = add(e.p, mul(M(s, f.p), w)); e.x = add(e.x, mul(Md(s, f.x), w)); e.w += w;
      }
    }
    const tags = Object.values(acc).map(e => ({ id: e.id, p: mul(e.p, 1 / e.w), x: norm(e.x) })).sort((a, b) => a.id - b.id);
    let room = { th: 0, o: [0, 0, 0] };
    if (tags.length) {
      const first = tags[0], next = tags.slice(1).sort((a, b) => dist(a.p, first.p) - dist(b.p, first.p))[0];
      const d = next ? sub(next.p, first.p) : first.x; // room +x: lowest id tag towards its nearest neighbour
      room = { th: Math.atan2(d[2], d[0]), o: mul(tags.reduce((a, e) => add(a, e.p), [0, 0, 0]), 1 / tags.length) };
    } else warn.push(`no floor tags seen yet: heights are relative to phone ${ref}'s AR start`);
    const toRoom = v => rotY(room.th, sub(v, room.o));
    const R = (s, v) => toRoom(M(s, v)), Rd = (s, v) => rotY(room.th, Md(s, v));

    // 3. people: own AR pose when mappable, else where the other phone sees their chest tag
    const people = {};
    for (const s of ['A', 'B']) {
      const a = live(s), o = other(s), v = slots[o].seen.at(-1);
      const tag = v && now - v.t < 0.5 && toM[o] ? R(o, v.p) : null;
      if (a && toM[s]) {
        const f = Rd(s, qrot(a.q, [0, 0, -1]));
        people[s] = { t: a.t, p: R(s, a.p), fwd: norm([f[0], 0, f[2]]), src: 'AR', tag, trail: slots[s].trail.map(e => R(s, e.p)) };
        const at = tag && poseAt(s, v.t);
        if (at) people[s].check = dist(R(s, at.p), tag); // AR vs tag disagreement, same instant
      } else if (tag) people[s] = { t: v.t, p: tag, src: `tag seen by ${o}`, tag, trail: [] };
    }

    // 4. opponent body and stick tip, from what each phone sees
    const bodies = {}, tips = {};
    for (const s of ['A', 'B']) {
      const S = slots[s], o = other(s), K = S.k ?? K0;
      if (!toM[s]) continue;
      // camera depth of the opponent's hip midpoint at time t: fresh chest tag, else their own AR position
      const hipDepth = (cam, t) => {
        const v = S.seen.at(-1), op = toM[o] && poseAt(o, t);
        const chest = v && Math.abs(v.t - t) < 0.3 ? v.p : op ? unapply(toM[s], M(o, op.p)) : null;
        return chest && worldToCam(cam, sub(chest, [0, HIP_BELOW_CHEST, 0]))[2];
      };
      const ray = (u, v) => [(u - K[2]) / K[0], (v - K[3]) / K[1], 1];

      const P = S.pose, pcam = P?.found && now - P.t < 0.5 && poseAt(s, P.t);
      const D = pcam && hipDepth(pcam, P.t);
      // MediaPipe pose z: depth from the hip midpoint, in units of image width
      const lm = D > 0.3 ? P.lm.map(([u, v, z, vis]) => vis > 0.5 ? camToWorld(pcam, mul(ray(u, v), D + z * D / K[0])) : null) : null;
      if (lm) bodies[o] = lm.map(p => p && R(s, p));

      const C = S.color, cam = C?.found && now - C.t < 0.5 && poseAt(s, C.t);
      const Dc = cam && hipDepth(cam, C.t);
      if (!(Dc > 0.3)) continue;
      const d = ray(C.x, C.y), len = L[o] ?? 1;
      const hand = lm && [15, 16].filter(i => lm[i]).sort((i, j) => Math.hypot(P.lm[i][0] - C.x, P.lm[i][1] - C.y) - Math.hypot(P.lm[j][0] - C.x, P.lm[j][1] - C.y))[0];
      const wrist = hand != null ? worldToCam(cam, lm[hand]) : null;
      let lam, src;
      if (wrist) { // tip is on my viewing ray, one stick length from the wrist nearest to it in the image
        const a = dot(d, d), b = dot(d, wrist), disc = b * b - a * (dot(wrist, wrist) - len * len);
        if (disc >= 0) {
          const r1 = (b - Math.sqrt(disc)) / a, r2 = (b + Math.sqrt(disc)) / a;
          const prev = S.lastTip && C.t - S.lastTip.t < 0.3 ? worldToCam(cam, S.lastTip.p) : null;
          const elbow = lm[hand - 2] && worldToCam(cam, lm[hand - 2]);
          const along = r => dot(norm(sub(mul(d, r), wrist)), norm(sub(wrist, elbow)));
          // two solutions: the one nearest the last tip, else the one continuing the forearm, else the nearer one
          lam = prev ? (dist(mul(d, r1), prev) <= dist(mul(d, r2), prev) ? r1 : r2)
            : elbow ? (along(r1) >= along(r2) ? r1 : r2) : r1 > 0.2 ? r1 : r2;
          src = 'stick length';
        } else { lam = b / a; src = 'closest to wrist'; }
      } else { lam = Dc; src = 'opponent depth'; }
      if (!(lam > 0.1)) continue;
      const tw = camToWorld(cam, mul(d, lam));
      S.lastTip = { t: C.t, p: tw };
      tips[o] = { t: C.t, p: R(s, tw), wrist: wrist && R(s, camToWorld(cam, wrist)), src, target: C.target, hit: people[s] ? dist(R(s, tw), people[s].p) : null };
    }

    return {
      people, tips, bodies, floorKnown: tags.length > 0, aligned, warn,
      corners: tags.map(e => ({ id: e.id, p: toRoom(e.p) })),
      align: T && { pairs: T.n, rms: T.rms, spread: T.spread, shared },
    };
  }

  return { ingest, estimate };
}
