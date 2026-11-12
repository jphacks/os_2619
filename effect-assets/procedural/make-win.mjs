// The victory fanfare, played when the results come in (ko-show.js 'result'): on the dashboard and on the winner's phone (app.js).
// Made here, no recordings: a brass section (stacked harmonics that brighten as each note swells, a little vibrato on the long one),
// "ta-ta-ta TAAA" rising to a held major chord, a timpani hit and cymbal wash under the last chord, a short room reverb.
//   node effect-assets/procedural/make-win.mjs
// writes product/android/app/src/main/res/raw/win.wav, product/ios/SensorLink/win.wav and (through ffmpeg) product/dashboard/public/audio/win.mp3
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WAVS = ['product/android/app/src/main/res/raw/win.wav', 'product/ios/SensorLink/win.wav'].map(p => join(ROOT, p));
const MP3 = join(ROOT, 'product/dashboard/public/audio/win.mp3');
const SR = 44100, DUR = 3.2;
let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const hz = m => 440 * Math.pow(2, (m - 69) / 12); // midi note -> Hz

// [start s, length s, midi notes, loudness]: three quick C's, a lift to E, then the held C major chord (C3 under it)
const B = .13;
const SCORE = [[0, B * .8, [72, 67], .75], [B, B * .8, [72, 67], .75], [2 * B, B * .8, [72, 67], .8], [3 * B, .28, [76, 72, 67], .9],
  [3 * B + .3, .12, [74, 71, 67], .8], [3 * B + .44, 2.1, [79, 76, 72, 67, 60, 48], 1]];
const FINAL = 3 * B + .44;

const n = Math.round(DUR * SR), out = new Float32Array(n);
function brass(t0, len, f, amp) {
  const a = .025, r = len > 1 ? .5 : .06, i0 = Math.round(t0 * SR), i1 = Math.min(n, Math.round((t0 + len + r) * SR));
  let ph = (rnd() + 1) * 3.14;
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    const env = t < a ? t / a : t < len ? 1 - .15 * Math.min(1, (t - a) / .3) : (.85) * Math.exp(-(t - len) / (r / 3));
    const bright = .35 + .65 * Math.min(1, t / .08) * (len > 1 ? .8 + .2 * Math.sin(t * 2.2) : 1); // the "blat" as the lips open
    const vib = len > 1 ? 1 + .004 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, t / .6) : 1;
    ph += 2 * Math.PI * f * vib / SR;
    let s = 0;
    for (let h = 1; h <= 12; h++) { if (f * h > 9000) break; s += Math.sin(ph * h) / h * Math.pow(bright, (h - 1) * .45); }
    out[i] += s * env * amp * .22;
  }
}
for (const [t0, len, notes, amp] of SCORE) for (const m of notes) brass(t0, len, hz(m) * (1 + rnd() * .0015), amp * (m < 55 ? 1.3 : 1));
// timpani + cymbal under the last chord
for (let i = Math.round(FINAL * SR); i < n; i++) {
  const t = i / SR - FINAL;
  out[i] += Math.sin(2 * Math.PI * (65 + 20 * Math.exp(-t * 30)) * t) * Math.exp(-t * 3.5) * .55;
  out[i] += rnd() * Math.exp(-t * 2.2) * .06 * Math.min(1, t / .005);
}
// a short room: four combs in parallel
const wet = new Float32Array(n);
for (const [d, g] of [[.0297, .78], [.0371, .76], [.0411, .74], [.0437, .72]]) {
  const D = Math.round(d * SR), buf = new Float32Array(n);
  for (let i = 0; i < n; i++) { buf[i] = out[i] + (i >= D ? buf[i - D] * g : 0); wet[i] += buf[i] * .12; }
}
for (let i = 0; i < n; i++) out[i] = out[i] * .85 + wet[i];
const fadeAt = Math.round((DUR - .4) * SR); for (let i = fadeAt; i < n; i++) out[i] *= 1 - (i - fadeAt) / (n - fadeAt);

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
