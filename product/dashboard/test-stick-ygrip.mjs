// A Y-shaped stick with a short handle (its grip toward tag T0, -x) and two long arms: the grip must be the handle's end, not an arm's,
// though the longest path through a Y runs arm to arm.   node test-stick-ygrip.mjs
process.env.MARKER = 'rune';
const { skeleton, SCAN } = await import('./public/stickscan.js');
const segs = [[[-.3, 0], [-.15, 0]], [[-.15, 0], [.2, .2]], [[-.15, 0], [.2, -.2]]], r = .012, f = SCAN.fine, P = []; // handle 15 cm, arms 40 cm
const dSeg = (x, z, [[ax, az], [bx, bz]]) => { const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz))); return Math.hypot(x - ax - t * dx, z - az - t * dz); };
for (let x = -.32; x < .23; x += f) for (let z = -.23; z < .23; z += f) if (Math.min(...segs.map(s => dSeg(x, z, s))) < r) for (let y = f / 2; y < 2 * r; y += f) P.push([x, y, z]);
const m = skeleton(P), [gs, ga] = m.nodes[0], [mx, mz, ax, az] = m.place, gx = mx + ax * ga - az * gs, gz = mz + az * ga + ax * gs;
const ok = Math.hypot(gx + .3, gz) < .03;
console.log(`${ok ? 'ok  ' : 'FAIL'} grip at (${gx.toFixed(3)}, ${gz.toFixed(3)}), the handle's end is (-0.300, 0)`);
process.exit(ok ? 0 : 1);
