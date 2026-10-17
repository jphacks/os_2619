// The final screen's picture with the recognition (vision.js) drawn into it, under the magic effects (stage.js uses the
// returned canvas as the scene background instead of the raw video). Each layer has its own switch:
//  spot   darken everything but the people and the space between them (one soft ellipse, eased so it does not jitter)
//  ghost  afterimages of each person's mask in their colour, fading in ~0.25 s, never over the person's current body
//  trail  afterimage of the recognised stick: the area it swept over the last 0.3 s
//  draw   the recognition itself: skeleton, hands, stick
import { LM } from './vision.js';

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [0, 11], [0, 12]];
const GHOST_TAU = .12, TRAIL_S = .3, STICK_MIN = .35;
const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

export function createVisionFx() {
  const out = document.createElement('canvas'), o = out.getContext('2d');
  const ghost = document.createElement('canvas'), g = ghost.getContext('2d');
  const masks = document.createElement('canvas'), mk = masks.getContext('2d');   // the latest masks, tinted
  const cut = document.createElement('canvas'), ct = cut.getContext('2d');       // ghost minus the current bodies
  const shade = document.createElement('canvas'), sh = shade.getContext('2d');
  shade.width = 320; shade.height = 180;
  let seq = -1, spot = null, spotA = 0;
  const trails = { A: [], B: [] };

  function stampMasks(V, colors) {
    const any = ['A', 'B'].map(s => V.persons[s]).find(p => p?.mask); if (!any) return false;
    const { w, h } = any.mask;
    if (masks.width !== w || masks.height !== h) { masks.width = ghost.width = cut.width = w; masks.height = ghost.height = cut.height = h; }
    const img = mk.createImageData(w, h), d = img.data;
    for (const s of ['A', 'B']) {
      const p = V.persons[s]; if (!p?.mask || p.mask.w !== w || p.mask.h !== h || p.t !== latestT(V)) continue;
      const [r, gg, b] = hex(colors[s]), m = p.mask.d;
      for (let i = 0; i < m.length; i++) if (m[i] > d[4 * i + 3]) { d[4 * i] = r; d[4 * i + 1] = gg; d[4 * i + 2] = b; d[4 * i + 3] = m[i]; }
    }
    mk.putImageData(img, 0, 0);
    return true;
  }
  const latestT = V => Math.max(V.persons.A?.t ?? -1, V.persons.B?.t ?? -1);

  /** Draw src (video / canvas, vw x vh) with the layers on; returns the canvas, or null when nothing is on. */
  function compose(src, vw, vh, dt, V, on, colors) {
    if (!on.spot && !on.ghost && !on.trail && !on.draw) return null;
    if (out.width !== vw || out.height !== vh) { out.width = vw; out.height = vh; }
    o.globalCompositeOperation = 'source-over'; o.globalAlpha = 1; o.filter = 'none';
    o.drawImage(src, 0, 0, vw, vh);
    const fresh = V.state.seq !== seq; seq = V.state.seq;
    const P = ['A', 'B'].map(s => [s, V.persons[s]]).filter(([, p]) => p);
    const now = performance.now() / 1000;

    if (on.spot) { // the people's box, both included, eased; the outside darkened through a soft ellipse
      let box = null;
      for (const [, p] of P) for (const [x, y, v] of p.pts) if (v > .4) box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
      const k = 1 - Math.exp(-dt / .25);
      if (box) { const t = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2, (box[2] - box[0]) / 2 + .1, (box[3] - box[1]) / 2 + .12]; spot = spot ? spot.map((v, i) => v + k * (t[i] - v)) : t; }
      spotA += k * ((box ? 1 : 0) - spotA);
      if (spot && spotA > .01) {
        const W = shade.width, H = shade.height;
        sh.globalCompositeOperation = 'source-over'; sh.clearRect(0, 0, W, H); sh.fillStyle = `rgba(0,0,0,${.62 * spotA})`; sh.fillRect(0, 0, W, H);
        sh.globalCompositeOperation = 'destination-out'; sh.save(); sh.translate(spot[0] * W, spot[1] * H); sh.scale(spot[2] * W * 1.25, spot[3] * H * 1.25);
        const gr = sh.createRadialGradient(0, 0, .55, 0, 0, 1); gr.addColorStop(0, '#000'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        sh.fillStyle = gr; sh.beginPath(); sh.arc(0, 0, 1, 0, 2 * Math.PI); sh.fill(); sh.restore();
        o.drawImage(shade, 0, 0, vw, vh);
      }
    } else { spot = null; spotA = 0; }

    if (on.ghost) {
      if (ghost.width > 1) { g.globalCompositeOperation = 'destination-out'; g.fillStyle = `rgba(0,0,0,${1 - Math.exp(-dt / GHOST_TAU)})`; g.fillRect(0, 0, ghost.width, ghost.height); }
      if (fresh && stampMasks(V, colors)) { g.globalCompositeOperation = 'source-over'; g.filter = 'blur(2px)'; g.globalAlpha = .7; g.drawImage(masks, 0, 0); g.filter = 'none'; g.globalAlpha = 1; }
      if (ghost.width > 1) {
        ct.globalCompositeOperation = 'source-over'; ct.clearRect(0, 0, cut.width, cut.height); ct.drawImage(ghost, 0, 0);
        ct.globalCompositeOperation = 'destination-out'; ct.drawImage(masks, 0, 0); // the person as they are now stays untouched
        o.globalCompositeOperation = 'screen'; o.drawImage(cut, 0, 0, vw, vh); o.globalCompositeOperation = 'source-over';
      }
    } else if (ghost.width > 1) g.clearRect(0, 0, ghost.width, ghost.height);

    for (const s of ['A', 'B']) { // stick history (also kept while the trail is off, so turning it on shows at once)
      const p = V.persons[s], T = trails[s];
      if (fresh && p?.stick && p.stick.conf > STICK_MIN && p.t !== T.at(-1)?.t) T.push({ t: p.t, at: now, ...p.stick });
      while (T.length && now - T[0].at > TRAIL_S) T.shift();
    }
    if (on.trail) {
      o.globalCompositeOperation = 'lighter';
      for (const s of ['A', 'B']) {
        const T = trails[s], [r, gg, b] = hex(colors[s]);
        for (let i = 1; i < T.length; i++) {
          const a = T[i - 1], c = T[i]; if (c.t - a.t > .25) continue; // a gap in the recognition: do not sweep across it
          const f = 1 - (now - c.at) / TRAIL_S;
          o.fillStyle = `rgba(${r},${gg},${b},${.45 * f * f})`;
          o.beginPath(); o.moveTo(a.x0 * vw, a.y0 * vh); o.lineTo(a.x1 * vw, a.y1 * vh); o.lineTo(c.x1 * vw, c.y1 * vh); o.lineTo(c.x0 * vw, c.y0 * vh); o.closePath(); o.fill();
        }
        const c = T.at(-1);
        if (c) { o.strokeStyle = `rgba(${r},${gg},${b},.8)`; o.lineWidth = vh / 120; o.lineCap = 'round'; o.beginPath(); o.moveTo(c.x0 * vw, c.y0 * vh); o.lineTo(c.x1 * vw, c.y1 * vh); o.stroke(); }
      }
      o.globalCompositeOperation = 'source-over';
    }

    if (on.draw) {
      const u = vh / 540;
      for (const [s, p] of P) {
        const col = colors[s], X = i => p.pts[i][0] * vw, Y = i => p.pts[i][1] * vh, ok = i => p.pts[i][2] > .4;
        o.strokeStyle = col; o.lineWidth = 2.5 * u; o.globalAlpha = .9;
        o.beginPath(); for (const [a, b] of BONES) if (ok(a) && ok(b)) { o.moveTo(X(a), Y(a)); o.lineTo(X(b), Y(b)); } o.stroke();
        o.fillStyle = '#fff'; for (let i = 0; i < 33; i++) if (ok(i) && (i === 0 || i > 10)) { o.beginPath(); o.arc(X(i), Y(i), 2.5 * u, 0, 7); o.fill(); }
        for (const side of ['l', 'r']) { // hand: centre of wrist, pinky, index, thumb
          const ids = [LM[side + 'Wr'], LM[side + 'Pi'], LM[side + 'Ix'], LM[side + 'Th']]; if (!ok(ids[0])) continue;
          const hx = ids.reduce((a, i) => a + X(i), 0) / 4, hy = ids.reduce((a, i) => a + Y(i), 0) / 4;
          o.strokeStyle = '#fff'; o.lineWidth = 2 * u; o.beginPath(); o.arc(hx, hy, 9 * u, 0, 7); o.stroke();
        }
        const st = p.stick;
        if (st) {
          const good = st.conf > STICK_MIN;
          o.strokeStyle = good ? '#ffe14d' : 'rgba(255,225,77,.35)'; o.lineWidth = 4 * u; o.setLineDash(good ? [] : [8 * u, 6 * u]);
          o.beginPath(); o.moveTo(st.x0 * vw, st.y0 * vh); o.lineTo(st.x1 * vw, st.y1 * vh); o.stroke(); o.setLineDash([]);
          o.fillStyle = '#ffe14d'; o.beginPath(); o.arc(st.x1 * vw, st.y1 * vh, 5 * u, 0, 7); o.fill();
        }
        const [lx, ly] = p.key ?? [X(0) / vw, Y(0) / vh];
        o.font = `bold ${16 * u}px system-ui, sans-serif`; o.fillStyle = col; o.textAlign = 'center';
        o.fillText(`${s}${st ? `  棒 ${Math.round(st.conf * 100)}%` : ''}`, lx * vw, ly * vh - 40 * u);
        o.globalAlpha = 1;
      }
    }
    return out;
  }
  return { compose, canvas: out };
}
