// Game state and rules, shared by the game screen (3D arena) and the final render (camera picture): one match, two views.
// Ported from kawashima/app.js. Players are placed from phonealign.js (chest phones), the pose tracker on phone C's picture,
// or the start marks; the sword (stick) tip is base + IMU direction × stick length. Moves come from the sensing team's
// detectors (actions.js: Charge / Swing / Dodge / Guard) and from the keys / buttons.
//   Charge → charging starts (full in 1.5 s)   Swing → a shot with the charge so far (full = special move)
//   Dodge  → shots pass through for 0.5 s       Guard → shield in front of the chest, 30 % of the damage (60 % of a special)
// Hits are 3D: shot sphere vs the opponent's vertical body segment. Effects go to effects.js (fx), sound to audio.js (sfx).
import * as THREE from 'three';
import * as W from './world.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v3 = a => V(a[0], a[1], a[2]);
const now = () => performance.now() / 1000;
const rotQ = ([w, x, y, z], [a, b, c]) => { // rotate v by quaternion [w, x, y, z]
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const BODY_DIR = { forward: [1, 0, 0], back: [-1, 0, 0], right: [0, 0, 1], left: [0, 0, -1] }; // body frame: x fwd, y up, z right
export const ELEMENT = { A: 'fire', B: 'thunder' };
export const ELEMENT_JA = { fire: '炎', thunder: '雷' };
export const PHASE_JA = { setup: '準備中', demo: 'デモ', countdown: 'カウントダウン', fight: '試合中', result: '試合終了' };
export const POS_JA = { auto: '自動', phones: '胸スマホ', camera: 'カメラ映像', start: '立ち位置' };

/**
 * createGame({ fx, drone, sfx: () => audio | null, cfg, onFlash }) → { players, match, shots, events, step, onSensed, command, canAct, ... }
 * cfg (live object): posSrc 'auto'|'phones'|'camera'|'start', hand 'R'|'L', aim 'stick'|'eye', stickLen { A, B }, test (no HP loss).
 */
export function createGame({ fx, drone, sfx = () => null, cfg, onFlash = () => {} }) {
  const events = []; // newest first: { at: Date.now(), slot, kind, text }
  const log = (slot, kind, text) => { events.unshift({ at: Date.now(), slot, kind, text }); if (events.length > 200) events.pop(); };
  const panOf = v => { // world x across the field -> stereo pan -1..1 (the camera looks along -z, so +x is screen right)
    const xs = W.FIELD.poly.map(q => q[0]), a = Math.min(...xs), b = Math.max(...xs);
    return Math.max(-1, Math.min(1, ((v.x - a) / ((b - a) || 1)) * 2 - 1));
  };

  function makePlayer(slot) {
    return { slot, element: ELEMENT[slot], hp: 100, online: false, imu: null, truth: null, charge: 0, charging: false, guard: false, dodgeLeft: 0, act: null,
      body: W.bodyPose(W.START[slot].pos, W.START[slot].yaw), chest: V(), base: V(), tip: V(), dir: V(1, 0, 0), lastShot: 0, src: 'start', stickSrc: '-',
      shots: 0, hits: 0, blocks: 0, dodges: 0, specials: 0 };
  }
  const players = { A: makePlayer('A'), B: makePlayer('B') };
  const other = p => p === players.A ? players.B : players.A;
  const shots = [];
  const match = { phase: 'setup', ready: false, paused: false, sec: 90, left: 90, until: 0, fightAt: -9 };
  let winner = null;
  const canAct = () => !match.paused && (match.phase === 'demo' || match.phase === 'fight');
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
    if (match.phase !== 'setup' && (p.online || p.imu || match.phase === 'demo')) { // no effects while setting up
      fx.aura(p.element, p.base, p.tip, p.charging ? .6 + .4 * p.charge : .5);
      if (p.charging) fx.charge(p.element, p.tip, p.charge);
      if (p.guard && Math.abs(p.dir.y) > Math.sin(30 * Math.PI / 180) && p.imu) { p.guard = false; log(p.slot, 'guard', 'ガード解除（棒が傾いた）'); }
      if (p.guard && canAct()) fx.guard(p.element, shieldAt(p), 1, 'guard' + p.slot);
      s?.aura(p.slot, p.element, match.paused ? 0 : p.charging ? .6 + .4 * p.charge : .4, panOf(p.chest));
    } else s?.aura(p.slot, p.element, 0, 0);
  }

  function shoot(p, power = .5) {
    if (!canAct() || now() - p.lastShot < .6) return;
    p.lastShot = now();
    const foe = other(p), s = sfx();
    p.shots++;
    if (power >= 1) { // full charge: special move straight at the opponent
      fx.special(p.element, p.tip.clone(), foe.chest.clone()); s?.special(p.element, panOf(p.tip));
      drone?.event('special', { owner: p.slot, from: p.tip.clone(), to: foe.chest.clone() });
      p.specials++; showAct(p, '必殺技'); log(p.slot, 'special', `必殺技（${ELEMENT_JA[p.element]}）`);
      if (dodging(foe)) { log(foe.slot, 'dodge', '必殺技を回避'); return; }
      return damage(foe, p, 35, true);
    }
    const aim = match.phase === 'demo' ? foe.chest.clone().sub(p.tip).normalize()
      : cfg.aim === 'eye' ? p.tip.clone().sub(p.chest.clone().add(V(0, .35, 0))).normalize() : p.dir.clone();
    drone?.event('shot', { owner: p.slot, pos: p.tip.clone(), dir: aim.clone() }); s?.shot(p.element, panOf(p.tip), power);
    shots.push({ id: fx.shot(p.element, p.tip.clone(), aim.clone(), power), owner: p, element: p.element, pos: p.tip.clone(), vel: aim.multiplyScalar(9), power, born: now() });
    log(p.slot, 'shot', `発射 威力 ${Math.round(power * 100)}%`);
  }
  const shieldAt = p => p.chest.clone().add(v3(W.app3(p.body.R, [.45, -.1, 0]))); // body frame: x forward
  const dodging = p => p.dodgeLeft > 0; // game time (frame dt), like the shots it has to outlast
  function damage(foe, from, n, special = false) {
    if (foe.guard) { // the shield takes most of it: 30% gets through, 60% of a special
      n = Math.round(n * (special ? .6 : .3));
      fx.block(foe.element, shieldAt(foe)); sfx()?.hit(foe.element, panOf(foe.chest), .2); showAct(foe, 'ブロック');
      foe.blocks++; log(foe.slot, 'block', `ガードで防いだ（${n} ダメージ）`);
    } else { from.hits++; log(from.slot, 'hit', `${foe.slot} に命中 ${n} ダメージ`); }
    onFlash(from.element);
    if (match.phase !== 'fight' || cfg.test) return; // setting up / demo / test: hits show but HP never drops
    foe.hp = Math.max(0, foe.hp - n);
    if (foe.hp === 0) finish(from);
  }
  function stepShots(dt) {
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i], foe = other(s.owner);
      s.pos.addScaledVector(s.vel, dt);
      fx.moveShot(s.id, s.pos);
      // hit: distance to the opponent's vertical body segment (capsule radius .3 + shot radius .15)
      const a = foe.chest.clone().setY(foe.chest.y - 1.05), b = foe.chest.clone().setY(foe.chest.y + .15);
      const hit = !dodging(foe) && new THREE.Line3(a, b).closestPointToPoint(s.pos, true, V()).distanceTo(s.pos) < .45; // dodging: shots pass through
      if (hit) {
        fx.hit(s.owner.element, s.pos.clone(), s.power); sfx()?.hit(s.owner.element, panOf(s.pos), s.power);
        drone?.event('hit', { target: foe.slot, pos: s.pos.clone(), power: s.power });
        damage(foe, s.owner, Math.round(10 + 20 * s.power));
      }
      if (hit || now() - s.born > 1.5) { fx.endShot(s.id); shots.splice(i, 1); }
    }
  }
  function showAct(p, text) { p.act = { text, at: now() }; }

  // ---- moves ----
  function startCharge(p) { if (!canAct() || p.charging) return; p.charging = true; p.charge = 0; p.guard = false; log(p.slot, 'charge', '溜め開始'); }
  function release(p, special = false) { const c = p.charging ? p.charge : .5; p.charging = false; p.lastShot = 0; shoot(p, special ? 1 : c); p.charge = 0; }
  function attack(p, power = .5) { if (p.charging) release(p); else shoot(p, Math.min(1, power)); }
  function cancel(p) { if (p.charging) log(p.slot, 'charge', '溜めを取り消し'); p.charging = false; p.charge = 0; }
  function setGuard(p, on) {
    if (on && !canAct()) return;
    if (p.guard !== on) log(p.slot, 'guard', on ? 'ガード' : 'ガード解除');
    p.guard = on; if (on) { cancel(p); showAct(p, 'ガード'); }
  }
  function dodge(p, dir = 'left') {
    if (!canAct()) return;
    p.dodgeLeft = .5; p.guard = false; p.dodges++; showAct(p, '回避');
    fx.dodge(p.element, p.chest.clone().setY(p.chest.y - .3), v3(W.app3(p.body.R, BODY_DIR[dir] ?? BODY_DIR.left)));
    sfx()?.shot(p.element, panOf(p.chest), .1);
    log(p.slot, 'dodge', `回避（${{ left: '左', right: '右', back: '後ろ', forward: '前' }[dir] ?? dir}）`);
  }
  /** A detector event from actions.js ({ slot, name, dir, power, speed }). */
  function onSensed(ev) {
    const p = players[ev.slot]; if (!p || !canAct()) return;
    if (ev.name === 'Charge') { showAct(p, '溜め'); startCharge(p); }
    else if (ev.name === 'Swing') { p.guard = false; showAct(p, '振り'); attack(p, Math.min(.9, .3 + .6 * (ev.power ?? .5))); }
    else if (ev.name === 'Guard') setGuard(p, true);
    else if (ev.name === 'Dodge') dodge(p, ev.dir);
  }
  function stepCharge(dt) {
    for (const p of Object.values(players)) if (p.charging) {
      const was = p.charge < 1;
      p.charge = Math.min(1, p.charge + dt / 1.5);
      if (was && p.charge === 1) { drone?.event('charge', { owner: p.slot, level: 1 }); log(p.slot, 'charge', '溜め最大：振ると必殺技'); }
    }
  }

  // ---- match flow: setup -> demo / countdown -> fight -> result ----
  function reset() {
    for (const p of Object.values(players)) Object.assign(p, { hp: 100, charge: 0, charging: false, guard: false, dodgeLeft: 0, act: null, shots: 0, hits: 0, blocks: 0, dodges: 0, specials: 0 });
    for (const s of shots) fx.endShot(s.id); shots.length = 0; winner = null;
  }
  function setPhase(ph) {
    reset(); match.paused = false;
    if (ph === 'fight') { match.phase = 'countdown'; match.until = now() + 3; } else match.phase = ph;
    log(null, 'phase', { setup: '準備中にした', demo: 'デモ開始', fight: '試合開始（3 秒前）' }[ph] ?? ph);
  }
  function finish(w) {
    winner = w; match.phase = 'result';
    for (const p of Object.values(players)) { p.charging = false; p.guard = false; }
    log(w?.slot ?? null, 'win', w ? `${w.slot} の勝ち` : '引き分け');
  }
  function stepMatch(dt) {
    if (match.phase === 'countdown' && now() >= match.until) { match.phase = 'fight'; match.left = match.sec; match.fightAt = now(); }
    if (match.phase !== 'fight' || match.paused) return;
    match.left = Math.max(0, match.left - dt);
    const { A, B } = players;
    if (match.left === 0) finish(A.hp === B.hp ? null : A.hp > B.hp ? A : B); // time up: more HP wins, equal is a draw
  }
  setInterval(() => { // demo: both fire on their own, B guards or dodges now and then
    if (match.phase !== 'demo' || match.paused) return;
    shoot(players.A, Math.random() * .9); setTimeout(() => shoot(players.B, Math.random() * .9), 400);
    const r = Math.random(), B = players.B;
    if (r < .25) setGuard(B, !B.guard); else if (r < .4) setTimeout(() => dodge(B, Math.random() < .5 ? 'left' : 'right'), 150);
    else if (r < .47) { startCharge(players.A); setTimeout(() => players.A.charging && release(players.A), 1700); }
  }, 800);

  function command(c) {
    const p = players[c.slot];
    switch (c.cmd) {
      case 'phase': return setPhase(c.phase);
      case 'pause': if (match.phase === 'fight' || match.phase === 'demo') { match.paused = !match.paused; log(null, 'phase', match.paused ? '一時停止' : '再開'); } return;
      case 'reset': return setPhase(match.phase === 'result' || match.phase === 'countdown' ? 'fight' : match.phase); // again from the top
      case 'matchSec': match.sec = Math.max(10, +c.value || 90); if (match.phase !== 'fight') match.left = match.sec; return;
      case 'shoot': if (p) shoot(p, c.power ?? .5); return;
      case 'special': if (p && canAct()) { p.lastShot = 0; shoot(p, 1); } return;
      case 'dodge': if (p) dodge(p, c.dir); return;
      case 'guard': if (p) setGuard(p, !p.guard); return;
      case 'charge': if (!p) return;
        if (c.on) startCharge(p); else if (p.charging) release(p);
        return;
    }
  }

  function step(dt, raw, est, tracker) {
    stepMatch(raw);
    for (const p of Object.values(players)) { place(p, est, tracker); effects(p); p.dodgeLeft = Math.max(0, p.dodgeLeft - dt); }
    stepCharge(dt); stepShots(dt);
    const s = sfx();
    if (s) {
      for (const p of Object.values(players)) s.charge(p.slot, p.charging && canAct(), p.charge, panOf(p.tip));
      s.bgm(['demo', 'countdown', 'fight'].includes(match.phase) && !match.paused);
    }
  }

  return {
    players, match, shots, events, canAct, step, onSensed, command, dodging,
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
    actText(p) { return p.guard ? 'ガード' : p.act && now() - p.act.at < 1 ? p.act.text : ''; },
  };
}
