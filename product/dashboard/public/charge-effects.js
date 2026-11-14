// Charging around the player's body. The stick itself glows in field3d.js.
//  body: thin vertical light pillars rising around the player, squiggly element-coloured wisps round the legs, dust puffing
//        off the floor, a floor ring; denser and brighter as the charge grows, pulsing once it is full
import * as THREE from 'three';
import { createKit, RAMP, TAU, V, rand, blend } from './effect-kit.js';

const PALETTE = {
  fire: { pillar: [[1, .72, .08], [1, .38, .03], [1, .9, .55]], wisp: [1, .42, .06], glow: [1, .5, .1],
    shell: [1, .32, .04], rim: [1, .82, .4], bolt: [1, .68, .1], core: [1, .95, .75] },
  thunder: { pillar: [[1, .85, .12], [1, .7, .05], [1, .97, .7]], wisp: [1, .78, .2], glow: [1, .75, .2],
    shell: [1, .8, .15], rim: [1, .98, .8], bolt: [1, .95, .4], core: [1, 1, 1] },
  water: { pillar: [[.12, .45, 1], [.05, .22, .85], [.6, .9, 1]], wisp: [.1, .42, 1], glow: [.15, .45, 1],
    shell: [.04, .25, .9], rim: [.55, .88, 1], bolt: [.4, .8, 1], core: [.85, .97, 1] },
  wind: { pillar: [[.85, .95, .96], [.55, .85, .88], [1, 1, 1]], wisp: [.75, .92, .92], glow: [.6, .82, .85],
    shell: [.5, .75, .78], rim: [.95, 1, 1], bolt: [.9, .97, 1], core: [1, 1, 1] },
};
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
  const geometries = { plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2) };
  const states = new Map(); let time = 0, sequence = 0;
  const point = V();
  const glow = (p, w, h, opacity, color, intensity = 1.4, occ = 0) => kit.sprite('glow', p, w, h, { opacity, intensity, color, ramp: RAMP.flat, occ });
  const floorRing = (p, r, opacity, color) => {
    const m = kit.mesh('ring', () => { const m = new THREE.Mesh(geometries.plane, new THREE.ShaderMaterial({ ...blend, vertexShader: RVS, fragmentShader: RFS,
      uniforms: { uMap: { value: kit.texture('ring') }, uColor: { value: new THREE.Color() }, uOpacity: { value: 1 } } })); m.renderOrder = 4; return m; }, p, [r * 2, 1, r * 2]);
    m.material.uniforms.uColor.value.setRGB(...color); m.material.uniforms.uOpacity.value = opacity;
  };

  // on the ground (y = 0) under the chest: the chest passed in is the shrunk character's, so chest - CHEST_H put it under the floor
  function body(s, L, P, full) {
    const c = s.chest, floor = 0, boost = full ? 1 + .35 * Math.max(0, Math.sin(time * 9 + s.seed)) : 1;
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

  return {
    request(element, chest, tip, level, key = element) { let s = states.get(key); if (!s) { s = { element, chest: V(), tip: V(), level: 0, seen: 0, seed: ++sequence }; states.set(key, s); } s.element = element; s.chest.copy(chest); s.tip.copy(tip); s.level = Math.max(0, Math.min(1, level)); s.seen = time; },
    step(dt) {
      time += dt; kit.begin();
      for (const [key, s] of states) {
        if (time - s.seen > .18) { states.delete(key); continue; }
        const P = PALETTE[s.element] ?? PALETTE.thunder, full = s.level >= .999;
        body(s, s.level, P, full);
      }
      kit.end();
    },
    get active() { return group.visible; },
    stats() { return { states: states.size, particles: kit.count, loaded: [...kit.loaded], errors: [...kit.errors], total: kit.total }; },
    dispose() { scene.remove(group); kit.dispose(); Object.values(geometries).forEach(g => g.dispose()); },
  };
}
