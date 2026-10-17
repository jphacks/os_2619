// Broadcast "drone" camera for the 3D view: fixed shots plus an auto director that reacts to game events.
// Smoothing chain per frame: shot generator -> blend from the last pose (cylindrical around the players, so it arcs
// instead of cutting through them) -> safety (floor, 1 m from bodies) -> critically damped spring -> speed clamp
// -> yaw/pitch rate limit (roll is always 0 apart from shake). World frame from world.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as W from './world.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const { clamp, lerp } = THREE.MathUtils, D2R = Math.PI / 180;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const ease = s => s <= 0 ? 0 : s >= 1 ? 1 : s * s * s * (s * (s * 6 - 15) + 10); // smootherstep
const flat = v => V(v.x, 0, v.z);
const az = (p, c) => Math.atan2(p.z - c.z, p.x - c.x);
const fromAz = (c, a, r, y) => V(c.x + Math.cos(a) * r, y, c.z + Math.sin(a) * r);

const MODES = ['auto', 'orbit', 'chaseA', 'chaseB', 'top', 'side', 'free'];
const DEFAULTS = {
  fovWide: 50, fovTight: 32,   // vertical degrees
  blend: 0.8,                  // s, mode switch blend (longer for big sweeps around the players)
  minDist: 1.05, minY: 0.6,    // m, from the body axis (feet to head) / from the floor
  maxSpeed: 7,                 // m/s
  maxYawRate: 80, maxPitchRate: 50, // deg/s
  sweepRate: 50, sweepRateManual: 120, // deg/s peak swing around the players during a blend (auto / key press)
  shake: 1,                    // hit shake scale, 0 = off
  eventCooldown: 4,            // s from the end of one shot/hit reaction to the next (the demo fires every 0.4 s)
  seed: 1,
};

// Exact critically damped spring step toward a fixed target (stable for any dt).
const _d = V(), _c = V();
function spring(x, v, T, w, dt) {
  const e = Math.exp(-w * dt);
  _d.subVectors(x, T); _c.copy(v).addScaledVector(_d, w);
  x.copy(T).addScaledVector(_d, e).addScaledVector(_c, dt * e);
  v.multiplyScalar(e).addScaledVector(_c, -w * dt * e);
}
function spring1(s, k, T, w, dt) { // s = { [k]: x, [k + 'V']: v }
  const e = Math.exp(-w * dt), d = s[k] - T, c = s[k + 'V'] + w * d;
  s[k] = T + (d + c * dt) * e; s[k + 'V'] = (s[k + 'V'] - w * c * dt) * e;
}
const rng = seed => () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

export function createDrone(camera, domElement, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rand = rng(o.seed);
  camera.rotation.order = 'YXZ';
  const controls = domElement ? new OrbitControls(camera, domElement) : null;
  if (controls) { controls.enabled = false; controls.enableDamping = true; controls.dampingFactor = 0.08; }

  // ---- smoothed players ----
  const S = { a: V(), b: V(), ca: V(), cb: V(), mid: V(), axis: 0, sep: 2.4, yawA: 0, yawB: Math.PI, ready: false };
  // ---- the field (world.js FIELD.poly): any quadrilateral, any size. Its extent sizes the orbit / top shot / keep-in
  // radius; recomputed only when setField replaced the outline (new array), so the per-frame cost is one compare ----
  const F = { poly: null, c: V(), R: 2.83, hx: 2, hz: 2, corners: [] };
  function syncField() {
    if (F.poly === W.FIELD.poly) return;
    const P = F.poly = W.FIELD.poly, xs = P.map(p => p[0]), zs = P.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    F.c.set((x0 + x1) / 2, 0, (z0 + z1) / 2); F.hx = (x1 - x0) / 2; F.hz = (z1 - z0) / 2;
    F.R = Math.max(...P.map(p => Math.hypot(p[0], p[1])));
    F.corners = P.map(p => V(p[0], 0, p[1]));
  }
  syncField();
  const startChest = k => V(W.START[k].pos[0], W.CHEST_H, W.START[k].pos[2]);
  function trackPlayers(players, dt) {
    const pa = players?.A?.chest ?? startChest('A'), pb = players?.B?.chest ?? startChest('B');
    if (!S.ready) { S.a.copy(pa); S.b.copy(pb); S.ca.copy(pa); S.cb.copy(pb); S.axis = az(pb, pa); S.ready = true; }
    const k1 = 1 - Math.exp(-dt / 0.15), k2 = 1 - Math.exp(-dt / 0.3); // general / chase (walking bob filtered out)
    S.a.lerp(pa, k1); S.b.lerp(pb, k1); S.ca.lerp(pa, k2); S.cb.lerp(pb, k2);
    S.yawA = players?.A?.yaw ?? S.yawA; S.yawB = players?.B?.yaw ?? S.yawB;
    S.mid.addVectors(S.a, S.b).multiplyScalar(0.5);
    S.sep = flat(S.b).distanceTo(flat(S.a));
    if (S.sep > 0.3) { // A->B direction, slew-limited so players crossing doesn't whip the side view
      const d = wrap(az(S.b, S.a) - S.axis);
      S.axis = wrap(S.axis + clamp(d * (1 - Math.exp(-dt / 0.4)), -60 * D2R * dt, 60 * D2R * dt));
    }
  }
  const chest = k => k === 'A' ? S.a : S.b;
  const chaseChest = k => k === 'A' ? S.ca : S.cb;
  const other = k => k === 'A' ? 'B' : 'A';

  // ---- camera state ----
  const cur = { pos: V(0, 4.5, 6), vel: V(), look: V(0, 1, 0), lookV: V(), fov: o.fovWide, fovV: 0, yaw: 0, pitch: 0 };
  let t = 0, shot = null, blend = null, shakeAmp = 0, shakeT = 0, inited = false;

  // Keep-out volume of a player: vertical segment from the floor to the top of the head.
  const HEAD = 1.95;
  const bodyDist = (p, c) => p.distanceTo(V(c.x, clamp(p.y, 0.1, HEAD), c.z));
  // Event shots: is player k at least `near` m from the camera and off the camera->look line (with margin)?
  function clear(pos, look, k, near = 1.6) {
    const c = chest(k);
    if (bodyDist(pos, c) < near) return false;
    for (let i = 1; i <= 24; i++) {
      const q = pos.clone().lerp(look, i / 24);
      if (q.y < HEAD + 0.1 && Math.hypot(q.x - c.x, q.z - c.z) < 0.55) return false;
    }
    return true;
  }
  // Push a point out of the players' bodies and keep it above the floor / near the arena.
  function safe(p) {
    for (const c of [S.a, S.b]) {
      const q = V(c.x, clamp(p.y, 0.2, HEAD), c.z), d = p.clone().sub(q), n = d.length();
      if (n < o.minDist) p.copy(q).addScaledVector(n > 1e-4 ? d.divideScalar(n) : V(0, 1, 0), o.minDist);
    }
    const far = Math.max(9, F.R + 5); // keep-in radius around the field
    p.y = clamp(p.y, o.minY, far);
    const h = Math.hypot(p.x, p.z); if (h > far) { p.x *= far / h; p.z *= far / h; }
    return p;
  }

  // Move the camera back along its view line until every point sits inside `m` of the frame.
  const _f = V(), _r = V(), _u = V(), _q = V();
  function fit(pose, pts, m = 0.82) {
    _f.subVectors(pose.look, pose.pos).normalize();
    _r.crossVectors(_f, V(0, 1, 0)).normalize(); _u.crossVectors(_r, _f);
    const tv = Math.tan(pose.fov * D2R / 2) * m, th = tv * (camera.aspect || 16 / 9);
    let back = 0;
    for (const p of pts) {
      _q.subVectors(p, pose.pos);
      const z = _q.dot(_f), need = Math.max(Math.abs(_q.dot(_r)) / th, Math.abs(_q.dot(_u)) / tv);
      back = Math.max(back, need - z);
    }
    if (back > 0) pose.pos.addScaledVector(_f, -back);
    return pose;
  }
  const bodyPts = () => [S.a, S.b].flatMap(c => [V(c.x, c.y + 0.55, c.z), V(c.x, Math.max(0.2, c.y - 0.9), c.z)]);

  // ---- shots: gen(dt) returns { pos, look, fov } ----
  const camAz = (c = S.mid) => az(cur.pos, c);
  const shots = {
    orbit() {
      let ph = camAz();
      // auto: drift toward the nearer side-on angle, so the players don't hide each other for long
      const perp = S.axis + Math.PI / 2 * (wrap(ph - S.axis) >= 0 ? 1 : -1);
      const turn = mode === 'auto' ? (wrap(perp - ph) >= 0 ? 1 : -1) : 1;
      return { name: 'orbit', w: 2.5, gen(dt) {
        ph += turn * 0.14 * dt; // ~8 deg/s
        const r = clamp(3.4 + 0.65 * S.sep, clamp(F.R + 2.6, 3.8, 4.6), Math.max(7, F.R + 3)), along = Math.abs(Math.cos(ph - S.axis)); // 1 = looking down the A-B line
        return fit({ pos: fromAz(S.mid, ph, r, 2.5 + 1.0 * along), look: V(S.mid.x, 1.0, S.mid.z), fov: o.fovWide }, bodyPts());
      } };
    },
    side() {
      const n = () => { const u = V(Math.cos(S.axis), 0, Math.sin(S.axis)); return V(u.z, 0, -u.x); }; // view dir: A left, B right
      const sign = n().dot(flat(cur.pos).sub(flat(S.mid))) > 0 ? -1 : 1; // stay on the side the camera is on
      return { name: 'side', w: 2.5, gen() {
        const pos = S.mid.clone().addScaledVector(n(), -3.4 * sign); pos.y = 1.6;
        return fit({ pos, look: V(S.mid.x, 1.1, S.mid.z), fov: o.fovWide }, bodyPts(), 0.78);
      } };
    },
    top() {
      return { name: 'top', w: 2, gen() {
        const c = F.c.clone().lerp(flat(S.mid), 0.3), y = Math.max(4.5, 1.2 * F.R + 3.6); // 7 m up for the old 4 m square; fit() backs off if a corner is out
        return fit({ pos: V(c.x, y, c.z + 0.34 * y), look: c.clone(), fov: o.fovWide }, [...F.corners, ...bodyPts()], 0.92);
      } };
    },
    chase(k) {
      return { name: 'chase' + k, w: 3, gen() {
        const c = chaseChest(k), op = chaseChest(other(k));
        let f = flat(op).sub(flat(c));
        if (f.length() < 0.3) { const y = k === 'A' ? S.yawA : S.yawB; f = V(Math.cos(y), 0, -Math.sin(y)); }
        f.normalize(); const r = V(-f.z, 0, f.x);
        const pos = c.clone().addScaledVector(f, -1.7).addScaledVector(r, 0.9); pos.y = 2.1; // over the right shoulder
        const look = c.clone().lerp(op, 0.8); look.y = 1.1; // player on the left third, opponent centre
        return { pos, look, fov: o.fovWide };
      } };
    },
    // events
    follow(owner, from, dir) { // behind the shooter along the projectile, or a pan from here if that's a big swing
      const d = dir.clone().normalize(), dh = flat(d).normalize(), rr = V(-dh.z, 0, dh.x), c0 = chest(owner).clone();
      const behind = c0.clone().addScaledVector(dh, -2.0).addScaledVector(rr, 0.8); behind.y = 2.2; // above the shooter's head
      const near = Math.abs(wrap(az(behind, S.mid) - camAz())) < 60 * D2R;
      const stay = cur.pos.clone().lerp(S.mid, 0.12), far = from.clone().addScaledVector(d, Math.max(2, S.sep));
      let e = 0;
      return { name: 'shot' + owner, w: 2.5, dur: 1.8, prio: 1, blend: 0.7, gen(dt) {
        e += dt;
        const k = ease(e / 1.2); // look runs shooter -> target, slower than the ball so the pan stays gentle
        const look = near ? from.clone().lerp(far, 0.3 + 0.5 * k) : S.mid.clone().lerp(from.clone().lerp(far, k), 0.35);
        look.y = clamp(look.y, 0.6, 2.0);
        return { pos: near ? behind : stay, look, fov: lerp(o.fovWide, o.fovTight, near ? 0.35 : 0.2) };
      } };
    },
    hit(target, at, power) {
      // push in from the camera's side; rotate around the impact until the attacker is out of the way, else go wide
      const p0 = at.clone(), a0 = az(cur.pos, p0), d0 = flat(cur.pos).distanceTo(flat(p0)), dd = clamp(d0 * 0.6, 2.2, 3.2);
      let pos = null, fov = lerp(o.fovWide, o.fovTight, 0.4 + 0.3 * power);
      for (const off of [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100]) {
        const q = fromAz(p0, a0 + off * D2R, dd, Math.max(p0.y + 0.3, 1.6));
        if (clear(q, p0, other(target))) { pos = q; break; }
      }
      if (!pos) { // nothing clean: wide and high, looking over the attacker
        const q = fromAz(p0, a0, Math.max(d0, 4), 3.2); pos = q; fov = o.fovWide;
      }
      return { name: 'hit' + target, w: 5, dur: 1.3, prio: 2, blend: 0.3, gen() {
        return { pos: pos.clone(), look: p0.clone(), fov };
      } };
    },
    special(owner, to) {
      const tg = (to ?? chest(other(owner))).clone(), aO = az(chest(owner), tg);
      const pref = wrap(camAz(tg) - aO) >= 0 ? 1 : -1; // on the camera's side of the beam
      // arc swings from beside the beam to behind the target; take the first (side, arc) that keeps the caster clear
      const pose = (turn, a, b, k, wide) => {
        const look = tg.clone().lerp(chest(owner), 0.3 * (1 - k)); look.y = 1.15;
        return { pos: fromAz(tg, aO + turn * lerp(a, b, k) * D2R, wide ? 4.5 : 3.0 - 0.5 * k, wide ? 3.0 : 1.5 + 0.5 * k), look };
      };
      let plan = null;
      for (const [turn, a, b] of [[pref, 55, 120], [-pref, 55, 120], [pref, 80, 150], [-pref, 80, 150]])
        if ([0, 0.5, 1].every(k => { const q = pose(turn, a, b, k); return clear(q.pos, tg, owner); })) { plan = [turn, a, b, false]; break; }
      plan ??= [pref, 70, 130, true];
      let e = 0;
      return { name: 'special' + owner, w: 2.2, dur: 2.4, prio: 3, blend: 0.7, gen(dt) {
        e += dt;
        const k = ease(e / 2.4), q = pose(plan[0], plan[1], plan[2], k, plan[3]);
        return { ...q, fov: plan[3] ? o.fovWide : lerp(o.fovWide + 8, o.fovTight, k) };
      } };
    },
    charge(owner) {
      const c = () => chaseChest(owner), f = () => flat(chaseChest(other(owner))).sub(flat(c())).normalize();
      const pref = Math.sign(V(-f().z, 0, f().x).dot(flat(cur.pos).sub(flat(c())))) || 1;
      const at = (ang, R) => { const fv = f(); return fromAz(c(), Math.atan2(fv.z, fv.x) + ang * D2R, R, 1.6); };
      let ang = null; // 3/4 front, opponent kept clear at both ends of the push-in
      for (const a of [75, 100, 125, 150]) for (const sd of [pref, -pref])
        if (ang == null && [3.0, 1.9].every(R => clear(at(sd * a, R), V(c().x, 1.2, c().z), other(owner)))) ang = sd * a;
      ang ??= pref * 160;
      let e = 0;
      return { name: 'charge' + owner, w: 2, dur: 2.2, prio: 1, blend: 0.8, gen(dt) {
        e += dt;
        const fv = f(), a = Math.atan2(fv.z, fv.x) + ang * D2R, R = lerp(3.0, 1.9, ease(e / 2.2));
        return { pos: fromAz(c(), a, R, 1.6), look: V(c().x, 1.2, c().z), fov: lerp(o.fovWide, o.fovTight, ease(e / 2.2) * 0.8) };
      } };
    },
  };
  const make = name => name.startsWith('chase') ? shots.chase(name.slice(5)) : shots[name]();

  // ---- director ----
  const dir = { base: null, since: 0, until: 0, ev: null, evEnd: -99, lastChase: 'B' };
  function nextBase() {
    const prev = dir.base?.name ?? '';
    let pick;
    if (prev.startsWith('chase')) pick = rand() < 0.5 ? 'orbit' : 'side';
    else {
      const opts2 = ['orbit', 'side', 'chase'].filter(n => n !== prev);
      pick = opts2[Math.floor(rand() * opts2.length)];
    }
    if (pick === 'chase') { // the chase nearer the camera, so the move is short; alternate on ties
      const dA = Math.abs(wrap(az(S.a, S.mid) + Math.PI - camAz())), dB = Math.abs(wrap(az(S.b, S.mid) + Math.PI - camAz()));
      const k = Math.abs(dA - dB) < 20 * D2R ? other(dir.lastChase) : dA < dB ? 'A' : 'B';
      pick = 'chase' + k; dir.lastChase = k;
    }
    dir.base = make(pick);
    dir.since = t; dir.until = t + (pick.startsWith('chase') ? 4 + 1.5 * rand() : 4.5 + 2.5 * rand());
    return dir.base;
  }

  // ---- mode / transitions ----
  let mode = MODES.includes(o.mode) ? o.mode : 'auto';
  function startShot(s, dur = o.blend) {
    if (inited) {
      const target = s.gen(0);
      const sweep = Math.abs(wrap(az(target.pos, S.mid) - camAz()));
      let rate = (mode === 'auto' ? o.sweepRate : o.sweepRateManual) * D2R;
      if (s.dur) rate = clamp(1.875 * sweep / (0.6 * s.dur), rate, 90 * D2R); // an event shot must land while it matters
      dur = Math.max(dur, 1.875 * sweep / rate); // smootherstep peaks at 1.875x the mean rate
      blend = { from: { pos: cur.pos.clone(), look: cur.look.clone(), fov: cur.fov }, t0: t, dur };
    }
    shot = s;
  }
  function setMode(m, { cut = false } = {}) {
    if (!MODES.includes(m)) return;
    mode = m;
    if (controls) { controls.enabled = m === 'free'; if (m === 'free') { controls.target.copy(cur.look); controls.update(); } }
    if (m === 'free') {
      if (!inited) { camera.position.copy(cur.pos); camera.lookAt(cur.look); controls?.target.copy(cur.look); inited = true; }
      shot = { name: 'free' }; blend = null; return;
    }
    dir.ev = null;
    startShot(m === 'auto' ? nextBase() : make(m), cut ? 0 : o.blend);
    if (cut) blend = null, inited = false;
  }

  function event(type, data = {}) {
    if (!S.ready) trackPlayers(null, 0);
    if (type === 'hit') shakeAmp = Math.max(shakeAmp, o.shake * (0.35 + 0.6 * clamp(data.power ?? 0.5, 0, 1))), shakeT = 0;
    if (mode !== 'auto') return;
    let s = null;
    const cool = !dir.ev && t - dir.evEnd > o.eventCooldown && t - dir.since > 2; // let a shot breathe
    const v3 = a => a?.isVector3 ? a : Array.isArray(a) ? V(...a) : null;
    if (type === 'special') s = shots.special(data.owner ?? 'A', v3(data.to));
    else if (type === 'hit' && (cool || (dir.ev?.name.startsWith('shot') && t < dir.evEnd))) s = shots.hit(data.target ?? 'B', v3(data.pos) ?? chest(data.target ?? 'B'), clamp(data.power ?? 0.5, 0, 1));
    else if (type === 'shot' && cool) s = shots.follow(data.owner ?? 'A', v3(data.pos) ?? chest(data.owner ?? 'A'), v3(data.dir) ?? flat(chest(other(data.owner ?? 'A'))).sub(flat(chest(data.owner ?? 'A'))));
    else if (type === 'charge' && (data.level ?? 0) >= 0.999 && !(dir.ev?.prio >= 1 && t < dir.evEnd)) s = shots.charge(data.owner ?? 'A');
    if (!s) return;
    if (dir.ev && t < dir.evEnd && dir.ev.prio > s.prio) return;
    if (dir.ev && dir.ev.name === s.name && t - (dir.evEnd - dir.ev.dur) < 0.5) return; // same reaction just started
    dir.ev = s; dir.evEnd = t + s.dur;
    startShot(s, s.blend);
  }

  function update(dt, players) {
    dt = clamp(dt, 0, 0.1); t += dt;
    syncField();
    trackPlayers(players, dt);
    if (!shot) setMode(mode);
    if (mode === 'free') {
      controls?.update();
      cur.pos.copy(camera.position); cur.look.copy(controls?.target ?? cur.look); cur.vel.set(0, 0, 0); cur.lookV.set(0, 0, 0);
      const d = cur.look.clone().sub(cur.pos).normalize(); cur.yaw = Math.atan2(-d.x, -d.z); cur.pitch = Math.asin(d.y);
      camera.updateProjectionMatrix();
      return;
    }
    if (mode === 'auto') {
      if (dir.ev && t >= dir.evEnd) { // back to the base shot, or a fresh one if it ran out meanwhile
        dir.ev = null;
        if (t + 2 > dir.until) nextBase(); else dir.since = t;
        startShot(dir.base, 1.2);
      } else if (!dir.ev && t >= dir.until) startShot(nextBase(), 1.4);
    }
    const g = shot.gen(dt);
    let tgt = { pos: g.pos.clone(), look: g.look.clone(), fov: g.fov };
    if (blend) {
      const s = ease((t - blend.t0) / blend.dur), f = blend.from, c = flat(S.mid);
      if (s >= 1) blend = null;
      else { // arc around the players: azimuth / radius / height
        const a0 = az(f.pos, c), a1 = az(tgt.pos, c), r0 = flat(f.pos).distanceTo(c), r1 = flat(tgt.pos).distanceTo(c);
        tgt.pos = fromAz(c, a0 + wrap(a1 - a0) * s, lerp(r0, r1, s), lerp(f.pos.y, tgt.pos.y, s));
        tgt.look = f.look.clone().lerp(tgt.look, s); tgt.fov = lerp(f.fov, tgt.fov, s);
      }
    }
    safe(tgt.pos);
    if (!inited) { cur.pos.copy(tgt.pos); cur.look.copy(tgt.look); cur.fov = tgt.fov; cur.vel.set(0, 0, 0); cur.lookV.set(0, 0, 0); cur.fovV = 0; }
    const prev = cur.pos.clone();
    spring(cur.pos, cur.vel, tgt.pos, shot.w ?? 2.5, dt);
    spring(cur.look, cur.lookV, tgt.look, (shot.w ?? 2.5) * 1.4, dt);
    spring1(cur, 'fov', tgt.fov, 2.5, dt);
    const step = cur.pos.clone().sub(prev), lim = o.maxSpeed * dt;
    if (step.length() > lim) { cur.pos.copy(prev).addScaledVector(step.normalize(), lim); cur.vel.clampLength(0, o.maxSpeed); }
    safe(cur.pos);

    const d = cur.look.clone().sub(cur.pos).normalize();
    const yaw = Math.atan2(-d.x, -d.z), pitch = clamp(Math.asin(d.y), -82 * D2R, 60 * D2R);
    if (!inited) { cur.yaw = yaw; cur.pitch = pitch; inited = true; }
    cur.yaw = wrap(cur.yaw + clamp(wrap(yaw - cur.yaw), -o.maxYawRate * D2R * dt, o.maxYawRate * D2R * dt));
    cur.pitch += clamp(pitch - cur.pitch, -o.maxPitchRate * D2R * dt, o.maxPitchRate * D2R * dt);

    // shake: smooth noise, decays in ~0.4 s, tiny roll allowed
    shakeT += dt; shakeAmp *= Math.exp(-6 * dt);
    const n = k => Math.sin(shakeT * 31 + k) * 0.6 + Math.sin(shakeT * 47 + 2 * k) * 0.4, a = shakeAmp * D2R;
    camera.position.copy(cur.pos);
    camera.rotation.set(cur.pitch + n(1) * a, cur.yaw + n(2) * a, n(3) * a * 0.5, 'YXZ');
    camera.fov = cur.fov; camera.updateProjectionMatrix();
    if (controls) controls.target.copy(cur.look); // free mode starts from what we were looking at
  }

  return {
    modes: MODES,
    get mode() { return mode; },
    get shot() { return mode === 'free' ? 'free' : shot?.name ?? ''; },
    get blending() { return !!blend; },
    opts: o,
    setMode,
    next() { setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]); },
    event, update,
    dispose() { controls?.dispose(); },
  };
}
