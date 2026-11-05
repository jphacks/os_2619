// Stick scan on the dashboard: the phones' { type: 'scan' } pictures in, a model out (stickscan.js), saved by the server
// ({ type: 'setStick' } -> sticks.json -> { type: 'stick' } to every page, which puts it in the game: field3d.js setStick).
// createStickScan(hub, onText): collects one scan per slot; onText(slot, text) says how far it got.
// createStickView(canvas): the model turning slowly, for the connection screen.
import * as THREE from 'three';
import { buildStick, viewCamera } from './stickscan.js';
import { stickGeometry, STICK_COLOR } from './stickmesh.js';

async function decode(jpg) {
  const blob = await (await fetch('data:image/jpeg;base64,' + jpg)).blob(), bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0); bmp.close();
  return g.getImageData(0, 0, c.width, c.height);
}

export function createStickScan(hub, onText) {
  const scans = {}; // slot -> { views: [], jobs: [], noPose: 0 }
  const fresh = () => ({ views: [], jobs: [], noPose: 0 });
  const say = (slot, s) => onText(slot, `写真 ${s.views.length} 枚${s.noPose ? ` · タグ不足で捨てた ${s.noPose} 枚` : ''}`);
  return {
    async ingest(k) {
      const slot = k.slot;
      if (k.step === 'start' || !scans[slot]) scans[slot] = fresh();
      const s = scans[slot];
      if (k.step === 'cancel') { delete scans[slot]; return onText(slot, 'スキャンを中止しました'); }
      if (k.step === 'stick' && k.jpg) {
        const job = decode(k.jpg).then(img => {
          const cam = viewCamera(k.tags, k.k, img.width, img.height);
          if (cam) s.views.push({ img, cam }); else s.noPose++;
          say(slot, s);
        }).catch(e => console.warn('stick scan picture', e));
        s.jobs.push(job);
      }
      if (k.step === 'done') {
        await Promise.all(s.jobs);
        onText(slot, `モデルを作成中…（写真 ${s.views.length} 枚）`);
        await new Promise(r => setTimeout(r, 30)); // let the text show: the build holds this thread for ~1 s
        try {
          // shortcut: runs on the page's thread (~1 s per scan); move to a worker if it stutters a match
          const model = buildStick(s.views);
          hub.send({ type: 'setStick', slot, model });
          const thick = (r, a = model.around) => (2000 * Math.max(...model.r.slice(r * a, (r + 1) * a))).toFixed(0); // the widest diameter of a ring, mm
          onText(slot, `作成しました：長さ ${(model.length * 100).toFixed(0)} cm、太さ 根元 ${thick(2)} mm・中ほど ${thick(model.rings >> 1)} mm・先 ${thick(model.rings - 3)} mm（${model.views} 方向から）`);
        } catch (e) { onText(slot, '作成できませんでした：' + e.message); console.warn(e); }
        delete scans[slot];
      }
    },
  };
}

export function createStickView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, 2, .01, 10);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(1, 2, 3); scene.add(sun);
  const mat = new THREE.MeshStandardMaterial({ color: STICK_COLOR, roughness: .8 }), mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  const holder = new THREE.Group(); holder.rotation.z = Math.PI / 2; holder.add(mesh); scene.add(holder); // lying across the view, tip to the left
  let model = null;
  return {
    set(m) {
      model = m; mesh.geometry.dispose();
      mesh.geometry = m ? stickGeometry(m) : new THREE.BufferGeometry(); if (!m) return;
      mesh.scale.set(1, m.length, 1);
      cam.position.set(0, 0, m.length * .62 / Math.tan(15 * Math.PI / 180) / Math.max(1, cam.aspect)); cam.lookAt(0, 0, 0); // the length fills the width
    },
    get model() { return model; },
    frame(t) { // every animation frame while the connection screen shows
      if (!model) return;
      const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
      if (canvas.width !== Math.floor(w * devicePixelRatio)) // three sizes the canvas with floor()
        { renderer.setPixelRatio(devicePixelRatio); renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); this.set(model); }
      mesh.rotation.y = t * .6; holder.rotation.x = .25;
      renderer.render(scene, cam);
    },
  };
}
