// fx-smash-circle.js: a magic circle on the floor under a charging player, in the "smash" style (fx-smash.js draws it from
// the aura hook, on top of the charge effects of fx-smash-charge.js). Drawn with glowing segments lying on the floor
// (floor sprites are culled from above), in the element's colour:
//   outer double ring with rune ticks turning one way, a hexagram turning the other way, small circles on its points,
//   an inner ring; it opens out (0.35 s) when the charge starts, grows and brightens with the level, flashes when the tier
//   goes up, and sends motes up from its rim.
//   draw(a, dt)  a = effects.js's aura state: { el, opt: { charging, level 0..1, tier, feet }, acc, seed }
export function createMagicCircle(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, seg, take } = kit;
  const Y = .02; // just above the floor
  const PAL = {
    fire: { main: [1, .45, .1], hot: [1, .8, .45], dim: [1, .3, .05] },
    thunder: { main: [.3, .7, 1], hot: [.8, .95, 1], dim: [.16, .38, 1] },
  };
  const tA = new THREE.Vector3();
  const now = () => kit.time;

  function circle(cx, cz, r, w, inten, col, n = 48) {
    let px = cx + r, pz = cz;
    for (let i = 1; i <= n; i++) { const a = i / n * TAU, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r; seg(px, Y, pz, x, Y, z, w, inten, col); px = x; pz = z; }
  }
  const pt = (cx, cz, r, a) => [cx + Math.cos(a) * r, cz + Math.sin(a) * r];

  function draw(a, dt) {
    const o = a.opt ?? {}, t = now();
    if (!o.charging || !o.feet) { a.circleAt = null; a.circleTier = null; return; }
    a.circleAt ??= t;
    const P = PAL[a.el] ?? PAL.thunder, L = Math.max(0, Math.min(1, o.level ?? 0)), F = o.feet;
    if (o.tier && a.circleTier && o.tier !== a.circleTier) a.circleFlash = t; // tier went up
    a.circleTier = o.tier;
    const age = t - a.circleAt, open = 1 - Math.exp(-age / .12), flash = Math.max(0, 1 - (t - (a.circleFlash ?? -9)) / .35);
    const R0 = (.55 + .35 * L) * (.4 + .6 * open), I = (.55 + .6 * L) * Math.min(1, age / .2) * (1 + 1.2 * flash), cx = F.x, cz = F.z;
    const spin = t * (.6 + .8 * L);
    // soft light pooled on the floor
    spr(S.GLOW, tA.set(cx, .05, cz), R0 * 2.4, R0 * .9, 0, 0, P.dim, .35 * I, .1);
    // outer double ring
    circle(cx, cz, R0, .03, 1.3 * I, P.main);
    circle(cx, cz, R0 * .9, .014, .9 * I, P.hot);
    // rune ticks between the two rings, turning
    for (let i = 0; i < 24; i++) {
      const th = spin + i / 24 * TAU, long = i % 3 === 0, [x0, z0] = pt(cx, cz, R0 * .91, th), [x1, z1] = pt(cx, cz, R0 * (long ? .99 : .96), th + (long ? 0 : .06));
      seg(x0, Y, z0, x1, Y, z1, long ? .02 : .012, (long ? 1.2 : .7) * I, P.hot);
    }
    // hexagram (two triangles) turning the other way, small circles on its points
    for (let tri = 0; tri < 2; tri++) for (let i = 0; i < 3; i++) {
      const a0 = -spin * 1.3 + tri * Math.PI / 3 + i * TAU / 3, a1 = a0 + TAU / 3, [x0, z0] = pt(cx, cz, R0 * .84, a0), [x1, z1] = pt(cx, cz, R0 * .84, a1);
      seg(x0, Y, z0, x1, Y, z1, .018, 1.1 * I, P.main);
    }
    for (let i = 0; i < 6; i++) { const [x, z] = pt(cx, cz, R0 * .84, -spin * 1.3 + i * TAU / 6); circle(x, z, R0 * .07, .01, .9 * I, P.hot, 12); }
    // inner ring and a small turning square
    circle(cx, cz, R0 * .42, .016, 1 * I, P.main, 32);
    for (let i = 0; i < 4; i++) { const a0 = spin * 2 + i * TAU / 4, [x0, z0] = pt(cx, cz, R0 * .42, a0), [x1, z1] = pt(cx, cz, R0 * .42, a0 + TAU / 4); seg(x0, Y, z0, x1, Y, z1, .01, .7 * I, P.hot); }
    // a ring of light thrown out when the tier goes up
    if (flash > 0) circle(cx, cz, R0 * (1 + .8 * (1 - flash)), .04 * flash + .01, 2 * flash, P.hot);
    // motes rising from the rim
    for (let n = take(a, 'mc', (6 + 22 * L) * Q * dt); n > 0; n--) {
      const th = R() * TAU, [x, z] = pt(cx, cz, R0 * (.85 + .15 * R()), th);
      emit(x, Y + .02, z, RS(.05), .5 + .9 * R(), RS(.05), .5 + .5 * R(), .016, .006, 1.5, .4, P.hot, K.SPARK, 1.6, .2, .05, 0);
    }
  }
  return { draw };
}
