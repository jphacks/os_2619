// fx-smash-water.js: the water moves of the "スマブラ風" set (contract in fx-smash.js). Design notes and references:
// effect-assets/WATER_WIND_IMPLEMENTATION.md.
// Element axis: fire bursts from the centre, thunder strikes from above in an instant, water comes UP FROM THE FLOOR or POURS
// as a heavy sustained mass, wind comes from AROUND. Each element also travels its own way (fire / thunder fly straight).
// How water is sold here (real-time VFX breakdowns): shader meshes with flow textures scrolled along them (fx-ww-layer.js),
// a dark-to-light value ramp with a fresnel rim, white water (Worley foam) where it is turbulent, painted splash / spray / mist
// sprites, droplets that fall under gravity, ring waves on the floor. Timing: anticipation → impact (flash, crown, shake) →
// a long heavy dissipation (rain, ripples, mist).
//   小 Water Ball:    a round, wobbling ball of water (jelly squash and stretch, swirling inside, bubbles) on a slight arc with a
//                     short trail of droplets; on contact it bursts: crown splash, spray, drops, a wet pool with ripples
//   中 Tidal Surge:   no projectile in the air: water bursts up out of the floor in a row of spouts racing from the caster to the
//                     target along the line between them, a breaking crest at its head; on arrival a 2.3 m geyser swallows the target
//   大 Cataract:      an orb arcs up over the line of fire; on contact a magic circle opens above the target and a heavy waterfall
//                     pours out of it onto the target for ~1.4 s (white water, a splash pool with ring waves, spray, mist rolling
//                     out over the floor), then thins and stops; the pool and the mist linger
// The game's shot position and hit time are untouched: the paths drawn here are a slight arc ≤ 0.16 m above the line (小),
// drawn on the floor under the shot (中), or lifted above it to where the circle opens (大).
export function createWaterMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, seg, segV, runit, u3, take, sc, shake, add, screenRot } = kit;
  const WW = kit.ww, WK = WW?.water;
  const V = () => new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
  const tA = V(), tB = V(), tC = V(), pv = V(), ph = V(), vel = V();
  const DEEP = COL.water, HI = COL.waterHi, FOAM = COL.foam, GLOWB = COL.waterGlow;
  const BODY = [.02, .17, .78], LIGHT = [.38, .86, 1], SPR = [.6, .86, 1], MIST = [.75, .9, 1];
  const mesh = (shape, p, s, o) => WW?.mesh('water', shape, p, s, o);
  const sprite = (tex, p, w, h, o) => WK?.sprite(tex, p, w, h, o);
  const sat = x => Math.max(0, Math.min(1, x));
  const hash = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

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
  /** a crown of drops thrown up and out in a cone (axis up), plus a flat skirt along the floor */
  function crown(p, n, sp, spread = .55, floor = true, size = .045) {
    for (let i = 0; i < n * Q; i++) {
      const th = R() * TAU, el = spread * (.5 + .5 * R()), v = sp * (.6 + .6 * R());
      drop(p.x + Math.cos(th) * .08, p.y, p.z + Math.sin(th) * .08, Math.cos(th) * Math.sin(el) * v, Math.cos(el) * v, Math.sin(th) * Math.sin(el) * v, .5 + .4 * R(), size * (.7 + .7 * R()));
    }
    if (floor) for (let i = 0; i < n * .5 * Q; i++) {
      const th = R() * TAU, v = sp * (.5 + .7 * R());
      drop(p.x, p.y + .02, p.z, Math.cos(th) * v, .4 + .8 * R(), Math.sin(th) * v, .3 + .2 * R(), size * .7, 1.2);
    }
  }
  /** ring waves over the floor at g */
  function ripples(g, a, n, gap, T, rad, inten, seed) {
    for (let i = 0; i < n; i++) {
      const k = sc(a, i * gap, i * gap + T);
      if (k <= 0 || k >= 1) continue;
      sprFloor(S.RING, g, .15 + rad * (1 - (1 - k) ** 2.2) * (1 - .12 * i), i & 1 ? HI : FOAM, .7 * inten * (1 - k) ** 1.4, .03 + .015 * i, seed + i);
    }
  }
  /** an impact flash: white-blue bloom, glint star, short flare */
  function flashFx(e) {
    const a = e.age, k = 1 - a / e.T; if (k <= 0) return false;
    spr(S.GLOW, e.pos, e.r, e.r, 0, 0, FOAM, e.i * k * k, .8);
    spr(S.GLOW, e.pos, e.r * 1.8, e.r * 1.8, 0, 0, GLOWB, .8 * e.i * k, .1);
    sprite('glint', e.pos, e.r * 2.2, e.r * 2.2, { color: [.8, .95, 1], intensity: 2.2 * e.i * k * k, occ: 0, rot: e.seed });
    return true;
  }
  const flash = (p, r, i = 1.4, T = .14) => add({ update: flashFx, pos: p.clone(), r, i, T });
  /** painted splash sheets standing round g (axis up), growing and thinning: the crown of a splash */
  function crownSheets(g, a, T, n, size, seed, inten = 1) {
    const k = sc(a, 0, T); if (k >= 1) return;
    const grow = 1 - (1 - k) ** 2.5, fade = (1 - k) ** 1.2, gx = g.x, gy = g.y, gz = g.z; // g may be tA
    for (let i = 0; i < n; i++) {
      const th = (i / n + hash(seed * 31 + i) * .15) * TAU, r = size * .25 * grow;
      tA.set(gx + Math.cos(th) * r, gy + size * .5 * grow, gz + Math.sin(th) * r);
      sprite('splash', tA, size * (.75 + .3 * hash(seed + i)) * grow, size * grow, { color: SPR, intensity: 1.2 * inten * fade, opacity: fade, occ: .35, rot: (hash(seed * 7 + i) - .5) * .5 + Math.sin(th) * .35, flip: i & 1 });
    }
  }
  /** spray clusters flung out from p */
  function sprayFx(e) {
    const a = e.age; let alive = false;
    for (let i = 0; i < e.n; i++) {
      const life = e.life * (.6 + .5 * hash(e.seed * 13 + i)); if (a > life) continue; alive = true;
      const th = hash(e.seed * 5 + i) * TAU, el = .25 + hash(e.seed * 3 + i) * .9, v = e.sp * (.6 + .6 * hash(e.seed * 9 + i)), k = a / life;
      tA.set(e.p.x + Math.cos(th) * Math.cos(el) * v * a, e.p.y + Math.sin(el) * v * a - 4.9 * a * a, e.p.z + Math.sin(th) * Math.cos(el) * v * a);
      if (tA.y < 0) continue;
      sprite('spray', tA, e.size * (.6 + .8 * k), e.size * (.6 + .8 * k), { color: SPR, intensity: 1.3 * (1 - k), opacity: 1 - k * k, occ: .4, rot: th + a * 2 });
    }
    return alive;
  }
  const spray = (p, n, sp, size, life = .6) => add({ update: sprayFx, p: p.clone(), n, sp, size, life });
  /** mist rolling out over the floor from g */
  function mistFx(e) {
    const a = e.age; let alive = false;
    for (let i = 0; i < e.n; i++) {
      const t0 = hash(e.seed * 3 + i) * e.spread, b = a - t0, life = e.life * (.7 + .5 * hash(e.seed * 11 + i)); if (b < 0 || b > life) { if (b < 0) alive = true; continue; } alive = true;
      const th = hash(e.seed * 7 + i) * TAU, k = b / life, r = e.r0 + e.v * life * (1 - (1 - k) ** 2);
      tA.set(e.g.x + Math.cos(th) * r, e.g.y + .15 + .5 * k * e.rise, e.g.z + Math.sin(th) * r);
      const sz = e.size * (.6 + .9 * k);
      sprite('mist', tA, sz * 1.4, sz, { color: MIST, intensity: .8 * e.i, opacity: Math.sin(Math.PI * k) * .7, occ: .12, rot: th * 3 + b * .3 });
    }
    return alive;
  }
  const mist = (g, n, r0, v, size, life, i = 1, spread = 0, rise = 1) => add({ update: mistFx, g: g.clone(), n, r0, v, size, life, i, spread, rise });
  /** a floor pool: the disc of water with outward flow and a foamy middle */
  function pool(g, r, I, seed, foam = .7, flow = .6) {
    if (I <= .01) return;
    sprFloor(S.GLOW, g, r * 1.3, GLOWB, .3 * I, .1);
    mesh('disc', tA.set(g.x, .025, g.z), r, { opacity: .85 * I, intensity: .75, flow, spin: .05, foam, tile: [3, 2.5], seed, occ: .5, colA: [.01, .1, .5], colB: [.25, .62, .9] });
  }

  /** a column of water bursting up from the floor at g: H tall, W radius, stands T s, then collapses as rain.
   *  Layers: flash, crown sheets + drops, spray, shader column (outer body + bright core), crest foam, drops racing up, pool, ripples, rain */
  function jetFx(e, dt) {
    const a = e.age - e.delay; if (a < 0) return true;
    const g = e.g, H = e.H, W = e.W, T = e.T, big = e.big;
    if (!e.go) {
      e.go = true;
      flash(tA.set(g.x, .2 + .3 * big, g.z), W * 3.5, 1.3 + .4 * big);
      crown(tA.set(g.x, .05, g.z), 30 + 120 * big, 2.5 + 2.5 * big, .45, true, .035 + .015 * big);
      spray(tA.set(g.x, .3, g.z), 4 + 8 * big, 2 + 2 * big, .25 + .25 * big, .7);
      shake(.12 + .6 * big);
    }
    const up = 1 - (1 - sc(a, 0, .12 + .06 * big)) ** 3, down = sc(a, T, T + .45), I = 1 - down;
    const top = H * up, bot = H * down * .9; // the collapse eats it from below: the top stays aloft a moment, like water falling
    crownSheets(tA.set(g.x, .02, g.z), a, .45 + .2 * big, 5, (.6 + .9 * big) * Math.max(.5, W * 3), e.seed);
    if (top - bot > .05 && I > 0) {
      const o = { r0: W * 1.1, r1: W * (.7 + .2 * Math.sin(a * 9)), h: top - bot, wob: .14, lean: .06, curve: 1, flow: 3.2, foam: .5 + .3 * big, tile: [2, 1.2 * (top - bot)], seed: e.seed, occ: .7, colA: BODY, colB: LIGHT, erode: .55 * down };
      mesh('tube', tA.set(g.x, bot, g.z), 1, o);
      mesh('tube', tA.set(g.x, bot, g.z), 1, { ...o, r0: W * .55, r1: W * .4, foam: .2, intensity: 1.3, opacity: .7, seed: e.seed + .5, flow: 4.5, occ: .3 });
      spr(S.GLOW, tA.set(g.x, (top + bot) / 2, g.z), W * 3.5, (top - bot) * .7 + .3, 0, 0, GLOWB, .45 * I, .05);
      if (up > .6 && down < .3) { // the crest: white water boiling over the top
        tB.set(g.x, top, g.z);
        crownSheets(tB.set(g.x, top - W * .8, g.z), (a * 2.5) % .4, .4, 4, W * 3.2, e.seed + Math.floor(a * 2.5), .9); // water boiling over the top
        sprite('spray', tB.set(g.x, top, g.z), W * 2.6, W * 2.6, { color: SPR, intensity: .8, opacity: .6 * I, occ: .2, rot: a * 2 });
      }
      for (let n = take(e, 'u', (80 + 300 * big) * I * Q * dt); n > 0; n--) { // water racing up the column
        const th = R() * TAU, r = W * .9 * Math.sqrt(R()), life = .35 + .3 * R();
        emit(g.x + Math.cos(th) * r, bot + .05, g.z + Math.sin(th) * r, Math.cos(th) * .3, (top - bot) / life * 1.1, Math.sin(th) * .3, life, .03 + .02 * R(), .02, .3, -9, R() < .35 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
      }
      for (let n = take(e, 'c', (30 + 140 * big) * I * Q * dt); n > 0; n--) { // spray fanning off the top, raining back
        const th = R() * TAU, v = (1 + 2 * R()) * (.5 + .5 * big);
        emit(g.x + RS(W), top, g.z + RS(W), Math.cos(th) * v, 1 + 2 * R(), Math.sin(th) * v, .8 + .5 * R(), .04, .025, .4, -9.8, R() < .3 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
      }
    }
    if (down > 0 && !e.rained) { // the collapse: the column's water comes down as rain
      e.rained = true;
      const n = (60 + 320 * big) * Q, h0 = Math.max(.6, H * .8);
      for (let i = 0; i < n; i++) {
        const th = R() * TAU, r = W * (1 + 4 * Math.sqrt(R())), y = h0 * (.4 + .6 * R());
        emit(g.x + Math.cos(th) * r * .4, y, g.z + Math.sin(th) * r * .4, Math.cos(th) * r * .8, .5 + R(), Math.sin(th) * r * .8, Math.sqrt(2 * y / 9.8) + .25, .04 + .02 * R(), .03, .2, -9.8, R() < .3 ? HI : DEEP, K.DROP, 1.3, .02, .03, 0);
      }
      mist(g, 6 + 8 * big, W * 2, .8, .5 + .4 * big, 1, .8);
    }
    pool(g, W * (3 + 2 * big) * (.4 + .6 * up), (1 - sc(a, T + .2, T + 1)) * .9, e.seed);
    ripples(g, a, 2 + Math.round(3 * big), .15, .8, W * 6, 1.2 + .8 * big, e.seed);
    return a < T + 1.0;
  }
  const jet = (g, H, W, T, big, delay = 0) => add({ update: jetFx, g: new THREE.Vector3(g.x, .02, g.z), H, W, T, big, delay });

  // ======================= 小: Water Ball =======================
  // a round ball of water on a slight arc: it rides up to 0.16 m above the line of fire and settles back towards it as it
  // nears the end of its range; it wobbles like jelly (squash and stretch along the motion), swirls inside, carries bubbles
  const LIFT_S = tr => .16 * Math.sin(Math.min(Math.PI, tr / 4 * Math.PI)) ** .7;
  function shotS(s, dt) {
    const dist = track(s), d = s.dir, t = s.age;
    basis(d);
    const p = (s.vp ??= V()).copy(s.pos).addScaledVector(UP, LIFT_S(s.travel));
    const q = s.vq ??= p.clone(); vel.copy(p).sub(q); if (vel.lengthSq() < 1e-8) vel.copy(d); vel.normalize();
    const R0 = .15, wob = Math.sin(t * 19 + s.seed * 9), st = 1 + .14 * wob; // jelly: stretched along the motion, squashed across
    const m = mesh('sphere', p, 1, { flow: 1.4, spin: 1.2, foam: .22, tile: [3, 2], seed: s.seed, occ: .65, colA: BODY, colB: LIGHT, intensity: 1.2 });
    if (m) { m.scale.set(R0 / Math.sqrt(st), R0 / Math.sqrt(st), R0 * st); m.lookAt(tA.copy(p).add(vel)); m.rotateZ(t * 3); }
    spr(S.GLOW, p, R0 * 3.5, R0 * 3.5, 0, 0, GLOWB, .45, .05);
    for (let i = 0; i < 4; i++) { // bubbles drifting inside
      const f = (t * (.9 + .4 * hash(i)) + hash(i + 7)) % 1, th = hash(i + 3) * TAU + t * 2, rr = R0 * .5 * Math.sqrt(1 - (2 * f - 1) ** 2);
      sprite('foamRing', tA.copy(p).addScaledVector(pv, R0 * .6 * (2 * f - 1)).addScaledVector(ph, Math.cos(th) * rr).addScaledVector(d, Math.sin(th) * rr * .5), R0 * .28, R0 * .28,
        { color: [.8, .95, 1], intensity: 1.1, opacity: Math.sin(Math.PI * f) * .8, occ: 0 });
    }
    sprite('glint', tA.copy(p).addScaledVector(pv, R0 * .45).addScaledVector(ph, -R0 * .3), R0 * 1.3, R0 * 1.3, { color: [.9, .98, 1], intensity: 1.4, occ: 0, rot: t });
    // a short trail of droplets and a thin wake of mist
    for (let k = take(s, 'd', (dist * 45 + dt * 15) * Q); k > 0; k--) {
      const u = R(); tA.copy(q).lerp(p, u); runit();
      emit(tA.x + u3[0] * R0 * .7, tA.y + u3[1] * R0 * .7, tA.z + u3[2] * R0 * .7, u3[0] * .5 - d.x * .8, u3[1] * .5 + .4, u3[2] * .5 - d.z * .8,
        .35 + .3 * R(), .028, .016, .8, -8, R() < .25 ? HI : DEEP, K.DROP, 1.25, .04, .03, (1 - u) * dt);
    }
    const H = s.wh ??= { pts: [] };
    H.pts.push(p.clone()); if (H.pts.length > 8) H.pts.shift();
    for (let i = 0; i < H.pts.length - 1; i += 2) sprite('mist', H.pts[i], .12 + .03 * (H.pts.length - i), .1 + .02 * (H.pts.length - i), { color: MIST, intensity: .35, opacity: .5 * i / H.pts.length, occ: .15, rot: i });
    q.copy(p); s.prev.copy(s.pos);
  }
  function splashSFx(e) {
    const a = e.age, p = e.pos, k = sc(a, 0, .3);
    if (a < .2) mesh('sphere', p, .12 + .3 * k, { opacity: 1 - a / .2, flow: 3, foam: .6 + k, erode: k * .8, tile: [3, 2], seed: e.seed, occ: .5, colA: BODY, colB: LIGHT });
    crownSheets(p, a, .35, 5, .55, e.seed, 1.1);
    pool(e.g, .45 + .25 * k, (1 - sc(a, .4, 1.1)) * .8, e.seed, .5);
    ripples(e.g, a, 3, .1, .5, .8, 1.2, e.seed);
    return a < 1.1;
  }
  function splashS(p0, reason) {
    const floor = reason === 'floor' || p0.y < .35, p = p0.clone(); if (floor) p.y = .03;
    crown(p, floor ? 70 : 50, floor ? 3.2 : 2.6, floor ? .5 : 1.4, floor);
    spray(p, 6, 2.2, .22, .5);
    flash(p, .45, 1.3, .1);
    add({ update: splashSFx, pos: p, g: new THREE.Vector3(p.x, .02, p.z) });
    if (!floor) mist(tA.set(p.x, Math.max(0, p.y - .3), p.z), 4, .1, .5, .35, .6, .7);
    shake(.18);
  }

  // ======================= 中: Tidal Surge =======================
  // the head on the floor under the shot; spouts burst up behind it every 0.32 m and fall back
  const GAP = .32;
  function spoutFx(e, dt) {
    const a = e.age, g = e.g, T = .55, H = e.H;
    const up = 1 - (1 - sc(a, 0, .1)) ** 3, down = sc(a, .18, T), top = H * up * (1 - .35 * down), bot = H * down * .85;
    if (top - bot > .04) mesh('tube', tA.set(g.x, bot, g.z), 1, { r0: e.W, r1: e.W * .55, h: top - bot, wob: .18, lean: .05, flow: 3.5, foam: .65, tile: [2, 1.2], seed: e.seed, occ: .65, colA: BODY, colB: LIGHT, erode: .6 * down });
    crownSheets(g, a, .4, 4, .55 * e.H + .25, e.seed, .9);
    if (!e.go) { e.go = true; crown(tA.set(g.x, .05, g.z), 26, 2.6, .5, true, .035); }
    for (let n = take(e, 'u', 90 * (1 - down) * Q * dt); n > 0; n--) {
      const th = R() * TAU;
      emit(g.x + Math.cos(th) * e.W * .6, top * .8, g.z + Math.sin(th) * e.W * .6, Math.cos(th) * .9 + e.d.x * 1.2, 1 + 1.5 * R(), Math.sin(th) * .9 + e.d.z * 1.2, .5 + .3 * R(), .035, .02, .4, -9.5, R() < .3 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
    }
    return a < T + .1;
  }
  function wakeFx(e) { // the wet track behind the surge: a long pool strip, foam, ring waves
    const a = e.age, I = 1 - sc(a, .5, 1.4);
    pool(e.g, .42, I * .75, e.seed, .55, .9);
    ripples(e.g, a, 2, .12, .7, .7, 1, e.seed);
    return a < 1.4;
  }
  function shotM(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos;
    const G = tC.set(p.x, .02, p.z), fwd = vel.set(d.x, 0, d.z); if (fwd.lengthSq() < 1e-4) fwd.set(1, 0, 0); fwd.normalize();
    const head = Math.max(.6, p.y + .15); // the crest reaches the shot's height, so the target is hit where the game says
    s.sg ??= { last: s.travel - GAP, from: new THREE.Vector3(s.from.x, .02, s.from.z) };
    while (s.travel - s.sg.last >= GAP) { // the row of spouts left behind the head, rising towards it
      s.sg.last += GAP;
      const back = s.travel - s.sg.last, g = new THREE.Vector3(p.x, .02, p.z).addScaledVector(fwd, -back);
      const k = sat(s.sg.last / 2.5);
      add({ update: spoutFx, g, H: .45 + .75 * k + .25 * R(), W: .14 + .06 * k, d: fwd.clone() });
      add({ update: wakeFx, g: g.clone() });
    }
    // the crest at the head: a leaning wall of water with white water on top
    const t = s.age;
    mesh('tube', G, 1, { r0: .3, r1: .2, h: head, wob: .25, lean: .12, curve: .7, flow: 4, foam: .75, tile: [2, 1.4], seed: s.seed, occ: .7, colA: BODY, colB: LIGHT });
    mesh('helix', tA.copy(G), 1, { r0: .42, r1: .2, h: head, turns: 1.4, width: .16, phase: -t * 12, flow: 2.5, foam: .4, tile: [3, 1], seed: s.seed + .3, occ: .4, colA: BODY, colB: LIGHT, opacity: .9 });
    tA.copy(G).addScaledVector(fwd, .1); tA.y = head;
    sprite('mist', tA, .8, .55, { color: [.85, .95, 1], intensity: .6, opacity: .7, occ: .3, rot: t * 2 });
    crownSheets(tB.copy(G).addScaledVector(fwd, .2), (t * 3.5) % 1 * .4, .4, 3, .7, s.seed + Math.floor(t * 3.5), 1);
    for (let n = take(s, 'sp', (dist * 50 + dt * 30) * Q); n > 0; n--) { // spray thrown forward and sideways off the crest
      const side = R() < .5 ? -1 : 1, v = 1.5 + 2 * R();
      emit(G.x + RS(.2), .1 + R() * head, G.z + RS(.2), fwd.x * v * .8 - fwd.z * side * v * .6, 1 + 2 * R(), fwd.z * v * .8 + fwd.x * side * v * .6, .5 + .3 * R(), .04, .02, .4, -9.5, R() < .3 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
    }
    sprFloor(S.GLOW, G, 1.1, GLOWB, .8, .1);
    s.prev.copy(p);
  }
  function surgeLand(p0, reason) {
    const big = reason === 'hit', k = big ? 1 : .7, g = new THREE.Vector3(p0.x, .02, p0.z);
    flash(tA.set(p0.x, Math.max(.4, p0.y), p0.z), .8 * k, 1.5, .12);
    jet(g, 2.3 * k, .42 * k, .5, .7 * k);
    mist(g, 8, .4, .9, .6, 1.1, .9, .3);
    shake(big ? .45 : .28);
  }

  // ======================= 大: Cataract =======================
  // the orb arcs up: it rides LIFT(travel) above the line of fire, which is where the circle opens on contact
  const LIFT = tr => 1.25 * (1 - Math.exp(-tr / 1.1));
  function shotL(s, dt) {
    const dist = track(s), d = s.dir, t = s.age;
    basis(d);
    const p = tB.copy(s.pos).addScaledVector(UP, LIFT(s.travel));
    const H = s.wh ??= { pts: [] };
    H.pts.push({ p: p.clone(), t: s.age }); while (H.pts.length > 2 && s.age - H.pts[0].t > .3) H.pts.shift();
    const n = H.pts.length;
    for (let i = n - 1; i > 0; i--) { // the arc it leaves: a thick tapering stream
      const u = (n - 1 - i) / Math.max(1, n - 1);
      segV(H.pts[i].p, H.pts[i - 1].p, .12 * (1 - .8 * u), .5 * (1 - u), DEEP);
      if (i % 3 === 0) sprite('mist', H.pts[i].p, .25 + .5 * u, .25 + .5 * u, { color: MIST, intensity: .4, opacity: (1 - u) * .6, occ: .25, rot: i });
    }
    const R0 = .27, pulse = 1 + .05 * Math.sin(t * 13);
    mesh('sphere', p, R0 * pulse, { flow: 1.6, spin: .4, foam: .3, tile: [3, 2], seed: s.seed, occ: .7, colA: BODY, colB: LIGHT, intensity: 1.2 });
    for (let h = 0; h < 3; h++) { // ribbons of water wound round the orb, trailing
      const m = mesh('helix', p, 1, { r0: R0 * 1.25, r1: R0 * 1.25, h: 0, turns: .8, width: .1, phase: t * 7 + h * TAU / 3, flow: 3, foam: .5, tile: [2, 1], seed: s.seed + h, occ: .4, colA: BODY, colB: LIGHT, opacity: .9 });
      if (m) m.rotation.set(h * 1.1 + t * 2, h * .7, t * 1.3);
    }
    spr(S.GLOW, p, R0 * 4, R0 * 4, 0, 0, GLOWB, .55, .05);
    sprite('glint', tA.copy(p).addScaledVector(pv, R0 * .4).addScaledVector(ph, -R0 * .3), .3, .3, { color: [.85, .97, 1], intensity: 1.5, occ: 0, rot: t });
    for (let k = take(s, 'd', (dist * 70 + dt * 30) * Q); k > 0; k--) { runit(); emit(p.x + u3[0] * R0, p.y + u3[1] * R0, p.z + u3[2] * R0, u3[0] * .8 - d.x, u3[1] * .5, u3[2] * .8 - d.z, .5 + .4 * R(), .035, .02, .5, -9, R() < .3 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt); }
    s.prev.copy(s.pos);
  }
  // the magic circle lying flat at height y: double ring, rune ticks, a hexagram and an inner ring, opening out, turning
  function skyCircle(c, R1, I, spin) {
    if (I <= .01) return;
    const ring = (r, w, it, col, n = 48) => { let px = c.x + r, pz = c.z; for (let i = 1; i <= n; i++) { const a = i / n * TAU, x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r; seg(px, c.y, pz, x, c.y, z, w, it, col); px = x; pz = z; } };
    ring(R1, .035, 1.4 * I, HI); ring(R1 * .9, .016, I, FOAM);
    for (let i = 0; i < 24; i++) { const th = spin + i / 24 * TAU, l = i % 3 === 0; seg(c.x + Math.cos(th) * R1 * .91, c.y, c.z + Math.sin(th) * R1 * .91, c.x + Math.cos(th) * R1 * (l ? .99 : .96), c.y, c.z + Math.sin(th) * R1 * (l ? .99 : .96), l ? .02 : .012, (l ? 1.2 : .7) * I, FOAM); }
    for (let tri = 0; tri < 2; tri++) for (let i = 0; i < 3; i++) {
      const a0 = -spin * 1.3 + tri * Math.PI / 3 + i * TAU / 3, a1 = a0 + TAU / 3;
      seg(c.x + Math.cos(a0) * R1 * .84, c.y, c.z + Math.sin(a0) * R1 * .84, c.x + Math.cos(a1) * R1 * .84, c.y, c.z + Math.sin(a1) * R1 * .84, .02, 1.1 * I, HI);
    }
    ring(R1 * .42, .018, I, HI, 32);
    spr(S.GLOW, c, R1 * 2.6, R1 * 1.1, 0, 0, GLOWB, .6 * I, .1);
  }
  const OPEN = .28, POUR = .3, STOP = 1.75;
  function cataractFx(e, dt) {
    const a = e.age, g = e.g, c = e.c, top = c.y - .05, t = kit.time;
    const open = 1 - (1 - sc(a, 0, OPEN)) ** 3, close = sc(a, STOP + .2, STOP + .7);
    const R1 = (.35 + 1.05 * open) * (1 - .3 * close);
    skyCircle(c, R1, (1.2 + .6 * (1 - sc(a, 0, .4))) * (1 - close), a * 1.6);
    if (a < OPEN) { // the orb is pulled into the circle and churns there
      mesh('sphere', tA.copy(c).addScaledVector(UP, -.15 * (1 - open)), .27 * (1 - .6 * open), { flow: 3, foam: .5, tile: [3, 2], seed: e.seed, occ: .7, colA: BODY, colB: LIGHT });
    }
    // underside of the circle: a churning disc of water the fall comes out of
    if (a > .1 && close < 1) {
      const m = mesh('disc', tA.set(c.x, c.y - .02, c.z), R1 * .85, { opacity: (1 - close) * sc(a, .1, .35), flow: -.8, spin: .3, twist: .6, foam: .6, tile: [4, 2], seed: e.seed, occ: .6, colA: BODY, colB: LIGHT });
      if (m) m.rotation.x = Math.PI;
    }
    // the waterfall: its front falls under gravity from the circle; once it stops pouring the tail falls after it
    const b = a - POUR;
    if (b > 0) {
      const fall = top, front = Math.min(fall, 1.2 * b + 4.9 * b * b), bs = a - STOP, tail = bs > 0 ? Math.min(fall, 1.5 * bs + 4.9 * bs * bs) : 0;
      const y1 = top - tail, y0 = Math.max(0, top - front), h = y1 - y0;
      const landed = front >= fall, thick = .5 * (1 - .45 * sc(a, STOP - .3, STOP + .2));
      if (h > .03) {
        const base = { r0: thick * 1.05, r1: thick * .8, h, wob: .1, lean: .03, curve: .6, flow: -5.5, foam: .55, tile: [2.5, 1 * h], seed: e.seed, occ: .75, colA: BODY, colB: LIGHT };
        mesh('tube', tA.set(c.x, y0, c.z), 1, base); // the body
        mesh('tube', tA.set(c.x, y0, c.z), 1, { ...base, r0: thick * .55, r1: thick * .45, flow: -7.5, foam: .3, intensity: 1.4, opacity: .75, seed: e.seed + .4, occ: .3 }); // a bright fast core
        mesh('tube', tA.set(c.x, y0, c.z), 1, { ...base, r0: thick * 1.5, r1: thick * 1.05, flow: -4, foam: .9, opacity: .45, erode: .45, seed: e.seed + .8, wob: .2, occ: .25 }); // a ragged white sheath
        spr(S.GLOW, tA.set(c.x, (y0 + y1) / 2, c.z), thick * 4, h * .7 + .4, 0, 0, GLOWB, .5, .05);
        // the leading edge while falling: white water
        if (!landed) { tA.set(c.x, y0, c.z); sprite('spray', tA, thick * 3.5, thick * 3.5, { color: SPR, intensity: 1.4, opacity: .9, occ: .3, rot: a * 4 }); spr(S.GLOW, tA, thick * 2.5, thick * 2, 0, 0, FOAM, .5, .3); }
      }
      if (landed && !e.hitFloor) { // the impact on the floor (and the target)
        e.hitFloor = true; e.tl = a;
        flash(tA.set(g.x, .4, g.z), 1, 1.1, .14);
        crown(tA.set(g.x, .05, g.z), 220, 4.5, .6, true, .05);
        spray(tA.set(g.x, .4, g.z), 14, 3.5, .5, .8);
        shake(.8);
      }
      if (e.hitFloor) { // the impact zone while it pours
        const pouring = 1 - sc(a, STOP + .1, STOP + .5), b2 = a - e.tl;
        crownSheets(tA.set(g.x, .02, g.z), b2 % .3, .3, 6, 1.2 * pouring + .2, e.seed + Math.floor(b2 / .3), pouring);
        for (let n = take(e, 'sp', 260 * pouring * Q * dt); n > 0; n--) { // spray thrown out low and wide
          const th = R() * TAU, v = 2 + 3.5 * R(), r = thick * (.8 + .4 * R());
          emit(g.x + Math.cos(th) * r, .1 + .3 * R(), g.z + Math.sin(th) * r, Math.cos(th) * v, 1 + 2.5 * R(), Math.sin(th) * v, .45 + .35 * R(), .04, .025, .5, -9.5, R() < .35 ? HI : DEEP, K.DROP, 1.3, .05, .03, R() * dt);
        }
        if ((e.mt = (e.mt ?? 0) - dt) <= 0 && pouring > .2) { e.mt = .12; mist(g, 3, thick, 1.4, .7, 1.2, .9); }
        if ((e.rumble = (e.rumble ?? 0) - dt) <= 0 && pouring > .3) { e.rumble = .14; shake(.2); }
        // white water boiling at the foot of the fall
        mesh('sphere', tA.set(g.x, .02, g.z), 1, { opacity: .8 * pouring, flow: 3, foam: 1.4, erode: .35, tile: [5, 3], seed: e.seed + .2, occ: .45, colA: BODY, colB: LIGHT })?.scale.set(thick * 1.9, .2 * pouring + .03, thick * 1.9);
      }
    }
    // the pool spreading under it, ring waves running out over the floor
    if (e.hitFloor) {
      const b2 = a - e.tl, I = 1 - sc(a, STOP + .5, 3);
      pool(g, .6 + 1.5 * (1 - Math.exp(-b2 * 2.5)), I, e.seed, .8, .9);
      for (let i = 0; i < 5; i++) { // a new ring wave every 0.28 s while it pours
        const ph0 = (b2 / .28 - i) ; if (ph0 < 0) continue;
        const k = (b2 - i * .28) / 1.1; if (k > 1 || a - i * .28 > STOP + 1) continue;
        sprFloor(S.RING, g, .4 + 2.6 * (1 - (1 - k) ** 2), i & 1 ? HI : FOAM, 1.1 * (1 - k) ** 1.4, .035, e.seed + i);
      }
    }
    return a < 3.1;
  }
  function cataract(p0, reason) {
    const g = new THREE.Vector3(p0.x, .02, p0.z);
    const c = new THREE.Vector3(p0.x, Math.max(2.5, p0.y + (reason === 'hit' ? 1.35 : 1.6)), p0.z);
    flash(c, 1, 1.4, .16);
    add({ update: cataractFx, g, c });
    shake(.35);
  }

  const SHOT = { s: shotS, m: shotM, l: shotL };
  const LAND = { s: splashS, m: surgeLand, l: cataract };
  const tierOf = t => SHOT[t] ? t : 'm'; // no tier (an old caller): the middle move, never the classic fallback (it routes back here)
  const last = new Map(); // tier -> the last shot drawn: the 小 ball bursts where it is drawn (a little above the line of fire)
  return {
    shot(s, dt) { SHOT[tierOf(s.tier)](s, dt); last.set(tierOf(s.tier), s); },
    end(s, reason) { if (reason !== 'hit') LAND[tierOf(s.tier)](reason === 'timeout' && s.vp ? s.vp : s.pos, reason); }, // a hit was drawn by hit() just before
    hit(pos, tier) { const t = tierOf(tier), s = last.get(t); LAND[t](s?.vp && s.pos.distanceTo(pos) < .5 ? s.vp : pos, 'hit'); },
  };
}
