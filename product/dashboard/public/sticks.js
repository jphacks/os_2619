// 棒設定 (screen 5 of the dashboard): the saved sticks. Each 3D model built from a phone's Scan (stickui.js) is saved here with one of its
// photos and goes to the phone that scanned it; its power and speed come from its wood volume (stick-stats.js). Here: which stick
// players A / B use, and each stick's name, element, power and speed by hand (or back to the scan's shape/volume). HP and the charge time are the
// same for every stick (the game screen's rules).
// mountSticks(root) draws into root.
import { STAT_RANGE } from './stick-stats.js';

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const EL = { fire: '炎', thunder: '雷', water: '水', wind: '風' };
const EL_COLOR = { fire: '#ff7a1a', thunder: '#ffd23d', water: '#2f7dff', wind: '#d8f4f2' }; // the effects' colours (app.js)
const ST = { power: '威力', speed: '弾速' };
const el = e => `<span class="el" style="--el:${EL_COLOR[e]}">${EL[e]}</span>`;
// meters on a log scale over STAT_RANGE: ×1.00 (today's value) sits in the middle
const pos = v => Math.log(v / STAT_RANGE[0]) / Math.log(STAT_RANGE[1] / STAT_RANGE[0]) * 100;
const stats = s => `<div class="stats">${Object.entries(ST).map(([k, l]) =>
  `<span>${l}</span><span class="meter${s[k] > 1.001 ? ' up' : ''}"><i style="width:${pos(s[k]).toFixed(0)}%"></i></span><span class="v">×${s[k].toFixed(2)}</span>`).join('')}</div>`;
const size = s => s.model ? `${(s.model.length * 100).toFixed(0)} cm・${s.volume} cm³` : '3D モデルなし';
const api = async (path, opt) => {
  const r = await fetch(path, { cache: 'no-store', ...opt, headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(r.status);
  return r.json();
};

export function mountSticks(root) {
  root.classList.add('stk');
  root.innerHTML = `
    <div class="main">
      <section class="card">
        <header><h2>保存した棒</h2><span class="sub num" data-count></span></header>
        <p class="sub" style="margin:0 0 10px">スマホの「Scan」で 3D モデルを作ると、形から属性を判定してここに保存します。枝分かれが多いと電気（雷）、まっすぐなら炎、滑らかに曲がると風、くねると水です。「反映」で撮ったスマホの棒になります。</p>
        <div class="list" data-list></div>
      </section>
    </div>
    <aside>
      <section class="card">
        <header><h2>プレイヤーの棒</h2></header>
        <div data-players></div>
        <p class="msg" data-err></p>
      </section>
      <section class="card">
        <header><h2>強さの決まり方</h2></header>
        <p class="sub" style="margin:0">体積が大きい棒ほど威力が高く、弾は少し遅くなります（威力 × 弾速² がどの棒も同じ）。
          体積 350 cm³ で ×1.00。体力 100・大までの溜め 3 秒はどの棒も同じです。数値は各棒の「編集」で変えられます。</p>
      </section>
    </aside>
    <dialog class="stkdlg" data-dlg aria-label="棒を編集"></dialog>`;
  const $ = s => root.querySelector(`[data-${s}]`);
  const err = t => { $('err').textContent = t; };

  // ---- editing one by hand (PATCH /sticks/<id>) ----
  let sticks = [];
  const dlg = $('dlg');
  const editor = s => `<form method="dialog" class="edit" data-form="${s.id}">
    <h2>棒を編集</h2>
    <label>名前<input type="text" maxlength="24" data-f="name" value="${esc(s.name)}"></label>
    <label>属性<select data-f="element">${Object.entries(EL).map(([k, l]) => `<option value="${k}"${k === s.element ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    ${Object.entries(ST).map(([k, l]) => `<label>${l}<input type="number" class="num" min="${STAT_RANGE[0]}" max="${STAT_RANGE[1]}" step="0.05" data-f="${k}" value="${s.stats[k].toFixed(2)}"></label>`).join('')}
    <p class="msg" data-editmsg>${s.custom ? '手で決めた値です' : s.model ? `体積 ${s.volume} cm³ から決まった値です` : '3D モデルのない棒です（×1.00）'}</p>
    <div class="use"><button type="button" class="go" data-save="${s.id}">保存</button>${s.custom ? `<button type="button" data-auto="${s.id}">自動に戻す</button>` : ''}<button value="cancel">閉じる</button></div>
  </form>`;
  const openEditor = id => { const s = sticks.find(x => x.id === id); if (!s) return; dlg.innerHTML = editor(s); dlg.showModal(); };
  async function saveEdit(id, auto) {
    const f = root.querySelector(`[data-form="${id}"]`), v = n => f.querySelector(`[data-f="${n}"]`).value;
    const body = { name: v('name'), element: v('element'), stats: auto ? null : Object.fromEntries(Object.keys(ST).map(k => [k, +v(k)])) };
    try { await api('/sticks/' + id, { method: 'PATCH', body: JSON.stringify(body) }); dlg.close(); await refresh(); }
    catch (e) { f.querySelector('[data-editmsg]').textContent = `保存できませんでした（${e.message}）`; }
  }

  // ---- players, saved sticks ----
  async function refresh() {
    const [list, as] = await Promise.all([api('/sticks'), api('/sticks/assign')]); sticks = list;
    $('players').innerHTML = ['A', 'B'].map(p => `<div class="slot" style="--team:var(--${p})"><b>${p}</b>${as[p]
      ? `<span class="nm">${esc(as[p].name)} ${el(as[p].element)}<br>${stats(as[p].stats)}</span><button data-use="${p}" data-id="">外す</button>`
      : '<span class="none">棒なし（いつもの棒・今の属性）</span><span></span>'}</div>`).join('');
    $('count').textContent = list.length ? `${list.length} 本` : '';
    $('list').innerHTML = list.length ? list.slice().reverse().map(s => {
      const who = ['A', 'B'].filter(p => as[p]?.id === s.id);
      return `<div class="tile${who.length ? ' inuse' : ''}">
        ${s.image ? `<img src="${esc(s.image)}" alt="" loading="lazy">` : '<div class="noimg">写真なし</div>'}
        <div class="body">
          <span class="nm">${esc(s.name)}</span>
          <span>${el(s.element)} <span class="muted num">${size(s)}</span></span>
          ${stats(s.stats)}
          <span class="tag">${who.length ? who.join('・') + ' が使用中' : s.custom ? '手で調整済み' : '&nbsp;'}</span>
          <div class="use"><button data-use="A" data-id="${s.id}">A</button><button data-use="B" data-id="${s.id}">B</button><button class="del" data-edit="${s.id}" aria-haspopup="dialog">編集</button><button class="del" data-del="${s.id}" data-label="${esc(s.name)}" aria-label="${esc(s.name)}を消す">消す</button></div>
        </div></div>`;
    }).join('') : '<p class="muted" style="margin:0">まだありません。スマホの「Scan」で作ると、ここに並びます。</p>';
  }
  root.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    err('');
    try {
      if (b.dataset.edit) openEditor(b.dataset.edit);
      else if (b.dataset.save) await saveEdit(b.dataset.save, false);
      else if (b.dataset.auto) await saveEdit(b.dataset.auto, true);
      else if (b.dataset.use) { await api('/sticks/assign', { method: 'POST', body: JSON.stringify({ [b.dataset.use]: b.dataset.id || null }) }); await refresh(); }
      else if (b.dataset.del && confirm(`「${b.dataset.label}」を消しますか？`)) { await api('/sticks/' + b.dataset.del, { method: 'DELETE' }); await refresh(); }
    } catch (e) { err(`できませんでした（${e.message}）`); }
  });
  refresh().catch(e => err(`読めませんでした（${e.message}）`));
  return { refresh };
}
