// One pose source for the dummy camera and the game. No DOM / Three.js dependency.
import * as W from './world.js';

export function synthDummyPose(slot, time, room) {
  const s = slot === 'A' ? -1 : 1, ph = slot === 'A' ? 0 : 1.7;
  const o = room.start[slot === 'A' ? 'B' : 'A'], st = room.start[slot], zA = room.zAmp;
  const chest = [st[0] - s * .25 * Math.sin(.6 * time + ph), W.CHEST_H + .03 * Math.sin(2.6 * time + ph), st[2] + zA * Math.sin(.45 * time + ph)];
  const other = [o[0], 0, o[2] + zA * Math.sin(.45 * time + (slot === 'A' ? 1.7 : 0))];
  const yaw = Math.atan2(-(other[2] - chest[2]), other[0] - chest[0]);
  const bp = W.bodyPose(chest, yaw, chest[1]), h = W.STICK.hand;
  const base = W.apply(bp, [h.fwd, h.up, h.right]);
  const sw = (time * .8 + ph) % 3, swinging = sw < .5;
  const el = swinging ? 1.2 - 4.4 * sw : .9 * Math.sin(1.5 * time + ph) + .3, az = .3 * Math.sin(time + ph);
  const dir = W.app3(bp.R, [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]);
  return { slot, chest, yaw, base, tip: base.map((v, i) => v + dir[i] * W.STICK.len), dir, swinging };
}

function copyPose(slot, pose, source) {
  const result = { slot, yaw: pose.yaw, swinging: !!pose.swinging, source };
  for (const key of ['chest', 'base', 'tip', 'dir']) result[key] = Object.freeze([...pose[key]]);
  return Object.freeze(result);
}

export function createDummyMotion(room, clock = () => performance.now()) {
  const latest = {}, received = {};
  return {
    setTruth(slot, pose) {
      if (!['A', 'B'].includes(slot)) return;
      latest[slot] = copyPose(slot, pose, 'fake-world'); received[slot] = clock();
    },
    sample(time) {
      const now = clock(), players = {};
      for (const slot of ['A', 'B']) players[slot] = latest[slot] && now - received[slot] < 1000
        ? latest[slot] : copyPose(slot, synthDummyPose(slot, time, room), 'synthetic');
      return Object.freeze({ time, players: Object.freeze(players) });
    },
  };
}
