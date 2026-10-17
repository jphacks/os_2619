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

export function createSmashStyle(kit) {
  const make = (mod, name) => { try { return mod[name]?.(kit) ?? {}; } catch (e) { console.warn('fx-smash', name, e); return {}; } };
  const by = { fire: make(fireMod, 'createFireMoves'), thunder: make(thunderMod, 'createThunderMoves') };
  const ch = make(chargeMod, 'createChargeMoves'), C = kit.classic;
  const tierPower = { s: .25, m: .6, l: 1 };
  return {
    shot(s, dt) { const m = by[s.el]; if (m.shot) m.shot(s, dt); else C.shot(s, dt); },
    end(s, reason) { const m = by[s.el]; if (m.end) m.end(s, reason); else C.end(s, reason); },
    // no tier: not a projectile (a charge that fizzled): the small classic burst
    hit(el, pos, power, opt = {}) { const m = by[el]; if (m.hit && opt.tier) m.hit(pos, opt.tier, power); else C.hit(el, pos, opt.tier ? tierPower[opt.tier] : power); },
    charge(c, dt) { if (ch.charge) ch.charge(c, dt); else C.charge(c, dt); },
    aura(a, dt) { if (ch.aura) ch.aura(a, dt); else C.aura(a, dt); },
  };
}
