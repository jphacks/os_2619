// 3D空間: everything the phones send, placed in the field world by phonealign.js and drawn as it is (no game effects).
//  - phones A / B: a phone-sized rectangle at the chest camera's pose, its view pyramid, AR trail and facing arrow
//  - phone C: a landscape rectangle where the tag scan put the third-person camera, with its view pyramid
//  - swords: base → tip as the game places them (hand + IMU direction × stick length), tip marked
//  - AprilTags: squares with their real pattern — the floor sheets at their fixed spots,
//    and the live sightings (a ray from the phone to every tag it sees right now)
//  - optional: the sensing team's own estimate (map.js) as a dashed ghost
// Ported from kawashima/space.js. Own renderer; geometry allocated once, buffers rewritten in place, estimate drawn at 15 Hz.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as W from './world.js';
import { toThreeCamera } from './extrinsics.js';
import { tagCanvas } from './dummycam.js';

const SLOTS = ['A', 'B'];
const COL = { A: 0xff8a3d, B: 0x4cc3ff, C: 0xffd23d, tag: 0x3ddc84, chest: 0xff4df0, ghost: 0xc9c9c9, grid: 0x2a3140 };
const DEG = Math.PI / 180;
const PHONE = { w: .075, h: .155, d: .009 }; // m, a typical phone
const toMat = (p, m = new THREE.Matrix4()) => m.set(p.R[0], p.R[1], p.R[2], p.t[0], p.R[3], p.R[4], p.R[5], p.t[1], p.R[6], p.R[7], p.R[8], p.t[2], 0, 0, 0, 1);
const lineMat = (color, extra = {}) => new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false, ...extra });

function segs(n, mat, vertexColors = false) {
  const pos = new Float32Array(n * 6), g = new THREE.BufferGeometry(), attr = new THREE.BufferAttribute(pos, 3); g.setAttribute('position', attr);
  let col = null; if (vertexColors) { col = new THREE.BufferAttribute(new Float32Array(n * 6), 3); g.setAttribute('color', col); }
  const obj = new THREE.LineSegments(g, mat); obj.frustumCulled = false; obj.renderOrder = 10;
  const c = new THREE.Color();
  return {
    obj,
    write(i, a, b, color) { pos.set(a, i * 6); pos.set(b, i * 6 + 3); if (col && color != null) { c.set(color); const o = i * 6, A = col.array; A[o] = A[o + 3] = c.r; A[o + 1] = A[o + 4] = c.g; A[o + 2] = A[o + 5] = c.b; } },
    draw(k) { g.setDrawRange(0, k * 2); attr.needsUpdate = true; if (col) col.needsUpdate = true; },
  };
}
function label(text, color = '#e7e9ee', size = .2) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d'); c.width = 256; c.height = 64;
  ctx.font = 'bold 40px system-ui, "Hiragino Sans", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color; ctx.fillText(text, 128, 32);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(size * 4, size, 1); sp.renderOrder = 20; return sp;
}
const tagTex = {};
function tagMaterial(id) { // the real tag36h11 pattern on a square (white quiet zone included, as printed)
  if (!tagTex[id]) { const t = new THREE.CanvasTexture(tagCanvas(id, 16)); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; tagTex[id] = t; }
  return new THREE.MeshBasicMaterial({ map: tagTex[id], side: THREE.DoubleSide });
}
/** A tag square of black-square size s (the printed quiet zone makes the sheet 10/8 of that), with a coloured rim. */
function tagSquare(id, s, rim) {
  const g = new THREE.Group(), q = s * 10 / 8;
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(q, q), tagMaterial(id)));
  const h = q / 2 + .004, ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-h, h], [h, h], [h, -h], [-h, -h]].map(([x, y]) => new THREE.Vector3(x, y, .001))), new THREE.LineBasicMaterial({ color: rim }));
  g.add(ring); return g;
}
/** Phone body: a thin box (screen dark, back tinted) with a bright outline. Local frame = OpenCV camera (x right, y down, z forward). */
function phoneMesh(color, landscape = false) {
  const w = landscape ? PHONE.h : PHONE.w, h = landscape ? PHONE.w : PHONE.h, g = new THREE.Group();
  const mats = [0, 1, 2, 3].map(() => new THREE.MeshBasicMaterial({ color: 0x1b1f29 }));
  mats.push(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .55 }), new THREE.MeshBasicMaterial({ color: 0x0b0d12 })); // +z (back, camera side) tinted, -z screen
  g.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, PHONE.d), mats));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, PHONE.d)), new THREE.LineBasicMaterial({ color })));
  const lens = new THREE.Mesh(new THREE.CircleGeometry(.006, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  lens.position.set(landscape ? -w / 2 + .015 : -w / 2 + .015, -h / 2 + .015, PHONE.d / 2 + .001); g.add(lens);
  g.matrixAutoUpdate = false; return g;
}

export function createSpace({ view, legendEl, panelEl, hub, PA, getStage, getGame, getMap, cfg }) {
  const canvas = document.createElement('canvas'); view.prepend(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x07090d); scene.fog = new THREE.Fog(0x07090d, 9, 22);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.03, 100);
  const HOME = { p: [3.6, 3.4, 5.6], t: [0, .8, 0] };
  camera.position.set(...HOME.p);
  const controls = new OrbitControls(camera, canvas); controls.target.set(...HOME.t); controls.enableDamping = true; controls.dampingFactor = .12;
  canvas.addEventListener('dblclick', () => { camera.position.set(...HOME.p); controls.target.set(...HOME.t); });
  function resize() { const w = view.clientWidth, h = view.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(view);

  // static-ish world: grid, field outline, field tags (rebuilt when the field changes)
  const world = new THREE.Group(); scene.add(world);
  const grid = new THREE.GridHelper(10, 20, COL.grid, 0x161b25); world.add(grid);
  const axes = new THREE.AxesHelper(.5); world.add(axes);
  const fieldGrp = new THREE.Group(), tagsGrp = new THREE.Group(); world.add(fieldGrp, tagsGrp);
  function buildField() {
    fieldGrp.clear(); tagsGrp.clear();
    const P = W.FIELD.poly, pts = [...P, P[0]].map(([x, z]) => new THREE.Vector3(x, .004, z));
    fieldGrp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(0xffffff, { opacity: .5 })));
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(P.map(([x, z]) => new THREE.Vector2(x, -z)))), new THREE.MeshBasicMaterial({ color: 0x1a2236, transparent: true, opacity: .35, side: THREE.DoubleSide, depthWrite: false }));
    fill.rotation.x = -Math.PI / 2; fill.position.y = .002; fieldGrp.add(fill);
    for (const s of SLOTS) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(.24, .28, 40), new THREE.MeshBasicMaterial({ color: COL[s], transparent: true, opacity: .5, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(W.START[s].pos[0], .005, W.START[s].pos[2]);
      const m = label(`${s} 立ち位置`, s === 'A' ? '#ff9a4d' : '#6cc8ff', .12); m.position.set(W.START[s].pos[0], .1, W.START[s].pos[2] + .45);
      fieldGrp.add(ring, m);
    }
    for (const id of W.CORNER_IDS) {
      const p = W.worldTagPose(id), size = W.TAGS[id].size, t = W.TAGS[id];
      const sq = tagSquare(id, size, COL.tag); sq.matrixAutoUpdate = false; toMat(p, sq.matrix);
      const l = label(`ID ${id}`, '#3ddc84', .13); l.position.set(p.t[0], p.t[1] + (t.stand ? size * .9 : .16), p.t[2]);
      tagsGrp.add(sq, l);
      if (t.stand) { const pole = new THREE.Mesh(new THREE.CylinderGeometry(.008, .008, p.t[1]), new THREE.MeshBasicMaterial({ color: 0x4a5262 })); pole.position.set(p.t[0], p.t[1] / 2, p.t[2]); tagsGrp.add(pole); }
    }
  }
  W.onFieldChange(buildField); buildField();

  // phone C (third-person camera): rectangle + view pyramid where the scan put it
  const cGrp = new THREE.Group(); scene.add(cGrp);
  const cPhone = phoneMesh(COL.C, true); cGrp.add(cPhone);
  const cFrustum = segs(8, lineMat(COL.C, { opacity: .8 })); cGrp.add(cFrustum.obj);
  const cLabel = label('C カメラ', '#ffd23d', .14); cGrp.add(cLabel);
  let cKey = '';
  function placeC() {
    const tc = getStage()?.state.tagCam, key = tc ? JSON.stringify(tc.pose) : '';
    cGrp.visible = !!tc && on.phoneC;
    if (!tc || key === cKey) return; cKey = key;
    toMat(tc.pose, cPhone.matrix); // world_T_cam, OpenCV frame: the rectangle's local frame
    const fy = tc.height / 2 / Math.tan(tc.fovY * DEG / 2), z = 1.2, hx = tc.width / 2 / fy * z, hy = tc.height / 2 / fy * z;
    const c = [[-hx, -hy, z], [hx, -hy, z], [hx, hy, z], [-hx, hy, z]].map(q => W.apply(tc.pose, q));
    for (let i = 0; i < 4; i++) { cFrustum.write(i, tc.pose.t, c[i]); cFrustum.write(4 + i, c[i], c[(i + 1) % 4]); } cFrustum.draw(8);
    cLabel.position.set(tc.pose.t[0], tc.pose.t[1] + .18, tc.pose.t[2]);
  }

  // ---- per-phone drawables (preallocated) ----
  const TRAIL_N = 200, RAY_N = 24;
  const src = {};
  for (const s of SLOTS) {
    const color = COL[s];
    const trailPos = new Float32Array(TRAIL_N * 3), tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    const trail = new THREE.Line(tg, lineMat(color, { opacity: .45 })); trail.frustumCulled = false;
    const phone = phoneMesh(color);
    const frustum = segs(8, lineMat(color, { opacity: .7 }));
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), .5, color, .1, .06);
    const name = label(`${s} スマホ`, s === 'A' ? '#ffb070' : '#a8dcff', .13);
    const drop = segs(1, lineMat(color, { opacity: .25 }));
    const grp = new THREE.Group(); grp.add(trail, phone, frustum.obj, arrow, name, drop.obj); scene.add(grp);
    // the sword: a glowing blade from the hand to the tip, plus a soft tip marker
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(.012, .018, 1, 10, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .95 }));
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(.035, .045, 1, 12, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .18, blending: THREE.AdditiveBlending, depthWrite: false }));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(.035, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const tipGlow = new THREE.Mesh(new THREE.SphereGeometry(.09, 14, 10), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .25, blending: THREE.AdditiveBlending, depthWrite: false }));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(.025, 10, 8), new THREE.MeshBasicMaterial({ color }));
    const tipShadow = segs(1, lineMat(color, { opacity: .25 }));
    const swordLabel = label(`${s} の剣`, s === 'A' ? '#ffb070' : '#a8dcff', .1);
    const sword = new THREE.Group(); sword.add(blade, glow, tip, tipGlow, hand, tipShadow.obj, swordLabel); scene.add(sword);
    const ghost = new THREE.Mesh(new THREE.SphereGeometry(.09, 10, 6), new THREE.MeshBasicMaterial({ color: COL.ghost, wireframe: true, transparent: true, opacity: .6 })); scene.add(ghost);
    src[s] = { grp, trail, trailPos, tg, phone, frustum, arrow, name, drop, sword, blade, glow, tip, tipGlow, hand, tipShadow, swordLabel, ghost };
  }
  const rays = segs(RAY_N, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .7, depthTest: false }), true); scene.add(rays.obj);
  // fixed tags as detected: each id where a phone first saw it (not where the layout says it should be), with its real turn.
  // The first few sightings (nearest one wins) fix the spot for good: seeing a tag again never moves it, so ARCore drift or
  // a changing phone alignment cannot make it wander. A new field scan clears them (the scan measures the sheets anyway).
  const LOCK_AFTER = 5, LOCK_MAX_D = 4;
  const detected = new Map(), detGrp = new THREE.Group(); scene.add(detGrp);
  function showDetected(id, R, p, dist) {
    if (!(dist < LOCK_MAX_D)) return; // too far to place a sheet reliably: wait for a closer look
    let d = detected.get(id);
    if (!d) {
      const sq = tagSquare(id, W.TAGS[id]?.size ?? .16, COL.tag), l = label(`ID ${id}`, '#3ddc84', .13); sq.matrixAutoUpdate = false; detGrp.add(sq, l);
      detected.set(id, d = { sq, l, n: 0, best: Infinity, locked: false });
    }
    if (d.locked) return;
    if (dist < d.best) { d.best = dist; toMat({ R, t: p }, d.sq.matrix); d.l.position.set(p[0], p[1] + .16, p[2]); d.sq.visible = d.l.visible = true; }
    if (++d.n >= LOCK_AFTER) d.locked = true;
  }
  W.onFieldChange(() => { for (const d of detected.values()) detGrp.remove(d.sq, d.l); detected.clear(); });
  const seenTags = new THREE.Group(); scene.add(seenTags); // small squares where each phone sees a tag right now
  const seenPool = Array.from({ length: RAY_N }, () => { const m = new THREE.Mesh(new THREE.PlaneGeometry(.12, .12), new THREE.MeshBasicMaterial({ color: COL.tag, transparent: true, opacity: .35, side: THREE.DoubleSide, depthTest: false })); m.visible = false; seenTags.add(m); return m; });

  // ---- legend / toggles ----
  const TOGGLES = [
    ['phones', 'スマホ A・B（長方形・視野・軌跡）', 'linear-gradient(90deg,#ff8a3d 50%,#4cc3ff 50%)'], ['phoneC', 'スマホ C（第三者視点カメラ）', '#ffd23d'],
    ['swords', '剣の推定位置', '#fff'], ['tags', 'AprilTag（床のタグ）', '#3ddc84'], ['rays', 'いま見えているタグ', '#3ddc84'],
    ['mapjs', 'センサー班 map.js の推定（点線）', 'repeating-linear-gradient(90deg,#c9c9c9 0 3px,transparent 3px 5px)'], ['grid', 'グリッド・軸', '#5a6378'],
  ];
  const on = Object.fromEntries(TOGGLES.map(([k]) => [k, k !== 'mapjs']));
  try { Object.assign(on, JSON.parse(localStorage.getItem('pd-space-toggles') ?? '{}')); } catch {}
  for (const [k, text, bg] of TOGGLES) {
    const l = document.createElement('label'), cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: on[k] });
    cb.onchange = () => { on[k] = cb.checked; try { localStorage.setItem('pd-space-toggles', JSON.stringify(on)); } catch {} };
    const sw = document.createElement('i'); sw.style.background = bg;
    l.append(cb, sw, text); legendEl.append(l);
  }
  const note = document.createElement('div'); note.className = 'note'; legendEl.append(note);

  // map.js room -> field world: yaw + shift on the shared floor tags; null when that cannot be done
  function fitRoom(corners) {
    const pairs = (corners ?? []).filter(c => W.TAGS[c.id]?.floor && getStage()?.state.scanned).map(c => [c.p, W.TAGS[c.id].pos]);
    if (pairs.length < 2) return null;
    const m = i => pairs.reduce((a, q) => [a[0] + q[i][0] / pairs.length, a[1] + q[i][2] / pairs.length], [0, 0]), ma = m(0), mb = m(1);
    let sc = 0, ss = 0;
    for (const [a, b] of pairs) { const A = [a[0] - ma[0], a[2] - ma[1]], B = [b[0] - mb[0], b[2] - mb[1]]; sc += A[0] * B[0] + A[1] * B[1]; ss += A[0] * B[1] - A[1] * B[0]; }
    const th = Math.atan2(ss, sc), c = Math.cos(th), s = Math.sin(th);
    return p => [c * (p[0] - ma[0]) - s * (p[2] - ma[1]) + mb[0], p[1], s * (p[0] - ma[0]) + c * (p[2] - ma[1]) + mb[1]];
  }

  // ---- per-estimate scene update ----
  const tmpV = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion();
  let est = null, ghostEst = null, roomToWorld = null, ghostAt = 0;
  function frustumOf(g, k) { // the chest camera's view pyramid, 0.4 m deep, from the intrinsics
    const Wcv = W.compose(g.cam, W.arcam_T_cv), K = k ?? [1.04, .78, .5, .5], z = .4, hx = .5 / K[0] * z, hy = .5 / K[1] * z;
    return { Wcv, o: Wcv.t, c: [[-hx, -hy, z], [hx, -hy, z], [hx, hy, z], [-hx, hy, z]].map(p => W.apply(Wcv, p)) };
  }
  function placeSword(d, base, tipP) {
    const a = new THREE.Vector3(...base), b = new THREE.Vector3(...tipP), len = a.distanceTo(b) || 1e-3;
    tmpV.copy(b).sub(a).normalize(); q.setFromUnitVectors(up, tmpV);
    for (const m of [d.blade, d.glow]) { m.position.copy(a).lerp(b, .5); m.quaternion.copy(q); m.scale.set(1, len, 1); }
    d.tip.position.copy(b); d.tipGlow.position.copy(b); d.hand.position.copy(a);
    d.tipShadow.write(0, tipP, [tipP[0], 0, tipP[2]]); d.tipShadow.draw(1);
    d.swordLabel.position.set(b.x, b.y + .12, b.z);
  }
  function update(t, estimate) {
    est = estimate; if (!est) return;
    let nRays = 0;
    const game = getGame();
    for (const s of SLOTS) {
      const d = src[s], g = est.slots[s];
      d.grp.visible = on.phones && !!g.chest;
      if (d.grp.visible) {
        const n = Math.min(TRAIL_N, g.trail.length), off = g.trail.length - n;
        for (let i = 0; i < n; i++) d.trailPos.set(g.trail[off + i], i * 3);
        d.tg.setDrawRange(0, n); d.tg.attributes.position.needsUpdate = true; d.trail.visible = n > 1;
        d.phone.visible = d.frustum.obj.visible = !!g.cam;
        if (g.cam) {
          const f = frustumOf(g, g.k);
          toMat(f.Wcv, d.phone.matrix);
          for (let i = 0; i < 4; i++) { d.frustum.write(i, f.o, f.c[i]); d.frustum.write(4 + i, f.c[i], f.c[(i + 1) % 4]); } d.frustum.draw(8);
        }
        d.name.position.set(g.chest[0], g.chest[1] + .22, g.chest[2]);
        d.drop.write(0, g.chest, [g.chest[0], 0, g.chest[2]]); d.drop.draw(1);
        d.arrow.visible = !!g.fwd;
        if (g.fwd) { d.arrow.position.set(g.chest[0], g.chest[1] - .12, g.chest[2]); d.arrow.setDirection(tmpV.set(...g.fwd)); }
        for (const sg of g.sightings ?? []) if (sg.R && !W.TAGS[sg.id]?.pos) showDetected(sg.id, sg.R, sg.p, sg.d);
        if (on.rays && g.sightings) for (const sg of g.sightings) {
          if (nRays >= RAY_N) break;
          const isField = W.TAGS[sg.id]?.pos, m = seenPool[nRays];
          m.visible = true; m.position.set(...sg.p); m.lookAt(g.chest[0], g.chest[1], g.chest[2]); m.material.color.set(isField ? COL.tag : COL.chest);
          rays.write(nRays++, g.chest, sg.p, isField ? COL.tag : COL.chest);
        }
      }
      // the sword, as the game has it this frame
      const p = game?.players[s];
      d.sword.visible = on.swords && !!p && (p.online || !!p.imu || !!g.chest);
      if (d.sword.visible) placeSword(d, p.base.toArray(), p.tip.toArray());
    }
    for (let i = nRays; i < RAY_N; i++) seenPool[i].visible = false;
    rays.draw(nRays); rays.obj.visible = on.rays && nRays > 0;
    const smap = getMap();
    if (smap && on.mapjs && t - ghostAt > .25) {
      ghostAt = t;
      try { ghostEst = smap.estimate({ now: t, L: cfg.stickLen }); roomToWorld = fitRoom(ghostEst.corners); } catch { ghostEst = null; roomToWorld = null; }
    }
    for (const s of SLOTS) {
      const d = src[s], ok = on.mapjs && roomToWorld && ghostEst;
      const p = ok && ghostEst.people[s]; d.ghost.visible = !!p; if (p) d.ghost.position.set(...roomToWorld(p.p));
    }
    grid.visible = axes.visible = on.grid; tagsGrp.visible = on.tags && (W.FIXED_FIELD || !!getStage()?.state.scanned); detGrp.visible = on.tags; // fixed sheets are drawn where they are; other tags where they were first seen
    placeC();
    const st = getStage()?.state;
    note.textContent = W.FIXED_FIELD ? `タグ 0〜3 は中心に接して大きな正方形（床。時計回りに 0→1→2→3、隣の中心まで ${W.TAG_PITCH} m）に固定${st?.scanned ? '' : '。スキャンはスマホ C の位置用'}` : !st?.scanned ? 'フィールド未スキャン：タグは見えた場所に表示（スキャンするとフィールドの形も出る）' : on.mapjs && !roomToWorld ? 'map.js：床のタグ 2 枚以上を両スマホが見るまで照合できない' : '';
  }

  // ---- right panel: raw numbers, DOM touched only when the text changes ----
  const cells = new Map(), shown = new Map();
  function section(title, rows) {
    const h = document.createElement('h3'); h.textContent = title; panelEl.append(h);
    const tb = document.createElement('table');
    for (const [key, name] of rows) {
      const tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td'); b.className = 'v';
      a.textContent = name; tr.append(a, b); tb.append(tr); cells.set(key, b);
    }
    panelEl.append(tb);
  }
  const put = (key, text) => { if (shown.get(key) !== text) { shown.set(key, text); cells.get(key).textContent = text; } };
  const f1 = v => v == null || !isFinite(v) ? '-' : v.toFixed(1), f0 = v => v == null || !isFinite(v) ? '-' : v.toFixed(0);
  const vec = (v, d = 2) => v ? '[' + Array.from(v, x => x.toFixed(d)).join(', ') + ']' : '-';
  const ms = v => v == null ? '-' : (v * 1000).toFixed(0) + ' ms';
  for (const s of SLOTS) section(`スマホ ${s}`, [
    [s + 'name', '接続'], [s + 'src', '位置の元'], [s + 'chest', '位置 [x,y,z] m'], [s + 'yaw', '向き'], [s + 'fit', '合わせの残差'],
    [s + 'sword', '剣 根元→先端'], [s + 'swsrc', '剣の向きの元'], [s + 'tags', '見えているタグ'], [s + 'hz', '受信 Hz'], [s + 'lat', '遅延'],
  ]);
  section('スマホ C・フィールド', [['camT', 'カメラ位置'], ['camFov', '縦画角 / 解像度'], ['camErr', 'スキャン誤差'], ['field', 'フィールド'], ['ftags', 'タグ配置'], ['warn', '注意']]);
  const WARN_JA = [[/no gravity-aligned/, '旧アプリ（wp/wq なし）：localize.js で代用'], [/no camera intrinsics/, 'カメラの内部パラメータ未受信：推定値を使用']];
  function panel(t) {
    if (!est) return;
    const game = getGame();
    for (const s of SLOTS) {
      const g = est.slots[s], ph = hub.phones[s], p = game?.players[s];
      put(s + 'name', ph.online ? `${ph.name}${ph.addr ? ' · ' + ph.addr : ''}` : '未接続');
      put(s + 'src', g.src === 'ar' ? `ARCore をタグで合わせた${g.aligned ? '' : '（観測 3 未満）'}` : g.src === 'localize' ? '旧アプリ（キャリブ基準）': '-');
      put(s + 'chest', vec(g.chest));
      put(s + 'yaw', g.yaw == null ? '-' : `${(g.yaw / DEG).toFixed(1)}°`);
      put(s + 'fit', g.rms == null ? '-' : `${f1(g.rms * 100)} cm / ${g.n} 回${g.lastFix ? `　最終 ${f1(t - g.lastFix)} 秒前` : ''}`);
      put(s + 'sword', p ? `${vec(p.base.toArray())} → ${vec(p.tip.toArray())}` : '-');
      put(s + 'swsrc', p?.stickSrc ?? '-');
      put(s + 'tags', g.sightings?.length ? g.sightings.map(q => `${q.id}:${q.d.toFixed(2)}m`).join(' ') : '-');
      put(s + 'hz', ['ar', 'tags', 'imu'].map(ty => `${ty} ${f0(g.hz[ty])}`).join('  '));
      put(s + 'lat', ['ar', 'tags', 'imu'].map(ty => `${ty} ${ms(ph.lat[ty])}`).join('  '));
    }
    const tc = getStage()?.state.tagCam;
    put('camT', tc ? vec(tc.pose.t) : '未スキャン');
    put('camFov', tc ? `${f1(tc.fovY)}° / ${tc.width}×${tc.height}` : '-');
    put('camErr', tc ? `${f1(tc.reprojErrPx)} px` : '-');
    const xs = W.FIELD.poly.map(p => p[0]), zs = W.FIELD.poly.map(p => p[1]);
    put('field', `${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} m × ${(Math.max(...zs) - Math.min(...zs)).toFixed(2)} m${getStage()?.state.scanned ? '' : '（仮）'}`);
    put('ftags', W.CORNER_IDS.map(id => `${id}:${W.TAGS[id].stand ? '立' : '床'}${vec(W.TAGS[id].pos, 1)}`).join(' '));
    put('warn', (est.warn ?? []).map(w => (WARN_JA.find(([re]) => re.test(w))?.[1] ?? w).replace(/^/, w.match(/phone (\w)/)?.[1] ? w.match(/phone (\w)/)[1] + ': ' : '')).join('；') || '-');
  }

  let lastEst = 0, lastPanel = 0;
  return {
    /** Called every frame while the screen is visible. */
    frame(t, estimate) {
      if (t - lastEst > 1 / 30) { lastEst = t; update(t, estimate); }
      if (t - lastPanel > .25) { lastPanel = t; panel(t); }
      controls.update();
      renderer.render(scene, camera);
    },
    resize,
  };
}
