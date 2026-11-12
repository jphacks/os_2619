// 新しい枝 (screen 6): the show while a phone scans a new stick (stickui.js 'stickscan' page events).
//  - waiting: the mahoujin in black on pure white
//  - scanning: gold motes drift in from everywhere and circle over it, more with every picture taken
//  - building (the phone's 送信): every mote rushes to the middle; once the model is saved they settle into the stick's own shape,
//    the stick appears, gold and silver sparks dance round it, the mahoujin turns gold, the camera closes in on the stick,
//    「新しい棒」 and then an OK button fade in. OK goes back to the game screen (onOk).
// mountScanFx(section, { onOk }) -> { setActive(on) }; it draws only while its screen is shown.
import * as THREE from 'three';
import { parseDesign } from './stickscan.js';
import { stickGeometry, STICK_COLOR } from './stickmesh.js';
import * as W from './world.js';

const N = 3000, SPARKS = 700, FULL_AT = 30; // motes; sparks after the build; the pictures after which every mote has come
const GOLD = new THREE.Color(0xd9a520), SILVER = new THREE.Color(0xc9d3de), BLACK = new THREE.Color(0x111111);
const STICK_Y = .32; // m: the new stick floats this high over the mahoujin
const ease = x => (x = Math.min(1, Math.max(0, x)), x * x * (3 - 2 * x));

// round soft dots, each with its own colour, size and alpha; normal blending (additive would vanish on white)
const dotMaterial = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  vertexShader: `attribute vec3 color; attribute float size, alpha; varying vec3 vC; varying float vA;
    void main() { vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = size * 300. / -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; varying float vA;
    void main() { float d = length(gl_PointCoord - .5); if (d > .5) discard; float core = smoothstep(.5, .0, d);
      gl_FragColor = vec4(mix(vC, vec3(1., .97, .85), core * core * .6), vA * core); }`,
});
function cloud(n) {
  const g = new THREE.BufferGeometry();
  for (const [k, s] of [['position', 3], ['color', 3], ['size', 1], ['alpha', 1]]) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n * s), s));
  const p = new THREE.Points(g, dotMaterial()); p.frustumCulled = false;
  return p;
}

export function mountScanFx(section, { onOk = () => {} } = {}) {
  section.innerHTML = `<div class="scanfx">
    <canvas></canvas>
    <div class="scanfx-msg" data-msg></div>
    <div class="scanfx-title" data-title>新しい棒</div>
    <div class="scanfx-name" data-name></div>
    <button class="scanfx-ok" data-ok>OK</button>
  </div>`;
  const $ = s => section.querySelector(`[data-${s}]`), canvas = section.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0xffffff);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(40, 16 / 9, .01, 60);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0a890, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(1, 3, 2); scene.add(sun);

  // ---- the mahoujin: black lines on the white floor, a gold haze over them once the stick is made ----
  const lineMat = new THREE.MeshBasicMaterial({ color: BLACK.clone(), transparent: true, depthWrite: false });
  const glowMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0, depthWrite: false });
  const circle = new THREE.Group(); scene.add(circle);
  fetch('mahoujin-design.bin.gz')
    .then(r => r.ok ? new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : Promise.reject(new Error(r.status)))
    .then(b => {
      const d = parseDesign(new Uint8Array(b)), c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
      const g = c.getContext('2d'), img = g.createImageData(d.w, d.h);
      for (let i = 0; i < d.ink.length; i++) { const k = d.ink[i]; img.data.set([255, 255, 255, k > 110 ? k : 0], 4 * i); } // the faint construction lines left out
      g.putImageData(img, 0, 0);
      const blur = document.createElement('canvas'); blur.width = d.w >> 2; blur.height = d.h >> 2;
      const bg = blur.getContext('2d'); bg.filter = 'blur(3px)'; bg.drawImage(c, 0, 0, blur.width, blur.height); bg.drawImage(blur, 0, 0); // a soft halo of the same lines
      const mm = W.RUNE_SCALE / 1000, geo = new THREE.PlaneGeometry(d.w * mm, d.h * mm);
      for (const [mat, src, y] of [[glowMat, blur, .001], [lineMat, c, .002]]) {
        mat.map = new THREE.CanvasTexture(src); mat.map.colorSpace = THREE.SRGBColorSpace; mat.map.anisotropy = 8; mat.needsUpdate = true;
        const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.position.set((d.w / 2 - d.cx) * mm, y, (d.h / 2 - d.cy) * mm); circle.add(m); // the design's centre (cx, cy) at the origin
      }
    }).catch(e => console.warn('scan show: mahoujin', e));

  // ---- motes: each comes from far away (from) to its own orbit over the circle, then to its place on the stick (to) ----
  const motes = cloud(N); scene.add(motes);
  const from = new Float32Array(3 * N), orbit = new Float32Array(4 * N), to = new Float32Array(3 * N), start = new Float32Array(3 * N);
  const came = new Float32Array(N).fill(-1); // when it set off (s), -1: not yet
  for (let i = 0; i < N; i++) {
    const a = Math.random() * 2 * Math.PI, el = (Math.random() - .3) * 1.2, r = 4 + Math.random() * 5;
    from.set([r * Math.cos(a) * Math.cos(el), 1 + r * Math.sin(el), r * Math.sin(a) * Math.cos(el)], 3 * i);
    orbit.set([.15 + Math.random() * .75, Math.random() * 2 * Math.PI, .02 + Math.random() * .5, (.25 + Math.random() * .5) * (Math.random() < .5 ? 1 : -1)], 4 * i); // radius, phase, height, turn speed
    motes.geometry.attributes.color.setXYZ(i, ...GOLD.clone().offsetHSL((Math.random() - .5) * .04, 0, (Math.random() - .5) * .2).toArray());
    motes.geometry.attributes.size.setX(i, .02 + Math.random() * .035);
  }
  const sparks = cloud(SPARKS); scene.add(sparks); sparks.visible = false;
  const spark = new Float32Array(5 * SPARKS); // radius, phase, height, rise speed, turn speed
  for (let i = 0; i < SPARKS; i++) {
    spark.set([.15 + Math.random() * .7, Math.random() * 2 * Math.PI, Math.random(), .08 + Math.random() * .25, (.6 + Math.random()) * (Math.random() < .5 ? 1 : -1)], 5 * i);
    sparks.geometry.attributes.color.setXYZ(i, ...(Math.random() < .55 ? GOLD : SILVER).toArray());
  }

  // ---- the stick: lying across the view, made of its model (stickmesh.js: y along, x side, z up as it lay) ----
  const stickMat = new THREE.MeshStandardMaterial({ color: STICK_COLOR, roughness: .7, emissive: GOLD, emissiveIntensity: 0, transparent: true, opacity: 0 });
  const stick = new THREE.Mesh(new THREE.BufferGeometry(), stickMat), holder = new THREE.Group();
  holder.add(stick); holder.position.y = STICK_Y; holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(0, 0, 1), V(1, 0, 0), V(0, 1, 0))); scene.add(holder);
  function V(x, y, z) { return new THREE.Vector3(x, y, z); }

  // ---- state ----
  let phase = 'idle', t = 0, phaseAt = 0, pictures = 0, rec = null, active = false, okShown = false;
  const go = (p, now = t) => { phase = p; phaseAt = now; };
  const capture = () => { start.set(motes.geometry.attributes.position.array); };
  function reset() {
    go('idle'); pictures = 0; rec = null; came.fill(-1); sparks.visible = false; stickMat.opacity = 0; stickMat.emissiveIntensity = 0;
    lineMat.color.copy(BLACK); glowMat.opacity = 0; okShown = false;
    for (const k of ['title', 'name', 'ok']) $(k).classList.remove('on');
    $('msg').textContent = ''; $('msg').classList.remove('off');
  }
  // the line the motes rush to before the model is known: along x, over the middle
  function aimAtMiddle() { for (let i = 0; i < N; i++) to.set([(Math.random() - .5) * .9, STICK_Y + (Math.random() - .5) * .04, (Math.random() - .5) * .04], 3 * i); }
  // places on the stick's wood: a random edge (by length), a random point along it, a little off its axis by its thickness
  function aimAtStick(m) {
    const L = m.length, rAt = a => m.r[0] + (m.r[1] - m.r[0]) * Math.min(1, Math.max(0, a / L + .5));
    const lens = m.edges.map(([i, j]) => Math.hypot(m.nodes[j][0] - m.nodes[i][0], m.nodes[j][1] - m.nodes[i][1])), sum = lens.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < N; k++) {
      let x = Math.random() * sum, e = 0; while (e < lens.length - 1 && x > lens[e]) x -= lens[e++];
      const [i, j] = m.edges[e] ?? [0, 0], f = Math.random(), s = m.nodes[i][0] + (m.nodes[j][0] - m.nodes[i][0]) * f, a = m.nodes[i][1] + (m.nodes[j][1] - m.nodes[i][1]) * f;
      const r = rAt(a) * Math.sqrt(Math.random()), ang = Math.random() * 2 * Math.PI;
      to.set([a, STICK_Y + r * Math.sin(ang), s + r * Math.cos(ang)], 3 * k); // model along -> x, side -> z, up -> y (holder's turn)
    }
  }
  addEventListener('stickscan', e => {
    const k = e.detail;
    if (k.step === 'start') { reset(); go('scan'); $('msg').textContent = 'スキャン中… 枝のまわりを歩いて撮影してください'; }
    if (k.step === 'picture' && phase === 'scan') { pictures = k.n; $('msg').textContent = `スキャン中… 写真 ${k.n} 枚`; }
    if (k.step === 'cancel') reset();
    if (k.step === 'building') { capture(); aimAtMiddle(); go('rush'); $('msg').classList.add('off'); }
    if (k.step === 'built') {
      rec = k.rec; const g = stickGeometry(rec.model);
      stick.geometry.dispose(); stick.geometry = g || new THREE.BufferGeometry(); stick.scale.set(1, rec.model.length, 1);
      capture(); aimAtStick(rec.model); go('form');
      $('name').textContent = `${rec.name}・${{ fire: '炎', thunder: '雷', water: '水', wind: '風' }[rec.element] ?? rec.element}`;
    }
    if (k.step === 'failed') { $('msg').textContent = '棒を作れませんでした：' + k.error; $('msg').classList.remove('off'); go('idle'); came.fill(-1); }
  });
  $('ok').onclick = () => { reset(); onOk(); };

  // ---- camera: the whole mahoujin from the front and above, closing in on the stick once it is made ----
  const far = { p: V(0, 1.55, 2.1), at: V(0, 0, .05) }, near = { p: V(0, .62, .95), at: V(0, STICK_Y, 0) };
  function frame(dt) {
    t += dt; const T = t - phaseAt, pos = motes.geometry.attributes.position, al = motes.geometry.attributes.alpha;
    // motes
    const want = phase === 'idle' ? 60 : phase === 'scan' ? 60 + (N - 60) * Math.min(1, pictures / FULL_AT) : N;
    for (let i = 0; i < N; i++) if (came[i] < 0 && i < want) came[i] = t - (phase === 'rush' ? 1.2 : 0); // the rush brings everyone at once
    for (let i = 0; i < N; i++) {
      const [R, ph, h, w] = orbit.subarray(4 * i, 4 * i + 4), o = [R * Math.cos(ph + w * t), h + .03 * Math.sin(3 * t + ph), R * Math.sin(ph + w * t)];
      let p;
      if (came[i] < 0) { al.setX(i, 0); continue; }
      const k = ease((t - came[i]) / 2.2), f = from.subarray(3 * i, 3 * i + 3);
      p = [f[0] + (o[0] - f[0]) * k, f[1] + (o[1] - f[1]) * k + Math.sin(k * Math.PI) * .6, f[2] + (o[2] - f[2]) * k]; // in on an arc
      if (phase === 'rush' || phase === 'form' || phase === 'done') {
        const q = ease(T / (phase === 'rush' ? .7 : 1.1)), s = start.subarray(3 * i, 3 * i + 3), d = to.subarray(3 * i, 3 * i + 3);
        p = [s[0] + (d[0] - s[0]) * q, s[1] + (d[1] - s[1]) * q, s[2] + (d[2] - s[2]) * q];
        if (phase === 'rush') { const j = .04 * (1 - q); p[0] += (Math.random() - .5) * j; p[1] += (Math.random() - .5) * j; } // a crackle while they gather
      }
      pos.setXYZ(i, ...p);
      al.setX(i, phase === 'form' || phase === 'done' ? .95 * (1 - ease((t - phaseAt - .9) / .8)) : .9 * Math.min(1, (t - came[i]) * 2));
    }
    pos.needsUpdate = al.needsUpdate = true;
    if (phase === 'form' && T > 1.1) go('done');
    // the stick, the circle turning gold, the sparks, the words
    const made = phase === 'done' ? 1 : phase === 'form' ? ease((T - .6) / .6) : 0, shown = phase === 'done' ? t - phaseAt + 1.1 : phase === 'form' ? T : 0;
    stickMat.opacity = made; stickMat.emissiveIntensity = .35 * made * (1 + .3 * Math.sin(4 * t));
    lineMat.color.copy(BLACK).lerp(GOLD, made); glowMat.opacity = .55 * made * (.85 + .15 * Math.sin(2.5 * t));
    sparks.visible = made > 0;
    if (sparks.visible) {
      const sp = sparks.geometry.attributes.position, sa = sparks.geometry.attributes.alpha, ss = sparks.geometry.attributes.size;
      for (let i = 0; i < SPARKS; i++) {
        const [R, ph, h0, up, w] = spark.subarray(5 * i, 5 * i + 5), y = (h0 + up * t) % 1, a = ph + w * t;
        sp.setXYZ(i, R * Math.cos(a), .02 + y * .9, R * Math.sin(a));
        sa.setX(i, made * Math.sin(y * Math.PI) * (.6 + .4 * Math.sin(9 * t + ph * 7)));
        ss.setX(i, .03 + .035 * Math.abs(Math.sin(5 * t + ph * 3)));
      }
      sp.needsUpdate = sa.needsUpdate = ss.needsUpdate = true;
    }
    const z = ease((shown - 1.1) / 2.2);
    cam.position.lerpVectors(far.p, near.p, z); cam.lookAt(V().lerpVectors(far.at, near.at, z));
    if (shown > 2.4) { $('title').classList.add('on'); $('name').classList.add('on'); }
    if (shown > 3.6 && !okShown) { okShown = true; $('ok').classList.add('on'); }
    renderer.render(scene, cam);
  }
  let last = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!active) return;
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    if (canvas.width !== Math.floor(w * devicePixelRatio)) { renderer.setPixelRatio(devicePixelRatio); renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    frame(dt);
  })(last);
  reset();
  return { setActive(on) { active = !!on; } };
}
