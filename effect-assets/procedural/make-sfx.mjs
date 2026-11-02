// Builds the water / wind sound effects in product/dashboard/public/audio (water1-3.mp3, wind1-3.mp3).
//   node effect-assets/procedural/make-sfx.mjs <cc0-dir>
// <cc0-dir> holds the two CC0 packs from OpenGameArt, unzipped (see public/audio/README.md):
//   water-splash-slime-sfx.zip -> <cc0-dir>/wa/*.ogg      swishes.zip -> <cc0-dir>/sw/swishes/*.wav
// Water = the CC0 splashes layered (plus a synthesized low "mass of water" thump on the big one).
// Wind  = synthesized here (band-passed noise whooshes with a moving centre, Farnell "Designing Sound" style) with a CC0 swish
//         on the transient. Needs ffmpeg. Deterministic (seeded noise), so re-running gives the same files.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node make-sfx.mjs <cc0-dir>'); process.exit(1); }
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../product/dashboard/public/audio');
const TMP = mkdtempSync(join(tmpdir(), 'sfx-'));
const SR = 44100, TAU = Math.PI * 2;

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// state-variable band-pass, per-sample centre / Q
function svf() {
  let lp = 0, bp = 0;
  return (x, fc, q) => { const f = 2 * Math.sin(Math.PI * Math.min(fc, SR / 6) / SR); const hp = x - lp - bp / q; bp += f * hp; lp += f * bp; return { lp, bp, hp }; };
}
// stereo buffer [L, R] of dur s
const buf = dur => [new Float32Array(Math.round(dur * SR)), new Float32Array(Math.round(dur * SR))];
/** A whoosh: noise through a band-pass whose centre glides lo -> peak -> lo around tPeak, loudness following it; pans across. */
function whoosh(out, t0, dur, { lo = 400, hi = 2400, end = 600, q = 1.6, gain = .5, tPeak = .3, pan = [-.6, .6], air = .25 } = {}) {
  const f1 = svf(), f2 = svf(), n = Math.round(dur * SR), o = Math.round(t0 * SR);
  for (let i = 0; i < n && o + i < out[0].length; i++) {
    const t = i / SR, u = t / dur, k = u < tPeak ? sm(0, tPeak, u) : 1 - sm(tPeak, 1, u);
    const fc = u < tPeak ? lo + (hi - lo) * k : end + (hi - end) * k;
    const env = Math.pow(k, 1.6) * gain;
    const x = rnd(), b = f1(x, fc, q).bp, a = f2(x, fc * 2.6, 2.5).bp * air;
    const s = (b + a) * env, p = pan[0] + (pan[1] - pan[0]) * u, gl = Math.cos((p + 1) * Math.PI / 4), gr = Math.sin((p + 1) * Math.PI / 4);
    out[0][o + i] += s * gl; out[1][o + i] += s * gr;
  }
}
/** Howling wind: resonant band-passes on slowly wandering centres, a low rumble, gusts (amplitude LFOs). */
function gale(out, t0, dur, { gain = .5, fade = [3, 6] } = {}) {
  const whis = [svf(), svf(), svf(), svf()], rum = svf(), body = svf(), n = Math.round(dur * SR), o = Math.round(t0 * SR);
  const W = [[620, .23, 1.1], [910, .31, 2.3], [1340, .17, .4], [1980, .41, 3.1]];
  for (let i = 0; i < n && o + i < out[0].length; i++) {
    const t = i / SR, x = rnd();
    const gust = .6 + .25 * Math.sin(TAU * .55 * t + 1) + .15 * Math.sin(TAU * 1.3 * t + 2.2);
    const env = sm(0, .35, t) * (t < fade[0] ? 1 : 1 - sm(fade[0], fade[1], t)) * gain;
    let w = 0;
    W.forEach(([f, r, ph], j) => { const fc = f * (1 + .18 * Math.sin(TAU * r * t + ph) + .07 * Math.sin(TAU * r * 3.1 * t + ph * 2)); w += whis[j](x, fc, 14).bp * (.55 - .08 * j); });
    const lowv = rum(x, 140, .8).lp * .9, mid = body(x, 900 + 300 * Math.sin(TAU * .4 * t), .9).bp * .55;
    const s = (w * .9 + mid) * gust + lowv * (.7 + .3 * gust), sp = .25 * Math.sin(TAU * .3 * t);
    out[0][o + i] += s * env * (1 - sp); out[1][o + i] += s * env * (1 + sp);
  }
}
function thump(out, t0, { f = 60, gain = .5, decay = 6 } = {}) { // a low, soft mass hitting (sine drop + low noise)
  const lp = svf(), n = Math.round(1.2 * SR), o = Math.round(t0 * SR);
  for (let i = 0; i < n && o + i < out[0].length; i++) {
    const t = i / SR, e = Math.exp(-t * decay) * Math.min(1, t / .004);
    const s = (Math.sin(TAU * (f * t + 25 * (1 - Math.exp(-t * 8)) / 8)) * .7 + lp(rnd(), 220, .7).lp * 1.2) * e * gain;
    out[0][o + i] += s; out[1][o + i] += s;
  }
}
function writeWav(path, [L, R]) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const k = pk > .89 ? .89 / pk : 1;
  for (let i = 0; i < n; i++) { b.writeInt16LE(Math.round(L[i] * k * 32767), 44 + i * 4); b.writeInt16LE(Math.round(R[i] * k * 32767), 46 + i * 4); }
  writeFileSync(path, b);
}
const ff = args => { const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]); if (r.status) throw new Error(String(r.stderr)); };
/** layers: [file, delay s, gain dB, extra filter?]; out mp3 of dur s, peak-limited, short fades at both ends */
function mix(name, dur, layers) {
  const ins = layers.flatMap(([f]) => ['-i', f]);
  const ch = layers.map(([, d, g, x], i) => `[${i}]aresample=${SR},aformat=channel_layouts=stereo,${x ? x + ',' : ''}volume=${g}dB,adelay=${Math.round(d * 1000)}|${Math.round(d * 1000)}[a${i}]`);
  const fc = ch.join(';') + ';' + layers.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${layers.length}:normalize=0:duration=longest,atrim=0:${dur},afade=t=out:st=${(dur - .05).toFixed(2)}:d=0.05,alimiter=limit=.89:level=false[o]`;
  ff([...ins, '-filter_complex', fc, '-map', '[o]', '-ar', '44100', '-b:a', '192k', join(OUT, name + '.mp3')]);
}
const wa = f => join(SRC, 'wa', f), sw = f => join(SRC, 'sw/swishes', f), tmp = f => join(TMP, f);

// ---- water ----
// Timed to fx-smash-water.js.
// 1 (every launch, the 小 hit): a short splash. 2 (中 Tidal Surge): the geyser bursting up under the target at once (splash +
// thump). 3 (大 Cataract): the orb splashing into the magic circle, a low swell while the waterfall starts pouring (.3 s) and
// falls, its impact on the floor at ~.9 s (thump + splashes), the roar of falling water until ~2.3 s, then rain and surf that
// audio.js fades out from 3 s to 6 s.
{ const b = buf(1.2); thump(b, 0, { f: 70, gain: .55, decay: 7 }); writeWav(tmp('thump.wav'), b); }
{ const b = buf(1.05), lp = svf(); // low noise swelling while the waterfall falls, until it lands at .9 s
  for (let i = 0; i < b[0].length; i++) { const t = i / SR, s = lp(rnd(), 90 + 160 * t, .9).lp * 1.4 * sm(.1, .9, t) * (1 - sm(.9, 1.05, t)); b[0][i] += s; b[1][i] += s; }
  writeWav(tmp('swell.wav'), b); }
mix('water1', .6, [[wa('splash_06.ogg'), 0, 0]]);
mix('water2', 1.3, [[wa('splash_04.ogg'), 0, -1], [wa('splash_13.ogg'), .02, 0], [tmp('thump.wav'), 0, -6]]);
mix('water3', 6, [[wa('splash_06.ogg'), 0, -4], [wa('loop_bubbles_1.ogg'), .05, -4, 'atrim=0:0.5,afade=t=in:d=0.2,afade=t=out:st=0.35:d=0.15'], [tmp('swell.wav'), 0, -3],
  [wa('splash_08.ogg'), .9, 0], [wa('splash_04.ogg'), .95, -1], [tmp('thump.wav'), .9, -1], [wa('splash_07.ogg'), 1.25, -5], [wa('splash_13.ogg'), 1.6, -6],
  [wa('loop_water_02.ogg'), .35, 4, 'afade=t=in:d=0.5,afade=t=out:st=1.9:d=1.2'], [wa('loop_rain.ogg'), 1.8, 1, 'afade=t=in:d=0.3,afade=t=out:st=1.0:d=1.4'], [wa('loop_water_02.ogg'), 2.2, 0, 'afade=t=in:d=0.4']]);

// ---- wind ----
// Timed to fx-smash-wind.js.
// 1: a quick whoosh passing left to right with a swish on its peak. 2 (中 Twin Boomerang): the two blades rushing in and
// crossing at .14 s (swish, a low air thump), after-cuts, a low body. 3 (大 Travelling Tempest): the twister arriving and swelling
// over the target at 0 (swish + thump), the howling tornado, the release gust blowing outward at 1.45 s.
{ const b = buf(.6); whoosh(b, 0, .55, { lo: 500, hi: 2600, end: 800, q: 1.7, gain: .7, tPeak: .32 }); writeWav(tmp('w1.wav'), b); }
mix('wind1', .6, [[tmp('w1.wav'), 0, 0], [sw('swish-7.wav'), .13, -5]]);
{ const b = buf(1.1);
  whoosh(b, 0, .3, { lo: 400, hi: 2600, end: 700, q: 1.5, gain: .75, tPeak: .47, pan: [-.8, 0] });
  whoosh(b, 0, .3, { lo: 500, hi: 3000, end: 800, q: 1.9, gain: .65, tPeak: .47, pan: [.8, 0] });
  whoosh(b, .1, .95, { lo: 120, hi: 420, end: 150, q: .9, gain: .6, tPeak: .15, pan: [0, 0], air: 0 });
  writeWav(tmp('w2.wav'), b); }
{ const b = buf(1.2); thump(b, 0, { f: 48, gain: .5, decay: 9 }); writeWav(tmp('athump.wav'), b); }
mix('wind2', 1.1, [[tmp('w2.wav'), 0, 0], [sw('swish-9.wav'), .12, -3], [sw('swish-4.wav'), .24, -7], [sw('swish-7.wav'), .32, -9], [tmp('athump.wav'), .14, -8]]);
{ const b = buf(6);
  whoosh(b, 0, .5, { lo: 300, hi: 2200, end: 700, q: 1.4, gain: .6, tPeak: .2, pan: [0, 0] }); // the twister swelling over the target
  gale(b, 0, 6, { gain: .55, fade: [1.1, 5.4] });
  whoosh(b, 1.35, 1.1, { lo: 150, hi: 1800, end: 300, q: 1, gain: .95, tPeak: .12, pan: [0, 0] }); // the release gust
  writeWav(tmp('w3.wav'), b); }
mix('wind3', 6, [[tmp('w3.wav'), 0, 0], [sw('swish-9.wav'), 0, -2], [tmp('athump.wav'), .02, -3], [sw('swish-12.wav'), 1.43, -4], [tmp('athump.wav'), 1.45, -5]]);
console.log('wrote water1-3, wind1-3 to', OUT);
