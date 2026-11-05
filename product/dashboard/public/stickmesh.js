// A scanned stick model (stickscan.js) as a three.js mesh: a lathe through the ring radii (m), its colours as a small texture
// (around x rings). Along y from -0.5 (grip) to 0.5 (tip), so it drops in for field3d's unit cylinder: scale.y = length, x / z = 1.
import * as THREE from 'three';

export function stickGeometry(m) {
  const N = m.rings, A = m.around, y = i => -.5 + (i + .5) / N;
  const pts = [[0, -.5], [m.r[0], -.5], ...m.r.map((r, i) => [r, y(i)]), [m.r[N - 1], .5], [0, .5]].map(([r, h]) => new THREE.Vector2(r, h));
  const geometry = new THREE.LatheGeometry(pts, 24);
  // lathe v runs over the points (0 = first): one texture row per point, the caps take the end rings' colours
  const c = Object.assign(document.createElement('canvas'), { width: A, height: pts.length }), g = c.getContext('2d'), img = g.createImageData(A, pts.length);
  pts.forEach((_, j) => {
    const ring = Math.max(0, Math.min(N - 1, j - 2)), row = pts.length - 1 - j; // the canvas' top row is v = 1
    for (let a = 0; a < A; a++) for (let k = 0; k < 3; k++) img.data[4 * (row * A + a) + k] = m.rgb[3 * (ring * A + a) + k];
    for (let a = 0; a < A; a++) img.data[4 * (row * A + a) + 3] = 255;
  });
  g.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = THREE.RepeatWrapping;
  return { geometry, texture };
}
