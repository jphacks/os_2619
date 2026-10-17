// Game state and rules, shared by the game screen (3D arena) and the final render (camera picture): one match, two views.
// Ported from kawashima/app.js. Players are placed from phonealign.js (chest phones), the pose tracker on phone C's picture,
// or the start marks; the sword (stick) tip is base + IMU direction × stick length. Moves come from the sensing team's
// detectors (actions.js: Charge / Swing) and from the keys / buttons. Rules (GAME_DESIGN.md, 10/17):
//   Swing without charging → 小 (weak, can be repeated every `rapid` s)
//   Charge (circle the stick) → charging; Swing releases it: under t1 s 小, t1..t2 s 中, t2 s and more 大 (special move)
//   moving the chest more than `moveFail` m while charging drops the charge
//   every tier is a projectile along the aim: dodging is just moving out of its way (no guard, no invulnerable dodge)
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
export const RULES = { t1: 2, t2: 5, dmg: { s: 5, m: 20, l: 60 }, rapid: .25, moveFail: .5 };
// how each tier looks and flies (provisional effects: size tells the tiers apart)
const TIER = {
  s: { power: .15, big: .7, speed: 11, radius: .12, hit: .25 },
  m: { power: .6, big: 1.5, speed: 8, radius: .28, hit: .65 },
  l: { power: 1, big: 2.8, speed: 6.5, radius: .5, hit: 1 },
};
export const POS_JA = { auto: '自動', phones: '胸スマホ', camera: 'カメラ映像', start: '立ち位置' };

/**
 * createGame({ fx, drone, sfx: () => audio | null, cfg, onFlash, clock? }) → { players, match, shots, events, step, onSensed, command, canAct, ... }
 * cfg (live object): posSrc 'auto'|'phones'|'camera'|'start', hand 'R'|'L', aim 'stick'|'eye', stickLen { A, B }, test (no HP loss),
 * rules (RULES: tier seconds, damage, rapid-fire interval, how far you may move while charging).
 */
export function createGame({ fx, drone, sfx = () => null, cfg, onFlash = () => {}, clock = null }) {
  const now = clock ?? (() => performance.now() / 1000); // test-game.mjs drives a fake clock
  const events = []; // newest first: { at: Date.now(), slot, kind, text }
  const log = (slot, kind, text) => { events.unshift({ at: Date.now(), slot, kind, text }); if (events.length > 200) events.pop(); };
  const panOf = v => { // world x across the field -> stereo pan -1..1 (the camera looks along -z, so +x is screen right)
    const xs = W.FIELD.poly.map(q => q[0]), a = Math.min(...xs), b = Math.max(...xs);
    return Math.max(-1, Math.min(1, ((v.x - a) / ((b - a) || 1)) * 2 - 1));
  };

  function makePlayer(slot) {
    return { slot, element: ELEMENT[slot], hp: 100, online: false, imu: null, truth: null, charge: 0, chargeT: 0, charging: false, chargeFrom: null, tier: null, act: null,
      body: W.bodyPose(W.START[slot].pos, W.START[slot].yaw), chest: V(), base: V(), tip: V(), dir: V(1, 0, 0), lastShot: -9, src: 'start', stickSrc: '-',
      shots: 0, hits: 0, specials: 0, fails: 0, dealt: 0 };
  }
  const players = { A: makePlayer('A'), B: makePlayer('B') };
  const other = p => p === players.A ? players.B : players.A;
  const shots = [];
  const match = { phase: 'setup', ready: false, paused: false, sec: 60, left: 60, until: 0, fightAt: -9 };
  let winner = null;
  const canAct = () => !match.paused && match.phase === 'fight';
  const rules = () => cfg.rules ?? RULES;
  const tierOf = t => t < rules().t1 ? 's' : t < rules().t2 ? 'm' : 'l';
  const IMU_SIDE = cross(W.STICK.axis, W.STICK.up);

  function place(p, est, tracker) {
    const g = est?.slots?.[p.slot] ?? {}, st = W.START[p.slot], T = p.truth;
    const pt = tracker?.get(p.slot);
    const phoneOk = g.chest && (g.aligned || g.src === 'localize');
    const camOk = pt?.seen && pt.foot;
    const src = cfg.useTruth && T ? 'truth' : cfg.posSrc === 'auto' ? (phoneOk ? 'phones' : camOk ? 'camera' : 'hold') : cfg.posSrc;
    if (src === 'truth') p.body = W.bodyPose(T.chest, T.yaw, T.chest[1]);
    else if (src === 'phones' && phoneOk) p.body = W.bodyPose(g.chest, g.yaw ?? st.yaw, g.chest[1]);
    else if (src === 'camera' && camOk) p.body = W.bodyPose(pt.foot, pt.yaw ?? st.yaw, pt.chest?.[1] ?? W.CHEST_H);
    else if (src === 'start' || !p.body) p.body = W.bodyPose(st.pos, st.yaw);
    p.src = src === 'hold' ? (p.src === 'start' ? 'start' : 'hold') : src;
    p.chest.copy(v3(p.body.t));
    // hand in the body frame (x fwd, y up, z right); the camera sees the wrist: use it
    const h = W.STICK.hand, wrist = pt?.seen && pt.wrist?.[cfg.hand];
    p.base.copy(v3(wrist ?? W.apply(p.body, [h.fwd, h.up, h.right])));
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
    if (match.phase !== 'setup' && (p.online || p.imu)) { // no effects while setting up
      fx.aura(p.element, p.base, p.tip, p.charging ? .6 + .4 * p.charge : .5);
      if (p.charging) fx.charge(p.element, p.tip, p.charge);
      s?.aura(p.slot, p.element, match.paused ? 0 : p.charging ? .6 + .4 * p.charge : .4, panOf(p.chest));
    } else s?.aura(p.slot, p.element, 0, 0);
  }

  /** Fires one projectile of tier 's' | 'm' | 'l' along the aim. 小 is limited to one every rules().rapid s. */
  function shoot(p, tier = 's') {
    if (!canAct()) return false;
    if (tier === 's' && now() - p.lastShot < rules().rapid) return false;
    p.lastShot = now();
    const T = TIER[tier], s = sfx();
    const aim = cfg.aim === 'eye' ? p.tip.clone().sub(p.chest.clone().add(V(0, .35, 0))).normalize() : p.dir.clone();
    p.shots++; if (tier === 'l') p.specials++;
    showAct(p, tier === 'l' ? '大！' : TIER_JA[tier]);
    if (tier === 'l') { s?.special(p.element, panOf(p.tip)); drone?.event('special', { owner: p.slot, from: p.tip.clone(), to: p.tip.clone().addScaledVector(aim, 6) }); }
    else { s?.shot(p.element, panOf(p.tip), T.power); drone?.event('shot', { owner: p.slot, pos: p.tip.clone(), dir: aim.clone() }); }
    shots.push({ id: fx.shot(p.element, p.tip.clone(), aim.clone(), T.power, T.big), owner: p, element: p.element, tier, pos: p.tip.clone(), vel: aim.multiplyScalar(T.speed), born: now() });
    log(p.slot, tier === 'l' ? 'special' : 'shot', `${TIER_JA[tier]}の攻撃${tier === 's' ? '' : `（溜め ${p.chargeT.toFixed(1)} 秒）`}`);
    return true;
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
      s.pos.addScaledVector(s.vel, dt);
      fx.moveShot(s.id, s.pos);
      // hit: distance to the opponent's vertical body segment (capsule radius .3 + the shot's own radius)
      const a = foe.chest.clone().setY(foe.chest.y - 1.05), b = foe.chest.clone().setY(foe.chest.y + .15);
      const hit = match.phase === 'fight' && new THREE.Line3(a, b).closestPointToPoint(s.pos, true, V()).distanceTo(s.pos) < .3 + T.radius;
      if (hit) {
        fx.hit(s.owner.element, s.pos.clone(), T.hit); sfx()?.hit(s.owner.element, panOf(s.pos), T.hit);
        drone?.event('hit', { target: foe.slot, pos: s.pos.clone(), power: T.hit });
        damage(foe, s.owner, s.tier);
      }
      if (hit || now() - s.born > 1.6) { fx.endShot(s.id); shots.splice(i, 1); }
    }
  }
  function showAct(p, text) { p.act = { text, at: now() }; }

  // ---- moves ----
  function startCharge(p) {
    if (!canAct() || p.charging) return;
    Object.assign(p, { charging: true, charge: 0, chargeT: 0, tier: 's', chargeFrom: p.chest.clone(), autoRelease: null });
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
  /** A detector event from actions.js ({ slot, name, dir, power, speed }). Guard / Dodge are not part of the game. */
  function onSensed(ev) {
    const p = players[ev.slot]; if (!p || !canAct()) return;
    if (ev.name === 'Charge') startCharge(p);
    else if (ev.name === 'Swing') attack(p);
  }
  function stepCharge(dt) {
    const R = rules();
    for (const p of Object.values(players)) if (p.charging) {
      // feet must stay put: the chest may sway, but more than moveFail m (horizontal) from where the charge began drops it
      const moved = p.chargeFrom ? Math.hypot(p.chest.x - p.chargeFrom.x, p.chest.z - p.chargeFrom.z) : 0;
      if (moved > R.moveFail) { failCharge(p, `${Math.round(moved * 100)} cm 動いた`); continue; }
      p.chargeT += dt;
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
    for (const p of Object.values(players)) Object.assign(p, { hp: 100, charge: 0, chargeT: 0, charging: false, tier: null, autoRelease: null, act: null, lastShot: -9, shots: 0, hits: 0, specials: 0, fails: 0, dealt: 0 });
    for (const s of shots) fx.endShot(s.id); shots.length = 0; winner = null;
  }
  function setPhase(ph) {
    if (ph === 'demo') ph = 'setup'; // the demo is gone (10/17)
    reset(); match.paused = false;
    if (ph === 'fight') { match.phase = 'countdown'; match.until = now() + 3; match.left = match.sec; } else { match.phase = ph; match.left = match.sec; }
    log(null, 'phase', { setup: '準備中にした', fight: '試合開始（3 秒前）' }[ph] ?? ph);
  }
  function finish(w) {
    winner = w; match.phase = 'result';
    for (const p of Object.values(players)) { p.charging = false; p.tier = null; }
    log(w?.slot ?? null, 'win', w ? `${w.slot} の勝ち` : '引き分け');
  }
  function stepMatch(dt) {
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
      case 'reset': return setPhase(match.phase === 'result' || match.phase === 'countdown' ? 'fight' : match.phase); // again from the top
      case 'matchSec': match.sec = Math.max(10, +c.value || 60); if (match.phase !== 'fight') match.left = match.sec; return;
      case 'shoot': if (p) shoot(p, c.tier ?? 's'); return;
      case 'special': // test button: really charge (小 → 中 → 大, moving still fails it), then swing just past the 大 line
        if (!p || !canAct()) return;
        startCharge(p); p.autoRelease = rules().t2 + .3; return;
      case 'charge': if (!p) return;
        if (c.on) startCharge(p); else release(p);
        return;
    }
  }

  function step(dt, raw, est, tracker) {
    stepMatch(raw);
    for (const p of Object.values(players)) { place(p, est, tracker); effects(p); }
    stepCharge(dt); stepShots(dt);
    const s = sfx();
    if (s) {
      for (const p of Object.values(players)) s.charge(p.slot, p.charging && canAct(), p.charge, panOf(p.tip));
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
      else if (k.type === 'calib') p.imu = null;
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
