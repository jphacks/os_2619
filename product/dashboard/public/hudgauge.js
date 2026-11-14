// The round charge gauge at the end of a player's HP bar: a disc with the scanned stick's silhouette, and an open ring that tapers from a thick end at
// nine o'clock, round the bottom and the right, to a point near the top. It fills the other way with the charge: from the point, clockwise, to the thick end. 1 / 2 / Full over it name the tier.
// Tier 1 is plain yellow. Tier 2 is deep yellow to orange with a faint soap film's sheen swaying in it, inside the frame. Tier 3 is a rainbow on fire: the thick end burns up past the frame as one flame with swaying tongues, the rest of the ring's edge ripples. Both are drawn each frame on a canvas over the ring.
const C = [72, 64], R = 42, FROM = Math.PI, SWEEP = 250 * Math.PI / 180, STEPS = 64; // centre and inner radius, in the drawing's units; where the ring starts, how far it runs (counter-clockwise on screen)
const LABEL = { s: '1', m: '2', l: 'Full' };

const widthAt = t => 3 + 24 * (1 - t) ** .8;
function ringPath(from, to = 1, inset = 0) { // the part of the ring between from and to (0 the thick end, 1 the point), inset from its edges
  if (to <= from) return '';
  const n = Math.max(2, Math.ceil(STEPS * (to - from))), outer = [], inner = [];
  for (let i = 0; i <= n; i++) {
    const t = from + (to - from) * i / n, a = FROM - SWEEP * t, c = Math.cos(a), s = Math.sin(a), r = R + widthAt(t) - inset;
    outer.push(`${(C[0] + c * r).toFixed(1)} ${(C[1] + s * r).toFixed(1)}`);
    inner.unshift(`${(C[0] + c * (R + inset)).toFixed(1)} ${(C[1] + s * (R + inset)).toFixed(1)}`);
  }
  return `M${outer.join('L')}L${inner.join('L')}Z`;
}
let count = 0; // the clip paths' ids
const PAD = 44, W = 132 + 2 * PAD, H = 130 + 2 * PAD, S = 1.4; // the canvas: the drawing's area with room for the flames (drawing units), its pixels per unit
const SHADOW = 4 * 132 / 92; // the HUD's 4 px, in the drawing's units (it is 132 units across 92 px)
const fract = v => v - Math.floor(v);
function paintFilm(g, film, from, time) { // a thin film's colours: its thickness sways slowly, and each thickness shows its own colour. Low resolution, smoothed up, clipped inside the frame
  const x = film.getContext('2d'), N = film.width, im = x.createImageData(N, N), d = im.data;
  for (let j = 0, k = 0; j < N; j++) for (let i = 0; i < N; i++, k += 4) {
    const u = i / N, v = j / N;
    const thick = Math.sin(u * 12 + time * .7 + 1.5 * Math.sin(v * 9 - time * .5)) + Math.sin(v * 14 - time * .4 + 1.5 * Math.sin(u * 7 + time * .6)), p = thick * 3.2 + time * .3;
    const o = .5 + .5 * Math.sin(thick * .9 + time * .5), sheen = .1 + .07 * Math.sin(thick * 1.7 + time * .9); // deep yellow to orange, and how much of the film shows through it
    const base = [255, 186 - 52 * o, 8];
    d[k] = base[0] + (150 + 105 * Math.cos(p) - base[0]) * sheen; d[k + 1] = base[1] + (150 + 105 * Math.cos(p + 2.1) - base[1]) * sheen; d[k + 2] = base[2] + (150 + 105 * Math.cos(p + 4.2) - base[2]) * sheen;
    d[k + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  g.save(); g.clip(new Path2D(ringPath(from, 1, 1)));
  g.imageSmoothingEnabled = true; g.drawImage(film, 0, 0, 132, 130);
  g.restore();
}
// The flame's tongues along the ring's outer edge, from the ring towards its top: where (t < 0 runs on past the thick end), how far from the centre
const TONGUES = [[.26, 72], [.17, 79], [.08, 86], [-.02, 93], [-.11, 97], [-.2, 89], [-.3, 84]];
const polar = (t, r) => { const a = FROM - SWEEP * t; return [C[0] + Math.cos(a) * r, C[1] + Math.sin(a) * r]; };
const outerAt = t => R + widthAt(Math.max(0, t));
function flamePath(g, time, grow) { // one outline: the ring's rippling edge, the tongues with hollow curves between them, back down to the disc and along the ring's inner edge
  g.beginPath();
  for (let i = 0; i <= 26; i++) { // the ripple runs along the edge, from the point to the first tongue
    const t = 1 - (1 - TONGUES[0][0]) * i / 26, r = outerAt(t) + (.8 + (1 - t) * 3.4 * (1 + Math.sin(t * 34 + time * 7))) * grow;
    g.lineTo(...polar(t, r));
  }
  let last = TONGUES[0][0];
  TONGUES.forEach(([t, r], i) => {
    const pulse = 1 + .055 * Math.sin(time * 6.3 + i * 2.7) + .03 * Math.sin(time * 11 - i * 1.3), reach = outerAt(t) + (r * pulse - outerAt(t)) * grow;
    const [x, y] = polar(t, reach), tip = [x + (2 + 5 * Math.abs(t - .3)) * Math.sin(time * 4.7 + i * 1.9), y - 9 * grow]; // the tips lean up and sway
    const mid = (last + t) / 2, valley = polar(mid + .012, outerAt(mid) + 1 + 2.4 * Math.sin(time * 5 + i));
    g.quadraticCurveTo(valley[0], valley[1], tip[0], tip[1]);
    last = t;
  });
  const back = polar(-.33, R + 19 + 3 * Math.sin(time * 5.6)), inner = polar(-.3, R + 1);
  g.quadraticCurveTo(...polar(-.25, R + 22), back[0], back[1]);
  g.quadraticCurveTo(...polar(-.27, R + 10), inner[0], inner[1]);
  for (let i = 1; i <= 40; i++) g.lineTo(...polar(-.3 + 1.3 * i / 40, R + 1));
  g.closePath();
}
function paintFire(g, time, shadowX) {
  const hue = g.createConicGradient(FROM - SWEEP, C[0], C[1]); // the rainbow runs along t, and on through the flame
  for (let i = 0; i <= 36; i++) { const t = 1 - 1.39 * i / 36; hue.addColorStop(i / 36, `hsl(${fract(t - time * .7) * 360}, 100%, 56%)`); }
  // the HUD's hard shadow, drawn here since the canvas lies over the disc: it stays off the disc
  const off = new Path2D(); off.rect(-PAD, -PAD, W, H); off.arc(C[0], C[1], R - 2, 0, Math.PI * 2);
  g.save(); g.clip(off, 'evenodd'); g.translate(shadowX, SHADOW); flamePath(g, time, 1); g.fillStyle = '#000'; g.fill(); g.restore();
  flamePath(g, time, 1.1); g.fillStyle = hue; g.globalAlpha = .28; g.fill(); g.globalAlpha = 1; // a soft edge of the same colours
  flamePath(g, time, 1); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 1.25; g.lineJoin = 'round'; g.stroke();
}
const STICK_TINT = { fire: '#ff8a46', thunder: '#ffe56a', water: '#6dbaff', wind: '#c8ffff' };
const FALLBACK_STICK = { v: 3, length: 1, r: [.025, .02], nodes: [[0, -.5], [.01, 0], [0, .5]], edges: [[0, 1], [1, 2]] };
const SVG = 'http://www.w3.org/2000/svg';

// Project the scan's side/length tree into the disc. Every branch and bend gets its own tapered-looking segment.
function stickSegments(model) {
  const m = model?.v === 3 && model.length > 0 && Array.isArray(model.nodes) && Array.isArray(model.edges) && Array.isArray(model.r) ? model : FALLBACK_STICK;
  const L = m.length, point = ([side, along]) => {
    const t = along / L + .5, offset = side * 64 / L;
    return [55 + 30 * t + .9 * offset, 94 - 60 * t + .45 * offset];
  };
  const radius = along => Math.max(2, (m.r[0] + (m.r[1] - m.r[0]) * Math.max(0, Math.min(1, along / L + .5))) * 64 / L * 1.5);
  return m.edges.flatMap(([i, j]) => {
    const a = m.nodes[i], b = m.nodes[j];
    if (!a || !b || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return [];
    const [x1, y1] = point(a), [x2, y2] = point(b);
    return [{ d: `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`, width: radius((a[1] + b[1]) / 2) * 2 }];
  });
}

/** createGauge(el): draws into el; set(level 0..1, tier 's' | 'm' | 'l' | null). */
export function createGauge(el) {
  const ring = ringPath(0), id = 'gauge-ring-' + ++count;
  el.innerHTML = `<svg viewBox="0 0 132 130" aria-hidden="true">
    <clipPath id="${id}"><path d="${ring}"/></clipPath>
    <clipPath id="${id}-disc"><circle cx="${C[0]}" cy="${C[1]}" r="${R - 6}"/></clipPath>
    <linearGradient id="${id}-stick"><stop offset="0" stop-color="#fff"/><stop class="stick-tint" offset=".5" stop-color="#ff8a46"/><stop offset="1" stop-color="#514331"/></linearGradient>
    <path class="track" d="${ring}"/><path class="fill"/>
    <g clip-path="url(#${id})"><path class="glow" d="${ring}"/></g>
    <path class="frame" d="${ring}"/>
    <circle class="edge" cx="${C[0]}" cy="${C[1]}" r="${R - 2}"/><circle class="disc" cx="${C[0]}" cy="${C[1]}" r="${R - 6}"/>
    <g class="staff" clip-path="url(#${id}-disc)"/>
  </svg><canvas width="${Math.round(W * S)}" height="${Math.round(H * S)}" style="left:${-PAD / 1.32}%;top:${-PAD / 1.3}%;width:${W / 1.32}%;height:${H / 1.3}%"></canvas><b class="lv"></b>`;
  const fill = el.querySelector('.fill'), lv = el.querySelector('.lv'), staff = el.querySelector('.staff'), tint = el.querySelector('.stick-tint');
  const g = el.querySelector('canvas').getContext('2d'), film = Object.assign(document.createElement('canvas'), { width: 48, height: 48 });
  const shadowX = el.closest('.pl.B') ? -SHADOW : SHADOW; // B's canvas is mirrored
  let key = '', painted = false, shownModel, shownElement;
  function paint(level, tier) {
    const on = tier === 'm' || tier === 'l';
    if (!on && !painted) return;
    g.setTransform(S, 0, 0, S, PAD * S, PAD * S); g.clearRect(-PAD, -PAD, W, H);
    painted = on; if (!on) return;
    const time = performance.now() / 1000;
    if (tier === 'm') paintFilm(g, film, 1 - level, time);
    else paintFire(g, time, shadowX);
  }
  return {
    setStick(model, element) {
      if (model === shownModel && element === shownElement) return;
      shownModel = model; shownElement = element;
      tint.setAttribute('stop-color', STICK_TINT[element] ?? '#fff');
      staff.replaceChildren();
      for (const { d, width } of stickSegments(model)) {
        for (const [extra, stroke] of [[2.5, '#13151d'], [0, `url(#${id}-stick)`]]) {
          const path = document.createElementNS(SVG, 'path');
          path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', stroke);
          path.setAttribute('stroke-width', width + extra); path.setAttribute('stroke-linecap', 'round');
          staff.append(path);
        }
      }
    },
    set(level, tier) {
      paint(level, tier);
      const k = `${level.toFixed(3)}|${tier}`; if (k === key) return; key = k;
      fill.setAttribute('d', ringPath(1 - level));
      lv.textContent = LABEL[tier] ?? '';
      el.dataset.tier = tier ?? '';
    },
  };
}
