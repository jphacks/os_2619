// The attacker's own phone sounds when they fire (app.js phoneSound): different from anything the player who is hit hears.
//   node effect-assets/procedural/make-phone-launch.mjs
//   my_shot.wav    小 (normal attack): a short, bright rising "pew" with a little click, ~0.22 s
//   my_launch.wav  中 / 大 (charged): a low "whump" with a rising whoosh and a shimmer on top, ~0.7 s (大 plays it lower)
// Written to the Android app (res/raw), the iOS app (bundle) and the dashboard (public/audio, to audition it).
// All synthesised here, seeded, so re-runs give the same files. Placeholder sounds: change freely.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIRS = ['product/android/app/src/main/res/raw', 'product/ios/SensorLink', 'product/dashboard/public/audio'];
const SR = 44100, TAU = Math.PI * 2;
let seed = 777;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
function svf() {
  let lp = 0, bp = 0;
  return (x, fc, q) => { const f = 2 * Math.sin(Math.PI * Math.min(fc, SR / 6) / SR); const hp = x - lp - bp / q; bp += f * hp; lp += f * bp; return { lp, bp, hp }; };
}

function myShot() {
  const out = new Float32Array(Math.round(.22 * SR)), nf = svf();
  let ph = 0, ph2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = 700 + 1500 * (1 - Math.exp(-t / .03)); // rises fast to ~2.2 kHz
    ph += TAU * f / SR; ph2 += TAU * f * 1.5 / SR;
    const env = Math.min(1, t / .003) * Math.exp(-t / .06);
    const tone = (Math.tanh(2.2 * Math.sin(ph)) * .6 + Math.sin(ph2) * .25) * env;
    const click = t < .006 ? nf(rnd(), 4000, .9).bp * (1 - t / .006) * 1.5 : 0;
    out[i] = tone + click;
  }
  return out;
}

function myLaunch() {
  const out = new Float32Array(Math.round(.7 * SR)), wf = svf(), sf = svf();
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    // whump: 140 -> 45 Hz
    const f = 45 + 95 * Math.exp(-t / .05);
    ph += TAU * f / SR;
    const whump = Math.sin(ph) * Math.min(1, t / .004) * Math.exp(-t / .12) * .9;
    // whoosh: band-passed noise sweeping 400 -> 3 kHz, swelling then fading
    const fc = 400 + 2600 * Math.min(1, t / .35);
    const wenv = Math.sin(Math.PI * Math.min(1, t / .6)) ** 1.5;
    const whoosh = wf(rnd(), fc, 2.2).bp * wenv * 1.1;
    // shimmer: high noise, gated quickly, on the rise
    const shimmer = sf(rnd(), 6000, 3).bp * (.5 + .5 * Math.sin(TAU * 28 * t)) * Math.max(0, Math.sin(Math.PI * Math.min(1, t / .5))) * .35;
    out[i] = whump + whoosh + shimmer;
  }
  return out;
}

function wav(out) {
  let peak = 0;
  for (let i = 0; i < out.length; i++) { out[i] = Math.tanh(out[i] * 1.2); peak = Math.max(peak, Math.abs(out[i])); }
  const g = Math.pow(10, -1 / 20) / peak, fade = Math.round(.01 * SR);
  const data = Buffer.alloc(out.length * 2);
  for (let i = 0; i < out.length; i++) data.writeInt16LE(Math.round(out[i] * g * Math.min(1, (out.length - 1 - i) / fade) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

for (const [name, make] of [['my_shot', myShot], ['my_launch', myLaunch]]) {
  const b = wav(make());
  for (const d of DIRS) writeFileSync(join(ROOT, d, name + '.wav'), b);
  console.log('wrote', name + '.wav');
}
