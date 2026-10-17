// Game state and rules, shared by the game screen (3D arena) and the final render (camera picture): one match, two views.
// Ported from kawashima/app.js. Players are placed from phonealign.js (chest phones), (no pose / hand estimation),
// or the start marks; the sword (stick) tip is base + IMU direction × stick length. Moves come from the sensing team's
// detectors (actions.js: Charge / Swing) and from the keys / buttons. Rules (GAME_DESIGN.md, 10/17):
//   Swing without charging → 小 (weak, can be repeated every `rapid` s)
//   Charge (circle the stick) → charging; Swing releases it: under t1 s 小, t1..t2 s 中, t2 s and more 大 (special move)
//   moving the chest more than `moveFail` m while charging drops the charge
//   every tier is a projectile along the aim: dodging is just moving out of its way (no invulnerable dodge)
//   guard (10/18): the stick held still in any pose for guardHold s (not while charging, not right after a swing), or the guard button: a 小 that
//   reaches the guard bounces back at its shooter; 中 and 大 go through it (full damage)
//   aim 'motion' (default): where the stick tip was travelling just before it stopped (GAME_DESIGN.md); 'stick': where the
//   stick points; 'eye': from the eyes through the tip. Buttons / keys (no swing) fall back to 'stick'.
//   10/18: in 'motion', 小 flies level at the tip's height, heading between the chest phone's facing and the tip's motion (levelAim)
// Hits are 3D: shot sphere vs the opponent's vertical body segment. Effects go to effects.js (fx), sound to audio.js (sfx).
import * as THREE from 'three';
import * as W from './world.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v3 = a => V(a[0], a[1], a[2]);
const rotQ = ([w, x, y, z], [a, b, c]) => { // rotate v by quaternion [w, x, y, z]
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const BODY_DIR = { forward: [1, 0, 0], back: [-1, 0, 0], right: [0, 0, 1], left: [0, 0, -1] }; // body frame: x fwd, y up, z right
export const ELEMENT = { A: 'fire', B: 'thunder' };
export const ELEMENT_JA = { fire: '炎', thunder: '雷' };
export const PHASE_JA = { setup: '準備中', countdown: 'カウントダウン', fight: '試合中', result: '試合終了' };
export const TIER_JA = { s: '小', m: '中', l: '大' };
/** Numbers the dashboard can change while play-testing (cfg.rules). */
export const RULES = { t1: 2, t2: 5, dmg: { s: 5, m: 20, l: 60 }, rapid: .25, moveFail: .5, chargeHold: 1.5, guardHold: .3, size: { s: 1, m: 1, l: 1 }, hp: 100, speed: 1 }; // size: ball size × (looks and hit radius); hp: each player's HP at the start; speed: ball speed × (all tiers)
// how each tier looks and flies (provisional effects: size tells the tiers apart). radius is only the hit radius (m),
// a little larger than the ball looks so near misses still count (10/18: .12 / .28 / .5 were too strict)
const TIER = {
  s: { power: .15, big: .7, speed: 11, radius: .2, hit: .25 },
  m: { power: .6, big: 1.5, speed: 8, radius: .38, hit: .65 },
  l: { power: 1, big: 2.8, speed: 6.5, radius: .62, hit: 1 },
};
export const POS_JA = { auto: '自動', phones: '胸スマホ', start: '立ち位置' };

/**
 * createGame({ fx, drone, sfx: () => audio | null, cfg, onFlash, clock? }) → { players, match, shots, events, step, onSensed, command, canAct, ... }
 * cfg (live object): posSrc 'auto'|'phones'|'camera'|'start', hand 'R'|'L', aim 'stick'|'eye', stickLen { A, B }, test (no HP loss),
 * rules (RULES: tier seconds, damage, rapid-fire interval, how far you may move while charging).
 */
export function createGame({ fx, drone, sfx = () => null, cfg, onFlash = () => {}, clock = null, getDummyFrame = () => null }) {
  const now = clock ?? (() => performance.now() / 1000); // test-game.mjs drives a fake clock
  const events = []; // newest first: { at: Date.now(), slot, kind, text }
  const log = (slot, kind, text) => { events.unshift({ at: Date.now(), slot, kind, text }); if (events.length > 200) events.pop(); };
  const panOf = v => { // world x across the field -> stereo pan -1..1 (the camera looks along -z, so +x is screen right)
    const xs = W.FIELD.poly.map(q => q[0]), a = Math.min(...xs), b = Math.max(...xs);
    return Math.max(-1, Math.min(1, ((v.x - a) / ((b - a) || 1)) * 2 - 1));
  };

  function makePlayer(slot) {
    return { slot, element: ELEMENT[slot], hp: cfg.rules?.hp ?? RULES.hp, hpMax: cfg.rules?.hp ?? RULES.hp, online: false, imu: null, truth: null, charge: 0, chargeT: 0, charging: false, chargeFrom: null, tier: null, act: null, guarding: false, guardBtn: false,
      body: W.bodyPose(W.START[slot].pos, W.START[slot].yaw), chest: V(), base: V(), tip: V(), dir: V(1, 0, 0), trail: [], lastShot: -9, src: 'start', stickSrc: '-',
      shots: 0, hits: 0, specials: 0, fails: 0, dealt: 0 };
  }
  const players = { A: makePlayer('A'), B: makePlayer('B') };
  const other = p => p === players.A ? players.B : players.A;
  const shots = [];
  // mode 'demo' (デモ試合): the same match, but every shot is aimed at the other player's chest when it is fired, then flies
  // straight (for showing it off; a quick enough sidestep after the shot still dodges it)
  const match = { phase: 'setup', mode: 'normal', ready: false, paused: false, sec: 60, left: 60, until: 0, fightAt: -9 };
  let winner = null;
  const canAct = () => !match.paused && match.phase === 'fight';
  const rules = () => cfg.rules ?? RULES;
  const CHARGE_LIVE = .4; // s after a Charge event the circling counts as still going (actions.js sends one every ~.15 s while it does)
  const speedOf = T => T.speed * (rules().speed ?? 1); // m/s, the dashboard's ball-speed slider applied
  const tierOf = t => t < rules().t1 ? 's' : t < rules().t2 ? 'm' : 'l';
  const IMU_SIDE = cross(W.STICK.axis, W.STICK.up);

  function place(p, est, sensorOnly = false) {
    let dummy = getDummyFrame()?.players?.[p.slot];
    if (dummy?.source === 'synthetic' && (p.imu || est?.stick?.[p.slot]?.dir)) dummy = null; // a real stick is sending: never replace it with the dummy room's made-up swing
    if (dummy) {
      p.body = W.bodyPose(dummy.chest, dummy.yaw, dummy.chest[1]);
      p.chest.fromArray(dummy.chest); p.base.fromArray(dummy.base);
      p.tip.fromArray(dummy.tip); p.dir.fromArray(dummy.dir);
      p.src = 'dummy'; p.stickSrc = 'ダミー映像と同じ座標';
      return;
    }
    const g = est?.slots?.[p.slot] ?? {}, st = W.START[p.slot], T = p.truth;
    const phoneOk = g.chest && (g.aligned || g.src === 'localize');
    const src = cfg.useTruth && T ? 'truth' : cfg.posSrc === 'auto' || sensorOnly ? (phoneOk ? 'phones' : 'hold') : cfg.posSrc;
    if (src === 'truth') p.body = W.bodyPose(T.chest, T.yaw, T.chest[1]);
    else if (src === 'phones' && phoneOk) p.body = W.bodyPose(g.chest, g.yaw ?? st.yaw, g.chest[1]);
    else if (src === 'start' || !p.body) p.body = W.bodyPose(st.pos, st.yaw);
    p.src = src === 'hold' ? (p.src === 'start' ? 'start' : 'hold') : src;
    p.chest.copy(v3(p.body.t));
    // hand in the body frame (x fwd, y up, z right)
    const h = W.STICK.hand;
    p.base.copy(v3(W.apply(p.body, [h.fwd, h.up, h.right])));
    const sk = est?.stick?.[p.slot];
    if (sk?.dir) { p.dir.copy(v3(sk.dir)).normalize(); p.stickSrc = sk.src === 'calib-ar' ? 'IMU（キャリブ時の向き基準）' : 'IMU（立ち位置の向き基準）'; }
    else if (p.imu) {
      const v = rotQ(p.imu.q, W.STICK.axis);
      p.dir.copy(v3(W.app3(W.bodyPose(st.pos, st.yaw).R, [dot(v, W.STICK.axis), dot(v, W.STICK.up), dot(v, IMU_SIDE)]))).normalize();
      p.stickSrc = 'IMU';
    } else { p.dir.copy(v3(W.app3(p.body.R, [1, 0, 0]))); p.stickSrc = 'IMU なし（前向き）'; }
    if (T && cfg.useTruth) { p.base.copy(v3(T.base)); p.dir.copy(v3(T.dir)); }
    p.tip.copy(p.base).addScaledVector(p.dir, cfg.stickLen?.[p.slot] ?? W.STICK.len);
  }

  function effects(p) {
    const s = sfx();
    // try-out charge (fxTest, any phase): the same level / tier the real charge would have after that long
    const pv = p.preview ? Math.max(0, now() - p.preview) : null;
    const charging = p.charging || pv !== null, chargeT = pv ?? p.chargeT, level = pv !== null ? Math.min(1, pv / rules().t2) : p.charge;
    const tier = charging ? (pv !== null ? tierOf(pv) : p.tier) : null;
    if ((match.phase !== 'setup' && (p.online || p.imu)) || pv !== null) { // no effects while setting up (except the try-out)
      fx.aura(p.element, p.base, p.tip, charging ? .6 + .4 * level : .5, p.element,
        { charging, level, tier, chest: p.chest, feet: V(p.chest.x, 0, p.chest.z) });
      if (charging) fx.charge(p.element, p.tip, level, p.element, { tier, chargeT });
      s?.aura(p.slot, p.element, match.paused ? 0 : p.charging ? .6 + .4 * p.charge : .4, panOf(p.chest));
    } else s?.aura(p.slot, p.element, 0, 0);
    if (p.guarding) { const f = W.app3(p.body.R, [1, 0, 0]); fx.guard(p.element, p.base.clone().lerp(p.tip, .5), 1, undefined, V(f[0], 0, f[2]).normalize()); } // facing: the shield stands square to it
  }
  // 10/18: a guard is the stick held still, in any pose: it stays within GUARD_STILL of where it is now for the last
  // guardHold s; not while charging, not right after a swing (the stop is the swing's shot). Not frame to frame: sensor packets and frames tick at different rates, so a still stick's dir moves
  // in 1-2° steps that read as tens of °/s over one frame (a held stick failed to guard). 7° / 0.3 s: above a still
  // stick's jitter, below a ±17° 1.5 Hz wobble even at its turning point (9.7°)
  const GUARD_STILL = 7 * Math.PI / 180, AFTER_SWING = .8;
  function stepGuard() {
    for (const p of Object.values(players)) {
      const t = now(), win = rules().guardHold, h = p.guardHist ??= [];
      h.push({ t, dir: p.dir.clone() }); while (h.length > 2 && h[1].t <= t - win) h.shift();
      const dev = Math.max(...h.map(x => p.dir.angleTo(x.dir))); // the furthest any sample in the window is from now: a wobble's turning point is not still
      const still = t - h[0].t >= win - 1e-6 && dev < GUARD_STILL && t - (p.swingAt ?? -9) > AFTER_SWING; // held still for the whole hold
      const on = canAct() && !p.charging && (p.guardBtn || still);
      if (on && !p.guarding) { showAct(p, 'ガード'); log(p.slot, 'guard', 'ガード'); sfx()?.guard('up', panOf(p.chest)); }
      p.guarding = on;
    }
  }

  /** Fires one projectile of tier 's' | 'm' | 'l' along the aim. 小 is limited to one every rules().rapid s. */
  function shoot(p, tier = 's') {
    if (!canAct()) return false;
    if (tier === 's' && now() - p.lastShot < rules().rapid) return false;
    p.lastShot = now();
    const T = TIER[tier], s = sfx();
    const dummyTarget = !!getDummyFrame(), homing = dummyTarget || match.mode === 'demo';
    const aim = homing ? other(p).chest.clone().sub(p.tip).normalize()
      : cfg.aim === 'eye' ? p.tip.clone().sub(p.chest.clone().add(V(0, .35, 0))).normalize()
        : (cfg.aim ?? 'motion') === 'motion' ? (tier === 's' ? levelAim(p) : motionAim(p) ?? p.dir.clone()) : p.dir.clone();
    p.shots++; if (tier === 'l') p.specials++;
    showAct(p, tier === 'l' ? '大！' : TIER_JA[tier]);
    if (tier === 'l') { s?.special(p.element, panOf(p.tip)); drone?.event('special', { owner: p.slot, from: p.tip.clone(), to: p.tip.clone().addScaledVector(aim, 6) }); }
    else { s?.shot(p.element, panOf(p.tip), T.power); drone?.event('shot', { owner: p.slot, pos: p.tip.clone(), dir: aim.clone() }); }
    const k = sizeOf(tier);
    // steer: the dummy room keeps turning a shot onto the chest it was drawn at; デモ試合 never does (aimed once, then straight)
    const steer = dummyTarget && match.mode !== 'demo';
    shots.push({ id: fx.shot(p.element, p.tip.clone(), aim.clone(), T.power, T.big * k, { tier, scale: k }), owner: p, element: p.element, tier, size: k, pos: p.tip.clone(), vel: aim.multiplyScalar(speedOf(T)), born: now(), dummyTarget, homing, steer });
    log(p.slot, tier === 'l' ? 'special' : 'shot', `${TIER_JA[tier]}の攻撃${tier === 's' ? '' : `（溜め ${p.chargeT.toFixed(1)} 秒）`}`);
    return true;
  }
  /** Direction the stick tip was moving just before it stopped: the last stretch of the swing still above half its top
   *  speed, measured over ~0.08 s. The tip is taken relative to the chest, so walking is not a swing; one-frame jumps
   *  faster than a tip can move (a re-localised phone, a lost IMU packet) are ignored. null when the tip did not really
   *  move (a button press, a slow drift). */
  function motionAim(p) {
    const tr = p.trail; if (tr.length < 4) return null;
    const sp = [];
    for (let i = 1; i < tr.length; i++) {
      const dt = tr[i].t - tr[i - 1].t; if (dt <= 0) continue;
      const v = tr[i].p.distanceTo(tr[i - 1].p) / dt;
      if (v < 25) sp.push({ i, v }); // m/s; a fast sword tip is ~15
    }
    if (!sp.length) return null;
    const vmax = Math.max(0, ...sp.map(x => x.v));
    if (vmax < (cfg.motionMin ?? 1)) return null; // m/s
    const end = sp.filter(x => x.v >= .5 * vmax).at(-1).i;
    let j = end; while (j > 0 && tr[end].t - tr[j].t < .08 && tr[j].p.distanceTo(tr[j - 1].p) / Math.max(1e-3, tr[j].t - tr[j - 1].t) < 25) j--;
    const d = tr[end].p.clone().sub(tr[j].p);
    return d.lengthSq() > 1e-6 ? d.normalize() : null;
  }
  /** 小's aim: level (it keeps the tip's height), heading halfway-ish between the body's facing (chest phone) and the
   *  tip's horizontal motion. A chop straight down flies along the facing; a sideways swipe veers up to 45° toward it;
   *  motion backwards is dropped. Without a swing (button), the facing. */
  function levelAim(p) {
    const f = W.app3(p.body.R, [1, 0, 0]), fh = V(f[0], 0, f[2]).normalize(), m = motionAim(p);
    if (!m) return fh;
    const mh = V(m.x, 0, m.z), back = mh.dot(fh);
    if (back < 0) mh.addScaledVector(fh, -back);
    return fh.add(mh).normalize();
  }
  const sizeOf = tier => Math.max(.2, Math.min(4, +(rules().size?.[tier] ?? 1) || 1));
  function fxShot(p, tier) { // try-out: aimed at the other player's chest so it always shows the hit too
    const T = TIER[tier], foe = other(p), aim = foe.chest.clone().sub(p.tip).normalize();
    if (tier === 'l') sfx()?.special(p.element, panOf(p.tip)); else sfx()?.shot(p.element, panOf(p.tip), T.power);
    const k = sizeOf(tier);
    shots.push({ id: fx.shot(p.element, p.tip.clone(), aim.clone(), T.power, T.big * k, { tier, scale: k }), owner: p, element: p.element, tier, size: k, test: true, homing: match.mode === 'demo', pos: p.tip.clone(), vel: aim.multiplyScalar(speedOf(T)), born: now() });
    showAct(p, tier === 'l' ? '大！' : TIER_JA[tier]);
  }
  function damage(foe, from, tier) {
    const n = Math.round(+rules().dmg[tier] || 0);
    from.hits++; from.dealt += n; log(from.slot, 'hit', `${foe.slot} に${TIER_JA[tier]}が命中 ${n} ダメージ`);
    onFlash(from.element);
    if (match.phase !== 'fight' || cfg.test) return; // test mode: hits show but HP never drops
    foe.hp = Math.max(0, foe.hp - n);
    if (foe.hp === 0) finish(from);
  }
  function stepShots(dt) {
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i], foe = other(s.owner), T = TIER[s.tier];
      if (s.steer && getDummyFrame()) { // dummy room (not デモ試合): steer at the chest every frame
        const distance = s.pos.distanceTo(foe.chest);
        s.vel.copy(foe.chest).sub(s.pos).normalize().multiplyScalar(speedOf(T));
        s.pos.addScaledVector(s.vel, Math.min(dt, distance / speedOf(T)));
      } else s.pos.addScaledVector(s.vel, dt);
      fx.moveShot(s.id, s.pos);
      // hit: distance to the opponent's vertical body segment (capsule radius .3 + the shot's own radius)
      const a = foe.chest.clone().setY(foe.chest.y - 1.05), b = foe.chest.clone().setY(foe.chest.y + .15);
      const hit = (match.phase === 'fight' || s.test) && new THREE.Line3(a, b).closestPointToPoint(s.pos, true, V()).distanceTo(s.pos) < .3 + T.radius * (s.size ?? 1);
      if (hit && foe.guarding) { // 小 bounces back at its shooter; 中 / 大 go through the guard and hit
        fx.block(foe.element, s.pos.clone());
        if (s.tier === 's') {
          sfx()?.guard('reflect', panOf(s.pos));
          const back = s.owner.chest.clone().sub(s.pos).normalize();
          fx.endShot(s.id, 'timeout');
          s.id = fx.shot(s.element, s.pos.clone(), back.clone(), T.power, T.big * (s.size ?? 1), { tier: s.tier, scale: s.size ?? 1 });
          s.vel.copy(back).multiplyScalar(speedOf(T)); s.owner = foe; s.born = now(); s.steer = false;
          foe.reflects = (foe.reflects ?? 0) + 1; showAct(foe, '反射！'); log(foe.slot, 'guard', `${other(foe).slot} の小を反射`);
          continue;
        }
        sfx()?.guard('break', panOf(s.pos)); log(foe.slot, 'guard', `${TIER_JA[s.tier]}にガードを貫通された`);
      }
      if (hit) {
        fx.hit(s.element, s.pos.clone(), T.hit, { tier: s.tier, target: foe.chest.clone() }); sfx()?.hit(s.element, panOf(s.pos), T.hit, s.tier);
        drone?.event('hit', { target: foe.slot, pos: s.pos.clone(), power: T.hit });
        if (!s.test) damage(foe, s.owner, s.tier); // try-out shots only show
      }
      const end = hit ? 'hit' : s.pos.y < 0 ? 'floor' : now() - s.born > 1.6 / Math.max(.3, rules().speed ?? 1) ? 'timeout' : null; // y < 0: into the floor; slower balls live longer, so they still reach
      if (end) { fx.endShot(s.id, end); shots.splice(i, 1); }
    }
  }
  function showAct(p, text) { p.act = { text, at: now() }; }

  // ---- moves ----
  function startCharge(p) {
    if (!canAct() || p.charging) return;
    Object.assign(p, { charging: true, chargeSeen: now(), charge: 0, chargeT: 0, tier: 's', chargeFrom: p.chest.clone(), autoRelease: null });
    showAct(p, '溜め'); log(p.slot, 'charge', '溜め開始');
  }
  /** Swing while charging: the tier comes from how long it was held. */
  function release(p) {
    if (!p.charging) return;
    const tier = tierOf(p.chargeT);
    p.charging = false; p.lastShot = -9; shoot(p, tier);
    p.charge = 0; p.chargeT = 0; p.tier = null; p.autoRelease = null;
  }
  function attack(p) { if (p.charging) release(p); else shoot(p, 's'); }
  function failCharge(p, why) {
    if (!p.charging) return;
    p.charging = false; p.charge = 0; p.chargeT = 0; p.tier = null; p.autoRelease = null; p.fails++;
    fx.hit(p.element, p.tip.clone(), .1); showAct(p, '溜め失敗'); log(p.slot, 'charge', `溜め失敗（${why}）`);
  }
  /** A detector event from actions.js ({ slot, name, dir, power, speed }). Dodge is not part of the game; Guard comes from
   *  the stick pose every frame (stepGuard: the detector's 1 s hold is too slow for a block). */
  function onSensed(ev) {
    const p = players[ev.slot]; if (!p || !canAct()) return;
    if (ev.name === 'Charge') { // only while the stick is not below horizontal (its IMU elevation; exactly level only happens in scripted tests);
      // circling it lower neither starts nor keeps a charge
      if (p.dir.y < 0) { if (now() - (p.lowLogged ?? -9) > 1) { p.lowLogged = now(); log(p.slot, 'charge', '棒が水平より下なので溜めない'); } return; }
      p.chargeSeen = now(); startCharge(p);
    }
    else if (ev.name === 'Swing') { p.swingAt = now(); if (inFront(p)) attack(p); else log(p.slot, 'shot', '背中側で止めたので撃たない'); }
  }
  /** A swing only fires when the stick stops in front of the body: tip ahead of the chest along the body's facing
   *  (horizontal). A stick that comes to rest behind the back (wind-up, putting it down) is not a shot. */
  function inFront(p) {
    const f = W.app3(p.body.R, [1, 0, 0]);
    return (p.tip.x - p.chest.x) * f[0] + (p.tip.z - p.chest.z) * f[2] > 0;
  }
  function stepCharge(dt) {
    const R = rules();
    for (const p of Object.values(players)) if (p.charging) {
      // feet must stay put: the chest may sway, but more than moveFail m (horizontal) from where the charge began drops it
      const moved = p.chargeFrom ? Math.hypot(p.chest.x - p.chargeFrom.x, p.chest.z - p.chargeFrom.z) : 0;
      if (moved > R.moveFail) { failCharge(p, `${Math.round(moved * 100)} cm 動いた`); continue; }
      if (R.chargeHold > 0 && p.autoRelease == null && p.tier !== 'l' && now() - p.chargeSeen > R.chargeHold) { failCharge(p, '棒の動きが止まった'); continue; } // short pauses are fine; a long stop drops it (a full charge just waits for the swing)
      // the charge only grows while the stick is being circled (Charge events keep coming); once the circling stops it is held
      // as it is, for chargeHold s, waiting for the swing down that fires it (10/18: circle, stop, swing down = fire).
      // Without the stop rule (chargeHold 0) or for the 大 test button it grows with time as before.
      const live = R.chargeHold <= 0 || p.autoRelease != null || now() - p.chargeSeen < CHARGE_LIVE;
      if (live) p.chargeT += dt;
      p.charge = Math.min(1, p.chargeT / R.t2);
      const t = tierOf(p.chargeT);
      if (t !== p.tier) {
        p.tier = t;
        if (t !== 's') { showAct(p, `溜め ${TIER_JA[t]}`); log(p.slot, 'charge', `溜めが${TIER_JA[t]}になった`); }
        if (t === 'l') drone?.event('charge', { owner: p.slot, level: 1 });
      }
      if (p.autoRelease != null && p.chargeT >= p.autoRelease) release(p); // the 大 test button: charged long enough, swing
    }
  }

  // ---- match flow: setup -> countdown -> fight -> result ----
  function reset() {
    for (const p of Object.values(players)) Object.assign(p, { guarding: false, guardHist: [], hp: rules().hp ?? RULES.hp, hpMax: rules().hp ?? RULES.hp, charge: 0, chargeT: 0, charging: false, tier: null, autoRelease: null, act: null, lastShot: -9, shots: 0, hits: 0, specials: 0, fails: 0, dealt: 0 });
    for (const s of shots) fx.endShot(s.id); shots.length = 0; winner = null;
    for (const p of Object.values(players)) p.preview = null;
  }
  /** ph: 'setup' | 'fight' | 'demo' (デモ試合: a fight where every shot is aimed at the other player when fired) */
  function setPhase(ph) {
    if (ph === 'demo' || ph === 'fight') match.mode = ph === 'demo' ? 'demo' : 'normal';
    reset(); match.paused = false;
    if (ph === 'fight' || ph === 'demo') { match.phase = 'countdown'; match.until = now() + 3; match.left = match.sec; } else { match.phase = ph; match.left = match.sec; }
    log(null, 'phase', { setup: '準備中にした', fight: '試合開始（3 秒前）', demo: 'デモ試合開始（3 秒前・魔法は撃った瞬間に相手を狙う）' }[ph] ?? ph);
  }
  function finish(w) {
    winner = w; match.phase = 'result';
    for (const p of Object.values(players)) { p.charging = false; p.tier = null; }
    log(w?.slot ?? null, 'win', w ? `${w.slot} の勝ち` : '引き分け');
  }
  function stepMatch(dt) {
    // a new HP setting shows at once while setting up; during a match it waits for the next one (reset)
    if (match.phase === 'setup') for (const p of Object.values(players)) if (p.hpMax !== (rules().hp ?? RULES.hp)) p.hp = p.hpMax = rules().hp ?? RULES.hp;
    if (match.phase === 'countdown' && now() >= match.until) { match.phase = 'fight'; match.left = match.sec; match.fightAt = now(); }
    if (match.phase !== 'fight' || match.paused) return;
    match.left = Math.max(0, match.left - dt);
    const { A, B } = players;
    if (match.left === 0) finish(A.hp === B.hp ? null : A.hp > B.hp ? A : B); // time up: more HP wins, equal is a draw
  }

  function command(c) {
    const p = players[c.slot];
    switch (c.cmd) {
      case 'phase': return setPhase(c.phase);
      case 'pause': if (match.phase === 'fight') { match.paused = !match.paused; log(null, 'phase', match.paused ? '一時停止' : '再開'); } return;
      case 'reset': return setPhase(match.phase === 'result' || match.phase === 'countdown' || match.phase === 'fight' ? (match.mode === 'demo' ? 'demo' : 'fight') : match.phase); // again from the top, same mode
      case 'matchSec': match.sec = Math.max(10, +c.value || 60); if (match.phase !== 'fight') match.left = match.sec; return;
      case 'shoot': if (p) shoot(p, c.tier ?? 's'); return;
      case 'special': // test button: really charge (小 → 中 → 大, moving still fails it), then swing just past the 大 line
        if (!p || !canAct()) return;
        startCharge(p); p.autoRelease = rules().t2 + .3; return;
      case 'guard': if (p) p.guardBtn = !!c.on; return; // test button: guard while held
      case 'charge': if (!p) return;
        if (c.on) startCharge(p); else release(p);
        return;
      // ---- effect try-out (any phase, no damage, no rules): fxShot fires one tier straight at the other player,
      // fxCharge on / off shows the charge as it grows (and fires the tier it reached when turned off with fire: true)
      case 'fxShot': if (p) fxShot(p, c.tier ?? 's'); return;
      case 'fxCharge': if (!p) return;
        if (c.on) p.preview = now();
        else if (p.preview) { const t = now() - p.preview; p.preview = null; if (c.fire) fxShot(p, tierOf(t)); }
        return;
    }
  }

  function step(dt, raw, est, { sensorOnly = false } = {}) {
    stepMatch(raw);
    for (const p of Object.values(players)) {
      place(p, est, sensorOnly); effects(p);
      p.trail.push({ t: now(), p: p.tip.clone().sub(p.chest) }); while (p.trail.length && p.trail[0].t < now() - .5) p.trail.shift(); // for motionAim
    }
    stepCharge(dt); stepGuard(); stepShots(dt);
    const s = sfx();
    if (s) {
      for (const p of Object.values(players)) s.charge(p.slot, p.charging && canAct(), p.charge, panOf(p.tip), p.tier ?? 's');
      s.bgm(['countdown', 'fight'].includes(match.phase) && !match.paused);
    }
  }

  return {
    players, match, shots, events, canAct, step, onSensed, command, tierOf,
    get winner() { return winner; },
    /** Raw packet hook: IMU kept for the stick fallback, simulator truth, calibration. */
    ingest(k) {
      const p = players[k.slot]; if (!p) return;
      if (k.type === 'imu') p.imu = k;
      else if (k.type === 'truth') p.truth = k;
      else if (k.type === 'calib') { p.imu = null; p.calibAt = performance.now(); } // the avatar re-reads its standing height too
    },
    setOnline(list) { for (const p of Object.values(players)) p.online = list.some(q => q.slot === p.slot); },
    bannerText() {
      const t = now();
      if (match.paused) return '一時停止';
      if (match.phase === 'countdown') return String(Math.ceil(match.until - t));
      if (match.phase === 'fight' && t - match.fightAt < .9) return 'FIGHT!';
      if (match.phase === 'result') return winner ? `${winner.slot} の勝ち！` : '引き分け';
      return '';
    },
    actText(p) { return p.act && now() - p.act.at < 1 ? p.act.text : ''; },
  };
}
