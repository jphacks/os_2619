// The end of a match, as a show (game screen and final screen). On a KO: the blow freezes the picture (hit stop), the camera rushes in on
// the beaten player over a backdrop of the winner's element colour with speed lines, the character breaks apart in slow motion, "K.O."
// is stamped, then the results slide in. On time up: "TIME UP", then the results. And the start: the players introduced, VS, FIGHT! (introLine). Only looks: the game has already decided (game.js finish()).
// Timings are real seconds from the end. The stage asks state() every frame for the time scale, the camera and the backdrop.
import * as THREE from 'three';

export const KO = {
  flash: .09,      // s of white
  stop: .38,       // s of hit stop before the break
  rush: .16,       // s for the camera to rush in
  zoomIn: 2.1,     // how close it rushes in
  slow: .25,       // time scale after the break
  slowFor: 1,      // s of slow motion
  ease: .35,       // s back to normal speed
  stamp: 1.5,      // s: "K.O." is stamped
  result: 2.7,     // s: the results come in
  timeup: 1.7,     // s: on time up, the results come in
  resultZoom: 1.3, // the camera on the winner during the results, the winner a third in from the left
  count: .8,       // s each number counts up
};
const clamp01 = v => Math.max(0, Math.min(1, v));
const outExpo = t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
const outCubic = t => 1 - Math.pow(1 - clamp01(t), 3);
const inOut = t => { t = clamp01(t); return t * t * (3 - 2 * t); };

/** The winner's rank from how the match went (draw: none). */
export function rankOf(w) {
  if (!w) return '';
  const hp = w.hp / (w.hpMax || 100), acc = w.shots ? w.hits / w.shots : 0;
  return hp >= .7 && acc >= .4 ? 'S' : hp >= .4 ? 'A' : hp >= .15 ? 'B' : 'C';
}

/** The time scale, camera and backdrop at t s after the end. ko: blown apart (else time up / draw). */
export function timeline(t, ko) {
  if (!ko) {
    const res = clamp01((t - KO.timeup) / .8);
    return { scale: 1, k: 0, zoom: 1 + (KO.resultZoom - 1) * inOut(res), on: res > 0 ? 'winner' : null, x: .5 + (1 / 3 - .5) * inOut(res), burst: false, stamp: t >= 0 && t < KO.timeup, result: t >= KO.timeup };
  }
  const b = KO.stop, s1 = b + KO.slowFor, res = clamp01((t - KO.result) / .8);
  const scale = t < b ? 0 : t < s1 ? KO.slow : t < s1 + KO.ease ? KO.slow + (1 - KO.slow) * inOut((t - s1) / KO.ease) : 1;
  let zoom = t < b ? 1 + (KO.zoomIn - 1) * outExpo(t / KO.rush) : 1 + (KO.zoomIn - 1) * (1 - inOut((t - b) / (s1 + KO.ease - b)));
  const on = t >= KO.result ? 'winner' : 'loser';
  if (t >= KO.result) zoom = 1 + (KO.resultZoom - 1) * inOut(res);
  const k = t < s1 ? 1 : 1 - inOut((t - s1) / KO.ease);
  return { scale, k, zoom, on, x: on === 'winner' ? .5 + (1 / 3 - .5) * inOut(res) : .5, burst: t >= b, stamp: t >= KO.stamp && t < KO.result, result: t >= KO.result };
}

// The start (the 3 s countdown, game.js setPhase): the camera visits A, then B, each with a name card; "VS" between them, the camera
// pulls back, "READY", and "FIGHT!" as the match starts. t from the countdown's start; the match starts at INTRO.fight.
export const INTRO = { a: 0, b: 1.05, vs: 2.05, ready: 2.35, fight: 3, end: 3.8, zoom: 1.5 };
export function introLine(t) {
  const I = INTRO, k = t < I.vs ? Math.min(1, t / .35) : 1 - inOut((t - I.vs) / .6);
  const on = t < I.b ? 'A' : t < I.vs ? 'B' : null;
  const x = t < I.b ? .36 : t < I.vs ? .64 : .5;
  return { scale: 1, k: 0, zoom: 1 + (I.zoom - 1) * (on ? outCubic(k * 1.4) : Math.max(0, k)), on, x, lastOn: t < I.vs ? null : 'B',
    cardA: t >= I.a && t < I.fight, cardB: t >= I.b && t < I.fight, vs: t >= I.vs && t < I.fight, ready: t >= I.ready && t < I.fight, fight: t >= I.fight && t < I.end, done: t >= I.end };
}

const STATS = [
  ['命中', p => `${p.hits}<i>/${p.shots}</i>`, p => p.hits],
  ['大技', p => `${p.specials}`, p => p.specials],
  ['与ダメージ', p => `${Math.round(p.dealt)}`, p => p.dealt],
  ['残り HP', p => `${Math.max(0, Math.round(p.hp))}`, p => Math.max(0, p.hp)],
];

/**
 * createKoShow(hud, { colorOf(slot) -> css colour, nameOf(slot) -> string, onBurst(loser, winner), sound(kind) }) ->
 *   { start(winner, loser, ko), reset(), state(dt), get active }
 */
export function createKoShow(hud, { colorOf, nameOf, onBurst = () => {}, sound = () => {} }) {
  const el = document.createElement('div'); el.className = 'ko'; el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<div class="ko-flash"></div><div class="ko-stamp"><span></span></div>
    <div class="ko-res"><div class="ko-band"></div><div class="ko-band thin"></div>
      <div class="ko-win"><small>WINNER</small><b></b><em></em></div>
      <div class="ko-card"><table><thead><tr><th></th><th class="A">A</th><th class="B">B</th></tr></thead><tbody></tbody></table></div>
      <div class="ko-rank"><small>RANK</small><b></b></div>
      <div class="ko-hint">R でもう一回</div></div>
    <div class="mi"><div class="mi-card A"><small>PLAYER</small><b>A</b><em></em></div><div class="mi-card B"><small>PLAYER</small><b>B</b><em></em></div>
      <div class="mi-vs">VS</div><div class="mi-call"><span class="ready">READY</span><span class="fight">FIGHT!</span></div></div>`;
  hud.append(el);
  const $ = q => el.querySelector(q), color = new THREE.Color();
  let at = null, show = null, last = { burst: false, stamp: false, result: false }, t = 0;
  const reduce = matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function fillResults() {
    const { winner: w } = show, P = show.players;
    $('.ko-win small').textContent = w ? 'WINNER' : 'DRAW';
    $('.ko-win b').textContent = w ? w.slot : 'A ― B';
    $('.ko-win em').textContent = w ? nameOf(w.slot) : '引き分け';
    $('.ko-rank b').textContent = rankOf(w); $('.ko-rank').hidden = !w;
    $('.ko-card tbody').innerHTML = STATS.map(([n], i) => `<tr style="--i:${i}"><th>${n}</th>${['A', 'B'].map(s => `<td class="${s}${w?.slot === s ? ' won' : ''}" data-row="${i}" data-slot="${s}">0</td>`).join('')}</tr>`).join('');
    for (const th of el.querySelectorAll('thead th.A, thead th.B')) th.classList.toggle('won', th.textContent === w?.slot);
  }
  function countUp(sinceResult) {
    for (const td of el.querySelectorAll('.ko-card td')) {
      const i = +td.dataset.row, p = show.players[td.dataset.slot], [, fmt, val] = STATS[i];
      const k = outCubic((sinceResult - .55 - .09 * i) / KO.count), v = val(p) * k;
      td.innerHTML = k >= 1 ? fmt(p) : fmt({ ...p, hits: Math.round(p.hits * k), shots: p.shots, specials: Math.round(v), dealt: v, hp: v });
    }
  }

  let intro = null; // { t, players }
  const setFlags = f => { for (const [c, on] of Object.entries(f)) el.classList.toggle(c, !!on); };
  return {
    get active() { return !!show || !!intro; },
    /** The countdown has begun: the players are introduced (players: { A, B } of game.js). */
    intro(players) {
      show = null; intro = { t: 0, players };
      el.className = 'ko on intro';
      for (const s of ['A', 'B']) { const c = el.querySelector(`.mi-card.${s}`); c.style.setProperty('--pc', colorOf(s)); c.querySelector('em').textContent = nameOf(s); }
      sound('intro');
    },
    /** The match has ended. winner / loser: game.js players (null on a draw), ko: the loser's HP went to 0. players: { A, B } (the stats). */
    start(winner, loser, ko, players) {
      intro = null;
      show = { winner, loser, ko: !!ko && !!loser, players }; at = 0; t = 0; last = { burst: false, stamp: false, result: false };
      const c = colorOf(winner?.slot ?? null);
      el.style.setProperty('--ko', c); color.set(c);
      el.className = 'ko on' + (show.ko ? ' is-ko' : ' is-time');
      $('.ko-stamp span').textContent = show.ko ? 'K.O.' : winner ? 'TIME UP' : 'DRAW';
      fillResults();
      if (show.ko && !reduce) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), KO.flash * 1000); }
      sound(show.ko ? 'ko' : 'end');
      if (!show.ko) el.classList.add('stamp');
    },
    reset() { show = null; intro = null; el.className = 'ko'; },
    /** Every frame with the real dt: { scale, k (backdrop), color, zoom, focus: 'winner' | 'loser' | null, x (where the focus sits across the screen, 0..1) } or null. */
    state(dt) {
      if (intro) {
        intro.t += dt; const s = introLine(intro.t);
        if (s.fight && !el.classList.contains('fight')) sound('fight');
        setFlags({ cardA: s.cardA, cardB: s.cardB, vs: s.vs, ready: s.ready && !s.fight, fight: s.fight });
        if (s.done) { intro = null; el.className = 'ko'; return null; }
        return { ...s, zoom: reduce ? 1 : s.zoom, color, focus: s.on ? intro.players[s.on] : null };
      }
      if (!show) return null;
      t += dt; const s = timeline(t, show.ko);
      if (s.burst && !last.burst) { onBurst(show.loser, show.winner); sound('burst'); }
      if (s.stamp !== last.stamp) el.classList.toggle('stamp', s.stamp);
      if (s.result && !last.result) { el.classList.add('result'); sound('result'); }
      if (s.result) countUp(t - (show.ko ? KO.result : KO.timeup));
      last = s;
      const focus = s.on === 'winner' ? show.winner : s.on === 'loser' ? show.loser : null;
      return { ...s, k: reduce ? 0 : s.k, scale: reduce ? 1 : s.scale, zoom: reduce ? 1 : s.zoom, color, focus };
    },
  };
}
