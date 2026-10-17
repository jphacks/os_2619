// Scenario check of the game rules (public/game.js): a fake clock, two scripted players, no browser.
// Run: node test-game.mjs     Prints one line per scenario (✓ / ✗) and exits 1 when any fails.
// Players stand where the script puts them (cfg.useTruth + 'truth' packets, the same path as the simulator's debug stream);
// moves arrive as the sensing team's detector events (Charge / Swing) exactly as app.js passes them on.
import { register } from 'node:module';

// game.js imports the bare name 'three' (the browser's import map): point it at the vendored copy
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'three') return next(new URL('./vendor/cdn/npm/three@0.160.0/build/three.module.js', ${JSON.stringify(import.meta.url)}).href, ctx);
    return next(spec, ctx);
  }`));
const { createGame, RULES } = await import('./public/game.js');

const DT = 1 / 60;
function setup({ rules = {}, matchSec = 60, test = false } = {}) {
  let t = 1000, ids = 1;
  const fx = { aura() {}, charge() {}, shot: () => ids++, moveShot() {}, endShot() {}, hit() {} };
  const cfg = { posSrc: 'start', aim: 'stick', hand: 'R', stickLen: { A: .8, B: .8 }, useTruth: true, test,
    rules: { ...RULES, ...rules, dmg: { ...RULES.dmg, ...rules.dmg } } };
  const g = createGame({ fx, drone: null, cfg, clock: () => t });
  const pos = { A: [-1.2, 0], B: [1.2, 0] };
  const put = (slot, x, z) => { // chest 1.3 m up, stick held at the chest pointing straight at the other start mark
    pos[slot] = [x, z];
    const s = slot === 'A' ? 1 : -1;
    g.ingest({ type: 'truth', slot, chest: [x, 1.3, z], yaw: slot === 'A' ? 0 : Math.PI, base: [x + .2 * s, 1.2, z], dir: [s, 0, 0] });
  };
  put('A', ...pos.A); put('B', ...pos.B);
  const run = sec => { for (let i = 0; i < Math.round(sec / DT); i++) { t += DT; g.step(DT, DT, null, null); } };
  g.command({ cmd: 'matchSec', value: matchSec });
  const S = {
    g, cfg, run, put,
    get A() { return g.players.A; }, get B() { return g.players.B; },
    fight() { g.command({ cmd: 'phase', phase: 'fight' }); run(3.05); },
    swing: slot => g.onSensed({ slot, name: 'Swing', power: .7 }),
    charge: slot => g.onSensed({ slot, name: 'Charge' }),
    /** charge for `sec`, then swing, then let the shot fly */
    chargeShot(slot, sec) { S.charge(slot); run(sec); S.swing(slot); run(1); },
    /** walk the chest from where it is by (dx, dz) metres over `sec` */
    walk(slot, dx, dz, sec = .5) {
      const [x0, z0] = pos[slot], n = Math.round(sec / DT);
      for (let i = 1; i <= n; i++) { put(slot, x0 + dx * i / n, z0 + dz * i / n); run(DT); }
    },
    log: () => g.events.map(e => `${e.slot ?? '-'} ${e.text}`).reverse(),
  };
  return S;
}

const results = [];
function scenario(name, fn) {
  try { const note = fn(); results.push({ ok: true, name, note }); }
  catch (e) { results.push({ ok: false, name, note: e.message }); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, what) => expect(a === b, `${what}: ${b} のはずが ${a}`);

// ---- 試合の流れ ----
scenario('準備中は振っても撃てず、ダメージも入らない', () => {
  const S = setup();
  S.swing('A'); S.charge('B'); S.run(1);
  eq(S.A.shots, 0, 'A の発射数'); eq(S.B.charging, false, 'B の溜め'); eq(S.B.hp, 100, 'B の HP');
});
scenario('試合開始で3秒数えてから、60秒の試合が始まる', () => {
  const S = setup();
  S.g.command({ cmd: 'phase', phase: 'fight' });
  eq(S.g.match.phase, 'countdown', '直後の状態');
  S.swing('A'); eq(S.A.shots, 0, 'カウント中の発射数');
  S.run(3.05);
  eq(S.g.match.phase, 'fight', '3秒後の状態'); expect(Math.abs(S.g.match.left - 60) < .1, `残り時間 ${S.g.match.left.toFixed(1)} 秒`);
  return `残り ${S.g.match.left.toFixed(1)} 秒`;
});
scenario('一時停止中は時間が止まり、振っても撃てない', () => {
  const S = setup(); S.fight(); S.run(5);
  S.g.command({ cmd: 'pause' }); const left = S.g.match.left;
  S.run(3); S.swing('A');
  expect(Math.abs(S.g.match.left - left) < 1e-6, '止めている間に時間が進んだ'); eq(S.A.shots, 0, '止めている間の発射数');
  S.g.command({ cmd: 'pause' }); S.run(1);
  expect(S.g.match.left < left - .9, '再開後に時間が進まない');
});

// ---- 溜めなし攻撃 ----
scenario('溜めなしで振ると小が飛び、当たると5ダメージ', () => {
  const S = setup(); S.fight(); S.swing('A'); S.run(1);
  eq(S.A.shots, 1, '発射数'); eq(S.B.hp, 95, 'B の HP');
});
scenario('小の連打は0.25秒おきまで。速すぎる振りは無視される', () => {
  const S = setup(); S.fight();
  for (let i = 0; i < 5; i++) { S.swing('A'); S.run(.05); } // 5 swings in 0.25 s
  const fast = S.A.shots;
  for (let i = 0; i < 4; i++) { S.run(.3); S.swing('A'); }   // 4 swings 0.3 s apart
  S.run(1);
  eq(fast, 1, '0.05秒おきに5回振ったときの発射数'); eq(S.A.shots, 5, '合計の発射数'); eq(S.B.hp, 75, 'B の HP（小5発）');
  return '0.05秒おき5回→1発、0.3秒おき4回→4発';
});

// ---- 溜めの段階 ----
for (const [sec, tier, dmg] of [[1.5, '小', 5], [3, '中', 20], [6, '大', 60]]) {
  scenario(`${sec}秒溜めて振ると${tier}になり、${dmg}ダメージ`, () => {
    const S = setup(); S.fight(); S.chargeShot('A', sec);
    eq(S.B.hp, 100 - dmg, 'B の HP');
    expect(S.log().some(l => l.includes(`${tier}の攻撃`)), `記録に「${tier}の攻撃」がない`);
  });
}
scenario('溜めのメーターは中で黄色、大で赤の段階が切り替わる', () => {
  const S = setup(); S.fight(); S.charge('A');
  const seen = []; for (const t of [1, 2.2, 5.2]) { S.run(t - (seen.length ? [1, 2.2, 5.2][seen.length - 1] : 0)); seen.push(S.A.tier); }
  eq(seen.join(','), 's,m,l', '1秒・2.2秒・5.2秒の段階'); eq(S.A.charge, 1, '大でのメーター');
  return '1秒 小 → 2.2秒 中 → 5.2秒 大';
});
scenario('溜め中にもう一度「溜め」が来ても、溜め時間はリセットされない', () => {
  const S = setup(); S.fight(); S.charge('A'); S.run(3); S.charge('A'); S.run(2.5);
  expect(S.A.chargeT > 5.4, `溜め時間 ${S.A.chargeT.toFixed(1)} 秒`); eq(S.A.tier, 'l', '段階');
});

scenario('大ボタンを押すと、実際に溜めて小→中→大と上がってから撃つ', () => {
  const S = setup(); S.fight(); S.g.command({ cmd: 'special', slot: 'A' });
  eq(S.A.charging, true, '押した直後に溜め中か'); eq(S.A.shots, 0, '押した直後の発射数');
  S.run(3); const mid = S.A.tier;
  S.run(3); S.run(1);
  eq(mid, 'm', '3秒後の段階'); eq(S.A.shots, 1, '発射数'); eq(S.A.charging, false, '撃ったあと溜め中か'); eq(S.B.hp, 40, 'B の HP（大1発）');
  return '押す → 3秒で中 → 5.3秒で撃つ';
});
scenario('大ボタンで溜めている途中に動くと失敗し、撃たない', () => {
  const S = setup(); S.fight(); S.g.command({ cmd: 'special', slot: 'A' }); S.run(2); S.walk('A', 0, .6); S.run(5);
  eq(S.A.fails, 1, '失敗数'); eq(S.A.shots, 0, '発射数'); eq(S.B.hp, 100, 'B の HP');
});

// ---- 溜めのリスク ----
scenario('溜め中に30cm動いても溜めは続く', () => {
  const S = setup(); S.fight(); S.charge('A'); S.run(1); S.walk('A', 0, .3); S.run(.5);
  eq(S.A.charging, true, '溜め中か'); eq(S.A.fails, 0, '失敗数');
});
scenario('溜め中に60cm動くと溜めが消え、そのあと振っても小しか出ない', () => {
  const S = setup(); S.fight(); S.charge('A'); S.run(3); S.walk('A', 0, .6);
  eq(S.A.charging, false, '溜め中か'); eq(S.A.fails, 1, '失敗数');
  S.put('A', -1.2, 0); S.run(.3); S.swing('A'); S.run(1);
  eq(S.B.hp, 95, 'B の HP（小1発）');
  return S.log().find(l => l.includes('溜め失敗'));
});
scenario('溜めている間は無防備：相手の小を受け続ける', () => {
  const S = setup(); S.fight(); S.charge('A');
  for (let i = 0; i < 4; i++) { S.swing('B'); S.run(.5); }
  eq(S.A.charging, true, 'A の溜めが続いているか'); eq(S.A.hp, 80, 'A の HP（小4発）');
});

// ---- 当たり判定（避けるのは体を動かすだけ） ----
scenario('横に1m動けば小は外れる', () => {
  const S = setup(); S.fight(); S.walk('B', 0, 1, .3); S.swing('A'); S.run(1.8);
  eq(S.B.hp, 100, 'B の HP');
});
scenario('70cmずれると、小は外れるが大は当たる（大は弾が太い）', () => {
  const S = setup(); S.fight(); S.walk('B', 0, .7, .3);
  S.swing('A'); S.run(1.8); const afterSmall = S.B.hp;
  S.chargeShot('A', 5.5);
  eq(afterSmall, 100, '小のあとの B の HP'); eq(S.B.hp, 40, '大のあとの B の HP');
});
scenario('大も横に1.2m動けば外れる', () => {
  const S = setup(); S.fight(); S.charge('A'); S.run(5.5); S.walk('B', 0, 1.2, .3); S.swing('A'); S.run(1.8);
  eq(S.B.hp, 100, 'B の HP');
});
scenario('ガードと回避のセンサー判定は、ゲームでは何も起きない', () => {
  const S = setup(); S.fight();
  S.g.onSensed({ slot: 'B', name: 'Guard' }); S.g.onSensed({ slot: 'B', name: 'Dodge', dir: 'left', speed: 1.5 });
  S.swing('A'); S.run(1);
  eq(S.B.hp, 95, 'B の HP（ガードも無敵もなし）');
});

// ---- 決着 ----
scenario('HPが0になった時点で決着し、そのあとは撃っても当たらない', () => {
  const S = setup(); S.fight();
  S.chargeShot('A', 5.5); S.chargeShot('A', 5.5);
  eq(S.B.hp, 0, 'B の HP'); eq(S.g.match.phase, 'result', '状態'); eq(S.g.winner?.slot, 'A', '勝者');
  S.swing('B'); S.run(1); eq(S.A.hp, 100, '決着後の A の HP');
  return `決着まで ${(60 - S.g.match.left).toFixed(1)} 秒`;
});
scenario('時間切れならHPが多いほうの勝ち', () => {
  const S = setup({ matchSec: 10 }); S.fight(); S.swing('A'); S.run(10.5);
  eq(S.g.match.phase, 'result', '状態'); eq(S.g.winner?.slot, 'A', '勝者');
});
scenario('時間切れでHPが同じなら引き分け', () => {
  const S = setup({ matchSec: 10 }); S.fight(); S.run(10.5);
  eq(S.g.match.phase, 'result', '状態'); eq(S.g.winner, null, '勝者');
});
scenario('やり直しで HP と溜めが元に戻り、もう一度3秒数える', () => {
  const S = setup(); S.fight(); S.swing('A'); S.run(1); S.charge('B'); S.run(1);
  S.g.command({ cmd: 'reset' });
  eq(S.B.hp, 100, 'B の HP'); eq(S.B.charging, false, 'B の溜め'); eq(S.g.match.phase, 'countdown', '状態'); S.run(3.05); eq(S.g.match.phase, 'fight', '3秒後の状態');
});

// ---- ダッシュボードで変えた数値がすぐ効く ----
scenario('数値を変えるとすぐ反映される（小のダメージ12、中は1秒から）', () => {
  const S = setup(); S.fight();
  S.cfg.rules.dmg.s = 12; S.swing('A'); S.run(1); eq(S.B.hp, 88, '小12のあとの B の HP');
  S.cfg.rules.t1 = 1; S.chargeShot('A', 1.5); eq(S.B.hp, 68, '1.5秒溜め（中）のあとの B の HP');
});
scenario('テストモードでは当たってもHPが減らない', () => {
  const S = setup({ test: true }); S.fight(); S.swing('A'); S.run(1);
  eq(S.A.hits, 1, '命中数'); eq(S.B.hp, 100, 'B の HP');
});

// ---- report ----
const w = Math.max(...results.map(r => r.name.length));
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(w, '　')}${r.note ? '  ' + r.note : ''}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\n${results.length - bad} / ${results.length} シナリオ合格`);
process.exit(bad ? 1 : 0);
