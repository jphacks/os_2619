// A picture of a scanned stick's 3D model (stickscan.js v 3) for the phones' Stick menu: rendered here on the dashboard and saved by
// the server (POST /sticks snap, PUT /sticks/<id>/snap), so a phone only downloads a small JPEG.
// The view: straight down on the side it lay on (the model is flat there, so every bend and branch shows), tipped back a little for
// depth, grip on the left, the whole stick filling the width, on the menu card's dark grey.
import * as THREE from 'three';
import { stickGeometry, STICK_COLOR } from './stickmesh.js';

const W = 640, H = 320, TILT = .45; // px; rad the stick is tipped back toward the viewer
let r = null;

/** Make the renderer and compile its shader now (page load), so the first real picture does not stall the page mid-show. */
export function warmSnapshot() { stickSnapshot({ v: 3, length: .5, r: [.01, .01], tip: 1, nodes: [[0, -.25], [0, .25]], edges: [[0, 1]] }); }

/** JPEG data URL of the model, or null for one stickmesh.js cannot draw. */
export function stickSnapshot(m) {
  const g = stickGeometry(m); if (!g) return null;
  r ??= new THREE.WebGLRenderer({ canvas: Object.assign(document.createElement('canvas'), { width: W, height: H }), antialias: true, preserveDrawingBuffer: true });
  r.setSize(W, H, false); r.setClearColor(0x16181d);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3020, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(-1, 2, 3); scene.add(sun);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: STICK_COLOR, roughness: .75 }));
  mesh.scale.set(1, m.length, 1); // the geometry runs -0.5..0.5 along y
  const turn = new THREE.Group(); turn.add(mesh); turn.rotation.set(-TILT, 0, Math.PI / 2); scene.add(turn); // along -> x (grip left), up as it lay -> toward the camera
  const box = new THREE.Box3().setFromObject(turn), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const half = Math.max(s.x / 2 / (W / H), s.y / 2) * 1.12; // fit the whole stick with a margin
  const cam = new THREE.OrthographicCamera(-half * W / H, half * W / H, half, -half, .01, 10);
  cam.position.set(c.x, c.y, c.z + 3); cam.lookAt(c);
  r.render(scene, cam);
  g.dispose(); mesh.material.dispose();
  return r.domElement.toDataURL('image/jpeg', .85);
}
