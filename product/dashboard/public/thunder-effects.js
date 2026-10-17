// Texture-backed electric attacks. Bolts are 3D polylines drawn as camera-facing soft ribbons; PNGs add hit stars and arcs.
//  small  Thunder    a spiky yellow spark ball with a long bright streak; a small comic hit star
//  medium Elthunder  a bigger spark ball, a thick crackling beam; a large spiky hit star with a dark outline
//  large  Thunder (Pikachu) a spark in the sky, a massive bolt straight down, a huge spiky explosion with dark-cored bolts
// Bolt shapes are re-seeded at a fixed rate from the event age, so pausing / stepping keeps the same shape.
import * as THREE from 'three';
import { THUNDER_TIERS, THUNDER_LIFETIME, THUNDER_STRIKE_DELAY, thunderTier, thunderPreviewSample } from './thunder-profile.js';
import { createKit, RAMP, TAU, V, clamp, rand, fade, rise, easeOut } from './effect-kit.js';

const YELLOW = [1, .8, .04], PALE = [1, .93, .45], WHITE = [1, 1, .9], DARK = [.1, .06, .01];

export function createThunderEffects(scene, { onShake = () => {} } = {}) {
  const group = new THREE.Group(); group.name = 'texture-thunder'; scene.add(group);
  const kit = createKit(group, 'thunder', [
    ['arc', 'electric-arc-v2.png'], ['burst', 'electric-burst-v2.png'], ['glow', 'glow.png'], ['spark', 'spark.png'],
    ['spike', 'spike-burst.png'], ['spike2', 'spike-burst-2.png'], ['star', 'star-flare.png'],
  ], { label: 'Thunder', ribbons: 4096 });
  let time = 0, previewTime = 0, sequence = 0;
  const shots = new Map(), events = [], previews = [];
  const previewState = { paused: false, speed: 1, tier: null, age: 0 };
  const point = V(), dir = V(), tail = V(), UP = V(0, 1, 0);
  const glow = (p, size, opacity = 1, color = YELLOW, intensity = 1.6) => kit.sprite('glow', p, size, size, { opacity, intensity, color, ramp: RAMP.flat, occ: 0 });
  const tick = (t, hz) => Math.floor(t * hz);
  function sparks(p, t, count, size, seed) {
    for (let i = 0; i < count; i++) {
      const j = seed * 83 + i, life = .16 + rand(j + 3) * .3; if (t < 0 || t > life) continue;
      const z = rand(j) * 2 - 1, a = rand(j + 1) * TAU, r = Math.sqrt(1 - z * z), sp = (.6 + rand(j + 2) * 2) * size;
      dir.set(Math.cos(a) * r, z, Math.sin(a) * r); point.copy(p).addScaledVector(dir, sp * t);
      kit.sprite('spark', point, .02 * size, (.08 + sp * .06) * size, { opacity: fade(t, life, .12), intensity: 2.4, color: PALE, ramp: RAMP.flat, occ: 0, axis: dir });
    }
  }
  /** Comic hit star: a dark outline layer under a bright spiky star, flickering between two shapes. */
  function hitStar(p, size, opacity, t, seed, { outline = .6, color = PALE, hz = 20 } = {}) {
    const f = tick(t, hz), tex = (f + seed) % 2 ? 'spike' : 'spike2', rot = rand(seed * 7 + f) * TAU;
    if (outline > 0) kit.sprite(tex, p, size * 1.1, size * 1.1, { opacity: opacity * outline, intensity: 1, color: DARK, ramp: RAMP.smoke, occ: .8, rot });
    kit.sprite(tex, p, size, size, { opacity, intensity: 1.05, color, occ: .45, rot });
    kit.sprite(tex, p, size * .42, size * .42, { opacity, intensity: 1.2, color: WHITE, occ: .3, rot: rot + .4 });
  }
  /** Radiating jagged bolts from p, re-seeded `hz` times a second. */
  function radiate(p, t, n, len, seed, { hz = 18, w = .022, opacity = 1, color = YELLOW, jag = .35, flat = .5, branches = .3 } = {}) {
    const f = tick(t, hz);
    for (let i = 0; i < n; i++) {
      const j = seed * 43 + i * 7 + f * 131, a = i / n * TAU + rand(j) * .9, z = (rand(j + 1) - .5) * 2 * flat, l = len * (.55 + rand(j + 2) * .6);
      dir.set(Math.cos(a), Math.sin(a), z).normalize();
      kit.bolt(p, point.copy(p).addScaledVector(dir, l).clone(), j, { jag, count: 7, w, w1: w * .2, color, opacity, intensity: 1.6, core: .4, branches, branchLen: .35 });
    }
  }

  // ---- projectiles ----
  function head(tier, p, d, t, seed, travelled = 9) {
    dir.copy(d).normalize();
    const big = tier === 'medium', f = tick(t, 30);
    // the streak: a bright tapered beam back along the path
    const L = Math.min(travelled, big ? 1.25 : .8);
    tail.copy(p).addScaledVector(dir, -L);
    kit.ribbon(p, tail, big ? .13 : .08, .008, { color: YELLOW, intensity: 1.3, core: .3, opacity: 1, occ: .35 });
    kit.ribbon(p, tail, big ? .3 : .18, .03, { color: [1, .72, .02], intensity: 1, core: 0, opacity: .45, occ: .1 });
    // crackling arcs along the streak
    for (let i = 0; i < (big ? 3 : 2); i++) kit.bolt(point.copy(p).addScaledVector(dir, -.05).clone(), point.copy(p).addScaledVector(dir, -L * (.55 + .35 * rand(seed + i + f))).clone(),
      seed * 17 + i * 31 + f * 7, { jag: big ? .2 : .14, count: 8, w: big ? .016 : .011, w1: .003, color: PALE, intensity: 1.6, core: .45, opacity: .9 });
    kit.sprite('arc', point.copy(p).addScaledVector(dir, -L * .45), L * .9, big ? .32 : .2, { opacity: .7, intensity: 1.5, color: YELLOW, axis: dir, rot: Math.PI / 2, flip: f % 2, occ: .05 });
    // the spark ball
    const s = big ? .42 : .26;
    glow(p, s * 2.2, .4, [1, .75, .02]);
    kit.sprite(f % 2 ? 'spike' : 'spike2', p, s, s, { opacity: 1, intensity: 1.2, color: PALE, occ: .4, rot: f * 1.37 });
    if (big) kit.sprite(f % 2 ? 'spike2' : 'spike', p, s * .75, s * .75, { opacity: .9, intensity: 1.7, color: WHITE, occ: .2, rot: -f * 1.1 });
    glow(p, s * .5, 1, WHITE, 1.6);
    radiate(p, t, big ? 5 : 3, big ? .32 : .2, seed, { hz: 30, w: big ? .014 : .01, color: PALE, branches: 0 });
  }

  // ---- impacts ----
  function smallHit(p, t, seed) {
    const k = easeOut(t, 22), f = fade(t, .3, .14);
    hitStar(p, .62 * k, f, t, seed, { outline: .35 });
    glow(p, .7, fade(t, .16, .1) * .7, [1, .85, .3], 1.6);
    if (t < .1) kit.sprite('star', p, .9, .9, { opacity: fade(t, .1, .06), intensity: 1.4, color: WHITE, occ: 0, rot: seed });
    if (t < .3) radiate(p, t, 6, .4, seed, { w: .014, opacity: f });
    sparks(p, t, 16, .7, seed);
  }
  function mediumHit(p, t, seed) {
    const k = easeOut(t, 16), f = fade(t, .46, .2);
    glow(p, 1.8, f * .25, [1, .7, .02], 1.2);
    hitStar(p, 1.3 * k * (1 + .05 * Math.sin(t * 60)), f, t, seed, { outline: .65 });
    kit.sprite('burst', p, 1.3 * k, 1.3 * k, { opacity: f * .7, intensity: 1.2, color: YELLOW, occ: .1, rot: tick(t, 15) * 1.1 + seed });
    if (t < .12) { kit.sprite('star', p, 1.5, 1.5, { opacity: fade(t, .12, .07), intensity: 1.5, color: WHITE, occ: 0, rot: seed });
      glow(p, .9, fade(t, .12, .08) * .8, WHITE, 1.8); }
    if (t < .5) radiate(p, t, 10, .75, seed, { w: .02, opacity: f });
    sparks(p, t, 30, 1, seed);
  }
  function largeHit(p, t, seed) {
    const sky = V(p.x + (rand(seed) - .5) * .5, p.y + 4.6, p.z + (rand(seed + 1) - .5) * .5);
    // the spark that gathers in the sky first (only seen when the event starts before the strike, as in the preview)
    if (t < .05) { const f = rise(t, -THUNDER_STRIKE_DELAY, -.06); kit.sprite('star', sky, .9, .9, { opacity: f, intensity: 2, color: PALE, occ: 0, rot: t * 5 });
      glow(sky, .8, f, YELLOW, 2); hitStar(sky, .35 * f, f, t + 1, seed, { outline: 0 }); }
    if (t < 0) return;
    const f = tick(t, 15), strike = fade(t, .5, .2);
    if (strike > 0) {
      // the main column: a wide soft glow, a thick jagged bolt, and a second thinner one alternating with it
      kit.ribbon(sky, p, .5, .6, { color: [1, .75, .05], intensity: .9, core: 0, opacity: strike * .25, occ: 0 });
      kit.bolt(sky, p, seed * 137 + f * 11, { jag: .07, count: 18, w: .15, w1: .12, color: YELLOW, intensity: 1.4, core: .35, opacity: strike, branches: .35, branchLen: .12, occ: .3 });
      kit.bolt(sky.clone().lerp(p, .15), p, seed * 137 + f * 11 + 57, { jag: .11, count: 12, w: .05, w1: .04, color: PALE, intensity: 1.7, core: .45, opacity: strike * .8, branches: .2, branchLen: .15 });
      glow(sky, 1.2, strike * .8, YELLOW, 2);
    }
    // the explosion around the target: layered hit stars, a magenta flash, a big star flare
    const k = easeOut(t, 11), boom = fade(t, .85, .35), sz = 2.1 * k * (1 + .06 * Math.sin(t * 50)) * (1 - .25 * rise(t, .5, .85));
    glow(p, 2.8, boom * .28, [1, .72, .02], 1.1);
    if (t < .4) glow(p, 2.2, fade(t, .4, .25) * .35, [.75, .2, 1], 1.6);
    hitStar(p, sz, boom, t, seed, { outline: .7, hz: 15 });
    kit.sprite('burst', p, sz * 1.2, sz * 1.2, { opacity: boom * .7, intensity: 1.2, color: YELLOW, occ: .1, rot: f * .9 + seed });
    if (t < .16) { kit.sprite('star', p, 3, 3, { opacity: fade(t, .16, .1), intensity: 1.6, color: WHITE, occ: 0, rot: .3 }); glow(p, 1.2, fade(t, .16, .1) * .8, WHITE, 1.8); }
    // dark-cored bolts thrown across the burst (yellow edge, black core), then lingering yellow zig-zags
    if (t > .3 && t < 1.05) {
      const g = tick(t, 10), o = rise(t, .3, .38) * fade(t, 1.05, .3);
      for (let i = 0; i < 4; i++) {
        const j = seed * 59 + i * 13 + g * 97, a = rand(j) * TAU, l = 1 + rand(j + 1) * .6;
        dir.set(Math.cos(a), Math.sin(a), (rand(j + 2) - .5) * .6).normalize();
        const from = point.copy(p).addScaledVector(dir, -l * .45).clone(), to = V().copy(p).addScaledVector(dir, l * .55);
        kit.bolt(from, to, j, { jag: .22, count: 9, w: .11, w1: .045, color: YELLOW, intensity: 1.2, core: 0, opacity: o, occ: .3 });
        kit.bolt(from, to, j, { jag: .22, count: 9, w: .05, w1: .02, color: DARK, intensity: 1, core: 0, opacity: o, occ: 1 });
      }
    }
    radiate(p, t, 8, 1.3, seed, { hz: 12, w: .03, opacity: fade(t, THUNDER_LIFETIME.large, .5), flat: .7, branches: .4 });
    sparks(p, t, 60, 1.6, seed);
    sparks(p, t - .35, 30, 1.1, seed + 9);
  }
  function impact(tier, p, t, seed) {
    if (t > THUNDER_LIFETIME[tier] || (t < 0 && !(tier === 'large' && t >= -THUNDER_STRIKE_DELAY))) return;
    if (tier === 'small') smallHit(p, t, seed); else if (tier === 'medium') mediumHit(p, t, seed); else largeHit(p, t, seed);
  }
  function addHit(tier, p, preview = false) { events.push({ tier, p: p.clone(), at: preview ? previewTime : time, seed: ++sequence, preview }); if (events.length > 64) events.shift(); onShake(tier === 'large' ? .75 : tier === 'medium' ? .25 : .12); }
  return {
    shot(id, pos, d, power) { const tier = thunderTier(power); shots.set(id, { tier, p: pos.clone(), from: pos.clone(), dir: d.clone().normalize(), seed: ++sequence, history: [], next: time, at: time }); },
    moveShot(id, p) { const s = shots.get(id); if (!s) return; s.p.copy(p); if (time >= s.next) { s.history.push({ p: p.clone(), at: time }); s.next = time + 1 / 60; } },
    endShot(id) { shots.delete(id); },
    hit(pos, power) { addHit(thunderTier(power), pos); },
    special(from, to) { addHit('large', to); },
    preview(tier, from, to, getTarget = null) { if (!THUNDER_TIERS.includes(tier)) return; previews.length = 0; previewTime = 0; previewState.paused = false; previewState.tier = tier; previews.push({ tier, from: from.clone(), to: to.clone(), dir: to.clone().sub(from).normalize(), seed: ++sequence, getTarget, impactPoint: null }); },
    previewControl({ paused, speed, step } = {}) { if (paused !== undefined) previewState.paused = !!paused; if (speed !== undefined) previewState.speed = clamp(speed); if (step) { previewState.paused = true; previewTime += Math.min(.1, Math.max(0, step)); } },
    step(dt) {
      time += dt; if (!previewState.paused) previewTime += dt * previewState.speed; previewState.age = previewTime;
      kit.begin();
      for (const s of shots.values()) { s.history = s.history.filter(h => time - h.at < .3); head(s.tier, s.p, s.dir, time - s.at, s.seed, s.p.distanceTo(s.from)); }
      for (let i = events.length - 1; i >= 0; i--) { const e = events[i], age = (e.preview ? previewTime : time) - e.at; if (age > THUNDER_LIFETIME[e.tier]) events.splice(i, 1); else impact(e.tier, e.p, age, e.seed); }
      for (const s of previews) {
        const q = thunderPreviewSample(s.tier, previewTime);
        if (!previewState.paused && !s.impactPoint && s.getTarget) { const p = s.getTarget(); if (p) s.to.copy(p); s.dir.copy(s.to).sub(s.from).normalize(); }
        if (!s.impactPoint && q.impactAge >= 0) s.impactPoint = s.to.clone();
        if (q.flying) { const p = s.from.clone().lerp(s.to, q.progress); head(s.tier, p, s.dir, previewTime, s.seed, p.distanceTo(s.from)); }
        if (q.alive) impact(s.tier, s.impactPoint ?? s.to, q.impactAge, s.seed);
      }
      kit.end();
    },
    get active() { return group.visible; },
    stats() { return { particles: kit.count, shots: shots.size, events: events.length, loaded: [...kit.loaded], errors: [...kit.errors], total: kit.total, preview: { ...previewState } }; },
    dispose() { scene.remove(group); kit.dispose(); },
  };
}
