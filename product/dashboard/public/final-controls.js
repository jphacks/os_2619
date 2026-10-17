// Controls that exist only for screen 4. Preview actions draw effects without
// changing the match, HP, hit detection, or firing a game projectile.
export function createFinalControls({ bar, stage, game, vsrc, cfg, save, scan, fullscreen }) {
  const $ = s => bar.querySelector(s);
  bar.innerHTML = `
    <button id="scanBtn" class="go">タグでスキャン<kbd>K</kbd></button>
    <span>炎の確認</span>
    <select id="fireDirection" aria-label="炎の確認方向"><option value="A">A → B</option><option value="B">B → A</option></select>
    <button data-fire="small">炎 小</button><button data-fire="medium">炎 中</button><button data-fire="large">炎 大</button>
    <button id="firePause">炎を停止</button><button id="fireStep">炎を1コマ進める</button>
    <span id="fireTextureStatus" class="msg"></span>
    <span>電気の確認</span>
    <select id="thunderDirection" aria-label="電気の確認方向"><option value="B">B → A</option><option value="A">A → B</option></select>
    <button data-thunder="small">電気 小</button><button data-thunder="medium">電気 中</button><button data-thunder="large">電気 大</button>
    <button id="thunderPause">電気を停止</button><button id="thunderStep">電気を1コマ進める</button>
    <span id="thunderTextureStatus" class="msg"></span>
    <span id="chargeTextureStatus" class="msg"></span>
    <span>チャージ</span><button data-charge="A">A 炎（長押し）</button><button data-charge="B">B 電気（長押し）</button>
    <span class="kv" id="tagCheck"></span>
    <span class="msg" id="finalMsg"></span>
    <div class="seg" id="fpvs"><button data-fpv="">第三者カメラ</button><button data-fpv="A">A の胸</button><button data-fpv="B">B の胸</button></div>
    <button data-tog="pip">小窓に 3D</button>
    <button id="fullBtn">全画面<kbd>F</kbd></button>`;

  $('#scanBtn').onclick = scan;
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

  const charge = new Map();
  for (const b of bar.querySelectorAll('[data-charge]')) {
    const slot = b.dataset.charge;
    const stop = () => { charge.delete(slot); b.classList.remove('on'); };
    b.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault(); charge.set(slot, performance.now() / 1000); b.classList.add('on'); b.setPointerCapture?.(e.pointerId);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    b.title = '最終映像のチャージ表現だけを確認';
  }

  for (const b of bar.querySelectorAll('[data-tog]')) b.onclick = () => { cfg[b.dataset.tog] = !cfg[b.dataset.tog]; save(); };
  for (const b of bar.querySelectorAll('[data-fpv]')) b.onclick = () => { cfg.fpv = b.dataset.fpv || null; save(); stage.resize(); stage.applyCam(); };
  $('#fullBtn').onclick = fullscreen;

  return {
    step(time) {
      for (const [slot, startedAt] of charge) {
        const p = game.players[slot];
        stage.fx.charging(p.element, p.chest, p.tip, Math.min(1, (time - startedAt) / 5), 'final-preview-' + slot);
      }
    },
    updateStatus() {
      const f = stage.fx.stats().fire;
      $('#fireTextureStatus').textContent = f.errors.length ? '炎素材を読み込めません: ' + f.errors.join(', ') : f.loaded.length < 5 ? '炎素材を読み込み中…' : '';
      const th = stage.fx.stats().thunder;
      $('#thunderTextureStatus').textContent = th.errors.length ? '電気素材を読み込めません: ' + th.errors.join(', ') : th.loaded.length < 4 ? '電気素材を読み込み中…' : '';
      const ch = stage.fx.stats().charging;
      $('#chargeTextureStatus').textContent = ch.errors.length ? 'チャージ素材を読み込めません: ' + ch.errors.join(', ') : ch.loaded.length < 5 ? 'チャージ素材を読み込み中…' : '';
    },
  };
}
