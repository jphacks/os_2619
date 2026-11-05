// A scanned stick model (stickscan.js, v 2) as a three.js geometry: per ring its centre offset and its radius at each angle, closed at
// both ends. Along y from -0.5 (grip) to 0.5 (tip), so it drops in for field3d's unit cylinder: scale.y = length, x / z = 1 (metres).
// x = the stick's side, z = up as it lay on the floor. Drawn in one solid colour (STICK_COLOR): the shape is what the scan measures.
import * as THREE from 'three';

export const STICK_COLOR = 0x7a4f2c; // brown

export function stickGeometry(m) {
  const N = m.rings, A = m.around, pos = [], idx = [];
  const vert = (r, a, y) => { const ph = 2 * Math.PI * a / A, rr = m.r[r * A + a]; pos.push(m.c[2 * r] + rr * Math.sin(ph), y, m.c[2 * r + 1] + rr * Math.cos(ph)); };
  // rings at their middles, plus the end rings again exactly at the ends
  const ys = [-.5, ...Array.from({ length: N }, (_, r) => -.5 + (r + .5) / N), .5], rs = [0, ...Array.from({ length: N }, (_, r) => r), N - 1];
  ys.forEach((y, k) => { for (let a = 0; a < A; a++) vert(rs[k], a, y); });
  const R = ys.length;
  for (let k = 0; k < R - 1; k++) for (let a = 0; a < A; a++) {
    const p = k * A + a, q = k * A + (a + 1) % A;
    idx.push(p, q, p + A, q, q + A, p + A);
  }
  // caps: a centre point at each end
  const c0 = pos.length / 3; pos.push(m.c[0], -.5, m.c[1]);
  const c1 = c0 + 1; pos.push(m.c[2 * (N - 1)], .5, m.c[2 * (N - 1) + 1]);
  for (let a = 0; a < A; a++) {
    idx.push(c0, (a + 1) % A, a);
    const o = (R - 1) * A; idx.push(c1, o + a, o + (a + 1) % A);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
