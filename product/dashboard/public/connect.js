// 接続: how to connect, and everything each phone sends, as the sensing dashboard shows it.
//  - phones A / B (SensorLink app): the tags its chest camera detects (where they sit in its frame; no picture is sent), stream rates and latency, IMU orientation /
//    gyro / acceleration charts, calibrated IMU axes, ARCore state + top-down track, AprilTag table
//  - phone C (cam.html in the browser): live picture, WebRTC / JPEG, fps, bitrate, delay; video source switch
//  - server: IP and port to type into the app, QR codes for phone C's page and the certificate page
//  - sidebar: the four detected actions (sensing actions.js) with the last time each fired, stick length, history
import { ACTIONS } from './actions.js';
import * as W from './world.js';
import { SOURCES } from './video.js';

const WINDOW = 10; // seconds shown in the IMU charts
const now = () => Date.now() / 1000;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = v => String(v).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const who = { A: '--A', B: '--B' };
export const ACTION_JA = { Charge: '溜め', Swing: '振り', Dodge: '回避', Guard: 'ガード' };
const HOW_JA = {
  Charge: '棒を真上から 45° 以内に立てて先を 2 秒以内に 1 周回すか、1 秒に 5 回以上（60°/秒超）向きを変えて揺らす。続けるのは 4 回（30°/秒超）でよい',
  Swing: '棒が 300°/秒より速く回って止まる。向きと始め・終わりの位置',
  Dodge: '胸のスマホが 1.2 m/秒より速く動く。左・右・後ろ・前',
  Guard: '棒を水平から 45° 以内で 1 秒静止（60°/秒未満）',
};
const DIR_JA = { up: '上', down: '下', left: '左', right: '右', forward: '前', back: '後ろ' };
const dirJa = d => (d ?? '').split('-').map(w => DIR_JA[w] ?? w).join('');
/** actions.js details are English: rebuild them in Japanese from the event's fields and numbers. */
export function detailJa(ev) {
  const d = ev.detail ?? '';
  if (ev.name === 'Charge') return /counter/.test(d) ? '反時計回り（上から見て）' : '時計回り（上から見て）';
  if (ev.name === 'Swing') { const m = d.match(/(\d+)° in (\d+) ms/); return `${dirJa(ev.dir) || '—'}へ${m ? ` ${m[1]}° を ${m[2]} ms` : ''} · 強さ ${Math.round((ev.power ?? 0) * 100)}%`; }
  if (ev.name === 'Dodge') return `${dirJa(ev.dir)}へ ${(ev.speed ?? 0).toFixed(1)} m/秒`;
  if (ev.name === 'Guard') { const m = d.match(/elev (-?\d+)°, heading (-?\d+)°/); return `1 秒静止${m ? ` · 仰角 ${m[1]}° 方位 ${m[2]}°` : ''}`; }
  return d;
}

export function createConnect({ cards, side, hub, vsrc, cfg, onStick, onVideoSrc }) {
  const slots = {};
  const tpl = s => `
    <section class="card phone ${s}">
      <header><h2 style="color:var(--${s})">スマホ ${s}</h2><span class="sub name">未接続</span><span class="badge off state">オフライン</span><span class="sub">${s === 'A' ? '炎' : '雷'}</span></header>
      <div class="cols">
        <div>
          <canvas class="video" width="480" height="640" aria-label="胸カメラが検出したタグ（画面内の位置）"></canvas>
          <h3>ストリーム</h3>
          <table class="rates"><thead><tr><th>種類</th><th>Hz</th><th>遅延</th></tr></thead><tbody></tbody></table>
        </div>
        <div>
          <h3>IMU の姿勢（°）</h3>
          <div class="crow"><div><div class="legend euler"></div><canvas class="chart euler" aria-label="ピッチ・ロール・ヨー 直近 10 秒"></canvas></div>
            <canvas class="square orient" aria-label="キャリブ後の IMU の軸"></canvas></div>
          <h3>IMU 角速度（°/秒）</h3>
          <div class="legend gyro"></div><canvas class="chart gyro" aria-label="角速度 直近 10 秒"></canvas>
          <h3>IMU 加速度（m/s²）</h3>
          <div class="legend acc"></div><canvas class="chart acc" aria-label="加速度 直近 10 秒"></canvas>
          <h3>ARCore <span class="badge off ar">—</span></h3>
          <div class="crow"><div class="kv arinfo">データなし</div><canvas class="square traj" aria-label="AR の軌跡（上から）"></canvas></div>
          <h3>AprilTag</h3>
          <table class="tags"><thead><tr><th>ID</th><th>x</th><th>y</th><th>z (m)</th><th>距離</th></tr></thead><tbody></tbody></table>
        </div>
      </div>
    </section>`;
  for (const s of ['A', 'B']) {
    cards.insertAdjacentHTML('beforeend', tpl(s));
    const el = cards.lastElementChild, q = c => el.querySelector(c);
    slots[s] = { el, q, imu: [], traj: [] };
    // euler[0] is WitMotion's "roll" (about sensor X), but on the mounted sensor that reads as pitch, so the labels are swapped
    for (const [k, names] of [['euler', ['ピッチ', 'ロール', 'ヨー']], ['gyro', ['x', 'y', 'z']], ['acc', ['x', 'y', 'z']]])
      q('.legend.' + k).innerHTML = names.map((n, i) => `<span><i style="background:var(--s${i + 1})"></i>${n} <b data-i="${i}">–</b></span>`).join('');
  }

  // ---- phone C ----
  cards.insertAdjacentHTML('beforeend', `
    <section class="card phone C">
      <header><h2 style="color:var(--C)">スマホ C</h2><span class="sub">第三者視点カメラ（ブラウザ）</span><span class="badge off cstate">未接続</span></header>
      <div class="cols">
        <div><video class="cvideo" muted playsinline autoplay></video><div class="kv cmsg" style="margin-top:6px"></div></div>
        <div>
          <h3>映像の入力</h3><div class="seg vsrc">${Object.entries(SOURCES).map(([k, v]) => `<button data-v="${k}">${v}</button>`).join('')}</div>
          <div class="row localrow" style="margin-top:6px"><select class="dev" style="max-width:100%"></select></div>
          <h3>受信</h3><table class="cstats"><tbody></tbody></table>
          <div class="row" style="margin-top:8px"><button class="jpeg">JPEG に切り替え</button><button class="webrtc">WebRTC に戻す</button></div>
        </div>
      </div>
    </section>`);
  const C = cards.lastElementChild, cq = c => C.querySelector(c);
  const cvideo = cq('.cvideo');
  for (const b of C.querySelectorAll('.vsrc button')) b.onclick = () => onVideoSrc(b.dataset.v);
  cq('.dev').onchange = e => vsrc.set('local', e.target.value);
  cq('.jpeg').onclick = () => vsrc.jpeg(); cq('.webrtc').onclick = () => vsrc.webrtc();

  // ---- sidebar: server, actions, stick, history ----
  side.innerHTML = `
    <section class="card server"><header><h2>つなぎ方</h2><span class="sub">ポート 8000 ひとつ</span></header>
      <div class="urls kv"></div><div class="qrs"></div>
      <p class="kv" style="font-size:12px;margin:10px 0 0">A・B：SensorLink アプリの LAN 欄に IP とポート 8000 を入れて接続（先につないだ方が A）。C：ブラウザで QR のページを開いて「開始」。初回は証明書のページの手順で信頼させる。</p>
    </section>
    <section class="card"><header><h2>床のマーカー</h2><span class="sub">全体の設定（ID 0-3）</span></header>
      <div class="seg marker"><button data-v="april">AprilTag</button><button data-v="rune">RuneTag</button></div>
      <p class="kv" style="font-size:12px;margin:8px 0 0">AprilTag：200 mm の紙（黒い正方形 160 mm）。RuneTag：250 mm の紙（product/print/runetags_A3.pdf）。どちらも 4 枚を端から端まで並べる。切り替えるとサーバーが保存し、スマホ A・B に送り、開いているページは読み直す。胸のタグ 8-11 は AprilTag のまま。</p>
    </section>
    <section class="card"><header><h2>動作の判定</h2><span class="sub">棒の IMU と胸のスマホから</span></header>
      <ul class="actions"></ul>
      <h3>棒の軸</h3>
      <div class="kv">IMU の +Y が棒の先端の向き（固定）</div>
      <h3>棒の長さ（m）</h3>
      <div class="kv sticks"><label>A <input type="number" min="0.1" step="0.05" data-s="A"></label><label>B <input type="number" min="0.1" step="0.05" data-s="B"></label></div>
    </section>
    <section class="card"><header><h2>履歴</h2><span class="sub">新しい順</span></header><ul class="history"><li class="kv empty">まだありません</li></ul></section>`;
  const sq = c => side.querySelector(c);
  for (const b of side.querySelectorAll('.marker button')) {
    b.classList.toggle('on', b.dataset.v === W.MARKER);
    b.onclick = () => { if (b.dataset.v !== W.MARKER && confirm(`床のマーカーを ${b.textContent} に切り替えます（全体・ページは読み直し）`)) hub.send({ type: 'setMarker', marker: b.dataset.v }); };
  }
  for (const inp of side.querySelectorAll('.sticks input')) {
    inp.value = cfg.stickLen[inp.dataset.s];
    inp.oninput = () => { if (+inp.value > 0) onStick(inp.dataset.s, +inp.value); };
  }
  const actionRows = {};
  for (const a of ACTIONS) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${ACTION_JA[a.name]}</b> <span class="kv last" style="font-size:12px"></span><div class="how">${HOW_JA[a.name]}</div>`;
    sq('.actions').append(li);
    actionRows[a.name] = { li, last: {} };
  }
  const clock = t => { const d = new Date(t * 1000); return d.toLocaleTimeString('ja-JP', { hour12: false }) + '.' + Math.floor(d.getMilliseconds() / 100); };
  function logAction(ev) {
    const r = actionRows[ev.name]; if (!r) return;
    r.last[ev.slot] = ev.t;
    r.li.querySelector('.last').innerHTML = ['A', 'B'].map(s => `<span class="who" style="color:var(${who[s]})">${s}</span> ${r.last[s] ? clock(r.last[s]) : '–'}`).join(' · ');
    r.li.classList.add('hit'); setTimeout(() => r.li.classList.remove('hit'), 300);
    const list = sq('.history');
    list.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    li.innerHTML = `<span class="kv">${clock(ev.t)}</span><span class="who" style="color:var(${who[ev.slot]})">${ev.slot}</span><b>${ACTION_JA[ev.name]}</b><span class="detail">${esc(detailJa(ev))}</span>`;
    list.prepend(li);
    while (list.children.length > 200) list.lastChild.remove();
  }

  // ---- server info (QR codes) every few seconds ----
  let qrKey = '';
  async function info() {
    try {
      const i = await (await fetch('/info')).json(), ip = i.ips[0] ?? location.hostname;
      sq('.urls').innerHTML = `<span>IP</span><b>${i.ips.map(esc).join('<br>') || '（ネットワークなし）'}</b><span>ポート</span><b>${i.port}</b>
        <span>A・B</span><b>${esc(ip)} : ${i.port}</b><span>C</span><b>${i.https ? esc(i.urls.camera) : 'https が無効（openssl なし）'}</b><span>証明書</span><b>${esc(i.urls.trust)}</b>`;
      const key = i.urls.camera + i.urls.trust;
      if (key !== qrKey && window.qrcode) {
        qrKey = key;
        const qr = text => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };
        sq('.qrs').innerHTML = (i.https ? `<figure>${qr(i.urls.camera)}スマホ C のページ</figure>` : '') + `<figure>${qr(i.urls.trust)}証明書を信頼する</figure>`;
      }
    } catch { sq('.urls').textContent = 'サーバーの情報を取得できません'; }
  }
  info(); setInterval(info, 5000);

  // ---- data in ----
  function ingest(k) {
    const s = slots[k.slot]; if (!s) return;
    if (k.type === 'imu') { s.imu.push(k); while (s.imu.length && s.imu[0].t < k.t - WINDOW) s.imu.shift(); }
    if (k.type === 'ar' && k.tracking === 'TRACKING') { s.traj.push(k.p); if (s.traj.length > 600) s.traj.shift(); }
    if (k.type === 'calib') s.traj.length = 0;
  }

  // ---- drawing (from sensing/dashboard/index.html) ----
  function fit(c) { // match the backing store to the CSS size so lines stay crisp
    const d = devicePixelRatio, w = Math.round(c.clientWidth * d), h = Math.round(c.clientHeight * d);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
    return [g, c.clientWidth, c.clientHeight];
  }
  function chart(s, key, fixed) {
    const [g, w, h] = fit(s.q('canvas.' + key));
    g.clearRect(0, 0, w, h);
    const pts = s.imu, last = pts.at(-1);
    if (!last) return;
    let lo = fixed ? -fixed : Infinity, hi = fixed ? fixed : -Infinity;
    if (!fixed) for (const p of pts) for (const v of p[key]) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    const pad = 12, X = t => (t - last.t + WINDOW) / WINDOW * w, Y = v => pad + (hi - v) / (hi - lo) * (h - 2 * pad);
    g.strokeStyle = css('--grid'); g.lineWidth = 1; g.fillStyle = css('--muted'); g.font = '10px system-ui';
    for (const v of [lo, 0, hi]) if (v === lo || v === hi || Math.min(Y(lo) - Y(0), Y(0) - Y(hi)) > 12) { g.beginPath(); g.moveTo(0, Y(v)); g.lineTo(w, Y(v)); g.stroke(); g.fillText(v.toFixed(0), 2, Y(v) - 2); }
    g.lineWidth = 1.6; g.lineJoin = 'round';
    for (let i = 0; i < 3; i++) {
      g.strokeStyle = css(`--s${i + 1}`); g.beginPath();
      pts.forEach((p, j) => { const x = X(p.t), y = Y(p[key][i]); j ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    }
    s.q('.legend.' + key).querySelectorAll('b').forEach((b, i) => b.textContent = last[key][i].toFixed(key === 'acc' ? 1 : 0));
  }
  const rot = (q, v) => { // rotate v by quaternion q = [w, x, y, z]
    const [w, x, y, z] = q, [a, b, c] = v;
    const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c;
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  };
  function orient(s, k) {
    const [g, w, h] = fit(s.q('.orient'));
    g.clearRect(0, 0, w, h);
    if (!k) return;
    const r = w * 0.36, cx = w / 2, cy = h / 2;
    const P = v => [cx + r * (v[0] - 0.5 * v[1]), cy - r * (v[2] - 0.3 * v[1])]; // oblique view, sensor Z up
    g.strokeStyle = css('--grid'); g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
    g.font = '11px system-ui'; g.lineWidth = 2; g.lineCap = 'round';
    ['X', 'Y', 'Z'].forEach((n, i) => {
      const e = [0, 0, 0]; e[i] = 1;
      const [x, y] = P(rot(k.q, e));
      g.strokeStyle = css(`--s${i + 1}`); g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke();
      g.fillStyle = css('--text'); g.fillText(n, x + 3, y - 3);
    });
  }
  function traj(s, k) {
    const [g, w, h] = fit(s.q('.traj'));
    g.clearRect(0, 0, w, h);
    let m = 1; for (const p of s.traj) m = Math.max(m, Math.abs(p[0]), Math.abs(p[2]));
    const sc = w / 2 / (m * 1.1), X = v => w / 2 + v * sc, Z = v => h / 2 + v * sc;
    g.strokeStyle = css('--grid'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.stroke();
    g.fillStyle = css('--muted'); g.font = '10px system-ui'; g.fillText(`±${(m * 1.1).toFixed(1)} m`, 2, 10);
    g.strokeStyle = css('--s1'); g.lineWidth = 1.6; g.beginPath();
    s.traj.forEach((p, i) => i ? g.lineTo(X(p[0]), Z(p[2])) : g.moveTo(X(p[0]), Z(p[2]))); g.stroke();
    if (!k) return;
    const f = rot([k.q[3], k.q[0], k.q[1], k.q[2]], [0, 0, -1]); // camera looks down its -Z
    const x = X(k.p[0]), z = Z(k.p[2]);
    g.fillStyle = g.strokeStyle = css('--s2'); g.beginPath(); g.arc(x, z, 4, 0, 7); g.fill();
    g.beginPath(); g.moveTo(x, z); g.lineTo(x + f[0] * 18, z + f[2] * 18); g.stroke();
  }
  function videoView(s, ph) {
    const c = s.q('canvas.video'), g = c.getContext('2d');
    const w = c.width, h = c.height, lw = Math.max(2, w / 200);
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    if (!ph.online) { g.fillStyle = '#666'; g.font = `${w / 18}px system-ui`; g.fillText('未接続', w * 0.06, h / 2); }
    const fresh = k => k && now() - k.rx < 0.5; // don't leave stale detections on screen
    g.lineWidth = lw; g.font = `${w / 22}px system-ui`;
    const tg = ph.last.tags;
    if (fresh(tg)) for (const t of tg.tags) {
      g.strokeStyle = '#3f3'; g.beginPath(); t.c.forEach(([x, y], i) => i ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h)); g.closePath(); g.stroke();
      g.fillStyle = '#3f3'; g.fillText(`ID ${t.id}${t.p ? ' ' + (t.p[2] * W.tagScale(t.id, t.sz)).toFixed(2) + 'm' : ''}`, t.c[0][0] * w, t.c[0][1] * h - 6);
    }
  }
  function panels(s, ph, rates) {
    const st = s.q('.state'); st.textContent = ph.online ? 'オンライン' : 'オフライン'; st.className = 'badge state ' + (ph.online ? 'ok' : 'off');
    s.q('.name').textContent = ph.online ? `${ph.name}${ph.addr ? ' · ' + ph.addr : ''}` : '未接続';
    const ar = ph.last.ar, b = s.q('.badge.ar');
    if (ar) {
      b.textContent = { TRACKING: '追跡中', PAUSED: '一時停止', STOPPED: '停止' }[ar.tracking] ?? ar.tracking; if (ar.reason && ar.reason !== 'NONE') b.textContent += ` · ${ar.reason}`;
      b.className = 'badge ar ' + (ar.tracking === 'TRACKING' ? 'ok' : ar.tracking === 'PAUSED' ? 'warn' : 'bad');
      s.q('.arinfo').innerHTML = `x ${ar.p[0].toFixed(2)} &nbsp;y ${ar.p[1].toFixed(2)} &nbsp;z ${ar.p[2].toFixed(2)} m<br>平面 ${ar.planes}${ar.wp ? '' : '<br><span class="warn">wp/wq なし（旧アプリ）</span>'}`;
    } else { b.textContent = '—'; b.className = 'badge ar off'; s.q('.arinfo').textContent = 'データなし'; }
    const tg = ph.last.tags;
    s.q('.tags tbody').innerHTML = (tg?.tags ?? []).map(t => t.p
      ? `<tr><td>${esc(t.id)}</td>${t.p.map(v => `<td>${(v * W.tagScale(t.id, t.sz)).toFixed(2)}</td>`).join('')}<td>${(Math.hypot(...t.p) * W.tagScale(t.id, t.sz)).toFixed(2)}</td></tr>`
      : `<tr><td>${esc(t.id)}</td><td colspan=4>姿勢なし</td></tr>`).join('') || '<tr><td colspan=5 class=kv>見えていない</td></tr>';
    s.q('.rates tbody').innerHTML = Object.entries(rates).sort().map(([k, r]) =>
      `<tr><td>${esc(k)}</td><td>${r.hz.toFixed(0)}</td><td>${ph.lat[k] == null ? '–' : (ph.lat[k] * 1000).toFixed(0) + ' ms'}</td></tr>`).join('');
  }
  let devKey = '';
  function cPanel() {
    const st = vsrc.state, stats = vsrc.stats(), v = vsrc.video;
    if (cvideo.srcObject !== v.srcObject) cvideo.srcObject = v.srcObject;
    for (const b of C.querySelectorAll('.vsrc button')) b.classList.toggle('on', b.dataset.v === st.mode);
    cq('.localrow').style.display = st.mode === 'local' ? '' : 'none';
    const dk = st.devices.map(d => d.id).join();
    if (dk !== devKey) { devKey = dk; cq('.dev').innerHTML = st.devices.map(d => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join(''); }
    const camOn = st.mode === 'remote' ? !!st.cam : !!v.videoWidth;
    const badge = cq('.cstate'); badge.textContent = st.mode === 'remote' ? (st.cam ? ({ webrtc: 'WebRTC', jpeg: 'JPEG', connecting: '接続中' }[st.camState] ?? '接続済み') : '未接続') : SOURCES[st.mode] ?? '-';
    badge.className = 'badge cstate ' + (camOn && v.videoWidth ? 'ok' : camOn ? 'warn' : 'off');
    cq('.cmsg').textContent = st.msg;
    const rows = [['解像度', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '-']];
    if (st.mode === 'remote') rows.push(['端末', st.cam?.name ?? '-'], ['方式', stats?.mode ?? '-'], ['fps', stats?.fps ?? '-'], ['ビットレート', stats?.kbps ? (stats.kbps / 1000).toFixed(1) + ' Mbps' : '-'],
      ['遅延', isFinite(stats?.latencyMs) ? stats.latencyMs.toFixed(0) + ' ms' : '-'], ['コーデック', stats?.codec || '-']);
    cq('.cstats tbody').innerHTML = rows.map(([a, b]) => `<tr><td class="muted">${a}</td><td>${esc(b)}</td></tr>`).join('');
  }

  let lastSlow = 0;
  return {
    ingest, logAction,
    frame() { // every animation frame while visible
      const slow = now() - lastSlow > 0.1; if (slow) lastSlow = now();
      for (const s of ['A', 'B']) {
        const S = slots[s], ph = hub.phones[s];
        videoView(S, ph); chart(S, 'euler', 180); chart(S, 'gyro'); chart(S, 'acc'); orient(S, ph.last.imu); traj(S, ph.last.ar);
        if (slow) panels(S, ph, hub.rates(s));
      }
      if (slow) cPanel();
    },
  };
}
