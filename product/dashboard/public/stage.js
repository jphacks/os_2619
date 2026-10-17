// One WebGL stage for the game screen and the final render (only one is visible at a time, so the canvas moves between them).
//  game:  the stylised arena (field3d.js) through the broadcast "drone" camera (drone.js), effects with bloom (effects.js)
//  final: phone C's picture as the background, the Three.js camera placed where the tag scan put phone C (extrinsics.js /
//         fieldmap.js), the same effects drawn at the sensors' 3D positions → the 3D state projected onto the live picture.
//         Optionally a chest phone's own picture instead (A / B view), or the drone view as a picture-in-picture.
// The tag scan (K) measures the floor sheets and phone C's pose at once; the result is kept in localStorage.
// Ported from kawashima/app.js (renderer, guide, scan, skeletons).
import * as THREE from 'three';
import * as W from './world.js';
import { createFx } from './effects.js';
import { toThreeCamera, detectTags } from './extrinsics.js';
import { createDrone } from './drone.js';
import { createField, createMinimap } from './field3d.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const v3 = a => V(a[0], a[1], a[2]);
const now = () => performance.now() / 1000;
const toMat = p => new THREE.Matrix4().set(p.R[0], p.R[1], p.R[2], p.t[0], p.R[3], p.R[4], p.R[5], p.t[1], p.R[6], p.R[7], p.R[8], p.t[2], 0, 0, 0, 1);
export const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], [0, 11], [0, 12]];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
// where phone C should go: 3.5 m in front of the centre, 1.7 m up or higher, tilted down a little (camera before a scan)
export const GUIDE_CAM = { x: 0, y: 1.7, z: 3.5, yaw: 0, pitch: -16, roll: 0, fov: 45 };
export const DRONE_JA = { auto: '自動演出', orbit: '周回', chaseA: 'A の肩越し', chaseB: 'B の肩越し', top: '真上', side: '真横', free: '自由操作' };

const FIELD_KEY = 'pd-field-' + W.LAYOUT, CAM_KEY = 'pd-tagcam';

export function createStage({ video, cfg, hub, PA, getTracker, isSetup = () => true }) {
  const el = document.createElement('div'); el.className = 'stage';
  const canvas = document.createElement('canvas'), guideCanvas = Object.assign(document.createElement('canvas'), { className: 'guide2d' }), gctx = guideCanvas.getContext('2d');
  el.append(canvas, guideCanvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const videoTex = new THREE.VideoTexture(video); videoTex.colorSpace = THREE.SRGBColorSpace;
  const camera = new THREE.PerspectiveCamera(GUIDE_CAM.fov, 16 / 9, 0.05, 100); camera.rotation.order = 'YXZ';
  const overCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 100); overCam.position.set(0, 5.5, 6.5);
  const drone = createDrone(overCam, canvas, { mode: cfg.drone });
  const field = createField(scene); field.group.visible = false;
  const fx = createFx(renderer, scene, camera);
  const S = { shake: 0, mode: 'game', box: null, w: 1, h: 1, aspect: 16 / 9, msg: '', tagCam: null, scanned: false, scannedIds: null, ready: false, intr: {} };
  fx.opts.onShake = a => { S.shake = Math.max(S.shake, a); };

  // ---- debug world (G): grid, field tags, phone C's frustum ----
  const world3d = new THREE.Group(); scene.add(world3d); world3d.visible = false;
  const grid = new THREE.GridHelper(8, 16, 0x888888, 0x444444); world3d.add(grid);
  const camHelper = new THREE.CameraHelper(camera); world3d.add(camHelper);

  // ---- skeletons: phone C's pose tracker (posetrack.js) and what each chest camera sees of the opponent (phonealign.js) ----
  const skels = Object.fromEntries(['A', 'B'].map(slot => {
    const color = slot === 'A' ? 0xffa060 : 0x8fd8ff, pos = new Float32Array(99);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(BONES.flat());
    const jg = new THREE.BufferGeometry(); jg.setAttribute('position', g.getAttribute('position')); jg.setIndex(JOINTS);
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false }));
    const dots = new THREE.Points(jg, new THREE.PointsMaterial({ color, size: .07, transparent: true, depthTest: false }));
    lines.renderOrder = dots.renderOrder = 15; lines.frustumCulled = dots.frustumCulled = false;
    const grp = new THREE.Group(); grp.add(lines, dots); grp.visible = false; scene.add(grp);
    return [slot, { grp, pos, attr: g.getAttribute('position'), has: false }];
  }));
  const phoneSk = Object.fromEntries(['A', 'B'].map(slot => {
    const pos = new Float32Array(BONES.length * 6), g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: slot === 'A' ? 0xffd2a8 : 0xd2f0ff, transparent: true, opacity: .75, depthTest: false }));
    lines.renderOrder = 14; lines.frustumCulled = false; lines.visible = false; scene.add(lines);
    return [slot, { lines, pos, attr: g.getAttribute('position'), has: false }];
  }));
  function updateSkels(est) {
    const tr = getTracker();
    for (const slot of ['A', 'B']) {
      const k = skels[slot], s = tr?.get(slot);
      k.has = !!(s?.seen && s.skel) && cfg.skelSrc !== 'phones';
      if (k.has) { k.pos.set(s.skel); k.attr.needsUpdate = true; }
      const q = phoneSk[slot], b = est?.bodies?.[slot];
      q.has = !!b && cfg.skelSrc !== 'camera';
      if (!q.has) continue;
      BONES.forEach(([i, j], n) => { const p = b[i] && b[j] ? [b[i], b[j]] : [[0, -50, 0], [0, -50, 0]]; q.pos.set(p[0], n * 6); q.pos.set(p[1], n * 6 + 3); });
      q.attr.needsUpdate = true;
    }
  }
  const showSkels = on => { for (const k of Object.values(skels)) k.grp.visible = on && k.has; for (const k of Object.values(phoneSk)) k.lines.visible = on && k.has; };

  // ---- setup guide over the picture while preparing: field outline, start marks, the sheets ----
  const guide = new THREE.Group(); scene.add(guide);
  const onTop = m => { m.depthTest = false; m.transparent = true; return m; };
  function label(text, color, h = .16) {
    const c = document.createElement('canvas'), g = c.getContext('2d'), font = 'bold 44px system-ui, "Hiragino Sans", sans-serif';
    g.font = font; const lines = text.split('\n'), w = Math.max(...lines.map(l => g.measureText(l).width)) + 36;
    c.width = w; c.height = 58 * lines.length + 14;
    g.fillStyle = 'rgba(0,0,0,.72)'; g.beginPath(); g.roundRect(0, 0, c.width, c.height, 14); g.fill();
    g.font = font; g.fillStyle = color; g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, 18, 12 + 58 * i));
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(onTop(new THREE.SpriteMaterial({ map: tex })));
    s.scale.set(h * lines.length * c.width / c.height, h * lines.length, 1); s.renderOrder = 20;
    return s;
  }
  function strip(a, b, color, w = .05) { // flat band on the floor from a to b
    const d = b.clone().sub(a), m = new THREE.Mesh(new THREE.PlaneGeometry(d.length(), w), onTop(new THREE.MeshBasicMaterial({ color, opacity: .85 })));
    m.rotation.set(-Math.PI / 2, 0, -Math.atan2(d.z, d.x)); m.position.copy(a).add(b).multiplyScalar(.5).setY(.005); m.renderOrder = 10;
    return m;
  }
  function buildGuide() {
    guide.clear();
    if (W.LAYOUT === 'map4' && !S.scanned) return; // sheets not scanned yet: nothing to draw where they are
    const c = W.FIELD.poly.map(([x, z]) => V(x, 0, z));
    c.forEach((p, i) => guide.add(strip(p, c[(i + 1) % c.length], 0xffffff)));
    for (const [slot, color, css] of [['A', 0xff7a1a, '#ffb070'], ['B', 0x6cc8ff, '#a8dcff']]) {
      const st = W.START[slot], ring = new THREE.Mesh(new THREE.RingGeometry(.26, .32, 48), onTop(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, opacity: .9 })));
      ring.rotation.x = -Math.PI / 2; ring.position.set(st.pos[0], .006, st.pos[2]); ring.renderOrder = 10;
      const tip = v3(W.apply(W.bodyPose(st.pos, st.yaw, .006), [.55, 0, 0]));
      const lb = label(`${slot} の立ち位置`, css, .13); lb.position.set(st.pos[0], .25, st.pos[2]);
      guide.add(ring, strip(v3(st.pos), tip, color, .04), lb);
    }
    for (const id of W.CORNER_IDS) {
      if (S.scannedIds && !S.scannedIds.includes(id)) continue;
      const p = W.worldTagPose(id), s = W.TAGS[id].size, h = s / 2, M = toMat(p);
      const sq = [[-h, h], [h, h], [h, -h], [-h, -h], [-h, h]].map(([x, y]) => V(x, y, 0).applyMatrix4(M));
      const frame = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sq), onTop(new THREE.LineBasicMaterial({ color: 0x3ddc84 })));
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(s, s), onTop(new THREE.MeshBasicMaterial({ color: 0x3ddc84, opacity: .25, side: THREE.DoubleSide })));
      fill.matrixAutoUpdate = false; fill.matrix.copy(M); frame.renderOrder = fill.renderOrder = 11;
      const lb = label(`ID ${id}`, '#9ff0c0', .085); lb.position.set(p.t[0], p.t[1] + .3, p.t[2]);
      guide.add(frame, fill, lb);
    }
  }
  W.onFieldChange(() => buildGuide());

  // ---- field scan (map4: 2 or 4 sheets anywhere, fieldmap.js) ----
  function applyField(f) { S.scanned = true; if (f.tags && Object.keys(f.tags).length) S.scannedIds = Object.keys(f.tags).map(Number); W.setField(f); }
  try { const f = JSON.parse(localStorage.getItem(FIELD_KEY)); if (f?.poly) applyField(f); } catch {}
  try { S.tagCam = JSON.parse(localStorage.getItem(CAM_KEY)); } catch {}
  buildGuide();
  const saveField = () => { try { localStorage.setItem(FIELD_KEY, JSON.stringify({ poly: W.FIELD.poly, tags: Object.fromEntries((S.scannedIds ?? W.CORNER_IDS).map(id => { const T = W.TAGS[id]; return [id, { pos: T.pos, yaw: T.yaw ?? 0, ...(T.stand ? { stand: true, spin: T.spin ?? 0, R: T.R } : {}) }]; })) })); } catch {} };
  const modeIds = () => cfg.tagMode === 2 ? [0, 1] : W.CORNER_IDS;
  async function scan() {
    if (!video.videoWidth) { S.msg = 'スキャンできない：スマホ C の映像がまだ届いていない'; return; }
    S.msg = `${cfg.tagMode}枚のタグをスキャン中…`;
    let FM; try { FM = await import('./fieldmap.js'); } catch (e) { S.msg = 'スキャン失敗：fieldmap.js を読み込めない ' + e.message; return; }
    const need = modeIds(), src = video.__dummy?.canvas ?? video;
    const fovY = cfg.tagMount === 'stand' ? cfg.knownFov ?? null : null; // leaning sheets cannot fix the focal from one view
    const m = await FM.scanField(src, { fovYGuess: S.tagCam?.fovY ?? GUIDE_CAM.fov, fovY, mode: cfg.tagMode, mount: cfg.tagMount, tagHeight: cfg.tagHeight });
    if (!m) { S.msg = `スキャン失敗：タグ（ID ${need.join('・')}）が${cfg.tagMode === 2 ? '2枚' : '3枚以上'}見えていない。カメラを高くするか、遠いタグを近づける`; return; }
    applyField({ poly: m.poly, tags: m.tags }); saveField();
    const firm = m.cam.focalFitted && !(m.warnings ?? []).some(w => /loosely|fovYGuess|focal/i.test(w)) && Object.values(m.tags).every(t => !(t.tilt > 2));
    if (firm) cfg.knownFov = m.fovY;
    S.tagCam = m.cam; try { localStorage.setItem(CAM_KEY, JSON.stringify(m.cam)); } catch {}
    const xs = m.poly.map(q => q[0]), zs = m.poly.map(q => q[1]), size = `${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}m × ${(Math.max(...zs) - Math.min(...zs)).toFixed(1)}m`;
    const good = need.every(id => m.ids.includes(id)) && m.reprojErrPx < 4;
    S.ready = S.ready || good;
    S.msg = good ? `スキャン完了：タグ ${m.ids.join(',')}　フィールド 約${size}　誤差 ${m.reprojErrPx.toFixed(1)}px　縦画角 ${m.fovY.toFixed(1)}°`
      : `スキャン不十分：${!need.every(id => m.ids.includes(id)) ? `タグが${m.ids.length}枚しか見えていない` : `誤差 ${m.reprojErrPx.toFixed(1)}px が大きい`}。置き方を直してもう一度`;
    resize();
  }
  function clearScan() { try { localStorage.removeItem(FIELD_KEY); localStorage.removeItem(CAM_KEY); } catch {} location.reload(); }

  // live tag check while preparing: which ids phone C sees, and chest tags 10 / 11 tell the pose tracker who is who
  const seen = { list: [], at: 0, busy: false, ms: 0 };
  const PLAYER_IDS = Object.values(W.PLAYER_TAG);
  async function checkTags(setup) {
    const tr = getTracker();
    if (seen.busy || (!setup && !tr) || video.__dummy || !video.videoWidth || document.hidden) return;
    seen.busy = true; const t0 = performance.now();
    try {
      const d = await detectTags(video, setup ? null : PLAYER_IDS, { passes: [[1, 2], [1, 6]] }); // off the main thread (tagworker.js)
      seen.list = d.map(o => ({ id: o.id, corners: o.corners, w: d.width, h: d.height })); seen.at = now();
      tr?.setHints?.(seen.list.filter(o => PLAYER_IDS.includes(o.id)).map(o => ({
        slot: o.id === W.PLAYER_TAG.A ? 'A' : 'B', u: o.corners.reduce((a, c) => a + c[0] / 4, 0), v: o.corners.reduce((a, c) => a + c[1] / 4, 0), t: now() })));
    } catch {} finally { seen.busy = false; seen.ms = performance.now() - t0; }
  }
  const tagChecks = () => modeIds().map(id => {
    const d = seen.list.find(o => o.id === id);
    return { id, seen: !!d, px: d ? Math.hypot(d.corners[0][0] - d.corners[1][0], d.corners[0][1] - d.corners[1][1]) : 0 };
  });
  let guideDrawn = false;
  function drawGuide2d(show) {
    const w = Math.round(S.w * devicePixelRatio), h = Math.round(S.h * devicePixelRatio);
    if (guideCanvas.width !== w || guideCanvas.height !== h) { guideCanvas.width = w; guideCanvas.height = h; }
    const draw = show && now() - seen.at <= 3;
    if (draw || guideDrawn) gctx.clearRect(0, 0, w, h);
    guideDrawn = draw; guideCanvas.style.display = show ? '' : 'none';
    if (!draw) return;
    for (const d of seen.list) {
      const k = w / d.w, ok = W.TAGS[d.id]?.pos;
      gctx.strokeStyle = ok ? '#3ddc84' : '#ffcc4d'; gctx.lineWidth = 3 * devicePixelRatio;
      gctx.beginPath(); d.corners.forEach(([x, y], i) => gctx[i ? 'lineTo' : 'moveTo'](x * k, y * k)); gctx.closePath(); gctx.stroke();
      const [x] = d.corners.reduce(([a, b], c) => [a + c[0] / 4, b + c[1] / 4], [0, 0]);
      gctx.font = `bold ${14 * devicePixelRatio}px system-ui`; gctx.fillStyle = gctx.strokeStyle; gctx.textAlign = 'center';
      gctx.fillText(`ID ${d.id}`, x * k, Math.min(...d.corners.map(c => c[1])) * k - 8 * devicePixelRatio);
    }
  }

  // ---- chest phone view (A / B): that phone's picture behind, the camera at its located pose ----
  const phoneCanvas = document.createElement('canvas'), phoneCtx = phoneCanvas.getContext('2d');
  const phoneTex = new THREE.CanvasTexture(phoneCanvas); phoneTex.colorSpace = THREE.SRGBColorSpace;
  let phoneImgAt = 0;
  function phonePicture(slot) {
    const p = hub.phones[slot]; if (!p?.img || p.imgAt === phoneImgAt) return;
    phoneImgAt = p.imgAt;
    if (phoneCanvas.width !== p.img.width || phoneCanvas.height !== p.img.height) { phoneCanvas.width = p.img.width; phoneCanvas.height = p.img.height; phoneTex.dispose(); resize(); }
    phoneCtx.drawImage(p.img, 0, 0); phoneTex.needsUpdate = true;
  }
  function placePhoneCamera(slot) {
    const L = PA.get(slot); if (!L?.cam) return false;
    const P = W.compose(L.cam, W.arcam_T_cv), R = P.R;
    // OpenCV camera (x right, y down, z forward) -> Three.js camera (x right, y up, looks down -z)
    new THREE.Matrix4().set(R[0], -R[1], -R[2], P.t[0], R[3], -R[4], -R[5], P.t[1], R[6], -R[7], -R[8], P.t[2], 0, 0, 0, 1).decompose(camera.position, camera.quaternion, camera.scale);
    const k = L.k ?? [1.04, .78, .5, .5];
    camera.fov = 2 * Math.atan(.5 / k[1]) * 180 / Math.PI; camera.aspect = S.aspect; camera.updateProjectionMatrix();
    return true;
  }

  function applyCam() {
    if (S.mode === 'final' && cfg.fpv) return; // placed every frame
    if (S.tagCam) toThreeCamera(S.tagCam, camera);
    else { const c = GUIDE_CAM, d = THREE.MathUtils.degToRad; camera.position.set(c.x, c.y, c.z); camera.rotation.set(d(c.pitch), d(c.yaw), d(c.roll)); camera.fov = c.fov; }
    camera.aspect = S.aspect; camera.updateProjectionMatrix(); camHelper.update();
  }
  function resize() {
    if (!S.box) return;
    const bw = S.box.clientWidth, bh = S.box.clientHeight; if (!bw || !bh) return;
    const fpv = S.mode === 'final' && cfg.fpv && phoneCanvas.width;
    S.aspect = S.mode === 'game' ? bw / bh : fpv ? phoneCanvas.width / phoneCanvas.height : (video.videoWidth ? video.videoWidth / video.videoHeight : 16 / 9);
    const w = Math.min(bw, bh * S.aspect), h = w / S.aspect;
    el.style.width = w + 'px'; el.style.height = h + 'px';
    const srcW = S.mode === 'final' ? (fpv ? phoneCanvas.width : video.videoWidth || 1920) : w * devicePixelRatio;
    renderer.setPixelRatio(Math.min(devicePixelRatio, Math.max(1, srcW / w))); // no more pixels than the picture
    fx.setSize(w, h);
    S.w = w; S.h = h;
    if (minimap) minimap.canvas.width = minimap.canvas.height = Math.round(Math.min(w, h) * .26 * devicePixelRatio);
    applyCam();
  }
  new ResizeObserver(() => resize()).observe(document.body);
  video.addEventListener('loadedmetadata', resize);
  setInterval(() => checkTags(isSetup()), 600);
  let minimap = null; // the HUD's corner map (attachMinimap)

  /** Render one frame. players: the game's, for the arena avatars and the drone; est: phonealign estimate. */
  function render(dt, game, est) {
    const P = game.players, setup = game.match.phase === 'setup';
    const yawOf = b => Math.atan2(-b.R[6], b.R[0]); // body x axis = forward
    drone.update(dt, Object.fromEntries(Object.values(P).map(p => [p.slot, { chest: p.chest, yaw: yawOf(p.body), tip: p.tip }])));
    field.update(dt, Object.fromEntries(Object.values(P).map(p => [p.slot,
      { body: p.body, base: p.base, tip: p.tip, hp: p.hp, element: p.element, charging: p.charging, charge: p.charge, online: p.online || !!p.imu, hideBody: (skels[p.slot].has || phoneSk[p.slot].has) && cfg.skeleton }])));
    updateSkels(est);
    fx.step(dt);
    if (minimap) { const on = cfg.minimap && !setup; minimap.canvas.style.display = on ? '' : 'none'; if (on) minimap.draw(P, game.shots); }
    const sx = (Math.random() - .5) * 20 * S.shake, sy = (Math.random() - .5) * 20 * S.shake;
    el.style.transform = S.shake ? `translate(${sx}px, ${sy}px)` : '';
    S.shake = S.shake < .01 ? 0 : S.shake * Math.exp(-8 * dt);
    world3d.visible = cfg.debug;

    renderer.setScissorTest(false);
    if (S.mode === 'game') {
      drawGuide2d(false);
      scene.background = field.background; field.group.visible = true; camHelper.visible = cfg.debug; guide.visible = false; showSkels(cfg.skeleton);
      overCam.aspect = S.aspect; overCam.updateProjectionMatrix();
      const keep = { p: camera.position.clone(), q: camera.quaternion.clone(), fov: camera.fov };
      camera.position.copy(overCam.position); camera.quaternion.copy(overCam.quaternion); camera.fov = overCam.fov; camera.aspect = S.aspect; camera.updateProjectionMatrix();
      renderer.setViewport(0, 0, S.w, S.h); fx.render();
      camera.position.copy(keep.p); camera.quaternion.copy(keep.q); camera.fov = keep.fov; camera.updateProjectionMatrix();
      return;
    }
    const fpv = cfg.fpv && placePhoneCamera(cfg.fpv);
    if (fpv) phonePicture(cfg.fpv); else if (cfg.fpv) applyCam();
    const guiding = setup && !fpv;
    drawGuide2d(guiding);
    scene.background = fpv ? phoneTex : video.videoWidth ? videoTex : field.background;
    field.group.visible = !video.videoWidth && !fpv; // no picture yet: show the arena from phone C's place instead of black
    camHelper.visible = false; guide.visible = guiding; showSkels(cfg.skeleton && !fpv);
    fx.render();
    guide.visible = false;
    if (cfg.pip) { // drone view in the bottom-right corner (no bloom)
      const w = S.w * .28, h = S.h * .28;
      scene.background = field.background; field.group.visible = true; camHelper.visible = cfg.debug;
      overCam.aspect = w / h; overCam.updateProjectionMatrix();
      renderer.setScissorTest(true); renderer.setScissor(S.w - w - 10, 10, w, h); renderer.setViewport(S.w - w - 10, 10, w, h);
      showSkels(true); renderer.render(scene, overCam);
      renderer.setScissorTest(false); renderer.setViewport(0, 0, S.w, S.h);
    }
  }

  return {
    el, scene, camera, fx, drone, field, state: S, render, scan, clearScan, tagChecks, seenTags: seen, applyCam,
    attach(box, mode) { S.box = box; S.mode = mode; if (el.parentNode !== box) box.append(el); resize(); applyCam(); },
    attachMinimap(c) { minimap = createMinimap(c); minimap.canvas = c; },
    resize, skels, phoneSk,
  };
}
