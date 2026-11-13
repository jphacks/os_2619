// サンドボックス (screen 7): every stage of the pipeline side by side, on white, to see and show how the game works.
//  1 生の ARCore 座標: each phone's own AR position (its trail, seen from above, in its own ARCore frame) and the stick IMU's raw angles (split A | B)
//  2 魔法陣で統合: both players and their sticks in the field's frame, after the mahoujin tags tied the phones together (game.js players)
//  3 3D ワイヤフレーム: the same in 3D as wire shapes, with the shots in flight, the guard and the charge (drag to turn)
//  4 ゲーム画面: the real game picture (stage.js), attached here while this screen shows
// Buttons fire every move in any phase (game.js try-outs: fxShot, fxCharge, tryGuard, tryDodge, tryElement). Live, or a freeze frame: ~30
// presets play a move and stop time at its telling moment (app.js stops the game clock and the effects while `frozen`).
// mountSandbox(section, { hub, game, stage, rules: () => the game's rules }) -> { get frozen, setActive(on), frame() }
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as W from './world.js';
import { eulerRot } from './actions.js';
import { qrot } from './map.js';
import { parseDesign } from './stickscan.js';

const COL = { A: '#ff6600', B: '#0078ff' }, EL_JA = { fire: '炎', thunder: '雷', water: '水', wind: '風' }, D = 180 / Math.PI;
const CIRCLE_R = .703 * W.RUNE_SCALE; // m: the mahoujin's outer ring (finished circle Ø 140.6 cm at scale 1)

export function mountSandbox(section, { hub, game, stage, rules = () => ({}) }) {
  section.innerHTML = `<style>
    #scr-sandbox { background: #fff; color: #1d2330; overflow: auto; }
    .sbx { display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: auto minmax(0, 1fr); gap: 10px; padding: 10px; min-height: 100%; box-sizing: border-box; }
    .sbx-bar { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .sbx-bar button, .sbx-bar select { background: #fff; color: #1d2330; border: 1px solid #c8cdd6; border-radius: 6px; padding: 6px 10px; font: inherit; cursor: pointer; }
    .sbx-bar button:hover { background: #f1f3f7; } .sbx-bar button.on { background: #1d2330; color: #fff; border-color: #1d2330; }
    .sbx-bar .sep { width: 1px; height: 24px; background: #dde1e8; margin: 0 4px; }
    .sbx-mode { font-weight: 700; padding: 4px 10px; border-radius: 999px; background: #e8f6ec; color: #13703a; }
    .sbx-mode.frozen { background: #e9f0ff; color: #1d4fd8; }
    .sbx-grid { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: minmax(260px, 1fr) minmax(260px, 1fr); gap: 10px; min-height: 0; }
    .sbx-grid > section { border: 1px solid #dde1e8; border-radius: 8px; display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; overflow: hidden; background: #fff; }
    .sbx-grid h3 { margin: 0; padding: 6px 10px; font-size: 13px; border-bottom: 1px solid #eef0f4; color: #4a5263; font-weight: 600; }
    .sbx-split { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #eef0f4; min-height: 0; }
    .sbx canvas { width: 100%; height: 100%; display: block; background: #fff; min-height: 0; }
    .sbx [data-wire], .sbx [data-game] { position: relative; min-height: 0; }
    .sbx [data-game] { background: #000; overflow: hidden; z-index: 0; }
    .sbx-grid > section > h3 { position: relative; z-index: 1; background: #fff; }
    .sbx-presets { border: 1px solid #dde1e8; border-radius: 8px; padding: 8px; overflow: auto; min-height: 0; }
    .sbx-presets h3 { margin: 0 0 6px; font-size: 13px; color: #4a5263; }
    .sbx-presets h4 { margin: 10px 0 4px; font-size: 11px; color: #8a91a0; font-weight: 600; letter-spacing: .05em; }
    .sbx-presets button { display: block; width: 100%; text-align: left; margin: 2px 0; padding: 5px 8px; border: 1px solid #e3e6ec; border-radius: 6px; background: #fff; color: #1d2330; font: inherit; font-size: 12px; cursor: pointer; }
    .sbx-presets button:hover { background: #f4f6fa; } .sbx-presets button.on { background: #1d4fd8; color: #fff; border-color: #1d4fd8; }
    .sbx-presets button i { color: #8a91a0; font-style: normal; margin-right: 4px; } .sbx-presets button.on i { color: #cdd8ff; }
  </style>
  <div class="sbx">
    <div class="sbx-bar">
      <span class="sbx-mode" data-mode>ライブ</span><button data-live>ライブに戻る</button><span class="sep"></span>
      <span>プレイヤー</span><button data-slot="A" class="on">A</button><button data-slot="B">B</button><span class="sep"></span>
      <button data-shot="s">小を撃つ</button><button data-shot="m">中を撃つ</button><button data-shot="l">大を撃つ</button>
      <button data-charge title="押している間ためる。離すと、たまった段階で撃つ">チャージ（長押し）</button>
      <button data-guard>ガード</button><button data-dodge="-1">← 回避</button><button data-dodge="1">回避 →</button>
      <select data-el title="技の属性"><option value="">属性：棒のまま</option>${Object.entries(EL_JA).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    </div>
    <div class="sbx-grid">
      <section><h3>1　生の ARCore 座標（スマホごと・上から）と棒の IMU の角度</h3><div class="sbx-split"><canvas data-raw="A"></canvas><canvas data-raw="B"></canvas></div></section>
      <section><h3>2　魔法陣で統合した位置と棒の向き（上から）</h3><canvas data-merged></canvas></section>
      <section><h3>3　3D ワイヤフレーム（ドラッグで回す）</h3><div data-wire></div></section>
      <section><h3>4　ゲーム画面</h3><div class="stagebox" data-game></div></section>
    </div>
    <aside class="sbx-presets"><h3>フリーズフレーム</h3><div data-presets></div></aside>
  </div>`;
  const $ = s => section.querySelector(`[data-${s}]`);
  const P = () => game.players;
  let slot = 'A', active = false, frozen = false, running = 0, guardOn = { A: false, B: false };

  // ---- raw packets per phone (hub), frozen with the rest ----
  const raw = { A: { trail: [], ar: null, imu: null }, B: { trail: [], ar: null, imu: null } };
  hub.on(k => {
    if (frozen || !raw[k.slot]) return;
    const r = raw[k.slot];
    if (k.type === 'ar' && k.wp) { r.ar = k; r.trail.push([k.wp[0], k.wp[2]]); if (r.trail.length > 400) r.trail.shift(); }
    if (k.type === 'imu') r.imu = k;
  });

  // ---- 2D panels ----
  const fit = c => { const w = c.clientWidth, h = c.clientHeight, d = devicePixelRatio; if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); } const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h); return [g, w, h]; };
  const text = (g, s, x, y, col = '#4a5263', font = '12px system-ui') => { g.fillStyle = col; g.font = font; g.fillText(s, x, y); };
  const arrow = (g, x, y, dx, dy, col, w = 2) => { const L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L; g.strokeStyle = g.fillStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx, y + dy); g.stroke();
    g.beginPath(); g.moveTo(x + dx, y + dy); g.lineTo(x + dx - 8 * ux + 4 * uy, y + dy - 8 * uy - 4 * ux); g.lineTo(x + dx - 8 * ux - 4 * uy, y + dy - 8 * uy + 4 * ux); g.fill(); };
  function drawRaw(s) {
    const [g, w, h] = fit(section.querySelector(`[data-raw="${s}"]`)), r = raw[s];
    text(g, `スマホ ${s}`, 8, 16, COL[s], 'bold 13px system-ui');
    if (!r.ar) { text(g, 'ARCore のデータなし', 8, 36, '#8a91a0'); } else {
      const [cx, cz] = [r.ar.wp[0], r.ar.wp[2]], k = Math.min(w, h) / 4; // ±2 m round the phone
      const X = x => w / 2 + (x - cx) * k, Z = z => h / 2 + 10 + (z - cz) * k;
      g.strokeStyle = '#eef0f4'; g.lineWidth = 1; g.beginPath();
      for (let v = Math.ceil((cx - 3) * 2) / 2; v < cx + 3; v += .5) { g.moveTo(X(v), 0); g.lineTo(X(v), h); }
      for (let v = Math.ceil((cz - 3) * 2) / 2; v < cz + 3; v += .5) { g.moveTo(0, Z(v)); g.lineTo(w, Z(v)); }
      g.stroke();
      g.strokeStyle = COL[s] + '66'; g.lineWidth = 1.5; g.beginPath(); r.trail.forEach(([x, z], i) => g[i ? 'lineTo' : 'moveTo'](X(x), Z(z))); g.stroke();
      const f = qrot(r.ar.wq, [0, 0, -1]); g.fillStyle = COL[s]; g.beginPath(); g.arc(X(cx), Z(cz), 5, 0, 7); g.fill();
      arrow(g, X(cx), Z(cz), f[0] * 40, f[2] * 40, COL[s]);
      text(g, `ARCore x ${cx.toFixed(2)}  y ${r.ar.wp[1].toFixed(2)}  z ${cz.toFixed(2)} m  ${r.ar.tracking}`, 8, h - 8, '#4a5263', '11px ui-monospace, monospace');
    }
    if (r.imu) { // the stick: its elevation and raw heading in the IMU's own frame, as a small dial
      const d = eulerRot(r.imu.euler, W.STICK.axis), el = Math.asin(Math.max(-1, Math.min(1, d[2]))) * D, hd = Math.atan2(d[1], d[0]), R = 30, ox = w - R - 10, oy = R + 26;
      g.strokeStyle = '#c8cdd6'; g.lineWidth = 1; g.beginPath(); g.arc(ox, oy, R, 0, 7); g.stroke();
      arrow(g, ox, oy, Math.cos(hd) * R * Math.cos(el / D), -Math.sin(hd) * R * Math.cos(el / D), '#1d2330', 2);
      text(g, `棒 仰角 ${el.toFixed(0)}°`, ox - R - 12, oy + R + 16, '#1d2330', '11px system-ui');
      text(g, `ジャイロ ${Math.hypot(...r.imu.gyro).toFixed(0)}°/s`, ox - R - 12, oy + R + 30, '#8a91a0', '11px system-ui');
    }
  }
  function drawMerged() {
    const [g, w, h] = fit($('merged')), k = Math.min(w / 5.5, h / 4), X = x => w / 2 + x * k, Z = z => h / 2 + z * k;
    g.strokeStyle = '#eef0f4'; g.lineWidth = 1; g.beginPath();
    for (let v = -3; v <= 3; v += .5) { g.moveTo(X(v), 0); g.lineTo(X(v), h); g.moveTo(0, Z(v)); g.lineTo(w, Z(v)); }
    g.stroke();
    g.strokeStyle = '#1d2330'; g.lineWidth = 1.5; g.beginPath(); g.arc(X(0), Z(0), CIRCLE_R * k, 0, 7); g.stroke(); // the mahoujin
    for (const id of W.CORNER_IDS) { const t = W.TAGS[id]; if (!t.floor) continue; g.fillStyle = '#1d2330'; g.fillRect(X(t.pos[0]) - 3, Z(t.pos[2]) - 3, 6, 6); text(g, `T${id}`, X(t.pos[0]) + 5, Z(t.pos[2]) - 4, '#8a91a0', '10px system-ui'); }
    for (const s of ['A', 'B']) {
      const p = P()[s], c = p.chest, f = W.app3(p.body.R, [1, 0, 0]);
      g.fillStyle = COL[s]; g.beginPath(); g.arc(X(c.x), Z(c.z), 7, 0, 7); g.fill();
      arrow(g, X(c.x), Z(c.z), f[0] * 30, f[2] * 30, COL[s] + '99', 1.5);
      g.strokeStyle = '#1d2330'; g.lineWidth = 3; g.beginPath(); g.moveTo(X(p.base.x), Z(p.base.z)); g.lineTo(X(p.tip.x), Z(p.tip.z)); g.stroke();
      const st = [p.guarding && 'ガード', p.charging && `チャージ ${Math.round((p.charge ?? 0) * 100)}%`, p.dodge && '回避中', EL_JA[p.element]].filter(Boolean).join('・');
      text(g, `${s}  ${st}`, X(c.x) - 30, Z(c.z) + 24, COL[s], 'bold 12px system-ui');
      text(g, `(${c.x.toFixed(2)}, ${c.z.toFixed(2)}) m  棒 仰角 ${(Math.asin(Math.max(-1, Math.min(1, p.dir.y))) * D).toFixed(0)}°  位置 ${p.src ?? ''}`, X(c.x) - 30, Z(c.z) + 38, '#8a91a0', '10px system-ui');
    }
    for (const sh of game.shots) { g.strokeStyle = COL[sh.owner.slot]; g.lineWidth = 2; g.beginPath(); g.arc(X(sh.pos.x), Z(sh.pos.z), { s: 4, m: 7, l: 11 }[sh.tier] ?? 5, 0, 7); g.stroke(); }
    text(g, '上が奥（+z が下）。黒線：棒、矢印：体の向き、丸：飛んでいる弾', 8, h - 8, '#8a91a0', '11px system-ui');
  }

  // ---- 3D wireframe ----
  const box3 = $('wire'), renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setClearColor(0xffffff); box3.append(renderer.domElement); renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(45, 1, .05, 50); cam.position.set(0, 3.2, 4.2);
  const orbit = new OrbitControls(cam, renderer.domElement); orbit.target.set(0, .8, 0); orbit.update();
  scene.add(new THREE.GridHelper(6, 12, 0xc8cdd6, 0xeef0f4));
  // the mahoujin on the floor as it looks: its print (black lines) at its measured size, T0 toward -x as on the real floor (world.js runeTagPos)
  fetch('mahoujin-design.bin.gz')
    .then(r => r.ok ? new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : Promise.reject(new Error(r.status)))
    .then(b => {
      const d = parseDesign(new Uint8Array(b)), c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
      const g = c.getContext('2d'), img = g.createImageData(d.w, d.h);
      for (let i = 0; i < d.ink.length; i++) { const k = d.ink[i]; img.data.set([29, 35, 48, k > 110 ? k : 0], 4 * i); } // faint construction lines left out
      g.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const mm = W.RUNE_SCALE / 1000, m = new THREE.Mesh(new THREE.PlaneGeometry(d.w * mm, d.h * mm), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      // the print's +u (right) is the floor's -z and its +v (down) the floor's +x (stickscan.js designPx): turn the plane to match, centre (cx, cy) on the origin
      m.rotation.set(-Math.PI / 2, 0, Math.PI / 2); // plane +x (print right) -> floor -z, plane -y (print down) -> floor +x
      m.position.set((d.h / 2 - d.cy) * mm, .002, (d.cx - d.w / 2) * mm);
      scene.add(m);
    }).catch(e => console.warn('sandbox: mahoujin', e));
  const wire = c => new THREE.MeshBasicMaterial({ color: c, wireframe: true }), line = c => new THREE.LineBasicMaterial({ color: c });
  const fig = {};
  for (const s of ['A', 'B']) {
    const c = new THREE.Color(COL[s]), g = new THREE.Group(); scene.add(g);
    const chest = new THREE.Mesh(new THREE.SphereGeometry(.14, 10, 8), wire(c)), head = new THREE.Mesh(new THREE.SphereGeometry(.1, 8, 6), wire(c));
    const body = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), line(c));
    const stick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x1d2330 }));
    const face = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), .4, c);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(.5, .01, 4, 32), wire(0x2266ff)), charge = new THREE.Mesh(new THREE.TorusGeometry(.35, .01, 4, 32), wire(0xffaa00));
    guard.rotation.x = Math.PI / 2; charge.rotation.x = Math.PI / 2;
    g.add(chest, head, body, stick, face, guard, charge); fig[s] = { chest, head, body, stick, face, guard, charge };
  }
  const shotPool = [], shotGeo = new THREE.IcosahedronGeometry(1, 1);
  function draw3D() {
    const w = box3.clientWidth, h = box3.clientHeight; if (!w || !h) return;
    if (renderer.domElement.width !== Math.round(w * devicePixelRatio)) { renderer.setPixelRatio(devicePixelRatio); renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    for (const s of ['A', 'B']) {
      const p = P()[s], F = fig[s], c = p.chest, f = W.app3(p.body.R, [1, 0, 0]);
      F.chest.position.copy(c); F.head.position.set(c.x, c.y + .35, c.z);
      F.body.geometry.setFromPoints([new THREE.Vector3(c.x, c.y, c.z), new THREE.Vector3(c.x, 0, c.z)]);
      F.stick.geometry.setFromPoints([p.base, p.tip]);
      F.face.position.set(c.x, c.y, c.z); F.face.setDirection(new THREE.Vector3(f[0], 0, f[2]).normalize());
      F.guard.visible = !!p.guarding; F.guard.position.copy(p.base.clone().lerp(p.tip, .5));
      F.charge.visible = !!p.charging || p.preview != null; F.charge.position.set(c.x, .02, c.z); F.charge.scale.setScalar(.5 + (p.charge ?? .5));
    }
    game.shots.forEach((sh, i) => {
      let m = shotPool[i]; if (!m) { m = new THREE.Mesh(shotGeo, wire(0)); shotPool.push(m); scene.add(m); }
      m.visible = true; m.material.color.set(COL[sh.owner.slot]); m.position.copy(sh.pos); m.scale.setScalar({ s: .08, m: .16, l: .28 }[sh.tier] ?? .1);
    });
    for (let i = game.shots.length; i < shotPool.length; i++) shotPool[i].visible = false;
    renderer.render(scene, cam);
  }

  // ---- moves (any phase: game.js try-outs) ----
  const cmd = c => game.command({ slot, ...c });
  const setGuard = (s, on) => { guardOn[s] = on; game.command({ cmd: 'tryGuard', slot: s, on }); section.querySelector('[data-guard]').classList.toggle('on', guardOn[slot]); };
  for (const b of section.querySelectorAll('[data-slot]')) b.onclick = () => { slot = b.dataset.slot; for (const q of section.querySelectorAll('[data-slot]')) q.classList.toggle('on', q === b); $('guard').classList.toggle('on', guardOn[slot]); $('el').value = P()[slot].tryElement ?? ''; };
  for (const b of section.querySelectorAll('[data-shot]')) b.onclick = () => { goLive(); cmd({ cmd: 'fxShot', tier: b.dataset.shot }); };
  const ch = $('charge');
  ch.onpointerdown = () => { goLive(); cmd({ cmd: 'fxCharge', on: true }); };
  ch.onpointerup = () => cmd({ cmd: 'fxCharge', on: false, fire: true });
  ch.onpointerleave = () => { if (P()[slot].preview != null) cmd({ cmd: 'fxCharge', on: false, fire: true }); };
  $('guard').onclick = () => { goLive(); setGuard(slot, !guardOn[slot]); };
  for (const b of section.querySelectorAll('[data-dodge]')) b.onclick = () => { goLive(); cmd({ cmd: 'tryDodge', side: +b.dataset.dodge }); };
  $('el').onchange = () => cmd({ cmd: 'tryElement', element: $('el').value || null });

  // ---- freeze frames ----
  const wait = sec => new Promise(r => setTimeout(r, sec * 1000));
  const until = async (f, max = 3) => { const t0 = performance.now(); while (!f() && performance.now() - t0 < max * 1000) await wait(.016); };
  const shotOf = s => game.shots.find(x => x.owner.slot === s);
  const hit = async s => { await until(() => shotOf(s)); await until(() => !shotOf(s)); await wait(.06); }; // its shot flew and ended (hit or gone), the impact just showing
  const A = { shot: (s, tier) => game.command({ cmd: 'fxShot', slot: s, tier }), charge: (s, on) => game.command({ cmd: 'fxCharge', slot: s, on, fire: false }),
    guard: setGuard, dodge: (s, side) => game.command({ cmd: 'tryDodge', slot: s, side }), element: (s, el) => game.command({ cmd: 'tryElement', slot: s, element: el }) };
  const t1 = () => rules().t1 ?? .7, t2 = () => rules().t2 ?? 2; // s: the charge reaches 中 / 大
  const PRESETS = [
    ['基本', [
      ['待機（両者が構えている）', async () => { await wait(.3); }],
      ['A 小を撃った瞬間', async () => { A.shot('A', 's'); await wait(.06); }],
      ['A 小が当たった瞬間', async () => { A.shot('A', 's'); await hit('A'); }],
      ['A 中を撃った瞬間', async () => { A.shot('A', 'm'); await wait(.08); }],
      ['A 中が当たった瞬間', async () => { A.shot('A', 'm'); await hit('A'); }],
      ['A 大を撃った瞬間', async () => { A.shot('A', 'l'); await wait(.12); }],
      ['A 大が当たった瞬間', async () => { A.shot('A', 'l'); await hit('A'); }],
      ['B 小が当たった瞬間', async () => { A.shot('B', 's'); await hit('B'); }],
      ['B 中が当たった瞬間', async () => { A.shot('B', 'm'); await hit('B'); }],
      ['B 大が当たった瞬間', async () => { A.shot('B', 'l'); await hit('B'); }],
    ]],
    ['チャージ', [
      ['A チャージ 始め（小）', async () => { A.charge('A', true); await wait(.35); }],
      ['A チャージ 中まで', async () => { A.charge('A', true); await wait(t1() + .25); }],
      ['A チャージ 大まで（満タン）', async () => { A.charge('A', true); await wait(t2() + .3); }],
      ['B チャージ 大まで（満タン）', async () => { A.charge('B', true); await wait(t2() + .3); }],
      ['両者 同時にチャージ', async () => { A.charge('A', true); A.charge('B', true); await wait(t2() + .3); }],
    ]],
    ['ガード', [
      ['A ガード', async () => { A.guard('A', true); await wait(.4); }],
      ['A ガードで B の小を跳ね返す', async () => { A.guard('A', true); await wait(.2); A.shot('B', 's'); await until(() => shotOf('B')); await until(() => { const s = shotOf('B'); return !s || s.owner.slot !== 'B'; }); await wait(.12); }],
      ['A ガードを B の大が貫く', async () => { A.guard('A', true); await wait(.2); A.shot('B', 'l'); await hit('B'); }],
    ]],
    ['回避', [
      ['A 右へ回避（転がっている途中）', async () => { A.dodge('A', 1); await wait(.22); }],
      ['A 右へ回避（転がり終わり）', async () => { A.dodge('A', 1); await wait(.5); }],
      ['A 回避から横跳びで戻る途中', async () => { A.dodge('A', 1); await wait(.85); }],
      ['B 左へ回避（転がっている途中）', async () => { A.dodge('B', -1); await wait(.22); }],
      ['A 回避で B の中をかわす', async () => { A.shot('B', 'm'); await wait(.03); A.dodge('A', 1); await wait(.3); }],
    ]],
    ['属性（大が当たった瞬間）', Object.entries(EL_JA).map(([el, ja]) => [`${ja}の大`, async () => { A.element('A', el); await wait(.05); A.shot('A', 'l'); await hit('A'); }])],
    ['その他', [
      ['雷のチャージ 満タン', async () => { A.element('A', 'thunder'); A.charge('A', true); await wait(t2() + .3); }],
      ['水のチャージ 満タン', async () => { A.element('A', 'water'); A.charge('A', true); await wait(t2() + .3); }],
      ['相打ち（両者の中が同時に当たる）', async () => { A.shot('A', 'm'); A.shot('B', 'm'); await until(() => shotOf('A') || shotOf('B')); await until(() => !shotOf('A') && !shotOf('B')); await wait(.06); }],
    ]],
  ];
  const list = $('presets'); let n = 0;
  list.innerHTML = PRESETS.map(([group, items]) => `<h4>${group}</h4>` + items.map(([name]) => `<button data-p="${n++}"><i>${String(n).padStart(2, '0')}</i>${name}</button>`).join('')).join('');
  const flat = PRESETS.flatMap(([, items]) => items);
  function clearAll() { for (const s of ['A', 'B']) { setGuard(s, false); game.command({ cmd: 'fxCharge', slot: s, on: false, fire: false }); game.command({ cmd: 'tryElement', slot: s, element: $('el').value && s === slot ? $('el').value : null }); } }
  function setMode(name) { const m = $('mode'); m.textContent = name ? `フリーズ：${name}` : 'ライブ'; m.classList.toggle('frozen', !!name); }
  function goLive() { if (!frozen) return; frozen = false; running++; setMode(null); for (const b of list.querySelectorAll('button')) b.classList.remove('on'); clearAll(); }
  $('live').onclick = goLive;
  list.onclick = async e => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const my = ++running; frozen = false; setMode(null); for (const q of list.querySelectorAll('button')) q.classList.toggle('on', q === b);
    clearAll(); for (const s of ['A', 'B']) game.command({ cmd: 'tryElement', slot: s, element: null });
    await until(() => !game.shots.length, 2); await wait(.15); // the last preset's shots and dodge settle
    await flat[+b.dataset.p][1]();
    if (my !== running) return; // another preset or live started meanwhile
    frozen = true; setMode(flat[+b.dataset.p][0]);
  };

  return {
    get frozen() { return active && frozen; },
    setActive(on) { active = !!on; if (on) stage.attach($('game'), 'game'); },
    frame() { if (!active) return; drawRaw('A'); drawRaw('B'); drawMerged(); draw3D(); },
  };
}
