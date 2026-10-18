// Tutorial window opened from the game screen (screen 3), over the whole page (header and side panel too): the presentation
// slides, one page at a time.
// Slides: public/assets/tutorial/slide1.png ... slide4.png (16:9 PNG exported from the deck). A missing page shows a note.
//   open: the チュートリアル button (mountButton) or T on screen 3   pages: ← → / the arrows / the dots   close: Esc / × / outside
// While it is open, arrow keys and Space go to the window only (not to the keyboard player, playable.js).
const PAGES = 4;
const src = i => new URL(`./assets/tutorial/slide${i + 1}.png`, import.meta.url).href;
const CSS = `
.tut-back { position: fixed; inset: 0; z-index: 1000; display: none; place-items: center; background: rgba(4,6,10,.72); backdrop-filter: blur(3px); }
.tut-back.open { display: grid; }
.tut-win { position: relative; width: min(94vw, calc((100vh - 130px) * 16 / 9 + 32px)); max-height: 96vh; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 10px;
  padding: 14px 16px; border-radius: 14px; background: var(--surface, #11141b); border: 1px solid var(--line, #222836); box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.tut-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.tut-head b { font-size: 15px; }
.tut-x { width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--line, #222836); background: var(--surface-2, #171b24); cursor: pointer; font-size: 24px; line-height: 1; color: var(--text, #e8eaf0); }
.tut-x:hover { background: #ff6b6b33; border-color: #ff6b6b; }
.tut-page { position: relative; min-height: 0; display: grid; place-items: center; background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 16 / 9; }
.tut-page img { width: 100%; height: 100%; object-fit: contain; display: block; }
.tut-missing { position: absolute; inset: 0; display: none; place-items: center; text-align: center; color: var(--muted, #7d8597); padding: 20px; }
.tut-page.missing img { visibility: hidden; } .tut-page.missing .tut-missing { display: grid; }
.tut-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.tut-foot button { min-width: 88px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line, #222836); background: var(--surface-2, #171b24); cursor: pointer; }
.tut-foot button:disabled { opacity: .4; cursor: default; }
.tut-dots { display: flex; gap: 8px; align-items: center; }
.tut-dots span { width: 9px; height: 9px; border-radius: 50%; background: var(--line, #222836); cursor: pointer; }
.tut-dots span.on { background: var(--accent, #a99dff); }
`;

export function createTutorial({ box = document.body, isActive = () => true } = {}) {
  if (!document.getElementById('tut-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'tut-css', textContent: CSS }));
  const back = document.createElement('div'); back.className = 'tut-back';
  back.innerHTML = `<div class="tut-win" role="dialog" aria-modal="true" aria-label="チュートリアル">
    <div class="tut-head"><b>発表</b><span class="muted tut-num"></span><button class="tut-x" aria-label="閉じる" title="閉じる（Esc）">✕</button></div>
    <div class="tut-page"><img alt=""><div class="tut-missing"></div></div>
    <div class="tut-foot"><button class="tut-prev">← 前へ</button><div class="tut-dots">${Array.from({ length: PAGES }, (_, i) => `<span data-i="${i}" title="${i + 1} ページ"></span>`).join('')}</div><button class="tut-next">次へ →</button></div>
  </div>`;
  box.append(back);
  const $ = s => back.querySelector(s), img = $('.tut-page img'), page = $('.tut-page');
  let at = 0;
  const preload = Array.from({ length: PAGES }, (_, i) => { const im = new Image(); im.src = src(i); return im; });

  function show(i) {
    at = Math.max(0, Math.min(PAGES - 1, i));
    page.classList.remove('missing');
    img.onerror = () => { page.classList.add('missing'); $('.tut-missing').textContent = `slide${at + 1}.png がまだありません（public/assets/tutorial/ に置いてください）`; };
    img.src = src(at); img.alt = `スライド ${at + 1}`;
    $('.tut-num').textContent = `${at + 1} / ${PAGES}`;
    $('.tut-prev').disabled = at === 0;
    $('.tut-next').textContent = at === PAGES - 1 ? '閉じる' : '次へ →';
    back.querySelectorAll('.tut-dots span').forEach((d, k) => d.classList.toggle('on', k === at));
  }
  const open = (i = 0) => { show(i); back.classList.add('open'); };
  const close = () => back.classList.remove('open');
  const isOpen = () => back.classList.contains('open');

  $('.tut-x').onclick = close;
  $('.tut-prev').onclick = () => show(at - 1);
  $('.tut-next').onclick = () => at === PAGES - 1 ? close() : show(at + 1);
  back.querySelectorAll('.tut-dots span').forEach(d => d.onclick = () => show(+d.dataset.i));
  back.onclick = e => { if (e.target === back) close(); };
  // capture phase on window, created before playable.js (app.js): while open, these keys stop here and never reach the
  // keyboard player or app.js's shortcuts
  addEventListener('keydown', e => {
    if (!isOpen()) { if (e.key.toLowerCase() === 't' && !e.repeat && isActive() && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); open(at); } return; }
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { if (at === PAGES - 1 && e.key !== 'ArrowRight') close(); else show(at + 1); }
    else if (e.key === 'ArrowLeft') show(at - 1);
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);

  return {
    open, close, get isOpen() { return isOpen(); },
    /** A 発表用スライド button that opens the window. */
    mountButton(el) {
      const b = Object.assign(document.createElement('button'), { className: 'go', innerHTML: '発表用スライド<kbd>T</kbd>', title: '発表用スライドを順に見る（← → でページ送り、Esc で閉じる）' });
      b.onclick = () => { open(0); b.blur(); }; el.append(b); return b;
    },
    preload,
  };
}
