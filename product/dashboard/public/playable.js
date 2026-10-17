// Keyboard player for the dummy room (screens 3 ゲーム / 4 最終映像): one of A / B is driven from the keyboard instead of
// the dummy's made-up motion or fake-world.
//   arrows: walk on the floor (camera-ish axes: → +x, ↑ −z)   A (or B when driving B): hold to charge, release to fire
// It only uses the existing contact points: the pose goes in through the dummy room's setTruth (the same path fake-world
// takes), the charge through game.command({ cmd: 'charge' }). game.js is unchanged: the same rules decide charge tiers,
// failing a charge by moving, hits and damage.
import * as W from './world.js';

const SPEED = 1.6;          // m/s
const SWING = .28;          // s, the swing down after releasing
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function createPlayable({ vsrc, game, cfg, save, isActive }) {
  const held = new Set();
  const st = { slot: cfg.playable ?? null, chest: null, yaw: 0, charging: false, swingAt: -9, chargeAt: 0 };
  const listeners = new Set();
  const note = () => { for (const f of listeners) f(); };

  function setSlot(slot) {
    if (st.charging) charge(false);
    cfg.playable = slot || null; save?.();
    st.slot = cfg.playable; st.chest = null; held.clear(); note();
  }
  function charge(on) {
    if (!st.slot) return;
    st.charging = on;
    if (on) st.chargeAt = performance.now() / 1000;
    else st.swingAt = performance.now() / 1000;
    game.command({ cmd: 'charge', slot: st.slot, on });
  }
  const keyOf = () => st.slot?.toLowerCase();
  const usable = () => !!st.slot && !!vsrc.dummy && isActive();

  addEventListener('keydown', e => {
    if (!usable() || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (ARROWS[e.key]) { e.preventDefault(); held.add(e.key); return; }
    if (e.key.toLowerCase() === keyOf()) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat && !st.charging) charge(true); }
  }, true);
  addEventListener('keyup', e => {
    if (ARROWS[e.key]) { held.delete(e.key); return; }
    if (st.charging && e.key.toLowerCase() === keyOf()) { e.stopImmediatePropagation(); charge(false); }
  }, true);
  addEventListener('blur', () => { held.clear(); if (st.charging) charge(false); });

  /** Body pose → the dummy room's truth format (chest, yaw, base, tip, dir, swinging), like dummy-motion.js. */
  function pose(time, foe) {
    const yaw = foe ? Math.atan2(-(foe[2] - st.chest[2]), foe[0] - st.chest[0]) : st.yaw;
    st.yaw = yaw;
    const chest = [st.chest[0], W.CHEST_H + .02 * Math.sin(2.4 * time), st.chest[2]];
    const bp = W.bodyPose(chest, yaw, chest[1]), h = W.STICK.hand, base = W.apply(bp, [h.fwd, h.up, h.right]);
    const sw = time - st.swingAt, swinging = sw >= 0 && sw < SWING;
    let el, az;
    if (st.charging) { const k = Math.min(1, (time - st.chargeAt) / 5); el = 1.15 + .04 * (1 + 2 * k) * Math.sin(time * (8 + 10 * k)); az = .05 * Math.sin(time * 3); } // raised, trembling more as it grows
    else if (swinging) { const u = sw / SWING; el = 1.2 - 1.7 * u; az = 0; }  // down toward the opponent
    else { el = .25 + .12 * Math.sin(1.6 * time); az = .15 * Math.sin(.9 * time); } // idle sway
    const dir = W.app3(bp.R, [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]);
    return { slot: st.slot, chest, yaw, base, tip: base.map((v, i) => v + dir[i] * W.STICK.len), dir, swinging };
  }

  return {
    get slot() { return st.slot; },
    get charging() { return st.charging; },
    setSlot,
    /** The 操作しない / A を操作 / B を操作 switch with a hint; every mounted copy stays in sync. */
    mountControl(el) {
      el.innerHTML = '<div class="seg">' + [['', '操作しない'], ['A', 'A を操作'], ['B', 'B を操作']].map(([v, t]) => `<button data-playable="${v}">${t}</button>`).join('') + '</div><span class="muted playable-hint" style="font-size:12px"></span>';
      const hint = el.querySelector('.playable-hint');
      const show = () => {
        for (const b of el.querySelectorAll('[data-playable]')) b.classList.toggle('on', (b.dataset.playable || null) === st.slot);
        hint.textContent = !st.slot ? '' : !vsrc.dummy ? 'ダミー映像（?dummy）のときだけ動かせる'
          : `十字キーで移動、${st.slot}キー長押しで溜め・離して撃つ（試合中のみ当たる）`;
      };
      for (const b of el.querySelectorAll('[data-playable]')) b.onclick = () => { setSlot(b.dataset.playable); b.blur(); };
      listeners.add(show); show();
    },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    /** Phones list for game.setOnline with the keyboard player counted as connected (its aura / charge are drawn). */
    withSelf(list = []) { return st.slot && vsrc.dummy && !list.some(q => q.slot === st.slot) ? [...list, { slot: st.slot, name: 'キーボード' }] : list; },
    /** true: messages from this slot's phone / fake-world should be ignored (the keyboard owns it). */
    owns(slot) { return !!vsrc.dummy && st.slot === slot; },
    step(dt, time) {
      const d = vsrc.dummy; if (!st.slot || !d) return;
      const frame = d.frame, me = frame?.players?.[st.slot], foe = frame?.players?.[st.slot === 'A' ? 'B' : 'A']?.chest;
      if (!st.chest) { if (!me) return; st.chest = [me.chest[0], W.CHEST_H, me.chest[2]]; st.yaw = me.yaw; }
      if (isActive()) {
        let x = 0, z = 0; for (const k of held) { x += ARROWS[k][0]; z += ARROWS[k][1]; }
        const n = Math.hypot(x, z);
        if (n) {
          const xs = W.FIELD.poly.map(q => q[0]), zs = W.FIELD.poly.map(q => q[1]), m = .2;
          st.chest[0] = Math.max(Math.min(...xs) + m, Math.min(Math.max(...xs) - m, st.chest[0] + x / n * SPEED * dt));
          st.chest[2] = Math.max(Math.min(...zs) + m, Math.min(Math.max(...zs) - m, st.chest[2] + z / n * SPEED * dt));
        }
      }
      d.setTruth(st.slot, pose(time, foe));
    },
  };
}
