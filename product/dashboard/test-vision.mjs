// findStick on a synthetic picture: noisy grey room, a body-coloured block (edges, not lines) and the forearm toward the
// elbow, and a 4 px dark wooden stick from the hand. It must find the stick's angle and length, also with a wrong prior.
import assert from 'node:assert/strict';
import { findStick, assignSlots } from './public/vision.js';

const W = 480, H = 360, px = new Uint8ClampedArray(W * H * 4);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < W * H; i++) { const g = 120 + (rnd() - .5) * 30; px.set([g, g, g + 8, 255], 4 * i); }
const fill = (inside, rgb) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) px.set(rgb, 4 * (y * W + x)); };
fill((x, y) => x > 120 && x < 190 && y > 60 && y < 300, [70, 80, 140]); // torso: a wide block
const hand = [205, 170], elbow = [175, 215], segD = (x, y, a, b, w) => { const dx = b[0] - a[0], dy = b[1] - a[1], u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy) < w; };
fill((x, y) => segD(x, y, elbow, hand, 9), [200, 160, 130]); // forearm
const ang = -35 * Math.PI / 180, len = 130, tip = [hand[0] + Math.cos(ang) * len, hand[1] + Math.sin(ang) * len];
fill((x, y) => segD(x, y, hand, tip, 2.2), [95, 60, 30]); // the stick
const ppm = 130; // ~1 m stick = 130 px
for (const prior of [null, ang + .3, ang + 2]) {
  const s = findStick(px, W, H, hand[0], hand[1], elbow[0], elbow[1], ppm, { len: 1, prior, prev: null });
  const da = Math.abs(Math.atan2(Math.sin(s.a - ang), Math.cos(s.a - ang))) * 180 / Math.PI;
  assert.ok(da < 3, `angle off by ${da.toFixed(1)}° (prior ${prior})`);
  assert.ok(Math.abs(s.len - len) < 15, `length ${s.len.toFixed(0)} px, want ${len}`);
  assert.ok(s.conf > .35, `conf ${s.conf}`);
}
// nothing held: low confidence
fill((x, y) => segD(x, y, hand, tip, 2.2), [120, 120, 128]);
assert.ok(findStick(px, W, H, hand[0], hand[1], elbow[0], elbow[1], ppm, { len: 1 }).conf < .35, 'no stick must give a low confidence');

// slots: sensor hints win over the left/right default
const P = (x) => ({ key: [x, .5] }), L = P(.3), R = P(.7);
assert.deepEqual(assignSlots([L, R], {}, {}, 0), { A: L, B: R });
assert.deepEqual(assignSlots([L, R], {}, { A: { chest: [.72, .5] }, B: { chest: [.28, .5] } }, 0), { A: R, B: L });
console.log('vision ok: stick angle / length / no-stick, A-B assignment');
// the worker's source (findStick and helpers pasted in by toString) must parse
const { workerSrc } = await import('./public/vision.js');
new Function(workerSrc('https://x', 'https://m'));
console.log('vision worker source parses');
