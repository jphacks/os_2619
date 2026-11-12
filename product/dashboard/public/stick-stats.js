// A scanned stick's element and stats. Shared by server.mjs (records) and the pages (game, 棒設定).
// Stats are multipliers, 1 = the game's global value: power (damage) and speed (ball speed). HP and charge time are the same for every
// stick (game.js RULES: hp 100, t2 3 s).
export const ELEMENTS = ['fire', 'thunder', 'water', 'wind'];
export const STATS = ['power', 'speed'];
export const STAT_RANGE = [.5, 2]; // what the admin may set by hand

// mulberry32: tiny seeded PRNG, uniform floats in [0, 1)
export function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const stickElement = seed => ELEMENTS[Math.floor(mulberry32((seed ^ 0x9E3779B9) >>> 0)() * 4)];

/** Wood volume (m³) of a scanned model (stickscan.js v 3): a cone frustum per edge, its radius tapering from the grip to the tip. */
export function stickVolume(m) {
  const L = m.length, rAt = a => m.r[0] + (m.r[1] - m.r[0]) * Math.min(1, Math.max(0, a / L + .5));
  let v = 0;
  for (const [i, j] of m.edges) {
    const a = m.nodes[i], b = m.nodes[j], l = Math.hypot(a[0] - b[0], a[1] - b[1]), r1 = rAt(a[1]), r2 = rAt(b[1]);
    v += Math.PI / 3 * l * (r1 * r1 + r1 * r2 + r2 * r2);
  }
  return v;
}

// Balance: a bigger stick hits harder and throws a little slower. With k = volume / REF_VOLUME, power = k^0.3 and speed = k^-0.15, so
// power x speed² stays 1: a slower ball is easier to dodge, roughly by its speed squared (shortcut: a guess, tune on play tests).
// k is held to [1/4, 4] (power 0.66..1.52, speed 1.23..0.81). REF_VOLUME: the middle of the first real scans (235-573 cm³).
export const REF_VOLUME = 350e-6; // m³
export function statsFromVolume(v) {
  const k = Math.min(4, Math.max(.25, (+v || REF_VOLUME) / REF_VOLUME));
  return { power: +(k ** .3).toFixed(2), speed: +(k ** -.15).toFixed(2) };
}
