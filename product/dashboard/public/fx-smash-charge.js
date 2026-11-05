// fx-smash-charge.js: the charge in the "smash" style (contract in fx-smash.js).
//   aura(a, dt)   the stick look (classic) plus, while charging, a body of the element's own (BODY): 小 low at the feet, 中 up the
//                 body, the last ~0.35 s before 大 everything is drawn in (anticipation), 大 reached: a ground shockwave, a short
//                 flash and element debris, then a taller pulsing look with an aftershock ring every ~0.7 s
//                 fire = a flame wreath climbing with the tier, embers spiralling in, hot streaks, dark smoke at 大
//                 thunder (yellow) = arcs crawling up the body, crackle flashes, a stuttering ring and arcs over the floor, tip-to-ground bolts at 大
//                 water = ribbons of water spiralling up, a whirlpool, ripples (and the magic circle, fx-smash-circle.js)
//                 wind = bands of wind wound round the body, a dust swirl, leaves and air pulled in, pressure rings
//   charge(c, dt) the stick tip: thunder = a Spark-Kirby-like electric sphere (arcs over the surface and jumping out); fire = a flame
//                 orb (no arcs) with tongues licking up off it; water = a shader sphere of water; wind = a ball of compressed air
export function createChargeMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, seg, Bolt, gen, drawBolt, runit, u3, take, flick, add, classic } = kit;
  const WW = kit.ww, wmesh = (el, shape, p, sc, o) => WW?.mesh(el, shape, p, sc, o), wspr = (el, tex, p, w, h, o) => WW?.[el].sprite(tex, p, w, h, o);
  const hash = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const WB = { a: [.02, .17, .78], b: [.38, .86, 1] }, AW = { a: [.5, .66, .68], b: [.95, 1, 1] }, AD = { a: [.36, .33, .28], b: [.7, .65, .56] };
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

  // ---------------- body ----------------
  // Every element has its own body (BODY below); what they share is the timing, so the tiers read the same way for all four:
  //   小 a small, low effect at the feet; 中 it climbs the body; the last ~0.35 s before 大 everything is drawn in (anticipation);
  //   大 reached: a ground shockwave, a short flash and element debris (fullBurst), then a sustained, pulsing, taller look with
  //   an aftershock ring every ~0.7 s. The 中 step gets a small version of the burst.
  const COL_TOP = 1.9, COL_R = .45, sc = kit.sc;
  const FLOOR = { fire: [.55, .1, .01], thunder: [.6, .35, 0], water: [.02, .12, .6], wind: [.35, .48, .5] }; // the floor pool: low value, saturated

  // the tier-up burst, drawn for T s: a crisp double ring running out over the floor in the element's colour (not a white wash),
  // a short flash at the chest, element debris; thunder adds bolts up the body and over the floor
  function tierBurst(e, dt) {
    const a = e.age, big = e.big, F = e.feet, P = PAL[e.el], T = .7 * (.7 + .3 * big);
    const k = Math.min(1, a / T), ease = 1 - (1 - k) ** 3;
    tA.set(F.x, 1, F.z);
    if (a < .1) spr(S.GLOW, tA, .55 + .3 * big, .9 + .5 * big, 0, 0, P.flash, 1.2 * big * (1 - a / .1) ** 2, .5);
    if (a < .16) { tB.set(F.x, 1.1, F.z); spr(S.FLARE, tB, 1.8 * big + .4, .05 + .04 * big, 0, 0, P.flash, 1.6 * big * (1 - a / .16) ** 2); }
    floorRing(F, .4 + 1.8 * big * ease, .045 + .035 * big, 1.6 * (1 - k) ** 1.5, P.main, .03, e.seed);
    floorRing(F, .3 + 1.2 * big * Math.min(1, ease * 1.15), .025, 1.2 * (1 - k) ** 2, P.hot, .05, e.seed + .3);
    if (e.el === 'wind') floorRing(F, .5 + 2.6 * big * Math.min(1, a / .3), .02, 1.4 * Math.max(0, 1 - a / .3), COL.windHi, .01, e.seed + .6); // the pressure front, fast and thin
    if (e.el === 'thunder' && a < .4) {
      if ((e.regen = (e.regen ?? 0) - dt) <= 0) {
        e.regen = .045;
        e.bolts.forEach((bo, i) => {
          const th = R() * TAU, r = COL_R * (.8 + .4 * R());
          if (i & 1) { tC.set(F.x + Math.cos(th) * .3, .02, F.z + Math.sin(th) * .3); tD.set(F.x + Math.cos(th) * (1 + 1.2 * big), .02, F.z + Math.sin(th) * (1 + 1.2 * big)); gen(bo, tC, tD, 4, .2, .35, .2); }
          else { tC.set(F.x + Math.cos(th) * r, .02, F.z + Math.sin(th) * r); tD.set(F.x + Math.cos(th + RS(.6)) * r * .7, COL_TOP + .3 * R(), F.z + Math.sin(th + RS(.6)) * r * .7); gen(bo, tC, tD, 5, .12, .3, .3); }
        });
      }
      for (const bo of e.bolts) drawBolt(bo, .028, 1.8 * (1 - a / .4), COL.elec);
    }
    return a < T;
  }
  function startBurst(a, big) {
    const F = a.opt.feet, el = a.el;
    add({ update: tierBurst, el, feet: F.clone(), big, bolts: el === 'thunder' ? Array.from({ length: big > .7 ? 6 : 2 }, () => new Bolt(96)) : [] });
    const n = Q * big;
    if (el === 'fire') {
      for (let i = 0; i < 90 * n; i++) { // a ring of flame bursting up from the feet
        const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.7 + .5 * R());
        emit(F.x + cx * r, .05, F.z + cz * r, cx * (.6 + .8 * R()), 2.2 + 2.8 * R(), cz * (.6 + .8 * R()), .35 + .3 * R(), .1 + .07 * R(), .03, 1.6, 1.5, COL.one, K.FLAME, 1.1, .3, 0, 0);
      }
      for (let i = 0; i < 140 * n; i++) { // embers flung up and out
        runit(); const v = 2 + 4 * R();
        emit(F.x + u3[0] * .3, .4 + R() * .9, F.z + u3[2] * .3, u3[0] * v, Math.abs(u3[1]) * v + 1.5, u3[2] * v, .5 + .5 * R(), .012, .005, 1.2, -2.5, R() < .3 ? COL.hot : COL.ember, K.SPARK, 2.4, .3, .05, 0);
      }
      for (let i = 0; i < 14 * n; i++) { // a dark smoke ring rolling out: value contrast against the bright flame
        const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th);
        emit(F.x + cx * .4, .15, F.z + cz * .4, cx * 2, .5 + .5 * R(), cz * 2, .7 + .4 * R(), .16, .45, 2.5, .4, COL.smoke, K.SMOKE, .9, .25, 0, 0);
      }
    } else if (el === 'thunder') {
      for (let i = 0; i < 120 * n; i++) { // sparks spraying off the body
        runit(); const v = 2.5 + 4 * R();
        emit(F.x + u3[0] * .25, .2 + R() * 1.5, F.z + u3[2] * .25, u3[0] * v, u3[1] * v * .6 + .5, u3[2] * v, .18 + .2 * R(), .01, .004, 2.5, -3, R() < .4 ? COL.white : COL.spark, K.SPARK, 2.6, .15, .05, 0);
      }
    } else if (el === 'water') {
      for (let i = 0; i < 110 * n; i++) { // a crown of water thrown up from the feet
        const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.8 + .3 * R()), v = 2.5 + 2.5 * R();
        emit(F.x + cx * r, .05, F.z + cz * r, cx * 1.1, v, cz * 1.1, .5 + .3 * R(), .022, .012, .5, -9, R() < .3 ? COL.waterHi : COL.water, K.DROP, 1.4, 0, .03, 0);
      }
      for (let i = 0; i < 6; i++) { const th = i / 6 * TAU; wspr('water', 'spray', tA.set(F.x + Math.cos(th) * .5, .25, F.z + Math.sin(th) * .5), .5, .5, { color: [.6, .85, 1], intensity: .9, occ: .3, rot: th }); }
    } else {
      for (let i = 0; i < 50 * n; i++) { // dust blown out flat from the feet
        const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), v = 2.5 + 2.5 * R();
        emit(F.x + cx * .3, .06, F.z + cz * .3, cx * v - cz, .2 + .4 * R(), cz * v + cx, .6 + .4 * R(), .12, .5, 2.5, .2, COL.dust, K.SMOKE, .8, .3, 0, 0);
      }
      for (let i = 0; i < 80 * n; i++) { // flat streaks of air racing outward
        const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), v = 5 + 4 * R();
        emit(F.x + cx * .5, .1 + R() * 1.2, F.z + cz * .5, cx * v, RS(.3), cz * v, .22 + .12 * R(), .009, .004, 2, 0, R() < .5 ? COL.windHi : COL.wind, K.SPARK, 2, .05, .08, 0);
      }
      for (let i = 0; i < 24 * n; i++) { const th = R() * TAU, v = 2 + 2 * R(); emit(F.x + Math.cos(th) * .4, .1, F.z + Math.sin(th) * .4, Math.cos(th) * v, 1 + 1.5 * R(), Math.sin(th) * v, 1 + .5 * R(), .05, .04, 1, -1, COL.leaf, K.LEAF, 1, .4, RS(9), 0); }
    }
    kit.shake(.15 + .35 * big);
  }

  function limitCharge(a, dt) {
    const o = a.opt, F = o.feet, tier = o.tier;
    const target = o.charging && tier ? TIER_K[tier] + .08 * (o.level ?? 0) : 0;
    a.lk = (a.lk ?? 0) + (target - (a.lk ?? 0)) * Math.min(1, dt * (target > (a.lk ?? 0) ? 6 : 4));
    const tr = o.charging ? tier : null;
    if (tr !== a.lcTier) { if (F && tr === 'm') startBurst(a, .45); else if (F && tr === 'l') { startBurst(a, 1); a.fullAt = now(); } a.lcTier = tr; }
    const k = a.lk;
    if (k < .02 || !F) return;
    const full = tier === 'l' && o.charging;
    const pre = tier === 'm' && o.charging ? sc(o.level ?? 0, .86, 1) : 0; // anticipation: the last stretch before 大
    if (full && now() - (a.fullAt ?? 0) > .7 && (a.shock = (a.shock ?? 0) - dt) <= 0) { a.shock = .7; add({ update: aftershock, el: a.el, feet: F.clone() }); }
    BODY[a.el](a, F, k, dt, full, pre);
    if (pre > 0) drawIn(a, F, pre, dt);
  }
  // the sustained 大: a small ring running out every ~0.7 s, so the full charge keeps threatening
  function aftershock(e) {
    const k = Math.min(1, e.age / .45), P = PAL[e.el];
    floorRing(e.feet, .45 + .9 * (1 - (1 - k) ** 2), .03, 1.1 * (1 - k) ** 1.5, P.main, .04, e.seed);
    return e.age < .45;
  }
  // anticipation: everything round the player is pulled in hard and a ring closes on the feet
  function drawIn(a, F, pre, dt) {
    const P = PAL[a.el], kind = a.el === 'fire' ? K.EMBER : a.el === 'water' ? K.DROP : K.SPARK;
    floorRing(F, COL_R + 1.4 * (1 - pre), .03, .9 * pre, P.hot, .02, a.seed + .9);
    for (let n = take(a, 'pre', 260 * pre * Q * dt); n > 0; n--) {
      const th = R() * TAU, c = Math.cos(th), s = Math.sin(th), r0 = 1.3 + .6 * R(), y0 = .1 + 1.5 * R(), life = .22 + .1 * R(), y1 = .9 + .3 * R();
      emit(F.x + c * r0, y0, F.z + s * r0, -c * (r0 - .15) / life, (y1 - y0) / life, -s * (r0 - .15) / life, life, .02, .008, 0, 0, P.mote, kind, 2, 0, .09, R() * dt);
    }
  }
  // drawn-in motes and an ever-present faint body glow
  function bodyGlow(F, k, col, fl) { tA.set(F.x, .95, F.z); spr(S.GLOW, tA, .55 + .15 * k, 1.15, 0, 0, col, (.15 + .3 * k) * fl, .05); }

  // the bodies, one per element. a = aura state, F = feet, k = .32 小 / .64 中 / 1 大 (eased), full = 大 held, pre = 0..1 anticipation
  const BODY = {
    // fire: a wreath of flame round the feet that climbs with the tier, embers spiralling in, dark smoke above at 大, a scorched pool
    fire(a, F, k, dt, full, pre) {
      const t = now(), fl = flick(a.seed, 17), surge = full ? .85 + .15 * Math.sin(t * 13) : 1;
      sprFloor(S.GLOW, tA.set(F.x, .03, F.z), .8 + .5 * k, FLOOR.fire, (.6 + .7 * k) * fl, .1);
      floorRing(F, COL_R + .12, .035 + .02 * k, (.5 + .7 * k) * fl, COL.fire, .06 + .04 * k, a.seed); // the flame edge wobbles
      if (k > .5) floorRing(F, COL_R * .7, .02, .6 * k * fl, COL.hot, .05, a.seed + .4);
      bodyGlow(F, k, COL.fire, fl * surge);
      const ring = t * 1.6;
      for (let n = take(a, 'fw', (50 + 170 * k) * Q * dt); n > 0; n--) { // the wreath: flames licking up from a turning ring, taller each tier
        const th = ring + R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.85 + .3 * R());
        emit(F.x + cx * r, .02, F.z + cz * r, -cx * .25 - cz * .3, (.8 + 2.2 * k) * (.7 + .6 * R()) * surge, -cz * .25 + cx * .3, .3 + .4 * k * R(), (.16 + .17 * k) * (.7 + .5 * R()), .05, 1.4, 1.6,
          COL.one, K.FLAME, 1 + .5 * k, .25, 0, R() * dt);
      }
      if (k > .5) for (let n = take(a, 'ft', (k - .4) * 150 * Q * dt); n > 0; n--) { // 中 / 大: tongues licking up the body
        const th = R() * TAU, r = .12 + .2 * R();
        emit(F.x + Math.cos(th) * r, .2 + R() * (.4 + .8 * k), F.z + Math.sin(th) * r, RS(.2), 1 + 1.6 * R() * k, RS(.2), .35 + .3 * R(), .2 + .12 * R(), .05, 1.4, 1.8, COL.one, K.FLAME, .9 + .4 * k, .3, 0, R() * dt);
      }
      for (let n = take(a, 'fe', (20 + 120 * k) * Q * dt); n > 0; n--) { // embers spiralling in from round the player and up
        const th = R() * TAU, c = Math.cos(th), s = Math.sin(th), r0 = .9 + .6 * R(), y0 = .05 + R() * .8, life = .6 + .4 * R(), r1 = COL_R * .5;
        emit(F.x + c * r0, y0, F.z + s * r0, c * (r1 - r0) / life - s * 1.2, (.6 + 1.2 * k) / life, s * (r1 - r0) / life + c * 1.2, life, .02, .008, 0, 0, R() < .3 ? COL.hot : COL.ember, K.EMBER, 2.4 + 1.2 * k, .15, 0, R() * dt);
      }
      for (let n = take(a, 'fr', (20 + 200 * k * k) * Q * dt); n > 0; n--) { // hot streaks shooting up the wreath: the bright read at a distance
        const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r = COL_R * (.75 + .35 * R());
        emit(F.x + cx * r, R() * .4, F.z + cz * r, -cx * .2, (2.2 + 2.6 * R()) * (.5 + k), -cz * .2, .35 + .3 * R(), .014 + .006 * k, .005, .6, 1.2,
          R() < .3 ? COL.hot : COL.ember, K.SPARK, 2.2 + 1.4 * k, .15, .1 + .05 * k, R() * dt);
      }
      if (k > .55) for (let n = take(a, 'fs', 90 * (k - .3) * Q * dt); n > 0; n--) { // sparks flying up off the body
        const th = R() * TAU, r = COL_R * R();
        emit(F.x + Math.cos(th) * r, .2 + R() * 1.4, F.z + Math.sin(th) * r, RS(.5), 1.2 + 1.8 * R(), RS(.5), .6 + .5 * R(), .012, .006, 1.2, .4, COL.ember, K.SPARK, 2.2, .7, .05, R() * dt);
      }
      if (full) for (let n = take(a, 'fk', 14 * Q * dt); n > 0; n--) { // dark smoke rolling off the top: the bright flame needs a dark next to it
        const th = R() * TAU;
        emit(F.x + Math.cos(th) * .2, 1.4 + .4 * R(), F.z + Math.sin(th) * .2, RS(.2), .5 + .4 * R(), RS(.2), 1.1 + .5 * R(), .14, .4, 1, .3, COL.smoke, K.SMOKE, .7, .2, 0, R() * dt);
      }
    },
    // thunder: arcs crawling up the body (each climbs as it regenerates), crackle flashes, a jagged flickering ring and arcs over
    // the floor, a few fast light lines; at 大 a bolt from the stick tip to the ground now and then
    thunder(a, F, k, dt, full) {
      const t = now(), fl = flick(a.seed, 31), P = PAL.thunder, T = a.tip;
      sprFloor(S.GLOW, tA.set(F.x, .03, F.z), .75 + .4 * k, FLOOR.thunder, (.5 + .6 * k) * fl, .1);
      const on = R() < .8 ? 1 : .3; // the ring stutters like a bad contact
      floorRing(F, COL_R + .15, .03 + .02 * k, (.55 + .8 * k) * on, P.main, .08, a.seed + Math.floor(t * 20));
      bodyGlow(F, k, COL.elecGlow, fl);
      // body arcs (bolts 4..9; 0..3 belong to the classic stick glow)
      const nb = Math.min(6, Math.round(2 + 4 * k) + (full ? 1 : 0));
      if ((a.lcRegen = (a.lcRegen ?? 0) - dt) <= 0) {
        a.lcRegen = .045 + .03 * R();
        for (let i = 0; i < 6; i++) {
          const bo = a.bolts[4 + i];
          if (i >= nb) { bo.n = 0; continue; }
          const th = i * 1.1 + t * 1.3 + RS(.4), r = COL_R * (.75 + .3 * R()), y = ((t * (1.2 + 1.6 * k) + i / 6) % 1) * COL_TOP, L = (.25 + .3 * R()) * (.6 + .6 * k);
          tA.set(F.x + Math.cos(th) * r, y, F.z + Math.sin(th) * r);
          const th2 = th + RS(.9);
          tB.set(F.x + Math.cos(th2) * r, Math.min(COL_TOP + .1, y + L), F.z + Math.sin(th2) * r);
          gen(bo, tA, tB, 3, .35, .35, .3);
          if (R() < .5) add({ update: crackle, p: tB.clone(), s: .12 + .12 * k });
        }
      }
      for (let i = 0; i < 6; i++) drawBolt(a.bolts[4 + i], .022 + .01 * k, 2 * Math.min(1, .5 + k), i & 1 ? COL.elec : COL.spark);
      // arcs over the floor (中 and up) and, at 大, a bolt from the tip to the ground
      const fb = a.floorBolts ??= Array.from({ length: 4 }, () => new Bolt(64));
      const nf = k > .5 ? (full ? 4 : 2) : 1;
      if ((a.fbRegen = (a.fbRegen ?? 0) - dt) <= 0) {
        a.fbRegen = .06 + .05 * R();
        fb.forEach((bo, i) => {
          if (i >= nf) { bo.n = 0; return; }
          const th = R() * TAU, r1 = COL_R + .5 + .6 * R() * k;
          tA.set(F.x + Math.cos(th) * COL_R, .02, F.z + Math.sin(th) * COL_R); tB.set(F.x + Math.cos(th + RS(.4)) * r1, .02, F.z + Math.sin(th + RS(.4)) * r1);
          gen(bo, tA, tB, 3, .3, .3, .2);
        });
        if (full && T && R() < .25) { const bo = fb[3], th = R() * TAU; gen(bo, T, tB.set(F.x + Math.cos(th) * .6, .02, F.z + Math.sin(th) * .6), 5, .16, .3, .5); add({ update: crackle, p: tB.clone(), s: .4 }); }
      }
      for (const bo of fb) drawBolt(bo, .024, 2, COL.elec);
      // fast light lines up the body (fewer than before: the arcs carry it now)
      const ls = a.lcLines ??= Array.from({ length: 12 }, () => ({ th: R() * TAU, y: R() * COL_TOP, sp: 2, len: .3, r: COL_R }));
      const nL = Math.min(ls.length, Math.round(3 + 9 * k * k));
      for (let i = 0; i < nL; i++) {
        const l = ls[i];
        l.y += l.sp * dt;
        if (l.y - l.len > COL_TOP) { l.th = R() * TAU; l.y = R() * .3; l.sp = (3 + 3 * R()) * (.6 + .6 * k); l.len = .2 + .3 * R(); l.r = COL_R * (.85 + .3 * R()); }
        const x = F.x + Math.cos(l.th) * l.r, z = F.z + Math.sin(l.th) * l.r, y0 = Math.max(0, l.y - l.len), y1 = Math.min(COL_TOP + .2, l.y);
        if (y1 > y0) seg(x, y0, z, x, y1, z, .007 + .004 * k, (.4 + .7 * k) * (1 - .5 * l.y / COL_TOP) * fl, i & 1 ? P.main : P.streak);
      }
      for (let n = take(a, 'tm', (15 + 90 * k) * Q * dt); n > 0; n--) { // static motes drawn in
        const th = R() * TAU, cx = Math.cos(th), cz = Math.sin(th), r0 = .85 + .5 * R(), y0 = .1 + R() * 1.6, life = .3 + .2 * R();
        emit(F.x + cx * r0, y0, F.z + cz * r0, -cx * (r0 - .2) / life, .3, -cz * (r0 - .2) / life, life, .01, .005, 0, 0, P.mote, K.SPARK, 1.8 + k, 0, .05, R() * dt);
      }
    },
    water(a, F, k, dt, full) {
      const t = now(), T = a.tip, on = Math.min(1, .55 + k), pulse = full ? .5 + .5 * Math.sin(t * 9) : 0;
      sprFloor(S.GLOW, tA.set(F.x, .03, F.z), 1.1 + .4 * k, FLOOR.water, .7 + .5 * k, .1);
      wmesh('water', 'disc', tA.set(F.x, .025, F.z), .6 + .5 * k, { opacity: .6 + .4 * on, twist: 1.6, spin: .5 + 1.2 * k, flow: -.5, foam: .55 + .3 * k, tile: [5, 2], seed: a.seed, occ: .5, colA: WB.a, colB: WB.b, intensity: 1.3 });
      const nr = k > .8 ? 3 : 2;
      for (let i = 0; i < nr; i++) // ribbons of water spiralling up round the body: knee high at 小, over the head at 大
        wmesh('water', 'helix', tA.set(F.x, .03, F.z), 1, { r0: .62 + .1 * pulse, r1: .3 + .08 * pulse, h: (.6 + 1.2 * k) * (.95 + .05 * Math.sin(t * 3 + i)), turns: 1.25, width: .1 + .1 * k + .05 * pulse,
          phase: t * (2.2 + 3 * k) + i * TAU / nr, flow: 2 + 2.5 * k, foam: .35 + .2 * pulse, tile: [3, 1], seed: a.seed + i, occ: .3, opacity: on, intensity: 1.9 + .5 * pulse, erode: .25 * (1 - k), colA: WB.a, colB: WB.b });
      for (let n = take(a, 'lcB', (16 + 60 * k) * Q * dt); n > 0; n--) { // drops lifting off the floor, slowly, as if the water defied gravity
        const th = R() * TAU, r = .35 + .4 * R();
        emit(F.x + Math.cos(th) * r, .05, F.z + Math.sin(th) * r, -Math.sin(th) * .6, .5 + 1.1 * R() * (.5 + k), Math.cos(th) * .6, .9 + .6 * R(), .022 + .016 * R(), .012, .8, .4,
          R() < .3 ? COL.waterHi : COL.water, K.DROP, 1.3 + .3 * k, .25, .02, R() * dt);
      }
      for (let i = 0; i < 4; i++) { // mist breathing at the feet
        const ph = (t * .5 + i / 4) % 1, th = i * 1.7 + a.seed * 9;
        wspr('water', 'mist', tA.set(F.x + Math.cos(th) * .45, .12 + .15 * ph, F.z + Math.sin(th) * .45), .5 + .4 * ph, .35 + .3 * ph,
          { color: [.6, .8, .95], intensity: .4 + .3 * k, opacity: Math.sin(Math.PI * ph) * (.3 + .5 * k), occ: .25, rot: th + t * .2 });
      }
      const nw = full ? 3 : k > .5 ? 2 : 1; // ripples on the circle: one at 小, two at 中, three and faster at 大
      for (let j = 0; j < nw; j++) {
        const ph = (t * (.7 + .7 * k) + j / nw) % 1;
        sprFloor(S.RING, tA.set(F.x, .03, F.z), .45 + (1 + .6 * k) * ph, j & 1 ? COL.waterHi : COL.foam, (.5 + .8 * k) * (1 - ph) ** 1.5, .05, a.seed + j);
      }
      if (!T) return;
      for (let n = take(a, 'lcU', (10 + 50 * k) * Q * dt); n > 0; n--) { // water drawn up from the floor into the tip
        const th = R() * TAU, r = .45 + .35 * R(), x = F.x + Math.cos(th) * r, z = F.z + Math.sin(th) * r, life = .4 + .25 * R();
        emit(x, .05, z, (T.x - x) / life, (T.y - .05) / life, (T.z - z) / life, life, .026, .012, 0, 0, R() < .4 ? COL.waterHi : COL.water, K.DROP, 1.3, .25, .03, R() * dt);
      }
    },
    wind(a, F, k, dt, full) {
      const t = now(), on = Math.min(1, .55 + k), pulse = full ? .5 + .5 * Math.sin(t * 11) : 0;
      sprFloor(S.GLOW, tA.set(F.x, .03, F.z), 1 + .4 * k, FLOOR.wind, .35 + .3 * k, .05);
      wmesh('wind', 'disc', tA.set(F.x, .02, F.z), .8 + .6 * k, { opacity: .7 + .3 * on, twist: 2, spin: -(1 + 1.5 * k), flow: -.6, tile: [5, 2], seed: a.seed, occ: .2, colA: AD.a, colB: AD.b, intensity: 1.4 });
      const nb = full ? 4 : k > .5 ? 3 : 2;
      for (let i = 0; i < nb; i++) // bands of wind wound round the body, rising: waist high at 小, over the head at 大
        wmesh('wind', 'helix', tA.set(F.x, .05, F.z), 1, { r0: .6 + .1 * pulse, r1: .4, h: .8 + 1.2 * k, turns: 1.1, width: .26 + .16 * k + .08 * pulse,
          phase: t * (4 + 6 * k + 3 * pulse) + i * TAU / nb, flow: 3 + 3 * k, tile: [1.5, .6], seed: a.seed + i, occ: .06, opacity: on, intensity: 4.6 + 1.2 * k + .8 * pulse, colA: AW.a, colB: AW.b });
      wmesh('wind', 'tube', tA.set(F.x, 0, F.z), 1, { r0: .5, r1: .38, h: 1.1 + .9 * k, curve: 1, spin: 2 + 2 * k, twist: 1.5, tile: [3, 1.2], seed: a.seed + .7, occ: .03, opacity: .7 * on, intensity: 2, colA: AW.a, colB: AW.b });
      for (let i = 0; i < 7; i++) { // painted dust clumps pulled in along the floor
        const ph = (t * (.5 + .4 * k) + i / 7) % 1, th = i * 2.4 + a.seed * 7 + ph * 2.5, r = 1.7 * (1 - ph) + .45;
        wspr('wind', 'dust', tA.set(F.x + Math.cos(th) * r, .1 + .1 * ph, F.z + Math.sin(th) * r), .45 + .2 * hash(i), .35 + .2 * hash(i + 3),
          { color: [.7, .65, .56], intensity: 1.1, opacity: Math.sin(Math.PI * ph) * (.55 + .45 * k), occ: .5, rot: th * 2 });
      }
      for (let n = take(a, 'lcL', (4 + 16 * k) * Q * dt); n > 0; n--) { // leaves circling in and up
        const th = R() * TAU, c = Math.cos(th), sn = Math.sin(th), r = 1.6;
        emit(F.x + c * r, .05 + R() * .5, F.z + sn * r, -c * 1.6 - sn * 2.2, .6 + 1.2 * k, -sn * 1.6 + c * 2.2, .9, .055, .04, .3, -.3, COL.leaf, K.LEAF, 1, .3, RS(9), R() * dt);
      }
      for (let j = 0; j < 2; j++) { // pressure rings contracting on the caster
        const ph = (t * (.7 + .8 * k) + j * .5 + a.seed) % 1, f = Math.sin(Math.PI * ph) * (.4 + .6 * k);
        floorRing(F, 2.1 * (1 - ph) + COL_R + .1, .02 + .015 * k, .9 * f, j ? COL.wind : COL.windHi, .02, a.seed + j);
      }
      for (let n = take(a, 'lcI', (20 + 90 * k) * Q * dt); n > 0; n--) { // streaks of air drawn in from all round, curling
        const th = R() * TAU, c = Math.cos(th), sn = Math.sin(th), r = 1.5 + .8 * R(), v = 3 + 3 * R(), life = (r - COL_R) / v;
        emit(F.x + c * r, .1 + R() * 1.8, F.z + sn * r, -c * v - sn * v * .6, .2, -sn * v + c * v * .6, life, .008, .004, 0, 0, R() < .4 ? COL.windHi : COL.wind, K.SPARK, 1.9, .05, .07, R() * dt);
      }
      if (full && (a.gp = (a.gp ?? 0) - dt) <= 0) { a.gp = .45; for (let i = 0; i < 2; i++) wspr('wind', 'twirl', tA.set(F.x, 1, F.z), 2, 2, { rot: t * 3 + i * Math.PI, color: [.9, 1, 1], intensity: .8, occ: 0 }); }
    },
  };
  // a crackle flash where an arc ends: a hard white pop for two or three frames
  function crackle(e) { if (e.age < .06) { spr(S.GLOW, e.p, e.s, e.s, 0, 0, COL.white, 1.6 * (1 - e.age / .06), .8); return true; } return false; }

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
    if (fire) spr(S.FIREBALL, p, r * 1.15, r * 1.15, t * .8, c.seed, COL.one, .8 + .3 * L, .9);
    spr(S.PLASMA, p, r * 1.25, r * 1.25, t * .6, c.seed, P.main, (fire ? .9 : 1.05) + .25 * L);
    spr(S.PLASMA, p, r * 1.1, r * 1.1, -t * 1.1, c.seed + .5, fire ? COL.ember : COL.spark, .5 + .15 * L);
    spr(S.GLOW, p, r * .6, r * .6, 0, 0, P.hot, (.7 + .2 * L) * fl, .6);
    spr(S.RING, p, r * 1.04 / .8, r * 1.04 / .8, t * 2, c.seed, P.main, (.6 + .5 * L) * fl, .07);
    if (full) {
      const ph = (t * 2.4) % 1;
      spr(S.RING, p, r * (1.1 + 1 * ph) / .8, r * (1.1 + 1 * ph) / .8, 0, c.seed + .2, P.hot, 1.3 * (1 - ph) ** 1.5, .06);
    }

    // arcs crawling over the surface: each one drifts round the sphere a little every regen and now and then jumps elsewhere
    // fire has no electric arcs (that is thunder's mark): its sphere is a flame orb with tongues licking off it (below)
    const nS = fire ? 0 : Math.min(12, Math.round(3 + 7 * L) + (full ? 2 : 0)), w = .009 + .012 * L;
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
    const nO = fire ? 0 : Math.min(8, Math.round(1 + 4 * L) + (full ? 3 : 0));
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
    if (fire) for (let n = take(c, 'tg', (15 + 90 * L) * Q * dt); n > 0; n--) { // tongues of flame licking up off the orb, taller at 大
      runit(); tA.set(u3[0], Math.abs(u3[1]) * .6 + .4, u3[2]).normalize();
      emit(p.x + tA.x * r * .8, p.y + tA.y * r * .8, p.z + tA.z * r * .8, tA.x * .4, (.6 + 1.2 * L) * (.7 + .6 * R()), tA.z * .4, .22 + .2 * L, (.03 + .05 * L) * (.7 + .6 * R()), .01, 1.5, 1.5,
        COL.one, K.FLAME, .7 + .3 * L, .3, 0, R() * dt);
    }
    if (full) for (let n = take(c, 'bz', 50 * Q * dt); n > 0; n--) {
      randUnit(tA); const v = 1 + 1.5 * R();
      emit(p.x + tA.x * r, p.y + tA.y * r, p.z + tA.z * r, tA.x * v, tA.y * v + (fire ? .5 : 0), tA.z * v, .3 + .3 * R(), .011, .005, 1.5, fire ? -1.5 : -2,
        fire ? COL.ember : COL.spark, K.SPARK, 2.4, .25, .04, R() * dt);
    }
  }

  // water: a sphere of water at the stick tip (shader: flowing value ramp, fresnel rim, a specular glint), bubbles rising
  // inside it, a ring of droplets orbiting it, drops drawn in; at full charge it pulses and throws ring waves
  function waterSphere(c, dt) {
    const L = c.v, p = c.tip, full = c.opt?.tier === 'l' || L >= .999, t = now();
    const r = (.07 + .21 * L) * (full ? 1 + .07 * Math.sin(t * 9) : 1);
    spr(S.GLOW, p, r * 3.2, r * 3.2, 0, 0, COL.waterGlow, .4 + .35 * L, .05);
    wmesh('water', 'sphere', p, r, { flow: 1.2 + L, spin: .5, foam: .2 + .2 * L, tile: [3, 2], seed: c.seed, occ: .65, intensity: 1.15, colA: WB.a, colB: WB.b });
    for (let i = 0; i < 6; i++) { // bubbles rising inside
      const ph = (t * (.6 + .3 * hash(i)) + hash(i + 9)) % 1, th = hash(i + 4) * TAU + t, rr = r * .55 * Math.sqrt(1 - (2 * ph - 1) ** 2);
      wspr('water', 'foamRing', tA.set(p.x + Math.cos(th) * rr, p.y + r * .7 * (2 * ph - 1), p.z + Math.sin(th) * rr), r * .22, r * .22,
        { color: [.8, .95, 1], intensity: 1.2, opacity: Math.sin(Math.PI * ph) * (.4 + .6 * L), occ: 0 });
    }
    const nd = Math.round(5 + 5 * L), sp = t * (3 + 3 * L);
    for (let i = 0; i < nd; i++) { // a tilted ring of orbiting droplets
      const th = sp + i / nd * TAU, ox = Math.cos(th), oz = Math.sin(th);
      tA.set(ox, oz * .35, oz * .94).multiplyScalar(r * 1.6).add(p); tB.set(-oz, ox * .35, ox * .94); // tangent
      wspr('water', 'drop', tA, r * .22 + .015, r * .5 + .03, { axis: tB, color: [.45, .8, 1], intensity: 1.1, occ: .3 });
    }
    wspr('water', 'glint', tB.set(p.x - r * .35, p.y + r * .4, p.z + r * .3), r * 1.1, r * 1.1, { color: [.9, .98, 1], intensity: 1.3, occ: 0, rot: t * .5 });
    for (let n = take(c, 'in', (20 + 90 * L) * Q * dt); n > 0; n--) {
      runit(); const r0 = r * (2 + 1.2 * R()) + .08, life = .2 + .12 * R(), v = (r0 - r * .4) / life;
      emit(p.x + u3[0] * r0, p.y + u3[1] * r0, p.z + u3[2] * r0, -u3[0] * v, -u3[1] * v, -u3[2] * v, life, .014, .01, 0, 0, COL.waterHi, K.DROP, 1.2, 0, .03, R() * dt);
    }
    if (full) { const ph = (t * 1.6) % 1; spr(S.RING, p, r * (1.2 + 1.2 * ph) / .8, r * (1.2 + 1.2 * ph) / .8, 0, c.seed, COL.waterHi, 1.1 * (1 - ph) ** 1.5, .05); }
  }
  // wind: a ball of compressed air: a shader sphere of streaks swirling round, painted twirls spinning about it, air drawn in
  function windSphere(c, dt) {
    const L = c.v, p = c.tip, full = c.opt?.tier === 'l' || L >= .999, t = now();
    const r = (.08 + .22 * L) * (full ? 1 + .06 * Math.sin(t * 13) : 1), spin = t * (8 + 10 * L);
    spr(S.GLOW, p, r * 2.4, r * 2.4, 0, 0, COL.windGlow, .25 + .25 * L, .3);
    wmesh('wind', 'sphere', p, r, { spin: 2 + 2 * L, twist: .6, tile: [2, 2], seed: c.seed, occ: .05, intensity: 1.4 + .4 * L, colA: AW.a, colB: AW.b });
    wmesh('wind', 'sphere', p, r * .7, { spin: -3 - 2 * L, twist: -.4, tile: [3, 2], seed: c.seed + .5, occ: .05, intensity: 1.2, opacity: .8, colA: AW.a, colB: AW.b });
    const nc = full ? 3 : 2;
    for (let i = 0; i < nc; i++) wspr('wind', 'twirl', p, r * 2.3, r * 2.3, { rot: -spin + i * TAU / nc, color: [.88, .98, 1], intensity: .9 + .6 * L, occ: .02 });
    for (let n = take(c, 'in', (40 + 160 * L) * Q * dt); n > 0; n--) {
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
