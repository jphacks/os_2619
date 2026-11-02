// sticks.html: photograph a branch → measure its shape here (stick-analyze.js) → the server rolls the seed and saves it.
// Also: the saved sticks, which one players A / B use, and rules.rarityMul (merged into /rules without touching other keys).
import { analyzeStick, shapeScore, stickReasons } from './stick-analyze.js';
import { cleanRarityMul } from './stick-stats.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const EL = { fire: '炎', thunder: '雷', water: '水', wind: '風' };
const ST = { hp: '体力', power: '威力', speed: '速さ', charge: '溜め' };
const stars = n => `<span class="stars" aria-label="★${n}">${'★'.repeat(n)}<i>${'★'.repeat(5 - n)}</i></span>`;
const bars = s => `<div class="bars">${Object.entries(ST).map(([k, l]) =>
  `<span>${l}</span><span class="bar"><b style="width:${((s[k] - .7) / .6 * 100).toFixed(0)}%"></b></span><span>×${s[k].toFixed(2)}</span>`).join('')}</div>`;
const api = async (path, opt) => {
  const r = await fetch(path, { cache: 'no-store', ...opt, headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(r.status);
  return r.json();
};

// ---- 1. scan ----
let scan = null; // { features, image } of the photo on screen, not yet saved
const canvasOf = (bmp, long) => {
  const k = Math.min(1, long / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
};
$('#file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const out = $('#result');
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const small = canvasOf(bmp, 256), { features } = analyzeStick(small.getContext('2d').getImageData(0, 0, small.width, small.height));
    const image = canvasOf(bmp, 800).toDataURL('image/jpeg', .82); // ~100–200 KB, the server takes up to 1 MB
    scan = { features, image };
    $('#photo').innerHTML = `<img src="${image}" alt="撮った枝">`;
    const odd = features.coverage < .005 || features.coverage > .6;
    out.innerHTML = `
      <p>${stickReasons(features).map(esc).join('・')}<br><span class="muted">形の点 ${Math.round(shapeScore(features) * 100)} / 100</span></p>
      ${odd ? '<p class="bad">枝がうまく見えない。<br>無地の上で撮り直す。</p>' : ''}
      <p><input type="text" class="name" id="name" maxlength="24" placeholder="名前（なくてよい）"></p>
      <p><button class="go" id="save">スキャンする</button></p>`;
    $('#save').onclick = save;
  } catch (err) { out.innerHTML = `<p class="bad">読めなかった（${esc(err.message)}）</p>`; }
};
async function save() {
  if (!scan) return;
  $('#save').disabled = true;
  try {
    const s = await api('/sticks', { method: 'POST', body: JSON.stringify({ name: $('#name').value, ...scan }) });
    scan = null;
    $('#result').innerHTML = `
      <p><strong class="name">${esc(s.name)}</strong></p>
      <p>${stars(s.rarity)}<span class="el">${EL[s.element]}</span></p>
      ${bars(s.stats)}
      <p class="muted">${stickReasons(s.features).map(esc).join('・')}</p>
      <p><button data-use="A" data-id="${s.id}">Aに使う</button> <button data-use="B" data-id="${s.id}">Bに使う</button></p>`;
    await refresh();
  } catch (err) { $('#save').disabled = false; $('#result').insertAdjacentHTML('beforeend', `<p class="bad">保存できなかった（${esc(err.message)}）</p>`); }
}

// ---- 2. players, 3. list ----
async function refresh() {
  const [list, as] = await Promise.all([api('/sticks'), api('/sticks/assign')]);
  $('#players').innerHTML = ['A', 'B'].map(p => `<div class="slot"><strong>${p}</strong>${as[p]
    ? `<span>${esc(as[p].name)}</span>${stars(as[p].rarity)}<span>${EL[as[p].element]}</span><button data-use="${p}" data-id="">外す</button>`
    : '<span class="muted">ふつうの枝</span>'}</div>`).join('');
  $('#list').innerHTML = list.length ? list.slice().reverse().map(s => {
    const who = ['A', 'B'].filter(p => as[p]?.id === s.id).join('・');
    return `<tr class="${who ? 'inuse' : ''}">
      <td class="pic"><img src="${esc(s.image)}" alt="" loading="lazy"></td>
      <td>${esc(s.name)}<br>${stars(s.rarity)} ${EL[s.element]}</td>
      <td class="st">${Object.entries(ST).map(([k, l]) => `${l} ×${s.stats[k].toFixed(2)}`).join('<br>')}</td>
      <td class="who">${who ? who + 'が使用中' : ''}</td>
      <td class="act"><button data-use="A" data-id="${s.id}">Aに使う</button><button data-use="B" data-id="${s.id}">Bに使う</button><button class="del" data-del="${s.id}" data-name="${esc(s.name)}">削除</button></td>
    </tr>`;
  }).join('') : '<tr><td class="muted">まだない</td></tr>';
}
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.use) { await api('/sticks/assign', { method: 'POST', body: JSON.stringify({ [b.dataset.use]: b.dataset.id || null }) }); await refresh(); }
    else if (b.dataset.del && confirm(`「${b.dataset.name}」を消す？`)) { await api('/sticks/' + b.dataset.del, { method: 'DELETE' }); await refresh(); }
  } catch (err) { alert('できなかった（' + err.message + '）'); }
});

// ---- 4. rarityMul in /rules (rules.json): read the whole object, change only rarityMul, write it back ----
const getRules = async () => { const r = await fetch('/rules', { cache: 'no-store' }); return r.status === 404 ? {} : r.ok ? r.json() : Promise.reject(new Error(r.status)); };
async function showMul() {
  const m = cleanRarityMul((await getRules())?.rarityMul);
  $('#mul').innerHTML = m.map((v, i) => `<label>★${i + 1} <input type="number" min="0.7" max="1.3" step="0.05" value="${v}" data-i="${i}"></label>`).join('')
    + '<button class="go" id="mulSave">保存する</button>';
  $('#mulSave').onclick = async () => {
    try {
      const rules = (await getRules()) ?? {};
      rules.rarityMul = cleanRarityMul([...document.querySelectorAll('#mul input')].map(i => +i.value));
      await api('/rules', { method: 'POST', body: JSON.stringify(rules) });
      $('#mulMsg').textContent = '保存した（' + new Date().toLocaleTimeString() + '）'; await showMul(); await refresh();
    } catch (err) { $('#mulMsg').textContent = '保存できなかった（' + err.message + '）'; }
  };
}
refresh().catch(err => { $('#list').innerHTML = `<tr><td class="bad">読めなかった（${esc(err.message)}）</td></tr>`; });
showMul().catch(err => { $('#mulMsg').textContent = '読めなかった（' + err.message + '）'; });
