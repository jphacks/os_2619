// "スマブラ風" effect set: one move per element and tier, modelled on Smash Bros. specials (original effects, no assets).
//   炎 小 PK Fire (Ness)          炎 中 Firaga (Sora)              炎 大 Explosive Flame (Palutena)
//   雷 小 Thunder (Robin)         雷 中 Elthunder (Robin)          雷 大 Thunder (Pikachu)
//   溜め: Limit Charge (Cloud) around the body, a Kirby-Spark-like sphere at the stick tip, in the element's colour
// The moves live in fx-smash-fire.js, fx-smash-thunder.js and fx-smash-charge.js; this file routes effects.js's style hooks
// to them (fx.addStyle('smash', createSmashStyle)). A hook a module does not provide falls back to the classic effect.
//
// Contract for the move modules (kit = effects.js primitives, see the `kit` object there):
//   createFireMoves(kit) / createThunderMoves(kit) -> {
//     shot(s, dt)          every frame while the projectile flies. s: { el, tier 's'|'m'|'l', pos (head, moved by the game),
//                          prev (pos last frame: set s.prev.copy(s.pos) at the end), from (muzzle), dir, power, big, age, travel,
//                          acc {}, regen, seed, bolts [6 Bolt] } — keep per-shot state on s
//     end(s, reason)       the projectile is gone: 'hit' | 'floor' | 'timeout' (on a hit, hit() is called just before)
//     hit(pos, tier, power) it struck a player at pos
//   }
//   createChargeMoves(kit) -> {
//     aura(a, dt)          every frame per player: a { el, base, tip (stick), v, opt: { charging, level 0..1, tier, chest, feet } }
//                          (draw the stick glow too, or call kit.classic.aura(a, dt) for it)
//     charge(c, dt)        every frame while charging: c { el, tip, v = level 0..1, opt: { tier, chargeT } }
//   }
import * as fireMod from './fx-smash-fire.js';
import * as thunderMod from './fx-smash-thunder.js';
import * as chargeMod from './fx-smash-charge.js';

// Projectile size (the dashboard's 玉の大きさ, s.scale): the move modules draw at fixed sizes, so while a projectile is being
// drawn the primitives they call are wrapped to scale every position about the projectile's centre, every size and every
// speed by s.scale. Impacts and the charge look are drawn unscaled.
function scaledKit(kit) {
  const Z = { k: 1, c: new kit.THREE.Vector3() }, tP = new kit.THREE.Vector3(), tQ = new kit.THREE.Vector3();
  const at = (v, o) => o.copy(v).sub(Z.c).multiplyScalar(Z.k).add(Z.c);
  const sk = {
    ...kit, _scale: Z,
    emit(x, y, z, vx, vy, vz, life, s0, s1, drag, grav, col, kind, inten, turb, extra, ageOff) {
      const k = Z.k;
      if (k !== 1) { const c = Z.c; x = c.x + (x - c.x) * k; y = c.y + (y - c.y) * k; z = c.z + (z - c.z) * k; vx *= k; vy *= k; vz *= k; s0 *= k; s1 *= k; }
      kit.emit(x, y, z, vx, vy, vz, life, s0, s1, drag, grav, col, kind, inten, turb, extra, ageOff);
    },
    spr(kind, p, sx, sy, rot, seed, col, inten, param) { if (Z.k !== 1) { p = at(p, tP); sx *= Z.k; sy *= Z.k; } kit.spr(kind, p, sx, sy, rot, seed, col, inten, param); },
    sprFloor(kind, p, rad, col, inten, param, seed) { if (Z.k !== 1) { p = at(p, tP); rad *= Z.k; } kit.sprFloor(kind, p, rad, col, inten, param, seed); },
    segV(a, b, w, inten, col) { if (Z.k !== 1) { a = at(a, tP); b = at(b, tQ); w *= Z.k; } kit.segV(a, b, w, inten, col); },
    seg(ax, ay, az, bx, by, bz, w, inten, col) {
      if (Z.k !== 1) { const k = Z.k, c = Z.c; ax = c.x + (ax - c.x) * k; ay = c.y + (ay - c.y) * k; az = c.z + (az - c.z) * k; bx = c.x + (bx - c.x) * k; by = c.y + (by - c.y) * k; bz = c.z + (bz - c.z) * k; w *= k; }
      kit.seg(ax, ay, az, bx, by, bz, w, inten, col);
    },
    gen(b, a, c, ...rest) { if (Z.k !== 1) { a = at(a, tP); c = at(c, tQ); } kit.gen(b, a, c, ...rest); }, // bolts keep the scaled points
    drawBolt(b, w, inten, col) { kit.drawBolt(b, Z.k !== 1 ? w * Z.k : w, inten, col); },
    trailFire(s, dt, prev, pos, pw, big = 1) { const k = Z.k; Z.k = 1; kit.trailFire(s, dt, prev, pos, pw, big * k); Z.k = k; }, // along the real path
    headFire(p, sz, seed, inten) { kit.headFire(Z.k !== 1 ? at(p, tP) : p, sz * Z.k, seed, inten); },
  };
  return sk;
}

export function createSmashStyle(kit0) {
  const kit = scaledKit(kit0), Z = kit._scale;
  const make = (mod, name) => { try { return mod[name]?.(kit) ?? {}; } catch (e) { console.warn('fx-smash', name, e); return {}; } };
  const by = { fire: make(fireMod, 'createFireMoves'), thunder: make(thunderMod, 'createThunderMoves') };
  const ch = make(chargeMod, 'createChargeMoves'), C = kit0.classic;
  const tierPower = { s: .25, m: .6, l: 1 };
  return {
    shot(s, dt) {
      const m = by[s.el]; if (!m.shot) return C.shot(s, dt);
      Z.k = s.scale ?? 1; Z.c.copy(s.pos);
      try { m.shot(s, dt); } finally { Z.k = 1; }
    },
    end(s, reason) { const m = by[s.el]; if (m.end) m.end(s, reason); else C.end(s, reason); },
    // no tier: not a projectile (a charge that fizzled): the small classic burst
    hit(el, pos, power, opt = {}) { const m = by[el]; if (m.hit && opt.tier) m.hit(pos, opt.tier, power); else C.hit(el, pos, opt.tier ? tierPower[opt.tier] : power); },
    charge(c, dt) { if (ch.charge) ch.charge(c, dt); else C.charge(c, dt); },
    aura(a, dt) { if (ch.aura) ch.aura(a, dt); else C.aura(a, dt); },
  };
}
