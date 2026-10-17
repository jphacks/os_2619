// Texture-backed fire, rendered in effects.js's HDR scene before its existing bloom/composite.
// All shapes are in world metres. Fixed particle indices + event age determine their motion, so a paused preview holds still.
//  small  PK Fire        a flat yellow zig-zag bolt; on hit a tall crimson pillar of flame with dark smoke and ◆ sparkles
//  medium Firaga         a big fireball with a streaming comet tail; on hit a star flash and a burst of flame puffs that cling
//  large  Explosive Flame a sphere of fire (bright rim, swirling dark interior, big lens star) that holds, then bursts into smoke
import * as THREE from 'three';
import { fireTier, FIRE_TIERS, FIRE_LIFETIME, firePreviewSample } from './fire-profile.js';
import { createKit, RAMP, TAU, V, clamp, rand, fade, rise, easeOut, blend } from './effect-kit.js';

// Rendering only; projectile movement and gameplay collision stay unchanged.
const SCALE = 1;
const NOISE = `
float h3(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float n3(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
 return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
  mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float s=0.,a=.5;for(int i=0;i<4;i++){s+=a*n3(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s;}
vec3 fireRamp(float h){vec3 c=mix(vec3(.5,.03,.004),vec3(1.,.26,.01),smoothstep(.05,.4,h));
 c=mix(c,vec3(1.,.66,.07),smoothstep(.35,.68,h));return mix(c,vec3(1.,.96,.78),smoothstep(.7,.97,h));}`;
const MVS = `varying vec3 vP,vN,vEye;void main(){vP=position;vec4 p=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vEye=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`;
// uKind 0 flat emissive (PK bolt), 1 fireball, 2 Explosive Flame sphere, 3 flame corona shell around it
const MFS = `${NOISE}
varying vec3 vP,vN,vEye;uniform vec3 uColor;uniform float uOpacity,uTime,uKind,uSeed,uI;
void main(){vec3 c;float a,occ;float rim=1.-abs(dot(normalize(vN),normalize(vEye)));vec3 q=vP+uSeed;
 if(uKind<.5){c=uColor;a=uOpacity;occ=.55;}
 else if(uKind<1.5){float n=fbm(q*3.2+vec3(0.,-uTime*3.,uTime*.7));
  float heat=clamp(1.08-rim*.85+(n-.5)*.9,0.,1.);c=fireRamp(heat);a=(1.-smoothstep(.62,.98,rim+(.5-n)*.35))*uOpacity;occ=.85;}
 else if(uKind<2.5){float n=fbm(q*2.4+vec3(uTime*.7,-uTime*1.5,uTime*.4)),s=fbm(q*5.5+vec3(0.,-uTime*2.6,uTime));
  vec3 inner=mix(vec3(.3,.015,.002),vec3(.95,.2,.01),smoothstep(.35,.8,n));inner+=vec3(1.,.5,.06)*smoothstep(.58,.78,s)*1.1;
  float line=smoothstep(.8,.95,rim),glow=smoothstep(.55,.95,rim);
  c=mix(inner,vec3(1.,.5,.06)*1.2,glow*.6);c=mix(c,vec3(1.,.86,.45)*1.6,line);a=mix(.8,1.,glow)*uOpacity;occ=.95;}
 else {float f=fbm(q*4.+vec3(0.,-uTime*4.5,uTime))-(rim-.55)*.95;
  a=smoothstep(.22,.42,f)*smoothstep(.35,.65,rim)*uOpacity;c=fireRamp(clamp(f*1.35,0.,1.));occ=.8;}
 if(a<.004)discard;gl_FragColor=vec4(c*a*uI,a*occ);}`;

export function createFireEffects(scene, { onShake = () => {} } = {}) {
  const group = new THREE.Group(); group.name = 'texture-fire'; scene.add(group);
  const kit = createKit(group, 'fire', [
    ['lobe', 'fire-lobe-v2.png', true], ['tongue', 'flame-tongue.png'], ['density', 'flame-density.png'], ['boom', 'explosion-density.png'],
    ['smoke', 'smoke-puff.png'], ['glow', 'glow.png'], ['spark', 'spark.png'], ['star', 'star-flare.png'], ['spike', 'spike-burst.png'],
    ['diamond', 'pk-diamond.png'], ['ring', 'shock-ring.png'],
  ], { label: 'Fire' });
  const shape = new THREE.Shape();
  [[-.5, .2], [.42, .05], [.02, .03], [.5, -.2], [-.42, -.05], [-.02, -.03]].forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y)); shape.closePath();
  const geometries = { bolt: new THREE.ExtrudeGeometry(shape, { depth: .05, bevelEnabled: false }).translate(0, 0, -.025), sphere: new THREE.SphereGeometry(1, 40, 28) };
  const meshMaterial = side => new THREE.ShaderMaterial({ ...blend, side, vertexShader: MVS, fragmentShader: MFS,
    uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 1 }, uTime: { value: 0 }, uKind: { value: 0 }, uSeed: { value: 0 }, uI: { value: 1 } } });
  let time = 0, previewTime = 0, sequence = 0;
  const shots = new Map(), events = [], previews = [];
  const previewState = { paused: false, speed: 1, tier: null, age: 0 };
  const point = V(), dir = V(), up = V(), side = V(), basis = new THREE.Matrix4(), UP = V(0, 1, 0);
  const at = (p, x = 0, y = 0, z = 0) => point.set(p.x + x * SCALE, p.y + y * SCALE, p.z + z * SCALE);
  const S = (tex, p, w, h, o) => kit.sprite(tex, p, w * SCALE, h * SCALE, o);

  function mesh(kind, p, scale, { color = [1, 1, 1], opacity = 1, style = 0, t = 0, seed = 0, intensity = 1, back = false } = {}) {
    const m = kit.mesh(kind + (back ? '-b' : ''), () => { const m = new THREE.Mesh(geometries[kind], meshMaterial(back ? THREE.DoubleSide : THREE.FrontSide)); m.renderOrder = kind === 'sphere' ? 3 : 7; return m; },
      p, Array.isArray(scale) ? scale.map(v => v * SCALE) : scale * SCALE);
    const u = m.material.uniforms; u.uColor.value.setRGB(...color); u.uOpacity.value = opacity; u.uKind.value = style; u.uTime.value = t; u.uSeed.value = seed; u.uI.value = intensity;
    return m;
  }
  const glow = (p, size, opacity = 1, color = [1, .3, .02], intensity = 1.6) => S('glow', p, size, size, { opacity, intensity, color, ramp: RAMP.flat, occ: 0 });
  function embers(p, t, count, size, seed, { up = .5, life = .7, color = [1, .55, .08] } = {}) {
    for (let i = 0; i < count; i++) {
      const j = i + seed * 97, l = life * (.45 + rand(j + 3) * .55); if (t < 0 || t > l) continue;
      const a = rand(j) * TAU, y = rand(j + 1) * 1.6 - .6, r = Math.sqrt(Math.max(0, 1 - y * y)), sp = (.6 + rand(j + 2) * 2.2) * size;
      dir.set(Math.cos(a) * r, y, Math.sin(a) * r);
      at(p, dir.x * sp * t, dir.y * sp * t + up * t * t, dir.z * sp * t);
      S('spark', point, .022 * size, (.07 + sp * .05) * size, { opacity: fade(t, l, .25), intensity: 2.4, color, ramp: RAMP.flat, occ: 0, axis: dir });
    }
  }

  // ---- projectiles ----
  function head(tier, p, d, t, seed) {
    dir.copy(d).normalize();
    if (tier === 'small') {
      // PK Fire: a flat, glowing zig-zag laid along the flight path, slightly rolled, with two fading afterimages
      side.crossVectors(dir, UP); if (side.lengthSq() < .001) side.set(0, 0, 1); side.normalize(); up.crossVectors(side, dir).normalize();
      basis.makeBasis(dir, up, side);
      const roll = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -.35);
      for (let k = 2; k >= 0; k--) {
        const m = mesh('bolt', point.copy(p).addScaledVector(dir, -k * .1 * SCALE), [.62, .62, .62], { color: k ? [1, .8, .1] : [1, .93, .32], opacity: k ? .32 / k : 1, intensity: k ? 1.4 : 2.1 });
        m.quaternion.setFromRotationMatrix(basis).multiply(roll);
      }
      glow(p, .75, .55, [1, .78, .1]); glow(p, .3, .7, [1, .97, .7]);
      kit.ribbon(point.copy(p).addScaledVector(dir, -.12 * SCALE), V().copy(p).addScaledVector(dir, -.55 * SCALE), .06 * SCALE, .005, { color: [1, .75, .1], opacity: .55, intensity: 1.4, ends: .3 });
      return;
    }
    // Firaga: noisy fire sphere, hot core, swirling flame lobes, tongues streaming backwards
    mesh('sphere', p, .2, { style: 1, t: t * 1.4, seed: seed * 3.1, intensity: 1.25 }).rotation.y = t * 2;
    glow(p, 1.05, .45, [1, .3, .02]); glow(p, .38, .85, [1, .9, .55], 1.8);
    for (let i = 0; i < 10; i++) {
      const a = i * 2.399 + t * 6, y = Math.sin(i * 1.7 + t * 4) * .7, r = .13;
      at(p, Math.cos(a) * r * Math.sqrt(1 - y * y), y * r, Math.sin(a) * r * Math.sqrt(1 - y * y));
      S('lobe', point, .3, .36, { opacity: .8, intensity: 1.2, ramp: RAMP.texture, occ: .7, rot: a * 1.3, flip: i % 2 });
    }
    up.copy(dir).negate();
    for (let i = 0; i < 7; i++) {
      const j = seed * 13 + i, a = i / 7 * TAU + t * 3, f = .85 + .3 * Math.sin(t * 23 + i * 2.1);
      at(p, -dir.x * .16 + Math.cos(a) * .06, -dir.y * .16 + Math.sin(a) * .07, -dir.z * .16 + Math.sin(a + 1) * .06);
      S('tongue', point, .26, .5 * f, { opacity: .75, intensity: 1.3, ramp: RAMP.fire, heat: 1, occ: .6, axis: up, rot: (rand(j) - .5) * .5, flip: i % 2 });
    }
  }
  function trail(s, t) {
    if (s.tier === 'small') return;
    // History is sampled at a fixed 60 Hz, independently of the draw rate.
    up.copy(s.dir).negate();
    for (let i = 0; i < s.history.length; i++) {
      const h = s.history[i], age = t - h.at; if (age < 0 || age > .42) continue;
      const j = i + s.seed * 91, u = age / .42;
      point.copy(h.p); point.y += age * (.3 + rand(j) * .4) * SCALE; point.z += (rand(j + 2) - .5) * age * .5 * SCALE; point.x += (rand(j + 5) - .5) * age * .3 * SCALE;
      S(i % 3 ? 'density' : 'lobe', point, .42 * (1 - u * .55), .5 * (1 - u * .4), { opacity: Math.pow(1 - u, 1.2) * .8, intensity: 1.2,
        ramp: i % 3 ? RAMP.fire : RAMP.texture, heat: 1.1 - u * .75, occ: .65, axis: i % 3 ? up : null, rot: rand(j) * TAU, flip: i % 2 });
      if (i % 4 === 0 && age > .05) { at(h.p, (rand(j + 7) - .5) * .25, (rand(j + 8) - .3) * .25 + age * .5, (rand(j + 9) - .5) * .25);
        S('spark', point, .02, .06, { opacity: 1 - u, intensity: 2.4, color: [1, .6, .1], ramp: RAMP.flat, occ: 0 }); }
    }
  }

  // ---- impacts ----
  function pkPillar(p, t, seed) {
    const end = FIRE_LIFETIME.small, env = rise(t, 0, .1) * fade(t, end, .5), base = -.72, H = 1.9;
    if (t < .16) { const f = fade(t, .16, .12); S('star', at(p), 1.3, 1.3, { opacity: f, intensity: 2, color: [1, .92, .7], ramp: RAMP.tint, occ: 0, rot: .2 });
      glow(p, 1.1, f, [1, .7, .5], 2); S('spike', at(p), .7 * easeOut(t, 20), .7 * easeOut(t, 20), { opacity: f * .8, intensity: 1.6, color: [1, .95, .55], occ: 0, rot: seed }); }
    // flame tongues born continuously at the base, rising, narrowing and cooling toward crimson at the top
    const N = 44, T = .5;
    for (let i = 0; i < N; i++) {
      const j = seed * 31 + i, ph = rand(j) * T, a = (t + ph) % T, born = t - a; if (born < 0 || born > end - .35) continue;
      const u = a / T, ang = rand(j + 1) * TAU, rr = (.1 + rand(j + 2) * .2) * (1 - u * .4);
      at(p, Math.cos(ang) * rr, base + u * H * (.75 + rand(j + 3) * .3), Math.sin(ang) * rr);
      const w = (.44 - u * .16) * (.8 + rand(j + 4) * .4), flick = .85 + .2 * Math.sin(t * 31 + i);
      S('tongue', point, w, w * 1.7 * flick, { opacity: Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), .55) * env * .9, intensity: 1.35, ramp: RAMP.crimson,
        heat: (1.02 - u * .62) * (.85 + .3 * rand(j + 6)), occ: .8, rot: (rand(j + 5) - .5) * .35, flip: i % 2 });
    }
    // hot white core and a bright base
    const fl = .9 + .1 * Math.sin(t * 37) * Math.sin(t * 13);
    S('glow', at(p, 0, base + H * .4, 0), .5, H * .8, { opacity: env * .75 * fl, intensity: 1.6, color: [1, .86, .62], ramp: RAMP.flat, occ: .25 });
    for (let i = 0; i < 5; i++) { const a = i * 1.26 + t * 2; S('density', at(p, Math.cos(a) * .1, base + .15, Math.sin(a) * .1), .6, .55, { opacity: env * .75, intensity: 1.3, ramp: RAMP.crimson, heat: .95, occ: .75, rot: a, flip: i % 2 }); }
    // dark crimson smoke rolling off the top
    for (let i = 0; i < 12; i++) {
      const j = seed * 17 + i, P = .9, a = (t + rand(j) * P) % P, born = t - a; if (born < .08) continue;
      const u = a / P, s = .42 + u * .5;
      at(p, (rand(j + 1) - .5) * .5 + (rand(j + 3) - .5) * u * .3, base + H * .82 + u * .55, (rand(j + 2) - .5) * .4);
      S('smoke', point, s, s * .9, { opacity: Math.sin(Math.PI * u) * .7 * env, intensity: 1, color: [.36, .05, .08], ramp: RAMP.smoke, occ: .85, rot: rand(j) * TAU + u, flip: i % 2 });
    }
    // PK diamonds ◆ floating up around the pillar
    for (let i = 0; i < 9; i++) {
      const j = seed * 7 + i, born = .04 + rand(j) * .7, age = t - born; if (age < 0) continue;
      const ang = rand(j + 1) * TAU, rr = .28 + rand(j + 2) * .2, s = (.1 + rand(j + 3) * .07) * (.8 + .3 * Math.sin(t * 17 + i * 2));
      at(p, Math.cos(ang) * rr, base + .35 + rand(j + 4) * H * .85 + age * .22, Math.sin(ang) * rr);
      S('diamond', point, s * .62, s, { opacity: rise(age, 0, .06) * fade(t, end, .4) * (.75 + .25 * Math.sin(t * 25 + i)), intensity: 2, color: [1, .92, .3], ramp: RAMP.tint, occ: .3 });
    }
    embers(p, t % .8, 10, .7, seed + Math.floor(t / .8), { up: 1.4, life: .8, color: [1, .45, .2] });
  }
  function firagaHit(p, t, seed) {
    // white-yellow star flash + comic burst, then flame puffs blown outward that cool and cling briefly
    if (t < .18) { const f = fade(t, .18, .14), k = easeOut(t, 25);
      S('star', at(p), 1.7 * k, 1.7 * k, { opacity: f, intensity: 2.1, color: [1, .95, .75], occ: 0, rot: .4 + seed });
      S('spike', at(p), .95 * k, .95 * k, { opacity: f * .9, intensity: 1.7, color: [1, .82, .25], occ: .2, rot: seed * 2 });
      glow(p, 1.4, f, [1, .7, .3], 2); }
    if (t < .32) { const k = easeOut(t, 9); S('ring', at(p), .3 + 1.3 * k, .3 + 1.3 * k, { opacity: fade(t, .32, .2) * .4, intensity: 1.4, color: [1, .6, .15], occ: 0 }); }
    for (let i = 0; i < 12; i++) {
      const j = seed * 23 + i, a = i * 2.399, y = rand(j) * 1.6 - .8, r = Math.sqrt(1 - y * y), k = easeOut(t, 8), d = .35 * k * (.7 + rand(j + 1) * .6);
      at(p, Math.cos(a) * r * d, y * d * .8 + t * t * .6, Math.sin(a) * r * d);
      const s = .35 + .45 * k;
      S('boom', point, s, s, { opacity: fade(t, .62, .35) * .85, intensity: 1.3, ramp: RAMP.fire, heat: 1.3 - t * 1.4, occ: .8, rot: rand(j + 2) * TAU + t, flip: i % 2 });
    }
    for (let i = 0; i < 8; i++) {
      const j = seed * 29 + i, a = i * .785 + rand(j) * .5, k = easeOut(t, 10), d = .3 + .25 * k;
      at(p, Math.cos(a) * d * .9, Math.sin(a) * d * .7, Math.sin(a * 2.3) * .2);
      S('lobe', point, .38, .44, { opacity: fade(t, .5, .25) * .9, intensity: 1.25, ramp: RAMP.texture, occ: .7, rot: a + t * 2, flip: i % 2 });
    }
    // clinging flames on the target
    for (let i = 0; i < 10; i++) {
      const j = seed * 37 + i, P = .3, a = (t + rand(j) * P) % P, born = t - a; if (born < .12) continue;
      const u = a / P; at(p, (rand(j + 1) - .5) * .4, (rand(j + 2) - .6) * .5 + u * .3, (rand(j + 3) - .5) * .3);
      S('tongue', point, .2, .36, { opacity: Math.sin(Math.PI * u) * fade(t, .85, .3), intensity: 1.3, ramp: RAMP.fire, heat: 1 - u * .5, occ: .6, flip: i % 2 });
    }
    glow(p, 1.3, fade(t, .55, .4) * .4, [1, .32, .03]);
    embers(p, t, 26, 1, seed);
  }
  function explosiveFlame(p, t, seed) {
    const BURST = 1.0, end = FIRE_LIFETIME.large;
    // a small spark first
    if (t < .14) { const f = fade(t, .14, .08); S('star', at(p), .9, .9, { opacity: f, intensity: 2, color: [1, .9, .55], occ: 0 }); glow(p, .5, f, [1, .8, .4], 2); }
    // the sphere: overshooting growth, a slow pulse, swelling as it bursts
    const g = easeOut(t - .03, 11), R = .95 * g * (1 + .05 * Math.exp(-6 * t) * Math.sin(t * 30)) * (1 + .02 * Math.sin(t * 9)) * (1 + .3 * rise(t, BURST, BURST + .18));
    const hold = rise(t, .03, .1) * fade(t, BURST + .16, .16);
    if (hold > 0 && R > .02) {
      mesh('sphere', p, R, { style: 2, t, seed: seed * 1.7, opacity: hold, intensity: 1 }).rotation.y = t * .5;
      mesh('sphere', p, R * 1.13, { style: 3, t, seed: seed * 2.3 + 4, opacity: hold, intensity: 1.2 }).rotation.y = -t * .3;
      S('ring', at(p), R * 2.34, R * 2.34, { opacity: hold * .35, intensity: 1.4, color: [1, .55, .12], occ: 0 });
      // the big lens star in the middle, slowly turning, flickering
      const tw = 1 + .08 * Math.sin(t * 41) + .05 * Math.sin(t * 17);
      S('star', at(p), R * 2.5 * tw, R * 2.5 * tw, { opacity: hold, intensity: 1.9, color: [1, .97, .88], occ: .1, rot: .12 + t * .25 });
      S('star', at(p), R * 1.5 * tw, R * 1.5 * tw, { opacity: hold * .6, intensity: 1.8, color: [1, .9, .65], occ: 0, rot: .12 + Math.PI / 8 - t * .4 });
      glow(p, R * .55, hold * .9, [1, .92, .75], 2);
      glow(p, R * 3, hold * .18, [1, .3, .02]);
      // flames licking up off the top half
      for (let i = 0; i < 14; i++) {
        const j = seed * 41 + i, P = .45, a = (t + rand(j) * P) % P, u = a / P, ang = rand(j + 1) * TAU, el = .25 + rand(j + 2) * .9;
        dir.set(Math.cos(ang) * Math.cos(el), Math.sin(el), Math.sin(ang) * Math.cos(el));
        point.copy(p).addScaledVector(dir, R * (.95 + u * .25)); point.y += u * .25 * SCALE;
        S('tongue', point, .3 * R + .05, .55 * R + .1, { opacity: Math.sin(Math.PI * u) * hold * .85, intensity: 1.3, ramp: RAMP.fire, heat: 1 - u * .5, occ: .6, axis: UP, rot: (dir.x) * -.6, flip: i % 2 });
      }
    }
    // the burst: flame clumps thrown off the surface, a flash, then dark smoke and falling embers
    const b = t - BURST;
    if (b > -.04) {
      if (b < .14) { const f = fade(b, .14, .1); S('star', at(p), 3.2, 3.2, { opacity: f, intensity: 2, color: [1, .9, .7], occ: 0, rot: .5 }); glow(p, 1.6, f * .8, [1, .55, .2], 1.8); }
      for (let i = 0; i < 26; i++) {
        const j = seed * 61 + i, y = 1 - 2 * (i + .5) / 26, a = i * 2.399, r = Math.sqrt(1 - y * y), k = easeOut(b + .04, 6), d = .95 * (.75 + .5 * k * (.6 + rand(j) * .8));
        at(p, Math.cos(a) * r * d, y * d * .85 + b * b * .5, Math.sin(a) * r * d);
        const s = .5 + .55 * k;
        S(i % 3 ? 'boom' : 'lobe', point, s, s, { opacity: rise(b, -.04, .04) * fade(b, .6, .35) * .9, intensity: 1.2, ramp: i % 3 ? RAMP.fire : RAMP.texture, heat: 1.05 - b * 1.4, occ: .85, rot: rand(j + 1) * TAU + b, flip: i % 2 });
      }
      for (let i = 0; i < 16; i++) {
        const j = seed * 71 + i, born = .08 + rand(j) * .2, age = b - born; if (age < 0) continue;
        const y = rand(j + 1) * 1.4 - .4, a = rand(j + 2) * TAU, r = Math.sqrt(Math.max(0, 1 - y * y)), d = .45 + rand(j + 5) * .3 + age * .35;
        at(p, Math.cos(a) * r * d, y * d * .8 + age * .45, Math.sin(a) * r * d);
        const s = .62 + age * .6;
        S('smoke', point, s, s, { opacity: rise(age, 0, .1) * fade(t, end, .5) * .8, intensity: 1, color: [.13, .08, .06], ramp: RAMP.smoke, occ: .9, rot: rand(j + 3) * TAU + age * .5, flip: i % 2 });
        if (i % 2 === 0) S('lobe', point, s * .6, s * .6, { opacity: fade(age, .35, .25) * .7, intensity: 1.2, ramp: RAMP.texture, occ: .4, rot: rand(j + 4) * TAU });
      }
      embers(p, b, 50, 1.6, seed, { up: -1.2, life: .85 });
    }
  }
  function impact(tier, p, t, seed) {
    if (t < 0 || t > FIRE_LIFETIME[tier]) return;
    if (tier === 'small') pkPillar(p, t, seed); else if (tier === 'medium') firagaHit(p, t, seed); else explosiveFlame(p, t, seed);
  }
  function addHit(tier, p, preview = false) { const e = { tier, p: p.clone(), at: preview ? previewTime : time, seed: ++sequence, preview }; events.push(e); if (events.length > 64) events.shift(); onShake(tier === 'large' ? .65 : tier === 'medium' ? .25 : .16); }
  return {
    shot(id, pos, d, power) { const tier = fireTier(power); shots.set(id, { tier, p: pos.clone(), dir: d.clone().normalize(), seed: ++sequence, history: [], next: time, at: time }); },
    moveShot(id, p) { const s = shots.get(id); if (!s) return; s.p.copy(p); if (time >= s.next) { s.history.push({ p: p.clone(), at: time }); s.next = time + 1 / 60; } },
    endShot(id) { shots.delete(id); },
    hit(pos, power) { addHit(fireTier(power), pos); },
    special(from, to) { addHit('large', to); },
    preview(tier, from, to, getTarget = null) {
      if (!FIRE_TIERS.includes(tier)) return;
      previews.length = 0; previewTime = 0; previewState.paused = false; previewState.tier = tier;
      previews.push({ tier, from: from.clone(), to: to.clone(), dir: to.clone().sub(from).normalize(), seed: ++sequence, history: [], at: 0, getTarget, impactPoint: null });
    },
    previewControl({ paused, speed, step } = {}) { if (paused !== undefined) previewState.paused = !!paused; if (speed !== undefined) previewState.speed = clamp(speed); if (step) { previewState.paused = true; previewTime += Math.min(.1, Math.max(0, step)); } },
    step(dt) {
      time += dt; if (!previewState.paused) previewTime += dt * previewState.speed; previewState.age = previewTime;
      kit.begin();
      for (const s of shots.values()) { head(s.tier, s.p, s.dir, time - s.at, s.seed); s.history = s.history.filter(h => time - h.at < .45); trail(s, time); }
      for (let i = events.length - 1; i >= 0; i--) { const e = events[i], age = (e.preview ? previewTime : time) - e.at; if (age > FIRE_LIFETIME[e.tier]) events.splice(i, 1); else impact(e.tier, e.p, age, e.seed); }
      for (const s of previews) {
        const q = firePreviewSample(s.tier, previewTime);
        if (!previewState.paused && !s.impactPoint && s.getTarget) { const p = s.getTarget(); if (p) s.to.copy(p); s.dir.copy(s.to).sub(s.from).normalize(); }
        if (!s.impactPoint && q.impactAge >= 0) s.impactPoint = s.to.clone();
        if (q.flying) {
          const p = s.from.clone().lerp(s.to, q.progress); head(s.tier, p, s.dir, previewTime, s.seed);
          if (s.tier === 'medium') { const history = []; for (let age = 0; age < .42; age += 1 / 60) { const born = previewTime - age; if (born < 0) continue; history.push({ p: s.from.clone().lerp(s.to, clamp(born / .46)), at: born }); } trail({ ...s, history }, previewTime); }
        }
        if (q.alive) impact(s.tier, s.impactPoint ?? s.to, q.impactAge, s.seed);
      }
      kit.end();
    },
    get active() { return group.visible; },
    stats() { return { particles: kit.count, shots: shots.size, events: events.length, loaded: [...kit.loaded], errors: [...kit.errors], total: kit.total, preview: { ...previewState } }; },
    dispose() { scene.remove(group); kit.dispose(); Object.values(geometries).forEach(g => g.dispose()); },
  };
}
