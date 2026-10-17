// Charging, after Cloud's Limit Charge (body) and Kirby's Spark ball (wand tip).
//  body: thin vertical light pillars rising around the player, squiggly element-coloured wisps round the legs, dust puffing
//        off the floor, a floor ring; denser and brighter as the charge grows, pulsing once it is full
//  tip:  a translucent sphere with a bright rim, a saw-tooth corona, a star inside and jagged bolts crackling outward
import * as THREE from 'three';
import { createKit, RAMP, TAU, V, rand, blend } from './effect-kit.js';
import { CHEST_H } from './world.js';

const PALETTE = {
  fire: { pillar: [[1, .72, .08], [1, .38, .03], [1, .9, .55]], wisp: [1, .42, .06], glow: [1, .5, .1],
    shell: [1, .32, .04], rim: [1, .82, .4], bolt: [1, .68, .1], core: [1, .95, .75] },
  thunder: { pillar: [[1, .85, .12], [.15, .75, 1], [.75, 1, 1]], wisp: [.3, .65, 1], glow: [.55, .85, 1],
    shell: [.2, .78, 1], rim: [.82, 1, 1], bolt: [.85, 1, .25], core: [1, 1, 1] },
};
const SVS = `varying vec3 vP,vN,vEye;void main(){vP=position;vec4 p=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vEye=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`;
// Spark ball shell: see-through tint inside, a bright rim, faint moving bands
const SFS = `varying vec3 vP,vN,vEye;uniform vec3 uShell,uRim;uniform float uOpacity,uTime;
void main(){float rim=1.-abs(dot(normalize(vN),normalize(vEye)));float band=.5+.5*sin(vP.y*9.+vP.x*5.-uTime*7.);
 float line=smoothstep(.72,.96,rim);vec3 c=mix(uShell*(.7+.3*band),uRim*1.15,line);float a=mix(.38,1.,smoothstep(.45,.95,rim))*uOpacity;
 gl_FragColor=vec4(c*a,a*.6);}`;
// Floor ring: the shock-ring texture on a horizontal plane
const RVS = `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const RFS = `varying vec2 vUv;uniform sampler2D uMap;uniform vec3 uColor;uniform float uOpacity;
void main(){vec4 s=texture2D(uMap,vUv);float a=s.a*uOpacity;if(a<.004)discard;gl_FragColor=vec4(uColor*(.5+s.r)*a,a*.2);}`;

export function createChargeEffects(scene) {
  const group = new THREE.Group(); group.name = 'charge-effects'; scene.add(group);
  const kit = createKit(group, 'charge', [
    ['aura', 'aura-wisp.png'], ['filament', 'electric-filament.png'], ['glow', 'glow.png'], ['spark', 'spark.png'], ['smoke', 'smoke-puff.png'],
    ['star', 'star-flare.png'], ['spike', 'spike-burst.png'], ['corona', 'spark-corona.png'], ['ring', 'shock-ring.png'],
  ], { label: 'Charge' });
  const geometries = { sphere: new THREE.SphereGeometry(1, 32, 20), plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2) };
  const states = new Map(); let time = 0, sequence = 0;
  const point = V(), axis = V(), UP = V(0, 1, 0);
  const glow = (p, w, h, opacity, color, intensity = 1.4, occ = 0) => kit.sprite('glow', p, w, h, { opacity, intensity, color, ramp: RAMP.flat, occ });
  const floorRing = (p, r, opacity, color) => {
    const m = kit.mesh('ring', () => { const m = new THREE.Mesh(geometries.plane, new THREE.ShaderMaterial({ ...blend, vertexShader: RVS, fragmentShader: RFS,
      uniforms: { uMap: { value: kit.texture('ring') }, uColor: { value: new THREE.Color() }, uOpacity: { value: 1 } } })); m.renderOrder = 4; return m; }, p, [r * 2, 1, r * 2]);
    m.material.uniforms.uColor.value.setRGB(...color); m.material.uniforms.uOpacity.value = opacity;
  };

  function body(s, L, P, full) {
    const c = s.chest, floor = c.y - CHEST_H, boost = full ? 1 + .35 * Math.max(0, Math.sin(time * 9 + s.seed)) : 1;
    // light pillars: thin vertical streaks on a cylinder round the body, each one rising and fading on its own cycle
    const pillars = 8 + Math.round(16 * L);
    for (let i = 0; i < pillars; i++) {
      const j = s.seed * 97 + i * 13, per = .45 + rand(j) * .5, u = ((time + rand(j + 1) * per) / per) % 1, cyc = Math.floor((time + rand(j + 1) * per) / per);
      const a = rand(j + 2 + cyc * 7) * TAU, r = .14 + rand(j + 3 + cyc * 5) * (.3 + .1 * L), h = (.7 + rand(j + 4) * 1.1) * (.7 + .5 * L);
      const y0 = floor + .02 + u * (.7 + .5 * L), x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      const w = (.016 + rand(j + 5) * .03) * (.8 + .6 * L), col = P.pillar[i % 3];
      kit.ribbon(point.set(x, y0, z), V(x, y0 + h, z), w, w * .6, { color: col, intensity: 1.3 * boost, core: .22, opacity: Math.sin(Math.PI * u) ** .7 * (.45 + .55 * L), occ: .12, ends: .35 });
    }
    // a soft column of light behind the body and a glow on the floor
    glow(point.set(c.x, floor + .95, c.z), 1.1 + .4 * L, 2.4 + .2 * L, (.14 + .22 * L) * boost, P.glow, 1.1);
    glow(point.set(c.x, floor + .05, c.z), 1.1 + .4 * L, .35, (.18 + .3 * L) * boost, P.glow, 1.3);
    // squiggly wisps round the legs
    const wisps = 4 + Math.round(8 * L);
    for (let i = 0; i < wisps; i++) {
      const j = s.seed * 31 + i * 17, per = .5 + rand(j) * .4, u = ((time + rand(j + 1) * per) / per) % 1, cyc = Math.floor((time + rand(j + 1) * per) / per);
      const a = rand(j + 2 + cyc * 3) * TAU, r = .26 + rand(j + 3) * .2;
      point.set(c.x + Math.cos(a) * r, floor + .2 + u * .65 + rand(j + 4) * .2, c.z + Math.sin(a) * r);
      kit.sprite(s.element === 'thunder' ? 'filament' : 'aura', point, .16 + .06 * L, .5 + .2 * L, { opacity: Math.sin(Math.PI * u) * (.5 + .4 * L), intensity: 1.5, color: P.wisp, occ: .1, rot: (rand(j + 5) - .5) * .8, flip: cyc % 2 });
    }
    // dust puffing outward off the floor
    const puffs = 5 + Math.round(5 * L);
    for (let i = 0; i < puffs; i++) {
      const j = s.seed * 53 + i * 11, per = .7 + rand(j) * .3, u = ((time + rand(j + 1) * per) / per) % 1, cyc = Math.floor((time + rand(j + 1) * per) / per);
      const a = i / puffs * TAU + rand(j + 2 + cyc) * .6, r = .3 + u * (.35 + .2 * L), sz = .3 + u * .35;
      kit.sprite('smoke', point.set(c.x + Math.cos(a) * r, floor + .08 + u * .08, c.z + Math.sin(a) * r), sz * 1.3, sz, { opacity: Math.sin(Math.PI * u) ** 1.5 * (.3 + .25 * L), intensity: 1.3, color: [1, 1, 1], ramp: RAMP.smoke, occ: .5, rot: rand(j + 3) * TAU });
    }
    // floor ring, and an expanding one each pulse once full
    floorRing(point.set(c.x, floor + .01, c.z), .5 + .1 * L, .12 + .2 * L, P.pillar[0]);
    if (full) { const ph = (time * 1.6 + s.seed * .3) % 1; floorRing(point.set(c.x, floor + .015, c.z), .4 + 1.1 * ph, (1 - ph) * .8, P.pillar[1]); }
    // twinkles
    const tw = 3 + Math.round(8 * L);
    for (let i = 0; i < tw; i++) {
      const j = s.seed * 71 + i * 5, per = .35 + rand(j) * .3, u = ((time + rand(j + 1) * per) / per) % 1, cyc = Math.floor((time + rand(j + 1) * per) / per);
      const a = rand(j + 2 + cyc * 9) * TAU, r = .2 + rand(j + 3 + cyc) * .35, sz = (.08 + rand(j + 4) * .1) * Math.sin(Math.PI * u);
      kit.sprite('star', point.set(c.x + Math.cos(a) * r, floor + .2 + rand(j + 5 + cyc * 2) * 1.6, c.z + Math.sin(a) * r), sz, sz, { opacity: .9, intensity: 1.8, color: P.pillar[2], occ: 0, rot: rand(j + 6) });
    }
  }

  function tip(s, L, P, full) {
    const p = s.tip, f = Math.floor(time * 15), pulse = 1 + (full ? .07 * Math.sin(time * 20 + s.seed) : .025 * Math.sin(time * 9 + s.seed)), r = (.06 + .15 * L) * pulse;
    glow(p, r * 4, r * 4, .22 + .12 * L, P.shell, 1.1);
    const m = kit.mesh('sphere', () => { const m = new THREE.Mesh(geometries.sphere, new THREE.ShaderMaterial({ ...blend, side: THREE.FrontSide, vertexShader: SVS, fragmentShader: SFS,
      uniforms: { uShell: { value: new THREE.Color() }, uRim: { value: new THREE.Color() }, uOpacity: { value: 1 }, uTime: { value: 0 } } })); m.renderOrder = 3; return m; }, p, r);
    const u = m.material.uniforms; u.uShell.value.setRGB(...P.shell); u.uRim.value.setRGB(...P.rim); u.uOpacity.value = .95; u.uTime.value = time; m.rotation.y = time * 1.5;
    // star burst inside and a small hot core
    kit.sprite('star', p, r * 2.2, r * 2.2, { opacity: .85, intensity: 1.3, color: P.core, occ: 0, rot: time * 1.2 });
    kit.sprite('spike', p, r * .8, r * .8, { opacity: .45, intensity: 1.1, color: P.core, occ: .1, rot: f * .7 });
    glow(p, r * .6, r * .6, .7, P.core, 1.3);
    // saw-tooth corona, flickering between two angles
    const cs = r * 2 / .66 * 1.02;
    kit.sprite('corona', p, cs, cs, { opacity: .95, intensity: 1.15 - .2 * L, color: P.rim, occ: .2, rot: (f % 2) * .09 + time * .6 });
    if (L > .25) kit.sprite('corona', p, cs * 1.12, cs * 1.12, { opacity: .3 * L, intensity: 1.1, color: P.shell, occ: 0, rot: -time * .8 + .05 });
    // jagged bolts out of the surface; a few long ones once charged
    const n = 3 + Math.round(5 * L);
    for (let i = 0; i < n; i++) {
      const j = s.seed * 37 + i * 7 + f * 131, a = rand(j) * TAU, z = rand(j + 1) * 2 - 1, rr = Math.sqrt(1 - z * z), long = i < Math.round(3 * L);
      axis.set(Math.cos(a) * rr, z, Math.sin(a) * rr);
      const from = point.copy(p).addScaledVector(axis, r * .95).clone(), to = V().copy(p).addScaledVector(axis, r + (long ? .22 + .45 * L : r * (.8 + rand(j + 2) * 1.2)));
      kit.bolt(from, to, j, { jag: .3, count: long ? 7 : 5, w: (long ? .022 : .013) * (.7 + .5 * L), w1: .003, color: P.bolt, intensity: 1.4, core: .25, opacity: .95, branches: long ? .5 : 0, branchLen: .4 });
    }
    // small arcs crawling over the surface
    for (let i = 0; i < 2; i++) {
      const j = s.seed * 19 + i * 3 + f * 17, a = rand(j) * TAU, b = a + .8 + rand(j + 1);
      kit.bolt(V(p.x + Math.cos(a) * r, p.y + (rand(j + 2) - .5) * r, p.z + Math.sin(a) * r), V(p.x + Math.cos(b) * r, p.y + (rand(j + 3) - .5) * r, p.z + Math.sin(b) * r), j,
        { jag: .4, count: 5, w: .008, w1: .004, color: P.rim, intensity: 1.5, core: .5, opacity: .8 });
    }
    // sparks orbiting
    for (let i = 0; i < 4 + Math.round(8 * L); i++) {
      const a = i * 2.399 + time * (2.4 + rand(i + s.seed)), y = Math.sin(i * 1.7 + time * 1.4) * .6;
      axis.set(Math.cos(a), y, Math.sin(a)).normalize(); point.copy(p).addScaledVector(axis, r * (1.3 + .7 * rand(i + s.seed * 3)));
      kit.sprite('spark', point, .014, .06 + .04 * L, { opacity: .8, intensity: 2, color: P.bolt, ramp: RAMP.flat, occ: 0, axis });
    }
    if (full) { const ph = (time * 1.7 + s.seed) % 1, rs = (r * 2.2 + .7 * ph); kit.sprite('ring', p, rs, rs, { opacity: (1 - ph) * .7, intensity: 1.4, color: P.rim, occ: 0 }); }
  }

  return {
    request(element, chest, tip, level, key = element) { let s = states.get(key); if (!s) { s = { element, chest: V(), tip: V(), level: 0, seen: 0, seed: ++sequence }; states.set(key, s); } s.element = element; s.chest.copy(chest); s.tip.copy(tip); s.level = Math.max(0, Math.min(1, level)); s.seen = time; },
    step(dt) {
      time += dt; kit.begin();
      for (const [key, s] of states) {
        if (time - s.seen > .18) { states.delete(key); continue; }
        const P = PALETTE[s.element] ?? PALETTE.thunder, full = s.level >= .999;
        body(s, s.level, P, full); tip(s, s.level, P, full);
      }
      kit.end();
    },
    get active() { return group.visible; },
    stats() { return { states: states.size, particles: kit.count, loaded: [...kit.loaded], errors: [...kit.errors], total: kit.total }; },
    dispose() { scene.remove(group); kit.dispose(); Object.values(geometries).forEach(g => g.dispose()); },
  };
}
