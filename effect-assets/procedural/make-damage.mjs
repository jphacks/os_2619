// Builds the "you took a hit" sound the phones play together with the torch (a super-effective style double impact).
//   node effect-assets/procedural/make-damage.mjs
// Writes the same file to the dashboard (to audition it) and the Android app (to play it on a hit):
//   product/dashboard/public/audio/damage.wav, product/android/app/src/main/res/raw/damage.wav
// All synthesised here (no outside material): two quick impacts "ba-BAM" (the second harder), each a click + a crunchy
// band-passed noise burst + a square-ish body that drops in pitch, then a short low rumble tail. Seeded, so re-runs match.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUTS = ['product/dashboard/public/audio/damage.wav', 'product/android/app/src/main/res/raw/damage.wav'].map(p => join(ROOT, p));
const SR = 44100, TAU = Math.PI * 2, DUR = .62;

let seed = 2619;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
function svf() { // state-variable filter: lp / bp / hp
  let lp = 0, bp = 0;
  return (x, fc, q) => { const f = 2 * Math.sin(Math.PI * Math.min(fc, SR / 6) / SR); const hp = x - lp - bp / q; bp += f * hp; lp += f * bp; return { lp, bp, hp }; };
}
const out = new Float32Array(Math.round(DUR * SR));

/** One impact at t0 s, strength k (1 = the big one). */
function impact(t0, k, { f0 = 520, f1 = 70, body = .16 } = {}) {
  const o = Math.round(t0 * SR), nf = svf(), cf = svf();
  let ph = 0;
  for (let i = 0; o + i < out.length; i++) {
    const t = i / SR;
    if (t > .5) break;
    // click: a 2 ms high-passed noise spike, the "smack"
    const click = t < .004 ? cf(rnd(), 3500, .8).hp * (1 - t / .004) * 1.2 : 0;
    // crunch: noise, band-pass sweeping down 2.8k -> 600 Hz, fast decay
    const crunch = nf(rnd(), 600 + 2200 * Math.exp(-t / .025), 1.4).bp * Math.exp(-t / .045) * 2.2;
    // body: a pitch drop f0 -> f1 with a square-ish shape (sine through tanh) for the 8/16-bit punch
    const f = f1 + (f0 - f1) * Math.exp(-t / .03);
    ph += TAU * f / SR;
    const bodyEnv = Math.min(1, t / .002) * Math.exp(-t / body);
    const bod = Math.tanh(3 * Math.sin(ph)) * bodyEnv * .75;
    out[o + i] += k * (click + crunch + bod);
  }
}
impact(0, .7, { f0: 420, f1: 90, body: .06 });     // "ba"
impact(.085, 1, { f0: 620, f1: 55, body: .17 });    // "BAM"
// tail: a low rumble after the big one
{
  const o = Math.round(.085 * SR), lf = svf();
  for (let i = 0; o + i < out.length; i++) { const t = i / SR; out[o + i] += lf(rnd(), 180, .9).lp * Math.min(1, t / .01) * Math.exp(-t / .16) * .9; }
}

// master: soft clip, normalise the peak to -1 dBFS, 8 ms fade-out at the end
let peak = 0;
for (let i = 0; i < out.length; i++) { out[i] = Math.tanh(out[i] * 1.4); peak = Math.max(peak, Math.abs(out[i])); }
const g = Math.pow(10, -1 / 20) / peak, fade = Math.round(.008 * SR);
for (let i = 0; i < out.length; i++) out[i] *= g * Math.min(1, (out.length - 1 - i) / fade);

// 16-bit mono PCM WAV
const data = Buffer.alloc(out.length * 2);
for (let i = 0; i < out.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i])) * 32767), i * 2);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
for (const p of OUTS) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.concat([h, data])); console.log('wrote', p); }
