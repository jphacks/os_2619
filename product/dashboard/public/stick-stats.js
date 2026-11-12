// A scanned stick's element and stats. Shared by server.mjs (records) and the pages (game, 棒設定).
// Stats are multipliers, 1 = the game's global value: power (damage) and speed (ball speed). HP and charge time are the same for every
// stick (game.js RULES: hp 100, t2 3 s).
export const ELEMENTS = ['fire', 'thunder', 'water', 'wind'];
export const STATS = ['power', 'speed'];
export const STAT_RANGE = [.5, 2]; // what the admin may set by hand

/**
 * Attribute from a v3 scan's tree. A large branch takes priority (thunder): one at least BIG_BRANCH of the stick's length (and
 * BIG_BRANCH_MIN m) from where it leaves the main line to its tip. Small twigs, however many, do not count.
 * For the main path, sample by arc length and measure its side offset from the end-to-end line.
 * Two significant changes of bend direction mean a winding stick (water); one broad bend is wind;
 * a nearly straight stick is fire. The 15-20 mm dead bands ignore small skeleton/pose noise.
 */
export const BIG_BRANCH = .1, BIG_BRANCH_MIN = .08;
export function elementFromShape(m) {
  if (longestBranch(m) >= Math.max(BIG_BRANCH_MIN, BIG_BRANCH * m.length)) return 'thunder';

  const main = m.nodes.slice(0, m.tip + 1);
  if (main.length < 3) return 'fire';
  const arc = [0];
  for (let i = 1; i < main.length; i++) arc.push(arc[i - 1] + Math.hypot(main[i][0] - main[i - 1][0], main[i][1] - main[i - 1][1]));
  const total = arc.at(-1);
  if (!total) return 'fire';
  const samples = [];
  let segment = 1;
  for (let i = 0; i <= 32; i++) {
    const t = i / 32, at = total * t;
    while (segment < arc.length - 1 && arc[segment] < at) segment++;
    const f = (at - arc[segment - 1]) / (arc[segment] - arc[segment - 1] || 1);
    const side = main[segment - 1][0] * (1 - f) + main[segment][0] * f;
    samples.push(side - (main[0][0] * (1 - t) + main.at(-1)[0] * t));
  }
  const smooth = samples.map((v, i) => i === 0 || i === 32 ? v : (samples[i - 1] + 2 * v + samples[i + 1]) / 4);
  const swing = Math.max(.015, m.length * .02), bow = Math.max(.015, m.length * .018);
  let direction = 0, extreme = smooth[0], reversals = 0;
  for (const v of smooth.slice(1)) {
    if (!direction) {
      if (v - extreme >= swing) { direction = 1; extreme = v; }
      else if (extreme - v >= swing) { direction = -1; extreme = v; }
    } else if (direction > 0) {
      if (v > extreme) extreme = v;
      else if (extreme - v >= swing) { reversals++; direction = -1; extreme = v; }
    } else if (v < extreme) extreme = v;
    else if (v - extreme >= swing) { reversals++; direction = 1; extreme = v; }
  }
  if (reversals >= 2) return 'water';
  return Math.max(...smooth.map(Math.abs)) >= bow ? 'wind' : 'fire';
}

/** The longest branch (m): from each branch tip (nodes after m.tip with one edge) back along the edges to the main line (nodes 0..tip). */
export function longestBranch(m) {
  const near = m.nodes.map(() => []), len = (i, j) => Math.hypot(m.nodes[i][0] - m.nodes[j][0], m.nodes[i][1] - m.nodes[j][1]);
  for (const [i, j] of m.edges) { near[i].push(j); near[j].push(i); }
  let best = 0;
  for (let leaf = m.tip + 1; leaf < m.nodes.length; leaf++) {
    if (near[leaf].length !== 1) continue;
    let at = leaf, from = -1, d = 0, steps = 0;
    while (at > m.tip && steps++ < m.nodes.length) { // walk toward the main line; a fork on the way keeps the way back (the first other node)
      const next = near[at].find(k => k !== from); if (next === undefined) break;
      d += len(at, next); from = at; at = next;
    }
    if (at <= m.tip) best = Math.max(best, d);
  }
  return best;
}

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
