// Link to server.mjs /ws as a dashboard (sensing protocol): every phone packet goes to the listeners, and per-type rates / latencies are kept for the
// connection screen. Packet times `t` are PC seconds (the phones sync to the server clock).
export const SLOTS = ['A', 'B'];
const nowS = () => Date.now() / 1000;

export function createHub() {
  const listeners = new Set();
  const slot = s => ({ online: false, name: '', addr: '', last: {}, rate: {}, lat: {} });
  const st = { A: slot('A'), B: slot('B') };
  const hub = { link: 'connecting', phones: st, on: f => listeners.add(f), off: f => listeners.delete(f) };

  function count(s, type, t) {
    const r = s.rate[type] ??= { n: 0, t0: nowS(), hz: 0 };
    r.n++;
    if (t) s.lat[type] = s.lat[type] == null ? nowS() - t : 0.9 * s.lat[type] + 0.1 * (nowS() - t);
  }
  /** Rates in Hz, refreshed once a second (call from a slow UI tick). */
  hub.rates = s => {
    const t = nowS();
    for (const r of Object.values(st[s].rate)) if (t - r.t0 >= 1) { r.hz = r.n / (t - r.t0); r.n = 0; r.t0 = t; }
    return st[s].rate;
  };

  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', role: 'dashboard', id: 'product-' + Math.random().toString(36).slice(2, 8) })); hub.link = 'open'; };
    ws.onclose = () => {
      hub.link = 'closed';
      for (const s of Object.values(st)) s.online = false;
      for (const f of listeners) f({ type: 'phones', list: [] });
      setTimeout(connect, 1000);
    };
    ws.onmessage = m => {
      if (typeof m.data !== 'string') return;
      let k; try { k = JSON.parse(m.data); } catch { return; }
      if (k.type === 'phones') {
        for (const [id, s] of Object.entries(st)) {
          const p = k.list.find(q => q.slot === id);
          s.online = !!p; s.name = p?.name ?? ''; s.addr = p?.addr ?? '';
          if (!p) s.last = {};
        }
      } else {
        const s = st[k.slot]; if (!s) return;
        count(s, k.type, k.t);
        k.rx = nowS();
        s.last[k.type] = k;
      }
      for (const f of listeners) f(k);
    };
  }
  connect();
  return hub;
}
