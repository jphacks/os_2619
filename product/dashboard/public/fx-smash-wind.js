// fx-smash-wind.js: the wind moves of the "スマブラ風" set (contract in fx-smash.js). Original effects, no assets.
// Air is invisible, so wind effects are drawn by what it carries and how it moves (the common stylised language of Pokémon's
// Air Slash, Genshin's Anemo, Smash's tornado moves and slash-VFX breakdowns): crescent blades thick at the leading edge and
// tapering to thin horns, thin speed lines along the motion, streaks that spiral, dust kicked up off the floor. Mostly white
// and translucent with a cool pale-cyan cast and grey dust; no saturated green, and nothing glowing blue so it never reads as
// thunder. Shapes are crisp (segments, crescents), not soft glow.
//   小 Air Cutter:     one crescent blade flying edge-first, its cutting edge drawn as a sharp arc, speed lines flickering
//                      round it; on contact two crossing cuts flash in an X and a puff of pale streaks and dust
//   中 Gale Shuriken:  three crescents whirling round a pale vortex like a thrown shuriken, a thin spinning ring, curling
//                      streaks shed behind; on contact four quick slashes at different angles, a ring of air, dust
//   大 Tornado:        a tight whirlwind ball (spinning crescents and stacked rings of air); where it ends a 2.6 m tornado
//                      stands on the floor for ~1.6 s: a funnel of broken rings of air spinning faster at the bottom, streaks
//                      and dust spiralling up, blades flung out at its birth, rings and a dust skirt on the floor
// The landing is drawn once: hit() for a hit, end() for a floor landing or a timeout (end(s, 'hit') only follows a hit()).
export function createWindMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, seg, segV, runit, u3, take, sc, shake, add, gustBurst, screenRot } = kit;
  const V = () => new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
  const tA = V(), tB = V(), tC = V(), pv = V(), ph = V();
  const W = COL.wind, HI = COL.windHi, GL = COL.windGlow, DUST = COL.dust;

  function basis(d) { // pv: perpendicular to d, near world up; ph: horizontal
    pv.copy(UP).addScaledVector(d, -d.dot(UP));
    if (pv.lengthSq() < 1e-4) pv.copy(X).addScaledVector(d, -d.dot(X));
    pv.normalize(); ph.crossVectors(d, pv).normalize();
  }
  function track(s) {
    const dist = s.prev.distanceTo(s.pos);
    if (dist > 1e-3) s.dir.copy(s.pos).sub(s.prev).normalize();
    s.travel += dist;
    return dist;
  }
  /** a crisp arc of segments: centre c, axes a (towards the middle of the arc) and b, radius r, half-angle h; tapered to the horns */
  function arc(c, a, b, r, h, w, inten, col, n = 12) {
    let px = 0, py = 0, pz = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n * 2 - 1, th = u * h, ca = Math.cos(th) * r, sb = Math.sin(th) * r;
      const x = c.x + a.x * ca + b.x * sb, y = c.y + a.y * ca + b.y * sb, z = c.z + a.z * ca + b.z * sb;
      if (i) { const m = 1 - Math.abs(u - 1 / n); seg(px, py, pz, x, y, z, w * (.25 + .75 * m ** .7), inten * (.3 + .7 * m), col); }
      px = x; py = y; pz = z;
    }
  }
  /** speed lines: n thin segments parallel to d around p, each re-placed now and then */
  function speedLines(s, key, p, d, n, rad, len, inten) {
    const L = s[key] ??= Array.from({ length: n }, () => ({ t: 0, o: V(), l: 0, f: 0 }));
    for (const l of L) {
      if ((l.t -= s.dtw) <= 0) {
        l.t = .05 + .08 * R(); const th = R() * TAU, r = rad * (.5 + .7 * R());
        l.o.copy(pv).multiplyScalar(Math.cos(th) * r).addScaledVector(ph, Math.sin(th) * r).addScaledVector(d, -R() * len * .6);
        l.l = len * (.5 + .7 * R()); l.f = R() < .2 ? 0 : .6 + .5 * R();
      }
      tA.copy(p).add(l.o); tB.copy(tA).addScaledVector(d, -l.l);
      segV(tA, tB, .007, inten * l.f, W);
    }
  }
  function streaks(s, dt, key, rate, r, back, col = W) { // pale streaks left along the path
    const d = s.dir;
    for (let n = take(s, key, rate * Q); n > 0; n--) {
      const u = R(); tA.copy(s.prev).lerp(s.pos, u); runit();
      emit(tA.x + u3[0] * r, tA.y + u3[1] * r, tA.z + u3[2] * r, -d.x * back + u3[0] * .4, -d.y * back + u3[1] * .4, -d.z * back + u3[2] * .4,
        .14 + .14 * R(), .007, .004, 2.5, 0, col, K.SPARK, 1.6, .25, .1, (1 - u) * dt);
    }
  }
  /** a quick slash: a crescent flashing at p, turned by rot on screen, growing a little as it fades */
  function slashFx(e) {
    const a = e.age - e.delay; if (a < 0) return true;
    const k = sc(a, 0, e.T), sz = e.sz * (1 + .45 * k);
    spr(S.CRESCENT, e.pos, sz, sz, e.rot + .5 * k * e.dirn, e.seed, W, 2.2 * (1 - k) ** 1.3, .32);
    if (a < .06) spr(S.FLARE, e.pos, e.sz * 3.2, .05, e.rot + Math.PI / 2, 0, HI, 1.8 * (1 - a / .06));
    return a < e.T;
  }
  const slash = (pos, rot, sz, delay = 0, T = .28) => add({ update: slashFx, pos: pos.clone(), rot, sz, delay, T, dirn: R() < .5 ? -1 : 1 });

  // ======================= 小: Air Cutter =======================
  function shotS(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos; s.dtw = dt;
    basis(d);
    // the blade stands upright across the flight (pv, d plane), edge first: its arc's middle points along d
    tC.copy(p).addScaledVector(d, -.2);
    arc(tC, d, pv, .2, 1.15, .03, 2.1, HI);
    arc(tA.copy(tC).addScaledVector(d, -.035), d, pv, .2, 1.0, .02, .9, W);
    spr(S.CRESCENT, p, .2, .2, screenRot(d), s.seed, W, 1.1, .3);
    speedLines(s, 'sl', p, d, 5, .2, .55, 1.1);
    streaks(s, dt, 'k', dist * 60 + dt * 20, .12, 2.5);
    s.prev.copy(p);
  }
  function cutS(p0, reason) {
    const p = p0.clone(); if (reason === 'floor') p.y = Math.max(.1, p.y);
    const big = reason === 'hit' ? 1 : .7;
    slash(p, -.75, .42 * big, 0, .26); slash(p, .75 + Math.PI, .42 * big, .05, .26);
    gustBurst(p, .5 * big, 70 * big, .8);
    shake(.15);
  }

  // ======================= 中: Gale Shuriken =======================
  function shotM(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age; s.dtw = dt;
    basis(d);
    const R0 = .26, spin = t * 16;
    for (let i = 0; i < 3; i++) spr(S.CRESCENT, p, R0, R0, -spin + i * TAU / 3, s.seed + i * .3, W, 1.25, .26);
    spr(S.SWIRL, p, R0 * 1.25, R0 * 1.25, 0, s.seed, W, .45);
    spr(S.GLOW, p, R0 * 2, R0 * 2, 0, 0, GL, .3, .2);
    spr(S.GLOW, p, .06, .06, 0, 0, HI, .9, 1);
    // a thin ring spinning in the flight's cross-section, broken into three arcs
    for (let i = 0; i < 3; i++) {
      const th0 = spin * .6 + i * TAU / 3;
      tA.copy(pv).multiplyScalar(Math.cos(th0)).addScaledVector(ph, Math.sin(th0));
      tB.copy(pv).multiplyScalar(-Math.sin(th0)).addScaledVector(ph, Math.cos(th0));
      arc(p, tA, tB, R0 * 1.35, .75, .016, 1.3, i ? W : HI, 8);
    }
    speedLines(s, 'sl', p, d, 7, .3, .7, .9);
    // curling streaks shed behind: tangential to the spin, drifting back
    for (let n = take(s, 'c', (dist * 70 + dt * 60) * Q); n > 0; n--) {
      const th = R() * TAU, r = R0 * (.9 + .4 * R());
      tA.copy(pv).multiplyScalar(Math.cos(th)).addScaledVector(ph, Math.sin(th));
      tB.copy(pv).multiplyScalar(-Math.sin(th)).addScaledVector(ph, Math.cos(th));
      emit(p.x + tA.x * r, p.y + tA.y * r, p.z + tA.z * r, tB.x * 3 - d.x * 1.5, tB.y * 3 - d.y * 1.5, tB.z * 3 - d.z * 1.5, .16 + .12 * R(), .007, .004, 3, 0, W, K.SPARK, 1.8, .3, .08, R() * dt);
    }
    s.prev.copy(p);
  }
  function cutM(p0, reason) {
    const p = p0.clone(); if (reason === 'floor') p.y = Math.max(.25, p.y);
    const big = reason === 'hit' ? 1 : .7;
    [-.6, 1.1, .2, 2.3].forEach((r, i) => slash(tA.copy(p).set(p.x + RS(.12), p.y + RS(.12), p.z + RS(.12)), r + RS(.2), (.5 + .1 * i) * big, i * .075, .3));
    gustBurst(p, .8 * big, 160 * big, 1);
    add({ update: e => {
      const a = e.age;
      spr(S.SWIRL, e.pos, .6 * e.big, .6 * e.big, 0, e.seed, W, .5 * (1 - sc(a, 0, .4)));
      if (e.floor) { const kf = sc(a, 0, .6); sprFloor(S.RING, e.g, .2 + 1.3 * (1 - (1 - kf) ** 3), W, 1.2 * (1 - kf) ** 1.5, .04, e.seed); }
      return a < .6;
    }, pos: p, big, g: new THREE.Vector3(p.x, .02, p.z), floor: p.y < .6 });
    shake(big > .9 ? .4 : .25);
  }

  // ======================= 大: Tornado =======================
  function shotL(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age; s.dtw = dt;
    basis(d);
    const R0 = .32, spin = t * 20;
    for (let i = 0; i < 4; i++) spr(S.CRESCENT, p, R0, R0, -spin + i * TAU / 4, s.seed + i * .2, W, 1.15, .22);
    spr(S.SWIRL, p, R0 * 1.4, R0 * 1.4, 0, s.seed, W, .5);
    spr(S.GLOW, p, R0 * 2.6, R0 * 2.6, 0, 0, GL, .35, .3);
    // stacked horizontal rings of air round the ball (a tornado in miniature), each turning at its own rate
    for (let j = 0; j < 3; j++) {
      const y = (j - 1) * .17, r = R0 * (1.1 + .25 * j), sp = spin * (1.2 - .2 * j);
      for (let i = 0; i < 2; i++) {
        const th0 = sp + i * Math.PI + j;
        tA.set(Math.cos(th0), 0, Math.sin(th0)); tB.set(-Math.sin(th0), 0, Math.cos(th0));
        arc(tC.set(p.x, p.y + y, p.z), tA, tB, r, 1.1, .018, 1.2, (i + j) % 2 ? W : HI, 9);
      }
    }
    speedLines(s, 'sl', p, d, 8, .4, .9, .9);
    streaks(s, dt, 'k', dist * 90 + dt * 50, .3, 3);
    if (p.y < 1.2) for (let n = take(s, 'u', 25 * Q * dt); n > 0; n--) { // dust dragged off the floor under it
      emit(p.x + RS(.4), .05, p.z + RS(.4), RS(.6) - d.x, .5 + .6 * R(), RS(.6) - d.z, .7 + .5 * R(), .15, .5, 2, .2, DUST, K.SMOKE, .7, .3, 0, R() * dt);
    }
    s.prev.copy(p);
  }
  const TH = 2.6; // tornado height (m)
  const funnelR = y => .22 + .75 * Math.pow(y / TH, 1.4);
  function tornadoFx(e, dt) {
    const a = e.age, g = e.g, T = 1.75;
    const grow = 1 - (1 - sc(a, 0, .3)) ** 3, die = sc(a, T - .45, T), I = grow * (1 - die);
    const top = TH * (.25 + .75 * grow);
    // the funnel: broken rings of air, faster at the bottom, wobbling about a leaning axis
    const NR = 13;
    for (let j = 0; j < NR; j++) {
      const v = (j + .5) / NR, y = top * v, r = funnelR(y) * (.75 + .25 * grow) * (1 + .5 * die);
      const lean = .2 * Math.sin(a * 2.3 + v * 2.5) * v, ox = g.x + lean, oz = g.z + .12 * Math.sin(a * 3.1 + v * 4) * v;
      const sp = a * (14 - 7 * v) + j * .9;
      for (let i = 0; i < 3; i++) {
        const th0 = sp + i * TAU / 3;
        tA.set(Math.cos(th0), 0, Math.sin(th0)); tB.set(-Math.sin(th0), 0, Math.cos(th0));
        arc(tC.set(ox, y, oz), tA, tB, r, .65 + .25 * Math.sin(j + i), .02 + .015 * v, (1.1 + .5 * (1 - v)) * I, (i + j) % 3 ? W : HI, 7);
      }
    }
    spr(S.GLOW, tA.set(g.x, top * .5, g.z), 1.4, top * .6, 0, 0, GL, .35 * I, 0);
    // streaks spiralling up the funnel (born on its wall moving round and up)
    for (let n = take(e, 's', 520 * I * Q * dt); n > 0; n--) {
      const y = top * R(), r = funnelR(y), th = R() * TAU, c = Math.cos(th), sn = Math.sin(th), w = 6 + 3 * R();
      emit(g.x + c * r, y, g.z + sn * r, -sn * r * w, 1.5 + 2 * R(), c * r * w, .1 + .1 * R(), .008, .004, 1.5, 0, R() < .3 ? HI : W, K.SPARK, 1.8, .2, .06, R() * dt);
    }
    // dust: a skirt at the base, some lifted up the funnel
    for (let n = take(e, 'd', 90 * I * Q * dt); n > 0; n--) {
      const th = R() * TAU, r = .35 + .5 * R(), c = Math.cos(th), sn = Math.sin(th);
      emit(g.x + c * r, .05, g.z + sn * r, -sn * 2.5 + c * .8, .3 + 1.6 * R() * R(), c * 2.5 + sn * .8, .7 + .6 * R(), .14, .55, 1.6, .5, DUST, K.SMOKE, .8, .35, 0, R() * dt);
    }
    // the floor: a dust-coloured pool, rings blown outward
    sprFloor(S.GLOW, g, 1.4, GL, .5 * I, .05);
    for (let i = 0; i < 4; i++) {
      const k = sc(a, i * .3, i * .3 + .7); if (k <= 0 || k >= 1) continue;
      sprFloor(S.RING, g, .4 + 2 * (1 - (1 - k) ** 3), i & 1 ? W : HI, 1.4 * (1 - k) ** 1.5, .035, e.seed + i);
    }
    if ((e.rumble = (e.rumble ?? .2) - dt) <= 0 && a < T - .4) { e.rumble = .2; shake(.2); }
    return a < T;
  }
  function tornado(p0, reason) {
    const g = new THREE.Vector3(p0.x, .02, p0.z), p = p0.clone();
    gustBurst(p, 1, 260, 1.2);
    for (let i = 0; i < 5; i++) slash(tA.set(p.x + RS(.25), Math.max(.4, p.y) + RS(.25), p.z + RS(.25)), R() * TAU, .55 + .2 * R(), i * .05, .3); // blades flung out
    add({ update: tornadoFx, g });
    shake(reason === 'hit' ? 1 : .8);
  }

  const SHOT = { s: shotS, m: shotM, l: shotL };
  const LAND = { s: cutS, m: cutM, l: tornado };
  const tierOf = t => SHOT[t] ? t : 'm'; // no tier (an old caller): the middle move, never the classic fallback (it routes back here)
  return {
    shot(s, dt) { SHOT[tierOf(s.tier)](s, dt); },
    end(s, reason) { if (reason !== 'hit') LAND[tierOf(s.tier)](s.pos, reason); }, // a hit was drawn by hit() just before
    hit(pos, tier) { LAND[tierOf(tier)](pos, 'hit'); },
  };
}
