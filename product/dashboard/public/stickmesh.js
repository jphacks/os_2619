// A scanned stick model (stickscan.js, v 3: a tree of nodes and edges, thickness from the grip to the tip) as a three.js geometry:
// a tube per edge and a ball per node (the joints and the round ends). Along y from -0.5 (grip) to 0.5 (tip), so it drops in for
// field3d's unit cylinder: scale.y = length, x / z = 1 (metres). x = the stick's side, z = up as it lay on the floor (it lay flat: z 0).
// Drawn in one solid colour (STICK_COLOR): the shape is what the scan measures.
import * as THREE from 'three';

export const STICK_COLOR = 0x7a4f2c; // brown

export function stickGeometry(m) {
  const L = m.length, rAt = a => m.r[0] + (m.r[1] - m.r[0]) * Math.min(1, Math.max(0, a / L + .5)); // thickness by how far toward the tip
  const P = m.nodes.map(([s, a]) => new THREE.Vector3(s, a, 0)); // built in metres, y squeezed to the unit length at the end
  const pos = [], idx = [], mat = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const add = (g, M) => {
    const o = pos.length / 3, p = g.getAttribute('position'), v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(M); pos.push(v.x, v.y, v.z); }
    for (const i of g.index.array) idx.push(o + i);
    g.dispose();
  };
  m.nodes.forEach(([, a], i) => add(new THREE.SphereGeometry(rAt(a), 10, 6), mat.makeTranslation(P[i].x, P[i].y, P[i].z)));
  for (const [i, j] of m.edges) {
    const d = P[j].clone().sub(P[i]), len = d.length(); if (!len) continue;
    q.setFromUnitVectors(Y, d.clone().normalize());
    // CylinderGeometry: radiusTop at +y (node j), radiusBottom at -y (node i)
    add(new THREE.CylinderGeometry(rAt(m.nodes[j][1]), rAt(m.nodes[i][1]), len, 10, 1, true), mat.compose(P[i].clone().addScaledVector(d, .5), q, one));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  g.scale(1, 1 / L, 1); g.computeVertexNormals();
  return g;
}
