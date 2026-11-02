// fx-smash-wind.js: the wind moves of the "スマブラ風" set (contract in fx-smash.js). Design notes and references:
// effect-assets/WATER_WIND_IMPLEMENTATION.md.
// Element axis: fire bursts from the centre, thunder strikes from above, water pours / rises, wind comes FROM AROUND and
// travels its own way (fire / thunder fly straight). Air is invisible, so wind is drawn by what it carries and how it moves:
// shader funnels and bands of thin tapered streaks scrolled round them (opacity × fresnel, layers spinning at different rates,
// as in tornado breakdowns on 80.lv / realtimevfx), painted twirls and slashes, dust and leaves picked up and thrown.
// Mostly white / translucent silver with a pale-cyan cast, grey-beige dust; nothing glowing blue (that is thunder).
//   小 Vacuum Crescent:  one crescent edge-first, weaving from side to side across the line of fire; on contact an X of cuts,
//                        painted twirls, streaks flung flat, a few leaves
//   中 Twin Boomerang:   two blades spinning flat, circling the line of fire 0.55 m out (a wide double helix); on contact they
//                        sweep in from where they are and cross on the target (X flash), three after-cuts, twirls, dust, leaves
//   大 Travelling Tempest (signature): a twister spins up at the stick tip, drops to the floor and runs along under the shot,
//                        GROWING as it goes (taller, wider, more dust and leaves); on arrival it swells over the target to 3 m
//                        and holds it (~1.45 s), then blows itself apart: a radial shock gust, swept-grass lines, dust and leaves
//                        flung outward
//   溜め (fx-smash-charge.js): bands of wind wound round the caster, dust and leaves pulled in along the floor.
// The game's shot position and hit time are untouched: the drawn paths are offsets that end on the hit point (小 ≤ 0.15 m,
// 中 the blades sweep in on contact) or are drawn on the floor under the shot (大).
// The landing is drawn once: hit() for a hit, end() for a floor landing or a timeout (end(s, 'hit') only follows a hit()).
export function createWindMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, sprFloor, seg, segV, runit, u3, take, sc, shake, add, gustBurst, screenRot } = kit;
  const V = () => new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
  const tA = V(), tB = V(), tC = V(), tD = V(), pv = V(), ph = V(), side = V();
  const WW = kit.ww, mesh = (shape, p, s, o) => WW?.mesh('wind', shape, p, s, o), sprite = (tex, p, w, h, o) => WW?.wind.sprite(tex, p, w, h, o);
  const sat = x => Math.max(0, Math.min(1, x));
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
      emit(g.x + c * r, .05 + .1 * R(), g.z + sn * r, c * v, .15 + .4 * R(), sn * v, life * (.7 + .5 * R()), .14, .5 + .3 * R(), out > 0 ? 2.2 : .3, .1, DUST, K.SMOKE, .16, .6, 0, 0);
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
  // its own path: the blade weaves from side to side across the line of fire (±0.15 m, ~0.8 waves per metre)
  function weave(s, out) { return out.copy(s.pos).addScaledVector(ph, .15 * sat(s.travel / .35) * Math.sin(s.travel * 5 + s.seed * TAU)); }
  function shotS(s, dt) {
    const dist = track(s), d = s.dir; s.dtw = dt;
    basis(d);
    const p = weave(s, s.vp ??= V()), q = s.vq ??= p.clone();
    tD.copy(p).sub(q); if (tD.lengthSq() > 1e-8) s.vd = (s.vd ?? V()).copy(tD).normalize(); const vd = s.vd ?? d;
    // the blade stands upright across its motion, edge first, with two afterimages fading behind it
    for (let i = 2; i >= 0; i--) {
      tC.copy(p).addScaledVector(vd, -.2 - i * .13);
      arc(tC, vd, pv, .21, 1.15, .032 * (1 - .3 * i), (i ? .5 / i : 2), i ? W : HI);
    }
    sprite('slash', tA.copy(p).addScaledVector(vd, -.05), .32, .5, { axis: pv, rot: 0, color: [.85, .98, 1], intensity: 1.6, occ: .05 });
    sprite('trace', tA.copy(p).addScaledVector(vd, -.4), .16, .8, { axis: vd, color: [.8, .95, 1], intensity: .9, occ: 0 });
    spr(S.GLOW, p, .3, .3, 0, 0, GL, .3, .3);
    speedLines(s, 'sl', p, vd, 6, .22, .6, 1);
    streaks(s, dt, 'k', dist * 60 + dt * 20, .12, 2.5);
    q.copy(p); s.prev.copy(s.pos);
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
    add({ update: twirlFx, p, n: 3, size: .7 * big, T: .3 });
    leaves(p, 6 * big, 2.5);
    shake(.18);
  }
  /** painted twirls (curled wind) spinning out at p and fading */
  function twirlFx(e) {
    const k = sc(e.age, 0, e.T); if (k >= 1) return false;
    for (let i = 0; i < e.n; i++) sprite('twirl', e.p, e.size * (.6 + .7 * k), e.size * (.6 + .7 * k), { rot: e.seed * 9 + i * TAU / e.n - k * 4, color: [.85, .97, 1], intensity: 1.8 * (1 - k) ** 1.3, occ: .05 });
    return true;
  }

  // ======================= 中: Twin Boomerang =======================
  // two blades spinning flat, circling the line of fire 0.55 m out (a wide double helix); on contact they sweep in from where they
  // are and cross on the target
  const BW = .55;
  function bladePos(s, hs, out) {
    const w = BW * sat(s.travel / .6), th = s.travel * 2.4 + s.seed * TAU + (hs > 0 ? 0 : Math.PI);
    return out.copy(s.pos).addScaledVector(pv, Math.cos(th) * w).addScaledVector(ph, Math.sin(th) * w);
  }
  function spinBlade(c, ax, ay, spin, sz, inten) { // a boomerang spinning in the plane (ax, ay): two crescents back to back + a painted twirl
    for (let i = 0; i < 2; i++) {
      const th = spin + i * Math.PI;
      tA.copy(ax).multiplyScalar(Math.cos(th)).addScaledVector(ay, Math.sin(th));
      tB.copy(ax).multiplyScalar(-Math.sin(th)).addScaledVector(ay, Math.cos(th));
      arc(c, tA, tB, sz, 1.0, .028, 1.8 * inten, i ? W : HI, 10);
    }
    sprite('twirl', c, sz * 2.6, sz * 2.6, { rot: -spin * 1.3, color: [.85, .97, 1], intensity: 1.4 * inten, occ: .05 });
  }
  function shotM(s, dt) {
    const dist = track(s), d = s.dir, t = s.age; s.dtw = dt;
    basis(d);
    s.bh ??= { '-1': [], '1': [] };
    for (const hs of [-1, 1]) {
      const c = bladePos(s, hs, V()), H = s.bh[hs];
      H.push({ p: c, t }); while (H.length > 2 && t - H[0].t > .22) H.shift();
      for (let i = H.length - 1; i > 0; i--) { // the curved trail it leaves
        const u = (H.length - 1 - i) / Math.max(1, H.length - 1);
        segV(H[i].p, H[i - 1].p, .03 * (1 - .8 * u), 1.3 * (1 - u), i % 2 ? W : HI);
      }
      spinBlade(c, ph, d, t * 26 * hs, .26, 1);
      spr(S.GLOW, c, .45, .45, 0, 0, GL, .3, .3);
    }
    speedLines(s, 'sl', s.pos, d, 5, .25, .6, .7);
    streaks(s, dt, 'k', dist * 40 + dt * 20, .5, 2.5);
    s.lastB = [bladePos(s, -1, s.lastB?.[0] ?? V()), bladePos(s, 1, s.lastB?.[1] ?? V())];
    s.prev.copy(s.pos);
  }
  // a blade sweeping in from p0 to p1 along a slight curve, leaving a trail of streak segments, then cutting
  function sweepFx(e) {
    const a = e.age - e.delay; if (a < 0) return true;
    const T = e.T, u = Math.min(1, a / T), q = u * u; // accelerating in
    const pos = (w, o) => o.copy(e.p0).lerp(e.p1, w).addScaledVector(UP, Math.sin(Math.PI * w) * e.bend);
    if (u < 1) {
      pos(q, tA); pos(Math.min(1, q + .05), tB); tD.copy(tB).sub(tA).normalize();
      spr(S.CRESCENT, tA, e.sz, e.sz, screenRot(tD), e.seed, W, 2, .3);
      sprite('slash', tA, e.sz * 1.4, e.sz * 2.2, { axis: tD, rot: Math.PI / 2, color: [.85, .98, 1], intensity: 1.5, occ: .05 });
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
      add({ update: twirlFx, p: p.clone(), n: 3, size: 1.1 * k, T: .4 });
      gustBurst(p, .8 * k, 160 * k, 1);
      leaves(p, 14 * k, 3.5);
      if (p.y < 1.6) dustRing(e.g, 16 * k, 3);
      shake(k > .9 ? .5 : .3);
    }
    if (e.hitDone && e.floor) { const kf = sc(a, .14, .75); sprFloor(S.RING, e.g, .2 + 1.6 * (1 - (1 - kf) ** 3), W, 1.4 * (1 - kf) ** 1.5, .04, e.seed); }
    return a < .8;
  }
  function cutM(p0, reason, s) {
    const p = p0.clone(); if (reason === 'floor') p.y = Math.max(.3, p.y);
    const big = reason === 'hit' ? 1 : .75, sd = screenSide();
    // from where the two blades were (or, without the shot, from the left and the right)
    for (const [i, hs] of [[0, -1], [1, 1]]) sweep(s?.lastB?.[i] ?? tA.copy(p).addScaledVector(sd, hs * .9).add(tB.set(0, .25, 0)), p, .42 * big, .14, 0, .15);
    add({ update: crossFxM, pos: p, big, g: new THREE.Vector3(p.x, .02, p.z), floor: p.y < 1.6 });
    shake(.15);
  }

  // ======================= 大: Travelling Tempest =======================
  // a twister spins up at the stick tip, drops to the floor and runs along under the shot, GROWING as it goes; on arrival it
  // swells over the target, holds it, and blows itself apart in an outward gust
  const WC = { a: [.5, .66, .68], b: [.95, 1, 1] }, DC = { a: [.36, .33, .28], b: [.7, .65, .56] };
  /** the tornado at floor point g: shader funnel (3 layers), wind bands wound round it, a dust sheath and floor swirl, debris */
  function tornado(st, g, top, r0, r1, I, t, dt, seed, lean = .25) {
    if (I <= .01) return;
    const base = { r0, r1, h: top, curve: 1.5, wob: .07, lean, spin: 1.5, twist: 1.2, tile: [3, 1.3], seed, occ: .1, opacity: I, intensity: 2, colA: WC.a, colB: WC.b };
    mesh('tube', g, 1, base);
    mesh('tube', g, 1, { ...base, r0: r0 * .55, r1: r1 * .55, spin: 2.6, intensity: 1.7, opacity: .8 * I, seed: seed + .4, tile: [2, 1.6] });
    mesh('tube', g, 1, { ...base, r0: r0 * 1.7 + .1, r1: r1 * 1.15, h: top * .35, curve: .8, spin: .9, colA: DC.a, colB: DC.b, opacity: .9 * I, erode: .25, seed: seed + .8, intensity: 1, occ: .25 }); // dust sheath at the foot
    for (let i = 0; i < 3; i++) mesh('helix', g, 1, { r0: r0 * 1.3 + .05, r1: r1 * 1.2, h: top * .95, turns: 1.6, width: .18 + .1 * r1, phase: -t * 9 + i * TAU / 3, flow: 2.5, tile: [1.5, .6], seed: seed + i, occ: .05, opacity: I, intensity: 2.6, colA: WC.a, colB: WC.b });
    mesh('disc', tA.set(g.x, .02, g.z), r1 * 1.8 + .3, { opacity: .9 * I, spin: -1.2, twist: 1.8, flow: -.4, tile: [4, 2], seed, occ: .2, colA: DC.a, colB: DC.b, intensity: 1.1 });
    spr(S.GLOW, tA.set(g.x, top * .5, g.z), r1 * 2, top * .6, 0, 0, GL, .25 * I, 0);
    for (let n = take(st, 'ds', 14 * I * Q * dt); n > 0; n--) st.dust.push({ th: R() * TAU, r: r0 * 2 + .2 * R(), y: .1, t: 0, s: .5 + .5 * R() });
    for (let i = st.dust.length - 1; i >= 0; i--) { // painted dust clumps carried round the foot
      const q = st.dust[i]; q.t += dt; if (q.t > 1.1) { st.dust.splice(i, 1); continue; }
      q.th += dt * 4; q.y += dt * .5; q.r += dt * .3;
      sprite('dust', tA.set(g.x + Math.cos(q.th) * q.r, q.y, g.z + Math.sin(q.th) * q.r), .5 * q.s, .5 * q.s, { rot: q.th * 2, color: [.62, .58, .5], intensity: .8, opacity: Math.sin(Math.PI * q.t / 1.1) * I, occ: .5, ramp: WW.RAMP.tint });
    }
    for (let n = take(st, 'lf', (8 + 30 * r1) * I * Q * dt); n > 0; n--) { // leaves and grit lifted round it
      const y = top * .7 * R(), r = r0 + (r1 - r0) * y / top, th = R() * TAU, cs = Math.cos(th), sn = Math.sin(th), gr = R() < .35;
      emit(g.x + cs * r, y, g.z + sn * r, -sn * 4.5 + cs * .3, 1.5 + 1.5 * R(), cs * 4.5 + sn * .3, .7 + .4 * R(), gr ? .028 : .06, gr ? .024 : .05, .8, .3,
        gr ? GRIT : LEAF, K.LEAF, 1, .5, RS(10), R() * dt);
    }
    for (let n = take(st, 's', 160 * I * Q * dt); n > 0; n--) { // streaks spiralling up the wall
      const y = top * R(), r = r0 + (r1 - r0) * Math.pow(y / top, 1.5), th = R() * TAU, cs = Math.cos(th), sn = Math.sin(th), w = 6 + 3 * R();
      emit(g.x + cs * r, y, g.z + sn * r, -sn * r * w, 1.5 + 2 * R(), cs * r * w, .1 + .1 * R(), .008, .004, 1.5, 0, R() < .3 ? HI : W, K.SPARK, 1.9, .2, .06, R() * dt);
    }
  }
  function shotL(s, dt) {
    const dist = track(s), d = s.dir, p = s.pos, t = s.age; s.dtw = dt;
    s.tw ??= { acc: {}, dust: [] };
    const k = sat(s.travel / 3.2), spin = Math.min(1, t / .2); // grows with distance; spins up over the first 0.2 s
    const top = Math.max(p.y + .35, 1.3 + 1.4 * k), r0 = .05 + .2 * k, r1 = (.18 + .7 * k) * (.5 + .5 * spin);
    const g = tC.set(p.x, 0, p.z);
    tornado(s.tw, g, top, r0, r1, .6 + .4 * spin, t, dt, s.seed, .15 + .15 * k);
    s.grown = { top, r0, r1 };
    if (t < .3) { // the spin-up at the stick tip: twirls and air drawn in
      sprite('twirl', s.from, .6, .6, { rot: -t * 30, color: [.85, .97, 1], intensity: 2 * (1 - t / .3), occ: .05 });
      sprite('twirl', s.from, .4, .4, { rot: -t * 42 + 2, color: [.85, .97, 1], intensity: 1.6 * (1 - t / .3), occ: .05 });
    }
    for (let n = take(s, 'u', 30 * Q * dt); n > 0; n--) { // dust kicked up behind it
      emit(p.x + RS(.4), .05, p.z + RS(.4), RS(.6) - d.x, .3 + .5 * R(), RS(.6) - d.z, .7 + .5 * R(), .14, .5, 2, .2, DUST, K.SMOKE, .14, .6, 0, R() * dt);
    }
    speedLines(s, 'sl', tA.set(p.x, top * .5, p.z), d, 6, r1 + .1, 1, .6);
    s.prev.copy(p);
  }
  const REL = 1.45;
  function tempestFx(e, dt) {
    const a = e.age, g = e.g, c = e.c, t = kit.time;
    const grow = 1 - (1 - sc(a, 0, .3)) ** 3, die = sc(a, REL - .05, REL + .35), I = 1 - die;
    const G0 = e.g0, top = G0.top + (3.1 - G0.top) * grow, r0 = G0.r0 + (.32 - G0.r0) * grow, r1 = (G0.r1 + (1.15 - G0.r1) * grow) * (1 + .7 * die);
    if (!e.hit0) { e.hit0 = true; cross(c, .6, .2); gustBurst(c, .8, 200, 1.1); leaves(c, 18, 4, 1.5); shake(.8); }
    tornado(e, g, top, r0, r1, I, t, dt, e.seed, .25);
    if (a < REL) {
      for (let i = 0; i < 3; i++) { const k = sc(a, i * .35, i * .35 + .7); if (k > 0 && k < 1) sprFloor(S.RING, g, .4 + 1.8 * (1 - (1 - k) ** 3), i & 1 ? W : HI, 1.1 * (1 - k) ** 1.5, .035, e.seed + i); }
      if ((e.rumble = (e.rumble ?? .2) - dt) <= 0) { e.rumble = .18; shake(.22); }
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
    const r2 = a - REL;
    if (r2 > 0) {
      const k = sc(r2, 0, .45), rr = .5 + 3.1 * (1 - (1 - k) ** 2.5);
      if (r2 < .15) spr(S.FLARE, tA.set(g.x, .15, g.z), 5.5, .12, 0, 0, HI, 2.2 * (1 - r2 / .15) ** 2);
      if (k < 1) {
        sprFloor(S.RING, g, rr, HI, 2.2 * (1 - k) ** 1.3, .03, e.seed + 7);
        sprFloor(S.RING, g, rr * .8, W, 1.2 * (1 - k) ** 1.5, .06, e.seed + 8);
        const N = 44; // swept-grass lines lying down radially just behind the front
        for (let i = 0; i < N; i++) {
          const th = i / N * TAU + e.seed * 3 + RS(.04), cs = Math.cos(th), sn = Math.sin(th), r1b = rr * (.86 + .1 * Math.sin(i * 7.3)), r2b = r1b - .28 - .2 * (i % 3) / 2;
          if (r2b > .2) seg(g.x + cs * r2b, .02, g.z + sn * r2b, g.x + cs * r1b, .02, g.z + sn * r1b, .012, 1.3 * (1 - k), i % 4 ? W : HI);
        }
      }
    }
    return a < REL + .85;
  }
  function tempest(p0, reason, s) {
    const c = p0.clone(); c.y = Math.max(.5, c.y);
    const g = new THREE.Vector3(c.x, 0, c.z);
    add({ update: tempestFx, g, c, g0: s?.grown ?? { top: 2.2, r0: .2, r1: .6 }, dust: [] });
    shake(reason === 'hit' ? .5 : .4);
  }

  const SHOT = { s: shotS, m: shotM, l: shotL };
  const LAND = { s: cutS, m: cutM, l: tempest };
  const tierOf = t => SHOT[t] ? t : 'm'; // no tier (an old caller): the middle move, never the classic fallback (it routes back here)
  const last = new Map(); // tier -> the last shot drawn (hit() does not get the shot: the blades / tornado carry on from it)
  return {
    shot(s, dt) { SHOT[tierOf(s.tier)](s, dt); last.set(tierOf(s.tier), s); },
    end(s, reason) { if (reason !== 'hit') LAND[tierOf(s.tier)](s.pos, reason, s); }, // a hit was drawn by hit() just before
    hit(pos, tier) { const t = tierOf(tier), s = last.get(t); LAND[t](pos, 'hit', s && s.pos.distanceTo(pos) < .5 ? s : null); },
  };
}
