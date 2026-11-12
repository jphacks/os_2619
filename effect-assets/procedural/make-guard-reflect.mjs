// The guard's reflect ping (audio.js GUARD.guardReflect, made there at load) as a file for the phones, which play it when
// their player bounces a 小 back (app.js phoneSound):
//   node effect-assets/procedural/make-guard-reflect.mjs
// writes product/android/app/src/main/res/raw/guard_reflect.wav and product/ios/SensorLink/guard_reflect.wav
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTS = ['product/android/app/src/main/res/raw/guard_reflect.wav', 'product/ios/SensorLink/guard_reflect.wav'].map(p => join(ROOT, p));
const SR = 44100, DUR = .6;
const rnd = a => (Math.random() * 2 - 1) * a;
const sin = (f, t) => Math.sin(2 * Math.PI * f * t), ping = (f0, t, k) => [1, 2.76, 5.4].reduce((a, m, i) => a + sin(f0 * m, t) * Math.exp(-t * k * (1 + i)) / (1 + i), 0);
const n = Math.round(DUR * SR), data = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  const t = i / SR, v = .35 * ping(1500, t, 7) + (t < .006 ? rnd(.4) : 0);
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
for (const o of OUTS) writeFileSync(o, Buffer.concat([h, data]));
console.log('wrote', OUTS.join(', '));
