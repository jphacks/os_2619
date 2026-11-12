// Full Stick ダッシュボード: one page, four screens, one match.
//   1 接続     phones A / B (SensorLink app over /ws) and phone C (cam.html over /cam), everything they send
//   2 3D空間   phones, swords and AprilTags in the field world (phonealign.js), dark and raw
//   3 ゲーム   the match in the stylised 3D arena: magic attacks (小・中・大), charge meters, HP, timer (game.js + stage.js)
//   4 最終映像 the untouched camera picture plus effects projected from sensor-world coordinates (camera pose/FOV from the tag scan)
// Data: hub.js → phonealign.js (positions), map.js (the sensing team's estimate, for comparison), actions.js (moves) → game.js.
import * as W from './world.js';
import { createHub } from './hub.js';
import { createPhoneAlign } from './phonealign.js';
import { createMap } from './map.js';
import { createActions } from './actions.js';
import { createVideoSource } from './video.js';
import { createStage, DRONE_JA } from './stage.js';
import { POSE, CHARAS } from './field3d.js';
import { mountSticks } from './sticks.js';
import { createGame, PHASE_JA, POS_JA, ELEMENT_JA, RULES, TIER_JA, speedRule } from './game.js';
import { createSmashStyle } from './fx-smash.js';
import { createSpace } from './space3d.js';
import { createConnect } from './connect.js';
import { createFinalControls } from './final-controls.js';
import { createVision } from './vision.js';
import { createVisionFx } from './visionfx.js';
import { personTo3D } from './avatarpose.js';
import { createPlayable } from './playable.js';
import { createTutorial } from './tutorial.js';
import { createGauge } from './hudgauge.js';
import { PRESETS, DEFAULT_HOUR, clock } from './sky.js';
import { createKoShow } from './ko-show.js';
import { createSwingSense, SWING_DEFAULT, SWING_GAIN, ATTACK_SPEED } from './swing-sense.js';
const TOD_SPEEDS = [['ゆっくり', 2], ['ふつう', 6], ['はやい', 24]]; // hours per minute: ふつう = a 60 s match from sunset into the night

const $ = s => document.querySelector(s);
const nowS = () => Date.now() / 1000;
const esc = v => String(v).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

// ---- settings (localStorage) ----
const DEFAULTS = {
  posSrc: 'auto', hand: 'R', aim: 'motion', stickLen: { A: W.STICK.len, B: W.STICK.len },
  minimap: true, debug: false, pip: false, mirrorX: false, mirrorY: false, swordFlip: false, fovC: 40, viewVer: 2, fpv: null, drone: 'fixed', videoSrc: 'remote', tagMode: 4, tagMount: 'floor', tagHeight: 1.0, knownFov: null,
  matchSec: 60, test: false, useTruth: false, screen: 'connect', rules: RULES, rulesVer: 8, fxStyle: 'smash', backdrop: 'court', timeOfDay: DEFAULT_HOUR,
  zoom: { fixed: 1, auto: 1, orbit: 1, chaseA: 1, chaseB: 1, top: 1, side: 1 }, // game screen: zoom per camera mode (free: the mouse wheel)
  chara: { A: 'wizard', B: 'wizard' }, // who each player is drawn as (field3d.js CHARAS): the wizard, or the special character チャオベン
  mimic: true, // the avatars copy the poses MediaPipe finds in phone C's picture (screen 3, and the small 3D window of screen 4)
  swing: SWING_DEFAULT, // the sword swing heard on the player's phone (swing-sense.js): on, and the 小 / 中 / 大 lines in °/s
  crt: true, // screens 3 and 4 look like an old CRT screen: fewer lines, scanlines, a little bleed and glow (stage.js), 30 fps
};
const saved = (() => { try { return JSON.parse(localStorage.getItem('pd-cfg')) ?? {}; } catch { return {}; } })();
const cfg = { ...DEFAULTS, ...saved, swing: { ...SWING_DEFAULT, ...saved.swing }, stickLen: { ...DEFAULTS.stickLen, ...saved.stickLen }, zoom: { ...DEFAULTS.zoom, ...saved.zoom }, chara: { ...DEFAULTS.chara, ...saved.chara } };
if ((saved.viewVer ?? 0) < 2) { cfg.mirrorX = cfg.mirrorY = cfg.swordFlip = false; cfg.viewVer = 2; } // the left-right / up-down guesses are off until a measured need: the alignment is solved from the tags now
cfg.visOn = false; // picture recognition (MediaPipe) is off at every start: nothing is loaded or run until it is switched on in the final bar
if ((saved.rulesVer ?? 0) < 1) cfg.matchSec = 60; // the 10/17 rules: 60 s matches
for (const s of ['A', 'B']) if (cfg.stickLen[s] === .8) cfg.stickLen[s] = W.STICK.len; // the old default, saved before the real 1.0 m stick was measured
if ((saved.rulesVer ?? 0) < 2) cfg.aim = 'motion'; // ...and the aim from the tip's motion
if ((saved.rulesVer ?? 0) < 4) cfg.fxStyle = 'smash'; // the program-drawn set is the one used in the show (10/18)
if ((saved.rulesVer ?? 0) < 5) cfg.drone = 'fixed'; // the game screen starts on phone C's view, the same as screen 4 (10/18)
if ((saved.rulesVer ?? 0) < 6) cfg.backdrop = 'court'; // the game screen stands in the school courtyard (11/3)
cfg.rulesVer = 8;
cfg.rules = { ...RULES, ...saved.rules, dmg: { ...RULES.dmg, ...saved.rules?.dmg }, size: { ...RULES.size, ...saved.rules?.size }, speed: speedRule(saved.rules?.speed ?? RULES.speed) };
if ((saved.rulesVer ?? 0) < 8) { cfg.rules.t1 = RULES.t1; cfg.rules.t2 = RULES.t2; } // the charge takes half as long (11/4), then 2/3 of 1 / 3 s (11/12): a saved older time must not hide it
const save = () => { try { localStorage.setItem('pd-cfg', JSON.stringify(cfg)); } catch {} };
const axis = { A: W.STICK.axis, B: W.STICK.axis }; // the IMU's +Y points to the stick tip, on both sticks

// ---- data ----
const hub = createHub();
const PA = createPhoneAlign({ axis, headingSign: () => cfg.swordFlip ? -1 : 1 }); // the stick axis (IMU +Y): detectors and aim share it
const smap = createMap();
const detectors = createActions();
const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none'; document.body.append(video);
const vsrc = createVideoSource(video, { onChange: () => { stage?.resize(); } });

let sfx = null; // sound: loaded lazily so a failing module never stops the picture
import('./audio.js').then(M => { sfx = M.createAudio(); sfx.load(); try { const v = JSON.parse(localStorage.getItem('pd-vol')); if (v) for (const [k, x] of Object.entries(v)) sfx.setVolume(k, x); } catch {} }).catch(e => console.warn('audio', e));
/** A game sound that concerns these players (their guard, failed charge, a hit they took) plays on their phones as well: the
 *  same files cut / pitched / faded as here (audio.js describe), sent through the server ({ type: 'sfx' }).
 *  The phone plays at gain × PHONE_REF: the loudest sound (大's hit, MIX.special +3 dB) at full scale.
 *  The shooter's phone has its own sounds (11/12), apart from what the one hit hears: myShot = 小 fired (my_shot), myLaunch =
 *  中 / 大 fired (my_launch, 大 lower), landed = a 中 / 大 of theirs hit: the same as the one hit hears (the hit + damage). */
const PHONE_REF = Math.pow(10, -3 / 20), PHONE_FILE = { guardUp: 'guard', guardReflect: 'guard_reflect' };
const PHONE_OWN = { myShot: () => [{ file: 'my_shot', gain: .8, rate: 1 }], myLaunch: tier => [{ file: 'my_launch', gain: tier === 'l' ? 1 : .8, rate: tier === 'l' ? .8 : 1 }] };
function phoneSound(slots, kind, ...args) {
  if (!sfx || sfx.muted) return;
  if (PHONE_OWN[kind]) { for (const slot of new Set(slots)) hub.send?.({ type: 'sfx', slot, voices: PHONE_OWN[kind](...args) }); return; }
  const landed = kind === 'landed'; if (landed) kind = 'hit';
  const voices = kind === 'chargeFail' ? [] : sfx.describe(kind, ...args).map(v => ({ file: PHONE_FILE[v.name] ?? v.name, gain: Math.min(1, +(v.gain * PHONE_REF).toFixed(3)),
    rate: +v.rate.toFixed(3), offset: v.offset, dur: v.dur, rel: v.rel, fade: v.fade })).slice(0, landed ? 3 : 4);
  if (landed) voices.push({ file: 'damage', gain: 1, rate: 1 }); // the one hit hears it from HitSound (flash)
  if (kind !== 'chargeFail' && !voices.length) return;
  for (const slot of new Set(slots)) hub.send?.({ type: 'sfx', slot, ...(kind === 'chargeFail' ? { kind } : { voices }) });
}

// every fast turn of a stick plays a sword swing on that player's phone, louder for a bigger swing (swing-sense.js): the player hears that the
// system saw the movement. Sent straight from the stick's packets, in any phase.
const swingSense = createSwingSense(() => cfg.swing), SWING_RATE = { s: 1.1, m: 1, l: .92 }; // a bigger swing a little lower, as a heavier blade
const swingFx = { A: null, B: null }; // the last swing per player, for the meter
const sendSwing = (slot, tier) => hub.send?.({ type: 'sfx', slot, voices: [{ file: 'swing', gain: SWING_GAIN[tier], rate: SWING_RATE[tier], offset: 0, dur: 0, rel: .25, fade: null }] });
function swingSound(k) {
  const e = swingSense.ingest(k); if (!e) return;
  swingFx[e.slot] = { ...e, at: performance.now() };
  sendSwing(e.slot, e.tier);
}

// recognition on the final screen (vision.js) and its layers under the effects (visionfx.js); nothing runs unless it is switched on (cfg.visOn) and a layer is on
const VIS_KEYS = ['visDraw', 'visGhost', 'visSpot', 'visTrail'], EL_COLOR = { fire: '#ff7a1a', thunder: '#ffd23d', water: '#2f7dff', wind: '#d8f4f2' };
const vision = createVision({ getSource: () => video.__dummy?.canvas ?? video, stickLen: () => (cfg.stickLen.A + cfg.stickLen.B) / 2, getFps: () => fps }); // fps (below): the recognition backs off while the page itself is slow
const vfx = createVisionFx();
const overlay = { compose: (src, w, h, dt) => vfx.compose(src, w, h, dt, vision, cfg.visOn ? { draw: cfg.visDraw, ghost: cfg.visGhost, spot: cfg.visSpot, trail: cfg.visTrail } : {}, { A: EL_COLOR[game.players.A.element] ?? EL_COLOR.thunder, B: EL_COLOR[game.players.B.element] ?? EL_COLOR.thunder }) };
const stage = createStage({ video, cfg, hub, PA, isSetup: () => game.match.phase === 'setup', overlay });
const hudFlash = { el: null };
const game = createGame({ fx: stage.fx, drone: stage.drone, sfx: () => sfx, cfg, onFlash: el => flash(el), onHit: (slot, ms) => hub.send?.({ type: 'flash', slot, ms }), onVibrate: (slot, kind, extra) => hub.send?.({ type: 'vibrate', slot, kind, ...extra }), onSound: phoneSound, getDummyFrame: () => vsrc.dummy?.frame });
stage.fx.addStyle('smash', createSmashStyle); stage.fx.setStyle(cfg.fxStyle); // effect sets: プログラム版 (smash, default) / 画像素材版 (textured) / いつもの (classic)
game.command({ cmd: 'matchSec', value: cfg.matchSec });
// A / B: keyboard / random / still (screens 3 / 4, dummy room only), through the dummy's truth input and game.command
const tutorial = createTutorial({ isActive: () => screen === 'game' }); // slides over the whole page, opened from screen 3 (made before playable: its keys come first)
const playable = createPlayable({ vsrc, game, cfg, save, isActive: () => screen === 'game' || screen === 'final' });
let phones = [];
playable.onChange(() => game.setOnline(playable.withSelf(phones)));

hub.on(k => {
  if (k.type === 'marker') { if (k.marker !== W.MARKER || (k.runeScale ?? W.RUNE_SCALE) !== W.RUNE_SCALE) location.reload(); return; } // world.js fixed its tag table at load: start over with the new one
  PA.ingest(k); smap.ingest(k);
  if (k.type === 'phones') { phones = k.list; game.setOnline(playable.withSelf(k.list)); return; }
  if (k.type === 'sticks') { game.setSticks(k); sticksUi?.refresh().catch(() => {}); return; } // assigned sticks (server.mjs): taken on while setting up / at the next match
  if (k.type === 'stick') { // a scanned stick (stickui.js, server.mjs): its look in the game, and its measured length for the tip
    stage.field.setStick(k.slot, k.model);
    if (k.model) { cfg.stickLen[k.slot] = k.model.length; save(); }
  }
  connect.ingest(k); game.ingest(k);
  if (k.type === 'truth' && !playable.owns(k.slot)) vsrc.dummy?.setTruth(k.slot, k); // fake-world.mjs: the dummy room shows the simulated players
  if (k.type === 'imu') swingSound(k);
  if (k.type === 'imu' || k.type === 'ar' || k.type === 'calib')
    for (const ev of detectors.ingest(k, axis[k.slot])) { if (!ev.keep) connect.logAction(ev); if (!playable.owns(ev.slot)) game.onSensed(ev); }
});

fetch('/sticks/assign', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(k => k && game.setSticks(k)).catch(() => {}); // until the first /ws 'sticks'
// ---- screens ----
const connect = createConnect({ cards: $('#phoneCards'), side: $('#connectSide'), hub, vsrc, cfg,
  onStick: (s, v) => { cfg.stickLen[s] = v; save(); },
  onVideoSrc: v => { cfg.videoSrc = v; save(); vsrc.set(v); } });
const space = createSpace({ view: $('#spaceView'), legendEl: $('#spaceLegend'), panelEl: $('#spacePanel'), hub, PA, getStage: () => stage, getGame: () => game, getMap: () => smap, cfg });

// HUD lives inside the stage, so it follows the canvas between the game and final screens
const hud = $('#hudTpl').content.firstElementChild.cloneNode(true);
stage.el.append(hud);
stage.attachMinimap(hud.querySelector('.minimap'));
hudFlash.el = hud.querySelector('.flash');
// the end of a match: KO (hit stop, camera rush, the loser blown apart) or time up, then the results (ko-show.js), in the winner's element colour
const koShow = createKoShow(hud, {
  colorOf: s => s ? EL_COLOR[game.players[s].element] ?? EL_COLOR.thunder : '#c9cfdc',
  nameOf: s => { const p = game.players[s], sk = p.stick; return [sk?.name, ELEMENT_JA[p.element]].filter(Boolean).join('　'); },
  onBurst(loser, winner) {
    const at = loser.chest.clone(), dir = winner ? at.clone().sub(winner.chest) : at.clone().multiplyScalar(0);
    const el = winner?.element ?? 'thunder', color = EL_COLOR[el] ?? EL_COLOR.thunder;
    // the blast (a hot ball, shock rings, a pillar of light), every piece trailing the winner's element, and the element's biggest hit twice
    stage.field.breakApart(loser.slot, at, dir, { color, trail: pos => stage.fx.hit(el, pos.clone(), .18, { tier: 's' }) });
    for (const [k, dy] of [[1, 0], [.6, .7]]) stage.fx.hit(el, at.clone().setY(at.y + dy), k, { tier: 'l', target: at.clone() });
    stage.drone.event('hit', { target: loser.slot, pos: at, power: 1 }); stage.state.shake = 2.2; stage.field.cheer();
  },
  sound(kind) {
    const w = game.winner; if (kind === 'ko' || kind === 'burst') sfx?.hit(w?.element ?? 'thunder', 0, 1, 'l');
    if (kind === 'result' && w) { sfx?.play('win'); if (!sfx?.muted) hub.send?.({ type: 'sfx', slot: w.slot, voices: [{ file: 'win', gain: 1, rate: 1 }] }); } // the fanfare, here and on the winner's phone (none on a draw)
  },
});
let koPhase = null;
function watchEnd() { // the show starts when the game says the match is over, and is put away when a new one (or setup) begins
  const ph = game.match.phase; if (ph === koPhase) return;
  if (ph === 'result') { const w = game.winner, l = w ? game.players[w.slot === 'A' ? 'B' : 'A'] : null; koShow.start(w, l, !!l && l.hp <= 0, game.players); }
  else if (ph === 'countdown') { koShow.reset(); stage.field.unbreak(); koShow.intro(game.players); } // a new match: introduced, the broken one stands again
  else if (ph === 'fight') {} // the intro runs on into the fight's first moment ("FIGHT!")
  else { koShow.reset(); stage.field.unbreak(); }
  koPhase = ph;
}
function flash(el) {
  const f = hudFlash.el; f.style.transition = 'none'; f.style.opacity = .5;
  f.style.background = `radial-gradient(${{ fire: '#ff7a1a', water: '#3d8bff', wind: '#e8fbff' }[el] ?? '#bfe8ff'}, transparent 70%)`;
  requestAnimationFrame(() => { f.style.transition = 'opacity .35s'; f.style.opacity = 0; });
}

let screen = null, sticksUi = null;
const sentPhase = { ph: null, at: 0 }; // the game phase told to the server (phones grey out 枝 in a match)
const sentHp = { A: { hp: null, max: null, at: -9 }, B: { hp: null, max: null, at: -9 } }; // what the phones were last told (their HP screen)
function show(name) {
  if (!['connect', 'space', 'game', 'final', 'sticks'].includes(name)) name = 'connect';
  screen = name; cfg.screen = name; save();
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === 'scr-' + name);
  for (const b of document.querySelectorAll('nav.tabs button')) b.setAttribute('aria-selected', b.dataset.screen === name);
  if (name === 'game') stage.attach($('#gameBox'), 'game');
  if (name === 'sticks') sticksUi ??= mountSticks($('#sticksRoot')); // built on first open
  if (name === 'final') stage.attach($('#finalBox'), 'final');
  if (name === 'space') space.resize();
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}
for (const b of document.querySelectorAll('nav.tabs button')) b.onclick = () => show(b.dataset.screen);
addEventListener('hashchange', () => show(location.hash.slice(1)));

// ---- game screen controls ----
const gameCtrl = $('#gameCtrl');
gameCtrl.innerHTML = `
  <div class="row" id="tutRow" style="margin-bottom:6px"></div>
  <h3>試合の進行</h3>
  <div class="phase">
    <button data-phase="setup">準備中<kbd>1</kbd></button>
    <button data-phase="demo" class="go bigstart" title="試合と同じだが、魔法は撃った瞬間に相手の方向へ真っすぐ飛ぶ。撃ったあとに素早く動けば避けられる">デモ試合開始<kbd>2</kbd></button><button data-cmd="pause">一時停止<kbd>4</kbd></button>
  </div>
  <div class="row" style="margin-top:6px"><button data-cmd="reset">やり直し<kbd>R</kbd></button><label class="kv">試合時間 <input id="secIn" type="number" min="10" max="600" step="10" style="width:64px"> 秒</label></div>
  <p class="why" id="why"></p>
  <h3>プレイヤー</h3>
  <div class="players2">${['A', 'B'].map(s => `
    <div class="pc" data-s="${s}"><div class="row" style="justify-content:space-between"><b class="el" style="color:var(--${s})"></b><span class="num hpv"></span></div>
      <div class="facts"></div>
      <div class="row" style="margin-top:4px"><button data-act="shoot">小（溜めなし）</button><button data-act="charge">押して溜め</button><button data-act="special" title="2 秒あまり溜めてから撃つ（溜め中は動くと失敗）">大（溜めて撃つ）</button></div></div>`).join('')}
  </div>
  <h3>振りの音（スマホ）</h3>
  <div class="row"><button id="swingOn" title="棒を速く振ると、そのプレイヤーのスマホから刀を振る音が鳴る。振りが大きいほど大きな音">刀の振り音を鳴らす</button><button id="swingTry" title="この PC で中の大きさを鳴らす">試聴（PC）</button></div>
  <div class="row" style="gap:4px;align-items:center"><span class="muted" style="font-size:12px">スマホで鳴らす</span>${['A', 'B'].map(s => `<b style="color:var(--${s});margin-left:6px">${s}</b>${['s', 'm', 'l'].map(t => `<button data-swingtest="${t}" data-s="${s}" title="${s} のスマホで${TIER_JA[t]}の振り音を鳴らす（つながっていれば）">${TIER_JA[t]}</button>`).join('')}`).join('')}</div>
  <div class="swingm">${['A', 'B'].map(s => `<div class="row"><b style="color:var(--${s});width:1.2em">${s}</b><canvas data-swingm="${s}" width="300" height="44"></canvas></div>`).join('')}</div>
  <div class="rules">${['s', 'm', 'l'].map(t => `<label title="棒の回転の速さがこれを超えると${TIER_JA[t]}の音">${TIER_JA[t]}の音になる速さ <input data-swing="${t}" type="range" min="100" max="1500" step="10" style="width:110px;vertical-align:middle"> <span data-swingout="${t}" class="num"></span> °/s</label>`).join('')}</div>
  <p class="muted" style="font-size:12px;margin:4px 0">メーターは棒の回転の速さ（°/s）。白い棒が今の速さ、縦線が 小・中・大 の音の境目、赤い線が攻撃の境目（${ATTACK_SPEED}°/s より速く 60° 以上振って、ピタッと止めると弾が出る）</p>
  <h3>キャラクター</h3>
  <div id="charas">${['A', 'B'].map(s => `<div class="row" style="align-items:center;gap:6px"><b style="color:var(--${s});width:1.2em">${s}</b><div class="seg">${Object.entries(CHARAS).map(([k, v]) => `<button data-chara="${k}" data-s="${s}">${v}</button>`).join('')}</div></div>`).join('')}</div>
  <h3>プレイヤーの動き（ダミー映像）</h3>
  <div id="playGame"></div>
  <h3>ゲームの数値（試遊で調整）</h3>
  <div class="rules">
    <label>中になる溜め時間 <input data-rule="t1" type="number" min="0.1" max="20" step="0.1"> 秒</label>
    <label>大になる溜め時間 <input data-rule="t2" type="number" min="0.2" max="30" step="0.1"> 秒</label>
    <label>HP（試合開始時） <input data-rule="hp" type="number" min="1" max="1000" step="1"></label>
${['s', 'm', 'l'].map(t => `<label title="${TIER_JA[t]}の弾の速さ。1 が元の速さ">${TIER_JA[t]}の弾の速さ <input data-rule="speed.${t}" type="range" min="0.3" max="2" step="0.05" style="width:110px;vertical-align:middle"> <span data-speedout="${t}" class="num"></span> 倍</label>`).join('')}
    <label>小のダメージ <input data-rule="dmg.s" type="number" min="0" max="100" step="1"></label>
    <label>中のダメージ <input data-rule="dmg.m" type="number" min="0" max="100" step="1"></label>
    <label>大のダメージ <input data-rule="dmg.l" type="number" min="0" max="100" step="1"></label>
    <label title="棒を水平からこの角度まで上下に傾けても、ガードになる">ガードの傾きの許容 <input data-rule="guardLevel" type="number" min="5" max="85" step="1"> °</label>
    <label title="棒が体の左右の向きからこの角度まで前後を向いても、ガードになる">ガードの向きの許容 <input data-rule="guardSide" type="number" min="5" max="85" step="1"> °</label>
    <label title="ガードで跳ね返した小が当たったときのダメージ。小のダメージ × この倍率">反射のダメージ倍率 <input data-rule="reflectMul" type="number" min="0" max="10" step="0.1"> 倍</label>
    <label>小の連打の間隔 <input data-rule="rapid" type="number" min="0" max="3" step="0.05"> 秒</label>
    <label title="1 が今の大きさ。見た目と当たりの大きさが一緒に変わる">小の玉の大きさ <input data-rule="size.s" type="number" min="0.2" max="4" step="0.1"> 倍</label>
    <label title="1 が今の大きさ。見た目と当たりの大きさが一緒に変わる">中の玉の大きさ <input data-rule="size.m" type="number" min="0.2" max="4" step="0.1"> 倍</label>
    <label title="1 が今の大きさ。見た目と当たりの大きさが一緒に変わる">大の玉の大きさ <input data-rule="size.l" type="number" min="0.2" max="4" step="0.1"> 倍</label>
    <div class="row"><button id="rulesSave" class="go" title="この PC のサーバーに保存。次に開いたとき（別のブラウザでも）この値で始まる">パラメータを保存</button><button id="rulesLoad" title="サーバーに保存した値に戻す">保存した値を読み込む</button><button id="rulesReset">初期値に戻す</button></div>
    <div class="row"><span class="muted" id="rulesSaved" style="font-size:12px"></span></div>
    <div class="row"><span class="muted" id="rulesNote"></span></div>
  </div>
  <h3>エフェクトを試す</h3>
  <div class="seg" id="fxStyles"><button data-fxstyle="smash">プログラム版</button><button data-fxstyle="textured">画像素材版</button><button data-fxstyle="classic">いつもの</button></div>
  <p class="muted" style="font-size:12px;margin:4px 0">試合中でなくても出る。ダメージは入らない。弾は相手の胸に向けて撃つ。「溜め」は押している間溜まり、離すとその段階の技を撃つ</p>
  <div class="fxtry">${['A', 'B'].map(s => `<div class="row"><b style="color:var(--${s});width:1.4em">${s}</b>${['s', 'm', 'l'].map(t => `<button data-fxshot="${t}" data-s="${s}">${TIER_JA[t]}</button>`).join('')}<button data-fxcharge data-s="${s}">溜め（押している間）</button></div>`).join('')}</div>
  <h3>カメラ（ドローン視点）</h3>
  <div class="seg" id="drones">${Object.entries(DRONE_JA).map(([k, v]) => `<button data-drone="${k}">${v}</button>`).join('')}</div>
  <div class="row" id="zoomRow"><label title="今のカメラのズーム。カメラごとに覚える。1 が元の大きさ">ズーム <input id="zoom" type="range" min="0.5" max="3" step="0.05" style="width:130px;vertical-align:middle"> <span id="zoomOut" class="num"></span> 倍</label><button id="zoomReset">1 倍に戻す</button><span class="muted" id="zoomFor" style="font-size:12px"></span></div>
  <h3>表示</h3>
  <div class="row"><button data-tog="minimap">ミニマップ</button><button data-tog="crt" title="試合画面と最終映像を昔のブラウン管テレビ風に：解像度を下げ、少しのにじみ・光り、30 fps（C キーでも切り替え）">ブラウン管風<kbd>C</kbd></button><button data-tog="debug">デバッグ</button></div>
  <div class="row"><span class="muted" style="font-size:12px">背景</span><span class="seg" id="backdrops"><button data-backdrop="court">中庭</button><button data-backdrop="rock">岩場</button><button data-backdrop="chaoben">チャオベン劇場</button><button data-backdrop="plain">無地</button></span></div>
  <div class="row"><label title="中庭と岩場の空と光の時刻。動かすと影も付け直す"><span class="muted" style="font-size:12px">時刻</span> <input id="tod" type="range" min="0" max="24" step="0.25" style="width:130px;vertical-align:middle"> <span id="todOut" class="num"></span></label><span class="seg" id="todPresets">${PRESETS.map(([n, h]) => `<button data-tod="${h}">${n}</button>`).join('')}</span></div>
  <div class="row"><button id="todAuto" title="空の時刻がひとりでに進む。プリセットを押すと、そこから進む">時刻を自動で進める</button><span class="seg" id="todSpeeds">${TOD_SPEEDS.map(([n, v]) => `<button data-todspeed="${v}" title="1分で${v}時間">${n}</button>`).join('')}</span></div>
  <div class="row"><button data-tog="mimic" title="第三者視点カメラの映像を MediaPipe で見て、アバターに同じ姿勢をとらせる（別スレッドで 1 秒に最大 15 回）">カメラの姿勢をアバターに反映</button><span class="muted" id="mimicStatus" style="font-size:12px"></span></div>
  <h3>攻撃・防御の記録</h3>
  <ul class="log" id="gameLog"></ul>`;
tutorial.mountButton($('#tutRow'));
for (const b of gameCtrl.querySelectorAll('[data-phase]')) b.onclick = () => { game.command({ cmd: 'phase', phase: b.dataset.phase }); matchFullscreen(b.dataset.phase); };
/** A match started on screen 3 (button or key) shows the game box fullscreen; Esc leaves it (the browser does that itself). */
function matchFullscreen(phase) {
  if ((phase === 'demo' || phase === 'fight') && screen === 'game' && !document.fullscreenElement) $('#gameBox').requestFullscreen?.().catch(() => {});
}
addEventListener('fullscreenchange', () => setTimeout(stage.resize, 100)); // the stage follows the box in and out of fullscreen
gameCtrl.querySelector('[data-cmd=pause]').onclick = () => game.command({ cmd: 'pause' });
gameCtrl.querySelector('[data-cmd=reset]').onclick = () => game.command({ cmd: 'reset' });
$('#swingOn').onclick = () => { cfg.swing.on = !cfg.swing.on; save(); };
$('#swingTry').onclick = () => { sfx?.unlock?.(); sfx?.play('swing', { gain: SWING_GAIN.m }); };
for (const b of gameCtrl.querySelectorAll('[data-swingtest]')) b.onclick = () => sendSwing(b.dataset.s, b.dataset.swingtest); // the phone's own sound, without swinging
for (const i of gameCtrl.querySelectorAll('[data-swing]')) {
  i.value = cfg.swing[i.dataset.swing];
  i.oninput = () => { // the lines stay in order: 小 ≤ 中 ≤ 大
    const t = i.dataset.swing, v = +i.value, c = cfg.swing; c[t] = v;
    if (t === 's') { c.m = Math.max(c.m, v); c.l = Math.max(c.l, c.m); } else if (t === 'm') { c.s = Math.min(c.s, v); c.l = Math.max(c.l, v); } else { c.m = Math.min(c.m, v); c.s = Math.min(c.s, c.m); }
    for (const j of gameCtrl.querySelectorAll('[data-swing]')) j.value = c[j.dataset.swing];
    save();
  };
}
const SWING_MAX = 1500, swingShown = { A: 0, B: 0 };
function drawSwingMeters() { // the stick's turning speed against the lines; a swing just heard shows its size for a moment
  const c = cfg.swing;
  for (const o of gameCtrl.querySelectorAll('[data-swingout]')) setText(o, String(c[o.dataset.swingout]));
  $('#swingOn').classList.toggle('on', !!c.on);
  for (const cv of gameCtrl.querySelectorAll('[data-swingm]')) {
    const s = cv.dataset.swingm, g = cv.getContext('2d'), W = cv.width, H = cv.height, x = v => Math.min(1, v / SWING_MAX) * (W - 2) + 1;
    swingShown[s] = Math.max(swingSense.speed(s), swingShown[s] * .85); // falls back smoothly, so a fast flick is still seen
    g.clearRect(0, 0, W, H);
    const y0 = 13, bh = 16; // the bar; the attack line's label above it, the sound lines' below
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, y0, W, bh);
    const band = [[0, c.s, 'rgba(255,255,255,.04)'], [c.s, c.m, 'rgba(120,200,255,.18)'], [c.m, c.l, 'rgba(120,200,255,.32)'], [c.l, SWING_MAX, 'rgba(120,200,255,.5)']];
    for (const [a, b, col] of band) { g.fillStyle = col; g.fillRect(x(a), y0, x(b) - x(a), bh); }
    g.fillStyle = '#fff'; g.fillRect(1, y0 + 4, x(swingShown[s]) - 1, bh - 8);
    g.font = '10px system-ui'; g.textBaseline = 'top';
    for (const [v, label] of [[c.s, '小'], [c.m, '中'], [c.l, '大']]) { g.fillStyle = '#cfe8ff'; g.fillRect(x(v) - .5, y0 - 2, 1.5, bh + 4); g.fillText(label, Math.min(W - 12, x(v) + 2), y0 + bh + 2); }
    g.fillStyle = '#ff5a5a'; g.fillRect(x(ATTACK_SPEED) - .5, y0 - 2, 1.5, bh + 4); g.fillText('攻撃', Math.min(W - 24, x(ATTACK_SPEED) + 2), 0);
    const f = swingFx[s];
    if (f && performance.now() - f.at < 900) { g.fillStyle = '#ffe600'; g.fillRect(x(f.peak) - 1, y0 - 2, 3, bh + 4); g.font = 'bold 11px system-ui'; g.textAlign = 'right'; g.fillText(`${TIER_JA[f.tier]} ${Math.round(f.peak)}°/s`, W - 1, 0); g.textAlign = 'left'; }
  }
}
const secIn = $('#secIn'); secIn.value = cfg.matchSec;
secIn.onchange = () => { cfg.matchSec = Math.max(10, +secIn.value || 60); save(); game.command({ cmd: 'matchSec', value: cfg.matchSec }); };
// rules: written straight into cfg.rules, which game.js reads every time
const ruleIns = [...gameCtrl.querySelectorAll('[data-rule]')];
const ruleGet = k => k.split('.').reduce((o, x) => o?.[x], cfg.rules), ruleSet = (k, v) => { const ks = k.split('.'), last = ks.pop(); ks.reduce((o, x) => o[x], cfg.rules)[last] = v; };
function showRules() {
  for (const i of ruleIns) i.value = +(ruleGet(i.dataset.rule) * (+i.dataset.scale || 1)).toFixed(2);
  const r = cfg.rules;
  for (const o of gameCtrl.querySelectorAll('[data-speedout]')) o.textContent = (+r.speed?.[o.dataset.speedout] || 1).toFixed(2);
  $('#rulesNote').textContent = r.t2 > r.t1 ? `0〜${r.t1}秒 小 / ${r.t1}〜${r.t2}秒 中 / ${r.t2}秒〜 大` : '大になる時間は中より長くする';
}
for (const i of ruleIns) if (i.type === 'range') i.oninput = () => i.onchange(); // the slider applies while it is dragged
for (const i of ruleIns) i.onchange = () => {
  const v = +i.value; if (!Number.isFinite(v)) return showRules();
  ruleSet(i.dataset.rule, Math.max(+i.min, Math.min(+i.max, v)) / (+i.dataset.scale || 1));
  if (cfg.rules.t2 <= cfg.rules.t1) cfg.rules.t2 = +(cfg.rules.t1 + .5).toFixed(2);
  save(); showRules();
};
for (const b of gameCtrl.querySelectorAll('[data-fxstyle]')) b.onclick = () => { cfg.fxStyle = b.dataset.fxstyle; save(); stage.fx.setStyle(cfg.fxStyle); };
for (const b of gameCtrl.querySelectorAll('[data-backdrop]')) b.onclick = () => { cfg.backdrop = b.dataset.backdrop; save(); };
const showCharas = () => { for (const s of ['A', 'B']) stage.field.setChara(s, cfg.chara[s]); };
for (const b of gameCtrl.querySelectorAll('[data-chara]')) b.onclick = () => { cfg.chara[b.dataset.s] = b.dataset.chara; save(); showCharas(); b.blur(); };
showCharas();
$('#todAuto').onclick = () => { cfg.todAuto = !cfg.todAuto; save(); };
for (const b of gameCtrl.querySelectorAll('[data-todspeed]')) b.onclick = () => { cfg.todSpeed = +b.dataset.todspeed; save(); };
const todIn = $('#tod'); // the clock: stage.js hands cfg.timeOfDay to the field every frame, the field bakes the shadows again once it settles
todIn.oninput = () => { cfg.timeOfDay = +todIn.value; save(); };
for (const b of gameCtrl.querySelectorAll('[data-tod]')) b.onclick = () => { cfg.timeOfDay = +b.dataset.tod; save(); };
for (const b of gameCtrl.querySelectorAll('[data-fxshot]')) b.onclick = () => game.command({ cmd: 'fxShot', slot: b.dataset.s, tier: b.dataset.fxshot });
for (const b of gameCtrl.querySelectorAll('[data-fxcharge]')) {
  b.onpointerdown = () => game.command({ cmd: 'fxCharge', slot: b.dataset.s, on: true });
  b.onpointerup = () => game.command({ cmd: 'fxCharge', slot: b.dataset.s, on: false, fire: true });
  b.onpointerleave = () => game.command({ cmd: 'fxCharge', slot: b.dataset.s, on: false });
}
// the numbers saved on this PC's server (server.mjs /rules -> rules.json): loaded once at start (they win over this browser's), saved with the button
const mergeRules = r => ({ ...RULES, ...r, dmg: { ...RULES.dmg, ...r?.dmg }, size: { ...RULES.size, ...r?.size }, speed: speedRule(r?.speed ?? RULES.speed) });
const rulesMsg = t => { $('#rulesSaved').textContent = t; };
async function loadSavedRules(quiet) {
  try {
    const r = await fetch('/rules', { cache: 'no-store' }); if (r.status === 404) { if (!quiet) rulesMsg('サーバーに保存した値はまだない'); return; }
    if (!r.ok) throw new Error(r.status); cfg.rules = mergeRules(await r.json()); save(); showRules();
    rulesMsg(quiet ? 'サーバーに保存した値で始めた' : '保存した値を読み込んだ');
  } catch (e) { if (!quiet) rulesMsg('読み込めなかった（' + e.message + '）'); }
}
$('#rulesSave').onclick = async () => {
  try { const r = await fetch('/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...cfg.rules, rarityMul: undefined }) }); if (!r.ok) throw new Error(r.status);
    rulesMsg('保存した（' + new Date().toLocaleTimeString() + '）'); } catch (e) { rulesMsg('保存できなかった（' + e.message + '）'); }
};
$('#rulesLoad').onclick = () => loadSavedRules(false);
loadSavedRules(true);
$('#rulesReset').onclick = () => { cfg.rules = { ...RULES, dmg: { ...RULES.dmg }, size: { ...RULES.size }, speed: { ...RULES.speed } }; save(); showRules(); };
showRules();
// a held 押して溜め button / Q・P key: repeat the charge every 0.2 s (under game.js CHARGE_LIVE), as a stick that keeps circling
// would; a single 'on' only grew the charge for 0.4 s, so it stayed 小 and failed after chargeHold
const chargeHeld = {};
function holdCharge(slot, on) {
  if (!on && !chargeHeld[slot]) return;
  clearInterval(chargeHeld[slot]); chargeHeld[slot] = on ? setInterval(() => game.command({ cmd: 'charge', slot, on: true }), 200) : null;
  game.command({ cmd: 'charge', slot, on });
}
for (const pc of gameCtrl.querySelectorAll('.pc')) for (const b of pc.querySelectorAll('[data-act]')) {
  const slot = pc.dataset.s, a = b.dataset.act;
  if (a === 'charge') { b.onpointerdown = () => holdCharge(slot, true); b.onpointerup = b.onpointerleave = () => holdCharge(slot, false); b.title = '押している間溜める'; }
  else b.onclick = () => game.command({ cmd: a, slot });
}
for (const b of gameCtrl.querySelectorAll('[data-drone]')) b.onclick = () => { stage.drone.setMode(b.dataset.drone); cfg.drone = b.dataset.drone; save(); };
const zoomIn = $('#zoom'), setZoom = v => { const m = stage.drone.mode; if (m === 'free') return; cfg.zoom[m] = Math.round(v * 100) / 100; save(); };
zoomIn.oninput = () => setZoom(+zoomIn.value);
$('#zoomReset').onclick = () => setZoom(1);
function syncZoom() { // the slider shows the current camera's zoom; free mode zooms with the mouse wheel instead
  const m = stage.drone.mode, free = m === 'free', v = cfg.zoom[m] ?? 1;
  zoomIn.disabled = $('#zoomReset').disabled = free;
  if (document.activeElement !== zoomIn && +zoomIn.value !== v) zoomIn.value = v;
  setText($('#zoomOut'), free ? '—' : v.toFixed(2));
  setText($('#zoomFor'), free ? '自由操作のときはマウスホイールで拡大・縮小する' : `（${DRONE_JA[m]}）`);
}
const toggle = k => { cfg[k] = !cfg[k]; save(); };
for (const b of document.querySelectorAll('[data-tog]')) b.onclick = () => toggle(b.dataset.tog);

// ---- final screen toolbar ----
const finalBar = $('#finalBar');
playable.mountControl($('#playGame'));
const finalControls = createFinalControls({ bar: finalBar, stage, game, vsrc, cfg, save, scan, fullscreen, playable, vision });
function fullscreen() { const box = $('#finalBox'); document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen?.().then(() => setTimeout(stage.resize, 100)); }
document.addEventListener('fullscreenchange', () => setTimeout(stage.resize, 50));
let dummyScanning = false; // a scan reads the dummy room's canvas: it has to be current, also on screen 3
async function scan() { game.command({ cmd: 'phase', phase: 'setup' }); dummyScanning = true; vsrc.dummy?.showPlayers(false); try { await stage.scan(); } finally { vsrc.dummy?.showPlayers(true); dummyScanning = false; } }

// ---- settings drawer ----
const drawer = $('#settings');
const seg = (key, opts, after) => `<div class="seg" data-seg="${key}">${Object.entries(opts).map(([k, v]) => `<button data-v="${k}">${v}</button>`).join('')}</div>${after ?? ''}`;
drawer.innerHTML = `
  <h2>設定<span class="grow"></span><button id="closeSettings">閉じる<kbd>Esc</kbd></button></h2>
  <section><h3>プレイヤーの位置</h3>${seg('posSrc', POS_JA)}
    <p class="note">自動：胸スマホがタグで合っていればそれ、なければ直前の位置。</p>
  </section>
  <section><h3>タグのスキャン（スマホ C）</h3>${seg('tagMode', { 2: '2枚（ID 0・1）', 4: '4枚（ID 0〜3）' })}
    ${W.FIXED_FIELD ? '' : `<div style="height:6px"></div>${seg('tagMount', { stand: '立てる', floor: '床に置く' })}`}
    <label class="f"><span>スマホ C の縦画角（床のタグの位置合わせ用）</span><input type="number" id="fovC" min="10" max="120" step="1"><output>°</output></label>
    <label class="f"><span>タグ中心の高さ</span><input type="number" id="tagHeight" min="0.1" max="3" step="0.05"><output>m</output></label>
    <p class="note" id="fovNote"></p>
    <div class="row"><button id="forgetFov">覚えた画角を消す</button><button id="clearScan">スキャン結果を消す</button></div>
    <p class="note">人がいない状態で、フィールドの角に置いたタグがスマホ C の映像に全部入るようにしてからスキャンする。床のタグなら 2 枚のとき左が A 側。</p></section>
  <section><h3>ゲーム</h3>
    <label class="f"><span>狙い</span><select id="aimSel"><option value="motion">止める直前の棒の先の動き（小は胸の向きと合わせて水平、高さは棒の先）</option><option value="stick">止めたときの棒の向き</option><option value="eye">目から棒先へ</option></select><span></span></label>
    <div class="row"><button data-tog="test">テスト（HP が減らない）</button><button data-tog="useTruth">正解位置（シミュレーター）</button></div></section>
  <section><h3>音</h3>
    ${['master:全体', 'bgm:BGM', 'sfx:効果音', 'amb:環境音'].map(x => { const [k, n] = x.split(':'); return `<label class="f"><span>${n}</span><input type="range" min="0" max="1" step="0.01" data-vol="${k}"><output data-volout="${k}"></output></label>`; }).join('')}
    <div class="row"><button id="mute">消音</button><button id="bgmPreview" title="M キーでも押せる。試合の BGM を、試合とは関係なく流す。試合が始まると自動で止まり、試合の BGM が頭から流れる">試合 BGM を流す<kbd>M</kbd></button><span class="note" id="audioInfo"></span></div>
    <div class="row" style="margin-top:6px">${[['shotFire', '炎の発射'], ['shotThunder', '雷の発射'], ['hitFire', '炎の命中'], ['hitThunder', '雷の命中'], ['specialFire', '炎の大'], ['specialThunder', '雷の大'], ['shotWater', '水の発射'], ['hitWater', '水の命中'], ['specialWater', '水の大'], ['shotWind', '風の発射'], ['hitWind', '風の命中'], ['specialWind', '風の大']].map(([k, n]) => `<button data-sound="${k}">${n}</button>`).join('')}<button id="damageSound" title="ダメージを受けたときに、スマホ A・B がライトと一緒に鳴らす音">被弾（スマホの音）</button><button data-own="my_shot" title="小を撃った人のスマホが鳴らす音">小の発射（撃った人のスマホ）</button><button data-own="my_launch" title="中・大を撃った人のスマホが鳴らす音（大は低く）">溜め技の発射（撃った人のスマホ）</button></div></section>
  <section><h3>キー操作</h3><table class="keys">
    <tr><td>Alt+1〜4</td><td>画面の切り替え</td></tr><tr><td>1 2 3 4</td><td>準備中・デモ試合開始（撃った瞬間に相手を狙う）・試合開始・一時停止</td></tr><tr><td>R</td><td>やり直し</td></tr>
    <tr><td>Space / Enter</td><td>A / B が小の攻撃（溜めなし）</td></tr><tr><td>Q / P 長押し</td><td>A / B が溜める（離した時の溜め時間で小・中・大）</td></tr>
    <tr><td>K</td><td>タグでスキャン</td></tr><tr><td>M</td><td>試合 BGM を流す / 止める</td></tr>
    <tr><td>A のキーボード操作</td><td>WASD で移動、F 長押しで溜め・離して撃つ、止まって G 長押しでガード</td></tr><tr><td>B のキーボード操作</td><td>十字キーで移動、. 長押しで溜め・離して撃つ、止まって / 長押しでガード</td></tr></table></section>`;
$('#openSettings').onclick = () => drawer.classList.toggle('open');
$('#closeSettings').onclick = () => drawer.classList.remove('open');
for (const g of drawer.querySelectorAll('[data-seg]')) for (const b of g.querySelectorAll('button')) b.onclick = () => {
  const k = g.dataset.seg; cfg[k] = k === 'tagMode' ? +b.dataset.v : b.dataset.v; save();
};
for (const b of drawer.querySelectorAll('[data-tog]')) b.onclick = () => toggle(b.dataset.tog);
const fovCEl = $('#fovC'); fovCEl.value = cfg.fovC; fovCEl.onchange = () => { cfg.fovC = Math.max(10, Math.min(120, +fovCEl.value || 40)); save(); };
const tagH = $('#tagHeight'); tagH.value = cfg.tagHeight; tagH.onchange = () => { cfg.tagHeight = Math.max(.1, Math.min(3, +tagH.value || 1)); save(); };
$('#forgetFov').onclick = () => { cfg.knownFov = null; save(); };
$('#clearScan').onclick = () => confirm('スキャンしたフィールドとカメラの位置を消しますか？') && stage.clearScan();
const aimSel = $('#aimSel'); aimSel.value = cfg.aim; aimSel.onchange = () => { cfg.aim = aimSel.value; save(); };
for (const r of drawer.querySelectorAll('[data-vol]')) r.oninput = () => {
  sfx?.setVolume(r.dataset.vol, +r.value);
  try { localStorage.setItem('pd-vol', JSON.stringify(sfx?.volumes ?? {})); } catch {}
};
$('#mute').onclick = () => sfx?.setMuted(!sfx.muted);
$('#tutRow').append($('#bgmPreview')); // the match BGM button sits next to 発表用スライド on screen 3 (moved out of the settings drawer)
$('#bgmPreview').onclick = () => { if (!sfx) return; sfx.unlock?.(); sfx.previewBgm(!sfx.previewingBgm); };
for (const b of drawer.querySelectorAll('[data-sound]')) b.onclick = () => {
  if (!sfx) return; sfx.unlock?.();
  const [, kind, E] = b.dataset.sound.match(/^(shot|hit|special)(\w+)$/) ?? [], el = E?.toLowerCase(); // e.g. hitWater
  ({ shot: () => sfx.shot(el, 0, .6), hit: () => sfx.hit(el, 0, .7), special: () => { sfx.special(el, 0); sfx.hit(el, 0, 1, 'l'); } })[kind]?.();
};

$('#damageSound').onclick = () => { if (!sfx) return; sfx.unlock?.(); sfx.play('damage'); };
for (const b of drawer.querySelectorAll('[data-own]')) b.onclick = () => { if (!sfx) return; sfx.unlock?.(); sfx.play(b.dataset.own); };

// ---- keys ----
const KEYS = { 1: { cmd: 'phase', phase: 'setup' }, 2: { cmd: 'phase', phase: 'demo' }, 3: { cmd: 'phase', phase: 'fight' }, 4: { cmd: 'pause' }, r: { cmd: 'reset' },
  ' ': { cmd: 'shoot', slot: 'A' }, Enter: { cmd: 'shoot', slot: 'B' } };
const held = { q: 'A', p: 'B' };
addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.repeat || e.ctrlKey || e.metaKey) return;
  if (e.altKey) { const n = { Digit1: 'connect', Digit2: 'space', Digit3: 'game', Digit4: 'final' }[e.code]; if (n) { e.preventDefault(); show(n); } return; }
  if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (held[k] && screen !== 'final') return holdCharge(held[k], true);
  if (KEYS[k]) { game.command(KEYS[k]); if (KEYS[k].cmd === 'phase') matchFullscreen(KEYS[k].phase); return; }
  if (k === 'k') scan();
  else if (k === 'c') document.querySelector('[data-tog="crt"]').click(); // ブラウン管風 on / off
  else if (k === 'm') $('#bgmPreview').click(); // 試合 BGM を流す / 止める (also while the slides are open: tutorial.js lets M through); the minimap is its button only
  else if (k === 'Escape') drawer.classList.remove('open');
});
addEventListener('keyup', e => { const k = e.key.toLowerCase(); if (held[k]) holdCharge(held[k], false); }); // on any screen: a key let go on the final screen still stops its repeat
addEventListener('blur', () => { for (const s of Object.keys(chargeHeld)) holdCharge(s, false); }); // the window lost focus: no keyup will come

// ---- per-frame UI ----
function pill(id, state) { const p = $(id); p.classList.toggle('on', state === true); p.classList.toggle('half', state === 'half'); }
const hudP = Object.fromEntries(['A', 'B'].map(s => { const el = hud.querySelector('.pl.' + s); return [s, { el, hp: el.querySelector('.hp i'), gauge: createGauge(el.querySelector('.gauge')), hpn: el.querySelector('.hpn') }]; }));
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const setHtml = (el, h) => { if (el.innerHTML !== h) el.innerHTML = h; };
// damage numbers: HUD text at the inner end of the player's HP bar, so the hit's effects never cover it; bigger for a bigger hit
const dmgLast = {}, dmgPops = [];
function damagePops() {
  for (const p of Object.values(game.players)) {
    const prev = dmgLast[p.slot]; dmgLast[p.slot] = p.hp;
    if (prev == null || !(p.hp < prev - .5) || screen !== 'game') continue;
    const n = Math.round(prev - p.hp), k = Math.min(1, n / 60) ** .6; // 5 -> ~30 px, 20 -> ~50 px, 60 -> 82 px
    const el = document.createElement('div'); el.className = 'dmg' + (n >= 40 ? ' l' : n >= 15 ? ' m' : '');
    el.textContent = String(n); el.style.fontSize = Math.round(22 + 60 * k) + 'px';
    hud.append(el); dmgPops.push({ el, slot: p.slot, t0: performance.now() });
  }
  // on the player's own HP bar: over its inner end (77 % of the way from the outer end), resting on its top edge
  const box = hud.getBoundingClientRect();
  for (let i = dmgPops.length - 1; i >= 0; i--) {
    const d = dmgPops[i], t = (performance.now() - d.t0) / 1000;
    if (t > 1.4) { d.el.remove(); dmgPops.splice(i, 1); continue; }
    const bar = hudP[d.slot].el.querySelector('.meter.hp').getBoundingClientRect(), along = d.slot === 'A' ? .77 : .23;
    const pop = t < .12 ? .6 + 3.3 * t : t < .25 ? 1.2 - 1.5 * (t - .12) : 1;
    d.el.style.left = bar.left - box.left + bar.width * along + 'px';
    d.el.style.top = Math.max(d.el.offsetHeight / 2 + 2, bar.top - box.top - bar.height * .64 - 10 * Math.min(1, t)) + 'px'; // rises a little, never off the top
    d.el.style.transform = `translate(-50%, -50%) scale(${pop})`; d.el.style.opacity = Math.min(1, (1.4 - t) / .4);
  }
}
function updateHud() {
  if (screen === 'game') drawSwingMeters();
  damagePops();
  const m = game.match;
  for (const p of Object.values(game.players)) {
    const h = hudP[p.slot];
    h.hp.style.width = 100 * p.hp / (p.hpMax || 100) + '%'; setText(h.hpn, String(Math.round(p.hp)));
    h.hp.classList.toggle('low', p.hp / (p.hpMax || 100) <= .2);
    // the try-out button fills it as well, as far as a real charge of that length would (game.js effects())
    const { t1, t2 } = cfg.rules, pv = p.preview ? performance.now() / 1000 - p.preview : null, level = pv !== null ? Math.min(1, pv / t2) : p.charging ? p.charge : 0;
    h.gauge.set(level, pv !== null ? (pv < t1 ? 's' : pv < t2 ? 'm' : 'l') : p.charging ? p.tier : null);
    // the name line is only the slot letter (A / B): no element, no stick name or stars (11/12)
  }
  const showTimer = m.phase === 'fight' || m.phase === 'result';
  setText(hud.querySelector('.timer'), showTimer ? String(Math.ceil(m.left)) : '');
  const pp = hud.querySelector('.phasepill'), pt = m.phase === 'setup' ? (stage.state.scanned ? '準備中（スキャン済み）' : '準備中') : m.mode === 'demo' ? 'デモ試合（相手を狙って撃つ）' : '';
  setText(pp, pt); pp.style.display = pt ? '' : 'none';
  const bt = game.bannerText(), bn = hud.querySelector('.banner');
  bn.style.display = bt && !koShow.active ? 'grid' : 'none'; setText(bn, bt); // the end of a match is ko-show.js's
  setText(hud.querySelector('.status'), cfg.debug ? `位置: A ${POS_JA[game.players.A.src] ?? game.players.A.src} / B ${POS_JA[game.players.B.src] ?? game.players.B.src}　ドローン: ${DRONE_JA[stage.drone.mode]}（${stage.drone.shot}）　${stage.state.msg}` : '');
}
const LOG_ICON = { shot: '発射', special: '大', hit: '命中', charge: '溜め', guard: 'ガード', phase: '進行', win: '勝敗' };
let logKey = '';
let autoScanAt = null; const t0 = () => performance.now() / 1000;
function updateSlowUi() {
  const m = game.match, P = game.players;
  pill('#pillA', hub.phones.A.online); pill('#pillB', hub.phones.B.online);
  const st = vsrc.state; pill('#pillC', video.videoWidth ? true : st.mode === 'remote' && st.cam ? 'half' : false);
  $('#pillC span:last-child').textContent = st.mode === 'remote' ? 'カメラ' : st.mode === 'local' ? 'PCカメラ' : 'ダミー';
  pill('#pillLink', hub.link === 'open');
  const playing = ['countdown', 'fight', 'result'].includes(m.phase);
  for (const b of gameCtrl.querySelectorAll('[data-phase]')) b.classList.toggle('on', b.dataset.phase === 'setup' ? m.phase === 'setup' : playing && b.dataset.phase === (m.mode === 'demo' ? 'demo' : 'fight'));
  gameCtrl.querySelector('[data-cmd=pause]').classList.toggle('on', m.paused);
  for (const b of document.querySelectorAll('[data-tog]')) b.classList.toggle('on', !!cfg[b.dataset.tog]);
  for (const b of gameCtrl.querySelectorAll('[data-drone]')) b.classList.toggle('on', b.dataset.drone === stage.drone.mode);
  syncZoom();
  for (const b of gameCtrl.querySelectorAll('[data-fxstyle]')) b.classList.toggle('on', b.dataset.fxstyle === stage.fx.style);
  for (const b of gameCtrl.querySelectorAll('[data-backdrop]')) b.classList.toggle('on', b.dataset.backdrop === cfg.backdrop);
  for (const b of gameCtrl.querySelectorAll('[data-chara]')) b.classList.toggle('on', b.dataset.chara === cfg.chara[b.dataset.s]);
  const plain = cfg.backdrop === 'plain'; todIn.disabled = plain; // the plain arena has no sky
  $('#todAuto').classList.toggle('on', !!cfg.todAuto); $('#todAuto').disabled = plain;
  for (const b of gameCtrl.querySelectorAll('[data-todspeed]')) { b.disabled = plain || !cfg.todAuto; b.classList.toggle('on', +b.dataset.todspeed === (cfg.todSpeed ?? TOD_SPEEDS[1][1])); }
  if (document.activeElement !== todIn && +todIn.value !== cfg.timeOfDay) todIn.value = cfg.timeOfDay;
  setText($('#todOut'), clock(cfg.timeOfDay));
  for (const b of gameCtrl.querySelectorAll('[data-tod]')) { b.disabled = plain; b.classList.toggle('on', +b.dataset.tod === cfg.timeOfDay % 24); }
  for (const b of finalBar.querySelectorAll('[data-fpv]')) b.classList.toggle('on', (b.dataset.fpv || null) === cfg.fpv);
  for (const g of drawer.querySelectorAll('[data-seg]')) for (const b of g.querySelectorAll('button')) b.classList.toggle('on', String(cfg[g.dataset.seg]) === b.dataset.v);
  $('#why').textContent = !stage.state.scanned ? '未スキャン：最終映像の位置はずれます（最終映像の画面で「タグでスキャン」）' : !hub.phones.A.online && !hub.phones.B.online ? 'スマホ A・B が未接続：キーかボタンで操作できます' : '';
  for (const pc of gameCtrl.querySelectorAll('.pc')) {
    const p = P[pc.dataset.s];
    pc.querySelector('.hpv').textContent = `HP ${Math.round(p.hp)}`;
    setText(pc.querySelector('b.el'), `${pc.dataset.s} ${ELEMENT_JA[p.element] ?? ''}${p.stick ? ` · ${p.stick.name} ${'★'.repeat(p.stick.rarity | 0)}` : ''}`); // follows the stick chosen on 棒設定
    pc.querySelector('.facts').innerHTML = `${p.online ? '接続中' : p.imu ? 'IMU のみ' : '未接続'} · 位置 ${POS_JA[p.src] ?? (p.src === 'hold' ? '保持' : p.src)}${p.charging ? ` · 溜め ${TIER_JA[p.tier] ?? '小'} ${p.chargeT.toFixed(1)} 秒` : ''}<br>発射 ${p.shots} · 命中 ${p.hits} · 与えたダメージ ${p.dealt} · 大 ${p.specials} · 溜め失敗 ${p.fails}`;
  }
  const key = game.events.length + ':' + (game.events[0]?.at ?? 0);
  if (key !== logKey) {
    logKey = key;
    $('#gameLog').innerHTML = game.events.slice(0, 80).map(e => `<li><span class="t">${new Date(e.at).toLocaleTimeString('ja-JP', { hour12: false })}</span><b style="color:${e.slot ? `var(--${e.slot})` : 'var(--muted)'}">${e.slot ?? '—'}</b><span><span class="muted">${LOG_ICON[e.kind] ?? ''}</span> ${esc(e.text)}</span></li>`).join('') || '<li class="muted">まだありません</li>';
  }
  const checks = stage.tagChecks(), fresh = performance.now() / 1000 - stage.seenTags.at < 3;
  // Phone C keeps itself aligned: a quiet scan of the middle tags every few seconds (the sheets are fixed, only phone C's pose is refreshed)
  if ((video.videoWidth || video.__dummy) && t0() - (autoScanAt ?? -99) > 2.5) { autoScanAt = t0(); stage.autoAlign(); }
  $('#tagCheck').innerHTML = video.videoWidth && !video.__dummy ? checks.map(c => `<span class="${fresh && c.seen ? (c.px < 14 ? 'warn' : 'ok') : 'bad'}">ID${c.id}${fresh && c.seen ? (c.px < 14 ? ' 小さい' : ' ✓') : ' ×'}</span>`).join(' ') : '';
  $('#finalMsg').textContent = [!video.videoWidth ? (vsrc.state.msg || '映像なし') : '', stage.state.msg].filter(Boolean).join('　');
  $('#fovNote').textContent = cfg.knownFov ? `覚えた縦画角 ${cfg.knownFov.toFixed(1)}°（立てたタグのスキャンで使う）` : '画角はまだ覚えていない（床置きか、まっすぐ立てた状態のスキャンで覚える）';
  for (const r of drawer.querySelectorAll('[data-vol]')) { const v = sfx?.volumes?.[r.dataset.vol]; if (v != null && document.activeElement !== r) r.value = v; drawer.querySelector(`[data-volout=${r.dataset.vol}]`).textContent = v != null ? Math.round(v * 100) : '--'; }
  $('#mute').textContent = sfx?.muted ? '消音を解除' : '消音';
  setHtml($('#bgmPreview'), (sfx?.previewingBgm ? '試合 BGM を止める' : '試合 BGM を流す') + '<kbd>M</kbd>');
  const v = vision.state;
  $('#mimicStatus').textContent = !cfg.mimic ? '' : !v.on ? '待機中（カメラの映像が届くと動く）' : v.error ? v.error : !v.ready ? 'MediaPipe を読み込み中…（初回は数十秒）'
    : `${v.delegate} ${v.hz.toFixed(0)} 回/秒 · 1回 ${v.ms.toFixed(0)} ms · 反映 ${['A', 'B'].filter(s => game.players[s].skel).join('・') || 'なし'}`;
  $('#audioInfo').textContent = !sfx ? '読み込み中' : !sfx.unlocked ? 'ページを一度クリックすると音が出ます' : '';
}

/** Where the sensors put each player in phone C's picture (0..1), for naming the people found and as the stick's prior. */
function visionHints() {
  if (cfg.fpv || !(stage.state.scanned || video.__dummy)) return {};
  const uv = p => { const q = p.clone().project(cam); return q.z < 1 && Math.abs(q.x) < 1.5 && Math.abs(q.y) < 1.5 ? [(q.x + 1) / 2, (1 - q.y) / 2] : null; };
  const out = {}, w = video.__dummy?.canvas.width ?? video.videoWidth, h = video.__dummy?.canvas.height ?? video.videoHeight;
  const cam = stage.phoneCam(w / h); if (!cam) return {};
  for (const s of ['A', 'B']) {
    const p = game.players[s], chest = p.src === 'start' ? null : uv(p.chest), b = uv(p.base), t = uv(p.tip);
    const real = p.stickSrc !== 'IMU なし（前向き）'; // only a measured stick direction helps the search
    out[s] = { chest, stick: real && b && t ? { x: b[0], y: b[1], a: Math.atan2((t[1] - b[1]) * h, (t[0] - b[0]) * w) } : null };
  }
  return out;
}

/** The pose found for each player -> world joints on game.players[slot].skel (field3d's avatar copies it); null = the avatar poses itself. */
const skelCache = {};
function applyMimic(on) {
  const w = video.__dummy?.canvas.width ?? video.videoWidth, h = video.__dummy?.canvas.height ?? video.videoHeight;
  for (const s of ['A', 'B']) {
    const p = game.players[s], person = on && (p.online || p.imu) ? vision.persons[s] : null; // offline (no phone, no stick): stands still, never copies whoever the camera sees
    if (!person || performance.now() / 1000 - person.t > .7 || !w) { p.skel = null; continue; }
    if (skelCache[s]?.person !== person) { // a new result (~15 Hz): convert once, the avatar smooths it between results
      const cam = stage.phoneCam(w / h);
      skelCache[s] = { person, r: cam && personTo3D(person, { e: cam.matrixWorld.elements, fovY: cam.fov }, w / h) };
    }
    p.skel = skelCache[s].r;
  }
}

// ---- main loop ----
const CRT_FPS = 30;
let stageDt = 0; // time since the stage last drew
let last = performance.now() / 1000, fps = 60, lastSlow = 0, est = PA.estimate(nowS()), dummyDrawnAt = -1e9;
function frame(ts) {
  requestAnimationFrame(frame);
  if (ts && ts - (frame.at ?? -1e9) < 1000 / 60 - 2) return; // 120 Hz screens: no visible gain for twice the work
  frame.at = ts;
  const t = performance.now() / 1000, raw = t - last, dt = Math.min(.05, raw); last = t;
  fps = .95 * fps + .05 / Math.max(raw, 1e-3);
  try { est = PA.estimate(nowS()); } catch (e) { console.warn('phonealign', e); }
  playable.step(dt, t);
  if (cfg.todAuto && cfg.backdrop !== 'plain') { // the clock runs by itself: hours per minute; saved now and then, not every frame
    cfg.timeOfDay = +(((cfg.timeOfDay ?? DEFAULT_HOUR) + dt * (cfg.todSpeed ?? TOD_SPEEDS[1][1]) / 60) % 24).toFixed(4);
    if (t - (frame.todSaved ?? 0) > 5) { frame.todSaved = t; save(); }
  }
  // The picture and game placement consume this exact same pose snapshot. Screen 3 does not show the picture, so it is drawn once a second there:
  // enough to keep the video stream alive, and a full 1080p room with soft shadows every frame is what made the dummy heavy on a laptop GPU.
  const dummyPicture = screen !== 'game' || !!cfg.mimic || dummyScanning || t - dummyDrawnAt >= 1;
  if (dummyPicture) dummyDrawnAt = t;
  vsrc.dummy?.render(t, dummyPicture);
  game.step(dt, raw, est, { sensorOnly: screen === 'final' });
  if (game.match.phase !== sentPhase.ph || t - sentPhase.at > 2) { sentPhase.ph = game.match.phase; sentPhase.at = t; hub.send?.({ type: 'match', phase: sentPhase.ph }); }
  for (const p of Object.values(game.players)) { // each phone's big HP bar (SensorLink's HP screen): on every change, and once a second
    const h = sentHp[p.slot], hp = Math.max(0, Math.round(p.hp)), max = Math.max(1, Math.round(p.hpMax || 100));
    if (h.hp !== hp || h.max !== max || t - h.at > 1) { h.hp = hp; h.max = max; h.at = t; hub.send?.({ type: 'hp', slot: p.slot, hp, max }); }
  }
  if (screen === 'final') finalControls.step(t);
  // MediaPipe runs for the avatars (pose only) and/or the final screen's layers (also the masks and the stick search)
  const live = !!(video.videoWidth || video.__dummy);
  const mimicOn = POSE.show && !!cfg.mimic && live && (screen === 'game' || screen === 'final' && !!cfg.pip);
  const layersOn = !!cfg.visOn && screen === 'final' && !cfg.fpv && VIS_KEYS.some(k => cfg[k]);
  vision.want(mimicOn || layersOn, layersOn);
  if (mimicOn || layersOn) vision.setHints(visionHints());
  applyMimic(mimicOn);
  watchEnd();
  stageDt += dt;
  if (screen === 'game' || screen === 'final') {
    if (!cfg.crt || stageDt >= 1 / CRT_FPS - .004) { stage.render(stageDt, game, est, koShow.state(stageDt)); stageDt = 0; } // the CRT look draws 30 frames a second
    updateHud();
  } else { stage.fx.step(stageDt); stageDt = 0; } // effects keep their time even when nobody looks
  if (screen === 'final') finalControls.updateStatus();
  if (screen === 'space') space.frame(nowS(), est);
  if (screen === 'connect') connect.frame();
  if (t - lastSlow > .2) { lastSlow = t; updateSlowUi(); $('#pillFps').textContent = `${fps.toFixed(0)} fps`; }
}

stage.drone.setMode(cfg.drone);
vsrc.set(new URLSearchParams(location.search).has('dummy') ? 'dummy' : cfg.videoSrc);
show(location.hash.slice(1) || cfg.screen);
requestAnimationFrame(frame);
window.__pd = { game, stage, PA, hub, cfg, vsrc, get est() { return est; } }; // for the console and tests
