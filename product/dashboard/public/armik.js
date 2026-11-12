// A natural arm from where its shoulder and fist are: a two-bone IK (law of cosines, as Unity's Two Bone IK Constraint) whose elbow side, clavicle and
// shoulder follow VRArmIK's rules (Mathias Parger, MIT licence, github.com/dabeschte/VRArmIK: VRArmIK.cs getElbowTargetAngle / correctElbowAfterPositioning,
// ShoulderPoser.cs rotateShoulderUp (the distinct shoulder rotation) / clampShoulderHandDistance). Only looks: the figures' arms (wizardmodel.js, chaobenmodel.js).
//
// Frame: the body's axes, fwd / up / out (out: away from the body on this arm's side: the right for the right arm). VRArmIK's local hand position is
// (x = out, y = up, z = fwd) / arm length; its elbow angle turns the elbow about the shoulder-fist line from straight up (0) through out (90) to down (180).
import * as THREE from 'three';

const V = () => new THREE.Vector3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), clamp01 = v => clamp(v, 0, 1), D = Math.PI / 180;

/** VRArmIK's numbers (its inspector defaults), degrees and arm lengths. */
export const ARM_IK = {
  elbow: { offset: 135, yWeight: -60, zWeightTop: 260, zWeightBottom: -100, zDistanceStart: .6, xWeight: -50, xDistanceStart: .1, minAngle: 13, softClampRange: 10 },
  nearShoulder: { startBelowDistance: .5, startBelowY: .1, weight: 2, localElbow: [.3, -1, -2] }, // out, up, fwd
  clavicle: { multiplier: 30, forwardLimit: 33, upwardLimit: 33 },
  dislocate: { startBefore: .005, max: .08 }, // the shoulder follows a fist out of reach, up to max × arm length; past that the arm stretches
  smooth: .06,                                // s: the elbow angle eases in, so a sensor's jitter does not flip the elbow
};

const _off = V(), _n = V(), _up = V(), _out = V(), _e = V(), _ax = V(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _ref = V();

/**
 * solveArm({ root, shoulder, fwd, up, out, upper, fore, target, state, dt }) -> { shoulder, elbow, clavicle, stretch, side }
 * root: the clavicle's root; shoulder: the upper arm's start at rest; fwd / up / out: the body's unit axes (out for this side); upper / fore: the bones'
 * lengths (fore: elbow to the fist's centre); target: the fist's centre; state: {} kept per arm (the eased elbow angle).
 * Returns new vectors: the shoulder (the clavicle turned, maybe pulled toward the fist), the elbow, the clavicle's turn (a quaternion, applied about
 * root on top of the trunk's), and stretch: how far past the arm's reach the fist still is (0 when it reaches).
 */
export function solveArm({ root, shoulder: rest, fwd, up, out, upper, fore, target, state = {}, dt = 1 / 60 }) {
  const P = ARM_IK, len = upper + fore;
  // the clavicle: reaching forward turns it forward, reaching up lifts it (ShoulderPoser.rotateShoulderUp)
  _off.subVectors(target, rest);
  const fr = _off.dot(fwd) / len, ur = _off.dot(up) / len;
  const yaw = fr > 0 ? clamp((fr - .5) * P.clavicle.multiplier, 0, P.clavicle.forwardLimit) : 0;
  const lift = clamp((ur - .5) * P.clavicle.multiplier, 0, P.clavicle.upwardLimit);
  const clavicle = new THREE.Quaternion().setFromAxisAngle(_ax.crossVectors(out, fwd).normalize(), yaw * D) // out toward forward
    .multiply(_q.setFromAxisAngle(_ax.crossVectors(out, up).normalize(), lift * D));                      // out toward up
  const shoulder = V().subVectors(rest, root).applyQuaternion(clavicle).add(root);
  // a fist just out of reach pulls the shoulder after it (clampShoulderHandDistance)
  _off.subVectors(target, shoulder);
  let d = _off.length();
  const reach = len * (1 - P.dislocate.startBefore);
  if (d > reach) { const m = Math.min(d - reach, P.dislocate.max * len); shoulder.addScaledVector(_off, m / d); _off.subVectors(target, shoulder); d = _off.length(); }
  const stretch = Math.max(0, d - len);

  // the elbow's side about the shoulder-fist line (getElbowTargetAngle): the fist's place in the shoulder's frame, over the arm's length
  const x = _off.dot(out) / len, y = _off.dot(up) / len, z = _off.dot(fwd) / len, E = P.elbow;
  let a = E.yWeight * y + E.offset;
  a += y > 0 ? E.zWeightTop * Math.max(E.zDistanceStart - z, 0) * y : E.zWeightBottom * Math.max(E.zDistanceStart - z, 0) * -y;
  a += E.xWeight * Math.max(E.xDistanceStart - x, 0);
  if (a < E.minAngle + E.softClampRange) { const s = E.minAngle + E.softClampRange - a; a = Math.max(0, E.minAngle + E.softClampRange * (1 - Math.log(1 + s) * 3)); }
  if (state.angle == null || !(dt > 0)) state.angle = a;
  else { const k = 1 - Math.exp(-dt / P.smooth), dd = ((a - state.angle + 540) % 360) - 180; state.angle += dd * k; }

  // the frame about the line: "up" made square to it (if the fist is straight above / below, the body's back / front stands in), "out" across it
  _n.copy(_off).divideScalar(Math.max(d, 1e-6));
  _up.copy(up).addScaledVector(_n, -up.dot(_n));
  if (_up.lengthSq() < .01) _up.copy(fwd).multiplyScalar(_n.dot(up) > 0 ? -1 : 1).addScaledVector(_n, -_n.dot(fwd) * (_n.dot(up) > 0 ? -1 : 1));
  _up.normalize(); _out.crossVectors(_n, _up); if (_out.dot(out) < 0) _out.negate();
  _e.copy(_up).multiplyScalar(Math.cos(state.angle * D)).addScaledVector(_out, Math.sin(state.angle * D));
  // near the shoulder and low, the elbow goes back and down, out a little (correctElbowAfterPositioning): it does not flip about there
  const C = P.nearShoulder, hd = Math.hypot(x, z);
  const w = clamp01(clamp01(clamp01((C.startBelowDistance - hd) / C.startBelowDistance) * C.weight + clamp01((-z + .1) * 3)) * clamp01((C.startBelowY - y) / C.startBelowY));
  if (w > 0) {
    _ref.copy(out).multiplyScalar(C.localElbow[0]).addScaledVector(up, C.localElbow[1]).addScaledVector(fwd, C.localElbow[2]);
    _ref.addScaledVector(_n, -_ref.dot(_n));
    if (_ref.lengthSq() > 1e-6) _e.lerp(_ref.normalize(), w).normalize();
  }
  // the elbow's side eased as a direction, not only as an angle: the frame it is measured in turns over when the arm's line passes near
  // upright, and a sensor's jitter there must not flip the elbow from frame to frame. Kept square to the line.
  if (!state.e || !(dt > 0)) state.e = _e.clone();
  else {
    state.e.addScaledVector(_n, -state.e.dot(_n)); if (state.e.lengthSq() < 1e-6) state.e.copy(_e); state.e.normalize();
    state.e.lerp(_e, 1 - Math.exp(-dt / P.smooth)); state.e.addScaledVector(_n, -state.e.dot(_n));
    if (state.e.lengthSq() < 1e-6) state.e.copy(_e); state.e.normalize();
  }
  _e.copy(state.e);
  // two bones (law of cosines): the elbow on its circle about the line, on that side
  const dd = clamp(d, Math.abs(upper - fore) + 1e-4, len);
  const along = (dd * dd + upper * upper - fore * fore) / (2 * dd), h = Math.sqrt(Math.max(0, upper * upper - along * along));
  const elbow = V().copy(shoulder).addScaledVector(_n, along).addScaledVector(_e, h);
  return { shoulder, elbow, clavicle, stretch, side: _e.clone() }; // side: where the elbow sticks out (square to the line), defined even when the arm is straight
}
