// Builds the water / wind hits, the four charge loops and the four "fully charged" stings in product/dashboard/public/audio
// (water1-3, wind1-3, charge_<el>, full_<el>).
//   node effect-assets/procedural/make-sfx.mjs <src-dir>
// <src-dir> holds the downloaded material, unzipped (sources and licenses: public/audio/README.md):
//   <src>/cc0/wa/*.ogg            water-splash-slime-sfx.zip (OpenGameArt, CC0)
//   <src>/cc0/sw/swishes/*.wav    swishes.zip (OpenGameArt, CC0)
//   <src>/fs/<id>.mp3             Freesound CC0 sounds, the HQ preview of https://freesound.org/s/<id>/
//   <src>/oga/leohpaz/*.wav       8_rpg_battle_magic_sfx_free_samples.zip (OpenGameArt, leohpaz, CC-BY 4.0)
//   <src>/oga/magical_3.ogg       "Magic Spell SFX" (OpenGameArt, JaggedStone, CC0)
// Every sound is layered the way action-game spells are: a transient (splash / swish / crack), a body (the element's mass,
// a low thump), a tail (spray, rain, wind) and a magical layer, each band-limited so they do not mask each other. Each source
// layer is set by its measured loudness (ebur128), each file is mastered to a target loudness with a -1.5 dBFS limiter.
// Needs ffmpeg. Deterministic (seeded noise), so re-running gives the same files.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node make-sfx.mjs <src-dir>'); process.exit(1); }
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
/** a bell-like ping: inharmonic partials, each decaying faster than the last (the "ready" shine on the full-charge sting) */
function ping(out, t0, { f = 1760, gain = .3, decay = 4, pan = 0 } = {}) {
  const n = Math.round(2 * SR), o = Math.round(t0 * SR), gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < n && o + i < out[0].length; i++) {
    const t = i / SR, s = [1, 2.76, 5.4, 8.93].reduce((a, m, k) => a + Math.sin(TAU * f * m * t) * Math.exp(-t * decay * (1 + k)) / (1 + k), 0) * Math.min(1, t / .002) * gain;
    out[0][o + i] += s * gl; out[1][o + i] += s * gr;
  }
}
/** a low roar that surges: low-passed noise whose level breathes with two slow LFOs (whole cycles over dur, so it loops) */
function rumble(out, dur, { fc = 120, gain = .5, cycles = [2, 3] } = {}) {
  const lp = svf(), lp2 = svf(), n = Math.round(dur * SR);
  for (let i = 0; i < n && i < out[0].length; i++) {
    const t = i / SR, u = t / dur, x = lp2(lp(rnd(), fc, .7).lp, fc, .7).lp;
    const e = (.7 + .2 * Math.sin(TAU * cycles[0] * u) + .1 * Math.sin(TAU * cycles[1] * u + 1)) * gain * 2.5;
    out[0][i] += x * e; out[1][i] += x * e;
  }
}
const ff = args => { const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]); if (r.status) throw new Error(String(r.stderr)); };
/** integrated loudness (LUFS) of a file after an optional filter; looped 9 times so clips shorter than ebur128's 400 ms
 *  gating block still measure */
function lufs(file, x = '') {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', (x ? x + ',' : '') + 'aloop=loop=8:size=2000000,ebur128', '-f', 'null', '-']);
  const m = String(r.stderr).split('Summary:')[1]?.match(/I:\s+(-?[\d.]+) LUFS/); return m ? +m[1] : -70;
}
/** layers: [file, delay s, dB, extra filter?]. A layer's dB is relative to the layer at -20 LUFS (its own loudness, measured
 *  after its filter, is taken out), so the numbers read as a mix. The sum is brought to `target` LUFS, then limited to
 *  -1.5 dBFS (true peak stays under -1 dBTP) and encoded at 192 kb/s. */
function mix(name, dur, target, layers) {
  const ins = layers.flatMap(([f]) => ['-i', f]);
  const ch = layers.map(([f, d, g, x], i) => `[${i}]aresample=${SR},aformat=channel_layouts=stereo,${x ? x + ',' : ''}volume=${(g - 20 - lufs(f, x)).toFixed(2)}dB,adelay=${Math.round(d * 1000)}|${Math.round(d * 1000)}[a${i}]`);
  const sum = ch.join(';') + ';' + layers.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${layers.length}:normalize=0:duration=longest,atrim=0:${dur}`;
  const raw = tmp(name + '.wav');
  ff([...ins, '-filter_complex', sum + '[o]', '-map', '[o]', '-c:a', 'pcm_f32le', raw]);
  ff(['-i', raw, '-af', `volume=${(target - lufs(raw)).toFixed(2)}dB,alimiter=limit=.84:attack=1:release=60:level=false,afade=t=out:st=${(dur - .05).toFixed(2)}:d=0.05`, '-ar', '44100', '-b:a', '192k', join(OUT, name + '.mp3')]);
}
const wa = f => join(SRC, 'cc0/wa', f), sw = f => join(SRC, 'cc0/sw/swishes', f), fs = id => join(SRC, 'fs', id + '.mp3'), lh = f => join(SRC, 'oga/leohpaz', f), tmp = f => join(TMP, f);
const seg = (a, b, fi = .01, fo = .05) => `atrim=${a}:${b},asetpts=PTS-STARTPTS,afade=t=in:d=${fi},afade=t=out:st=${(b - a - fo).toFixed(3)}:d=${fo}`;
const HP = f => `highpass=f=${f}`, LP = f => `lowpass=f=${f}`;

// ---- water ----
// Timed to fx-smash-water.js.
// 1 (every launch, the 小 hit): a short splash. 2 (中 Tidal Surge): the geyser bursting up under the target at once. 3 (大
// Cataract): the orb splashing into the magic circle, a low swell while the waterfall starts pouring (.35 s) and falls, its
// impact on the floor at .9 s, spray at 1.25 / 1.6 s, the roar of falling water until ~2.3 s, then rain and surf that audio.js
// fades out from 3 s to 6 s.
// Layers: transient = the front of a big real splash (Freesound 442773 / 316744 / 469608), body = the OpenGameArt splashes and
// a low thump (the mass of water), magic = leohpaz's designed water spell, tail = drops, rain, surf.
{ const b = buf(1.2); thump(b, 0, { f: 70, gain: .55, decay: 7 }); writeWav(tmp('thump.wav'), b); }
{ const b = buf(1.6); thump(b, 0, { f: 46, gain: .6, decay: 4.5 }); writeWav(tmp('boom.wav'), b); }
{ const b = buf(1.05), lp = svf(); // low noise swelling while the waterfall falls, until it lands at .9 s
  for (let i = 0; i < b[0].length; i++) { const t = i / SR, s = lp(rnd(), 90 + 160 * t, .9).lp * 1.4 * sm(.1, .9, t) * (1 - sm(.9, 1.05, t)); b[0][i] += s; b[1][i] += s; }
  writeWav(tmp('swell.wav'), b); }
mix('water1', .6, -13, [[fs(442773), 0, 0, seg(.15, .6, .003, .2) + ',' + HP(180)], [wa('splash_06.ogg'), 0, -2], [lh('22_Water_02.wav'), 0, -6, seg(0, .6, .005, .3)],
  [tmp('thump.wav'), 0, -7, seg(0, .4, .002, .2)]]);
mix('water2', 1.3, -12, [[fs(442773), 0, 0, seg(.15, 1.45, .003, .4)], [fs(316744), .02, -3, seg(0, 1.25, .002, .4) + ',' + HP(150)], [wa('splash_04.ogg'), 0, -5],
  [wa('splash_13.ogg'), .02, -5], [lh('22_Water_02.wav'), 0, -4, seg(0, 1.3, .005, .5)], [tmp('boom.wav'), 0, -1, seg(0, 1.2, .002, .5)], [wa('splash_07.ogg'), .55, -11]]);
mix('water3', 6, -13, [[wa('splash_06.ogg'), 0, -2], [lh('22_Water_02.wav'), 0, -5, seg(0, .9, .005, .3)], [wa('loop_bubbles_1.ogg'), .05, -8, seg(0, .5, .2, .15)],
  [tmp('swell.wav'), 0, -6], [fs(193755), .35, -4, seg(20.5, 23, .5, 1.4) + ',' + HP(120)], [wa('loop_water_02.ogg'), .35, -3, 'afade=t=in:d=0.5,afade=t=out:st=1.9:d=1.2'],
  [fs(469608), .6, -10, seg(0, .3, .002, .02) + ',areverse,afade=t=in:d=0.25'], // the splash reversed: a suck-in into the impact
  [fs(442773), .9 - .15, 2, seg(0, 2.17, .002, .8)], [fs(316744), .9, -1, HP(120)], [wa('splash_08.ogg'), .9, -4], [tmp('boom.wav'), .9, 1], [tmp('thump.wav'), .9, -4],
  [wa('splash_07.ogg'), 1.25, -7], [wa('splash_13.ogg'), 1.6, -8], [fs(469608), 1.6, -9, HP(300)],
  [wa('loop_rain.ogg'), 1.8, -9, 'afade=t=in:d=0.3,afade=t=out:st=1.0:d=1.4'], [fs(426075), 2.0, -7, seg(146, 150, .6, 1.5) + ',' + HP(90)], [wa('loop_water_02.ogg'), 2.2, -10, 'afade=t=in:d=0.4']]);

// ---- wind ----
// Timed to fx-smash-wind.js.
// 1: a quick whoosh passing left to right with a swish on its peak. 2 (中 Twin Boomerang): the two blades rushing in and
// crossing at .14 s (swish, a low air thump), after-cuts, a low body. 3 (大 Travelling Tempest): the twister arriving and swelling
// over the target at 0 (swish + thump), the howling tornado, the release gust blowing outward at 1.45 s.
// Layers: transient = the swishes and a tonal whoosh (Freesound 60013 / 683101), body = the synthesized band-passed whooshes
// (Farnell "Designing Sound") and a low air thump, magic = leohpaz's designed wind spell, tail = real wind (344887 / 638434 / 361487).
{ const b = buf(.6); whoosh(b, 0, .55, { lo: 500, hi: 2600, end: 800, q: 1.7, gain: .7, tPeak: .32 }); writeWav(tmp('w1.wav'), b); }
{ const b = buf(1.2); thump(b, 0, { f: 48, gain: .5, decay: 9 }); writeWav(tmp('athump.wav'), b); }
mix('wind1', .6, -13, [[tmp('w1.wav'), 0, 0], [fs(60013), .1, -3, HP(250)], [sw('swish-7.wav'), .13, -6], [lh('25_Wind_01.wav'), 0, -5, seg(0, .6, .005, .3)],
  [tmp('athump.wav'), .14, -12, seg(0, .3, .002, .15)]]);
{ const b = buf(1.1);
  whoosh(b, 0, .3, { lo: 400, hi: 2600, end: 700, q: 1.5, gain: .75, tPeak: .47, pan: [-.8, 0] });
  whoosh(b, 0, .3, { lo: 500, hi: 3000, end: 800, q: 1.9, gain: .65, tPeak: .47, pan: [.8, 0] });
  whoosh(b, .1, .95, { lo: 120, hi: 420, end: 150, q: .9, gain: .6, tPeak: .15, pan: [0, 0], air: 0 });
  writeWav(tmp('w2.wav'), b); }
mix('wind2', 1.1, -14, [[tmp('w2.wav'), 0, 0], [fs(683101), 0, -2, seg(.06, .9, .005, .3)] /* its peak (.2 s) on the cross */, [sw('swish-9.wav'), .12, -3], [sw('swish-4.wav'), .24, -8], [sw('swish-7.wav'), .32, -10],
  [tmp('athump.wav'), .14, -5], [lh('25_Wind_01.wav'), .1, -5, seg(0, 1, .01, .4)], [fs(361487), .25, -10, seg(1, 1.85, .2, .4) + ',' + HP(200)]]);
{ const b = buf(6);
  whoosh(b, 0, .5, { lo: 300, hi: 2200, end: 700, q: 1.4, gain: .6, tPeak: .2, pan: [0, 0] }); // the twister swelling over the target
  gale(b, 0, 6, { gain: .55, fade: [1.1, 5.4] });
  whoosh(b, 1.35, 1.1, { lo: 150, hi: 1800, end: 300, q: 1, gain: .95, tPeak: .12, pan: [0, 0] }); // the release gust
  writeWav(tmp('w3.wav'), b); }
mix('wind3', 6, -13, [[tmp('w3.wav'), 0, 0], [sw('swish-9.wav'), 0, -3], [tmp('athump.wav'), .02, -3], [lh('25_Wind_01.wav'), 0, -4],
  [fs(344887), .1, -6, seg(0, 4.5, .4, 2.6) + ',' + HP(100)], [fs(638434), .2, -8, seg(2, 6, .5, 2.4)], // the tornado's roar and its howl
  [fs(683096), 1.45 - .75, -1, seg(0, 1.7, .01, .5)], [sw('swish-12.wav'), 1.43, -4], [tmp('athump.wav'), 1.45, -4], [fs(361487), 1.5, -9, seg(1, 4, .1, 2.2) + ',' + HP(250)]]);

// ---- charge loops (one per element) ----
// audio.js loops each file's steady middle (LOOPS: [.25, 4.75, .4] s, the tail crossfaded into the head) and raises its pitch per
// tier. Each element has its own band so two players charging at once stay apart: fire low (a roar, < 1 kHz body), water the
// mids (a swirling vortex, slow phaser), wind a tonal howl (600 Hz-2 kHz, moving left / right), thunder the top (crackle, buzz).
{ const b = buf(5); rumble(b, 5, { fc: 110, gain: .5, cycles: [2, 3] }); writeWav(tmp('rumble.wav'), b); }
{ const b = buf(5); gale(b, 0, 5, { gain: .5, fade: [9, 10] }); writeWav(tmp('gale.wav'), b); }
{ const b = buf(5), lp = svf(); // the electric hum under the crackle: a 100 Hz buzz (odd harmonics), flickering 5 times / s
  for (let i = 0; i < b[0].length; i++) { const t = i / SR, saw = [1, 3, 5, 7, 9].reduce((a, k) => a + Math.sin(TAU * 100 * k * t) / k, 0);
    const s = lp(saw, 1800, .8).lp * (.75 + .25 * Math.sin(TAU * 5 * t)) * .25; b[0][i] += s; b[1][i] += s; }
  writeWav(tmp('buzz.wav'), b); }
mix('charge_fire', 5, -15, [[fs(581078), 0, 0, seg(.5, 5.5, .05, .05)], [fs(563138), 0, -4, seg(2, 7, .05, .05) + ',' + HP(400)], [fs(249418), 0, -9, seg(3, 8, .05, .05) + ',' + HP(1500)],
  [tmp('rumble.wav'), 0, -3]]);
mix('charge_thunder', 5, -15, [[fs(531421), 0, -2, seg(0, 4.9, .05, .05) + ',' + HP(150)], [fs(187363), 0, -1, seg(1, 6, .05, .05) + ',' + HP(900)],
  [fs(449013), 0, -6, seg(20, 25, .05, .05) + ',' + HP(120)], [fs(238597), 0, -7, seg(4, 9, .05, .05) + ',' + HP(2000)], [tmp('buzz.wav'), 0, -6]]);
mix('charge_water', 5, -15, [[fs(197266), 0, 0, seg(5.5, 10.5, .05, .05) + ',aphaser=speed=0.4:decay=0.5'], [fs(193755), 0, -3, seg(5, 10, .05, .05) + ',' + HP(150)],
  [wa('loop_bubbles_02.ogg'), 0, -9, 'aloop=loop=4:size=200000,' + seg(0, 5, .05, .05) + ',' + HP(600)], [tmp('rumble.wav'), 0, -12, LP(200)]]);
mix('charge_wind', 5, -15, [[fs(638434), 0, 0, seg(6, 11, .05, .05)], [fs(344887), 0, -3, seg(5, 10, .05, .05) + ',' + HP(150)], [fs(403003), 0, -5, seg(5, 10, .05, .05)],
  [tmp('gale.wav'), 0, -6, 'apulsator=hz=0.6:amount=0.5']]);

// ---- fully charged (大 reached): a bright ping + a puff of the element, ~1.3 s ----
{ const b = buf(1.6); ping(b, 0, { f: 1760, gain: .3, decay: 3, pan: -.2 }); ping(b, .02, { f: 2637, gain: .2, decay: 3.5, pan: .2 }); writeWav(tmp('ping.wav'), b); }
const shine = [[tmp('ping.wav'), 0, -3], [join(SRC, 'oga/magical_3.ogg'), 0, -5, seg(0, 1.3, .005, .6) + ',' + HP(500)]];
mix('full_fire', 1.3, -13, [...shine, [lh('04_Fire_explosion_04_medium.wav'), 0, 0, seg(0, 1.3, .003, .6)], [tmp('boom.wav'), 0, -6, seg(0, 1, .002, .4)]]);
mix('full_thunder', 1.3, -13, [...shine, [lh('18_Thunder_02.wav'), 0, 0, seg(0, 1.3, .003, .6)], [fs(187363), 0, -6, seg(.4, 1.2, .002, .4) + ',' + HP(1500)]]);
mix('full_water', 1.3, -13, [...shine, [lh('22_Water_02.wav'), 0, 0, seg(0, 1.3, .003, .6)], [fs(469608), 0, -5, seg(0, 1.2, .002, .5) + ',' + HP(200)]]);
mix('full_wind', 1.3, -13, [...shine, [lh('25_Wind_01.wav'), 0, 0, seg(0, 1.0, .003, .4)], [fs(60013), 0, -4, HP(250)]]);
console.log('wrote water1-3, wind1-3, charge_<el>, full_<el> to', OUT);
