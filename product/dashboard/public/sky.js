// The time of day behind the game screen (screen 3): from the clock (hours, 0–24) to the sun, the moon, the sky's colours and the light.
// Pure numbers, no Three.js: courtyard.js and backdrop.js turn them into uniforms, field3d.js into the avatars' lights. Notes and sources: effect-assets/SKY_TIME_OF_DAY.md.
// Each look keeps its own daytime sky and light (day = 1, every multiplier 1), so the default hour looks exactly as before the clock existed.
// Colours are display colours, as the looks' shaders work in them. Directions point from the ground to the light; world.js frame (y up, the fixed view looks towards -z).

export const DEFAULT_HOUR = 14; // the looks' own afternoon sun: nothing changes until the clock is moved
export const PRESETS = [['朝', 6.4], ['昼', DEFAULT_HOUR], ['夕焼け', 17.6], ['夜', 19.4], ['星空', 0]];

// Keyframes along the day, a straight blend between neighbours (the day wraps at 24).
// day: weight of the look's own daytime sky; hor/mid/zen: the sky low, half way up, overhead; glow: the light around the sun; cloud: lit cloud colour;
// sun: the direct light, times the look's daytime sun; amb: sky and bounce light, times the look's own; haze: far air; stars, lamp: lit windows (0–1).
const K = [
  { h: 0, day: 0, hor: [.07, .10, .20], mid: [.03, .05, .12], zen: [.01, .015, .05], glow: [.10, .12, .22], cloud: [.10, .12, .19], sun: [.24, .33, .62], amb: [.27, .34, .62], haze: [.07, .10, .19], stars: 1, lamp: 1 },
  { h: 4.6, same: 0 },
  { h: 5.4, day: 0, hor: [.50, .42, .55], mid: [.20, .23, .42], zen: [.06, .09, .24], glow: [.85, .48, .45], cloud: [.48, .38, .48], sun: [.42, .42, .62], amb: [.46, .48, .70], haze: [.38, .36, .48], stars: .35, lamp: .8 },
  { h: 6.3, day: 0, hor: [1.0, .68, .50], mid: [.62, .63, .78], zen: [.26, .42, .72], glow: [1.0, .62, .36], cloud: [1.0, .78, .68], sun: [1.02, .66, .44], amb: [.70, .66, .80], haze: [.86, .73, .70], stars: 0, lamp: .25 },
  { h: 7.6, day: .55, hor: [.90, .86, .84], mid: [.58, .72, .90], zen: [.18, .44, .84], glow: [1.0, .82, .62], cloud: [1.0, .94, .88], sun: [1.04, .92, .80], amb: [.92, .90, .94], haze: [.82, .82, .86], stars: 0, lamp: 0 },
  { h: 9, day: 1, hor: [.70, .82, .96], mid: [.30, .55, .90], zen: [.05, .25, .64], glow: [.5, .45, .35], cloud: [1, 1, 1], sun: [1, 1, 1], amb: [1, 1, 1], haze: [.72, .82, .94], stars: 0, lamp: 0 },
  { h: 15.4, same: 5 },
  { h: 16.5, day: .35, hor: [1.0, .84, .62], mid: [.62, .72, .88], zen: [.20, .42, .80], glow: [1.0, .72, .38], cloud: [1.0, .88, .72], sun: [1.12, .90, .62], amb: [.90, .84, .82], haze: [.92, .82, .68], stars: 0, lamp: 0 },
  { h: 17.6, day: 0, hor: [1.0, .52, .24], mid: [.86, .46, .40], zen: [.30, .27, .54], glow: [1.0, .46, .16], cloud: [1.0, .58, .46], sun: [1.10, .66, .40], amb: [.72, .56, .62], haze: [.92, .56, .42], stars: 0, lamp: .35 },
  { h: 18.5, day: 0, hor: [.80, .38, .32], mid: [.40, .24, .42], zen: [.11, .12, .30], glow: [.92, .36, .20], cloud: [.46, .28, .36], sun: [.52, .44, .62], amb: [.50, .44, .62], haze: [.42, .27, .33], stars: .25, lamp: .85 },
  { h: 19.4, day: 0, hor: [.20, .26, .47], mid: [.09, .14, .33], zen: [.03, .05, .16], glow: [.32, .22, .34], cloud: [.16, .18, .29], sun: [.28, .37, .66], amb: [.30, .37, .64], haze: [.13, .17, .31], stars: .7, lamp: 1 },
  { h: 20.6, same: 0 },
].map((k, _, a) => k.same === undefined ? k : { ...a[k.same], h: k.h });
const FIELDS = ['hor', 'mid', 'zen', 'glow', 'cloud', 'sun', 'amb', 'haze'];

const wrap = h => ((h % 24) + 24) % 24;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const RAD = Math.PI / 180, SWEEP = 23.3 * RAD; // the sun's turn per hour: from the front right at dawn, behind the camera at noon, to the front left at dusk

/** The share of the windows lit (0-1) at hour h: all of them come on in broad day (on), where the daylight hides it; from dusk (out) they go out one
 *  by one, the last at midnight; dark until the next day. */
export const WINDOWS = { on: 9, out: 18.6 };
export function windowsLit(h) {
  h = wrap(h);
  if (h < WINDOWS.on) return 0;
  if (h < WINDOWS.out) return 1;
  return (24 - h) / (24 - WINDOWS.out);
}
/** The palette at hour h (no directions). */
export function paletteAt(h) {
  h = wrap(h);
  let i = K.length - 1; while (K[i].h > h) i--;
  const a = K[i], b = K[(i + 1) % K.length], span = wrap(b.h - a.h) || 24, t = wrap(h - a.h) / span;
  const out = { day: lerp(a.day, b.day, t), stars: lerp(a.stars, b.stars, t), lamp: lerp(a.lamp, b.lamp, t), win: windowsLit(h) };
  for (const f of FIELDS) out[f] = a[f].map((v, j) => lerp(v, b[f][j], t));
  return out;
}

/**
 * timeOfDay(h, anchor) -> palette + { sunDir, lightDir, moonDir, sunEl }
 * anchor: the look's own sun ({x, y, z}, normalised) at DEFAULT_HOUR; minEl: the lowest the light may come (rad), so no building or mesa shades the field;
 * sweep: 1 the sun sets on the left of the view, -1 on the right (the canyon's tall wall stands on the left).
 * sunDir: the real sun (below the horizon at night), for the sky. lightDir: what lights and shades the ground: the sun, clamped to minEl;
 * at night the moonlight comes from the anchor's direction, behind the camera, so the players stay lit from the front (an artistic cheat: the moon drawn in the sky stays in front).
 */
export function timeOfDay(h, anchor, { minEl = 28 * RAD, sweep = 1 } = {}) {
  h = wrap(h);
  const p = paletteAt(h);
  const az0 = Math.atan2(anchor.x, anchor.z), sinMax = Math.min(1, anchor.y / Math.sin(Math.PI * (DEFAULT_HOUR - 6) / 12));
  const sinEl = sinMax * Math.sin(Math.PI * (h - 6) / 12), el = Math.asin(sinEl), az = az0 - (h - DEFAULT_HOUR) * SWEEP * sweep;
  const dir = (a, e) => [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
  const sunDir = dir(az, el);
  const lit = dir(az, Math.max(el, Math.min(minEl, Math.asin(anchor.y)))); // never lower than minEl, nor raised above the anchor's own height
  const w = smooth(-.05, .12, sinEl); // dusk and dawn: the light turns from the moon's to the sun's while both are weak
  const night = [anchor.x, anchor.y, anchor.z];
  const lightDir = norm(lit.map((v, j) => lerp(night[j], v, w)));
  const n = wrap(h - 18) / 12; // the moon over the night, in front of the view: rises on the left, sets on the right, beside the gate tower at midnight
  const moonDir = dir((180 + 36 - n * 48) * RAD, (7 + 9 * Math.sin(Math.PI * Math.min(1, n))) * RAD);
  return { ...p, sunDir, sunEl: el, lightDir, moonDir };
}

/** '14:30' for the clock's label */
export const clock = h => { const m = Math.round(wrap(h) * 60) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

// ---- for the shaders: the uniforms (plain arrays: Three.js takes them for vec3) and the GLSL that reads them ----
const U = { uTodDay: 'day', uTodStars: 'stars', uTodLamp: 'lamp', uTodWin: 'win', uTodHor: 'hor', uTodMid: 'mid', uTodZen: 'zen', uTodGlow: 'glow', uTodCloud: 'cloud', uTodSun: 'sun', uTodAmb: 'amb', uTodHaze: 'haze', uTodSunDir: 'sunDir', uTodMoon: 'moonDir' };
/** One set of uniforms, shared by a look's shaders and the field's floor. */
export function todUniforms(t = timeOfDay(DEFAULT_HOUR, { x: 0, y: .5, z: .87 })) {
  const u = {}; for (const k in U) u[k] = { value: Array.isArray(t[U[k]]) ? [...t[U[k]]] : t[U[k]] };
  return u;
}
export function applyTod(u, t) { for (const k in U) u[k].value = Array.isArray(t[U[k]]) ? [...t[U[k]]] : t[U[k]]; }

export const TOD_GLSL = `
uniform float uTodDay, uTodStars, uTodLamp, uTodWin; uniform vec3 uTodHor, uTodMid, uTodZen, uTodGlow, uTodCloud, uTodSun, uTodAmb, uTodHaze, uTodSunDir, uTodMoon;
vec3 todHaze(vec3 dayHaze) { return mix(uTodHaze, dayHaze, uTodDay); }
float todHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float todStars(vec3 d, float time) { // one jittered point a cell, a Gaussian at least a pixel wide, so the stars neither shimmer nor vanish as the view moves
  vec3 p = d * 150., cell = floor(p), f = fract(p) - .5;
  vec3 j = vec3(todHash(cell), todHash(cell + 17.), todHash(cell + 41.)) - .5;
  float pick = todHash(cell + 7.), band = exp(-pow(dot(d, normalize(vec3(.55, .35, .76))) / .22, 2.)); // more stars along a faint Milky Way
  if (pick < .9 - band * .1) return 0.;
  float fw = max(length(fwidth(p)), .02), r = length(f - j * .55), b = (pick - .88) * 8.;
  return b * exp(-r * r / (fw * fw * .7)) * (.75 + .25 * sin(time * (1.5 + pick * 4.) + pick * 60.));
}
vec3 todSky(vec3 d, vec3 dayC, float cloud, float time) { // the sky at this hour; dayC: the look's own daytime sky, with its clouds
  float y = max(d.y, 0.);
  vec3 c = mix(uTodHor, uTodMid, smoothstep(0., .22, y));
  c = mix(c, uTodZen, smoothstep(.18, .8, y));
  float cs = max(dot(d, uTodSunDir), 0.), low = 1. - smoothstep(0., .45, y); // the sun's glow spreads along the horizon
  c += uTodGlow * (pow(cs, 5.) * .45 * low + pow(cs, 48.) * .55) * smoothstep(-.25, .02, uTodSunDir.y);
  c = mix(c, vec3(1., .93, .78), smoothstep(.99955, .99975, cs) * smoothstep(-.02, .01, uTodSunDir.y));
  float band = exp(-pow(dot(d, normalize(vec3(.55, .35, .76))) / .22, 2.));
  c += vec3(.10, .11, .16) * band * uTodStars * smoothstep(0., .3, y) * .5;
  float mc = max(dot(d, uTodMoon), 0.), moon = smoothstep(.99955, .99968, mc) * smoothstep(.0, .3, uTodStars);
  vec3 sky = c + vec3(.85, .88, 1.) * todStars(d, time) * uTodStars * smoothstep(.02, .2, y) * (1. - moon);
  sky += vec3(.55, .62, .85) * (pow(mc, 2000.) * .35 + pow(mc, 80.) * .12) * smoothstep(0., .3, uTodStars); // the moon's halo
  sky = mix(sky, vec3(1., .97, .88) * (.9 - .12 * todHash(floor(d * 900.))), moon);
  sky = mix(sky, uTodCloud * (.82 + .18 * smoothstep(.0, .3, y)), cloud * (1. - moon));
  return mix(sky, dayC, uTodDay);
}`;
