// 棒設定: photograph a branch → measure its shape here (stick-analyze.js) → the server rolls the seed and saves it.
// Also: the saved sticks, which one players A / B use, and rules.rarityMul (merged into /rules without touching other keys).
// mountSticks(root) draws into root; the dashboard mounts it on screen 5, sticks.html (phones) on its own page.
import { analyzeStick, shapeScore, stickReasons } from './stick-analyze.js';
import { cleanRarityMul } from './stick-stats.js';

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const EL = { fire: '炎', thunder: '雷', water: '水', wind: '風' };
const EL_COLOR = { fire: '#ff7a1a', thunder: '#ffd23d', water: '#2f7dff', wind: '#d8f4f2' }; // the effects' colours (app.js)
const ST = { hp: '体力', power: '威力', speed: '速さ', charge: '溜め' };
const stars = n => `<span class="stars" aria-label="★${n}">${'★'.repeat(n)}<i>${'★'.repeat(5 - n)}</i></span>`;
const el = e => `<span class="el" style="--el:${EL_COLOR[e]}">${EL[e]}</span>`;
const stats = s => `<div class="stats">${Object.entries(ST).map(([k, l]) =>
  `<span>${l}</span><span class="meter${s[k] > 1.001 ? ' up' : ''}"><i style="width:${((s[k] - .7) / .6 * 100).toFixed(0)}%"></i></span><span class="v">×${s[k].toFixed(2)}</span>`).join('')}</div>`;
const api = async (path, opt) => {
  const r = await fetch(path, { cache: 'no-store', ...opt, headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(r.status);
  return r.json();
};
const canvasOf = (bmp, long) => {
  const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height, k = Math.min(1, long / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
};

// any photo: createImageBitmap first; where it can't decode the file (HEIC in Chrome), the browser's own <img> decoder
async function decode(f) {
  try { return await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch {}
  const url = URL.createObjectURL(f), img = new Image();
  try { img.src = url; await img.decode(); return img; }
  catch { throw new Error('この写真の形式は読めません。JPEG か PNG で撮り直してください'); }
  finally { URL.revokeObjectURL(url); }
}

export function mountSticks(root) {
  root.classList.add('stk');
  root.innerHTML = `
    <div class="main">
      <section class="card">
        <header><h2>枝をスキャン</h2><span class="sub">無地の床や紙に置いて、全体を撮る</span></header>
        <div class="scan">
          <div class="well" data-photo>写真はまだありません</div>
          <div class="res" data-res></div>
        </div>
      </section>
      <section class="card">
        <header><h2>保存した枝</h2><span class="sub num" data-count></span></header>
        <div class="list" data-list></div>
      </section>
    </div>
    <aside>
      <section class="card">
        <header><h2>プレイヤーの枝</h2></header>
        <div data-players></div>
        <p class="msg" data-err></p>
      </section>
      <section class="card">
        <header><h2>★ごとの強さ</h2></header>
        <p class="sub" style="margin:0 0 8px">4つの能力の平均です。1 で今と同じ。</p>
        <div class="mul" data-mul></div>
        <p class="msg" data-mulmsg></p>
      </section>
    </aside>
    <dialog class="stkdlg" data-dlg aria-label="枝を編集"></dialog>
    <input type="file" accept="image/*" data-file style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none" tabindex="-1" aria-hidden="true">`;
  const $ = s => root.querySelector(`[data-${s}]`);
  const err = t => { $('err').textContent = t; };

  // ---- scan ----
  let scan = null; // { features, image } of the photo on screen, not yet saved
  const idle = () => { $('res').innerHTML = `<button class="go shot" data-act="pick">写真を撮る</button><p class="why">撮るか、写真を選ぶ。</p>`; };
  $('file').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const bmp = await decode(f);
      const small = canvasOf(bmp, 256), { features } = analyzeStick(small.getContext('2d').getImageData(0, 0, small.width, small.height));
      const big = canvasOf(bmp, 800);
      let image = big.toDataURL('image/jpeg', .82); // ~100–200 KB; the server takes up to 1 MB, so a noisy photo is squeezed until it fits
      for (const q of [.7, .55, .4]) if (image.length > 1.2e6) image = big.toDataURL('image/jpeg', q);
      scan = { features, image };
      $('photo').innerHTML = `<img src="${image}" alt="撮った枝">`;
      const odd = features.coverage < .005 || features.coverage > .6;
      $('res').innerHTML = `
        <h3>形</h3>
        <p class="why">${stickReasons(features).map(esc).join('・')}<br><span class="muted num">形の点 ${Math.round(shapeScore(features) * 100)} / 100</span></p>
        ${odd ? '<p class="why warn">枝がうまく見えません。<br>無地の上で撮り直してください。</p>' : ''}
        <input type="text" maxlength="24" placeholder="名前（なくてもよい）" data-name>
        <div class="use"><button class="go" data-act="save">スキャンする</button><button data-act="pick">撮り直す</button></div>`;
    } catch (e) { $('res').innerHTML = `<p class="why bad">読めませんでした（${esc(e.message)}）</p><button data-act="pick">もう一度</button>`; }
  };
  async function save(b) {
    if (!scan) return;
    b.disabled = true;
    try {
      const s = await api('/sticks', { method: 'POST', body: JSON.stringify({ name: $('name').value, ...scan }) });
      scan = null;
      $('res').innerHTML = `
        <div class="who"><b>${esc(s.name)}</b>${el(s.element)}</div>
        ${stars(s.rarity)}
        ${stats(s.stats)}
        <p class="why">${stickReasons(s.features).map(esc).join('・')}</p>
        <div class="use"><button data-use="A" data-id="${s.id}">Aに使う</button><button data-use="B" data-id="${s.id}">Bに使う</button></div>
        <button data-act="pick">次の枝を撮る</button>`;
      await refresh();
    } catch (e) { b.disabled = false; err(`保存できませんでした（${e.message}）`); }
  }

  // ---- players, saved sticks; editing one by hand (PATCH /sticks/<id>) ----
  let sticks = [];
  const dlg = $('dlg');
  const editor = s => `<form method="dialog" class="edit" data-form="${s.id}">
    <h2>枝を編集</h2>
    <label>名前<input type="text" maxlength="24" data-f="name" value="${esc(s.name)}"></label>
    <label>属性<select data-f="element">${Object.entries(EL).map(([k, l]) => `<option value="${k}"${k === s.element ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>レア度<select data-f="rarity">${[1, 2, 3, 4, 5].map(n => `<option value="${n}"${n === s.rarity ? ' selected' : ''}>${'★'.repeat(n)}</option>`).join('')}</select></label>
    ${Object.entries(ST).map(([k, l]) => `<label>${l}<input type="number" class="num" min="0.5" max="2" step="0.05" data-f="${k}" value="${s.stats[k].toFixed(2)}"></label>`).join('')}
    <p class="msg" data-editmsg>${s.custom ? '手で決めた能力です' : 'スキャンで決まった能力です'}</p>
    <div class="use"><button type="button" class="go" data-save="${s.id}">保存</button>${s.custom ? `<button type="button" data-auto="${s.id}">自動に戻す</button>` : ''}<button value="cancel">閉じる</button></div>
  </form>`;
  const openEditor = id => { const s = sticks.find(x => x.id === id); if (!s) return; dlg.innerHTML = editor(s); dlg.showModal(); };
  async function saveEdit(id, auto) {
    const f = root.querySelector(`[data-form="${id}"]`), v = n => f.querySelector(`[data-f="${n}"]`).value;
    const body = { name: v('name'), element: v('element'), rarity: +v('rarity'), stats: auto ? null : Object.fromEntries(Object.keys(ST).map(k => [k, +v(k)])) };
    try { await api('/sticks/' + id, { method: 'PATCH', body: JSON.stringify(body) }); dlg.close(); await refresh(); }
    catch (e) { f.querySelector('[data-editmsg]').textContent = `保存できませんでした（${e.message}）`; }
  }

  // ---- players, saved sticks ----
  async function refresh() {
    const [list, as] = await Promise.all([api('/sticks'), api('/sticks/assign')]); sticks = list;
    $('players').innerHTML = ['A', 'B'].map(p => `<div class="slot" style="--team:var(--${p})"><b>${p}</b>${as[p]
      ? `<span class="nm">${esc(as[p].name)}<br>${stars(as[p].rarity)} ${el(as[p].element)}</span><button data-use="${p}" data-id="">外す</button>`
      : '<span class="none">枝なし（今の属性のまま）</span><span></span>'}</div>`).join('');
    $('count').textContent = list.length ? `${list.length} 本` : '';
    $('list').innerHTML = list.length ? list.slice().reverse().map(s => {
      const who = ['A', 'B'].filter(p => as[p]?.id === s.id);
      return `<div class="tile${who.length ? ' inuse' : ''}">
        <img src="${esc(s.image)}" alt="" loading="lazy">
        <div class="body">
          <span class="nm">${esc(s.name)}</span>
          <span>${stars(s.rarity)} ${el(s.element)}</span>
          <span class="tag">${who.length ? who.join('・') + ' が使用中' : '&nbsp;'}</span>
          <div class="use"><button data-use="A" data-id="${s.id}">A</button><button data-use="B" data-id="${s.id}">B</button><button class="del" data-edit="${s.id}" aria-haspopup="dialog">編集</button><button class="del" data-del="${s.id}" data-label="${esc(s.name)}" aria-label="${esc(s.name)}を消す">消す</button></div>
        </div></div>`;
    }).join('') : '<p class="muted" style="margin:0">まだありません。撮ると、ここに並びます。</p>';
  }
  root.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    err('');
    try {
      if (b.dataset.act === 'pick') $('file').click();
      else if (b.dataset.act === 'save') await save(b);
      else if (b.dataset.edit) openEditor(b.dataset.edit);
      else if (b.dataset.save) await saveEdit(b.dataset.save, false);
      else if (b.dataset.auto) await saveEdit(b.dataset.auto, true);
      else if (b.dataset.use) { await api('/sticks/assign', { method: 'POST', body: JSON.stringify({ [b.dataset.use]: b.dataset.id || null }) }); await refresh(); }
      else if (b.dataset.del && confirm(`「${b.dataset.label}」を消しますか？`)) { await api('/sticks/' + b.dataset.del, { method: 'DELETE' }); await refresh(); }
    } catch (e) { err(`できませんでした（${e.message}）`); }
  });

  // ---- rarityMul in /rules (rules.json): read the whole object, change only rarityMul, write it back ----
  const getRules = async () => { const r = await fetch('/rules', { cache: 'no-store' }); return r.status === 404 ? {} : r.ok ? r.json() : Promise.reject(new Error(r.status)); };
  async function showMul() {
    const m = cleanRarityMul((await getRules())?.rarityMul);
    $('mul').innerHTML = m.map((v, i) => `<label>${stars(i + 1)}<input type="number" class="num" min="0.7" max="1.3" step="0.05" value="${v}"></label>`).join('')
      + '<div class="row" style="margin-top:6px"><button class="go" data-mulsave>保存する</button></div>';
    $('mulsave').onclick = async () => {
      try {
        const rules = (await getRules()) ?? {};
        rules.rarityMul = cleanRarityMul([...root.querySelectorAll('[data-mul] input')].map(i => +i.value));
        await api('/rules', { method: 'POST', body: JSON.stringify(rules) });
        $('mulmsg').textContent = '保存しました（' + new Date().toLocaleTimeString() + '）'; await showMul(); await refresh();
      } catch (e) { $('mulmsg').textContent = `保存できませんでした（${e.message}）`; }
    };
  }
  idle();
  refresh().catch(e => err(`読めませんでした（${e.message}）`));
  showMul().catch(e => { $('mulmsg').textContent = `読めませんでした（${e.message}）`; });
  return { refresh };
}
