// A scanned stick's element, rarity and stats, all pure functions of its seed (a random uint32 made at every scan).
// Shared by server.mjs (records) and the pages (game, admin). Stats are multipliers: 1 = the game's global value.
export const ELEMENTS = ['fire', 'thunder', 'water', 'wind'];
export const STATS = ['hp', 'power', 'speed', 'charge'];
export const RARITY_MUL = [1, 1, 1, 1, 1]; // default rules.rarityMul: mean stat multiplier for ★1..★5
const LO = .7, HI = 1.3;

// mulberry32: tiny seeded PRNG, uniform floats in [0, 1)
export function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// each use gets its own stream, so the element, the luck and the stats don't depend on each other
const rng = (seed, salt) => mulberry32((seed ^ salt) >>> 0);

export const stickElement = seed => ELEMENTS[Math.floor(rng(seed, 0x9E3779B9)() * 4)];

/** Rarity ★1..5: from the shape (shapeScore 0..1, stick-analyze.js), then the seed's luck of -1 / 0 / +1. */
export function baseRarity(shapeScore) {
  const s = +shapeScore || 0;
  return s < .15 ? 1 : s < .3 ? 2 : s < .5 ? 3 : s < .7 ? 4 : 5;
}
export function stickLuck(seed) { const r = rng(seed, 0x85EBCA6B)(); return r < .25 ? -1 : r >= .75 ? 1 : 0; }
export const stickRarity = (seed, shapeScore) => Math.max(1, Math.min(5, baseRarity(shapeScore) + stickLuck(seed)));

const clampMul = v => Number.isFinite(+v) ? Math.max(LO, Math.min(HI, +v)) : 1;
/** rules.rarityMul cleaned up: 5 numbers in [0.7, 1.3] (anything else falls back to 1). */
export const cleanRarityMul = m => RARITY_MUL.map((d, i) => Array.isArray(m) ? clampMul(m[i] ?? d) : d);

/** {hp, power, speed, charge}: each in [0.7, 1.3], their mean exactly rarityMul[rarity-1]. */
export function stickStats(seed, rarity, rarityMul = RARITY_MUL) {
  const m = cleanRarityMul(rarityMul)[Math.max(1, Math.min(5, Math.round(rarity) || 1)) - 1];
  const r = rng(seed, 0xC2B2AE35);
  let d = STATS.map(() => r() * 2 - 1);
  const avg = d.reduce((a, b) => a + b) / 4; d = d.map(x => x - avg); // zero mean: the mean stays m
  const big = Math.max(...d.map(Math.abs)) || 1; d = d.map(x => x / big); // largest deviation = 1
  // spread 0.1..0.3, shrunk so the largest stat still fits in [0.7, 1.3]
  let s = .1 + .2 * r();
  for (const x of d) if (x > 0) s = Math.min(s, (HI - m) / x); else if (x < 0) s = Math.min(s, (LO - m) / x);
  return Object.fromEntries(STATS.map((k, i) => [k, Math.max(LO, Math.min(HI, m + s * d[i]))]));
}
