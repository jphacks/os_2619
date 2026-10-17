// 棒バトル ダッシュボード: one page, four screens, one match.
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
import { createGame, PHASE_JA, POS_JA, ELEMENT_JA, RULES, TIER_JA } from './game.js';
import { createSmashStyle } from './fx-smash.js';
import { createSpace } from './space3d.js';
import { createConnect } from './connect.js';
import { createFinalControls } from './final-controls.js';
import { createVision } from './vision.js';
import { createVisionFx } from './visionfx.js';
import { createPlayable } from './playable.js';

const $ = s => document.querySelector(s);
const nowS = () => Date.now() / 1000;
const esc = v => String(v).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

// ---- settings (localStorage) ----
const DEFAULTS = {
  posSrc: 'auto', hand: 'R', aim: 'motion', stickLen: { A: W.STICK.len, B: W.STICK.len },
  minimap: true, debug: false, pip: false, mirrorX: true, mirrorY: true, swordFlip: true, fpv: null, drone: 'fixed', videoSrc: 'remote', tagMode: 4, tagMount: 'floor', tagHeight: 1.0, knownFov: null,
  matchSec: 60, test: false, useTruth: false, screen: 'connect', rules: RULES, rulesVer: 5, fxStyle: 'smash',
};
const saved = (() => { try { return JSON.parse(localStorage.getItem('pd-cfg')) ?? {}; } catch { return {}; } })();
const cfg = { ...DEFAULTS, ...saved, stickLen: { ...DEFAULTS.stickLen, ...saved.stickLen } };
cfg.visOn = false; // picture recognition (MediaPipe) is off at every start: nothing is loaded or run until it is switched on in the final bar
if ((saved.rulesVer ?? 0) < 1) cfg.matchSec = 60; // the 10/17 rules: 60 s matches
for (const s of ['A', 'B']) if (cfg.stickLen[s] === .8) cfg.stickLen[s] = W.STICK.len; // the old default, saved before the real 1.0 m stick was measured
if ((saved.rulesVer ?? 0) < 2) cfg.aim = 'motion'; // ...and the aim from the tip's motion
if ((saved.rulesVer ?? 0) < 4) cfg.fxStyle = 'smash'; // the program-drawn set is the one used in the show (10/18)
if ((saved.rulesVer ?? 0) < 5) cfg.drone = 'fixed'; // the game screen starts on phone C's view, the same as screen 4 (10/18)
cfg.rulesVer = 5;
cfg.rules = { ...RULES, ...saved.rules, dmg: { ...RULES.dmg, ...saved.rules?.dmg }, size: { ...RULES.size, ...saved.rules?.size } };
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

// recognition on the final screen (vision.js) and its layers under the effects (visionfx.js); nothing runs unless it is switched on (cfg.visOn) and a layer is on
const VIS_KEYS = ['visDraw', 'visGhost', 'visSpot', 'visTrail'], EL_COLOR = { fire: '#ff7a1a', thunder: '#6cc8ff' };
const vision = createVision({ getSource: () => video.__dummy?.canvas ?? video, stickLen: () => (cfg.stickLen.A + cfg.stickLen.B) / 2 });
const vfx = createVisionFx();
const overlay = { compose: (src, w, h, dt) => vfx.compose(src, w, h, dt, vision, cfg.visOn ? { draw: cfg.visDraw, ghost: cfg.visGhost, spot: cfg.visSpot, trail: cfg.visTrail } : {}, { A: EL_COLOR[game.players.A.element], B: EL_COLOR[game.players.B.element] }) };
const stage = createStage({ video, cfg, hub, PA, isSetup: () => game.match.phase === 'setup', overlay });
const hudFlash = { el: null };
const game = createGame({ fx: stage.fx, drone: stage.drone, sfx: () => sfx, cfg, onFlash: el => flash(el), getDummyFrame: () => vsrc.dummy?.frame });
stage.fx.addStyle('smash', createSmashStyle); stage.fx.setStyle(cfg.fxStyle); // effect sets: プログラム版 (smash, default) / 画像素材版 (textured) / いつもの (classic)
game.command({ cmd: 'matchSec', value: cfg.matchSec });
// A / B: keyboard / random / still (screens 3 / 4, dummy room only), through the dummy's truth input and game.command
const playable = createPlayable({ vsrc, game, cfg, save, isActive: () => screen === 'game' || screen === 'final' });
let phones = [];
playable.onChange(() => game.setOnline(playable.withSelf(phones)));

hub.on(k => {
  PA.ingest(k); smap.ingest(k);
  if (k.type === 'phones') { phones = k.list; game.setOnline(playable.withSelf(k.list)); return; }
  connect.ingest(k); game.ingest(k);
  if (k.type === 'truth' && !playable.owns(k.slot)) vsrc.dummy?.setTruth(k.slot, k); // fake-world.mjs: the dummy room shows the simulated players
  if (k.type === 'imu' || k.type === 'ar' || k.type === 'calib')
    for (const ev of detectors.ingest(k, axis[k.slot])) { if (!ev.keep) connect.logAction(ev); if (!playable.owns(ev.slot)) game.onSensed(ev); }
});

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
function flash(el) {
  const f = hudFlash.el; f.style.transition = 'none'; f.style.opacity = .5;
  f.style.background = el === 'fire' ? 'radial-gradient(#ff7a1a, transparent 70%)' : 'radial-gradient(#bfe8ff, transparent 70%)';
  requestAnimationFrame(() => { f.style.transition = 'opacity .35s'; f.style.opacity = 0; });
}

let screen = null;
function show(name) {
  if (!['connect', 'space', 'game', 'final'].includes(name)) name = 'connect';
  screen = name; cfg.screen = name; save();
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === 'scr-' + name);
  for (const b of document.querySelectorAll('nav.tabs button')) b.setAttribute('aria-selected', b.dataset.screen === name);
  if (name === 'game') stage.attach($('#gameBox'), 'game');
  if (name === 'final') stage.attach($('#finalBox'), 'final');
  if (name === 'space') space.resize();
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}
for (const b of document.querySelectorAll('nav.tabs button')) b.onclick = () => show(b.dataset.screen);
addEventListener('hashchange', () => show(location.hash.slice(1)));

// ---- game screen controls ----
const gameCtrl = $('#gameCtrl');
gameCtrl.innerHTML = `
  <h3>試合の進行</h3>
  <div class="phase">
    <button data-phase="setup">準備中<kbd>1</kbd></button>
    <button data-phase="fight" class="go">試合開始<kbd>3</kbd></button><button data-phase="demo" title="試合と同じだが、魔法は撃った瞬間に相手の方向へ真っすぐ飛ぶ。撃ったあとに素早く動けば避けられる">デモ試合開始<kbd>2</kbd></button><button data-cmd="pause">一時停止<kbd>4</kbd></button>
  </div>
  <div class="row" style="margin-top:6px"><button data-cmd="reset">やり直し<kbd>R</kbd></button><label class="kv">試合時間 <input id="secIn" type="number" min="10" max="600" step="10" style="width:64px"> 秒</label></div>
  <p class="why" id="why"></p>
  <h3>プレイヤー</h3>
  <div class="players2">${['A', 'B'].map(s => `
    <div class="pc" data-s="${s}"><div class="row" style="justify-content:space-between"><b style="color:var(--${s})">${s} ${ELEMENT_JA[s === 'A' ? 'fire' : 'thunder']}</b><span class="num hpv"></span></div>
      <div class="facts"></div>
      <div class="row" style="margin-top:4px"><button data-act="shoot">小（溜めなし）</button><button data-act="charge">押して溜め</button><button data-act="special" title="5 秒あまり溜めてから撃つ（溜め中は動くと失敗）">大（溜めて撃つ）</button></div></div>`).join('')}
  </div>
  <h3>プレイヤーの動き（ダミー映像）</h3>
  <div id="playGame"></div>
  <h3>ゲームの数値（試遊で調整）</h3>
  <div class="rules">
    <label>中になる溜め時間 <input data-rule="t1" type="number" min="0.1" max="20" step="0.1"> 秒</label>
    <label>大になる溜め時間 <input data-rule="t2" type="number" min="0.2" max="30" step="0.1"> 秒</label>
    <label>小のダメージ <input data-rule="dmg.s" type="number" min="0" max="100" step="1"></label>
    <label>中のダメージ <input data-rule="dmg.m" type="number" min="0" max="100" step="1"></label>
    <label>大のダメージ <input data-rule="dmg.l" type="number" min="0" max="100" step="1"></label>
    <label>小の連打の間隔 <input data-rule="rapid" type="number" min="0" max="3" step="0.05"> 秒</label>
    <label>溜め失敗になる移動 <input data-rule="moveFail" type="number" min="5" max="300" step="5" data-scale="100"> cm</label>
    <label title="1 が今の大きさ。見た目と当たりの大きさが一緒に変わる">小の玉の大きさ <input data-rule="size.s" type="number" min="0.2" max="4" step="0.1"> 倍</label>
    <label title="1 が今の大きさ。見た目と当たりの大きさが一緒に変わる">中の玉の大きさ <input data-rule="size.m" type="number" min="0.2" max="4" step="0.1"> 倍</label>
    <label title="1 が今の大きさ。見た目と当たりの大きさが一緒に変わる">大の玉の大きさ <input data-rule="size.l" type="number" min="0.2" max="4" step="0.1"> 倍</label>
    <div class="row"><button id="rulesReset">初期値に戻す</button><span class="muted" id="rulesNote"></span></div>
  </div>
  <h3>エフェクトを試す</h3>
  <div class="seg" id="fxStyles"><button data-fxstyle="smash">プログラム版</button><button data-fxstyle="textured">画像素材版</button><button data-fxstyle="classic">いつもの</button></div>
  <p class="muted" style="font-size:12px;margin:4px 0">試合中でなくても出る。ダメージは入らない。弾は相手の胸に向けて撃つ。「溜め」は押している間溜まり、離すとその段階の技を撃つ</p>
  <div class="fxtry">${['A', 'B'].map(s => `<div class="row"><b style="color:var(--${s});width:1.4em">${s}</b>${['s', 'm', 'l'].map(t => `<button data-fxshot="${t}" data-s="${s}">${TIER_JA[t]}</button>`).join('')}<button data-fxcharge data-s="${s}">溜め（押している間）</button></div>`).join('')}</div>
  <h3>カメラ（ドローン視点）<kbd>D</kbd></h3>
  <div class="seg" id="drones">${Object.entries(DRONE_JA).map(([k, v]) => `<button data-drone="${k}">${v}</button>`).join('')}</div>
  <h3>表示</h3>
  <div class="row"><button data-tog="minimap">ミニマップ<kbd>M</kbd></button><button data-tog="debug">デバッグ<kbd>G</kbd></button></div>
  <h3>攻撃・防御の記録</h3>
  <ul class="log" id="gameLog"></ul>`;
for (const b of gameCtrl.querySelectorAll('[data-phase]')) b.onclick = () => game.command({ cmd: 'phase', phase: b.dataset.phase });
gameCtrl.querySelector('[data-cmd=pause]').onclick = () => game.command({ cmd: 'pause' });
gameCtrl.querySelector('[data-cmd=reset]').onclick = () => game.command({ cmd: 'reset' });
const secIn = $('#secIn'); secIn.value = cfg.matchSec;
secIn.onchange = () => { cfg.matchSec = Math.max(10, +secIn.value || 60); save(); game.command({ cmd: 'matchSec', value: cfg.matchSec }); };
// rules: written straight into cfg.rules, which game.js reads every time
const ruleIns = [...gameCtrl.querySelectorAll('[data-rule]')];
const ruleGet = k => k.split('.').reduce((o, x) => o?.[x], cfg.rules), ruleSet = (k, v) => { const ks = k.split('.'), last = ks.pop(); ks.reduce((o, x) => o[x], cfg.rules)[last] = v; };
function showRules() {
  for (const i of ruleIns) i.value = +(ruleGet(i.dataset.rule) * (+i.dataset.scale || 1)).toFixed(2);
  const r = cfg.rules;
  $('#rulesNote').textContent = r.t2 > r.t1 ? `0〜${r.t1}秒 小 / ${r.t1}〜${r.t2}秒 中 / ${r.t2}秒〜 大` : '大になる時間は中より長くする';
}
for (const i of ruleIns) i.onchange = () => {
  const v = +i.value; if (!Number.isFinite(v)) return showRules();
  ruleSet(i.dataset.rule, Math.max(+i.min, Math.min(+i.max, v)) / (+i.dataset.scale || 1));
  if (cfg.rules.t2 <= cfg.rules.t1) cfg.rules.t2 = +(cfg.rules.t1 + .5).toFixed(2);
  save(); showRules();
};
for (const b of gameCtrl.querySelectorAll('[data-fxstyle]')) b.onclick = () => { cfg.fxStyle = b.dataset.fxstyle; save(); stage.fx.setStyle(cfg.fxStyle); };
for (const b of gameCtrl.querySelectorAll('[data-fxshot]')) b.onclick = () => game.command({ cmd: 'fxShot', slot: b.dataset.s, tier: b.dataset.fxshot });
for (const b of gameCtrl.querySelectorAll('[data-fxcharge]')) {
  b.onpointerdown = () => game.command({ cmd: 'fxCharge', slot: b.dataset.s, on: true });
  b.onpointerup = () => game.command({ cmd: 'fxCharge', slot: b.dataset.s, on: false, fire: true });
  b.onpointerleave = () => game.command({ cmd: 'fxCharge', slot: b.dataset.s, on: false });
}
$('#rulesReset').onclick = () => { cfg.rules = { ...RULES, dmg: { ...RULES.dmg }, size: { ...RULES.size } }; save(); showRules(); };
showRules();
for (const pc of gameCtrl.querySelectorAll('.pc')) for (const b of pc.querySelectorAll('[data-act]')) {
  const slot = pc.dataset.s, a = b.dataset.act;
  if (a === 'charge') { b.onpointerdown = () => game.command({ cmd: 'charge', slot, on: true }); b.onpointerup = b.onpointerleave = () => game.command({ cmd: 'charge', slot, on: false }); b.title = '押している間溜める'; }
  else b.onclick = () => game.command({ cmd: a, slot });
}
for (const b of gameCtrl.querySelectorAll('[data-drone]')) b.onclick = () => { stage.drone.setMode(b.dataset.drone); cfg.drone = b.dataset.drone; save(); };
const toggle = k => { cfg[k] = !cfg[k]; save(); };
for (const b of document.querySelectorAll('[data-tog]')) b.onclick = () => toggle(b.dataset.tog);

// ---- final screen toolbar ----
const finalBar = $('#finalBar');
playable.mountControl($('#playGame'));
const finalControls = createFinalControls({ bar: finalBar, stage, game, vsrc, cfg, save, scan, fullscreen, playable, vision });
function fullscreen() { const box = $('#finalBox'); document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen?.().then(() => setTimeout(stage.resize, 100)); }
document.addEventListener('fullscreenchange', () => setTimeout(stage.resize, 50));
async function scan() { game.command({ cmd: 'phase', phase: 'setup' }); vsrc.dummy?.showPlayers(false); await stage.scan(); vsrc.dummy?.showPlayers(true); }

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
    <label class="f"><span>タグ中心の高さ</span><input type="number" id="tagHeight" min="0.1" max="3" step="0.05"><output>m</output></label>
    <p class="note" id="fovNote"></p>
    <div class="row"><button id="forgetFov">覚えた画角を消す</button><button id="clearScan">スキャン結果を消す</button></div>
    <p class="note">人がいない状態で、フィールドの角に置いたタグがスマホ C の映像に全部入るようにしてからスキャンする。床のタグなら 2 枚のとき左が A 側。</p></section>
  <section><h3>ゲーム</h3>
    <label class="f"><span>狙い</span><select id="aimSel"><option value="motion">止める直前の棒の先の動き</option><option value="stick">止めたときの棒の向き</option><option value="eye">目から棒先へ</option></select><span></span></label>
    <div class="row"><button data-tog="test">テスト（HP が減らない）</button><button data-tog="useTruth">正解位置（シミュレーター）</button></div></section>
  <section><h3>音</h3>
    ${['master:全体', 'bgm:BGM', 'sfx:効果音', 'amb:環境音'].map(x => { const [k, n] = x.split(':'); return `<label class="f"><span>${n}</span><input type="range" min="0" max="1" step="0.01" data-vol="${k}"><output data-volout="${k}"></output></label>`; }).join('')}
    <div class="row"><button id="mute">消音</button><span class="note" id="audioInfo"></span></div>
    <div class="row" style="margin-top:6px">${[['shotFire', '炎の発射'], ['shotThunder', '雷の発射'], ['hitFire', '炎の命中'], ['hitThunder', '雷の命中'], ['specialFire', '炎の大'], ['specialThunder', '雷の大']].map(([k, n]) => `<button data-sound="${k}">${n}</button>`).join('')}</div></section>
  <section><h3>キー操作</h3><table class="keys">
    <tr><td>Alt+1〜4</td><td>画面の切り替え</td></tr><tr><td>1 2 3 4</td><td>準備中・デモ試合開始（撃った瞬間に相手を狙う）・試合開始・一時停止</td></tr><tr><td>R</td><td>やり直し</td></tr>
    <tr><td>Space / Enter</td><td>A / B が小の攻撃（溜めなし）</td></tr><tr><td>Q / P 長押し</td><td>A / B が溜める（離した時の溜め時間で小・中・大）</td></tr>
    <tr><td>K</td><td>タグでスキャン</td></tr><tr><td>D</td><td>ドローン視点の切り替え</td></tr><tr><td>M / G</td><td>ミニマップ / デバッグ表示</td></tr><tr><td>F</td><td>最終映像を全画面</td></tr><tr><td>S</td><td>設定</td></tr></table></section>`;
$('#openSettings').onclick = () => drawer.classList.toggle('open');
$('#closeSettings').onclick = () => drawer.classList.remove('open');
for (const g of drawer.querySelectorAll('[data-seg]')) for (const b of g.querySelectorAll('button')) b.onclick = () => {
  const k = g.dataset.seg; cfg[k] = k === 'tagMode' ? +b.dataset.v : b.dataset.v; save();
};
for (const b of drawer.querySelectorAll('[data-tog]')) b.onclick = () => toggle(b.dataset.tog);
const tagH = $('#tagHeight'); tagH.value = cfg.tagHeight; tagH.onchange = () => { cfg.tagHeight = Math.max(.1, Math.min(3, +tagH.value || 1)); save(); };
$('#forgetFov').onclick = () => { cfg.knownFov = null; save(); };
$('#clearScan').onclick = () => confirm('スキャンしたフィールドとカメラの位置を消しますか？') && stage.clearScan();
const aimSel = $('#aimSel'); aimSel.value = cfg.aim; aimSel.onchange = () => { cfg.aim = aimSel.value; save(); };
for (const r of drawer.querySelectorAll('[data-vol]')) r.oninput = () => {
  sfx?.setVolume(r.dataset.vol, +r.value);
  try { localStorage.setItem('pd-vol', JSON.stringify(sfx?.volumes ?? {})); } catch {}
};
$('#mute').onclick = () => sfx?.setMuted(!sfx.muted);
for (const b of drawer.querySelectorAll('[data-sound]')) b.onclick = () => {
  if (!sfx) return; sfx.unlock?.();
  ({ shotFire: () => sfx.shot('fire', 0, .6), shotThunder: () => sfx.shot('thunder', 0, .6), hitFire: () => sfx.hit('fire', 0, .7), hitThunder: () => sfx.hit('thunder', 0, .7),
    specialFire: () => { sfx.special('fire', 0); sfx.hit('fire', 0, 1, 'l'); }, specialThunder: () => { sfx.special('thunder', 0); sfx.hit('thunder', 0, 1, 'l'); } })[b.dataset.sound]?.();
};

// ---- keys ----
const KEYS = { 1: { cmd: 'phase', phase: 'setup' }, 2: { cmd: 'phase', phase: 'demo' }, 3: { cmd: 'phase', phase: 'fight' }, 4: { cmd: 'pause' }, r: { cmd: 'reset' },
  ' ': { cmd: 'shoot', slot: 'A' }, Enter: { cmd: 'shoot', slot: 'B' } };
const held = { q: 'A', p: 'B' };
addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.repeat || e.ctrlKey || e.metaKey) return;
  if (e.altKey) { const n = { Digit1: 'connect', Digit2: 'space', Digit3: 'game', Digit4: 'final' }[e.code]; if (n) { e.preventDefault(); show(n); } return; }
  if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (held[k] && screen !== 'final') return game.command({ cmd: 'charge', slot: held[k], on: true });
  if (KEYS[k]) return game.command(KEYS[k]);
  if (k === 'k') scan();
  else if (k === 'd') { stage.drone.next(); cfg.drone = stage.drone.mode; save(); }
  else if (k === 'm') toggle('minimap'); else if (k === 'g') toggle('debug');
  else if (k === 'f' && screen === 'final') fullscreen();
  else if (k === 's') drawer.classList.toggle('open');
  else if (k === 'Escape') drawer.classList.remove('open');
});
addEventListener('keyup', e => { const k = e.key.toLowerCase(); if (held[k] && screen !== 'final') game.command({ cmd: 'charge', slot: held[k], on: false }); });

// ---- per-frame UI ----
function pill(id, state) { const p = $(id); p.classList.toggle('on', state === true); p.classList.toggle('half', state === 'half'); }
const hudP = Object.fromEntries(['A', 'B'].map(s => { const el = hud.querySelector('.pl.' + s); return [s, { el, hp: el.querySelector('.hp i'), ch: el.querySelector('.ch'), chi: el.querySelector('.ch i'), hpn: el.querySelector('.hpn'), act: el.querySelector('.act'), tick: el.querySelector('.ch b'), chips: Object.fromEntries([...el.querySelectorAll('.chips span')].map(c => [c.className.split(' ')[0], c])) }]; }));
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
function updateHud() {
  const m = game.match;
  for (const p of Object.values(game.players)) {
    const h = hudP[p.slot];
    h.hp.style.width = p.hp + '%'; setText(h.hpn, String(Math.round(p.hp)));
    h.chi.style.width = (p.charging ? p.charge * 100 : 0) + '%';
    for (const t of ['m', 'l']) h.ch.classList.toggle(t, p.charging && p.tier === t);
    h.tick.style.left = (100 * Math.min(1, cfg.rules.t1 / cfg.rules.t2)) + '%';
    h.chips.off.classList.toggle('on', !p.online && !p.imu);
    h.chips.charge.classList.toggle('on', p.charging);
    setText(h.chips.charge, p.charging ? `溜め ${TIER_JA[p.tier] ?? '小'} ${p.chargeT.toFixed(1)}s` : '溜め中');
    setText(h.act, game.actText(p));
  }
  const showTimer = m.phase === 'fight' || m.phase === 'result';
  setText(hud.querySelector('.timer'), showTimer ? `${Math.floor(Math.ceil(m.left) / 60)}:${String(Math.ceil(m.left) % 60).padStart(2, '0')}` : '');
  const pp = hud.querySelector('.phasepill'), pt = m.phase === 'setup' ? (stage.state.scanned ? '準備中（スキャン済み）' : '準備中') : m.mode === 'demo' ? 'デモ試合（相手を狙って撃つ）' : '';
  setText(pp, pt); pp.style.display = pt ? '' : 'none';
  const bt = game.bannerText(), bn = hud.querySelector('.banner');
  bn.style.display = bt ? 'grid' : 'none'; setText(bn, bt);
  setText(hud.querySelector('.status'), cfg.debug ? `位置: A ${POS_JA[game.players.A.src] ?? game.players.A.src} / B ${POS_JA[game.players.B.src] ?? game.players.B.src}　ドローン: ${DRONE_JA[stage.drone.mode]}（${stage.drone.shot}）　${stage.state.msg}` : '');
}
const LOG_ICON = { shot: '発射', special: '大', hit: '命中', charge: '溜め', phase: '進行', win: '勝敗' };
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
  for (const b of gameCtrl.querySelectorAll('[data-fxstyle]')) b.classList.toggle('on', b.dataset.fxstyle === stage.fx.style);
  for (const b of finalBar.querySelectorAll('[data-fpv]')) b.classList.toggle('on', (b.dataset.fpv || null) === cfg.fpv);
  for (const g of drawer.querySelectorAll('[data-seg]')) for (const b of g.querySelectorAll('button')) b.classList.toggle('on', String(cfg[g.dataset.seg]) === b.dataset.v);
  $('#why').textContent = !stage.state.scanned ? '未スキャン：最終映像の位置はずれます（最終映像の画面で「タグでスキャン」）' : !hub.phones.A.online && !hub.phones.B.online ? 'スマホ A・B が未接続：キーかボタンで操作できます' : '';
  for (const pc of gameCtrl.querySelectorAll('.pc')) {
    const p = P[pc.dataset.s];
    pc.querySelector('.hpv').textContent = `HP ${Math.round(p.hp)}`;
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
  $('#audioInfo').textContent = !sfx ? '読み込み中' : !sfx.unlocked ? 'ページを一度クリックすると音が出ます' : '';
}

/** Where the sensors put each player in phone C's picture (0..1), for naming the people found and as the stick's prior. */
function visionHints() {
  if (cfg.fpv || !(stage.state.scanned || video.__dummy)) return {};
  const uv = p => { const q = p.clone().project(stage.camera); return q.z < 1 && Math.abs(q.x) < 1.5 && Math.abs(q.y) < 1.5 ? [(q.x + 1) / 2, (1 - q.y) / 2] : null; };
  const out = {}, w = video.__dummy?.canvas.width ?? video.videoWidth, h = video.__dummy?.canvas.height ?? video.videoHeight;
  for (const s of ['A', 'B']) {
    const p = game.players[s], chest = p.src === 'start' ? null : uv(p.chest), b = uv(p.base), t = uv(p.tip);
    const real = p.stickSrc !== 'IMU なし（前向き）'; // only a measured stick direction helps the search
    out[s] = { chest, stick: real && b && t ? { x: b[0], y: b[1], a: Math.atan2((t[1] - b[1]) * h, (t[0] - b[0]) * w) } : null };
  }
  return out;
}

// ---- main loop ----
let last = performance.now() / 1000, fps = 60, lastSlow = 0, est = PA.estimate(nowS());
function frame(ts) {
  requestAnimationFrame(frame);
  if (ts && ts - (frame.at ?? -1e9) < 1000 / 60 - 2) return; // 120 Hz screens: no visible gain for twice the work
  frame.at = ts;
  const t = performance.now() / 1000, raw = t - last, dt = Math.min(.05, raw); last = t;
  fps = .95 * fps + .05 / Math.max(raw, 1e-3);
  try { est = PA.estimate(nowS()); } catch (e) { console.warn('phonealign', e); }
  playable.step(dt, t);
  vsrc.dummy?.render(t); // the picture and game placement consume this exact same pose snapshot
  game.step(dt, raw, est, { sensorOnly: screen === 'final' });
  if (screen === 'final') finalControls.step(t);
  vision.want(!!cfg.visOn && screen === 'final' && !cfg.fpv && VIS_KEYS.some(k => cfg[k]));
  if (screen === 'final') vision.setHints(visionHints());
  if (screen === 'game' || screen === 'final') { stage.render(dt, game, est); updateHud(); }
  else stage.fx.step(dt); // effects keep their time even when nobody looks
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
