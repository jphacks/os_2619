// Both players on one keyboard (playable.js): each has its own keys, neither gets in the other's way, nothing stays held. A guard is its key held while not walking.
import assert from 'node:assert/strict';
let page;
globalThis.addEventListener = (...a) => page.addEventListener(...a);
const { createPlayable } = await import('./public/playable.js');

function setup(control = { A: 'keyboard', B: 'keyboard' }) {
  page = new EventTarget(); // a page of its own: the listeners of earlier setups stay out of it
  const truth = {}, commands = [], players = { A: { charging: false }, B: { charging: false } };
  const frame = { players: { A: { chest: [-1.2, 1.3, 0], yaw: 0 }, B: { chest: [1.2, 1.3, 0], yaw: Math.PI } } };
  const dummy = { frame, setTruth: (slot, t) => { truth[slot] = t; frame.players[slot] = { chest: t.chest, yaw: t.yaw }; } };
  const guardOn = { A: undefined, B: undefined };
  const game = { players, onSensed() {}, command: c => { if (c.cmd === 'guard') guardOn[c.slot] = c.on; else commands.push(c); } };
  const cfg = { control, rules: { t2: 2.5 } };
  const p = createPlayable({ vsrc: { dummy }, game, cfg, isActive: () => true });
  p.step(0, 0);
  return { p, truth, commands, cfg, guardOn };
}
const key = (type, code, { target = { tagName: 'BODY' }, ...extra } = {}) => { const e = Object.assign(new Event(type, { cancelable: true }), { code, key: '', ...extra }); Object.defineProperty(e, 'target', { value: target }); page.dispatchEvent(e); return e; };
const down = (code, extra) => key('keydown', code, extra), up = code => key('keyup', code);
const walk = (S, slot, code) => { const from = [...S.truth[slot].chest]; down(code); S.p.step(1, 1); up(code); S.p.step(0, 1); return [S.truth[slot].chest[0] - from[0], S.truth[slot].chest[2] - from[2]]; };

const cases = [
  ['A は WASD、B は十字キーで動き、相手の動きを変えない', () => {
    const S = setup();
    for (const [slot, code, dx, dz] of [['A', 'KeyD', 1, 0], ['A', 'KeyA', -1, 0], ['A', 'KeyW', 0, -1], ['A', 'KeyS', 0, 1], ['B', 'ArrowRight', 1, 0], ['B', 'ArrowLeft', -1, 0], ['B', 'ArrowUp', 0, -1], ['B', 'ArrowDown', 0, 1]]) {
      const foe = slot === 'A' ? 'B' : 'A', still = [...S.truth[foe].chest], [x, z] = walk(S, slot, code);
      assert.ok(Math.abs(x - dx * 1.6) < 1e-9 && Math.abs(z - dz * 1.6) < 1e-9, `${slot} ${code}: ${x}, ${z}`);
      assert.equal(S.truth[foe].chest[0], still[0], `${code} で ${foe} は動かない`);
      assert.equal(S.truth[foe].chest[2], still[2], `${code} で ${foe} は動かない`);
    }
  }],
  ['2 人が同時に別の方向へ動ける', () => {
    const S = setup(), a = S.truth.A.chest[0], b = S.truth.B.chest[0];
    down('KeyD'); down('ArrowLeft'); S.p.step(1, 1);
    assert.ok(Math.abs(S.truth.A.chest[0] - a - 1.6) < 1e-9); assert.ok(Math.abs(b - S.truth.B.chest[0] - 1.6) < 1e-9);
  }],
  ['溜めはそれぞれのキーで、同時にできる', () => {
    const S = setup();
    down('KeyF'); down('Period');
    assert.deepEqual(S.commands, [{ cmd: 'charge', slot: 'A', on: true }, { cmd: 'charge', slot: 'B', on: true }]);
    assert.equal(S.p.charging('A'), true); assert.equal(S.p.charging('B'), true);
    up('KeyF'); assert.equal(S.p.charging('A'), false); assert.equal(S.p.charging('B'), true);
    up('Period');
    assert.deepEqual(S.commands.slice(2), [{ cmd: 'charge', slot: 'A', on: false }, { cmd: 'charge', slot: 'B', on: false }]);
  }],
  ['長押しの繰り返しで溜めが始まり直さない', () => {
    const S = setup();
    down('KeyF'); down('KeyF', { repeat: true });
    assert.equal(S.commands.length, 1);
  }],
  ['キーを押さなければ、止まっていてもガードしない', () => {
    const S = setup(); S.p.step(1, 1);
    assert.equal(S.guardOn.A, false); assert.equal(S.guardOn.B, false);
  }],
  ['ガードはキーを押している間だけで、2 人別々に効く', () => {
    const S = setup();
    down('KeyG'); S.p.step(.1, 1); assert.equal(S.guardOn.A, true); assert.equal(S.guardOn.B, false);
    down('Slash'); S.p.step(.1, 1.1); assert.equal(S.guardOn.B, true);
    up('KeyG'); S.p.step(.1, 1.2); assert.equal(S.guardOn.A, false); assert.equal(S.guardOn.B, true);
    up('Slash'); S.p.step(.1, 1.3); assert.equal(S.guardOn.B, false);
  }],
  ['ガードキーを押していても、歩いている間はガードしない', () => {
    const S = setup();
    down('KeyG'); S.p.step(.1, 1); assert.equal(S.guardOn.A, true);
    down('KeyD'); S.p.step(.1, 1.1); assert.equal(S.guardOn.A, false, '歩き出した');
    assert.ok(S.truth.A.chest[0] > -1.2, '歩いている');
    up('KeyD'); S.p.step(.1, 1.2); assert.equal(S.guardOn.A, true, '止まった');
    down('ArrowLeft'); S.p.step(.1, 1.3); assert.equal(S.guardOn.A, true, 'B が歩いても A のガードは続く');
  }],
  ['キーボード操作をやめると、棒の静止でのガードに戻す', () => {
    const S = setup();
    down('KeyG'); S.p.step(.1, 1); S.p.setMode('A', 'still'); S.p.step(.1, 1.1);
    assert.equal(S.guardOn.A, null);
    assert.equal(down('KeyG').defaultPrevented, false, 'もうキーは取らない');
  }],
  ['入力欄の中のキーは取らない', () => {
    const S = setup(), e = down('KeyD', { target: { tagName: 'INPUT' } });
    assert.equal(e.defaultPrevented, false); assert.equal(S.commands.length, 0);
    S.p.step(1, 1); assert.equal(S.truth.A.chest[0], -1.2);
  }],
  ['ウィンドウを離れると押しっぱなしにならない', () => {
    const S = setup();
    down('KeyD'); down('KeyF'); down('Slash'); S.commands.length = 0; S.p.step(.1, 1); assert.equal(S.guardOn.B, true);
    page.dispatchEvent(new Event('blur')); S.p.step(.1, 1.1);
    assert.deepEqual(S.commands, [{ cmd: 'charge', slot: 'A', on: false }]);
    assert.equal(S.guardOn.B, false);
    const x = S.truth.A.chest[0]; S.p.step(1, 2); assert.equal(S.truth.A.chest[0], x);
  }],
  ['片方を切り替えても、もう片方のモードは変わらない', () => {
    const S = setup();
    S.p.setMode('A', 'random'); assert.equal(S.p.mode('B'), 'keyboard');
    S.p.setMode('A', 'keyboard'); assert.equal(S.p.mode('A'), 'keyboard'); assert.equal(S.p.mode('B'), 'keyboard');
    assert.deepEqual(S.cfg.control, { A: 'keyboard', B: 'keyboard' });
  }],
  ['キーボード操作でないプレイヤーのキーは取らない', () => {
    setup({ A: 'random', B: 'keyboard' });
    assert.equal(down('KeyD').defaultPrevented, false, 'A のキー');
    assert.equal(down('KeyG').defaultPrevented, false, 'A のガード');
    assert.equal(down('ArrowLeft').defaultPrevented, true, 'B のキー');
  }],
];
for (const [name, run] of cases) { run(); console.log('✓', name); }
console.log('test-playable: ok');
