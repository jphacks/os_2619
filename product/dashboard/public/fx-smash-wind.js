// fx-smash-wind.js: the wind moves of the "スマブラ風" set (contract in fx-smash.js). Original effects, no assets.
// Element axis of the set: fire bursts from the centre, thunder strikes from above, water comes up from below, wind closes in FROM AROUND.
// Air is invisible, so wind is drawn by what it carries and how it moves (the shared stylised language of Genshin's Anemo,
// Pokémon's Air Slash, Smash tornado moves and slash-VFX breakdowns): crescent blades thick at the leading edge and tapering to thin
// horns, thin speed lines, streaks that spiral, dust, grit and leaves picked up and thrown. Sharp shapes (crescents, segments), not
// soft glow; mostly white / translucent silver with a pale-cyan cast, grey-beige dust, dusty khaki leaves; no saturated green or purple,
// nothing glowing blue (that is thunder). Timing: blades arrive fast (anticipation is the convergence), the impact is a white
// cross-flash and a ring of air, the dissipation is a long gust that flattens dust outward.
//   小 Vacuum Crescent:  one crescent edge-first with two fading afterimages and vacuum streaks along it; on contact an X of cuts,
//                        a ring of air, streaks flung flat to the sides, a puff of dust and a few leaves
//   中 Cross Gale:       two blades flying side by side, scissoring across the flight line; on contact two big blades sweep in from
//                        the LEFT and the RIGHT and cross on the target (X flash), three after-cuts, a ring of air, dust and leaves
//   大 Tempest (signature, ~2.9 s): a whirlwind ball (crescents, stacked rings of air) dragging dust off the floor. On contact:
//                        0-.65 s  ten vacuum blades fly in on the target from every direction (360°, each with a streak trail),
//                                 a pressure ring contracts over the floor and dust is sucked inward; each arrival cuts and shakes
//                        .65 s    convergence: white cross-flash, a ring of air, heavy shake; a 2.8 m tornado spins up on the target:
//                                 a translucent funnel, broken rings of air spinning faster at the bottom, streaks spiralling up,
//                                 leaves and grit lifted round it, a dust skirt
//                        2.05 s   release: a radial shock gust: a floor ring racing out to 3.6 m, streaks and dust blown flat outward,
//                                 swept-grass lines lying down radially behind the front, leaves flung, a shake; dust settles
//   溜め (fx-smash-charge.js): air spirals in toward the caster, pressure rings contracting round them.
// Layers per 大 hit: converging blades + trails, slash flashes, contracting ring, inward dust, cross-flash, flare, camera ring,
// funnel sprite, ring arcs, spiral streaks, leaves, grit, dust skirt, floor rings, release ring x2, flat streaks, grass lines,
// outward dust, shake + rumble (fire: ~14, thunder: ~13).
// The landing is drawn once: hit() for a hit, end() for a floor landing or a timeout (end(s, 'hit') only follows a hit()).
export function createWindMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, seg, segV, runit, u3, take, sc, shake, add, gustBurst, screenRot } = kit;
  const V = () => new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
  const tA = V(), tB = V(), tC = V(), tD = V(), pv = V(), ph = V(), side = V();
  const W = COL.wind, HI = COL.windHi, GL = COL.windGlow, DUST = COL.dust, LEAF = COL.leaf ?? COL.dust, GRIT = COL.pebble ?? COL.dust;

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
  /** the camera's horizontal right: "left / right" on screen */
  function screenSide() { side.setFromMatrixColumn(kit.camera.matrixWorld, 0); side.y = 0; if (side.lengthSq() < 1e-6) side.set(1, 0, 0); return side.normalize(); }
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
  /** leaves (and grit) thrown from p: tumbling, drifting down */
  function leaves(p, n, sp, up = 1, grit = .3) {
    for (let i = 0; i < n * Q; i++) {
      runit(); const v = sp * (.4 + .8 * R()), g = R() < grit;
      emit(p.x, p.y, p.z, u3[0] * v, Math.abs(u3[1]) * v * .5 + up * R(), u3[2] * v, 1 + .8 * R(), g ? .025 : .055 + .025 * R(), g ? .02 : .045, 1.6, g ? -6 : -1.2,
        g ? GRIT : LEAF, K.LEAF, 1, g ? .1 : .6, RS(9), 0);
    }
  }
  function dustRing(g, n, sp, out = 1, life = 1) { // dust blown flat over the floor (out = -1: sucked inward)
    for (let i = 0; i < n * Q; i++) {
      const th = R() * TAU, c = Math.cos(th), sn = Math.sin(th), r = out > 0 ? .2 + .4 * R() : 1.8 + .8 * R(), v = sp * (.6 + .6 * R()) * out;
      emit(g.x + c * r, .05 + .1 * R(), g.z + sn * r, c * v, .15 + .4 * R(), sn * v, life * (.7 + .5 * R()), .2, .8 + .4 * R(), out > 0 ? 2.2 : .3, .1, DUST, K.SMOKE, .22, .6, 0, 0);
    }
  }
  /** a quick slash: a crescent flashing at p, turned by rot on screen, growing a little as it fades */
  function slashFx(e) {
    const a = e.age - e.delay; if (a < 0) return true;
    const k = sc(a, 0, e.T), sz = e.sz * (1 + .45 * k);
    spr(S.CRESCENT, e.pos, sz, sz, e.rot + .5 * k * e.dirn, e.seed, W, 2.4 * (1 - k) ** 1.3, .32);
    if (a < .07) spr(S.FLARE, e.pos, e.sz * 3.4, .05, e.rot + Math.PI / 2, 0, HI, 2 * (1 - a / .07));
    return a < e.T;
  }
  const slash = (pos, rot, sz, delay = 0, T = .28) => add({ update: slashFx, pos: pos.clone(), rot, sz, delay, T, dirn: R() < .5 ? -1 : 1 });
  /** the cross-flash of blades meeting: two crossed flares, a white bloom, a ring of air */
  function crossFx(e) {
    const a = e.age, k = 1 - a / e.T; if (k <= 0) return false;
    spr(S.GLOW, e.pos, e.r * .7, e.r * .7, 0, 0, HI, 1.1 * k * k, .8);
    spr(S.FLARE, e.pos, e.r * 3.2, e.r * .07, Math.PI / 4, 0, HI, 2.2 * k * k);
    spr(S.FLARE, e.pos, e.r * 3.2, e.r * .07, -Math.PI / 4, 0, HI, 2.2 * k * k);
    const q = 1 - k, rr = e.r * (.4 + 1.6 * (1 - (1 - q) ** 3));
    spr(S.RING, e.pos, rr, rr, 0, e.seed, W, 1.4 * k ** 1.5, .04);
    return true;
  }
  const cross = (p, r, T = .3) => add({ update: crossFx, pos: p.clone(), r, T });

  // ======================= 小: Vacuum Crescent =======================
  function shotS(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos; s.dtw = dt;
    basis(d);
    // the blade stands upright across the flight, edge first, with two afterimages fading behind it
    for (let i = 2; i >= 0; i--) {
      tC.copy(p).addScaledVector(d, -.2 - i * .13);
      arc(tC, d, pv, .21, 1.15, .032 * (1 - .3 * i), (i ? .55 / i : 2.2), i ? W : HI);
    }
    arc(tA.copy(p).addScaledVector(d, -.235), d, pv, .2, 1.0, .02, .9, W);
    spr(S.CRESCENT, p, .22, .22, screenRot(d), s.seed, W, 1.2, .3);
    spr(S.GLOW, p, .3, .3, 0, 0, GL, .3, .3);
    // vacuum streaks: thin lines dragged along both horns
    for (const hs of [-1, 1]) { tA.copy(p).addScaledVector(d, -.32).addScaledVector(pv, hs * .19); tB.copy(tA).addScaledVector(d, -.45 - .1 * Math.sin(s.age * 40)); segV(tA, tB, .009, 1.3, HI); }
    speedLines(s, 'sl', p, d, 6, .22, .6, 1.1);
    streaks(s, dt, 'k', dist * 60 + dt * 20, .12, 2.5);
    s.prev.copy(p);
  }
  function cutS(p0, reason) {
    const p = p0.clone(); if (reason === 'floor') p.y = Math.max(.1, p.y);
    const big = reason === 'hit' ? 1 : .7;
    slash(p, -.75, .45 * big, 0, .26); slash(p, .75 + Math.PI, .45 * big, .05, .26);
    cross(p, .55 * big, .2);
    gustBurst(p, .5 * big, 80 * big, .8);
    for (let i = 0; i < 40 * big * Q; i++) { // streaks flung flat to the sides
      const th = R() * TAU, v = 5 + 5 * R();
      emit(p.x, p.y + RS(.1), p.z, Math.cos(th) * v, RS(.4), Math.sin(th) * v, .15 + .1 * R(), .008, .004, 4, 0, HI, K.SPARK, 2, .05, .1, 0);
    }
    leaves(p, 6 * big, 2.5);
    shake(.18);
  }

  // ======================= 中: Cross Gale =======================
  function shotM(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age; s.dtw = dt;
    basis(d);
    const rot = screenRot(d);
    // two blades side by side, scissoring: they swing across the flight line and back
    for (const hs of [-1, 1]) {
      const off = hs * .2 * Math.cos(t * 14), tilt = hs * .5 * Math.sin(t * 14);
      tC.copy(p).addScaledVector(pv, off).addScaledVector(d, -.15);
      tD.copy(d).multiplyScalar(Math.cos(tilt)).addScaledVector(pv, Math.sin(tilt)); tB.crossVectors(tD, ph).negate();
      arc(tC, tD, tB, .24, 1.1, .03, 2, hs > 0 ? HI : W);
      arc(tA.copy(tC).addScaledVector(tD, -.04), tD, tB, .23, .95, .018, .8, W);
      spr(S.CRESCENT, tA.copy(tC).addScaledVector(tD, .2), .2, .2, rot + tilt, s.seed + hs, W, .8, .3);
    }
    spr(S.GLOW, p, .5, .5, 0, 0, GL, .35, .3);
    spr(S.GLOW, p, .06, .06, 0, 0, HI, 1, 1);
    speedLines(s, 'sl', p, d, 8, .32, .75, 1);
    streaks(s, dt, 'k', dist * 70 + dt * 30, .25, 2.5);
    s.prev.copy(p);
  }
  // a blade sweeping in from p0 to p1 along a slight curve, leaving a trail of streak segments, then cutting
  function sweepFx(e) {
    const a = e.age - e.delay; if (a < 0) return true;
    const T = e.T, u = Math.min(1, a / T), q = u * u; // accelerating in
    const pos = (w, o) => o.copy(e.p0).lerp(e.p1, w).addScaledVector(UP, Math.sin(Math.PI * w) * e.bend);
    if (u < 1) {
      pos(q, tA); pos(Math.min(1, q + .05), tB); tD.copy(tB).sub(tA).normalize();
      spr(S.CRESCENT, tA, e.sz, e.sz, screenRot(tD), e.seed, W, 2, .3);
      spr(S.GLOW, tA, e.sz * 1.6, e.sz * 1.6, 0, 0, GL, .3, .2);
      for (let i = 0; i < 6; i++) { // trail
        const w0 = Math.max(0, q - .06 * i), w1 = Math.max(0, q - .06 * (i + 1));
        segV(pos(w0, tB), pos(w1, tC), e.sz * .12 * (1 - i / 6), 1.4 * (1 - i / 6), i ? W : HI);
      }
    } else if (!e.cut) { e.cut = true; slash(e.p1, e.rot, e.sz * 1.4, 0, .3); }
    return u < 1 || a < T + .02;
  }
  const sweep = (p0, p1, sz, T, delay, bend = 0) => {
    tD.copy(p1).sub(p0); const rot = Math.atan2(tD.y, Math.hypot(tD.x, tD.z)) + R() * .4;
    add({ update: sweepFx, p0: p0.clone(), p1: p1.clone(), sz, T, delay, bend, rot });
  };
  function crossFxM(e) {
    const a = e.age;
    if (!e.hitDone && a >= .14) {
      e.hitDone = true; const p = e.pos, k = e.big;
      cross(p, 1 * k, .32);
      [.4, 2.1, 1.2].forEach((r, i) => slash(tA.set(p.x + RS(.12), p.y + RS(.12), p.z + RS(.12)), r + RS(.2), (.45 + .1 * i) * k, .08 + i * .07, .28));
      gustBurst(p, .8 * k, 160 * k, 1);
      leaves(p, 14 * k, 3.5);
      if (p.y < 1.6) dustRing(e.g, 16 * k, 3);
      shake(k > .9 ? .5 : .3);
    }
    if (e.hitDone && e.floor) { const kf = sc(a, .14, .75); sprFloor(S.RING, e.g, .2 + 1.6 * (1 - (1 - kf) ** 3), W, 1.4 * (1 - kf) ** 1.5, .04, e.seed); }
    return a < .8;
  }
  function cutM(p0, reason) {
    const p = p0.clone(); if (reason === 'floor') p.y = Math.max(.3, p.y);
    const big = reason === 'hit' ? 1 : .75, sd = screenSide();
    for (const hs of [-1, 1]) sweep(tA.copy(p).addScaledVector(sd, hs * 1.7).add(tB.set(0, .35, 0)), p, .42 * big, .14, 0, .15); // from the left and the right
    add({ update: crossFxM, pos: p, big, g: new THREE.Vector3(p.x, .02, p.z), floor: p.y < 1.6 });
    shake(.15);
  }

  // ======================= 大: Tempest =======================
  function shotL(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age; s.dtw = dt;
    basis(d);
    const R0 = .32, spin = t * 20;
    for (let i = 0; i < 4; i++) spr(S.CRESCENT, p, R0, R0, -spin + i * TAU / 4, s.seed + i * .2, W, 1.2, .22);
    spr(S.SWIRL, p, R0 * 1.4, R0 * 1.4, 0, s.seed, W, .6);
    spr(S.GLOW, p, R0 * 2.6, R0 * 2.6, 0, 0, GL, .4, .3);
    for (let j = 0; j < 3; j++) { // stacked horizontal rings of air round the ball (a tornado in miniature)
      const y = (j - 1) * .17, r = R0 * (1.1 + .25 * j), sp = spin * (1.2 - .2 * j);
      for (let i = 0; i < 2; i++) {
        const th0 = sp + i * Math.PI + j;
        tA.set(Math.cos(th0), 0, Math.sin(th0)); tB.set(-Math.sin(th0), 0, Math.cos(th0));
        arc(tC.set(p.x, p.y + y, p.z), tA, tB, r, 1.1, .02, 1.3, (i + j) % 2 ? W : HI, 9);
      }
    }
    speedLines(s, 'sl', p, d, 8, .4, .9, .9);
    streaks(s, dt, 'k', dist * 90 + dt * 50, .3, 3);
    for (let n = take(s, 'lf', 10 * Q * dt); n > 0; n--) { // a leaf or two caught in it
      const th = R() * TAU; emit(p.x + Math.cos(th) * R0, p.y + RS(.15), p.z + Math.sin(th) * R0, -Math.sin(th) * 3 - d.x, .3, Math.cos(th) * 3 - d.z, .6, .05, .045, 2, -1, LEAF, K.LEAF, 1, .3, RS(9), R() * dt);
    }
    if (p.y < 1.4) for (let n = take(s, 'u', 30 * Q * dt); n > 0; n--) { // dust dragged off the floor under it
      emit(p.x + RS(.4), .05, p.z + RS(.4), RS(.6) - d.x, .4 + .5 * R(), RS(.6) - d.z, .7 + .5 * R(), .2, .8, 2, .2, DUST, K.SMOKE, .22, .6, 0, R() * dt);
    }
    s.prev.copy(p);
  }
  const NB = 10, CONV = .65, REL = 2.05, TH = 2.8; // blades, convergence time, release time, tornado height (m)
  const funnelR = y => .2 + .8 * Math.pow(y / TH, 1.3);
  function tempestFx(e, dt) {
    const a = e.age, g = e.g, c = e.c;
    // ---- 0..CONV: blades converge from all round, the floor is pulled in ----
    if (a < CONV + .05) {
      const k = sc(a, 0, CONV);
      for (let i = 0; i < 3; i++) { const ph0 = (a * 2.4 + i / 3) % 1; sprFloor(S.RING, g, 2.8 * (1 - ph0) + .3, i ? W : HI, 1.3 * Math.sin(Math.PI * ph0) * (.4 + .6 * k), .035, e.seed + i); }
      sprFloor(S.GLOW, g, 2.2 - 1.2 * k, GL, .35 + .3 * k, .05);
      for (let n = take(e, 'in', 70 * Q * dt); n > 0; n--) { // streaks drawn in over the floor
        const th = R() * TAU, r = 2 + .8 * R(), cx = Math.cos(th), cz = Math.sin(th), v = 6 + 4 * R();
        emit(g.x + cx * r, .05 + R() * 1.4, g.z + cz * r, -cx * v - cz * 1.5, 0, -cz * v + cx * 1.5, r / v * .9, .008, .004, 0, 0, R() < .4 ? HI : W, K.SPARK, 1.7, .05, .08, R() * dt);
      }
      if (!e.sucked) { e.sucked = true; dustRing(g, 30, 2.6, -1, .9); }
    }
    // ---- CONV: convergence ----
    if (!e.conv && a >= CONV) {
      e.conv = true;
      cross(c, 1.3, .35);
      gustBurst(c, 1, 300, 1.3);
      leaves(c, 24, 4, 1.5);
      shake(1);
    }
    // ---- the tornado ----
    const b = a - CONV;
    if (b > 0) {
      const grow = 1 - (1 - sc(b, 0, .3)) ** 3, die = sc(a, REL - .1, REL + .35), I = grow * (1 - die);
      const top = TH * (.25 + .75 * grow);
      if (I > 0) {
        // the funnel body: a translucent cone of streaks winding round
        spr(S.COLUMN, tA.set(g.x, top * .5, g.z), funnelR(top) * 1.05, top * .5 + .1, 0, 10 + e.seed, W, .9 * I, .78);
        spr(S.COLUMN, tA, funnelR(top) * .8, top * .5, 0, 10.5 + e.seed, HI, .5 * I, .8);
        spr(S.GLOW, tA, 1.3, top * .6, 0, 0, GL, .3 * I, 0);
        // broken rings of air, faster at the bottom, wobbling about a leaning axis
        const NR = 14;
        for (let j = 0; j < NR; j++) {
          const v = (j + .5) / NR, y = top * v, r = funnelR(y) * (.75 + .25 * grow) * (1 + .6 * die);
          const ox = g.x + .2 * Math.sin(b * 2.3 + v * 2.5) * v, oz = g.z + .12 * Math.sin(b * 3.1 + v * 4) * v;
          const sp = b * (16 - 8 * v) + j * .9;
          for (let i = 0; i < 3; i++) {
            const th0 = sp + i * TAU / 3;
            tA.set(Math.cos(th0), 0, Math.sin(th0)); tB.set(-Math.sin(th0), 0, Math.cos(th0));
            arc(tC.set(ox, y, oz), tA, tB, r, .65 + .25 * Math.sin(j + i), .022 + .02 * v, (1.2 + .5 * (1 - v)) * I, (i + j) % 3 ? W : HI, 7);
          }
        }
        for (let n = take(e, 's', 520 * I * Q * dt); n > 0; n--) { // streaks spiralling up the funnel wall
          const y = top * R(), r = funnelR(y), th = R() * TAU, cs = Math.cos(th), sn = Math.sin(th), w = 6 + 3 * R();
          emit(g.x + cs * r, y, g.z + sn * r, -sn * r * w, 1.5 + 2 * R(), cs * r * w, .1 + .1 * R(), .008, .004, 1.5, 0, R() < .3 ? HI : W, K.SPARK, 1.9, .2, .06, R() * dt);
        }
        for (let n = take(e, 'lf', 26 * I * Q * dt); n > 0; n--) { // leaves and grit lifted round it
          const y = top * .7 * R(), r = funnelR(y) * (1 + .3 * R()), th = R() * TAU, cs = Math.cos(th), sn = Math.sin(th), gr = R() < .35;
          emit(g.x + cs * r, y, g.z + sn * r, -sn * 4.5 + cs * .3, 1.5 + 1.5 * R(), cs * 4.5 + sn * .3, .7 + .4 * R(), gr ? .028 : .06, gr ? .024 : .05, .8, .3,
            gr ? GRIT : LEAF, K.LEAF, 1, .5, RS(10), R() * dt);
        }
        for (let n = take(e, 'd', 60 * I * Q * dt); n > 0; n--) { // the dust skirt at the base, some lifted
          const th = R() * TAU, r = .35 + .5 * R(), cs = Math.cos(th), sn = Math.sin(th);
          emit(g.x + cs * r, .05, g.z + sn * r, -sn * 2.5 + cs * .8, .3 + 1.6 * R() * R(), cs * 2.5 + sn * .8, .7 + .6 * R(), .2, .85, 1.6, .5, DUST, K.SMOKE, .22, .6, 0, R() * dt);
        }
        sprFloor(S.GLOW, g, 1.4, GL, .45 * I, .05);
        for (let i = 0; i < 4; i++) {
          const k = sc(b, i * .3, i * .3 + .7); if (k <= 0 || k >= 1) continue;
          sprFloor(S.RING, g, .4 + 1.8 * (1 - (1 - k) ** 3), i & 1 ? W : HI, 1.3 * (1 - k) ** 1.5, .035, e.seed + i);
        }
        if ((e.rumble = (e.rumble ?? .2) - dt) <= 0) { e.rumble = .18; shake(.2); }
      }
    }
    // ---- REL: the release gust, flattening everything outward ----
    if (!e.rel && a >= REL) {
      e.rel = true;
      for (let i = 0; i < 160 * Q; i++) { // streaks blown flat outward
        const th = R() * TAU, v = 7 + 6 * R(), y = .05 + .9 * R() * R();
        emit(g.x + Math.cos(th) * .4, y, g.z + Math.sin(th) * .4, Math.cos(th) * v, 0, Math.sin(th) * v, .25 + .15 * R(), .009, .004, 2.5, 0, R() < .4 ? HI : W, K.SPARK, 2, .05, .1, 0);
      }
      dustRing(g, 45, 4.5, 1, 1.3);
      leaves(tA.set(g.x, .6, g.z), 30, 5, .6);
      shake(.7);
    }
    const r0 = a - REL;
    if (r0 > 0) {
      const k = sc(r0, 0, .45), rr = .5 + 3.1 * (1 - (1 - k) ** 2.5);
      if (r0 < .15) spr(S.FLARE, tA.set(g.x, .15, g.z), 5.5, .12, 0, 0, HI, 2.2 * (1 - r0 / .15) ** 2); // the gust front flashing flat over the floor
      if (k < 1) {
        sprFloor(S.RING, g, rr, HI, 2.2 * (1 - k) ** 1.3, .03, e.seed + 7);
        sprFloor(S.RING, g, rr * .8, W, 1.2 * (1 - k) ** 1.5, .06, e.seed + 8);
        // swept-grass lines lying down radially just behind the front
        const N = 44;
        for (let i = 0; i < N; i++) {
          const th = i / N * TAU + e.seed * 3 + RS(.04), cs = Math.cos(th), sn = Math.sin(th), r1 = rr * (.86 + .1 * Math.sin(i * 7.3)), r2 = r1 - .28 - .2 * (i % 3) / 2;
          if (r2 > .2) seg(g.x + cs * r2, .02, g.z + sn * r2, g.x + cs * r1, .02, g.z + sn * r1, .012, 1.3 * (1 - k), i % 4 ? W : HI);
        }
      }
    }
    return a < REL + .85;
  }
  // a vacuum blade flying in on the target from far round it
  function bladeIn(c, i, delay) {
    const th = i / NB * TAU + RS(.25), r = 2.3 + .4 * R(), y = c.y + RS(.6) + .2;
    tA.set(c.x + Math.cos(th) * r, Math.max(.25, y), c.z + Math.sin(th) * r);
    sweep(tA, c, .34 + .08 * R(), .2, delay, RS(.25));
  }
  function tempest(p0, reason) {
    const c = p0.clone(); c.y = Math.max(.5, c.y);
    const g = new THREE.Vector3(c.x, .02, c.z);
    gustBurst(c, .5, 80, .8);
    cross(c, .5, .15);
    for (let i = 0; i < NB; i++) bladeIn(c, (i * 3) % NB, .02 + i * .043); // alternate sides so they arrive from everywhere
    add({ update: tempestFx, g, c });
    shake(reason === 'hit' ? .5 : .4);
  }

  const SHOT = { s: shotS, m: shotM, l: shotL };
  const LAND = { s: cutS, m: cutM, l: tempest };
  const tierOf = t => SHOT[t] ? t : 'm'; // no tier (an old caller): the middle move, never the classic fallback (it routes back here)
  return {
    shot(s, dt) { SHOT[tierOf(s.tier)](s, dt); },
    end(s, reason) { if (reason !== 'hit') LAND[tierOf(s.tier)](s.pos, reason); }, // a hit was drawn by hit() just before
    hit(pos, tier) { LAND[tierOf(tier)](pos, 'hit'); },
  };
}
