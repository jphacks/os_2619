// fx-smash-fire.js: the fire moves of the "スマブラ風" set (contract in fx-smash.js). Original effects, no assets.
//   小 PK Fire (Ness):              a thin zig-zag shard of light flies straight; where it lands a narrow pillar of fire stands ~0.9 s
//   中 Firaga (Sora):               a big round fireball with flame tongues swirling round it; a round fiery burst with a shock ring
//   大 Explosive Flame (Palutena):  a small, very bright seed of light; on contact (or at the end of its range) a ~2 m sphere of fire
//                                   that blooms again several times, a rising column, heavy smoke, a floor ring, a strong shake
// The landing effect is drawn once: hit() draws it for a hit, end() for a floor landing or a timeout (end(s, 'hit') only follows a hit()).
export function createFireMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, segV, runit, u3, take, flick, sc, shake, add } = kit;
  const V = () => new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
  const tA = V(), tB = V(), tC = V(), pv = V(), ph = V(), pts = Array.from({ length: 6 }, V);
  const now = () => kit.time;
  const PK = [1, .72, .22], WHITE = [1, .95, .82], DEEP = [1, .26, .04];

  // two unit vectors perpendicular to d: pv as close to world up as possible (seen side-on by the camera), ph horizontal
  function basis(d) {
    pv.copy(UP).addScaledVector(d, -d.dot(UP));
    if (pv.lengthSq() < 1e-4) pv.copy(X).addScaledVector(d, -d.dot(X));
    pv.normalize(); ph.crossVectors(d, pv).normalize();
  }
  function track(s) { // keep s.dir along the actual motion
    const dist = s.prev.distanceTo(s.pos);
    if (dist > 1e-3) s.dir.copy(s.pos).sub(s.prev).normalize();
    s.travel += dist;
    return dist;
  }
  // a spherical shell of flame: every particle at the same speed so the ball stays round; radius ~ sp / drag
  function flameShell(p, n, sp, drag, s0, s1, life, inten, turb = .25) {
    for (let i = 0; i < n * Q; i++) {
      runit(); const v = sp * (.85 + .3 * R());
      emit(p.x + u3[0] * .05, p.y + u3[1] * .05, p.z + u3[2] * .05, u3[0] * v, u3[1] * v, u3[2] * v, life * (.8 + .4 * R()),
        s0 * (.8 + .4 * R()), s1, drag, .6, COL.one, K.FLAME, inten, turb, 0, R() * .03);
    }
  }
  function sparkShell(p, n, sp, life = .6, col = COL.ember) {
    for (let i = 0; i < n * Q; i++) {
      runit(); const v = sp * (.4 + .9 * R());
      emit(p.x, p.y, p.z, u3[0] * v, u3[1] * v + 1, u3[2] * v, life * (.5 + R()), .013, .006, 1.3, -5, col, K.SPARK, 2.6, .2, .045, 0);
    }
  }
  function smokeShell(p, n, sp, s0, s1, life, inten = .9) {
    for (let i = 0; i < n * Q; i++) {
      runit(); const v = sp * (.3 + .7 * R());
      emit(p.x + u3[0] * .1, p.y + u3[1] * .1, p.z + u3[2] * .1, u3[0] * v, u3[1] * v * .6 + .3, u3[2] * v, life * (.7 + .5 * R()),
        s0, s1 * (.8 + .4 * R()), 1.8, .4, COL.smoke, K.SMOKE, inten, .25, 0, -(.05 + .15 * R()));
    }
  }

  // ======================= 小: PK Fire =======================
  function shotPK(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos;
    basis(d);
    // the shard: a lightning-bolt zig-zag pointing along the flight, wobbling a little about the flight axis and flickering
    const a = .35 * Math.sin(now() * 9 + s.seed * 7), ca = Math.cos(a), sa = Math.sin(a);
    tC.copy(pv).multiplyScalar(ca).addScaledVector(ph, sa);
    const L = .34, w = .055, zig = [0, 1, -.55, .8, -.35, .15];
    for (let i = 0; i < 6; i++) {
      const u = i / 5, j = i && i < 5 ? RS(.012) : 0;
      pts[i].copy(p).addScaledVector(d, -L * u * (i === 2 ? .82 : 1)).addScaledVector(tC, (zig[i] * w + j) * (1 - .3 * u));
    }
    const fl = flick(s.seed, 37) * (R() < .1 ? .55 : 1);
    for (let i = 0; i < 5; i++) segV(pts[i], pts[i + 1], .024 * (1 - .12 * i), 2.1 * fl * (1 - .1 * i), PK);
    segV(pts[0], tA.copy(p).addScaledVector(d, .05), .018, 2 * fl, WHITE); // bright point
    spr(S.GLOW, tB.copy(p).addScaledVector(d, -.15), .26, .26, 0, 0, COL.fire, .3 * fl, 0);
    spr(S.GLOW, p, .06, .06, 0, 0, PK, .8 * fl, 1);
    // a few sparks peeling off and a faint warm wake
    for (let n = take(s, 'k', (dist * 45 + dt * 25) * Q); n > 0; n--) {
      const u = R(); tA.copy(s.prev).lerp(p, u); runit(); const sp = .5 + 1.2 * R();
      emit(tA.x, tA.y, tA.z, u3[0] * sp - d.x * 1.5, u3[1] * sp - d.y * 1.5, u3[2] * sp - d.z * 1.5, .2 + .25 * R(), .011, .005, 2, -3,
        PK, K.SPARK, 2.4, .2, .04, (1 - u) * dt);
    }
    for (let n = take(s, 'g', dist * 25 * Q); n > 0; n--) {
      tA.copy(s.prev).lerp(p, R());
      emit(tA.x, tA.y, tA.z, -d.x * .2, -d.y * .2 + .1, -d.z * .2, .18, .07, .14, 3, 0, COL.fire, K.GLOW, .5, 0, 0, 0);
    }
    s.prev.copy(p);
  }
  function pillarFx(e, dt) {
    const a = e.age, T = .9, g = e.g, H = 1.2;
    const env = Math.min(1, a / .07) * (1 - sc(a, T - .28, T)), fl = flick(e.seed, 19) * (.85 + .15 * Math.sin(a * 60));
    if (env > 0) {
      // the column: narrow tongues rising ~1.2 m, thinning towards the top
      for (let n = take(e, 'f', 800 * env * Q * dt); n > 0; n--) {
        const r = .15 * Math.sqrt(R()), th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), life = .3 + .2 * R();
        emit(g.x + cx * r, g.y + R() * .1, g.z + cz * r, -cx * .1 + RS(.08), H * 1.9 / life * (.6 + .5 * R()), -cz * .1 + RS(.08),
          life, .16 + .05 * R(), .08, .5, 1.5, COL.one, K.FLAME, 1.15, .35, 0, R() * dt);
      }
      // the bright base
      for (let n = take(e, 'b', 160 * env * Q * dt); n > 0; n--) {
        const r = .2 * Math.sqrt(R()), th = R() * TAU;
        emit(g.x + Math.cos(th) * r, g.y + .02, g.z + Math.sin(th) * r, RS(.25), .6 + .8 * R(), RS(.25), .22 + .12 * R(),
          .13 + .05 * R(), .09, 2, 1, COL.one, K.FLAME, 1.45, .2, 0, R() * dt);
      }
      for (let n = take(e, 'e', 45 * env * Q * dt); n > 0; n--)
        emit(g.x + RS(.18), g.y + R() * .8, g.z + RS(.18), RS(.5), 1.4 + 1.6 * R(), RS(.5), .5 + .5 * R(), .011, .005, 1, -.6, COL.ember, K.SPARK, 2.4, .6, .05, R() * dt);
      tA.copy(g); tA.y += H * .45; spr(S.GLOW, tA, .32, .75, 0, 0, COL.fire, .6 * env * fl, .2);
      tA.copy(g); tA.y += .1; spr(S.GLOW, tA, .3, .2, 0, 0, COL.hot, 1.1 * env * fl, 1.5);
      if (e.floor) sprFloor(S.GLOW, tB.copy(g).setY(.02), .55, COL.fire, .9 * env * fl, .3);
    }
    if (a < .1) spr(S.GLOW, tA.copy(g).setY(g.y + .15), .45, .45, 0, 0, PK, 2 * (1 - a / .1) ** 2, 1.5);
    const k = sc(a, 0, .3);
    if (e.floor) sprFloor(S.RING, tB.copy(g).setY(.02), .15 + .5 * (1 - (1 - k) ** 3), PK, 1.6 * (1 - k) ** 1.5, .06, e.seed);
    return a < T;
  }
  function pkFire(p, reason) {
    const floor = reason === 'floor' || p.y < .35, g = p.clone();
    if (floor) g.y = 0; else g.y = Math.max(0, g.y - .55); // in the air: the pillar stands round the point it struck
    add({ update: pillarFx, g, floor });
    for (let i = 0; i < 40 * Q; i++) { runit(); const sp = 1 + 2.5 * R(); emit(p.x, Math.max(.02, p.y), p.z, u3[0] * sp, Math.abs(u3[1]) * sp + .5, u3[2] * sp, .2 + .25 * R(), .012, .005, 2, -4, PK, K.SPARK, 2.6, .1, .04, 0); }
    shake(.18);
  }

  // ======================= 中: Firaga =======================
  function shotFiraga(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = now();
    const R0 = .34; // sprite radius: the visible ball is ~0.45 m across
    basis(d);
    kit.trailFire(s, dt, s.prev, p, .4, 1); // a short comet tail
    // three flame tongues orbiting the ball: spawned at rotating points just outside its surface, drifting backwards
    for (let n = take(s, 't', 330 * Q * dt); n > 0; n--) {
      const arm = (n % 3) * TAU / 3, th = t * 11 + arm + RS(.25), r = .26 + .05 * R(), c = Math.cos(th), sn = Math.sin(th);
      tA.copy(pv).multiplyScalar(c).addScaledVector(ph, sn);              // radial
      tB.copy(pv).multiplyScalar(-sn).addScaledVector(ph, c);             // tangential
      emit(p.x + tA.x * r, p.y + tA.y * r, p.z + tA.z * r,
        tB.x * 1.6 - d.x * 1.4 + tA.x * .3, tB.y * 1.6 - d.y * 1.4 + tA.y * .3 + .2, tB.z * 1.6 - d.z * 1.4 + tA.z * .3,
        .2 + .1 * R(), .08 + .03 * R(), .03, 2.5, .5, COL.one, K.FLAME, .95, .1, 0, R() * dt);
    }
    // halo of tiny embers round the ball
    for (let n = take(s, 'h', 60 * Q * dt); n > 0; n--) {
      runit(); const r = .24;
      emit(p.x + u3[0] * r, p.y + u3[1] * r, p.z + u3[2] * r, u3[0] * .8 - d.x, u3[1] * .8 - d.y + .3, u3[2] * .8 - d.z, .25 + .2 * R(), .012, .006, 2, -1, COL.ember, K.SPARK, 2.4, .3, .04, R() * dt);
    }
    const pulse = 1 + .05 * Math.sin(t * 17 + s.seed * 9);
    spr(S.GLOW, p, R0 * 3, R0 * 3, 0, 0, DEEP, .6, 0);
    spr(S.FIREBALL, p, R0 * pulse, R0 * pulse, t * .7, s.seed, COL.one, 1, .7);
    spr(S.FIREBALL, p, R0 * .7, R0 * .7, -t * 1.3, s.seed + .37, COL.one, .45, .8);
    spr(S.SWIRL, p, R0 * 1.9, R0 * 1.9, t * 2, s.seed, COL.fire, .9);
    spr(S.RING, p, R0 * .95, R0 * .95, t, s.seed, COL.hot, .5 * flick(s.seed, 13), .07);
    spr(S.RING, p, R0 * 1.05, R0 * 1.05, -t * 1.7, s.seed + .5, COL.fire, .6, .12);
    s.prev.copy(p);
  }
  function firagaFx(e) {
    const a = e.age, p = e.pos, k0 = e.k;
    if (a < .1) spr(S.GLOW, p, 1 * k0, 1 * k0, 0, 0, COL.hot, 1.3 * (1 - a / .1) ** 2, .8);
    const grow = 1 - (1 - sc(a, 0, .22)) ** 2, fb = (.3 + .38 * grow) * k0; // ball ~1.1 m across at its biggest
    spr(S.FIREBALL, p, fb, fb, e.seed * TAU, e.seed, COL.one, 1.7 * (1 - sc(a, .2, .65)), 1 - .75 * sc(a, 0, .6));
    spr(S.FIREBALL, p, fb * .75, fb * .75, -e.seed * TAU, e.seed + .5, COL.one, 1.2 * (1 - sc(a, .1, .5)), 1 - .6 * sc(a, 0, .5));
    spr(S.GLOW, p, 1.6 * k0, 1.6 * k0, 0, 0, COL.fire, .9 * (1 - sc(a, 0, .7)), .2);
    const k = sc(a, 0, .4), rr = (.25 + 1.15 * (1 - (1 - k) ** 3)) * k0;
    spr(S.RING, p, rr, rr, 0, e.seed, COL.hot, 1.6 * (1 - k) ** 1.5, .05);
    const k2 = sc(a, .06, .5), rr2 = (.2 + .9 * (1 - (1 - k2) ** 3)) * k0;
    spr(S.RING, p, rr2, rr2, 1, e.seed + .3, COL.fire, 1.1 * (1 - k2) ** 1.5, .08);
    if (a < .2) spr(S.FLARE, p, 2.6 * k0, .1 * k0, 0, 0, COL.hot, 2.2 * (1 - a / .2) ** 2);
    if (e.floor) { const kf = sc(a, 0, .5); sprFloor(S.RING, tA.copy(p).setY(.02), (.3 + 1.1 * (1 - (1 - kf) ** 3)) * k0, COL.fire, 1.4 * (1 - kf) ** 1.5, .05, e.seed); }
    return a < .8;
  }
  function firaga(p, reason) {
    const big = reason === 'hit', k = big ? 1 : .6, c = p.clone();
    if (reason === 'floor') c.y = .15;
    flameShell(c, 260 * k, 2.3 * k, 4, .16 * k, .3 * k, .55, 1.15);   // the round ball of fire
    flameShell(c, 60 * k, .5 * k, 3, .2 * k, .28 * k, .3, 1.4, .1);   // hot core
    smokeShell(c, 70 * k, 1.1 * k, .15 * k, .6 * k, 1.6);
    sparkShell(c, 160 * k, 6 * k);
    add({ update: firagaFx, pos: c, k, floor: reason === 'floor' || c.y < .5 });
    shake(big ? .55 : .3);
  }

  // ======================= 大: Explosive Flame =======================
  function shotSeed(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = now();
    const pulse = 1 + .15 * Math.sin(t * 30 + s.seed * 5);
    spr(S.GLOW, p, .5 * pulse, .5 * pulse, 0, 0, COL.fire, .55, .2);
    spr(S.GLOW, p, .2 * pulse, .2 * pulse, 0, 0, COL.hot, 1.4, 1.5);
    spr(S.GLOW, p, .09, .09, 0, 0, WHITE, 2.6, 4);
    spr(S.FLARE, p, .55 * pulse, .025, 0, 0, COL.hot, 1.2 * flick(s.seed, 29));
    spr(S.RING, p, .13 + .02 * Math.sin(t * 23), .13, t * 3, s.seed, COL.hot, .5, .12);
    for (let n = take(s, 'g', (dist * 30 + dt * 10) * Q); n > 0; n--) { // faint trail of light
      const u = R(); tA.copy(s.prev).lerp(p, u);
      emit(tA.x, tA.y, tA.z, 0, .05, 0, .3, .06, .02, 0, 0, COL.hot, K.GLOW, .5, 0, 0, (1 - u) * dt);
    }
    for (let n = take(s, 'k', (dist * 18 + dt * 12) * Q); n > 0; n--) {
      const u = R(); tA.copy(s.prev).lerp(p, u); runit(); const sp = .3 + .6 * R();
      emit(tA.x, tA.y, tA.z, u3[0] * sp - d.x * .4, u3[1] * sp - d.y * .4, u3[2] * sp - d.z * .4, .3 + .3 * R(), .01, .005, 1.5, -.5, COL.ember, K.SPARK, 2.2, .3, .03, (1 - u) * dt);
    }
    s.prev.copy(p);
  }
  // pops: secondary blooms around the core, [time, offset scale, size]
  const POPS = [[.12, .55, .8], [.26, .65, .75], [.42, .6, .7], [.58, .5, .65]];
  function explosionFx(e, dt) {
    const a = e.age, c = e.pos, g = e.ground;
    // the main sphere: swells fast, then keeps churning and slowly cools
    const sw = 1 - (1 - sc(a, 0, .18)) ** 3, br = 1 + .1 * Math.sin(a * 25);
    const R1 = (.35 + 1.0 * sw) * br * (1 - .15 * sc(a, .8, 1.4)), heat = 1 - .7 * sc(a, .3, 1.3), on = 1 - sc(a, .95, 1.45);
    if (a < .12) { spr(S.GLOW, c, 1.6, 1.6, 0, 0, WHITE, 1 * (1 - a / .12) ** 2, 1.2); spr(S.FLARE, c, 6, .16, 0, 0, COL.hot, 2.2 * (1 - a / .12) ** 1.5); }
    spr(S.GLOW, c, 2.6 * (.6 + .4 * sw), 2.6 * (.6 + .4 * sw), 0, 0, DEEP, .45 * on, 0);
    spr(S.FIREBALL, c, R1, R1, a * .6, e.seed, COL.one, 1.05 * on, heat * .85);
    spr(S.FIREBALL, c, R1 * .75, R1 * .75, -a * 1.1, e.seed + .41, COL.one, .7 * on, Math.min(1, heat + .1));
    spr(S.FIREBALL, c, R1 * .45, R1 * .45, a * 1.7, e.seed + .73, COL.one, .5 * on, .9);
    spr(S.GLOW, c, R1 * .6, R1 * .6, 0, 0, COL.hot, .35 * on * flick(e.seed, 17), .5);
    // shock rings: one facing the camera, two on the floor
    const k = sc(a, 0, .45), rr = .4 + 2.4 * (1 - (1 - k) ** 3);
    spr(S.RING, c, rr, rr, 0, e.seed, COL.hot, 2 * (1 - k) ** 1.5, .045);
    const kf = sc(a, 0, .7), rf = .4 + 2.8 * (1 - (1 - kf) ** 3);
    sprFloor(S.RING, g, rf, COL.fire, 2.2 * (1 - kf) ** 1.5, .05, e.seed);
    const kf2 = sc(a, .3, 1.1), rf2 = .3 + 2 * (1 - (1 - kf2) ** 3);
    if (a > .3) sprFloor(S.RING, g, rf2, COL.ember, 1.4 * (1 - kf2) ** 1.5, .08, e.seed + .5);
    sprFloor(S.GLOW, g, 2 * (.5 + .5 * sw), COL.fire, .7 * (1 - sc(a, .6, 1.6)), .1);
    // churning fire filling the sphere
    if (on > 0) for (let n = take(e, 'v', 420 * on * Q * dt); n > 0; n--) {
      runit(); const r = R1 * .75 * Math.cbrt(R()), sp = .6 + .8 * R();
      emit(c.x + u3[0] * r, c.y + u3[1] * r, c.z + u3[2] * r, u3[0] * sp, u3[1] * sp + .4, u3[2] * sp, .3 + .25 * R(),
        .18 + .08 * R(), .3, 2, 1.2, COL.one, K.FLAME, .9, .45, 0, R() * dt);
    }
    // secondary pops
    for (let i = 0; i < POPS.length; i++) {
      const [t0, off, sz] = POPS[i], b = a - t0, pp = e.pops[i];
      if (b < 0) continue;
      if (!pp.done) {
        pp.done = true; runit(); pp.p.set(u3[0], u3[1] * .7 + .25, u3[2]).normalize().multiplyScalar(off * (.8 + .4 * R())).add(c);
        flameShell(pp.p, 90, 2.6 * sz, 4.2, .16 * sz, .32 * sz, .45, 1);
        sparkShell(pp.p, 60, 5);
        smokeShell(pp.p, 25, .8, .25, .9, 1.8, .8);
        shake(.45);
      }
      if (b < .4) {
        const q = 1 - (1 - sc(b, 0, .15)) ** 2, f = 1 - sc(b, .15, .4);
        spr(S.FIREBALL, pp.p, (.25 + .45 * q) * sz, (.25 + .45 * q) * sz, b + i, e.seed + i * .19, COL.one, 1.05 * f, .9 - .5 * sc(b, 0, .4));
        if (b < .1) spr(S.GLOW, pp.p, 1 * sz, 1 * sz, 0, 0, COL.hot, .9 * (1 - b / .1) ** 2, .8);
        if (b < .3) { const kr = sc(b, 0, .3), r3 = (.2 + .9 * kr) * sz; spr(S.RING, pp.p, r3, r3, 0, e.seed + i, COL.hot, 1.2 * (1 - kr) ** 1.5, .06); }
      }
    }
    // the rising column of fire and the heavy dark smoke above it
    const col = Math.min(1, sc(a, .1, .3)) * (1 - sc(a, 1, 1.5));
    if (col > 0) {
      for (let n = take(e, 'c', 380 * col * Q * dt); n > 0; n--) {
        const r = .45 * Math.sqrt(R()), th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th);
        emit(c.x + cx * r, c.y + RS(.3), c.z + cz * r, cx * .3 - cz * .4, 3 + 2.5 * R(), cz * .3 + cx * .4,
          .5 + .3 * R(), .18 + .07 * R(), .3, 1, 1.5, COL.one, K.FLAME, .95, .4, 0, R() * dt);
      }
      tA.copy(c); tA.y += 1.3; spr(S.GLOW, tA, .9, 1.8, 0, 0, COL.fire, .35 * col, 0);
    }
    const smk = sc(a, .1, .3) * (1 - sc(a, 1.4, 2));
    if (smk > 0) for (let n = take(e, 's', 150 * smk * Q * dt); n > 0; n--) {
      const r = .9 * Math.sqrt(R()), th = R() * TAU;
      emit(c.x + Math.cos(th) * r, c.y + .4 + R() * 1.2, c.z + Math.sin(th) * r, RS(.4), .9 + .8 * R(), RS(.4), 1.6 + .8 * R(),
        .3, 1.1 + .4 * R(), 1, .4, COL.smoke, K.SMOKE, 1.05, .3, 0, 0);
    }
    // embers drifting out of it for the whole time
    for (let n = take(e, 'e', 160 * (1 - sc(a, .8, 1.6)) * Q * dt); n > 0; n--) {
      runit(); const sp = 1.5 + 3 * R();
      emit(c.x + u3[0] * R1 * .6, c.y + u3[1] * R1 * .6, c.z + u3[2] * R1 * .6, u3[0] * sp, u3[1] * sp + 1.5, u3[2] * sp, .6 + .7 * R(),
        .014, .006, 1.2, -1.5, COL.ember, K.SPARK, 2.5, .5, .05, R() * dt);
    }
    // flames licking the floor under it
    if (g.y < .05 && c.y < 1.8) for (let n = take(e, 'l', 200 * (1 - sc(a, .8, 1.5)) * Q * dt); n > 0; n--) {
      const r = 1.1 * Math.sqrt(R()), th = R() * TAU;
      emit(g.x + Math.cos(th) * r, .02, g.z + Math.sin(th) * r, Math.cos(th) * .5, .7 + .9 * R(), Math.sin(th) * .5, .3 + .25 * R(),
        .12 + .06 * R(), .05, 1.5, 1.2, COL.one, K.FLAME, 1.05, .3, 0, R() * dt);
    }
    if ((e.rumble = (e.rumble ?? .7) - dt) <= 0 && a < 1.2) { e.rumble = .2; shake(.25); }
    return a < 1.6;
  }
  function explosiveFlame(p, reason) {
    const c = p.clone();
    if (reason === 'floor' || c.y < .6) c.y = .6; // sitting on the floor
    flameShell(c, 260, 3.4, 3.6, .2, .4, .6, 1, .35);
    flameShell(c, 40, .8, 3, .26, .38, .35, 1.1, .1);
    sparkShell(c, 420, 9, .8);
    smokeShell(c, 110, 1.6, .25, 1.1, 2.2, 1);
    add({ update: explosionFx, pos: c, ground: new THREE.Vector3(c.x, .02, c.z), pops: POPS.map(() => ({ done: false, p: V() })) });
    shake(1);
  }

  const SHOT = { s: shotPK, m: shotFiraga, l: shotSeed };
  const LAND = { s: pkFire, m: firaga, l: explosiveFlame };
  return {
    shot(s, dt) { const f = SHOT[s.tier]; if (f) f(s, dt); else kit.classic.shot(s, dt); },
    end(s, reason) {
      const f = LAND[s.tier];
      if (!f) return kit.classic.end(s, reason);
      if (reason !== 'hit') f(s.pos, reason); // a hit was drawn by hit() just before
    },
    hit(pos, tier, power) { const f = LAND[tier]; if (f) f(pos, 'hit'); else kit.classic.hit('fire', pos, power); },
  };
}
