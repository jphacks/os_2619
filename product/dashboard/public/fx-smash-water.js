// fx-smash-water.js: the water moves of the "スマブラ風" set (contract in fx-smash.js). Original effects, no assets.
// Element axis of the set: fire bursts from the centre, thunder strikes from above, water comes up FROM BELOW, wind closes in from AROUND.
// How stylised water is sold in games (Genshin Hydro, Smash / Tales water arts, real-time VFX breakdowns such as the layered
// "water bending" one on 80.lv): a dark dense blue body that hides what is behind it (not a glow), thin bright caustic bands and a
// hard white glint on it, white foam on the edges; round, flowing shapes; motion read through chunky blobs and drops that fall
// under gravity; timing = a telegraph on the floor (anticipation), a fast eruption (impact: white flash, crown, shock rings, shake),
// a long heavy fall-back (rain, foam rings, mist). Kept off thunder: deep blue + white foam, no yellow, nothing from the sky.
//   小 Aqua Bullet:   a pressurised bead leading a tapering stream with a spiral wake; on contact a white flash, a crown splash of
//                     drops and blobs, a wet patch with ripple rings, and a short spout kicks up from the floor under the target
//   中 Spiral Lance:  a long lance of water wrapped in three spiralling strands, pressure rings sliding down it; on contact a splash,
//                     then a whirlpool opens on the floor under the target and a 2 m column bursts up out of it and falls back
//   大 Maelstrom Geyser (signature, ~2.8 s): a heavy orb in a double helix, the floor rippling under its path. On contact:
//                     0-.45 s  the floor under the target turns into a widening maelstrom (渦潮): foam arms winding into a dark eye,
//                              rings contracting inward, foam sucked in, a rumble
//                     .45 s    eruption: white flash, a 3.4 m geyser bursts up swallowing the target (dark body, streaks racing up,
//                              a spiral of water round it, a crest of blobs), crown of drops, two shock rings, heavy shake;
//                              two smaller jets burst up beside it (.62 / .8 s) like fire's secondary pops
//                     1.4 s    the column collapses back as heavy rain, foam rings where it lands; lingering mist and a wet floor
//   溜め (fx-smash-charge.js): water gathers up from the floor into the staff tip.
// Layers per 大 hit: maelstrom, contracting rings, floor glow, flash, flare, crown drops, blobs, 3 columns (body + core), helix,
// crest, up-drops, top spray, foam, shock rings x2, ripple sets, rain, rain rings, mist, shake + rumble (fire: ~14, thunder: ~13).
// The landing is drawn once: hit() for a hit, end() for a floor landing or a timeout (end(s, 'hit') only follows a hit()).
export function createWaterMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, seg, segV, runit, u3, take, sc, shake, add, splashBurst, screenRot } = kit;
  const V = () => new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
  const tA = V(), tB = V(), tC = V(), tD = V(), pv = V(), ph = V();
  const DEEP = COL.water, HI = COL.waterHi, FOAM = COL.foam, GLOWB = COL.waterGlow, EYE = COL.waterDeep ?? COL.waterGlow;

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
  const drop = (x, y, z, vx, vy, vz, life, size, inten = 1.3) => emit(x, y, z, vx, vy, vz, life, size, size * .6, .6, -9.5, R() < .25 ? HI : DEEP, K.DROP, inten, .03, .03, 0);
  // drops shed along the path since last frame: sideways spray, falling
  function shed(s, dt, key, rate, r, sp, size = .03) {
    const d = s.dir;
    for (let n = take(s, key, rate * Q); n > 0; n--) {
      const u = R(); tA.copy(s.prev).lerp(s.pos, u); runit();
      emit(tA.x + u3[0] * r, tA.y + u3[1] * r, tA.z + u3[2] * r, u3[0] * sp - d.x * .6, u3[1] * sp + .3 - d.y * .6, u3[2] * sp - d.z * .6,
        .35 + .35 * R(), size * (.7 + .6 * R()), size * .6, .8, -8, R() < .2 ? HI : DEEP, K.DROP, 1.25, .05, .035, (1 - u) * dt);
    }
  }
  /** ripple rings spreading over the floor at g: n rings, one every gap s, each lasting T, out to rad */
  function ripples(g, a, n, gap, T, rad, inten, seed) {
    for (let i = 0; i < n; i++) {
      const k = sc(a, i * gap, i * gap + T);
      if (k <= 0 || k >= 1) continue;
      sprFloor(S.RING, g, .15 + rad * (1 - (1 - k) ** 2.2) * (1 - .15 * i), i & 1 ? DEEP : HI, inten * (1 - k) ** 1.4, .05 + .02 * i, seed + i);
    }
  }
  /** a crown of drops thrown up and out in a cone (axis up), plus a flat skirt of drops along the floor */
  function crown(p, n, sp, spread = .55, floor = true, size = .045) {
    for (let i = 0; i < n * Q; i++) {
      const th = R() * TAU, el = spread * (.5 + .5 * R()), v = sp * (.6 + .6 * R());
      drop(p.x + Math.cos(th) * .08, p.y, p.z + Math.sin(th) * .08, Math.cos(th) * Math.sin(el) * v, Math.cos(el) * v, Math.sin(th) * Math.sin(el) * v,
        .5 + .4 * R(), size * (.7 + .7 * R()));
    }
    if (floor) for (let i = 0; i < n * .5 * Q; i++) {
      const th = R() * TAU, v = sp * (.5 + .7 * R());
      drop(p.x, p.y + .02, p.z, Math.cos(th) * v, .4 + .8 * R(), Math.sin(th) * v, .3 + .2 * R(), size * .7, 1.2);
    }
  }
  function foam(p, n, r, life = .7, inten = .32) { // white foam / mist puffs
    for (let i = 0; i < n * Q; i++) {
      runit(); const sp = r * (.5 + R());
      emit(p.x + u3[0] * r * .3, p.y + Math.abs(u3[1]) * r * .3, p.z + u3[2] * r * .3, u3[0] * sp, Math.abs(u3[1]) * sp * .6 + .2, u3[2] * sp,
        life * (.7 + .6 * R()), .12, .4 + .2 * R(), 2.5, .3, FOAM, K.GLOW, inten, .15, 0, 0);
    }
  }
  /** chunky blobs of water (orb sprites) thrown out, falling and stretching: what reads as "a lot of water" */
  function blobsFx(e, dt) {
    let alive = false;
    for (const b of e.b) {
      if (b.t <= 0) continue; alive = true;
      b.v.y -= 9.5 * dt; b.p.addScaledVector(b.v, dt); b.t -= dt;
      if (b.p.y < .03) { b.t = 0; continue; }
      const k = Math.min(1, b.t / .25), sp = b.v.length(), st = Math.min(2.2, 1 + sp * .12);
      spr(S.WATER, b.p, b.r * k / Math.sqrt(st), b.r * k * st, screenRot(b.v), b.seed, DEEP, 1.25, 4);
    }
    return alive;
  }
  function blobs(p, n, sp, up, r = .07, life = .7) {
    add({ update: blobsFx, b: Array.from({ length: Math.round(n) }, () => {
      runit(); const v = sp * (.5 + .6 * R());
      return { p: p.clone(), v: new THREE.Vector3(u3[0] * v, Math.abs(u3[1]) * v * .7 + up * (.6 + .6 * R()), u3[2] * v), r: r * (.6 + .8 * R()), t: life * (.7 + .5 * R()), seed: R() };
    }) });
  }
  /** an impact flash: a white-blue bloom and a short horizontal flare */
  function flashFx(e) {
    const a = e.age, k = 1 - a / e.T; if (k <= 0) return false;
    spr(S.GLOW, e.pos, e.r, e.r, 0, 0, FOAM, e.i * k * k, .8);
    spr(S.GLOW, e.pos, e.r * 1.8, e.r * 1.8, 0, 0, GLOWB, .8 * e.i * k, .1);
    spr(S.FLARE, e.pos, e.r * 3.5, e.r * .08, 0, 0, HI, 1.6 * e.i * k * k);
    return true;
  }
  const flash = (p, r, i = 1.4, T = .14) => add({ update: flashFx, pos: p.clone(), r, i, T });
  function rippleFx(e) { const k = sc(e.age, 0, e.T); sprFloor(S.RING, e.g, .05 + e.r * (1 - (1 - k) ** 2), e.age < .08 ? FOAM : HI, e.i * (1 - k) ** 1.5, .07, e.seed); return k < 1; }
  const ripple = (x, z, r, i = 1, T = .5) => add({ update: rippleFx, g: new THREE.Vector3(x, .02, z), r, i, T });

  /** a jet of water bursting up from the floor at g: H tall, W half-width, stands T s, then falls back as rain.
   *  Layers: floor flash, column body + bright core, glow, spiral strands, crest blobs, drops racing up, spray off the top, foam, rain, rain rings */
  function jetFx(e, dt) {
    const a = e.age - e.delay; if (a < 0) return true;
    const g = e.g, H = e.H, W = e.W, T = e.T, big = e.big;
    if (!e.go) { // the eruption
      e.go = true;
      flash(tA.set(g.x, .25 + .3 * big, g.z), W * 3.5, 1.6);
      crown(tA.set(g.x, .05, g.z), 40 + 160 * big, 2.5 + 2.5 * big, .45, true, .04 + .015 * big);
      blobs(tA.set(g.x, .15, g.z), 3 + 9 * big, 1.5 + 1.5 * big, 3 + 3 * big, .06 + .05 * big);
      foam(tA.set(g.x, .08, g.z), 6 + 24 * big, W * 3);
      shake(.15 + .7 * big);
    }
    const up = 1 - (1 - sc(a, 0, .13 + .05 * big)) ** 3, down = sc(a, T, T + .4), I = 1 - down;
    const top = H * up * (1 - down * .92);
    if (top > .05 && I > 0) {
      const wob = 1 + .07 * Math.sin(a * 23 + e.seed * 9), c = tA.set(g.x + .03 * Math.sin(a * 11), top * .5, g.z);
      spr(S.GLOW, c, W * 3, top * .6 + .25, 0, 0, GLOWB, .55 * I, .05);
      spr(S.COLUMN, c, W * wob, top * .5 + .06, 0, e.seed, DEEP, 1.3 * I, -.3);
      spr(S.COLUMN, c, W * .45, top * .5, 0, e.seed + .5, HI, .3 * I, -.2);
      // two strands of water spiralling up round the column
      for (let h = 0; h < 2; h++) {
        let px = 0, py = 0, pz = 0;
        const N = 16;
        for (let i = 0; i <= N; i++) {
          const u = i / N, y = top * u, th = -a * 9 + u * 7 + h * Math.PI, r = W * (1.25 - .3 * u);
          const x = g.x + Math.cos(th) * r, z = g.z + Math.sin(th) * r;
          if (i) seg(px, py, pz, x, y, z, (.012 + .03 * big) * (1 - .5 * u), (.6 + .5 * Math.sin(th * 2)) * I * 1.3, (i + h) % 3 ? DEEP : HI);
          px = x; py = y; pz = z;
        }
      }
      // the crest: churning blobs and foam at the top
      if (up > .5) {
        tB.set(g.x, top, g.z);
        spr(S.WATER, tB, W * .8 * wob, W * .55, 0, e.seed + .9, DEEP, .9 * I, 6);
        for (const sx of [-1, 1]) spr(S.WATER, tB.set(g.x + sx * W * (.7 + .15 * Math.sin(a * 7 + sx)), top - W * .45, g.z), W * .6, W * .75, -sx * .5, e.seed + .3 + sx, DEEP, 1.05 * I, 6); // the crest curling over
        spr(S.GLOW, tB.set(g.x, top + W * .2, g.z), W * 2.2, W * 1.1, 0, 0, FOAM, .35 * I, .2);
      }
      for (let n = take(e, 'u', (120 + 380 * big) * I * Q * dt); n > 0; n--) { // water racing up the column
        const th = R() * TAU, r = W * .8 * Math.sqrt(R()), life = .35 + .3 * R();
        emit(g.x + Math.cos(th) * r, .05, g.z + Math.sin(th) * r, Math.cos(th) * .3, top / life * 1.15, Math.sin(th) * .3, life, .035 + .02 * R(), .02, .3, -9,
          R() < .35 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
      }
      for (let n = take(e, 'c', (40 + 160 * big) * I * Q * dt); n > 0; n--) { // spray fanning off the top, raining back
        const th = R() * TAU, v = (1 + 2 * R()) * (.5 + .5 * big);
        emit(g.x + RS(W), top, g.z + RS(W), Math.cos(th) * v, 1 + 2 * R(), Math.sin(th) * v, .8 + .5 * R(), .04, .025, .4, -9.8, R() < .3 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
      }
      for (let n = take(e, 'f', (8 + 30 * big) * I * Q * dt); n > 0; n--) foam(tB.set(g.x, top * R(), g.z), 1, W * 1.5, .6, .28);
    }
    // the collapse: the column's water comes down as rain, foam rings where it lands
    if (down > 0 && !e.rained) {
      e.rained = true;
      const n = (60 + 380 * big) * Q, h0 = Math.max(.6, H * .8);
      for (let i = 0; i < n; i++) {
        const th = R() * TAU, r = W * (1 + 4 * Math.sqrt(R())), y = h0 * (.4 + .6 * R());
        emit(g.x + Math.cos(th) * r * .4, y, g.z + Math.sin(th) * r * .4, Math.cos(th) * r * .8, .5 + R(), Math.sin(th) * r * .8, Math.sqrt(2 * y / 9.8) + .25, .04 + .02 * R(), .03, .2, -9.8,
          R() < .3 ? HI : DEEP, K.DROP, 1.3, .02, .03, 0);
      }
      if (big > .5) blobs(tB.set(g.x, H * .7, g.z), 10, 2, .5, .1, 1);
    }
    if (down > 0 && down < 1 || (down >= 1 && a < T + .9)) for (let n = take(e, 'rr', (6 + 30 * big) * Q * dt); n > 0; n--) {
      const th = R() * TAU, r = W * (1 + 4.5 * Math.sqrt(R()));
      ripple(g.x + Math.cos(th) * r, g.z + Math.sin(th) * r, .15 + .25 * R(), .8 + .5 * big, .45);
    }
    // the floor round the base: a foam skirt, rings racing out, a glow
    sprFloor(S.GLOW, g, W * 5, GLOWB, .9 * (1 - sc(a, T, T + .9)), .1);
    ripples(g, a, 2 + Math.round(3 * big), .15, .8, W * 6, 1.4 + .8 * big, e.seed);
    for (let n = take(e, 'b', (20 + 50 * big) * I * Q * dt); n > 0; n--) {
      const th = R() * TAU, r = W * (1.1 + .4 * R());
      emit(g.x + Math.cos(th) * r, .05, g.z + Math.sin(th) * r, Math.cos(th) * .7, .3 + .5 * R(), Math.sin(th) * .7, .6 + .4 * R(), .12, .4, 2, .1, FOAM, K.GLOW, .3, .2, 0, R() * dt);
    }
    return a < T + 1.0;
  }
  const jet = (g, H, W, T, big, delay = 0) => add({ update: jetFx, g: new THREE.Vector3(g.x, .02, g.z), H, W, T, big, delay });

  // ======================= 小: Aqua Bullet =======================
  function shotS(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos;
    basis(d);
    // the stream: the path of the last ~0.16 s, tapering towards the muzzle, wrapped in a spiral wake
    const H = s.wh ??= { pts: [] };
    H.pts.push({ p: p.clone(), t: s.age });
    while (H.pts.length > 2 && s.age - H.pts[0].t > .16) H.pts.shift();
    const n = H.pts.length;
    for (let i = n - 1; i > 0; i--) {
      const u = (n - 1 - i) / Math.max(1, n - 1);
      segV(H.pts[i].p, H.pts[i - 1].p, .045 * (1 - .75 * u), .6 * (1 - u * .7), DEEP);
    }
    for (let h = 0; h < 2; h++) {
      let px = 0, py = 0, pz = 0;
      for (let i = n - 1; i >= 0; i--) {
        const q = H.pts[i], age = s.age - q.t, th = q.t * 45 + h * Math.PI, r = .03 + .5 * age;
        const x = q.p.x + (pv.x * Math.cos(th) + ph.x * Math.sin(th)) * r, y = q.p.y + (pv.y * Math.cos(th) + ph.y * Math.sin(th)) * r, z = q.p.z + (pv.z * Math.cos(th) + ph.z * Math.sin(th)) * r;
        if (i < n - 1) seg(px, py, pz, x, y, z, .01, 1.3 * (1 - age / .16), h ? HI : FOAM);
        px = x; py = y; pz = z;
      }
    }
    shed(s, dt, 'd', dist * 70 + dt * 20, .03, .7);
    // the head: a stretched bead, a pressure cone of foam just behind it
    const rot = screenRot(d);
    spr(S.GLOW, p, .26, .26, 0, 0, GLOWB, .45, .1);
    spr(S.WATER, tA.copy(p).addScaledVector(d, -.05), .09, .19, rot, s.seed, DEEP, 1.4, 3);
    spr(S.CRESCENT, tA.copy(p).addScaledVector(d, -.02), .11, .11, rot, s.seed, FOAM, .7, .35);
    spr(S.GLOW, p, .05, .05, 0, 0, FOAM, .8, 1.5);
    s.prev.copy(p);
  }
  function splashSFx(e) {
    const a = e.age, p = e.pos, k = sc(a, 0, .3);
    spr(S.WATER, p, .16 + .34 * k, .16 * (1 - .6 * k), 0, e.seed, DEEP, 1.3 * (1 - sc(a, .12, .35)), 2); // a blob flattening as it spreads
    spr(S.RING, p, .1 + .55 * k, .1 + .55 * k, 0, e.seed, HI, 1.2 * (1 - k) ** 1.5, .06);
    sprFloor(S.WATER, e.g, .55 * (1 - .3 * sc(a, .4, 1.1)), EYE, .6 * (1 - sc(a, .5, 1.1)), 1, e.seed); // the wet patch on the floor
    ripples(e.g, a, 3, .1, .5, .8, 1.4, e.seed);
    return a < 1.1;
  }
  function splashS(p0, reason) {
    const floor = reason === 'floor' || p0.y < .35, p = p0.clone(); if (floor) p.y = .03;
    crown(p, floor ? 80 : 55, floor ? 3.4 : 2.6, floor ? .5 : 1.4, floor);
    blobs(p, 5, 1.6, 1.2, .05, .55);
    foam(p, 10, .5);
    flash(p, .45, 1.3, .1);
    add({ update: splashSFx, pos: p, g: new THREE.Vector3(p.x, .02, p.z) });
    jet(p, .95, .1, .14, .15, .08); // a short spout kicks up from the floor under it
    shake(.18);
  }

  // ======================= 中: Spiral Lance =======================
  function shotM(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age;
    basis(d);
    const L = Math.min(.3 + s.travel, .75), rot = screenRot(d);
    // the lance: a long body of water pointing along the flight, a sharp bright point
    spr(S.GLOW, tA.copy(p).addScaledVector(d, -L * .4), .7, .7, 0, 0, GLOWB, .6, .05);
    spr(S.WATER, tA.copy(p).addScaledVector(d, -L * .45), .15, L * .6, rot, s.seed, DEEP, 1.4, 4);
    spr(S.CRESCENT, tA.copy(p).addScaledVector(d, -.06), .2, .2, rot, s.seed, FOAM, .9, .35); // the pressure cone at the point
    spr(S.WATER, tA.copy(p).addScaledVector(d, -.05), .07, .13, rot, s.seed + .4, HI, .6, 6);
    segV(p, tA.copy(p).addScaledVector(d, -L * .5), .018, 1.6, FOAM);
    // three strands spiralling round it, tightening to the point
    for (let h = 0; h < 3; h++) {
      let px = 0, py = 0, pz = 0;
      const N = 14;
      for (let i = 0; i <= N; i++) {
        const u = i / N, th = -t * 22 + u * 10 + h * TAU / 3, r = .04 + .2 * u ** .7;
        tA.copy(p).addScaledVector(d, -L * 1.2 * u).addScaledVector(pv, Math.cos(th) * r).addScaledVector(ph, Math.sin(th) * r);
        if (i) seg(px, py, pz, tA.x, tA.y, tA.z, .026 * (1 - .5 * u), 1.4 * (1 - u * .8), (i + h) % 3 ? DEEP : HI);
        px = tA.x; py = tA.y; pz = tA.z;
      }
    }
    // pressure rings sliding back down the lance
    for (let j = 0; j < 2; j++) {
      const ph0 = (t * 3.5 + j * .5) % 1, c = tB.copy(p).addScaledVector(d, -L * ph0), r = .07 + .14 * ph0;
      let px = 0, py = 0, pz = 0;
      for (let i = 0; i <= 14; i++) {
        const th = i / 14 * TAU; tA.copy(c).addScaledVector(pv, Math.cos(th) * r).addScaledVector(ph, Math.sin(th) * r);
        if (i) seg(px, py, pz, tA.x, tA.y, tA.z, .01, 1.2 * (1 - ph0), HI);
        px = tA.x; py = tA.y; pz = tA.z;
      }
    }
    shed(s, dt, 'd', dist * 60, .12, .6, .034);
    s.prev.copy(p);
  }
  function lanceFx(e) {
    const a = e.age, p = e.pos, g = e.g, k = sc(a, 0, .2);
    const sz = (.25 + .45 * (1 - (1 - k) ** 2)) * e.k;
    spr(S.WATER, p, sz, sz * (1 - .35 * k), 0, e.seed, DEEP, 1.3 * (1 - sc(a, .03, .22)), 4); // the lance's water bursting on the target
    for (let i = 0; i < 2; i++) {
      const kk = sc(a, i * .08, .45 + i * .08), rr = (.25 + 1.1 * (1 - (1 - kk) ** 3)) * e.k;
      if (kk > 0 && kk < 1) spr(S.RING, p, rr, rr, i, e.seed + i, i ? DEEP : HI, 1.1 * (1 - kk) ** 1.5, .05 + .03 * i);
    }
    // the whirlpool opening on the floor under the target, the column comes out of it at .18 s
    const open = 1 - (1 - sc(a, .02, .25)) ** 2, close = sc(a, .7, 1.3);
    sprFloor(S.VORTEX, g, (.3 + .8 * open) * (1 - .3 * close) * e.k, DEEP, 1.2 * open * (1 - close), 1.5 + 2 * open, e.seed);
    if (a < .2) for (let i = 0; i < 2; i++) { const kk = sc(a, i * .06, .2 + i * .06); sprFloor(S.RING, g, (1.4 - 1.1 * kk) * e.k, HI, 1.3 * kk * (1 - kk) * 3, .05, e.seed + i); } // pulled in
    return a < 1.3;
  }
  function lance(p0, reason) {
    const big = reason === 'hit', k = big ? 1 : .75, p = p0.clone();
    if (reason === 'floor') p.y = .15;
    splashBurst(p, .9 * k, 200 * k, 1.1, .6);
    blobs(p, 6 * k, 2, 1, .07, .6);
    foam(p, 14 * k, .8);
    flash(p, .8 * k, 1.5, .12);
    const g = new THREE.Vector3(p.x, .02, p.z);
    add({ update: lanceFx, pos: p, g, k });
    jet(g, 2.1 * k, .3 * k, .4, .45 * k, .18);
    shake(big ? .45 : .28);
  }

  // ======================= 大: Maelstrom Geyser =======================
  function shotL(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age;
    basis(d);
    const R0 = .28, L = Math.min(.25 + s.travel, 1.2);
    for (let h = 0; h < 2; h++) { // a double helix of water trailing the orb, drilling
      const N = 18; let px = 0, py = 0, pz = 0;
      for (let i = 0; i <= N; i++) {
        const u = i / N, th = t * 14 + u * 9 + h * Math.PI, r = R0 * (1.25 - .55 * u);
        tA.copy(p).addScaledVector(d, -L * u).addScaledVector(pv, Math.cos(th) * r).addScaledVector(ph, Math.sin(th) * r);
        if (i) seg(px, py, pz, tA.x, tA.y, tA.z, .04 * (1 - .7 * u), 1.1 * (1 - u), (i + h) % 4 ? DEEP : HI);
        px = tA.x; py = tA.y; pz = tA.z;
      }
    }
    shed(s, dt, 'd', dist * 110 + dt * 40, .2, .9, .038);
    foam(tA.copy(p).addScaledVector(d, -.2), dt * 20, .3, .4);
    spr(S.GLOW, p, R0 * 3.8, R0 * 3.8, 0, 0, GLOWB, .5, .05);
    spr(S.WATER, p, R0, R0, 0, s.seed, DEEP, 1.35, 4);
    spr(S.WATER, p, R0 * .6, R0 * .6, 0, s.seed + .3, HI, .35, 6);
    spr(S.RING, p, R0 * 1.3, R0 * 1.3, t * 3, s.seed, HI, .7, .06);
    // the floor answers from below: a wake of ripples under the orb's path
    if ((s.rip = (s.rip ?? 0) - dt) <= 0 && p.y < 2.2) { s.rip = .07; ripple(p.x + RS(.1), p.z + RS(.1), .5 + .3 * R(), .9, .6); }
    s.prev.copy(p);
  }
  const ERUPT = .45, GH = 3;
  function maelstromFx(e, dt) {
    const a = e.age, g = e.g;
    // the maelstrom: widens and speeds up until the eruption, then slowly closes
    const open = 1 - (1 - sc(a, 0, ERUPT)) ** 2, close = sc(a, 1.6, 2.6), I = Math.min(1, a / .08) * (1 - close);
    const rad = (.4 + 1.8 * open) * (1 - .25 * close);
    sprFloor(S.GLOW, g, rad * 1.5, GLOWB, (.6 + .8 * open) * I, .1);
    sprFloor(S.VORTEX, g, rad, DEEP, 1.4 * I, 1 + 3 * open, e.seed);
    sprFloor(S.VORTEX, g, rad * .6, EYE, .9 * I, -(1.5 + 3 * open), e.seed + .5); // an inner counter-turning layer: depth
    if (a < ERUPT + .05) { // rings contracting inward: the floor is being pulled down
      for (let i = 0; i < 3; i++) {
        const ph0 = ((a * 2.6 + i / 3) % 1), rr = rad * (1.6 - 1.3 * ph0);
        sprFloor(S.RING, g, rr, i ? DEEP : FOAM, 1.4 * Math.sin(Math.PI * ph0) * open, .05, e.seed + i);
      }
      for (let n = take(e, 's', 220 * Q * dt); n > 0; n--) { // foam flecks swirling in over the floor
        const th = R() * TAU, r = rad * (.7 + .6 * R()), c = Math.cos(th), sn = Math.sin(th), w = 2.5 + 2 * open;
        emit(g.x + c * r, .04, g.z + sn * r, -sn * w - c * 1.2, .05, c * w - sn * 1.2, .35 + .2 * R(), .05, .02, .5, 0, R() < .5 ? FOAM : HI, K.SPARK, 1.6, .05, .06, R() * dt);
      }
      for (let n = take(e, 'b', 60 * Q * dt); n > 0; n--) { const th = R() * TAU, r = rad * .5 * R(); drop(g.x + Math.cos(th) * r, .03, g.z + Math.sin(th) * r, RS(.3), 1 + 1.5 * R(), RS(.3), .3, .03); }
      if ((e.rumble = (e.rumble ?? 0) - dt) <= 0) { e.rumble = .1; shake(.12 + .2 * open); }
    }
    if (!e.erupted && a >= ERUPT) { // the eruption: one main geyser, two smaller jets beside it a moment later
      e.erupted = true;
      jet(g, GH, .55, .95, 1);
      for (const [d0, th] of [[.17, e.seed * TAU], [.35, e.seed * TAU + 2.4]]) jet(tA.set(g.x + Math.cos(th) * .85, 0, g.z + Math.sin(th) * .85), 1.9, .22, .35, .45, d0);
      flash(tA.set(g.x, .9, g.z), 1.5, 1.5, .18);
      sprFloor(S.GLOW, g, 3, FOAM, 1, .5);
    }
    const b = a - ERUPT;
    if (b > 0) {
      for (let i = 0; i < 2; i++) { // shock rings over the floor
        const k = sc(b, i * .1, .6 + i * .1), rr = .5 + (3.2 - .8 * i) * (1 - (1 - k) ** 3);
        if (k > 0 && k < 1) sprFloor(S.RING, g, rr, i ? HI : FOAM, 2.2 * (1 - k) ** 1.5, .04, e.seed + 3 + i);
      }
      const kc = sc(b, 0, .35); if (kc < 1) spr(S.RING, tA.set(g.x, 1.3, g.z), .6 + 2.2 * (1 - (1 - kc) ** 3), .6 + 2.2 * (1 - (1 - kc) ** 3), 0, e.seed, HI, 1.6 * (1 - kc) ** 1.5, .04);
      if (b > 1.1) for (let n = take(e, 'm', 40 * (1 - sc(b, 1.8, 2.3)) * Q * dt); n > 0; n--) { // lingering mist over the wet floor
        const th = R() * TAU, r = 1.6 * Math.sqrt(R());
        emit(g.x + Math.cos(th) * r, .1 + R() * .6, g.z + Math.sin(th) * r, RS(.2), .1 + .15 * R(), RS(.2), 1.2 + .6 * R(), .3, .9, 1, 0, FOAM, K.GLOW, .16, .2, 0, R() * dt);
      }
    }
    sprFloor(S.WATER, g, 1.9 * open, EYE, .5 * sc(a, .5, .8) * (1 - sc(a, 2, 2.8)), 1, e.seed); // the wet floor
    return a < 2.8;
  }
  function maelstrom(p0, reason) {
    const p = p0.clone(), g = new THREE.Vector3(p.x, .02, p.z);
    splashBurst(p, 1, 140, 1.1, .6); // the orb bursting on the target
    blobs(p, 6, 2, 1, .08, .6);
    flash(p, 1, 1.6, .14);
    add({ update: maelstromFx, g });
    shake(reason === 'hit' ? .6 : .45);
  }

  const SHOT = { s: shotS, m: shotM, l: shotL };
  const LAND = { s: splashS, m: lance, l: maelstrom };
  const tierOf = t => SHOT[t] ? t : 'm'; // no tier (an old caller): the middle move, never the classic fallback (it routes back here)
  return {
    shot(s, dt) { SHOT[tierOf(s.tier)](s, dt); },
    end(s, reason) { if (reason !== 'hit') LAND[tierOf(s.tier)](s.pos, reason); }, // a hit was drawn by hit() just before
    hit(pos, tier) { LAND[tierOf(tier)](pos, 'hit'); },
  };
}
