// The round charge gauge at the end of a player's HP bar: a disc with the staff mark, and an open ring that tapers from a thick end at
// nine o'clock, round the bottom and the right, to a point near the top. It fills along that way with the charge; 1 / 2 / Full over it name the tier.
const C = [72, 64], R = 42, FROM = Math.PI, SWEEP = 250 * Math.PI / 180, STEPS = 64; // centre and inner radius, in the drawing's units; where the ring starts, how far it runs (clockwise on screen)
const LABEL = { s: '1', m: '2', l: 'Full' };

const widthAt = t => 3 + 24 * (1 - t) ** .8;
function ringPath(to) { // the ring from its thick end up to `to` (0..1)
  if (to <= 0) return '';
  const n = Math.max(2, Math.ceil(STEPS * to)), outer = [], inner = [];
  for (let i = 0; i <= n; i++) {
    const t = to * i / n, a = FROM - SWEEP * t, c = Math.cos(a), s = Math.sin(a), r = R + widthAt(t);
    outer.push(`${(C[0] + c * r).toFixed(1)} ${(C[1] + s * r).toFixed(1)}`);
    inner.unshift(`${(C[0] + c * R).toFixed(1)} ${(C[1] + s * R).toFixed(1)}`);
  }
  return `M${outer.join('L')}L${inner.join('L')}Z`;
}
const STAFF = '49,96 77,42 80,27 83,41 92,46 82,49 55,98';

/** createGauge(el): draws into el; set(level 0..1, tier 's' | 'm' | 'l' | null, split 0..1 where tier 2 begins). */
export function createGauge(el) {
  el.innerHTML = `<svg viewBox="0 0 132 130" aria-hidden="true">
    <path class="track" d="${ringPath(1)}"/><path class="fill"/><line class="split"/>
    <circle class="edge" cx="${C[0]}" cy="${C[1]}" r="${R - 2}"/><circle class="disc" cx="${C[0]}" cy="${C[1]}" r="${R - 6}"/>
    <polygon class="staff" points="${STAFF}"/>
  </svg><b class="lv"></b>`;
  const fill = el.querySelector('.fill'), split = el.querySelector('.split'), lv = el.querySelector('.lv');
  let key = '';
  return {
    set(level, tier, at) {
      const k = `${level.toFixed(3)}|${tier}|${at.toFixed(3)}`; if (k === key) return; key = k;
      fill.setAttribute('d', ringPath(level));
      const a = FROM - SWEEP * at, c = Math.cos(a), s = Math.sin(a), r = R + widthAt(at) + 1;
      split.setAttribute('x1', C[0] + c * (R - 1)); split.setAttribute('y1', C[1] + s * (R - 1)); split.setAttribute('x2', C[0] + c * r); split.setAttribute('y2', C[1] + s * r);
      lv.textContent = LABEL[tier] ?? '';
      el.dataset.tier = tier ?? '';
    },
  };
}
