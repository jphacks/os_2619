// How each of A / B moves in the dummy room (screens 3 ゲーム / 4 最終映像):
//   keyboard キーボード操作  arrows walk on the floor (camera-ish axes: → +x, ↑ −z); the slot's own key (A / B) held = charge,
//                            released = fire; Space held = guard (game.command 'guard'). Only one slot on the keyboard at a time.
//   random   ランダム動作    the dummy room's own made-up motion (or fake-world, when it is sending), as before
//   still    静止            stands where it was, facing the other player, stick held still in front
// It only uses the existing contact points: the pose goes in through the dummy room's setTruth (the same path fake-world
// takes), the charge through game.command({ cmd: 'charge' }). game.js is unchanged: the same rules decide charge tiers,
// failing a charge by moving, hits and damage.
import * as W from './world.js';

const SPEED = 1.6;          // m/s
const SWING = .28;          // s, the swing down after releasing
const KEEP = .2;            // s between the Charge events a held key sends: under game.js CHARGE_LIVE (.4 s), so the charge keeps growing while held
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
export const CONTROL_JA = { keyboard: 'キーボード操作', random: 'ランダム動作', still: '静止' };
const SLOTS = ['A', 'B'];

export function createPlayable({ vsrc, game, cfg, save, isActive }) {
  const held = new Set();
  // cfg.control = { A: mode, B: mode }; the old single cfg.playable ('A' | 'B' | null) means that slot on the keyboard
  const saved = cfg.control ?? { A: cfg.playable === 'A' ? 'keyboard' : 'random', B: cfg.playable === 'B' ? 'keyboard' : 'random' };
  const st = Object.fromEntries(SLOTS.map(s => [s, { mode: CONTROL_JA[saved[s]] ? saved[s] : 'random', chest: null, yaw: 0, charging: false, guarding: false, swingAt: -9, chargeAt: 0 }]));
  if (st.A.mode === 'keyboard' && st.B.mode === 'keyboard') st.B.mode = 'random';
  const listeners = new Set();
  const note = () => { for (const f of listeners) f(); };
  const keyboardSlot = () => SLOTS.find(s => st[s].mode === 'keyboard') ?? null;
  const other = s => s === 'A' ? 'B' : 'A';

  function setMode(slot, mode) {
    if (!st[slot] || !CONTROL_JA[mode]) return;
    if (mode === 'keyboard' && st[other(slot)].mode === 'keyboard') return; // one keyboard player at most
    const s = st[slot];
    if (s.charging) charge(slot, false);
    if (s.guarding) guard(slot, false);
    s.mode = mode; s.chest = null;
    if (mode === 'keyboard' || keyboardSlot() === null) held.clear();
    cfg.control = { A: st.A.mode, B: st.B.mode }; delete cfg.playable; save?.();
    note();
  }
  function charge(slot, on) {
    const s = st[slot];
    s.charging = on;
    if (on) s.chargeAt = performance.now() / 1000;
    else s.swingAt = performance.now() / 1000;
    game.command({ cmd: 'charge', slot, on });
  }
  function guard(slot, on) { st[slot].guarding = on; game.command({ cmd: 'guard', slot, on }); }
  const usable = () => !!keyboardSlot() && !!vsrc.dummy && isActive();

  addEventListener('keydown', e => {
    if (!usable() || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = keyboardSlot();
    if (ARROWS[e.key]) { e.preventDefault(); held.add(e.key); return; }
    if (e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); if (!st[k].guarding) guard(k, true); return; } // Space: guard (instead of app.js's 'A shoots')
    if (e.key.toLowerCase() === k.toLowerCase()) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat && !st[k].charging) charge(k, true); }
  }, true);
  addEventListener('keyup', e => {
    if (ARROWS[e.key]) { held.delete(e.key); return; }
    const k = keyboardSlot();
    if (k && st[k].guarding && e.key === ' ') { e.stopImmediatePropagation(); guard(k, false); return; }
    if (k && st[k].charging && e.key.toLowerCase() === k.toLowerCase()) { e.stopImmediatePropagation(); charge(k, false); }
  }, true);
  addEventListener('blur', () => { held.clear(); const k = keyboardSlot(); if (k && st[k].charging) charge(k, false); if (k && st[k].guarding) guard(k, false); });

  /** Body pose → the dummy room's truth format (chest, yaw, base, tip, dir, swinging), like dummy-motion.js. */
  function pose(slot, time, foe) {
    const s = st[slot], still = s.mode === 'still';
    const yaw = foe ? Math.atan2(-(foe[2] - s.chest[2]), foe[0] - s.chest[0]) : s.yaw;
    s.yaw = yaw;
    const chest = [s.chest[0], W.CHEST_H + (still ? 0 : .02 * Math.sin(2.4 * time)), s.chest[2]];
    const bp = W.bodyPose(chest, yaw, chest[1]), h = W.STICK.hand, base = W.apply(bp, [h.fwd, h.up, h.right]);
    const sw = time - s.swingAt, swinging = !still && sw >= 0 && sw < SWING;
    let el, az;
    if (still) { el = .25; az = 0; }
    else if (s.guarding && !s.charging) { el = .02; az = -1.45; } // held level across the body (game.js guardPose: within 25° of level, 30° of square)
    else if (s.charging) { const k = Math.min(1, (time - s.chargeAt) / 5); el = 1.15 + .04 * (1 + 2 * k) * Math.sin(time * (8 + 10 * k)); az = .05 * Math.sin(time * 3); } // raised, trembling more as it grows
    else if (swinging) { const u = sw / SWING; el = 1.2 - 1.7 * u; az = 0; }  // down toward the opponent
    else { el = .25 + .12 * Math.sin(1.6 * time); az = .15 * Math.sin(.9 * time); } // idle sway
    const dir = W.app3(bp.R, [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]);
    return { slot, chest, yaw, base, tip: base.map((v, i) => v + dir[i] * W.STICK.len), dir, swinging };
  }

  return {
    mode: slot => st[slot]?.mode,
    /** The slot on the keyboard, or null. */
    get slot() { return keyboardSlot(); },
    get charging() { const k = keyboardSlot(); return !!k && st[k].charging; },
    setMode,
    /** A / B rows of キーボード操作 / ランダム動作 / 静止 with a hint; every mounted copy stays in sync. */
    mountControl(el) {
      el.innerHTML = SLOTS.map(s => `<div class="row" style="align-items:center;gap:6px"><b style="color:var(--${s});width:1.2em">${s}</b><div class="seg">${
        Object.entries(CONTROL_JA).map(([m, t]) => `<button data-control="${m}" data-s="${s}">${t}</button>`).join('')}</div></div>`).join('')
        + '<span class="muted playable-hint" style="font-size:12px"></span>';
      const hint = el.querySelector('.playable-hint');
      const show = () => {
        const k = keyboardSlot();
        for (const b of el.querySelectorAll('[data-control]')) {
          const s = b.dataset.s, m = b.dataset.control;
          b.classList.toggle('on', st[s].mode === m);
          b.disabled = m === 'keyboard' && k !== null && k !== s; // the other one is already on the keyboard
          b.title = b.disabled ? `${k} がキーボード操作中` : '';
        }
        hint.textContent = !vsrc.dummy && (k || SLOTS.some(s => st[s].mode === 'still')) ? 'ダミー映像（?dummy）のときだけ効く'
          : k ? `十字キーで ${k} を移動、${k}キー長押しで溜め・離して撃つ、スペース長押しでガード（試合中のみ）` : '';
      };
      for (const b of el.querySelectorAll('[data-control]')) b.onclick = () => { setMode(b.dataset.s, b.dataset.control); b.blur(); };
      listeners.add(show); show();
    },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    /** true: messages from this slot's phone / fake-world should be ignored (keyboard or still owns it). */
    owns(slot) { return !!vsrc.dummy && !!st[slot] && st[slot].mode !== 'random'; },
    /** true: this slot's key belongs to the match (keyboard player), not to the screen-4 preview. */
    keyboard(slot) { return !!vsrc.dummy && keyboardSlot() === slot; },
    /** Phones list for game.setOnline with the slots this module drives counted as connected (aura / charge are drawn). */
    withSelf(list = []) {
      if (!vsrc.dummy) return list;
      const add = SLOTS.filter(s => st[s].mode !== 'random' && !list.some(q => q.slot === s)).map(s => ({ slot: s, name: CONTROL_JA[st[s].mode] }));
      return add.length ? [...list, ...add] : list;
    },
    step(dt, time) {
      const d = vsrc.dummy; if (!d) return;
      const frame = d.frame;
      for (const slot of SLOTS) {
        const s = st[slot]; if (s.mode === 'random') continue;
        const me = frame?.players?.[slot], foe = frame?.players?.[other(slot)]?.chest;
        if (!s.chest) { if (!me) continue; s.chest = [me.chest[0], W.CHEST_H, me.chest[2]]; s.yaw = me.yaw; } // start from where it stood
        // a held key stands for a stick that keeps shaking: send the sensor's Charge event every KEEP s, so game.js's
        // "stick stopped for chargeHold s" rule sees a live charge. Only while the match still has it charging, so a
        // charge dropped for moving is not restarted.
        if (s.charging && game.players[slot]?.charging && time - (s.keptAt ?? 0) >= KEEP) { s.keptAt = time; game.onSensed({ slot, name: 'Charge' }); }
        if (s.mode === 'keyboard' && isActive()) {
          let x = 0, z = 0; for (const k of held) { x += ARROWS[k][0]; z += ARROWS[k][1]; }
          const n = Math.hypot(x, z);
          // no bounds: the field outline is only a guide on the floor
          if (n) { s.chest[0] += x / n * SPEED * dt; s.chest[2] += z / n * SPEED * dt; }
        }
        d.setTruth(slot, pose(slot, time, foe));
      }
    },
  };
}
