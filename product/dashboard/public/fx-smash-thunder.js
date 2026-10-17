// fx-smash-thunder.js: B's electric moves for the "smash" style (contract in fx-smash.js). Original effects drawn with effects.js primitives.
//   小 Thunder (Robin):   a small crackling ball, tiny arcs jumping off it; small pop on hit, fizzle otherwise
//   中 Elthunder (Robin): an arrowhead of 4 braided bolts converging on a bright point, short crackling tail; 4 rapid pulses on hit
//   大 Thunder (Pikachu): a dark thundercloud forms above the charged orb and follows it, bolts strike down along the path;
//                         wherever it ends, a massive bolt slams from the sky with a white flash, floor shock rings and crackle
export function createThunderMoves(kit) {
  const { K, S, COL, TAU, Q, R, RS, V, emit, spr, sprFloor, segV, Bolt, gen, drawBolt, runit, u3, take, sc, shake, sparkBurst, add } = kit;
  const now = () => kit.time;
  const UP = V().set(0, 1, 0), tA = V(), tB = V(), tC = V(), pX = V(), pY = V();
  const YEL = [1, .9, .5], CLOUD = [.04, .045, .075], DEEP = [.12, .26, 1];
  const H = 1.9; // cloud height above the projectile (m)
  const bolts = (n, cap) => Array.from({ length: n }, () => new Bolt(cap));
  function basis(d) { pX.crossVectors(d, UP); if (pX.lengthSq() < 1e-4) pX.set(1, 0, 0); pX.normalize(); pY.crossVectors(pX, d).normalize(); }
  const strobe = () => (R() < .3 ? .25 + .3 * R() : .8 + .4 * R());
  function sparks(p, n, sp0, sp1, life, grav = -3, col = COL.spark, inten = 2.6) {
    for (let i = 0; i < n; i++) {
      runit(); const sp = sp0 + (sp1 - sp0) * R();
      emit(p.x, p.y, p.z, u3[0] * sp, u3[1] * sp, u3[2] * sp, life * (.5 + R()), .009, .004, 2, grav, col, K.SPARK, inten, .1, .035, 0);
    }
  }

  // ---------------- 小: Thunder ----------------
  function shotS(s, dt) {
    const p = s.pos, dist = s.prev.distanceTo(p), d = s.dir;
    const st = s.ts ??= { b: bolts(4, 48) };
    if ((s.regen -= dt) <= 0) {
      s.regen = .025 + .03 * R();
      for (let i = 0; i < 4; i++) {
        const bo = st.b[i];
        if (i === 3 && R() < .5) { bo.n = 0; continue; }
        runit(); tA.set(u3[0], u3[1], u3[2]).multiplyScalar(.06).add(p);
        runit(); tB.set(u3[0], u3[1], u3[2]).multiplyScalar(.13 + .14 * R()).add(p);
        gen(bo, tA, tB, 3, .42, .3, .25);
      }
    }
    for (const bo of st.b) drawBolt(bo, .013, 2.2, COL.elec);
    for (let n = take(s, 'k', (dist * 45 + dt * 70) * Q); n > 0; n--) {
      const u = R(); tA.copy(s.prev).lerp(p, u); runit(); const sp = 1 + 1.8 * R();
      emit(tA.x + u3[0] * .06, tA.y + u3[1] * .06, tA.z + u3[2] * .06, u3[0] * sp - d.x, u3[1] * sp - d.y, u3[2] * sp - d.z,
        .08 + .12 * R(), .007, .003, 2.5, -2, COL.spark, K.SPARK, 2.6, .1, .03, (1 - u) * dt);
    }
    for (let n = take(s, 'g', dist * 22 * Q); n > 0; n--) {
      tA.copy(s.prev).lerp(p, R());
      emit(tA.x, tA.y, tA.z, -d.x * .2, -d.y * .2, -d.z * .2, .16, .07, .13, 3, 0, COL.elecGlow, K.GLOW, .5, 0, 0, 0);
    }
    const fl = strobe();
    spr(S.PLASMA, p, .085, .085, 0, s.seed, COL.elec, 2);
    spr(S.GLOW, p, .06, .06, 0, 0, COL.white, 1.3, 2.5);
    spr(S.GLOW, p, .32, .32, 0, 0, COL.elecGlow, .8 * fl, .5);
    spr(S.RING, p, .12, .12, now() * 7, s.seed, COL.spark, .9 * fl, .12);
    s.prev.copy(p);
  }
  function popS(e) {
    const a = e.age, p = e.pos;
    if (a < .2 && (e.regen = (e.regen ?? 0) - e.dt) <= 0) {
      e.regen = .03;
      for (let i = 0; i < 6; i++) { runit(); tA.set(u3[0], u3[1], u3[2]).multiplyScalar(.2 + .22 * R()).add(p); gen(e.bolts[i], p, tA, 3, .38, .35, .2); }
    }
    const fade = 1 - sc(a, .1, .26);
    for (const bo of e.bolts) drawBolt(bo, .016, 2.2 * fade, COL.elec);
    if (a < .08) spr(S.GLOW, p, .5, .5, 0, 0, COL.white, 2 * (1 - a / .08) ** 2, 1);
    spr(S.PLASMA, p, .14 * (1 - sc(a, 0, .3)), .14, 0, e.seed, COL.elec, 2);
    const k = sc(a, 0, .25);
    spr(S.RING, p, .12 + .45 * k, .12 + .45 * k, 0, e.seed, COL.elec, 1.5 * (1 - k) ** 1.5, .06);
    spr(S.GLOW, p, .45, .45, 0, 0, COL.elecGlow, .9 * (1 - sc(a, 0, .3)), .3);
    return a < .35;
  }
  function hitS(pos) {
    sparkBurst(pos, .3, 60, .7);
    add({ update: popS, pos: pos.clone(), bolts: bolts(6, 48) });
    shake(.2);
  }
  function fizzle(e) { // shared by 小 / 中 when they miss: weakening arcs, falling sparks
    const a = e.age, p = e.pos, T = e.T;
    if (a < T && (e.regen = (e.regen ?? 0) - e.dt) <= 0) {
      e.regen = .04;
      for (let i = 0; i < e.bolts.length; i++) {
        runit(); tA.set(u3[0], u3[1] * (e.floor ? .3 : 1) + (e.floor ? .1 : 0), u3[2]).multiplyScalar(e.r * (.5 + R())).add(p);
        gen(e.bolts[i], p, tA, 3, .4, .3, .15); if (R() < .4) e.bolts[i].on = 0;
      }
    }
    const fade = 1 - sc(a, 0, T);
    for (const bo of e.bolts) drawBolt(bo, e.w, 1.8 * fade, COL.elec);
    spr(S.GLOW, p, e.r * 1.6, e.r * 1.6, 0, 0, COL.elecGlow, .8 * fade * (R() < .3 ? .4 : 1), .3);
    if (e.floor) { const k = sc(a, 0, T); sprFloor(S.RING, tA.set(p.x, .02, p.z), e.r * (1 + 3 * k), COL.elec, 1.3 * (1 - k) ** 1.5, .06, e.seed); }
    return a < T;
  }
  function endS(s, reason) {
    const p = s.pos.clone(); if (reason === 'floor') p.y = Math.max(p.y, .03);
    sparks(p, Math.round(30 * Q), .6, 2, .35, -6);
    add({ update: fizzle, pos: p, bolts: bolts(3, 48), T: .28, r: .18, w: .012, floor: reason === 'floor' });
  }

  // ---------------- 中: Elthunder ----------------
  function shotM(s, dt) {
    const p = s.pos, dist = s.prev.distanceTo(p), d = s.dir;
    basis(d);
    const st = s.tm ??= { b: bolts(8, 40), core: new Bolt(64), tail: new Bolt(120), spin: R() * TAU };
    st.spin += dt * 8;
    const L = Math.min(.35 + s.travel, 1.05);
    if ((s.regen -= dt) <= 0) {
      s.regen = .028 + .02 * R();
      for (let i = 0; i < 4; i++) { // strands braided around the flight line, crossing halfway, all meeting at the tip
        const th = st.spin + i * TAU / 4, r = .24, th2 = th + Math.PI * .8;
        tA.copy(p).addScaledVector(d, -L).addScaledVector(pX, Math.cos(th) * r).addScaledVector(pY, Math.sin(th) * r);
        tB.copy(p).addScaledVector(d, -L * .45).addScaledVector(pX, Math.cos(th2) * r * .7).addScaledVector(pY, Math.sin(th2) * r * .7);
        gen(st.b[2 * i], tA, tB, 3, .2, 0, .45);
        gen(st.b[2 * i + 1], tB, p, 3, .16, 0, .7);
        st.b[2 * i].on = st.b[2 * i + 1].on = R() < .1 ? .3 : .85 + .35 * R();
      }
      tA.copy(p).addScaledVector(d, -L * 1.1);
      gen(st.core, tA, p, 4, .05, 0, .1); st.core.on = 1;
      tB.copy(p).addScaledVector(d, -Math.min(s.travel + .2, L + .7));
      gen(st.tail, tB, tA, 4, .2, .45, .3);
    }
    for (let i = 0; i < 8; i++) drawBolt(st.b[i], .024, i & 1 ? 2.6 : 2, COL.elec);
    drawBolt(st.core, .03, 2, COL.elec);
    drawBolt(st.tail, .022, 1.9, COL.elec);
    // arrowhead: four bright wings swept back from the point (an X seen head-on, a chevron from the side)
    const fl = strobe();
    tC.copy(p).addScaledVector(d, .05);
    for (let i = 0; i < 4; i++) {
      const th = st.spin * .25 + i * TAU / 4 + TAU / 8;
      tA.copy(p).addScaledVector(d, -.42).addScaledVector(pX, Math.cos(th) * .2).addScaledVector(pY, Math.sin(th) * .2);
      segV(tC, tA, .03, 2.4 * fl, COL.elec);
    }
    for (let n = take(s, 'k', (dist * 90 + dt * 50) * Q); n > 0; n--) {
      const u = R(); tA.copy(p).addScaledVector(d, -L * R()); runit(); const sp = .8 + 1.6 * R();
      emit(tA.x, tA.y, tA.z, u3[0] * sp - d.x * 2, u3[1] * sp - d.y * 2, u3[2] * sp - d.z * 2, .1 + .14 * R(), .009, .004, 2.5, -2, COL.spark, K.SPARK, 2.6, .1, .035, (1 - u) * dt);
    }
    for (let n = take(s, 'g', dist * 26 * Q); n > 0; n--) {
      tA.copy(s.prev).lerp(p, R()).addScaledVector(d, -L * .6);
      emit(tA.x, tA.y, tA.z, -d.x * .3, -d.y * .3, -d.z * .3, .25, .1, .22, 3, 0, COL.elecGlow, K.GLOW, .5, 0, 0, 0);
    }
    spr(S.GLOW, tC, .09, .09, 0, 0, COL.white, 2, 3.5);
    spr(S.PLASMA, p, .09, .09, 0, s.seed, COL.elec, 1.8);
    spr(S.GLOW, p, .5, .5, 0, 0, COL.elecGlow, .9 * fl, .5);
    tA.copy(p).addScaledVector(d, -L * .5);
    spr(S.GLOW, tA, .35, .35, 0, 0, COL.elecGlow, .4, 0);
    s.prev.copy(p);
  }
  function pulseM(e) {
    const a = e.age, p = e.pos, P = e.pulses;
    while (e.idx < P.length && a >= P[e.idx]) { // next hit of the multi-hit
      const i = e.idx++, big = 1 + .18 * i;
      e.last = P[i]; e.regen = 0;
      sparkBurst(p, .5, 45 + 15 * i, .9);
      if (i) shake(.18 + .06 * i);
      e.big = big;
    }
    const b = a - e.last, on = b < .055;
    if (on && (e.regen -= e.dt) <= 0) {
      e.regen = .028;
      for (let i = 0; i < 7; i++) {
        runit(); tA.set(u3[0], u3[1] * .8, u3[2]).normalize().multiplyScalar((.4 + .45 * R()) * e.big).add(p);
        gen(e.bolts[i], tB.set(p.x + RS(.05), p.y + RS(.05), p.z + RS(.05)), tA, 4, .3, .5, .15);
      }
    }
    if (on && a < .4) for (const bo of e.bolts) drawBolt(bo, .026 * e.big, 2.6, COL.elec);
    if (on) spr(S.GLOW, p, .55 * e.big, .55 * e.big, 0, 0, COL.white, 2.2 * (1 - b / .055) ** 1.5, 1);
    for (let i = 0; i < e.idx; i++) {
      const k = sc(a - P[i], 0, .22), rr = (.2 + .75 * (1 - (1 - k) ** 3)) * (1 + .18 * i);
      if (k < 1) spr(S.RING, p, rr, rr, i, e.seed + i, COL.elec, 1.4 * (1 - k) ** 1.5, .05);
    }
    if (a < .18) spr(S.FLARE, p, 2.4, .09, 0, 0, COL.white, 2.4 * (1 - a / .18) ** 2);
    spr(S.PLASMA, p, .22 * (1 - sc(a, 0, .45)), .22, 0, e.seed, COL.elec, 2);
    spr(S.GLOW, p, 1, 1, 0, 0, COL.elecGlow, 1.1 * (1 - sc(a, 0, .55)), .3);
    return a < .7;
  }
  function hitM(pos) {
    sparkBurst(pos, .6, 100, 1);
    add({ update: pulseM, pos: pos.clone(), bolts: bolts(7, 120), pulses: [0, .08, .17, .28], idx: 0, last: 0, big: 1 });
    shake(.45);
  }
  function endM(s, reason) {
    const p = s.pos.clone(); if (reason === 'floor') p.y = Math.max(p.y, .03);
    sparkBurst(p, .35, 50, .6);
    add({ update: fizzle, pos: p, bolts: bolts(5, 64), T: .35, r: .35, w: .018, floor: reason === 'floor' });
  }

  // ---------------- 大: Thunder (Pikachu) ----------------
  function cloudPuff(c, n, rx, ry, vx, vz, life, ageMax) {
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, r = Math.sqrt(R());
      emit(c.x + Math.cos(a) * r * rx, c.y + RS(ry), c.z + Math.sin(a) * r * rx, vx + RS(.15), RS(.06), vz + RS(.15),
        life * (.75 + .5 * R()), .36 + .12 * R(), .7 + .2 * R(), .8, 0, CLOUD, K.SMOKE, 3.3, .12, 0, R() * ageMax);
    }
  }
  function cloudFlicker(c, rx, n, inten, seed) { // lightning lighting the cloud from inside
    for (let i = 0; i < n; i++) {
      if (R() > .4) continue;
      const a = R() * TAU, r = Math.sqrt(R()) * rx;
      tA.set(c.x + Math.cos(a) * r, c.y + RS(.12), c.z + Math.sin(a) * r);
      const sz = .2 + .3 * R();
      spr(S.GLOW, tA, sz, sz * .7, 0, 0, R() < .5 ? DEEP : COL.elecGlow, inten * (.3 + R()), .2);
    }
  }
  function shotL(s, dt) {
    const p = s.pos, dist = s.prev.distanceTo(p), d = s.dir;
    const st = s.tl ??= { arcs: bolts(4, 48), strikes: [0, 1, 2].map(() => ({ bolt: new Bolt(260), t: 9, a: V(), b: V(), regen: 0, orb: true })), next: .02, c: V() };
    st.c.set(p.x, p.y + H, p.z);
    if (!st.formed) { st.formed = true; cloudPuff(st.c, Math.round(140 * Q), .6, .15, d.x * 1.5, d.z * 1.5, .9, .3); }
    for (let n = take(s, 'c', 340 * Q * dt); n > 0; n--) cloudPuff(st.c, 1, .6, .15, d.x * 1.5, d.z * 1.5, .8, dt);
    tA.copy(st.c); tA.y -= .1;
    spr(S.GLOW, tA, 1, .4, 0, 0, COL.elecGlow, .12, 0);
    cloudFlicker(st.c, .55, 3, .45, s.seed);
    // strikes from the cloud onto the orb or the floor just ahead
    if ((st.next -= dt) <= 0) {
      st.next = .09 + .08 * R();
      const k = st.strikes.find(x => x.t > .15);
      if (k) {
        k.t = 0; k.regen = 0; k.orb = R() < .65;
        k.a.set(p.x + RS(.35), p.y + H - .1, p.z + RS(.35));
        if (k.orb) k.b.copy(p);
        else { const f = .3 + .7 * R(); k.b.set(p.x + d.x * f + RS(.35), .02, p.z + d.z * f + RS(.35)); sparkBurst(k.b, .45, 40, .8); }
        shake(.12);
      }
    }
    for (const k of st.strikes) {
      if (k.t > .15) continue;
      if (k.orb) k.b.copy(p);
      if ((k.regen -= dt) <= 0) { k.regen = .035; gen(k.bolt, k.a, k.b, 5, .1, .4, .45); k.bolt.on = .85 + .4 * R(); }
      const f = k.t < .04 ? 1.4 : 1 - k.t / .15;
      drawBolt(k.bolt, .06, 2.8 * f, COL.elec);
      if (k.t < .06) spr(S.GLOW, k.a, .6, .35, 0, 0, COL.elec, .8 * (1 - k.t / .06), .3);
      if (!k.orb) { const q = sc(k.t, 0, .15); sprFloor(S.RING, k.b, .2 + .9 * q, COL.elec, 1.7 * (1 - q) ** 1.5, .05, s.seed); sprFloor(S.GLOW, k.b, .5, COL.elecGlow, f, .3); }
      k.t += dt;
    }
    // the charged orb
    if ((s.regen -= dt) <= 0) {
      s.regen = .03 + .025 * R();
      for (let i = 0; i < 4; i++) {
        runit(); tA.set(u3[0], u3[1], u3[2]).multiplyScalar(.12).add(p);
        runit(); tB.set(u3[0], u3[1], u3[2]).multiplyScalar(.28 + .25 * R()).add(p);
        gen(st.arcs[i], tA, tB, 3, .4, .35, .2);
      }
    }
    for (const bo of st.arcs) drawBolt(bo, .02, 2, COL.elec);
    for (let n = take(s, 'k', (dist * 110 + dt * 90) * Q); n > 0; n--) {
      const u = R(); tA.copy(s.prev).lerp(p, u); runit(); const sp = 1.2 + 2.5 * R();
      emit(tA.x + u3[0] * .15, tA.y + u3[1] * .15, tA.z + u3[2] * .15, u3[0] * sp - d.x, u3[1] * sp - d.y, u3[2] * sp - d.z,
        .12 + .2 * R(), .01, .004, 2, -3, COL.spark, K.SPARK, 2.6, .1, .035, (1 - u) * dt);
    }
    for (let n = take(s, 'g', dist * 20 * Q); n > 0; n--) {
      tA.copy(s.prev).lerp(p, R());
      emit(tA.x, tA.y, tA.z, -d.x * .3, -d.y * .3, -d.z * .3, .35, .2, .4, 3, 0, COL.elecGlow, K.GLOW, .5, 0, 0, 0);
    }
    const fl = strobe();
    spr(S.PLASMA, p, .2, .2, 0, s.seed, COL.elec, 2);
    spr(S.GLOW, p, .12, .12, 0, 0, YEL, 1.2, 2);
    spr(S.GLOW, p, .85, .85, 0, 0, COL.elecGlow, .95 * fl, .4);
    spr(S.RING, p, .3, .3, now() * 5, s.seed, COL.spark, .8 * fl, .08);
    s.prev.copy(p);
  }
  function slamFx(e, dt) {
    const a = e.age, p = e.pos, g = e.g, sky = e.sky, T = e.strikeT;
    while (e.si < T.length && a >= T[e.si]) {
      const i = e.si++;
      e.last = T[i]; e.str = [1, .75, .6][i]; e.regen = 0;
      if (i) { shake(.45); sparkBurst(g, .7, 80, .9); sparkBurst(p, .6, 60); }
    }
    const b = a - e.last, str = e.str;
    if (b < .24) {
      if ((e.regen -= dt) <= 0) {
        e.regen = .045;
        tA.set(sky.x + RS(.15), sky.y, sky.z + RS(.15));
        gen(e.main, tA, p, 6, .07, .3, .7); e.main.on = 1;
        if (e.low) { gen(e.main2, p, g, 4, .12, .35, 1); e.main2.on = 1; }
        for (let i = 0; i < 2; i++) {
          tB.set(sky.x + RS(.7), sky.y + RS(.1), sky.z + RS(.7)); tC.set(p.x + RS(.12), p.y + RS(.12), p.z + RS(.12));
          gen(e.side[i], tB, tC, 5, .12, .4, .35);
        }
      }
      const f = (b < .05 ? 1.5 : strobe() * (1 - b / .24)) * str;
      drawBolt(e.main, .21, 3.2 * f, COL.elec);
      if (e.low) drawBolt(e.main2, .15, 3 * f, COL.elec);
      for (const bo of e.side) drawBolt(bo, .07, 2.2 * f, COL.elec);
      for (let i = 0; i <= 4; i++) { // glow column along the bolt
        tA.copy(sky).lerp(e.low ? g : p, i / 4);
        spr(S.GLOW, tA, .75, .9, 0, 0, COL.elecGlow, .7 * f, .2);
      }
      spr(S.GLOW, sky, .9, .45, 0, 0, COL.elec, .6 * f, .3);
    }
    if (a < .1) spr(S.GLOW, p, 2.6, 2.6, 0, 0, COL.white, 2.6 * (1 - a / .1) ** 2, 1);
    if (a < .2) spr(S.FLARE, p, 4.5, .2, 0, 0, COL.white, 2.8 * (1 - a / .2) ** 2);
    if (a < .35) spr(S.GLOW, p, .6, .6, 0, 0, YEL, 1.6 * (1 - a / .35), 2);
    for (let i = 0; i < e.si; i++) {
      const k = sc(a - T[i], 0, .6), s0 = [1, .7, .55][i], rr = (.3 + 2.8 * (1 - (1 - k) ** 3)) * s0;
      if (k < 1) sprFloor(S.RING, g, rr, i ? COL.elec : COL.white, 2.4 * (1 - k) ** 1.5 * s0, .04, e.seed + i);
    }
    { const k = sc(a, 0, .4), rr = .3 + 1.4 * (1 - (1 - k) ** 3); if (k < 1) sprFloor(S.RING, g, rr, COL.elec, 2 * (1 - k) ** 2, .1, e.seed + 5); }
    const fade = 1 - sc(a, .8, 1.3);
    sprFloor(S.GLOW, g, 1.8, COL.elecGlow, 1.1 * fade, .3);
    cloudFlicker(sky, .8, 6, 1.1 * fade, e.seed);
    spr(S.RING, p, .5 + 1.3 * sc(a, 0, .3), .5 + 1.3 * sc(a, 0, .3), 0, e.seed, COL.elec, 1.6 * (1 - sc(a, 0, .3)) ** 1.5, .05);
    // lingering crackle on the struck point and over the floor
    if (a > .05 && a < 1.25) {
      if ((e.cregen = (e.cregen ?? 0) - dt) <= 0) {
        e.cregen = .05;
        for (let i = 0; i < 4; i++) { runit(); tA.set(u3[0], u3[1], u3[2]).multiplyScalar(.3 + .4 * R()).add(p); gen(e.bolts[i], p, tA, 3, .35, .3, .2); }
        for (let i = 4; i < 7; i++) { const t = R() * TAU, r = .5 + .9 * R(); tA.set(g.x + Math.cos(t) * r, .03, g.z + Math.sin(t) * r); gen(e.bolts[i], g, tA, 4, .25, .35, .15); }
      }
      for (const bo of e.bolts) drawBolt(bo, .026, 1.8 * fade, COL.elec);
      for (let n = take(e, 'k', 90 * fade * Q * dt); n > 0; n--) {
        runit(); const sp = 1 + 2.2 * R(), q = R() < .5 ? p : g;
        emit(q.x + u3[0] * .25, q.y + Math.abs(u3[1]) * .25, q.z + u3[2] * .25, u3[0] * sp, Math.abs(u3[1]) * sp, u3[2] * sp, .15 + .2 * R(), .009, .004, 2, -4, COL.spark, K.SPARK, 2.5, .1, .035, R() * dt);
      }
    }
    return a < 1.4;
  }
  function slam(pos) {
    const p = pos.clone(); p.y = Math.max(p.y, .05);
    const g = V().set(p.x, .02, p.z), sky = V().set(p.x + RS(.15), p.y + H + .1, p.z + RS(.15));
    sparkBurst(p, 1, 260, 1.2); sparkBurst(g, 1, 150, 1);
    cloudPuff(sky, Math.round(200 * Q), .85, .2, 0, 0, 1.4, .3);
    add({ update: slamFx, pos: p, g, sky, low: p.y > .25, main: new Bolt(420), main2: new Bolt(200), side: bolts(2, 300), bolts: bolts(7, 96),
      strikeT: [0, .32, .6], si: 0, last: 0, str: 1 });
    shake(1);
  }

  const SHOT = { s: shotS, m: shotM, l: shotL }, END = { s: endS, m: endM, l: (s) => slam(s.pos) }, HIT = { s: hitS, m: hitM, l: slam };
  return {
    shot(s, dt) { (SHOT[s.tier] ?? kit.classic.shot)(s, dt); },
    end(s, reason) {
      if (!SHOT[s.tier]) return kit.classic.end(s, reason);
      if (reason !== 'hit') END[s.tier](s, reason);
    },
    hit(pos, tier, power) { if (HIT[tier]) HIT[tier](pos, power); else kit.classic.hit('thunder', pos, power); },
  };
}
