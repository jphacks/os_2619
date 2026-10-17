// Streams synthetic data as one or two phones, to try the dashboard without hardware.
// AR, tags, colour and pose come from the geometric scene in sim.mjs, so the space map has something real to fit.
// Run: node fake-phone.mjs [count=2] [host=localhost:8000]
import WebSocket from 'ws';
import { packets } from './sim.mjs';

const n = +(process.argv[2] ?? 2), host = process.argv[3] ?? 'localhost:8000';
for (let i = 0; i < n; i++) fake(`fake-${i}`, i);

function fake(id, i) {
  const ws = new WebSocket(`ws://${host}/ws`);
  const now = () => Date.now() / 1000;
  let slot = null; // the scene role follows the slot the server hands out
  ws.on('message', d => { try { const k = JSON.parse(d); if (k.type === 'welcome') slot = k.slot; } catch {} });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', role: 'phone', id, name: `Fake ${i}` }));
    const t0 = now(), timers = [];
    let frame = 0;
    ws.on('close', () => timers.forEach(clearInterval));
    const s = (k) => ws.readyState === 1 && ws.send(JSON.stringify({ t: now(), ...k }));
    timers.push(setInterval(() => ws.send(JSON.stringify({ type: 'ping', t0: now() })), 1000));
    timers.push(setInterval(() => { // 100 Hz IMU
      const a = now() - t0 + i;
      s({ type: 'imu', euler: [30 * Math.sin(a), 20 * Math.sin(a * 1.3), (a * 20) % 360 - 180], acc: [Math.sin(a * 5), Math.cos(a * 3), 9.8], gyro: [100 * Math.cos(a), 50 * Math.sin(a * 2), 20], q: [Math.cos(a / 2), 0, Math.sin(a / 2), 0] });
    }, 10));
    timers.push(setInterval(() => { // 30 Hz camera: AR every frame, detectors every other frame
      if (!slot || ws.readyState !== 1) return;
      for (const k of packets(slot, now(), frame++ % 2 === 0)) ws.send(JSON.stringify(k));
      const a = now() - t0 + i;
      s({ type: 'hands', hands: [{ side: 'Right', score: 0.9, lm: Array.from({ length: 21 }, (_, j) => [0.3 + 0.01 * j * Math.cos(a), 0.6 - 0.012 * j, 0]) }] });
    }, 33));
  });
  ws.on('close', () => setTimeout(() => fake(id, i), 1000));
  ws.on('error', () => {});
}
