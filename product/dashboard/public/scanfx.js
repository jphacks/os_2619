// 新しい枝 (screen 6): the show while a phone scans a new stick (stickui.js 'stickscan' page events).
//  - waiting: the mahoujin, black lines on a white disc, in the dark
//  - scanning: gold motes spring up all around and are drawn into a hurricane over the middle: a funnel turning round the centre,
//    fastest at its eye, the motes climbing it; more motes, a taller, wider, faster storm with every picture taken; a hum swells with it
//  - building (the phone's 送信): the storm winds up, wider and faster, while the model is made (in a worker)
//  - built: the motes pull back, snap all at once into one point (a whoosh) and at once explode, the screen shakes and the stick is
//    there; gold and silver sparks dance round it, the mahoujin turns
//    gold, the camera closes in on the stick, "New Stick" fades in (a boom and a bright chime); 4 s after the boom the screen fades
//    to black and goes back to the game screen (onOk). The sounds are synthesised here (Web Audio, no files); the stick's entrance is an organ fanfare.
// mountScanFx(section, { onOk }) -> { setActive(on) }; it draws only while its screen is shown.
import * as THREE from 'three';
import { parseDesign } from './stickscan.js';
import { stickGeometry, STICK_COLOR } from './stickmesh.js';
import * as W from './world.js';

const N = 3000, SPARKS = 700, FULL_AT = 30, FIRST = 400; // motes; sparks after the build; pictures until every mote is out; motes at once when a scan starts
const GOLD = new THREE.Color(0xd9a520), SILVER = new THREE.Color(0xc9d3de), BLACK = new THREE.Color(0x111111);
const STICK_Y = .32; // m: the new stick floats this high over the mahoujin
const LEAVE = 4, FADE = .6; // s after the boom: the fade to black begins; its length (then the game screen)
const PULL = .35, SNAP = .3; // s: the pull back before the rush, the rush into one point (it explodes the moment they meet)
const ease = x => (x = Math.min(1, Math.max(0, x)), x * x * (3 - 2 * x));
const outCubic = x => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

// round soft dots, each with its own colour, size and alpha; plain blending: added as light they would vanish over the white disc
const dotMaterial = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  vertexShader: `attribute vec3 color; attribute float size, alpha; varying vec3 vC; varying float vA;
    void main() { vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = size * 300. / -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; varying float vA;
    void main() { float d = length(gl_PointCoord - .5); if (d > .5) discard; float core = smoothstep(.5, .0, d);
      gl_FragColor = vec4(mix(vC, vec3(1., .93, .6), core * core * .5), vA * min(1., core * 1.6)); }`,
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
    <div data-flash style="position:absolute;inset:0;background:#fff6dc;opacity:0;pointer-events:none"></div>
    <div class="scanfx-msg" data-msg></div>
    <div class="scanfx-title" data-title>New Stick</div>
    <div class="scanfx-name" data-name></div>
    <div data-fade style="position:absolute;inset:0;background:#000;opacity:0;pointer-events:none"></div>
  </div>`;
  const $ = s => section.querySelector(`[data-${s}]`), canvas = section.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x000000);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(40, 16 / 9, .01, 60);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x403828, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(1, 3, 2); scene.add(sun);
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

  // ---- the mahoujin: black lines on a white disc, a gold haze over them once the stick is made ----
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
      const disc = new THREE.Mesh(new THREE.CircleGeometry(d.r * mm + .02, 128), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      disc.rotation.x = -Math.PI / 2; circle.add(disc);
      for (const [mat, src, y] of [[glowMat, blur, .001], [lineMat, c, .002]]) {
        mat.map = new THREE.CanvasTexture(src); mat.map.colorSpace = THREE.SRGBColorSpace; mat.map.anisotropy = 8; mat.needsUpdate = true;
        const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.position.set((d.w / 2 - d.cx) * mm, y, (d.h / 2 - d.cy) * mm); circle.add(m); // the design's centre (cx, cy) at the origin
      }
    }).catch(e => console.warn('scan show: mahoujin', e));

  // ---- motes: each springs up somewhere around (from), then is drawn into the hurricane (its own height, place round it, width) ----
  const motes = cloud(N); scene.add(motes);
  const from = new Float32Array(3 * N), orbit = new Float32Array(4 * N), start = new Float32Array(3 * N), vel = new Float32Array(3 * N), ang = new Float32Array(N);
  const came = new Float32Array(N).fill(-1); // when it sprang up (s), -1: not yet
  const CENTRE = V(0, STICK_Y, 0);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * 2 * Math.PI, r = .6 + Math.random() * 3.4; // anywhere around, in the air and low over the floor
    from.set([r * Math.cos(a), .05 + Math.random() * 2.2, r * Math.sin(a)], 3 * i);
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
  const stickMat = new THREE.MeshStandardMaterial({ color: STICK_COLOR, roughness: .7, emissive: GOLD, emissiveIntensity: 0 });
  const stick = new THREE.Mesh(new THREE.BufferGeometry(), stickMat), holder = new THREE.Group();
  holder.add(stick); holder.position.copy(CENTRE); holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(0, 0, 1), V(1, 0, 0), V(0, 1, 0))); scene.add(holder);
  holder.visible = false;
  holder.visible = sparks.visible = true; renderer.compile(scene, cam); holder.visible = sparks.visible = false; // their shaders now, not at the boom

  // ---- sound (synthesised): a hum while scanning, a whoosh into the point, a boom and a chime as the stick appears ----
  let ac = null, humV = null;
  const audio = () => { try { ac ??= new AudioContext(); if (ac.state === 'suspended') ac.resume(); return ac.state === 'running' ? ac : null; } catch { return null; } };
  function hum(level) { // level 0..1: louder and a little higher the more pictures there are; 0 fades it out
    const c = level > 0 ? audio() : ac; if (!c) return;
    if (!humV && level > 0) {
      const out = c.createGain(), lp = c.createBiquadFilter(); out.gain.value = 0; lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 4;
      const os = [55, 55.7, 110.4].map(f => { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(); return o; });
      lp.connect(out).connect(c.destination); humV = { out, lp, os };
    }
    if (!humV) return;
    const t = c.currentTime;
    humV.out.gain.setTargetAtTime(.12 * level, t, .2); humV.lp.frequency.setTargetAtTime(350 + 900 * level, t, .3);
    humV.os.forEach((o, i) => o.frequency.setTargetAtTime([55, 55.7, 110.4][i] * (1 + .25 * level), t, .3));
    if (level === 0 && humV.out.gain.value < .002) { humV.os.forEach(o => o.stop()); humV.out.disconnect(); humV = null; }
  }
  const noise = (c, sec) => { const b = c.createBuffer(1, c.sampleRate * sec, c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; const n = c.createBufferSource(); n.buffer = b; return n; };
  function whoosh() { // noise swept up through a band-pass, peaking as the motes meet
    const c = audio(); if (!c) return;
    const n = noise(c, 1), bp = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime; bp.type = 'bandpass'; bp.Q.value = 2;
    bp.frequency.setValueAtTime(150, t); bp.frequency.exponentialRampToValueAtTime(5000, t + PULL + SNAP);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.4, t + PULL + SNAP); g.gain.exponentialRampToValueAtTime(.001, t + PULL + SNAP + .15);
    n.connect(bp).connect(g).connect(c.destination); n.start(t); n.stop(t + 1);
  }
  function boom() { // a low thud dropping in pitch under a burst of noise
    const c = audio(); if (!c) return;
    const t = c.currentTime, o = c.createOscillator(), og = c.createGain(), n = noise(c, .8), lp = c.createBiquadFilter(), ng = c.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(38, t + .6);
    og.gain.setValueAtTime(.7, t); og.gain.exponentialRampToValueAtTime(.001, t + .9);
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(3000, t); lp.frequency.exponentialRampToValueAtTime(200, t + .6);
    ng.gain.setValueAtTime(.35, t); ng.gain.exponentialRampToValueAtTime(.001, t + .7);
    o.connect(og).connect(c.destination); n.connect(lp).connect(ng).connect(c.destination);
    o.start(t); o.stop(t + 1); n.start(t); n.stop(t + .8);
  }
  // an organ fanfare: four-note chords climbing (the top voice C5 D5 E5 G5, landing on C6), the last one held. Each note a drawbar
  // organ (sines on the 16' 8' 4' 2⅔' 2' footages, a little vibrato), quick swell in and out like a pipe.
  const FANFARE = [[.0, .16, [261.63, 329.63, 392, 523.25]], [.17, .16, [293.66, 392, 493.88, 587.33]], [.34, .16, [329.63, 392, 523.25, 659.25]],
    [.51, .22, [392, 523.25, 659.25, 783.99]], [.76, 1.7, [523.25, 659.25, 783.99, 1046.5]]]; // [start s, length s, Hz]
  function chime() {
    const c = audio(); if (!c) return;
    const t0 = c.currentTime + .05, out = c.createGain(), vib = c.createOscillator(), vibG = c.createGain();
    out.gain.value = .045; out.connect(c.destination); vib.frequency.value = 6; // 20 sines at once: kept low under the boom vibG.gain.value = 2.5; vib.connect(vibG); vib.start(t0); vib.stop(t0 + 2.8);
    for (const [at, len, chord] of FANFARE) for (const f of chord) for (const [m, v] of [[.5, .5], [1, 1], [2, .7], [3, .35], [4, .3]]) {
      const o = c.createOscillator(), g = c.createGain(), s = t0 + at, e = s + len;
      o.frequency.value = f * m; vibG.connect(o.detune); o.connect(g).connect(out);
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(v, s + .02); g.gain.setValueAtTime(v, e - .04); g.gain.linearRampToValueAtTime(0, e + (len > 1 ? .5 : .03));
      o.start(s); o.stop(e + .6);
    }
  }

  // ---- state ----
  let phase = 'idle', t = 0, phaseAt = 0, pictures = 0, rec = null, active = false, level = 0;
  const storm = { h: .4, eye: .25, top: .7, spin: 1.5, rise: .06 }; // the hurricane's height, its eye's and top's radius (m), turn and climb speeds
  const go = p => { phase = p; phaseAt = t; };
  function reset() {
    go('idle'); pictures = 0; level = 0; rec = null; came.fill(-1); sparks.visible = false; holder.visible = false; stickMat.emissiveIntensity = 0;
    lineMat.color.copy(BLACK); glowMat.opacity = 0; $('flash').style.opacity = 0; $('fade').style.opacity = 0;
    for (const k of ['title', 'name']) $(k).classList.remove('on');
    $('msg').textContent = ''; $('msg').classList.remove('off');
  }
  function rush() { // every mote, out or not yet, from where it is now
    const pos = motes.geometry.attributes.position.array;
    for (let i = 0; i < N; i++) {
      if (came[i] < 0) { came[i] = t; start.set(from.subarray(3 * i, 3 * i + 3), 3 * i); } else start.set(pos.subarray(3 * i, 3 * i + 3), 3 * i);
    }
    go('rush'); whoosh(); $('msg').classList.add('off');
  }
  function explode() {
    for (let i = 0; i < N; i++) { // out in every direction, more up than down
      const u = Math.random() * 2 - 1, a = Math.random() * 2 * Math.PI, s = 1.5 + Math.random() * 4, r = Math.sqrt(1 - u * u);
      vel.set([r * Math.cos(a) * s, (Math.abs(u) * .8 + u * .2) * s, r * Math.sin(a) * s], 3 * i);
    }
    holder.visible = true; go('boom'); boom(); chime();
  }
  addEventListener('stickscan', e => {
    const k = e.detail;
    if (k.step === 'start') { reset(); go('scan'); $('msg').textContent = 'スキャン中… 枝のまわりを歩いて撮影してください'; }
    if (k.step === 'picture' && phase === 'scan') { pictures = k.n; $('msg').textContent = `スキャン中… 写真 ${k.n} 枚`; }
    if (k.step === 'cancel') reset();
    if (k.step === 'building' && phase === 'scan') { go('charge'); $('msg').textContent = '棒を作っています…'; }
    if (k.step === 'built') {
      rec = k.rec; const g = stickGeometry(rec.model);
      stick.geometry.dispose(); stick.geometry = g || new THREE.BufferGeometry(); stick.scale.set(1, rec.model.length, 1);
      $('name').textContent = `${rec.name}・${{ fire: '炎', thunder: '雷', water: '水', wind: '風' }[rec.element] ?? rec.element}`;
      if (phase !== 'rush' && phase !== 'boom') rush(); // they meet and explode at once (frame)
    }
    if (k.step === 'failed') { reset(); $('msg').textContent = '棒を作れませんでした：' + k.error; }
  });

  // ---- camera: the whole mahoujin from the front and above, closing in on the stick once it is made ----
  const far = { p: V(0, 1.55, 2.1), at: V(0, 0, .05) }, near = { p: V(0, .62, .95), at: CENTRE.clone() };
  const p = V(), o = V();
  function frame(dt) {
    t += dt; const T = t - phaseAt, pos = motes.geometry.attributes.position, al = motes.geometry.attributes.alpha;
    if (phase === 'rush' && T >= PULL + SNAP) explode();
    // motes
    const storming = phase === 'scan' || phase === 'charge';
    const want = phase === 'idle' ? 0 : phase === 'scan' ? FIRST + (N - FIRST) * Math.min(1, pictures / FULL_AT) : N;
    hum(phase === 'scan' ? .25 + .75 * Math.min(1, pictures / FULL_AT) : phase === 'charge' ? 1 : 0);
    level += ((phase === 'charge' ? 1.35 : phase === 'scan' ? Math.min(1, pictures / FULL_AT) : 0) - level) * Math.min(1, dt * 1.5); // eased: the storm grows smoothly
    storm.h = .4 + .5 * level; storm.eye = .25 + .1 * level; storm.top = .7 + .8 * level; storm.spin = 1.5 + 3.5 * level; storm.rise = .06 + .12 * level; // wide: over the whole mahoujin and past it
    for (let i = 0; i < N; i++) {
      if (came[i] < 0) { if (storming && i < want) came[i] = t; else { al.setX(i, 0); continue; } }
      if (storming || phase === 'idle') { // the hurricane: a wide funnel widening upward, turning faster nearer its eye, the motes climbing it
        const hy = (orbit[4 * i + 2] / .52 + storm.rise * t) % 1, R = (storm.eye + storm.top * hy ** 1.2) * (.6 + .8 * (orbit[4 * i] - .15) / .75);
        ang[i] += dt * storm.spin * .6 / (R + .2);
        o.set(R * Math.cos(ang[i]), .02 + hy * storm.h, R * Math.sin(ang[i]));
        const k = ease((t - came[i] - .6) / 2.5); // it springs up where it is, then is sucked in
        p.fromArray(from, 3 * i).lerp(o, k); p.y += .05 * Math.sin(2 * t + i) * (1 - k);
        const ends = k < 1 ? 1 : Math.min(1, hy * 8, (1 - hy) * 5); // no pop where a mote leaves the top and starts again at the foot
        al.setX(i, .9 * (.55 + .45 * Math.sin(6 * t + i * 1.7)) * Math.min(1, (t - came[i]) * 1.5) * ends);
      } else if (phase === 'rush') { // pull back, then snap into one point and wait there, crackling
        p.fromArray(start, 3 * i).sub(CENTRE);
        const out = T < PULL ? 1 + .3 * outCubic(T / PULL) : 1.3 * (1 - Math.min(1, (T - PULL) / SNAP) ** 3);
        p.multiplyScalar(out).add(CENTRE);
        if (T > PULL + SNAP) p.x += (Math.random() - .5) * .03, p.y += (Math.random() - .5) * .03, p.z += (Math.random() - .5) * .03;
        al.setX(i, .9);
      } else { // boom: out from the point, slowing, fading
        const f = (1 - Math.exp(-3 * T)) / 3;
        p.set(vel[3 * i] * f, vel[3 * i + 1] * f, vel[3 * i + 2] * f).add(CENTRE);
        al.setX(i, .95 * (1 - ease(T / 1.3)));
      }
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = al.needsUpdate = true;
    // after the boom: the stick pops in, the flash, the circle turning gold, the sparks, the words
    const B = phase === 'boom' ? T : -1, made = B < 0 ? 0 : 1;
    holder.scale.setScalar(B < 0 ? 1 : 1 + .45 * Math.exp(-9 * B) * Math.cos(14 * B));
    stickMat.emissiveIntensity = B < 0 ? 0 : .35 + 1.5 * Math.exp(-4 * B) + .1 * Math.sin(4 * t);
    $('flash').style.opacity = B < 0 ? 0 : (.85 * Math.exp(-7 * B)).toFixed(3);
    const gold = B < 0 ? 0 : ease(B / .6);
    lineMat.color.copy(BLACK).lerp(GOLD, gold); glowMat.opacity = .55 * gold * (.85 + .15 * Math.sin(2.5 * t));
    sparks.visible = B > .15;
    if (sparks.visible) {
      const sp = sparks.geometry.attributes.position, sa = sparks.geometry.attributes.alpha, ss = sparks.geometry.attributes.size;
      for (let i = 0; i < SPARKS; i++) {
        const [R, ph, h0, up, w] = spark.subarray(5 * i, 5 * i + 5), y = (h0 + up * t) % 1, a = ph + w * t;
        sp.setXYZ(i, R * Math.cos(a), .02 + y * .9, R * Math.sin(a));
        sa.setX(i, ease((B - .15) / .5) * Math.sin(y * Math.PI) * (.6 + .4 * Math.sin(9 * t + ph * 7)));
        ss.setX(i, .03 + .035 * Math.abs(Math.sin(5 * t + ph * 3)));
      }
      sp.needsUpdate = sa.needsUpdate = ss.needsUpdate = true;
    }
    const z = B < 0 ? 0 : ease((B - .6) / 2);
    cam.position.lerpVectors(far.p, near.p, z); cam.lookAt(V().lerpVectors(far.at, near.at, z));
    const shake = B < 0 ? 0 : .06 * Math.exp(-5 * B); // the screen shakes with the boom
    if (shake > .001) cam.position.add(o.set((Math.random() - .5) * shake, (Math.random() - .5) * shake, (Math.random() - .5) * shake));
    if (B > 1.6) { $('title').classList.add('on'); $('name').classList.add('on'); }
    if (B > LEAVE) $('fade').style.opacity = ease((B - LEAVE) / FADE).toFixed(3); // 4 s after the stick appears: fade to black, then the game
    if (B > LEAVE + FADE) { reset(); onOk(); }
    renderer.render(scene, cam);
  }
  let last = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!active) { hum(0); return; }
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    if (canvas.width !== Math.floor(w * devicePixelRatio)) { renderer.setPixelRatio(devicePixelRatio); renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    frame(dt);
  })(last);
  reset();
  return { setActive(on) { active = !!on; } };
}
