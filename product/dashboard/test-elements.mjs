// Every element has its entry in every per-element table, and the "smash" set draws water / wind with their own moves
// (never the classic fallback): each tier's shot / landing / hit, the charge, the aura and the guard run without throwing.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from './vendor/cdn/npm/three@0.160.0/build/three.module.js';
import { EL } from './public/audio.js';
import { createSmashStyle } from './public/fx-smash.js';

const ELEMENTS = ['fire', 'thunder', 'water', 'wind'];
const NEW = ['water', 'wind'];

// sounds: launch (1), 中 hit (2), 大 hit (3), and the file is there
for (const el of ELEMENTS) for (const k of [1, 2, 3]) {
  assert.ok(EL[el]?.[k], `audio EL.${el}.${k}`);
  assert.ok(existsSync(new URL(`./public/audio/${EL[el][k]}.mp3`, import.meta.url)), `audio file ${EL[el][k]}.mp3`);
}
// palette tables in the effect modules and the dashboard (read as text: they live inside closures)
const src = f => readFileSync(new URL('./public/' + f, import.meta.url), 'utf8');
for (const [file, table] of [['fx-smash-charge.js', 'const PAL = {'], ['fx-smash-guard.js', 'const PAL = {'], ['fx-smash-circle.js', 'const PAL = {'],
  ['charge-effects.js', 'const PALETTE = {'], ['effects.js', 'const ELC = {'], ['effects.js', 'const CHARGE = {'], ['effects.js', 'const AURA = {'], ['app.js', 'EL_COLOR = {'], ['field3d.js', "c = { fire:"]]) {
  const s = src(file), i = s.indexOf(table); assert.ok(i >= 0, `${file}: ${table}`);
  const ends = ['};', '}['].map(e => s.indexOf(e, i)).filter(e => e > 0), body = s.slice(i, Math.min(...ends)); // up to the table's own end
  // field3d's table leaves thunder to its fallback colour
  for (const el of (file === 'field3d.js' ? ['fire', 'water', 'wind'] : ELEMENTS)) assert.match(body, new RegExp(`\\b${el}\\s*:`), `${file} ${table} has ${el}`);
}

// a kit of stubs that counts what gets drawn
const V = () => new THREE.Vector3();
let drawn = 0, time = 0, seed = 1;
const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const u3 = [0, 0, 0];
const classicCalls = [];
const classic = new Proxy({}, { get: (_, k) => (...a) => { classicCalls.push([k, a[0]?.el ?? a[0]]); } });
const live = [];
class Bolt { constructor(cap = 160) { this.d = new Float32Array(cap * 8); this.n = 0; this.cap = cap; this.on = 1; } }
const kit = {
  THREE, K: { FLAME: 0, SMOKE: 1, SPARK: 2, GLOW: 3, EMBER: 4, DROP: 5 }, S: { GLOW: 0, FIREBALL: 1, PLASMA: 2, RING: 3, SWIRL: 4, FLARE: 5, GHOST: 6, WATER: 7, CRESCENT: 8 },
  COL: new Proxy({}, { get: () => [1, 1, 1] }), TAU: Math.PI * 2, Q: 1, R, RS: s => (R() * 2 - 1) * s, V,
  emit: (...a) => { assert.ok(a.slice(0, 11).every(Number.isFinite), 'emit: finite numbers'); drawn++; },
  spr: (k, p, sx, sy) => { assert.ok(Number.isFinite(p.x + p.y + p.z + sx + sy), 'spr: finite'); drawn++; },
  sprFloor: () => { drawn++; }, seg: (...a) => { assert.ok(a.slice(0, 8).every(Number.isFinite), 'seg: finite'); drawn++; }, segV: () => { drawn++; },
  Bolt, gen: () => {}, drawBolt: () => {}, runit: (o = u3) => { const z = R() * 2 - 1, t = R() * 6.28, r = Math.sqrt(1 - z * z); o[0] = r * Math.cos(t); o[1] = z; o[2] = r * Math.sin(t); return o; }, u3,
  take: (st, k, n) => { const v = (st.acc[k] ?? 0) + n, f = Math.floor(v); st.acc[k] = v - f; return f; },
  flick: () => 1, sc: (k, a, b) => Math.min(1, Math.max(0, (k - a) / (b - a))), shake: () => {},
  fireBurst: () => {}, sparkBurst: () => {}, splashBurst: () => { drawn++; }, gustBurst: () => { drawn++; }, trailFire: () => {}, headFire: () => {}, screenRot: () => .3,
  add: e => { e.age = 0; e.seed = R(); e.acc = {}; e.bolts ??= []; live.push(e); return e; }, classic, camera: new THREE.PerspectiveCamera(), get time() { return time; },
};
const style = createSmashStyle(kit);
const dt = 1 / 60;
const runLive = () => { for (let f = 0; f < 150 && live.length; f++) { time += dt; for (let i = live.length - 1; i >= 0; i--) { const e = live[i]; e.dt = dt; if (!e.update(e, dt)) live.splice(i, 1); e.age += dt; } } };
for (const el of NEW) {
  for (const tier of ['s', 'm', 'l']) for (const how of ['hit', 'floor', 'timeout']) {
    const s = { el, tier, pos: new THREE.Vector3(-1.5, 1.2, 0), prev: new THREE.Vector3(-1.5, 1.2, 0), from: V(), dir: new THREE.Vector3(1, 0, 0), power: .6, big: 1, scale: 1, age: 0, travel: 0, acc: {}, regen: 0, seed: .3, bolts: [] };
    drawn = 0;
    for (let f = 0; f < 30; f++) { s.pos.x += .12; style.shot(s, dt); s.age += dt; time += dt; }
    assert.ok(drawn > 30, `${el} ${tier} shot draws`);
    drawn = 0;
    if (how === 'hit') style.hit(el, s.pos.clone(), .7, { tier });
    style.end(s, how);
    runLive();
    assert.ok(drawn > 20, `${el} ${tier} ${how} landing draws`);
  }
  // charge (tip), aura (stick + body + magic circle), guard and block
  const c = { el, tip: new THREE.Vector3(0, 1.4, 0), v: 0, acc: {}, regen: 0, seed: .4, bolts: Array.from({ length: 10 }, () => new Bolt(96)), opt: {} };
  const a = { el, base: V(), tip: new THREE.Vector3(.4, 1.4, 0), v: 1, acc: {}, regen: 0, seed: .5, bolts: Array.from({ length: 10 }, () => new Bolt(96)) };
  const g = { el, tip: new THREE.Vector3(0, 1.1, 0), base: new THREE.Vector3(1, 0, 0), facing: true, v: 1, acc: {}, seed: .6 };
  drawn = 0;
  for (let f = 0; f < 200; f++) {
    const tier = f < 70 ? 's' : f < 140 ? 'm' : 'l', L = Math.min(1, f / 150);
    c.v = L; c.opt = { tier, chargeT: f * dt }; a.opt = { charging: true, level: L, tier, chest: new THREE.Vector3(0, 1.3, 0), feet: V() };
    style.charge(c, dt); style.aura(a, dt); style.guard(g, dt); time += dt;
  }
  style.block(el, new THREE.Vector3(0, 1.1, 0)); runLive();
  assert.ok(drawn > 1000, `${el} charge / aura / guard draw`);
}
// the classic set is only asked for the stick glow (aura), never for a water / wind move
assert.deepEqual(classicCalls.filter(([k]) => k !== 'aura'), [], 'water / wind never fall back to the classic moves');
console.log('test-elements: ok (tables for', ELEMENTS.join(', ') + '; water / wind moves, charge, aura, guard)');
