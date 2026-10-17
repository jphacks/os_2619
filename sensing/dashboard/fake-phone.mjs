// Streams synthetic data as one or two phones, to try the dashboard without hardware.
// Run: node fake-phone.mjs [count=2] [host=localhost:8000]
import WebSocket from 'ws';

const n = +(process.argv[2] ?? 2), host = process.argv[3] ?? 'localhost:8000';
for (let i = 0; i < n; i++) fake(`fake-${i}`, i);

function fake(id, i) {
  const ws = new WebSocket(`ws://${host}/ws`);
  const now = () => Date.now() / 1000;
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'phone', id, name: `Fake ${i}` }));
    const t0 = now(), timers = [];
    ws.on('close', () => timers.forEach(clearInterval));
    const s = (k) => ws.readyState === 1 && ws.send(JSON.stringify({ t: now(), ...k }));
    timers.push(setInterval(() => ws.send(JSON.stringify({ type: 'ping', t0: now() })), 1000));
    timers.push(setInterval(() => { // 100 Hz IMU
      const a = now() - t0 + i;
      s({ type: 'imu', euler: [30 * Math.sin(a), 20 * Math.sin(a * 1.3), (a * 20) % 360 - 180], acc: [Math.sin(a * 5), Math.cos(a * 3), 9.8], gyro: [100 * Math.cos(a), 50 * Math.sin(a * 2), 20], q: [Math.cos(a / 2), 0, Math.sin(a / 2), 0] });
    }, 10));
    timers.push(setInterval(() => { // 30 Hz camera-rate streams
      const a = now() - t0 + i, cx = 0.5 + 0.3 * Math.sin(a), cy = 0.4 + 0.2 * Math.cos(a * 0.7);
      s({ type: 'ar', tracking: 'TRACKING', reason: 'NONE', p: [Math.sin(a / 3), 0, Math.cos(a / 3) - 1], q: [0, 0, 0, 1], planes: 2 });
      s({ type: 'tags', tags: [{ id: i, c: [[cx - .1, cy - .07], [cx + .1, cy - .07], [cx + .1, cy + .07], [cx - .1, cy + .07]], p: [cx - .5, cy - .5, 1.2], r: [0, 0, 0] }] });
      s({ type: 'color', found: true, target: [60, 200, 200], x: 1 - cx, y: 0.7, area: 0.01, box: [0.95 - cx, 0.65, 0.1, 0.1] });
      s({ type: 'hands', hands: [{ side: 'Right', score: 0.9, lm: Array.from({ length: 21 }, (_, j) => [0.3 + 0.01 * j * Math.cos(a), 0.6 - 0.012 * j, 0]) }] });
      s({ type: 'pose', found: true, lm: Array.from({ length: 33 }, (_, j) => [0.5 + 0.15 * Math.sin(j + a), 0.1 + j * 0.025, 0, 0.9]) });
    }, 33));
  });
  ws.on('close', () => setTimeout(() => fake(id, i), 1000));
  ws.on('error', () => {});
}
