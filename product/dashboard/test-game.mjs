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
function setup({ rules = {}, matchSec = 60, test = false, dummy = false } = {}) {
  let t = 1000, ids = 1;
  const fx = { aura() {}, charge() {}, shot: () => ids++, moveShot() {}, endShot() {}, hit() {}, guard() {}, block() {} };
  const cfg = { posSrc: 'start', aim: 'motion', hand: 'R', stickLen: { A: .8, B: .8 }, useTruth: true, test,
    rules: { ...RULES, chargeHold: 0, ...rules, dmg: { ...RULES.dmg, ...rules.dmg }, size: { ...RULES.size, ...rules.size } } };
  const pos = { A: [-1.2, 0], B: [1.2, 0] };
  // dummy: the dummy room's frame (app.js getDummyFrame), players where the script puts them, as the dummy room draws them
  const frame = () => ({ players: Object.fromEntries(['A', 'B'].map(sl => { const [x, z] = pos[sl], sg = sl === 'A' ? 1 : -1;
    return [sl, { chest: [x, 1.3, z], yaw: sl === 'A' ? 0 : Math.PI, base: [x + .2 * sg, 1.2, z], tip: [x + 1 * sg, 1.2, z], dir: [sg, 0, 0] }]; })) });
  const g = createGame({ fx, drone: null, cfg, clock: () => t, ...(dummy && { getDummyFrame: frame }) });
  const put = (slot, x, z) => { // chest 1.3 m up, stick held at the chest pointing straight at the other start mark
    pos[slot] = [x, z];
    const s = slot === 'A' ? 1 : -1;
    g.ingest({ type: 'truth', slot, chest: [x, 1.3, z], yaw: slot === 'A' ? 0 : Math.PI, base: [x + .2 * s, 1.2, z], dir: [s, 0, 0] });
  };
  put('A', ...pos.A); put('B', ...pos.B);
  // a still stick guards (game.js stepGuard), so B's stick bobs up and down ±20° at 1.5 Hz unless a scenario holds it still
  // (wob[slot] = false); up and down, so it adds nothing sideways to a shot's aim
  const wob = { A: false, B: true }; // A scripts its own stick (sweeps, charges); B is the target
  const bob = slot => { const [x, z] = pos[slot], s = slot === 'A' ? 1 : -1, a = .35 * Math.sin(2 * Math.PI * 1.5 * t);
    g.ingest({ type: 'truth', slot, chest: [x, 1.3, z], yaw: slot === 'A' ? 0 : Math.PI, base: [x + .2 * s, 1.2, z], dir: [s * Math.cos(a), Math.sin(a), 0] }); };
  const run = sec => { for (let i = 0; i < Math.round(sec / DT); i++) { t += DT; for (const sl of ['A', 'B']) if (wob[sl]) bob(sl); g.step(DT, DT, null); } };
  g.command({ cmd: 'matchSec', value: matchSec });
  const S = {
    g, cfg, run, put, wob,
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
    /** move A's stick over `sec`: base(u) and dir(u) for u 0..1 (field coords), then a Swing as the stick stops */
    sweep(slot, sec, base, dir, { keep = false } = {}) { // keep: stop right after the Swing (the shot still in flight)
      const n = Math.round(sec / DT), x = pos[slot];
      g.ingest({ type: 'truth', slot, chest: [x[0], 1.3, x[1]], yaw: slot === 'A' ? 0 : Math.PI, base: base(0), dir: dir(0) }); run(.6); // wind up, still
      for (let i = 0; i <= n; i++) { const u = i / n; g.ingest({ type: 'truth', slot, chest: [x[0], 1.3, x[1]], yaw: slot === 'A' ? 0 : Math.PI, base: base(u), dir: dir(u) }); run(DT); }
      S.swing(slot); if (!keep) run(1.5);
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

// ---- 撃つ方向（止める直前の棒の先の動き） ----
scenario('棒を前に突き出して止めると、突き出した向きに飛んで当たる', () => {
  const S = setup(); S.fight();
  S.sweep('A', .15, u => [-1.4 + .4 * u, 1.2, 0], () => [1, 0, 0]); // the whole stick moves 40 cm toward B
  eq(S.B.hp, 95, 'B の HP');
});
scenario('横に払って相手の方を向いて止めると、払った向き（横）に飛んで外れる', () => {
  const S = setup(); S.fight();
  // stick swings from pointing left (-z) round to pointing at B (+x): the tip is moving toward +z when it stops
  S.sweep('A', .2, () => [-1.0, 1.2, 0], u => { const a = -Math.PI / 2 * (1 - u); return [Math.cos(a), 0, Math.sin(a)]; });
  eq(S.B.hp, 100, 'B の HP');
  const sh = S.g.events.find(e => e.kind === 'shot'); expect(sh, '撃っていない');
});
scenario('同じ払い方でも、狙いを「止めたときの棒の向き」にすると当たる', () => {
  const S = setup(); S.fight(); S.cfg.aim = 'stick';
  S.sweep('A', .2, () => [-1.0, 1.2, 0], u => { const a = -Math.PI / 2 * (1 - u); return [Math.cos(a), 0, Math.sin(a)]; });
  eq(S.B.hp, 95, 'B の HP');
});
scenario('振り下ろして止めると、小は止めた棒の先の高さで、体の向きに水平に飛んで当たる', () => {
  const S = setup(); S.fight();
  // stick from straight up down to level forward: at the stop the tip is moving straight down
  S.sweep('A', .2, () => [-1.0, 1.2, 0], u => { const a = Math.PI / 2 * (1 - u); return [Math.cos(a), Math.sin(a), 0]; }, { keep: true });
  const sh = S.g.shots[0]; expect(sh, '弾がない');
  expect(Math.abs(sh.vel.y) < 1e-9, `弾の上下の速さ ${sh.vel.y}`); expect(Math.abs(sh.pos.y - S.A.tip.y) < .05, `弾の高さ ${sh.pos.y.toFixed(2)}、棒の先 ${S.A.tip.y.toFixed(2)}`);
  S.run(1.5); eq(S.B.hp, 95, 'B の HP');
});
scenario('横に払うと、小は体の向きと払った向きの間（最大 45°）に飛ぶ', () => {
  const S = setup(); S.fight();
  S.sweep('A', .2, () => [-1.0, 1.2, 0], u => { const a = -Math.PI / 2 * (1 - u); return [Math.cos(a), 0, Math.sin(a)]; }, { keep: true });
  const v = S.g.shots[0].vel, deg = Math.atan2(v.z, v.x) * 180 / Math.PI;
  expect(deg > 20 && deg <= 45.5, `水平の向き ${deg.toFixed(0)}°`);
});
scenario('ボタンで撃つとき（棒が動いていない）は、小は体の向きに飛ぶ', () => {
  const S = setup(); S.fight(); S.g.command({ cmd: 'shoot', slot: 'A' }); S.run(1);
  eq(S.B.hp, 95, 'B の HP');
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
scenario('45cmずれても小は当たる（玉の当たり判定は見た目より少し大きい）', () => {
  const S = setup(); S.fight(); S.walk('B', 0, .45, .3); S.swing('A'); S.run(1.8);
  eq(S.B.hp, 95, 'B の HP');
});
scenario('棒を背中側で止めた振りでは撃たず、体の前で止めれば撃つ', () => {
  const S = setup(); S.fight();
  S.g.ingest({ type: 'truth', slot: 'A', chest: [-1.2, 1.3, 0], yaw: 0, base: [-1.4, 1.2, 0], dir: [-1, 0, 0] }); S.run(.1);
  S.swing('A'); S.run(.5); eq(S.A.shots, 0, '背中側での発射数');
  S.charge('A'); S.run(2.5); S.swing('A'); S.run(.1);
  eq(S.A.charging, true, '背中側で振ったあとも溜めは続く');
  S.put('A', -1.2, 0); S.run(.1); S.swing('A'); S.run(1.5);
  eq(S.A.shots, 1, '前で止めたときの発射数'); eq(S.B.hp, 80, '中が当たったあとの B の HP');
});
scenario('棒が水平より下で回しても溜まらず、上なら溜まる（下で回し続けると溜めが切れる）', () => {
  const S = setup({ rules: { chargeHold: 1.5 } }); S.fight(); // the real rule: a charge needs the circling to go on
  const aim = y => S.g.ingest({ type: 'truth', slot: 'A', chest: [-1.2, 1.3, 0], yaw: 0, base: [-1, 1.0, 0], dir: [Math.sqrt(1 - y * y), y, 0] });
  aim(-.3); S.run(.1); S.charge('A'); S.run(.2); eq(S.A.charging, false, '下向きで回したときの溜め');
  aim(.3); S.run(.1); S.charge('A'); S.run(.2); eq(S.A.charging, true, '上向きで回したときの溜め');
  aim(-.3); for (let i = 0; i < 4; i++) { S.charge('A'); S.run(.5); }
  eq(S.A.charging, false, '溜め中に下向きで回し続けたあと');
});
scenario('回避とガードのセンサー判定だけでは何も起きない（ガードは棒の姿勢で決まる）', () => {
  const S = setup(); S.fight();
  S.g.onSensed({ slot: 'B', name: 'Guard' }); S.g.onSensed({ slot: 'B', name: 'Dodge', dir: 'left', speed: 1.5 });
  S.swing('A'); S.run(1);
  eq(S.B.hp, 95, 'B の HP（無敵なし）');
});
// B holds the stick level across the body (真一文字): pointing along z, square to the facing (-x)
const guardB = S => (S.wob.B = false, S.g.ingest)({ type: 'truth', slot: 'B', chest: [1.2, 1.3, 0], yaw: Math.PI, base: [1, 1.2, -.4], dir: [0, 0, 1] });
scenario('真一文字に構えると、小は跳ね返って撃った A に当たる', () => {
  const S = setup(); S.fight(); guardB(S); S.run(.4);
  eq(S.B.guarding, true, 'B のガード');
  S.swing('A'); S.run(1.5);
  eq(S.B.hp, 100, 'B の HP'); eq(S.A.hp, 90, '跳ね返った小を受けた A の HP（小 5 × 反射 2 倍）');
});
scenario('反射のダメージ倍率を変えると、跳ね返った小のダメージも変わる', () => {
  const S = setup({ rules: { reflectMul: 3 } }); S.fight(); guardB(S); S.run(.4);
  S.swing('A'); S.run(1.5);
  eq(S.A.hp, 85, '跳ね返った小を受けた A の HP（小 5 × 反射 3 倍）');
});
scenario('構えてすぐ（0.3 秒未満）はまだガードにならない', () => {
  const S = setup(); S.fight(); guardB(S); S.run(.1);
  eq(S.B.guarding, false, 'B のガード');
});
const stickB = (S, dir) => (S.wob.B = false, S.g.ingest)({ type: 'truth', slot: 'B', chest: [1.2, 1.3, 0], yaw: Math.PI, base: [1, 1.2, -.4], dir });
scenario('振って真一文字の位置で止めると、止めたときに小を撃ち、ガードにはならない', () => {
  const S = setup(); S.fight();
  stickB(S, [0, 1, 0]); S.run(.5);
  for (let i = 1; i <= 9; i++) { const a = i / 9 * Math.PI / 2; stickB(S, [0, Math.cos(a), Math.sin(a)]); S.run(DT); } // 90° in .15 s
  S.swing('B'); eq(S.B.shots, 1, '止めた瞬間の B の発射数');
  let guarded = false; for (let i = 0; i < 40; i++) { S.run(DT); guarded ||= S.B.guarding; }
  eq(guarded, false, '止めた直後 0.66 秒のガード');
});
scenario('真一文字でも棒を揺らし続けている間はガードにならない', () => {
  const S = setup(); S.fight();
  let guarded = false;
  for (let i = 0; i < 90; i++) { const a = .3 * Math.sin(i * DT * 2 * Math.PI * 1.5); stickB(S, [-Math.sin(a), 0, Math.cos(a)]); S.run(DT); guarded ||= S.B.guarding; } // ±17° at 1.5 Hz
  eq(guarded, false, '揺らしている間の B のガード');
  S.run(.4); eq(S.B.guarding, true, '止めて 0.4 秒後の B のガード');
});
scenario('止めた棒の向きが 1.5° ほど揺れ、センサーの更新がフレームとずれていてもガードになる', () => {
  const S = setup(); S.fight();
  let r = 7; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647 - .5;
  for (let i = 0; i < 40; i++) { // a packet every ~2 frames, each with up to ±1.5° of noise
    if (i % 2 === 0 || i % 7 === 0) { const a = 3 * rnd() * Math.PI / 180, b = 3 * rnd() * Math.PI / 180; stickB(S, [Math.sin(a), Math.sin(b), Math.cos(a)]); }
    S.run(DT);
  }
  eq(S.B.guarding, true, '止めて 0.66 秒後の B のガード');
});
scenario('棒をどの向きで止めていても（相手に向けたままでも）ガードになり、小は跳ね返る', () => {
  const S = setup(); S.fight(); stickB(S, [-1, .3, 0]); S.run(.4);
  eq(S.B.guarding, true, 'B のガード');
  S.swing('A'); S.run(1.5);
  eq(S.B.hp, 100, 'B の HP'); eq(S.A.hp, 90, '跳ね返った小を受けた A の HP（小 5 × 反射 2 倍）');
});
scenario('中と大はガードを貫通する', () => {
  const S = setup(); S.fight(); guardB(S);
  S.chargeShot('A', 2.5); eq(S.B.hp, 80, '中のあとの B の HP');
  S.chargeShot('A', 5.5); eq(S.B.hp, 20, '大のあとの B の HP'); eq(S.A.hp, 100, 'A の HP');
});
scenario('ガードボタンを押している間はガード、離すと小が当たる', () => {
  const S = setup(); S.fight();
  S.g.command({ cmd: 'guard', slot: 'B', on: true }); S.run(DT); S.swing('A'); S.run(1.5);
  eq(S.A.hp, 90, '跳ね返りを受けた A の HP（小 5 × 反射 2 倍）');
  S.g.command({ cmd: 'guard', slot: 'B', on: false }); S.run(.3); S.swing('A'); S.run(1.5);
  eq(S.B.hp, 95, 'B の HP');
});

// ---- デモ試合（ホーミング） ----
scenario('デモ試合では、撃つ前に横へ1m動いた相手にも、狙って小が当たる', () => {
  const S = setup(); S.g.command({ cmd: 'phase', phase: 'demo' }); S.run(3.05);
  eq(S.g.match.phase, 'fight', '状態'); eq(S.g.match.mode, 'demo', 'モード');
  S.walk('B', 0, 1, .3); S.swing('A'); S.run(1.5);
  eq(S.B.hp, 95, 'B の HP');
});
scenario('デモ試合でも、大を撃たれた直後に素早く1.2m横へ動けば避けられる（弾は曲がらない）', () => {
  const S = setup(); S.g.command({ cmd: 'phase', phase: 'demo' }); S.run(3.05);
  S.charge('A'); S.run(5.5); S.swing('A'); S.walk('B', 0, 1.2, .15); S.run(1.8);
  eq(S.B.hp, 100, 'B の HP');
});
scenario('デモ試合で、撃たれたあとゆっくり動いても大は当たる', () => {
  const S = setup(); S.g.command({ cmd: 'phase', phase: 'demo' }); S.run(3.05);
  S.charge('A'); S.run(5.5); S.swing('A'); S.walk('B', 0, .3, .4); S.run(1.5);
  eq(S.B.hp, 40, 'B の HP');
});
scenario('デモ試合では、下に振り下ろしても相手に飛んで大が当たる', () => {
  const S = setup(); S.g.command({ cmd: 'phase', phase: 'demo' }); S.run(3.05);
  S.charge('A'); S.run(5.5);
  S.sweep('A', .2, () => [-1.0, 1.2, 0], u => { const a = Math.PI / 2 * (1 - u); return [Math.cos(a), Math.sin(a), 0]; });
  eq(S.B.hp, 40, 'B の HP');
});
scenario('デモ試合でやり直すと、デモ試合のまま3秒数える', () => {
  const S = setup(); S.g.command({ cmd: 'phase', phase: 'demo' }); S.run(4); S.g.command({ cmd: 'reset' });
  eq(S.g.match.phase, 'countdown', '状態'); eq(S.g.match.mode, 'demo', 'モード');
  S.g.command({ cmd: 'phase', phase: 'fight' }); eq(S.g.match.mode, 'normal', '試合開始で戻るモード');
});

scenario('ダミーの部屋でも、デモ試合の大は撃った直後に素早く動けば避けられる（追いかけない）', () => {
  const S = setup({ dummy: true }); S.g.command({ cmd: 'phase', phase: 'demo' }); S.run(3.05);
  S.g.command({ cmd: 'special', slot: 'A' }); // the 大 button: charges, then swings just past the 大 line
  for (let i = 0; i < 800 && !S.A.shots; i++) S.run(1 / 60);
  eq(S.A.shots, 1, '発射数'); S.walk('B', 0, 1.2, .15); S.run(1.8);
  eq(S.B.hp, 100, 'B の HP');
});
scenario('ダミーの部屋でも、デモ試合で動かなければ大は当たる', () => {
  const S = setup({ dummy: true }); S.g.command({ cmd: 'phase', phase: 'demo' }); S.run(3.05);
  S.g.command({ cmd: 'special', slot: 'A' }); S.run(7);
  eq(S.B.hp, 40, 'B の HP');
});

// ---- 玉の大きさ ----
scenario('60cmずれた相手に、小は1倍だと外れ、3倍だと当たる（当たりも大きくなる）', () => {
  for (const [k, hp] of [[1, 100], [3, 95]]) {
    const S = setup({ rules: { size: { s: k, m: 1, l: 1 } } }); S.fight(); S.walk('B', 0, .6, .3);
    S.swing('A'); S.run(1.8);
    eq(S.B.hp, hp, `${k}倍のときの B の HP`);
  }
});
scenario('大の玉を0.5倍にすると、70cmずれた相手には当たらない', () => {
  const S = setup({ rules: { size: { s: 1, m: 1, l: .5 } } }); S.fight(); S.walk('B', 0, .7, .3);
  S.chargeShot('A', 5.5);
  eq(S.B.hp, 100, 'B の HP');
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
scenario('HPの設定は準備中にすぐ反映され、試合はその値から始まる', () => {
  const S = setup(); S.cfg.rules.hp = 200; S.run(.1);
  eq(S.B.hp, 200, '準備中の B の HP'); eq(S.B.hpMax, 200, 'B の最大 HP');
  S.fight(); S.swing('A'); S.run(1); eq(S.B.hp, 195, '小のあとの B の HP');
});
scenario('弾の速さ0.5倍だと、同じ距離に当たるまで2倍かかる', () => {
  const time = speed => { // seconds until the 小 hits B standing 4 m away
    const S = setup({ rules: { speed } }); S.put('B', 4, 0); S.fight(); S.swing('A');
    for (let t = 0; t < 3; t += 1 / 60) { S.run(1 / 60); if (S.B.hp < 100) return t; }
    return Infinity;
  };
  const t1 = time(1), t5 = time(.5);
  expect(Math.abs(t5 / t1 - 2) < .15, `通常 ${t1.toFixed(2)} 秒、0.5倍 ${t5.toFixed(2)} 秒`);
  return `通常 ${t1.toFixed(2)} 秒 / 0.5倍 ${t5.toFixed(2)} 秒`;
});
scenario('テストモードでは当たってもHPが減らない', () => {
  const S = setup({ test: true }); S.fight(); S.swing('A'); S.run(1);
  eq(S.A.hits, 1, '命中数'); eq(S.B.hp, 100, 'B の HP');
});

// ---- report ----
// ---- 溜めは棒を動かし続けている間だけ ----
scenario('溜めの検知が途切れると、溜めがやめになる（動かし続ければ続く）', () => {
  const S = setup({ rules: { chargeHold: 1.5 } }); S.fight();
  S.charge('A'); for (let i = 0; i < 20; i++) { S.run(.1); S.charge('A'); }
  eq(S.A.charging, true, '動かしている間');
  S.run(1);
  eq(S.A.charging, true, '1秒止めても続く');
  S.run(1);
  eq(S.A.charging, false, '2秒止めたら終わり');
  S.charge('A'); for (let i = 0; i < 55; i++) { S.run(.1); S.charge('A'); }
  eq(S.A.tier, 'l', '溜め切り'); S.run(4);
  eq(S.A.charging, true, '溜め切ったら止めていても待つ');
});
scenario('回すのをやめると溜めはその量で止まって保持され、振り下ろしでその段階が出る', () => {
  const S = setup({ rules: { chargeHold: 1.5 } }); S.fight(); // the real rule
  const circle = sec => { for (let t = 0; t < sec; t += .15) { S.charge('A'); S.run(.15); } };
  circle(1.5); const held = S.A.chargeT; // 1.5 s of circling: still 小
  S.run(1); // stopped circling, 1 s before the swing down
  expect(Math.abs(S.A.chargeT - held) < .45, `止めている間に溜めが ${held.toFixed(2)} → ${S.A.chargeT.toFixed(2)} 秒に増えた`);
  eq(S.A.charging, true, '保持中の溜め');
  S.swing('A'); S.run(1.5);
  eq(S.B.hp, 95, '保持した小で撃ったあとの B の HP（時間だけなら中になっていた）');
  circle(2.6); S.run(.8); S.swing('A'); S.run(1.5);
  eq(S.B.hp, 75, '2.6秒回して止め、振り下ろした中のあとの B の HP');
});

const w = Math.max(...results.map(r => r.name.length));
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(w, '　')}${r.note ? '  ' + r.note : ''}`);
const bad = results.filter(r => !r.ok).length;
console.log(`\n${results.length - bad} / ${results.length} シナリオ合格`);
process.exit(bad ? 1 : 0);
