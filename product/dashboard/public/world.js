// Shared contract: arena layout, tag table and frame conventions. Plain JS (no deps) so node and the browser both use it.
//
// World: metres, y up, origin on the floor at the arena centre. A starts at -x facing +x, B at +x facing -x.
// Pose = { R: 3x3 row-major [9], t: [3] }, maps points from the child frame into the parent frame: p_parent = R p_child + t.
//
// Frames
// - tag:   x right, y up (as you look at the printed tag), z out of the face toward the viewer. Matches the
//          solvePnP object points in sensing Vision.kt: corners (-h,h), (h,h), (h,-h), (-h,-h).
// - cv:    the phone's upright portrait image, OpenCV convention: x right, y down, z forward. `tags[].p` / `r` give
//          cv_T_tag (Rodrigues r). p is computed with the phone's single tag-size setting: rescale per id (see tagScale).
// - arcam: ARCore camera pose frame (sensor native landscape, back camera at 90°): x, y, -z forward.
//          The portrait image is the sensor image rotated 90° clockwise, so x_cv = y_ar, y_cv = x_ar, z_cv = -z_ar.
//          `ar.p` / `ar.q` ([x,y,z,w]) give calib_T_arcam: the current camera pose in the camera frame at calibration.
// - imu:   `imu.q` ([w,x,y,z]) is the IMU orientation relative to calibration, in the IMU body frame at calibration.
//          Calibration pose: stick held forward and level. Which IMU axes point along the stick / up is in STICK.

export const ARENA = { half: 2 };   // 4 m x 4 m
export const CHEST_H = 1.3;          // chest phone / chest tag height, m
export const START = { A: { pos: [-1.2, 0, 0], yaw: 0 }, B: { pos: [1.2, 0, 0], yaw: Math.PI } }; // yaw 0 = facing +x
export const PHONE_TAG_SIZE = 0.1;   // the size typed into the phones (m); every tags[].p is scaled by this
export const STICK = { len: 0.8, axis: [1, 0, 0], up: [0, 0, 1], hand: { fwd: 0.3, right: 0.2, up: -0.3 } };

// Tag layouts. Pick one with ?layout= (browser) or LAYOUT= (node); default 'map4'.
// - map4:  four sheets (ids 0-3, any size listed here) lying anywhere on the floor, roughly the corners of the play area.
//          Their real positions and turns are measured by the scan (fieldmap.js -> setField); the values here are only a
//          placeholder 3 m square until then. Nothing in the room is measured by hand.
// - full:  fixed tags on poles at chest height facing the arena centre: corners 0-3, plus 4 / 5 in the middle of the
//          sides behind B / A so each player sees one straight ahead from the start mark. Chest tags 10 (A), 11 (B).
// - today: what was printed on 10/17 (AprilTag Print Studio, 200 mm black square): only ids 0 and 1, behind B / A.
// - floor: the same two sheets lying face up on the floor (standing them up was impractical), in front of the start
//          marks on the camera side so the third-person camera sees them less obliquely. Only needed while scanning.
// floor: lying face up, tag z = world up. The sheet's top edge points away from the camera (-z), so seen from the
//        camera the page reads upright (the caption under the tag is the edge nearest the camera).
// flip: printed in the official apriltag-imgs orientation, which OpenCV reads rotated 180° about the tag normal
//       (our print/make_tags.py PDFs are in OpenCV's orientation and need no flip). Mount sheets upright as printed.
const H = ARENA.half;
const LAYOUTS = {
  full: {
    0: { size: 0.25, pos: [-H, CHEST_H, -H] },
    1: { size: 0.25, pos: [H, CHEST_H, -H] },
    2: { size: 0.25, pos: [H, CHEST_H, H] },
    3: { size: 0.25, pos: [-H, CHEST_H, H] },
    4: { size: 0.25, pos: [H, CHEST_H, 0] },
    5: { size: 0.25, pos: [-H, CHEST_H, 0] },
    10: { size: 0.18, player: 'A' },
    11: { size: 0.18, player: 'B' },
  },
  today: {
    0: { size: 0.2, pos: [H, CHEST_H, 0], flip: true },
    1: { size: 0.2, pos: [-H, CHEST_H, 0], flip: true },
    10: { size: 0.18, player: 'A' }, // not printed yet: kept so the dummy room and the simulator still use them
    11: { size: 0.18, player: 'B' },
  },
  map4: {
    0: { size: 0.2, pos: [1.5, 0, 1.5], floor: true, yaw: 0 },
    1: { size: 0.2, pos: [-1.5, 0, 1.5], floor: true, yaw: 0 },
    2: { size: 0.25, pos: [-1.5, 0, -1.5], floor: true, yaw: 0 },
    3: { size: 0.25, pos: [1.5, 0, -1.5], floor: true, yaw: 0 },
    10: { size: 0.18, player: 'A' },
    11: { size: 0.18, player: 'B' },
  },
  floor: {
    0: { size: 0.2, pos: [1.5, 0, 1], floor: true, flip: true },
    1: { size: 0.2, pos: [-1.5, 0, 1], floor: true, flip: true },
    10: { size: 0.18, player: 'A' },
    11: { size: 0.18, player: 'B' },
  },
};
const pick = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('layout'))
  || (typeof process !== 'undefined' && process.env?.LAYOUT) || 'map4';
export const LAYOUT = LAYOUTS[pick] ? pick : 'map4';
export const TAGS = LAYOUTS[LAYOUT];
export const CORNER_IDS = Object.keys(TAGS).map(Number).filter(id => TAGS[id].pos); // every fixed tag (name kept for the modules that use it)
export const PLAYER_TAG = { A: 10, B: 11 }; // the ids drawn / simulated on A and B
// Tags 8-11 are worn on the phones (chest mounts) and move with their wearer; every other id is fixed in the room.
// A phone never sees its own, so a chest tag in view is always the opponent's.
export const CHEST_IDS = [8, 9, 10, 11];
export const isChestTag = id => id >= 8 && id <= 11;
for (const id of CHEST_IDS) if (!TAGS[id]) TAGS[id] = { size: 0.18, chest: true }; // size for tagScale; never a pos, never a field tag
// floor layout: the scan measures how far apart the two sheets really are (app.js) and keeps it, so the
// sheets only need to lie level and face the same way, not sit exactly 3 m apart
export const FLOOR_IDS = CORNER_IDS.filter(id => TAGS[id].floor);
export function setFloorSep(sep) { for (const id of FLOOR_IDS) TAGS[id].pos[0] = Math.sign(TAGS[id].pos[0]) * sep / 2; }
if (typeof location !== 'undefined' && LAYOUT === 'floor') { // the two-sheet layout only; map4 is measured whole by fieldmap.js
  try { const v = +localStorage.getItem('fx-tagsep'); if (v > .2 && v < 8) setFloorSep(v); } catch {}
}

// ---- the play area (FIELD) ----
// poly: the field outline on the floor, [x, z] corners in order around it. Starts as the ARENA square; a scan of the
// map4 sheets replaces it (setField). START, ARENA.half (largest extent, for the old square-minded code) follow it.
// Listeners (onFieldChange) rebuild whatever they drew from the old outline.
export const FIELD = { // until a scan: map4's placeholder sheets, else the ARENA square
  poly: LAYOUT === 'map4' ? FLOOR_IDS.map(id => [TAGS[id].pos[0], TAGS[id].pos[2]]).sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) : [[-H, -H], [H, -H], [H, H], [-H, H]],
};
const fieldListeners = new Set();
export const onFieldChange = cb => { fieldListeners.add(cb); return () => fieldListeners.delete(cb); };
/**
 * setField({ poly, tags }) — poly: [[x, z] x N] the outline; tags: { id: { pos: [x, 0, z], yaw } } measured floor sheets,
 * or { id: { pos: [x, y, z], yaw, spin, stand: true, R } } measured standing sheets (see worldTagPose).
 * World frame convention for a scanned field: origin at the outline's centroid, y up, +x from A's side (left in the
 * third-person picture) to B's side (right), so A starts at -x facing +x as before.
 */
export function setField({ poly, tags = {} }) {
  for (const [id, t] of Object.entries(tags)) if (TAGS[id] && !isChestTag(+id)) // a measured sheet: lying (floor) or upright (stand: true, spin)
    Object.assign(TAGS[id], { pos: [...t.pos], yaw: t.yaw ?? 0, floor: !t.stand, stand: !!t.stand, spin: t.spin ?? 0, R: t.R ? [...t.R] : undefined, flip: false });
  FIELD.poly = poly.map(p => [...p]);
  const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  ARENA.half = Math.max(maxX, -minX, ...zs.map(Math.abs));
  const inset = Math.min(.9, (maxX - minX) * .22); // start marks a little in from the A / B ends
  START.A.pos = [minX + inset, 0, 0]; START.B.pos = [maxX - inset, 0, 0];
  for (const cb of fieldListeners) cb(FIELD);
}
/** Is the floor point (x, z) inside the field outline? */
export function inField(x, z) {
  let inside = false; const P = FIELD.poly;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, zi] = P[i], [xj, zj] = P[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
export const tagScale = id => (TAGS[id]?.size ?? PHONE_TAG_SIZE) / PHONE_TAG_SIZE;

// ---- small pose maths ----
export const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const mul3 = (a, b) => { const r = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]); return r; };
export const tr3 = a => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
export const app3 = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
export const pose = (R = I3, t = [0, 0, 0]) => ({ R, t });
export const compose = (a, b) => ({ R: mul3(a.R, b.R), t: app3(a.R, b.t).map((v, i) => v + a.t[i]) });
export const invert = p => { const Rt = tr3(p.R); return { R: Rt, t: app3(Rt, p.t).map(v => -v) }; };
export const apply = (p, v) => app3(p.R, v).map((x, i) => x + p.t[i]);
/** Rotation matrix from columns: the child's x, y, z axes expressed in the parent. */
export const fromCols = (x, y, z) => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
export const fromQuat = ([w, x, y, z]) => [
  1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
  2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
  2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
export const toQuat = R => { // [w, x, y, z]
  const tr = R[0] + R[4] + R[8];
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; return [s / 4, (R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s]; }
  if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; return [(R[7] - R[5]) / s, s / 4, (R[1] + R[3]) / s, (R[2] + R[6]) / s]; }
  if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; return [(R[2] - R[6]) / s, (R[1] + R[3]) / s, s / 4, (R[5] + R[7]) / s]; }
  const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; return [(R[3] - R[1]) / s, (R[2] + R[6]) / s, (R[5] + R[7]) / s, s / 4];
};
export const fromRodrigues = r => {
  const th = Math.hypot(...r); if (th < 1e-9) return I3;
  const [x, y, z] = r.map(v => v / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
};
export const toRodrigues = R => { // via the quaternion: stable near 180° (a tag facing the camera sits there)
  const [w, x, y, z] = toQuat(R), n = Math.hypot(x, y, z);
  if (n < 1e-12) return [0, 0, 0];
  const k = 2 * Math.atan2(n, w) / n;
  return [x * k, y * k, z * k];
};

// Fixed frame changes
export const CV_FROM_AR = [0, 1, 0, 1, 0, 0, 0, 0, -1];   // v_cv = CV_FROM_AR v_ar  (its own inverse)
export const cv_T_arcam = pose(CV_FROM_AR);
export const arcam_T_cv = pose(CV_FROM_AR);

/** World pose of a corner tag (faces the arena centre), or of a chest tag given the wearer's bodyPose. */
export function worldTagPose(id, body) {
  const tag = TAGS[id];
  if (!tag.pos) return chestTagPose(body);
  if (tag.stand) { // taped upright (fieldmap stand scan): normal horizontal, facing `yaw` (0: facing +z, toward the
    // third-person camera's side); base axes x = [cos, 0, -sin], y = up, z = [sin, 0, cos], then the tag frame turned
    // spin·90° about its normal so the OpenCV tag axes match the print as mounted (Print Studio sheets upright: spin 2).
    // A scanned sheet carries its measured rotation R (lean included): that wins over yaw / spin.
    if (tag.R) return pose(tag.R, tag.pos);
    const c = Math.cos(tag.yaw ?? 0), s = Math.sin(tag.yaw ?? 0), [ck, sk] = [[1, 0], [0, 1], [-1, 0], [0, -1]][((tag.spin ?? 0) % 4 + 4) % 4];
    const xb = [c, 0, -s];
    return pose(fromCols([ck * xb[0], sk, ck * xb[2]], [-sk * xb[0], ck, -sk * xb[2]], [s, 0, c]), tag.pos);
  }
  if (tag.floor) { // lying face up, turned `yaw` about world up (yaw 0: the sheet's top edge points to -z, away from the camera)
    const a = (tag.yaw ?? 0) + (tag.flip ? Math.PI : 0), c = Math.cos(a), s = Math.sin(a);
    return pose(fromCols([c, 0, -s], [-s, 0, -c], [0, 1, 0]), tag.pos);
  }
  const n = Math.hypot(tag.pos[0], tag.pos[2]), z = [-tag.pos[0] / n, 0, -tag.pos[2] / n], y = [0, 1, 0];
  const x = [z[2], 0, -z[0]]; // x = y × z
  return tag.flip ? pose(fromCols(x.map(v => -v), [0, -1, 0], z), tag.pos) : pose(fromCols(x, y, z), tag.pos);
}

/** Body frame of a standing player: x forward, y up, z right. A chest tag faces forward: tag z = body forward. */
export function bodyPose(pos, yaw, h = CHEST_H) {
  const f = [Math.cos(yaw), 0, -Math.sin(yaw)], u = [0, 1, 0], r = [-f[2], 0, f[0]]; // r = f x u
  return pose(fromCols(f, u, r), [pos[0], h, pos[2]]);
}
/** Chest tag in world: tag x = player's right... seen from the front the tag's x is the viewer's right = player's left. */
export function chestTagPose(body) {
  const [f, u, r] = [0, 1, 2].map(c => [body.R[c], body.R[3 + c], body.R[6 + c]]);
  return pose(fromCols(r.map(v => -v), u, f), body.t);
}
/** Chest phone camera (arcam) in world for a body pose: portrait, looking forward, image up = world up. */
export function phoneArcamPose(body) {
  const [f, u, r] = [0, 1, 2].map(c => [body.R[c], body.R[3 + c], body.R[6 + c]]);
  // cv axes in world: x = right, y = -up, z = forward; arcam = cv * CV_FROM_AR
  const world_T_cv = pose(fromCols(r, u.map(v => -v), f), body.t);
  return compose(world_T_cv, cv_T_arcam);
}
