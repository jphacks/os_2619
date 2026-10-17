// MediaPipe pose (vision.js) -> the 3D joints that the game's avatars copy. Plain JS (no deps), so node can test it.
//
// Input: one person from vision.js ({ pts: 33 x [u, v, vis] in the picture 0..1, world: 33 x [x, y, z, vis] in metres around the
// hip centre, x right / y down / z away from the camera }) and phone C's camera (a three.js matrixWorld, column-major, and the
// vertical field of view).
// Where the person stands: the ray through the hip centre meets the horizontal plane at the hip's height above the floor
// (read off the same person: hip to the lowest foot point).
// How the person is turned: the pose model reports the body as seen upright in the picture, so the camera's pitch and roll are
// not applied; only its heading is (x -> the camera's horizontal right, z -> its horizontal forward, -y -> up).

export const J = { nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26,
  lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };
const FEET = [J.lAnk, J.rAnk, J.lHeel, J.rHeel, J.lToe, J.rToe];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * personTo3D(person, cam, aspect) -> { joints: [x, y, z] x 33 (world, metres, y up), vis: [0..1] x 33, hipH } or null.
 * cam = { e: matrixWorld.elements (16), fovY: degrees }; aspect = the picture's width / height.
 */
export function personTo3D(person, cam, aspect) {
  const w = person?.world, pts = person?.pts;
  if (!w || !pts || !cam?.e) return null;
  const e = cam.e, pos = [e[12], e[13], e[14]];
  const right = [e[0], e[1], e[2]], up = [e[4], e[5], e[6]], fwd = [-e[8], -e[9], -e[10]]; // the camera looks down its own -z
  // heading only: the camera's right / forward flattened onto the floor
  const hr = norm([right[0], 0, right[2]]), hf = norm([fwd[0], 0, fwd[2]]);
  if (Math.hypot(fwd[0], fwd[2]) < .05) return null; // looking straight down: no heading
  const off = i => [hr[0] * w[4 * i] + hf[0] * w[4 * i + 2], -w[4 * i + 1], hr[2] * w[4 * i] + hf[2] * w[4 * i + 2]];
  const hipY = (w[4 * J.lHip + 1] + w[4 * J.rHip + 1]) / 2;
  let down = -Infinity;
  for (const i of FEET) if (w[4 * i + 3] > .5) down = Math.max(down, w[4 * i + 1]);
  const hipH = down > -Infinity ? Math.max(.55, Math.min(1.15, down - hipY)) : .9; // feet cut off: a typical standing hip
  // ray through the hip centre
  const u = (pts[J.lHip][0] + pts[J.rHip][0]) / 2, v = (pts[J.lHip][1] + pts[J.rHip][1]) / 2;
  const th = Math.tan(cam.fovY * Math.PI / 360), cx = (2 * u - 1) * th * aspect, cy = (1 - 2 * v) * th;
  const d = [0, 1, 2].map(k => right[k] * cx + up[k] * cy + fwd[k]);
  if (d[1] > -.02) return null; // the ray never reaches the hip's height
  const t = (hipH - pos[1]) / d[1];
  if (!(t > 0.3 && t < 40)) return null;
  const P = [pos[0] + d[0] * t, hipH, pos[2] + d[2] * t];
  const joints = [], vis = [];
  for (let i = 0; i < 33; i++) { const o = off(i); joints.push([P[0] + o[0], P[1] + o[1], P[2] + o[2]]); vis.push(Math.min(w[4 * i + 3], pts[i][2])); }
  return { joints, vis, hipH };
}
