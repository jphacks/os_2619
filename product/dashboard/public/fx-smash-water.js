// fx-smash-water.js: the water moves of the "スマブラ風" set (contract in fx-smash.js). Original effects, no assets.
// How game VFX artists sell water (stylised: Pokémon / Genshin Hydro / Smash, and the usual real-time breakdowns): a dark, dense
// blue body that hides what is behind it (not a glow), thin bright caustic bands and a hard glint on it, a bright fresnel rim;
// motion read through droplets that are stretched along their velocity and fall under gravity; impacts as a splash crown,
// ripple rings on the floor and white foam / mist. Kept clear of thunder: deeper blue, almost no white-hot core, drops fall.
//   小 Water Gun:   a pressurised jet: a stretched bead of water leading a tapering stream that sheds drops;
//                   on contact a splash crown (a cone of drops), a flattening blob, foam, ripple rings where it lands
//   中 Aqua Ring:   an orb of churning water held by two tilted rings of water spinning round it like a gyroscope, beads
//                   flung off the rings, a trail of falling drops; it bursts into a sphere of spray with two rings and ripples
//   大 Geyser:      a heavy orb drilling forward inside a double helix of water; where it ends a geyser erupts from the floor:
//                   a 2.6 m column of water, a fan of spray off its top raining back down, rings racing out over the floor
// The landing is drawn once: hit() for a hit, end() for a floor landing or a timeout (end(s, 'hit') only follows a hit()).
export function createWaterMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, seg, segV, runit, u3, take, sc, shake, add, splashBurst, screenRot } = kit;
  const V = () => new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
  const tA = V(), tB = V(), tC = V(), tD = V(), pv = V(), ph = V();
  const DEEP = COL.water, HI = COL.waterHi, FOAM = COL.foam, GLOWB = COL.waterGlow;
  const now = () => kit.time;

  function basis(d) { // pv: perpendicular to d, as close to world up as possible; ph: horizontal
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
  // drops shed along the path since last frame: sideways spray, falling
  function shed(s, dt, key, rate, r, sp, size = .028, col = DEEP) {
    const d = s.dir;
    for (let n = take(s, key, rate * Q); n > 0; n--) {
      const u = R(); tA.copy(s.prev).lerp(s.pos, u); runit();
      emit(tA.x + u3[0] * r, tA.y + u3[1] * r, tA.z + u3[2] * r, u3[0] * sp - d.x * .6, u3[1] * sp + .3 - d.y * .6, u3[2] * sp - d.z * .6,
        .35 + .35 * R(), size * (.7 + .6 * R()), size * .6, .8, -8, R() < .2 ? HI : col, K.DROP, 1.25, .05, .035, (1 - u) * dt);
    }
  }
  /** ripple rings spreading over the floor at g: n rings, one every gap s, each lasting T, out to rad */
  function ripples(g, a, n, gap, T, rad, inten, seed) {
    for (let i = 0; i < n; i++) {
      const k = sc(a, i * gap, i * gap + T);
      if (k <= 0 || k >= 1) continue;
      const rr = .15 + rad * (1 - (1 - k) ** 2.2) * (1 - .15 * i);
      sprFloor(S.RING, g, rr, i & 1 ? DEEP : HI, inten * (1 - k) ** 1.4, .05 + .02 * i, seed + i);
    }
  }
  /** a crown of drops thrown up and out in a cone (axis up), plus a flat skirt of drops along the floor */
  function crown(p, n, sp, spread = .55, floor = true) {
    for (let i = 0; i < n * Q; i++) {
      const th = R() * TAU, el = spread * (.5 + .5 * R()), v = sp * (.6 + .6 * R());
      emit(p.x + Math.cos(th) * .06, p.y, p.z + Math.sin(th) * .06, Math.cos(th) * Math.sin(el) * v, Math.cos(el) * v, Math.sin(th) * Math.sin(el) * v,
        .45 + .35 * R(), .034 + .02 * R(), .02, .6, -9.5, R() < .25 ? HI : DEEP, K.DROP, 1.3, .03, .03, 0);
    }
    if (floor) for (let i = 0; i < n * .5 * Q; i++) {
      const th = R() * TAU, v = sp * (.5 + .7 * R());
      emit(p.x, p.y + .02, p.z, Math.cos(th) * v, .4 + .8 * R(), Math.sin(th) * v, .3 + .2 * R(), .028, .016, 2, -9, DEEP, K.DROP, 1.2, .02, .03, 0);
    }
  }
  function foam(p, n, r, life = .7) { // white foam / mist puffs
    for (let i = 0; i < n * Q; i++) {
      runit(); const sp = r * (.5 + R());
      emit(p.x + u3[0] * r * .3, p.y + Math.abs(u3[1]) * r * .3, p.z + u3[2] * r * .3, u3[0] * sp, Math.abs(u3[1]) * sp * .6 + .2, u3[2] * sp,
        life * (.7 + .6 * R()), .12, .4 + .2 * R(), 2.5, .3, FOAM, K.GLOW, .32, .15, 0, 0);
    }
  }

  // ======================= 小: Water Gun =======================
  function shotS(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos;
    // the stream: the path of the last ~0.14 s, tapering and thinning towards the muzzle
    const H = s.wh ??= { pts: [], t: 0 };
    H.pts.push({ p: p.clone(), t: s.age });
    while (H.pts.length > 2 && s.age - H.pts[0].t > .14) H.pts.shift();
    const n = H.pts.length;
    for (let i = n - 1; i > 0; i--) {
      const u = (n - 1 - i) / Math.max(1, n - 1), w = .04 * (1 - .75 * u);
      segV(H.pts[i].p, H.pts[i - 1].p, w, .55 * (1 - u * .7), DEEP);
    }
    shed(s, dt, 'd', dist * 70 + dt * 20, .03, .7);
    // the head: a stretched bead pointing along the flight, a soft deep glow round it
    const rot = screenRot(d);
    spr(S.GLOW, p, .22, .22, 0, 0, GLOWB, .35, .1);
    spr(S.WATER, tA.copy(p).addScaledVector(d, -.05), .08, .17, rot, s.seed, DEEP, 1.4, 3);
    spr(S.GLOW, p, .05, .05, 0, 0, FOAM, .6, 1);
    s.prev.copy(p);
  }
  function splashSFx(e) {
    const a = e.age, p = e.pos, k = sc(a, 0, .3);
    // a blob of water flattening as it spreads
    const w = .14 + .3 * k, h = .14 * (1 - .6 * k);
    spr(S.WATER, p, w, h, 0, e.seed, DEEP, 1.3 * (1 - sc(a, .12, .35)), 2);
    if (a < .08) spr(S.GLOW, p, .4, .4, 0, 0, FOAM, 1.2 * (1 - a / .08) ** 2, .5);
    spr(S.RING, p, .1 + .45 * k, .1 + .45 * k, 0, e.seed, DEEP, .9 * (1 - k) ** 1.5, .06);
    if (e.floor) ripples(e.g, a, 2, .12, .5, .7, 1.3, e.seed);
    return a < .65;
  }
  function splashS(p0, reason) {
    const floor = reason === 'floor' || p0.y < .35, p = p0.clone(); if (floor) p.y = .03;
    crown(p, floor ? 70 : 45, floor ? 3.2 : 2.4, floor ? .5 : 1.4, floor);
    foam(p, 8, .5);
    add({ update: splashSFx, pos: p, g: new THREE.Vector3(p.x, .02, p.z), floor });
    shake(.16);
  }

  // ======================= 中: Aqua Ring =======================
  function ringPoint(c, R0, tilt, spin, th, o) { // a point of a circle of radius R0 round c, its plane tilted about pv then spun about d
    tC.copy(ph).multiplyScalar(Math.cos(th)).addScaledVector(pv, Math.sin(th)); // circle facing along d
    tC.applyAxisAngle(pv, tilt).applyAxisAngle(tB, spin);
    return o.copy(c).addScaledVector(tC, R0);
  }
  function shotM(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age;
    basis(d); tB.copy(d);
    const R0 = .2;
    // two rings of water, tilted, spinning in opposite senses
    for (let r = 0; r < 2; r++) {
      const tilt = r ? 1.05 : -1.05, spin = (r ? -1 : 1) * t * 7, N = 22;
      let px = 0, py = 0, pz = 0;
      for (let i = 0; i <= N; i++) {
        ringPoint(p, R0 * 1.45, tilt, spin, i / N * TAU, tA);
        const shimmer = .55 + .45 * Math.sin(i / N * TAU * 3 - t * 18 + r * 2);
        if (i) seg(px, py, pz, tA.x, tA.y, tA.z, .022, (.5 + .55 * shimmer), shimmer > .8 ? HI : DEEP);
        px = tA.x; py = tA.y; pz = tA.z;
      }
      // beads flung off the ring, tangentially
      for (let n = take(s, 'r' + r, 70 * Q * dt); n > 0; n--) {
        const th = R() * TAU; ringPoint(p, R0 * 1.45, tilt, spin, th, tA); ringPoint(p, R0 * 1.45, tilt, spin, th + .05, tD);
        tD.sub(tA).normalize().multiplyScalar(1.6 * (r ? -1 : 1));
        emit(tA.x, tA.y, tA.z, tD.x - d.x, tD.y - d.y + .3, tD.z - d.z, .3 + .2 * R(), .026, .016, 1, -8, DEEP, K.DROP, 1.25, 0, .03, R() * dt);
      }
    }
    shed(s, dt, 'd', dist * 50, .14, .5, .03);
    spr(S.GLOW, p, R0 * 3.4, R0 * 3.4, 0, 0, GLOWB, .35, .05);
    spr(S.WATER, p, R0, R0, 0, s.seed, DEEP, 1.25, 3);
    spr(S.WATER, p, R0 * .55, R0 * .55, 0, s.seed + .5, HI, .35, 5); // a lighter churn inside
    s.prev.copy(p);
  }
  function burstMFx(e) {
    const a = e.age, p = e.pos, k0 = e.k, k = sc(a, 0, .2);
    const g = (.25 + .45 * (1 - (1 - k) ** 2)) * k0; // the orb swells and breaks into spray
    spr(S.WATER, p, g, g * (1 - .35 * k), 0, e.seed, DEEP, 1.3 * (1 - sc(a, .03, .2)), 4);
    if (a < .1) spr(S.GLOW, p, .9 * k0, .9 * k0, 0, 0, FOAM, 1.4 * (1 - a / .1) ** 2, .6);
    spr(S.GLOW, p, 1.4 * k0, 1.4 * k0, 0, 0, GLOWB, .4 * (1 - sc(a, 0, .5)), .1);
    for (let i = 0; i < 2; i++) {
      const kk = sc(a, i * .08, .45 + i * .08), rr = (.25 + 1.1 * (1 - (1 - kk) ** 3)) * k0;
      if (kk > 0 && kk < 1) spr(S.RING, p, rr, rr, i, e.seed + i, DEEP, .9 * (1 - kk) ** 1.5, .05 + .03 * i);
    }
    if (e.floor) ripples(e.g, a, 3, .12, .7, 1.2 * k0, 1.5, e.seed);
    return a < .9;
  }
  function burstM(p0, reason) {
    const big = reason === 'hit', k = big ? 1 : .7, p = p0.clone();
    if (reason === 'floor') p.y = .15;
    splashBurst(p, .9 * k, 220 * k, 1.1, .6);
    crown(p, 40 * k, 2.4, 1.6, false); // spray all round
    foam(p, 16 * k, .8);
    add({ update: burstMFx, pos: p, k, g: new THREE.Vector3(p.x, .02, p.z), floor: reason === 'floor' || p.y < .6 });
    shake(big ? .45 : .25);
  }

  // ======================= 大: Geyser =======================
  function shotL(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age;
    basis(d);
    const R0 = .27, L = Math.min(.25 + s.travel, 1.2);
    // a double helix of water trailing the orb, drilling (it turns as it goes)
    for (let h = 0; h < 2; h++) {
      const N = 18; let px = 0, py = 0, pz = 0;
      for (let i = 0; i <= N; i++) {
        const u = i / N, th = t * 14 + u * 9 + h * Math.PI, r = R0 * (1.25 - .55 * u);
        tA.copy(p).addScaledVector(d, -L * u).addScaledVector(pv, Math.cos(th) * r).addScaledVector(ph, Math.sin(th) * r);
        if (i) seg(px, py, pz, tA.x, tA.y, tA.z, .035 * (1 - .7 * u), .9 * (1 - u), (i + h) % 4 ? DEEP : HI);
        px = tA.x; py = tA.y; pz = tA.z;
      }
    }
    shed(s, dt, 'd', dist * 110 + dt * 40, .2, .9, .034);
    foam(tA.copy(p).addScaledVector(d, -.2), dt * 20, .3, .4);
    spr(S.GLOW, p, R0 * 3.6, R0 * 3.6, 0, 0, GLOWB, .4, .05);
    spr(S.WATER, p, R0, R0, 0, s.seed, DEEP, 1.3, 4);
    spr(S.WATER, p, R0 * .6, R0 * .6, 0, s.seed + .3, HI, .3, 6);
    s.prev.copy(p);
  }
  const GH = 2.6; // geyser height (m)
  function geyserFx(e, dt) {
    const a = e.age, g = e.g;
    const rise = 1 - (1 - sc(a, .05, .3)) ** 3, fall = sc(a, 1.15, 1.6); // shoots up, stands, collapses
    const top = GH * rise * (1 - fall * .85);
    if (a < .12) { spr(S.GLOW, tA.set(g.x, .3, g.z), 1.6, .8, 0, 0, FOAM, 1.3 * (1 - a / .12) ** 2, .4); spr(S.FLARE, tA, 4, .12, 0, 0, HI, 1.6 * (1 - a / .12) ** 2); }
    // the column: overlapping vertical water bodies, wider at the base, wobbling
    if (top > .05) {
      const n = 3; // a few tall bodies overlapping (shorter ones read as a stack of beads)
      for (let i = 0; i < n; i++) {
        const u = (i + .5) / n, y = top * u, w = (.4 - .1 * u) * (1 + .06 * Math.sin(a * 23 + i * 1.7));
        spr(S.WATER, tA.set(g.x + .03 * Math.sin(a * 11 + i), y, g.z), w, Math.max(.2, top / n * .85), 0, e.seed + i * .13, DEEP, 1.2 * (1 - fall), 5);
      }
      spr(S.GLOW, tA.set(g.x, top * .5, g.z), .9, top * .7 + .2, 0, 0, GLOWB, .4 * (1 - fall), .05);
      // water racing up the column, sprayed off its top
      for (let n2 = take(e, 'u', 420 * (1 - fall) * Q * dt); n2 > 0; n2--) {
        const th = R() * TAU, r = .22 * Math.sqrt(R()), life = .45 + .35 * R();
        emit(g.x + Math.cos(th) * r, .05, g.z + Math.sin(th) * r, Math.cos(th) * .4, top / life * 1.25 + 1, Math.sin(th) * .4, life, .032 + .016 * R(), .02, .3, -9,
          R() < .3 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
      }
      for (let n2 = take(e, 'c', 160 * (1 - fall) * Q * dt); n2 > 0; n2--) { // the fan of spray off the top, raining back down
        const th = R() * TAU, v = 1.5 + 2.2 * R();
        emit(g.x + RS(.15), top, g.z + RS(.15), Math.cos(th) * v, 1 + 2 * R(), Math.sin(th) * v, .8 + .5 * R(), .034, .02, .4, -9.8, R() < .3 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
      }
      if (rise > .3) spr(S.WATER, tA.set(g.x, top, g.z), .55 * (1 - fall), .32 * (1 - fall), 0, e.seed + .9, DEEP, 1.2, 6); // the cap
      for (let n2 = take(e, 'f', 40 * (1 - fall) * Q * dt); n2 > 0; n2--) foam(tA.set(g.x, top * R(), g.z), 1, .4, .6);
    }
    // the floor: a pool of light, rings racing out, a ring of foam round the base
    sprFloor(S.GLOW, g, 1.6, GLOWB, 1 * (1 - sc(a, 1.2, 1.9)), .1);
    ripples(g, a, 5, .17, .85, 2.6, 2, e.seed);
    if (a > .7) ripples(g, a - .7, 3, .25, .9, 1.6, 1.2, e.seed + 9); // the water falling back
    for (let n2 = take(e, 'b', 60 * (1 - sc(a, 1, 1.7)) * Q * dt); n2 > 0; n2--) {
      const th = R() * TAU, r = .45 + .2 * R();
      emit(g.x + Math.cos(th) * r, .05, g.z + Math.sin(th) * r, Math.cos(th) * .6, .3 + .5 * R(), Math.sin(th) * .6, .6 + .4 * R(), .15, .45, 2, .1, FOAM, K.GLOW, .3, .2, 0, R() * dt);
    }
    if ((e.rumble = (e.rumble ?? .25) - dt) <= 0 && a < 1.2) { e.rumble = .18; shake(.22); }
    return a < 1.95;
  }
  function geyser(p0) {
    const g = new THREE.Vector3(p0.x, .02, p0.z);
    splashBurst(p0.clone(), 1, 160, 1.2, .8); // the orb itself bursting
    crown(tA.set(p0.x, .05, p0.z), 120, 4.2, .45, true);
    foam(tA.set(p0.x, .1, p0.z), 30, 1);
    add({ update: geyserFx, g });
    shake(1);
  }

  const SHOT = { s: shotS, m: shotM, l: shotL };
  const LAND = { s: splashS, m: burstM, l: (p) => geyser(p) };
  const tierOf = t => SHOT[t] ? t : 'm'; // no tier (an old caller): the middle move, never the classic fallback (it routes back here)
  return {
    shot(s, dt) { SHOT[tierOf(s.tier)](s, dt); },
    end(s, reason) { if (reason !== 'hit') LAND[tierOf(s.tier)](s.pos, reason); }, // a hit was drawn by hit() just before
    hit(pos, tier) { LAND[tierOf(tier)](pos, 'hit'); },
  };
}
