// Controls that exist only for screen 4. Preview actions draw effects without
// changing the match, HP, hit detection, or firing a game projectile.
export const finalChargeTier = seconds => seconds < 2 ? 'small' : seconds < 5 ? 'medium' : 'large';

export function createFinalControls({ bar, stage, game, vsrc, cfg, save, scan, fullscreen, playable = null, vision = null }) {
  const $ = s => bar.querySelector(s);
  bar.innerHTML = `
    <div class="final-control-row">
      <strong class="final-control-title">炎の確認</strong>
      <div class="final-control-items">
        <select id="fireDirection" aria-label="炎の確認方向"><option value="A">A → B</option><option value="B">B → A</option></select>
        <button data-fire="small">炎 小</button><button data-fire="medium">炎 中</button><button data-fire="large">炎 大</button>
        <button id="firePause">炎を停止</button><button id="fireStep">炎を1コマ進める</button>
        <span id="fireTextureStatus" class="msg"></span>
      </div>
    </div>
    <div class="final-control-row">
      <strong class="final-control-title">電気の確認</strong>
      <div class="final-control-items">
        <select id="thunderDirection" aria-label="電気の確認方向"><option value="B">B → A</option><option value="A">A → B</option></select>
        <button data-thunder="small">電気 小</button><button data-thunder="medium">電気 中</button><button data-thunder="large">電気 大</button>
        <button id="thunderPause">電気を停止</button><button id="thunderStep">電気を1コマ進める</button>
        <span id="thunderTextureStatus" class="msg"></span>
      </div>
    </div>
    <div class="final-control-row">
      <strong class="final-control-title">映像の認識</strong>
      <div class="final-control-items">
        <button data-tog="visOn">認識を有効にする</button><button data-tog="visDraw">骨格・手・棒を表示</button><button data-tog="visGhost">人の残像</button><button data-tog="visSpot">二人の周りを暗く</button><button data-tog="visTrail">棒の残像</button>
        <span id="visionStatus" class="msg"></span>
      </div>
    </div>
    <div class="final-control-row">
      <strong class="final-control-title">チャージ</strong>
      <div class="final-control-items">
        <span class="kv" data-charge-status="A">炎：Aキー長押しでチャージ、離して発射</span>
        <span class="kv" data-charge-status="B">電気：Bキー長押しでチャージ、離して発射</span>
        <span id="chargeTextureStatus" class="msg"></span>
      </div>
    </div>
    <div class="final-control-row">
      <strong class="final-control-title">プレイヤーの動き</strong>
      <div class="final-control-items">
        <div id="finalPlay" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center"></div>
      </div>
    </div>
    <div class="final-control-row">
      <strong class="final-control-title">スキャン・表示</strong>
      <div class="final-control-items">
        <div class="final-shared-controls">
          <button id="scanBtn" class="go">タグでスキャン<kbd>K</kbd></button>
          <span class="kv" id="tagCheck"></span><span class="msg" id="finalMsg"></span>
          <div class="seg" id="fpvs"><button data-fpv="">第三者カメラ</button><button data-fpv="A">A の胸</button><button data-fpv="B">B の胸</button></div>
          <button data-tog="pip">小窓に 3D</button><button data-tog="mirrorX">3D の左右を反転</button><button data-tog="mirrorY">3D の上下を反転</button><button data-tog="swordFlip">剣の左右を逆にする</button><button id="fullBtn">全画面<kbd>F</kbd></button>
        </div>
      </div>
    </div>`;

  $('#scanBtn').onclick = scan;
  playable?.mountControl($('#finalPlay'));
  for (const b of bar.querySelectorAll('[data-fire]')) b.onclick = () => {
    const owner = $('#fireDirection').value, target = owner === 'A' ? 'B' : 'A';
    const from = game.players[owner], to = game.players[target];
    stage.fx.previewFire(b.dataset.fire, from.tip, to.chest, vsrc.dummy ? () => game.players[target].chest : null);
    $('#firePause').textContent = '炎を停止';
  };
  $('#firePause').onclick = () => {
    const paused = !stage.fx.stats().fire.preview.paused;
    stage.fx.controlFirePreview({ paused }); $('#firePause').textContent = paused ? '炎を再生' : '炎を停止';
  };
  $('#fireStep').onclick = () => { stage.fx.controlFirePreview({ step: 1 / 60 }); $('#firePause').textContent = '炎を再生'; };

  for (const b of bar.querySelectorAll('[data-thunder]')) b.onclick = () => {
    const owner = $('#thunderDirection').value, target = owner === 'A' ? 'B' : 'A';
    const from = game.players[owner], to = game.players[target];
    stage.fx.previewThunder(b.dataset.thunder, from.tip, to.chest, vsrc.dummy ? () => game.players[target].chest : null);
    $('#thunderPause').textContent = '電気を停止';
  };
  $('#thunderPause').onclick = () => {
    const paused = !stage.fx.stats().thunder.preview.paused;
    stage.fx.controlThunderPreview({ paused }); $('#thunderPause').textContent = paused ? '電気を再生' : '電気を停止';
  };
  $('#thunderStep').onclick = () => { stage.fx.controlThunderPreview({ step: 1 / 60 }); $('#thunderPause').textContent = '電気を再生'; };

  const chargeKeys = { a: 'A', b: 'B' };
  const charge = Object.fromEntries(['A', 'B'].map(slot => [slot, { seconds: 0, startedAt: 0, held: false }]));
  const active = () => bar.closest('.screen')?.classList.contains('active');
  const secondsAt = (s, time) => s.seconds + (s.held ? Math.max(0, time - s.startedAt) : 0);
  const tierJa = { small: '小', medium: '中', large: '大' };
  const keyFor = slot => slot;
  const updateChargeText = (slot, time) => {
    const s = charge[slot], seconds = secondsAt(s, time), tier = finalChargeTier(seconds);
    const label = bar.querySelector(`[data-charge-status="${slot}"]`);
    // the keyboard player's key goes to the match (playable.js), not to this preview
    if (playable?.keyboard(slot)) { label.textContent = `${slot === 'A' ? '炎' : '電気'}：${slot}キーは試合の溜め（キーボード操作中）`; label.classList.toggle('ok', playable.charging); return; }
    label.textContent = `${slot === 'A' ? '炎' : '電気'}：${keyFor(slot)}キー ${s.held ? `チャージ中 ${seconds.toFixed(1)}秒 ${tierJa[tier]}` : '長押しでチャージ、離して発射'}`;
    label.classList.toggle('ok', s.held || seconds > 0);
  };
  addEventListener('keydown', e => {
    if (!active() || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    const slot = chargeKeys[e.key.toLowerCase()]; if (!slot) return;
    e.preventDefault(); const s = charge[slot]; if (s.held) return;
    s.held = true; s.startedAt = performance.now() / 1000;
  });
  addEventListener('keyup', e => {
    const slot = chargeKeys[e.key.toLowerCase()]; if (!slot) return;
    const s = charge[slot]; if (!s.held) return;
    e.preventDefault();
    const time = performance.now() / 1000, target = slot === 'A' ? 'B' : 'A';
    const tier = finalChargeTier(secondsAt(s, time)), from = game.players[slot], to = game.players[target];
    if (from.element === 'fire') { stage.fx.previewFire(tier, from.tip, to.chest, vsrc.dummy ? () => game.players[target].chest : null); $('#firePause').textContent = '炎を停止'; }
    else { stage.fx.previewThunder(tier, from.tip, to.chest, vsrc.dummy ? () => game.players[target].chest : null); $('#thunderPause').textContent = '電気を停止'; }
    s.seconds = 0; s.startedAt = time; s.held = false;
  });

  for (const b of bar.querySelectorAll('[data-tog]')) b.onclick = () => { cfg[b.dataset.tog] = !cfg[b.dataset.tog]; save(); };
  for (const b of bar.querySelectorAll('[data-fpv]')) b.onclick = () => { cfg.fpv = b.dataset.fpv || null; save(); stage.resize(); stage.applyCam(); };
  $('#fullBtn').onclick = fullscreen;

  return {
    step(time) {
      for (const slot of ['A', 'B']) {
        const s = charge[slot], seconds = secondsAt(s, time);
        const p = game.players[slot];
        if (s.held || seconds > 0) stage.fx.charging(p.element, p.chest, p.tip, Math.min(1, seconds / 5), 'final-preview-' + slot);
        updateChargeText(slot, time);
      }
    },
    updateStatus() {
      const f = stage.fx.stats().fire;
      $('#fireTextureStatus').textContent = f.errors.length ? '炎素材を読み込めません: ' + f.errors.join(', ') : f.loaded.length < f.total ? '炎素材を読み込み中…' : '';
      const th = stage.fx.stats().thunder;
      $('#thunderTextureStatus').textContent = th.errors.length ? '電気素材を読み込めません: ' + th.errors.join(', ') : th.loaded.length < th.total ? '電気素材を読み込み中…' : '';
      const v = vision?.state, on = v?.on;
      $('#visionStatus').textContent = !v ? '' : !cfg.visOn ? '認識は止まっている（「認識を有効にする」で動く）' : cfg.fpv && ['visDraw', 'visGhost', 'visSpot', 'visTrail'].some(k => cfg[k]) ? '胸の視点では使えません（第三者カメラに切り替える）'
        : !on ? '' : v.error ? v.error : !v.ready ? 'MediaPipe を読み込み中…（初回は数十秒）'
        : `${v.delegate} ${v.hz.toFixed(0)} 回/秒 · 1回 ${v.ms.toFixed(0)} ms · 認識 ${['A', 'B'].filter(s => vision.persons[s]).join('・') || 'なし'}`;
      const ch = stage.fx.stats().charging;
      $('#chargeTextureStatus').textContent = ch.errors.length ? 'チャージ素材を読み込めません: ' + ch.errors.join(', ') : ch.loaded.length < ch.total ? 'チャージ素材を読み込み中…' : '';
    },
  };
}
