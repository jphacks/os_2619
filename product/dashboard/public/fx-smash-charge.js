// fx-smash-charge.js: the charge in the "smash" style (contract in fx-smash.js).
//   aura(a, dt)   the stick look (classic) plus, while charging, a Limit-Charge-like body aura (Cloud): wisps and streaks rising
//                 from the feet up a ~0.45 m cylinder, motes drawn in and up, a pulsing ring on the floor, the body glow
//                 flickering brighter with the tier; a flash and an expanding ring when the tier becomes 中 (small) and 大 (big)
//   charge(c, dt) a Spark-Kirby-like electric sphere at the stick tip: a bright core, arcs crawling over the surface, short arcs
//                 jumping outward; it grows with the level (0.07 m -> 0.3 m) and pulses at 大. Fire = orange plasma, thunder = blue-white
//                 water: a ball of water instead (caustic orb held by two spinning rings of water, drops drawn into it)
//                 wind:  a little cyclone instead (crescents whirling round a pale vortex, stacked rings of air, air drawn in)
//   body extras per element: fire flame tongues and embers, thunder arcs, water bubbles rising and a rippling ring,
//                 wind an updraft (streak lines spiralling up the cylinder) and dust skirting the floor
//                 water also gathers UP FROM THE FLOOR into the stick tip (a whirlpool at the feet, strands and drops rising to the tip);
//                 wind also spirals IN FROM AROUND (pressure rings contracting on the caster, streaks and leaves drawn in)
export function createChargeMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, seg, Bolt, gen, drawBolt, runit, u3, take, flick, add, classic } = kit;
  const V = () => new THREE.Vector3();
  const tA = V(), tB = V(), tC = V(), tD = V(), UP = new THREE.Vector3(0, 1, 0);
  const TIER_K = { s: .32, m: .64, l: 1 };
  const PAL = {
    fire: { main: COL.fire, hot: COL.hot, glow: COL.fire, mote: COL.ember, streak: COL.ember, flash: COL.hot, arc: COL.fire, arc2: COL.hot },
    thunder: { main: COL.elec, hot: COL.white, glow: COL.elecGlow, mote: COL.spark, streak: COL.spark, flash: COL.white, arc: COL.elec, arc2: COL.spark },
    water: { main: COL.water, hot: COL.waterHi, glow: COL.waterGlow, mote: COL.waterHi, streak: COL.water, flash: COL.waterHi, arc: COL.water, arc2: COL.waterHi, si: .45 },
    wind: { main: COL.wind, hot: COL.wind, glow: COL.windGlow, mote: COL.wind, streak: COL.windGlow, flash: COL.windHi, arc: COL.wind, arc2: COL.windHi, si: .45 },
  };
  const now = () => kit.time;
  // a glowing ring lying on the floor, drawn as a loop of segments (floor-oriented sprites are back-face culled from above)
  function floorRing(F, rad, w, inten, col, wob = 0, seed = 0, y = .015) {
    if (inten <= .01 || rad <= 0) return;
    const n = Math.max(28, Math.min(56, Math.round(30 + rad * 16))), t = now();
    let px = 0, pz = 0;
    for (let i = 0; i <= n; i++) {
      const th = i / n * TAU, rr = rad * (1 + wob * Math.sin(th * 5 + t * 7 + seed * 40) * Math.sin(th * 3 - t * 5 + seed * 13));
      const x = F.x + Math.cos(th) * rr, z = F.z + Math.sin(th) * rr;
      if (i) seg(px, y, pz, x, y, z, w, inten * (.8 + .2 * Math.sin(th * 7 + t * 9 + seed * 50)), col);
      px = x; pz = z;
    }
  }

  // ---------------- body aura (Limit Charge) ----------------
  const COL_TOP = 1.9, COL_R = .45;

  // tier-up burst: a flash on the body, an expanding ring on the floor, a pillar of light; thunder adds bolts up the body
  function tierBurst(e, dt) {
    const a = e.age, big = e.big, F = e.feet, P = PAL[e.el], T = .75 * (.7 + .3 * big);
    const k = Math.min(1, a / T), ease = 1 - (1 - k) ** 3;
    tA.set(F.x, .95, F.z);
    if (a < .18) spr(S.GLOW, tA, .9 * big + .5, 1.3 * big + .8, 0, 0, P.flash, 2.4 * big * (1 - a / .18) ** 2, .6);
    if (a < .22) { tB.set(F.x, 1.2, F.z); spr(S.FLARE, tB, 2.6 * big, .07 + .05 * big, 0, 0, P.flash, 2.2 * big * (1 - a / .22) ** 2); }
    floorRing(F, .4 + 1.3 * big * ease, .04 + .03 * big, 1.1 * (1 - k) ** 1.5, P.main, .03, e.seed);
    if (big > .7) floorRing(F, .3 + .8 * ease, .03, .8 * (1 - k) ** 2, P.hot, .05, e.seed + .3);
    spr(S.GLOW, tA, .6 + .2 * big, 1.6, 0, 0, P.glow, 1.3 * big * (1 - k) ** 1.2, .2);
    if (e.el === 'thunder' && a < .35) {
      if ((e.regen = (e.regen ?? 0) - dt) <= 0) {
        e.regen = .04;
        for (const bo of e.bolts) {
          const th = R() * TAU, r = COL_R * (.8 + .4 * R());
          tC.set(F.x + Math.cos(th) * r, .02, F.z + Math.sin(th) * r);
          tD.set(F.x + Math.cos(th + RS(.6)) * r * .7, COL_TOP + .3 * R(), F.z + Math.sin(th + RS(.6)) * r * .7);
          gen(bo, tC, tD, 5, .12, .3, .3);
        }
      }
      for (const bo of e.bolts) drawBolt(bo, .03, 1.8 * (1 - a / .35), COL.elec);
    }
    return a < T;
  }
  function startBurst(a, big) {
    const F = a.opt.feet, P = PAL[a.el], fire = a.el === 'fire';
    add({ update: tierBurst, el: a.el, feet: F.clone(), big, bolts: fire ? [] : Array.from({ length: big > .7 ? 5 : 2 }, () => new Bolt(96)) });
    // a ring of streaks blown up and out from the feet
    for (let i = 0; i < (90 + 170 * big) * Q; i++) {
      const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.6 + .5 * R()), sp = (1.5 + 3 * R()) * (.6 + .5 * big);
      emit(F.x + cx * r, .05 + R() * .3, F.z + cz * r, cx * sp * .8, sp * (1 + R()), cz * sp * .8, .35 + .4 * R(), .014, .006, 2.2, -1.5,
        P.streak, K.SPARK, 2.6, .2, .06, 0);
    }
    for (let i = 0; i < 30 * Q * big; i++) {
      const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th);
      emit(F.x + cx * .3, .1, F.z + cz * .3, cx * 2.2, .4 + R(), cz * 2.2, .45 + .2 * R(), .18, .4, 3.5, 0, P.glow, K.GLOW, .7, .1, 0, 0);
    }
    if (a.el === 'water') for (let i = 0; i < 80 * Q * big; i++) { // a ring of water thrown up from the feet
      const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.8 + .3 * R()), v = 2.5 + 2.5 * R();
      emit(F.x + cx * r, .05, F.z + cz * r, cx * .9, v, cz * .9, .5 + .3 * R(), .02, .012, .5, -9, R() < .3 ? COL.waterHi : COL.water, K.DROP, 1.3, 0, .03, 0);
    }
    if (a.el === 'wind') for (let i = 0; i < 40 * Q * big; i++) { // dust blown out flat from the feet
      const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), v = 2 + 2 * R();
      emit(F.x + cx * .3, .06, F.z + cz * .3, cx * v - cz, .2 + .4 * R(), cz * v + cx, .6 + .4 * R(), .12, .5, 2.5, .2, COL.dust, K.SMOKE, .8, .3, 0, 0);
    }
    if (fire) for (let i = 0; i < 60 * Q * big; i++) {
      const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.7 + .4 * R());
      emit(F.x + cx * r, .05, F.z + cz * r, cx * .6, 2 + 2.5 * R(), cz * .6, .4 + .3 * R(), .1 + .06 * R(), .03, 1.5, 1.5, COL.one, K.FLAME, 1.1, .3, 0, 0);
    }
    kit.shake(.15 + .35 * big);
  }

  function limitCharge(a, dt) {
    const o = a.opt, F = o.feet, P = PAL[a.el], fire = a.el === 'fire', tier = o.tier;
    const target = o.charging && tier ? TIER_K[tier] + .08 * (o.level ?? 0) : 0;
    a.lk = (a.lk ?? 0) + (target - (a.lk ?? 0)) * Math.min(1, dt * (target > (a.lk ?? 0) ? 6 : 4));
    // tier changes: 中 a small pulse, 大 the big flash
    const tr = o.charging ? tier : null;
    if (tr !== a.lcTier) { if (!o.feet) {} else if (tr === 'm') startBurst(a, .45); else if (tr === 'l') startBurst(a, 1); a.lcTier = tr; }
    const k = a.lk;
    if (k < .02 || !F) return;
    const t = now(), full = tier === 'l' && o.charging, fl = flick(a.seed, fire ? 17 : 31);
    const spike = full && R() < .1 ? 1.5 : 1;

    // floor: a soft pool of light, a ring that breathes, rings pulsing outward
    tA.set(F.x, .02, F.z);
    tA.y = .06; spr(S.GLOW, tA, .95 + .3 * k, .4 + .1 * k, 0, 0, P.glow, (.3 + .6 * k) * fl, .2);
    const br = .5 + .5 * Math.sin(t * (4 + 6 * k));
    floorRing(F, (COL_R + .15) * (1 + .05 * br), .03 + .02 * k, (.3 + .55 * k) * (.75 + .25 * br) * spike, P.main, .015 + .02 * k, a.seed);
    const rate = .7 + 1.8 * k;
    for (let j = 0; j < (k > .5 ? 2 : 1); j++) {
      const ph = (t * rate + j * .5 + a.seed) % 1;
      floorRing(F, .3 + .7 * ph, .02 + .012 * k, .6 * k * (1 - ph) ** 1.6, P.main, .02, a.seed + j);
    }

    // the body: a tall glow and a hollow energy capsule around it, flickering brighter with the tier
    tA.set(F.x, .95, F.z);
    spr(S.GLOW, tA, .6 + .15 * k, 1.2, 0, 0, P.glow, (.2 + .45 * k) * fl * spike, .1);
    spr(S.GHOST, tA, .4 + .06 * k, 1.0, 0, a.seed + Math.floor(t * 12) * .37, P.main, (.2 + .55 * k) * fl * spike);
    if (k > .5) { tB.set(F.x, 1.25, F.z); spr(S.GLOW, tB, .35, .35, 0, 0, P.hot, .35 * (k - .5) * fl * spike, .5); }

    // streaks rising up the cylinder (the Limit Charge look), slightly spiralling and drawn inward
    for (let n = take(a, 'lcS', (40 + 340 * k * k) * Q * dt); n > 0; n--) {
      const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.75 + .4 * R()), y = R() * .5;
      const up = 2.2 + 2.8 * R() * (.5 + k), sw = .5 + .6 * k;
      emit(F.x + cx * r, y, F.z + cz * r, -cx * .25 - cz * sw, up, -cz * .25 + cx * sw, .4 + .35 * R(), .016 + .008 * k, .006, .6, 1.2,
        R() < .3 ? P.hot : P.streak, K.SPARK, (2.2 + 1.6 * k) * (P.si ?? 1), .15, .1 + .06 * k, R() * dt);
    }
    // light streaks shooting up the cylinder (segments: crisp lines that read at any distance)
    const ls = a.lcLines ??= Array.from({ length: 20 }, () => ({ th: R() * TAU, y: R() * COL_TOP, sp: 2, len: .3 }));
    const nL = Math.min(ls.length, Math.round(4 + 15 * k * k));
    for (let i = 0; i < nL; i++) {
      const l = ls[i];
      l.y += l.sp * dt;
      if (l.y - l.len > COL_TOP) { l.th = R() * TAU; l.y = R() * .3; l.sp = (2.5 + 2.5 * R()) * (.6 + .6 * k); l.len = .2 + .35 * R() * (.5 + k); l.r = COL_R * (.85 + .3 * R()); }
      const r = l.r ?? COL_R, x = F.x + Math.cos(l.th) * r, z = F.z + Math.sin(l.th) * r, y0 = Math.max(0, l.y - l.len), y1 = Math.min(COL_TOP + .2, l.y);
      if (y1 > y0) seg(x, y0, z, x, y1, z, .008 + .006 * k, (.35 + .9 * k) * (1 - .5 * l.y / COL_TOP) * fl * (P.si ?? 1), i & 1 ? P.main : P.streak);
    }
    // translucent wisps: fire = flame tongues licking up from the ring, thunder = pale glow puffs
    if (fire) {
      for (let n = take(a, 'lcF', (15 + 110 * k) * Q * dt); n > 0; n--) {
        const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.85 + .3 * R()), y = R() * R() * 1.2;
        emit(F.x + cx * r, y, F.z + cz * r, -cx * .2, .8 + 1.4 * R() * (.4 + k), -cz * .2, .45 + .35 * R(), (.07 + .07 * R()) * (.7 + .5 * k), .02, 1.4, 1.6,
          COL.one, K.FLAME, .45 + .4 * k, .25, 0, R() * dt);
      }
    }
    for (let n = take(a, 'lcW', (8 + 40 * k) * Q * dt); n > 0; n--) {
      const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.6 + .4 * R());
      emit(F.x + cx * r, R() * .8, F.z + cz * r, -cx * .1, .7 + .9 * R(), -cz * .1, .8 + .5 * R(), .14, .26, .5, .4, P.glow, K.GLOW, .22 + .3 * k, .3, 0, R() * dt);
    }
    // motes drawn in from around the player towards the body and up
    for (let n = take(a, 'lcM', (15 + 110 * k) * Q * dt); n > 0; n--) {
      const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r0 = .85 + .5 * R(), y0 = .1 + R() * 1.6, life = .45 + .3 * R();
      const r1 = COL_R * .5, y1 = Math.min(COL_TOP, y0 + .3 + .4 * R());
      emit(F.x + cx * r0, y0, F.z + cz * r0, cx * (r1 - r0) / life - cz * .4, (y1 - y0) / life, cz * (r1 - r0) / life + cx * .4, life, .014, .006, 0, 0,
        P.mote, fire ? K.EMBER : K.SPARK, 1.6 + 1.2 * k, 0, .05, R() * dt);
    }
    BODY[a.el]?.(a, F, k, dt);
    // thunder: small arcs crackling over the body (bolts 4..9; 0..3 belong to the classic stick)
    if (a.el === 'thunder') {
      const nb = Math.min(6, Math.round(1 + 5 * k * k) + (full ? 1 : 0));
      if ((a.lcRegen = (a.lcRegen ?? 0) - dt) <= 0) {
        a.lcRegen = .05 + .04 * R();
        for (let i = 0; i < 6; i++) {
          const bo = a.bolts[4 + i];
          if (i >= nb) { bo.n = 0; continue; }
          const th = R() * TAU, r = COL_R * (.8 + .3 * R()), y = .05 + R() * 1.75, L = (.18 + .3 * R()) * (.6 + .6 * k);
          tA.set(F.x + Math.cos(th) * r, y, F.z + Math.sin(th) * r);
          const th2 = th + RS(.7);
          tB.set(F.x + Math.cos(th2) * r * 1.05, Math.min(COL_TOP + .1, y + L), F.z + Math.sin(th2) * r * 1.05);
          gen(bo, tA, tB, 3, .35, .3, .3);
        }
      }
      for (let i = 0; i < 6; i++) drawBolt(a.bolts[4 + i], .016, 1.5 * Math.min(1, k * 1.4), COL.elec);
    } else if (fire && k > .55) { // fire at 中/大: embers flying up off the body
      for (let n = take(a, 'lcE', 70 * (k - .3) * Q * dt); n > 0; n--) {
        const th = R() * TAU, r = COL_R * R();
        emit(F.x + Math.cos(th) * r, .2 + R() * 1.4, F.z + Math.sin(th) * r, RS(.5), 1 + 1.5 * R(), RS(.5), .6 + .5 * R(), .012, .006, 1.2, .4,
          COL.ember, K.SPARK, 2.2, .7, .05, R() * dt);
      }
    }
  }

  // body extras of the elements without flames or arcs
  const BODY = {
    water(a, F, k, dt) { // bubbles rising round the body, a wobbling ring of water on the floor
      for (let n = take(a, 'lcB', (10 + 70 * k) * Q * dt); n > 0; n--) {
        const th = R() * TAU, r = COL_R * (.6 + .5 * R());
        emit(F.x + Math.cos(th) * r, R() * .4, F.z + Math.sin(th) * r, RS(.1), .6 + 1.2 * R() * (.5 + k), RS(.1), .9 + .6 * R(), .018 + .014 * R(), .03, .8, .6,
          R() < .3 ? COL.waterHi : COL.water, K.DROP, 1.1 + .4 * k, .35, 0, R() * dt);
      }
      floorRing(F, COL_R + .05, .025 + .02 * k, .5 + .6 * k, COL.waterHi, .06 + .04 * k, a.seed + .7);
      // water gathered up from the floor into the tip: a whirlpool round the feet, three strands and drops rising to the tip
      const T = a.tip, t = now(); if (!T) return;
      sprFloor(S.VORTEX, tA.set(F.x, .02, F.z), .55 + .55 * k, COL.water, .4 + .8 * k, 1 + 3 * k, a.seed);
      for (let h = 0; h < 3; h++) {
        let px = 0, py = 0, pz = 0;
        for (let i = 0; i <= 12; i++) {
          const u = i / 12, th = h * TAU / 3 + t * 5 + u * 5, r = (.7 + .2 * k) * (1 - u) ** 1.3, w = u ** 1.6;
          const x = F.x + Math.cos(th) * r + (T.x - F.x) * w, y = .03 + (T.y - .03) * u, z = F.z + Math.sin(th) * r + (T.z - F.z) * w;
          const fl = .5 + .5 * Math.sin(u * 14 - t * 16 + h * 2);
          if (i) seg(px, py, pz, x, y, z, .01 + .012 * k * (1 - u * .5), (.3 + .9 * k) * fl * Math.sin(Math.PI * Math.min(1, u * 1.1)), fl > .75 ? COL.waterHi : COL.water);
          px = x; py = y; pz = z;
        }
      }
      for (let n = take(a, 'lcU', (15 + 120 * k) * Q * dt); n > 0; n--) {
        const th = R() * TAU, r = .5 + .45 * R(), x = F.x + Math.cos(th) * r, z = F.z + Math.sin(th) * r, life = .35 + .25 * R();
        emit(x, .03, z, (T.x - x) / life, (T.y - .03) / life, (T.z - z) / life, life, .028, .012, 0, 0, R() < .4 ? COL.waterHi : COL.water, K.DROP, 1.3, .2, .03, R() * dt);
      }
    },
    wind(a, F, k, dt) { // an updraft: streak lines spiralling up the cylinder, dust skirting the floor
      const t = now(), nl = Math.round(3 + 6 * k);
      for (let i = 0; i < nl; i++) {
        const ph = (t * (.6 + .5 * k) + i / nl) % 1, th0 = i / nl * TAU + t * (2 + 3 * k), r = COL_R * (1 - .25 * ph);
        let px = 0, py = 0, pz = 0;
        for (let j = 0; j <= 6; j++) {
          const u = j / 6, th = th0 + u * 1.4, y = (ph * COL_TOP + u * .45) % (COL_TOP + .3);
          const x = F.x + Math.cos(th) * r, z = F.z + Math.sin(th) * r;
          if (j && y > py) seg(px, py, pz, x, y, z, .008 + .006 * k, (.4 + .9 * k) * Math.sin(Math.PI * u) * (1 - .5 * ph), j & 1 ? COL.wind : COL.windHi);
          px = x; py = y; pz = z;
        }
      }
      for (let n = take(a, 'lcD', (6 + 30 * k) * Q * dt); n > 0; n--) {
        const th = R() * TAU, c = Math.cos(th), sn = Math.sin(th), r = COL_R * (.9 + .6 * R());
        emit(F.x + c * r, .04, F.z + sn * r, -sn * 1.6 + c * .5, .1 + .3 * R(), c * 1.6 + sn * .5, .7 + .5 * R(), .18, .7, 1.5, .1, COL.dust, K.SMOKE, .22, .6, 0, R() * dt);
      }
      // air spiralling in from all round: pressure rings contracting on the caster (floor and chest height), streaks and leaves drawn in
      for (let j = 0; j < 2; j++) {
        const ph = (t * (.7 + .8 * k) + j * .5 + a.seed) % 1, f = Math.sin(Math.PI * ph) * k;
        floorRing(F, 2.1 * (1 - ph) + COL_R + .1, .02 + .015 * k, 1.1 * f, j ? COL.wind : COL.windHi, .02, a.seed + j);
        if (k > .4) floorRing(F, 1.5 * (1 - ph) + COL_R + .05, .012 + .01 * k, .8 * f, COL.wind, .04, a.seed + j + .5, .9 + .3 * j);
      }
      for (let n = take(a, 'lcI', (20 + 140 * k) * Q * dt); n > 0; n--) {
        const th = R() * TAU, c = Math.cos(th), sn = Math.sin(th), r = 1.5 + .8 * R(), v = 3 + 3 * R(), life = (r - COL_R) / v;
        emit(F.x + c * r, .1 + R() * 1.8, F.z + sn * r, -c * v - sn * v * .6, .2, -sn * v + c * v * .6, life, .008, .004, 0, 0, R() < .4 ? COL.windHi : COL.wind, K.SPARK, 1.7, .05, .07, R() * dt);
      }
      for (let n = take(a, 'lcL', 8 * k * Q * dt); n > 0; n--) {
        const th = R() * TAU, c = Math.cos(th), sn = Math.sin(th), r = 1.8, life = .8;
        emit(F.x + c * r, .1 + R() * 1.2, F.z + sn * r, -c * 1.8 - sn * 2, .3, -sn * 1.8 + c * 2, life, .055, .04, .3, -.3, COL.leaf ?? COL.dust, K.LEAF, 1, .3, RS(9), R() * dt);
      }
    },
  };

  // ---------------- stick-tip sphere (Spark Kirby) ----------------
  // an arc crawling over the sphere: a jittered polyline along the great circle from u to v, written straight into a Bolt
  function surfArc(b, p, r, u, v, n, jit, brp) {
    b.n = 0;
    const d = b.d;
    let px = p.x + u.x * r, py = p.y + u.y * r, pz = p.z + u.z * r;
    for (let i = 1; i <= n && b.n < b.cap; i++) {
      const s = i / n;
      tC.copy(u).lerp(v, s);
      if (i < n) tC.x += RS(jit), tC.y += RS(jit), tC.z += RS(jit);
      tC.normalize();
      const rr = r * (1.02 + RS(.07)), qx = p.x + tC.x * rr, qy = p.y + tC.y * rr, qz = p.z + tC.z * rr, it = .45 + .55 * Math.sin(Math.PI * (s - .5 / n));
      let o = b.n++ * 8;
      d[o] = px; d[o + 1] = py; d[o + 2] = pz; d[o + 3] = qx; d[o + 4] = qy; d[o + 5] = qz; d[o + 6] = 1; d[o + 7] = it;
      if (brp > 0 && i < n && R() < brp && b.n + 2 <= b.cap) { // a short fork lifting off the surface
        runit(); const l = r * (.25 + .35 * R());
        const ex = qx + (tC.x * .8 + u3[0] * .6) * l, ey = qy + (tC.y * .8 + u3[1] * .6) * l, ez = qz + (tC.z * .8 + u3[2] * .6) * l;
        const mx = (qx + ex) / 2 + RS(l * .3), my = (qy + ey) / 2 + RS(l * .3), mz = (qz + ez) / 2 + RS(l * .3);
        o = b.n++ * 8; d[o] = qx; d[o + 1] = qy; d[o + 2] = qz; d[o + 3] = mx; d[o + 4] = my; d[o + 5] = mz; d[o + 6] = .6; d[o + 7] = it * .7;
        o = b.n++ * 8; d[o] = mx; d[o + 1] = my; d[o + 2] = mz; d[o + 3] = ex; d[o + 4] = ey; d[o + 5] = ez; d[o + 6] = .45; d[o + 7] = it * .4;
      }
      px = qx; py = qy; pz = qz;
    }
  }
  const randUnit = o => { runit(); return o.set(u3[0], u3[1], u3[2]); };
  function sphereState(c) {
    if (c.sp) return c.sp;
    c.sp = {
      surf: Array.from({ length: 12 }, () => ({ b: new Bolt(40), u: randUnit(V()), v: V(), w: randUnit(V()), t: 0, span: 0 })),
      out: Array.from({ length: 8 }, () => ({ b: new Bolt(64), t: 0 })),
    };
    for (const s of c.sp.surf) { s.span = .7 + .9 * R(); s.v.copy(s.u).applyAxisAngle(s.w, s.span); }
    return c.sp;
  }

  function sparkSphere(c, dt) {
    const L = c.v, p = c.tip, fire = c.el === 'fire', P = PAL[c.el], tier = c.opt?.tier, full = tier === 'l' || L >= .999, t = now();
    const sp = sphereState(c);
    const pulse = full ? 1 + .1 * Math.sin(t * 17) + .05 * Math.sin(t * 41) : 1 + .03 * Math.sin(t * 9);
    const r = (.07 + .23 * L) * pulse, fl = flick(c.seed, fire ? 21 : 37);

    // core and body
    spr(S.GLOW, p, r * 2.5, r * 2.5, 0, 0, P.glow, (.35 + .4 * L) * fl, .1);
    if (fire) spr(S.FIREBALL, p, r * .9, r * .9, t * .8, c.seed, COL.one, .7 + .3 * L, .85);
    spr(S.PLASMA, p, r * 1.25, r * 1.25, t * .6, c.seed, P.main, (fire ? .9 : 1.05) + .25 * L);
    spr(S.PLASMA, p, r * 1.1, r * 1.1, -t * 1.1, c.seed + .5, fire ? COL.ember : COL.spark, .5 + .15 * L);
    spr(S.GLOW, p, r * .6, r * .6, 0, 0, P.hot, (.7 + .2 * L) * fl, .6);
    spr(S.RING, p, r * 1.04 / .8, r * 1.04 / .8, t * 2, c.seed, P.main, (.6 + .5 * L) * fl, .07);
    if (full) {
      const ph = (t * 2.4) % 1;
      spr(S.RING, p, r * (1.1 + 1 * ph) / .8, r * (1.1 + 1 * ph) / .8, 0, c.seed + .2, P.hot, 1.3 * (1 - ph) ** 1.5, .06);
    }

    // arcs crawling over the surface: each one drifts round the sphere a little every regen and now and then jumps elsewhere
    const nS = Math.min(12, Math.round(3 + 7 * L) + (full ? 2 : 0)), w = .009 + .012 * L;
    for (let i = 0; i < 12; i++) {
      const s = sp.surf[i];
      if (i >= nS) { s.b.n = 0; continue; }
      if ((s.t -= dt) <= 0) {
        s.t = .035 + .045 * R();
        if (R() < .15) { randUnit(s.u); randUnit(s.w); s.span = .7 + .9 * R(); }
        else { s.u.applyAxisAngle(s.w, .2 + .25 * R()); }
        s.v.copy(s.u).applyAxisAngle(tD.crossVectors(s.w, s.u).normalize(), s.span * (.8 + .4 * R()));
        surfArc(s.b, p, r, s.u, s.v, 7, .13, .15 + .25 * L);
        s.b.on = R() < .85 ? .7 + .5 * R() : .15;
      }
      drawBolt(s.b, w, 1.5 + .5 * L, i & 1 ? P.arc2 : P.arc);
    }
    // short arcs jumping outward from the surface
    const nO = Math.min(8, Math.round(1 + 4 * L) + (full ? 3 : 0));
    for (let i = 0; i < 8; i++) {
      const s = sp.out[i];
      if (i >= nO) { s.b.n = 0; continue; }
      if ((s.t -= dt) <= 0) {
        s.t = .045 + .06 * R();
        randUnit(tA); tB.copy(tA).multiplyScalar(r).add(p);
        tC.copy(tA).addScaledVector(randUnit(tD), .5).normalize().multiplyScalar(r * (1.3 + .6 * R()) + .03 + .05 * R()).add(p);
        gen(s.b, tB, tC, 3, .38, .15, .12);
        if (R() < .35) s.b.on = 0;
      }
      drawBolt(s.b, w * .9, 1.6, P.arc);
    }

    // particles: sparks skating off the surface, motes drawn in; fire also licks small flames inward
    for (let n = take(c, 'sk', (30 + 170 * L) * Q * dt); n > 0; n--) {
      randUnit(tA); tB.crossVectors(tA, randUnit(tD)).normalize();
      const v = 1.2 + 2.5 * R();
      emit(p.x + tA.x * r, p.y + tA.y * r, p.z + tA.z * r, tB.x * v + tA.x * .8, tB.y * v + tA.y * .8, tB.z * v + tA.z * .8, .1 + .15 * R(), .008, .004, 3, fire ? -1 : 0,
        fire ? COL.ember : COL.spark, K.SPARK, 2.4, .05, .04, R() * dt);
    }
    for (let n = take(c, 'in', (25 + 120 * L) * Q * dt); n > 0; n--) {
      randUnit(tA); const r0 = r * (2.2 + 1.2 * R()) + .08, life = .16 + .12 * R(), v = (r0 - r * .3) / life;
      emit(p.x + tA.x * r0, p.y + tA.y * r0, p.z + tA.z * r0, -tA.x * v, -tA.y * v, -tA.z * v, life, .01, .006, 0, 0, P.mote, K.SPARK, 2, 0, .045, R() * dt);
    }
    if (fire) for (let n = take(c, 'fl', (20 + 110 * L) * Q * dt); n > 0; n--) {
      randUnit(tA); const r0 = r * (1.4 + .6 * R()), life = .2 + .12 * R(), v = (r0 - r * .5) / life;
      tB.crossVectors(tA, UP);
      emit(p.x + tA.x * r0, p.y + tA.y * r0, p.z + tA.z * r0, -tA.x * v + tB.x * v * .4, -tA.y * v, -tA.z * v + tB.z * v * .4, life, .025 + .03 * L, .04 + .05 * L, 0, 0,
        COL.one, K.FLAME, .8, .04, 0, R() * dt);
    }
    if (full) for (let n = take(c, 'bz', 50 * Q * dt); n > 0; n--) {
      randUnit(tA); const v = 1 + 1.5 * R();
      emit(p.x + tA.x * r, p.y + tA.y * r, p.z + tA.z * r, tA.x * v, tA.y * v + (fire ? .5 : 0), tA.z * v, .3 + .3 * R(), .011, .005, 1.5, fire ? -1.5 : -2,
        fire ? COL.ember : COL.spark, K.SPARK, 2.4, .25, .04, R() * dt);
    }
  }

  // water: a ball of water swelling at the stick tip, held by two rings of water spinning round it, drops drawn in
  function waterSphere(c, dt) {
    const L = c.v, p = c.tip, full = c.opt?.tier === 'l' || L >= .999, t = now();
    const r = (.07 + .23 * L) * (full ? 1 + .06 * Math.sin(t * 13) : 1);
    spr(S.GLOW, p, r * 3, r * 3, 0, 0, COL.waterGlow, .45 + .4 * L, .05);
    spr(S.WATER, p, r, r, 0, c.seed, COL.water, 1.2 + .3 * L, 2 + 3 * L);
    for (let ring = 0; ring < 2; ring++) {
      const tilt = ring ? 1 : -1, spin = t * (4 + 5 * L) * (ring ? -1 : 1), N = 20;
      let px = 0, py = 0, pz = 0;
      for (let i = 0; i <= N; i++) {
        const th = i / N * TAU;
        tA.set(Math.cos(th), Math.sin(th) * Math.cos(tilt), Math.sin(th) * Math.sin(tilt)).applyAxisAngle(UP, spin).multiplyScalar(r * 1.45).add(p);
        const sh = .55 + .45 * Math.sin(th * 3 - t * 15 + ring);
        if (i) seg(px, py, pz, tA.x, tA.y, tA.z, .01 + .012 * L, (.4 + .5 * L) * (.5 + .7 * sh), sh > .8 ? COL.waterHi : COL.water);
        px = tA.x; py = tA.y; pz = tA.z;
      }
    }
    for (let n = take(c, 'in', (30 + 150 * L) * Q * dt); n > 0; n--) {
      runit(); const r0 = r * (2 + 1.2 * R()) + .08, life = .2 + .12 * R(), v = (r0 - r * .4) / life;
      emit(p.x + u3[0] * r0, p.y + u3[1] * r0, p.z + u3[2] * r0, -u3[0] * v, -u3[1] * v, -u3[2] * v, life, .014, .01, 0, 0, COL.waterHi, K.DROP, 1.2, 0, .03, R() * dt);
    }
    if (full) {
      const ph = (t * 2.2) % 1; spr(S.RING, p, r * (1.2 + ph) / .8, r * (1.2 + ph) / .8, 0, c.seed, COL.waterHi, 1.2 * (1 - ph) ** 1.5, .06);
      for (let n = take(c, 'dr', 30 * Q * dt); n > 0; n--) { runit(); emit(p.x + u3[0] * r, p.y + u3[1] * r, p.z + u3[2] * r, u3[0] * 1.2, u3[1] * 1.2 + .5, u3[2] * 1.2, .4 + .3 * R(), .016, .01, .5, -8, COL.water, K.DROP, 1.2, 0, .03, R() * dt); }
    }
  }
  // wind: a little cyclone: crescents whirling round a pale vortex, rings of air turning at different rates, air drawn in
  function windSphere(c, dt) {
    const L = c.v, p = c.tip, full = c.opt?.tier === 'l' || L >= .999, t = now();
    const r = (.08 + .24 * L) * (full ? 1 + .05 * Math.sin(t * 17) : 1), spin = t * (8 + 10 * L);
    spr(S.GLOW, p, r * 2.4, r * 2.4, 0, 0, COL.windGlow, .25 + .25 * L, .3);
    spr(S.SWIRL, p, r * 1.4, r * 1.4, 0, c.seed, COL.wind, .6 + .6 * L);
    const nc = full ? 4 : 3;
    for (let i = 0; i < nc; i++) spr(S.CRESCENT, p, r, r, -spin + i * TAU / nc, c.seed + i * .2, COL.wind, .7 + .6 * L, .24);
    for (let j = 0; j < 3; j++) {
      const y = (j - 1) * r * .55, rr = r * (1.05 + .2 * j), sp = spin * (1.3 - .25 * j) + j;
      for (let i = 0; i < 2; i++) {
        let px = 0, py = 0, pz = 0;
        for (let q = 0; q <= 7; q++) {
          const th = sp + i * Math.PI + q / 7 * 1.9, x = p.x + Math.cos(th) * rr, z = p.z + Math.sin(th) * rr;
          if (q) seg(px, py, pz, x, p.y + y, z, .006 + .008 * L, (.5 + .7 * L) * Math.sin(Math.PI * q / 7), (i + j) % 2 ? COL.wind : COL.windHi);
          px = x; py = p.y + y; pz = z;
        }
      }
    }
    for (let n = take(c, 'in', (40 + 200 * L) * Q * dt); n > 0; n--) {
      runit(); const r0 = r * 2.2 + .12 * R(), life = .15 + .1 * R(), v = r0 / life; tA.set(u3[0], u3[1], u3[2]); tB.crossVectors(tA, UP);
      emit(p.x + u3[0] * r0, p.y + u3[1] * r0, p.z + u3[2] * r0, -u3[0] * v + tB.x * v, -u3[1] * v, -u3[2] * v + tB.z * v, life, .007, .004, 0, 0, COL.wind, K.SPARK, 1.8, 0, .06, R() * dt);
    }
    if (full) { const ph = (t * 2.6) % 1; spr(S.RING, p, r * (1.1 + ph) / .8, r * (1.1 + ph) / .8, 0, c.seed, COL.windHi, 1.1 * (1 - ph) ** 1.5, .035); }
  }
  const SPHERE = { water: waterSphere, wind: windSphere };

  return {
    aura(a, dt) { classic.aura(a, dt); limitCharge(a, dt); },
    charge(c, dt) { (SPHERE[c.el] ?? sparkSphere)(c, dt); },
  };
}
