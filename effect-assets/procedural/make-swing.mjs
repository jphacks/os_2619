// The sword swing ("ヒュッ"), the phones' sound for a fast turn of the stick (swing-sense.js, app.js): one file, played louder for a bigger swing.
// Made here, no recordings: a whistle of air whose pitch rushes up and falls away as the blade passes (band-passed noise, its centre swept,
// a thin resonant tone on top) over a soft low "whoom". Sharp onset, a quick tail, so it lands on the motion.
//   node effect-assets/procedural/make-swing.mjs
// writes product/android/app/src/main/res/raw/swing.wav, product/ios/SensorLink/swing.wav and (through ffmpeg) product/dashboard/public/audio/swing.mp3
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WAVS = ['product/android/app/src/main/res/raw/swing.wav', 'product/ios/SensorLink/swing.wav'].map(p => join(ROOT, p));
const MP3 = join(ROOT, 'product/dashboard/public/audio/swing.mp3');
const SR = 44100, DUR = .42, PEAK = .085; // s: the blade passes the ear at PEAK
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1; // the same file every time

// a resonant band-pass (RBJ biquad), its centre moved every sample
function bandpass() {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x, f, q) => {
    const w = 2 * Math.PI * f / SR, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a;
    const y = (a * x - a * x2 - (-2 * c) * y1 - (1 - a) * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; return y;
  };
}
const n = Math.round(DUR * SR), out = new Float32Array(n), air = bandpass(), air2 = bandpass(), low = bandpass();
let ph = 0;
for (let i = 0; i < n; i++) {
  const t = i / SR;
  const env = t < PEAK ? Math.pow(t / PEAK, 2.2) : Math.exp(-(t - PEAK) / .05);               // rush in, fall away
  const f = t < PEAK ? 700 + 2300 * Math.pow(t / PEAK, 1.5) : 3000 - 1900 * (1 - Math.exp(-(t - PEAK) / .06)); // the pitch of the air: up as it nears, down as it goes
  const noise = rnd();
  const hiss = air(noise, f, 3.5) * 1.1 + air2(noise, f * 1.9, 6) * .35;
  ph += 2 * Math.PI * f * .98 / SR;
  const whistle = Math.sin(ph) * .16 * Math.pow(env, 1.5);                                     // the edge's thin singing tone, at the peak
  const whoom = low(noise, 180 + 140 * env, 1.2) * 1.4 * Math.exp(-Math.abs(t - PEAK) / .07);  // the weight behind it
  out[i] = (hiss + whoom) * env + whistle;
}
let m = 0; for (const v of out) m = Math.max(m, Math.abs(v));
const k = Math.pow(10, -1.5 / 20) / m, data = Buffer.alloc(n * 2); // to -1.5 dBFS
for (let i = 0; i < n; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * k * 32767))), i * 2);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
for (const o of WAVS) writeFileSync(o, Buffer.concat([h, data]));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', WAVS[0], '-codec:a', 'libmp3lame', '-b:a', '128k', MP3]);
console.log('wrote', [...WAVS, MP3].join(', '));
