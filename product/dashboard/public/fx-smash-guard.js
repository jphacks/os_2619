// fx-smash-guard.js: the guard in the "smash" style (fx-smash.js routes effects.js's guard / block hooks here).
// A Reflector-like barrier (Fox) standing in the 3D world: a hexagonal panel upright in front of the guarding player, square to
// the way the body faces (g.base, sent by game.js), drawn with the same glowing segments / sprites / sparks as the other smash
// moves. It has some depth (a front and a back hexagon joined at the corners), so it still reads as a panel from the side.
//   guard(g, dt)     every frame while guarding. g: { el, tip (centre: middle of the stick), base (facing), facing, v, seed, acc }
//                    pops open (0.12 s, overshooting), front hexagon with a soft halo, a counter-turning inner hexagon, faint
//                    spokes, a light running round the rim, sparks off the corners, a flickering fill
//   block(el, pos)   a shot met the barrier: the barrier flares, a hexagon ripple spreads out in its plane, a flash and sparks
// Fire tints it amber, thunder cyan.
export function createGuardMoves(kit) {
  const { THREE, K, S, COL, TAU, Q, R, RS, emit, spr, seg, take, flick, add, shake } = kit;
  const V = () => new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), tA = V(), tB = V(), tC = V();
  const RAD = .62, DEPTH = .14; // m: centre to corner, front to back
  const PAL = {
    fire: { edge: [1, .62, .16], core: [1, .9, .6], fill: [1, .42, .08], spark: COL.ember },
    thunder: { edge: [.3, .78, 1], core: [.82, .97, 1], fill: COL.elecGlow, spark: COL.spark },
  };
  const blockAt = { fire: -9, thunder: -9 };
  const facing = { fire: new THREE.Vector3(1, 0, 0), thunder: new THREE.Vector3(-1, 0, 0) }; // last seen, for block()
  const now = () => kit.time;

  /** The panel's frame: n = facing (horizontal), right = horizontal across it, up = world up. */
  function frame(el, g) {
    const f = facing[el] ?? facing.thunder;
    if (g?.facing && g.base.lengthSq() > 1e-6) f.copy(g.base).setY(0).normalize();
    const right = V().crossVectors(UP, f).normalize();
    return { n: f, right, up: UP };
  }
  const corner = (B, c, r, a, out) => out.copy(c).addScaledVector(B.right, Math.cos(a) * r).addScaledVector(B.up, Math.sin(a) * r);
  /** hexagon outline in the panel's plane (pointy top at rot 0), each edge one glowing segment */
  function hexagon(B, c, r, rot, w, inten, col) {
    for (let i = 0; i < 6; i++) {
      corner(B, c, r, rot + Math.PI / 2 + i * TAU / 6, tA); corner(B, c, r, rot + Math.PI / 2 + (i + 1) * TAU / 6, tB);
      seg(tA.x, tA.y, tA.z, tB.x, tB.y, tB.z, w, inten, col);
    }
  }

  function guard(g, dt) {
    const P = PAL[g.el] ?? PAL.thunder, t = now(), B = frame(g.el, g);
    g.born ??= t; // the map entry is dropped when the guard is lowered, so a new one starts the pop again
    const age = t - g.born, open = age < .12 ? .6 + .55 * Math.sin(age / .12 * Math.PI / 2) : 1 + .04 * Math.exp(-(age - .12) * 12); // overshoot, settle
    const hitBoost = Math.max(0, 1 - (t - blockAt[g.el]) / .25), fl = flick(g.seed, 13), pulse = .85 + .15 * Math.sin(t * 9);
    const v = g.v * (age < .12 ? .7 + 2 * (1 - age / .12) : 1), r = RAD * open;
    const c = tC.copy(g.tip).addScaledVector(B.n, .1), back = V().copy(c).addScaledVector(B.n, -DEPTH); // a little ahead of the stick
    // fill: a translucent sheen with a hot centre
    spr(S.GLOW, c, r * 2.2, r * 2.2, 0, 0, P.fill, (.22 + .5 * hitBoost) * v * fl, .1);
    spr(S.GLOW, c, r * .7, r * .7, 0, 0, P.core, (.25 + .6 * hitBoost) * v, .5);
    // front: soft halo + bright rim; back rim dimmer; the corners joined front to back
    hexagon(B, c, r, 0, .1, (.35 + .6 * hitBoost) * v * pulse, P.fill);
    hexagon(B, c, r, 0, .028, (1.5 + 1.5 * hitBoost) * v * pulse * fl, P.edge);
    hexagon(B, back, r * .96, 0, .018, (.6 + .6 * hitBoost) * v, P.edge);
    for (let i = 0; i < 6; i++) { const a = Math.PI / 2 + i * TAU / 6; corner(B, c, r, a, tA); corner(B, back, r * .96, a, tB); seg(tA.x, tA.y, tA.z, tB.x, tB.y, tB.z, .014, .7 * v, P.edge); }
    // inner hexagons turning the other way, spokes to the corners
    hexagon(B, c, r * .62, -t * .9, .016, (.75 + .8 * hitBoost) * v, P.edge);
    hexagon(B, c, r * .3, t * 1.4, .012, .6 * v, P.core);
    for (let i = 0; i < 6; i++) { corner(B, c, r, Math.PI / 2 + i * TAU / 6, tA); seg(c.x, c.y, c.z, tA.x, tA.y, tA.z, .008, .35 * v * (.7 + .3 * Math.sin(t * 11 + i)), P.edge); }
    // a light running round the front rim (two, opposite)
    for (let k = 0; k < 2; k++) {
      const u = (t * 1.6 + k * .5) % 1 * 6, i = Math.floor(u), f = u - i, a0 = Math.PI / 2 + i * TAU / 6, a1 = a0 + TAU / 6;
      corner(B, c, r, a0, tA); corner(B, c, r, a1, tB); const p0 = V().copy(tA).lerp(tB, f), p1 = V().copy(tA).lerp(tB, Math.min(1, f + .22));
      seg(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, .045, 2.6 * v, P.core);
    }
    // sparks flicking off the corners, out in the panel's plane
    for (let n = take(g, 'gs', 26 * Q * dt * (1 + 3 * hitBoost)); n > 0; n--) {
      corner(B, c, r, Math.PI / 2 + Math.floor(R() * 6) * TAU / 6, tA);
      const ox = tA.x - c.x, oy = tA.y - c.y, oz = tA.z - c.z;
      emit(tA.x, tA.y, tA.z, ox * 1.2 + RS(.3), oy * 1.2 + RS(.3), oz * 1.2 + RS(.3), .2 + .2 * R(), .014, .005, 3, 0, P.spark, K.SPARK, 1.8, 0, .05, 0);
    }
  }

  function ripple(e) {
    const a = e.age, P = PAL[e.el] ?? PAL.thunder, k = Math.min(1, a / .35), ease = 1 - (1 - k) ** 3, B = e.B;
    hexagon(B, e.pos, RAD * (1 + 1.1 * ease), 0, .04 * (1 - k) + .01, 2.2 * (1 - k) ** 1.5, P.edge);
    hexagon(B, e.pos, RAD * (1 + .6 * ease), 0, .02, 1.4 * (1 - k) ** 2, P.core);
    if (a < .12) { spr(S.FLARE, e.pos, 1.8, .07, 0, 0, P.core, 2.4 * (1 - a / .12) ** 2); spr(S.GLOW, e.pos, .9, .9, 0, 0, P.core, 2 * (1 - a / .12), .5); }
    return a < .35;
  }
  function block(el, pos) {
    blockAt[el] = now();
    const B = frame(el, null);
    add({ update: ripple, el, pos: pos.clone(), B: { n: B.n.clone(), right: B.right, up: UP } });
    const P = PAL[el] ?? PAL.thunder;
    for (let i = 0; i < 40 * Q; i++) { const a = R() * TAU, s = 1.5 + 2.5 * R(); tA.copy(B.right).multiplyScalar(Math.cos(a) * s).addScaledVector(UP, Math.sin(a) * s).addScaledVector(B.n, s * .4 * R());
      emit(pos.x, pos.y, pos.z, tA.x, tA.y, tA.z, .25 + .25 * R(), .016, .006, 2.5, 1, P.spark, K.SPARK, 2, 0, .05, 0); }
    shake(.15);
  }
  return { guard, block };
}
