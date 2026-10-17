// camlink.js — the third-person camera is a phone's browser (cam.html) on the same Wi-Fi. Its back camera reaches the display
// page through server.mjs's /cam socket: signalling for a direct WebRTC stream (host candidates only: same LAN, no internet)
// and, when WebRTC cannot connect (mDNS blocked by the venue Wi-Fi, client isolation…), JPEG frames over that same socket.
//   cam.html:  createCamSender({ url, video, constraints })        → start / stop / listCameras / setCamera / forceJpeg / getStats
//   display:   createCamReceiver({ url, onStream, onFrame, onState }) → onStream(MediaStream) in BOTH modes (JPEG frames are
//              painted on a canvas and handed out as canvas.captureStream(30)), so app.js only ever does video.srcObject = s
// Protocol over /cam (server.mjs): hello{role,id,name}; the server relays {type:'signal',...} cam→displays (or `to` one) and
// display→cam, stamping `from`; binary cam→all displays; cams{list} to displays; displays{count}/welcome to the cam;
// ping{t0}→pong{t0,ts} (ts = server clock in SECONDS). Signal kinds we define:
//   display→cam  want{mode:'webrtc'|'jpeg'}  alive{mode}  bye  sdp{description}  ice{candidate}
//   cam→display  sdp{description}  ice{candidate}  mode{mode:'jpeg'|'auto'}   (the cam is always the offerer: no glare)
// Binary frame: 'C' (0x43) + float64 BE capture time (server clock, ms) + JPEG bytes.

/** /cam socket for the page we are on: server.mjs serves http and https on the same port (8000). */
export function defaultCamUrl() {
  const q = new URLSearchParams(location.search).get('cam'); if (q) return q;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/cam`;
}
const uid = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 8);
const ICE = { iceServers: [] }; // LAN only: STUN would just add seconds of gathering and needs internet we may not have

// ---- WebSocket with hello / ping-pong clock sync / backoff reconnect ----
function openLink({ url, hello, onMessage, onBinary, onState }) {
  let ws = null, closed = false, tries = 0, timer = 0, pinger = 0;
  const clock = { offset: 0, rtt: NaN, samples: [] }; // offset = server − local (ms); the min-RTT sample of the last 10 wins
  const ping = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }));
  const pong = m => {
    const t1 = Date.now(), rtt = t1 - m.t0, ts = m.ts < 1e11 ? m.ts * 1000 : m.ts; // server.mjs sends seconds; tolerate ms
    clock.samples.push({ rtt, offset: ts - (m.t0 + t1) / 2 }); if (clock.samples.length > 10) clock.samples.shift();
    clock.rtt = rtt; clock.offset = clock.samples.reduce((a, b) => b.rtt < a.rtt ? b : a).offset;
  };
  const connect = () => {
    if (closed) return;
    onState('connecting');
    ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
    ws.onopen = () => { tries = 0; ws.send(JSON.stringify(hello())); onState('open'); ping(); clearInterval(pinger); pinger = setInterval(ping, 2000); };
    ws.onmessage = e => {
      if (typeof e.data !== 'string') return onBinary(e.data);
      let m; try { m = JSON.parse(e.data); } catch { return; }
      m.type === 'pong' ? pong(m) : onMessage(m);
    };
    ws.onclose = () => { ws = null; clearInterval(pinger); onState('closed'); if (!closed) timer = setTimeout(connect, Math.min(5000, 500 * 2 ** tries++)); };
    ws.onerror = () => {}; // onclose follows and reconnects
  };
  connect();
  return {
    send: o => { if (ws?.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; },
    sendRaw: b => ws?.readyState === 1 && ws.send(b),
    get buffered() { return ws?.bufferedAmount ?? Infinity; },
    get open() { return ws?.readyState === 1; },
    now: () => Date.now() + clock.offset, clock,
    close() { closed = true; clearTimeout(timer); clearInterval(pinger); ws?.close(); ws = null; },
  };
}

// H.264 first: hardware encode on every iPhone and most Androids (the phone must sustain 1080p30 on battery), hardware or
// OpenH264 decode on the Mac. Constrained Baseline 42e01f is the profile both Safari and Chrome always share, so it leads;
// VP8 is the universal software fallback (Safari ≥ 12.1). RTX/RED/FEC entries sort last and keep working wherever they land.
function preferH264(transceiver, dir) {
  try {
    const caps = (dir === 'send' ? RTCRtpSender : RTCRtpReceiver).getCapabilities?.('video')?.codecs;
    if (!caps?.length) return;
    const rank = c => /h264/i.test(c.mimeType) ? (/42e01f/i.test(c.sdpFmtpLine ?? '') ? 0 : 1) : /vp8/i.test(c.mimeType) ? 2 : /vp9|av1/i.test(c.mimeType) ? 3 : 4;
    transceiver.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
  } catch {} // older Safari throws on entries it does not like: the default order still negotiates something
}
const codecOf = (report, id) => id && report.get(id)?.mimeType?.replace('video/', '');

/* ================================================================================================================ sender */
/**
 * createCamSender({ url, video, constraints, name, maxBitrate, degradation, jpeg })
 *  video: preview <video autoplay muted playsinline> (also what the JPEG fallback reads frames from)
 *  constraints: extra MediaTrackConstraints merged into the camera request
 *  maxBitrate: bps, default 10 Mbps — 1080p30 H.264 is clean at ~8; LAN has the room and the display reads tag edges
 *  degradation: 'maintain-resolution' (default). Measured on Chrome: with 'balanced' the quality scaler starts a new
 *    connection at 640x360 and needs ~30 s to climb back to 1080p (and does it again after every WebRTC↔JPEG flip); with
 *    'maintain-resolution' it is 1920x1080@30 from the first seconds. The display's tag detection and pose tracker also
 *    assume constant frame dimensions. A real bandwidth shortage then costs fps instead of pixels, which the effects over
 *    the video tolerate far better than 360p tags. Only Chrome/Android honour it (read back to see); Safari ignores it.
 *  jpeg: { fps: 15, width: 1280, quality: .7 } fallback encoder
 * → { start({deviceId,width,height,stream}), stop(), listCameras(), setCamera(id), setSize(w,h), forceJpeg(on), getStats(), onState, id }
 */
export function createCamSender({ url = defaultCamUrl(), video, constraints = {}, name = 'cam', maxBitrate = 10e6, degradation = 'maintain-resolution', jpeg = {} } = {}) {
  const J = { fps: 15, width: 1280, quality: .7, ...jpeg };
  const id = uid(), displays = new Map(); // displayId → { mode, seen, pc, dc, tr, making }
  let stream = null, track = null, running = false, forced = false, wake = null, link = null, want = {};
  let state = { ws: 'closed', displays: 0, replaced: false, error: '' };
  const listeners = new Set(), emit = () => listeners.forEach(f => f({ ...state }));
  const set = p => { Object.assign(state, p); emit(); };
  const st = { mode: 'idle', width: 0, height: 0, fps: 0, kbps: 0, codec: '', encodeMs: 0, rtt: NaN, displays: 0, webrtc: 0, jpeg: 0, label: '' };

  // --- camera ---
  const stopStream = () => { stream?.getTracks().forEach(t => t.stop()); stream = track = null; };
  async function openCamera(o) {
    stopStream();
    if (o.stream) stream = o.stream; // caller-provided source (cam.html ?fake test pattern)
    else stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : { facingMode: { ideal: 'environment' } }),
      width: { ideal: o.width ?? 1920 }, height: { ideal: o.height ?? 1080 }, frameRate: { ideal: 30 }, ...constraints } });
    track = stream.getVideoTracks()[0];
    try { track.contentHint = 'motion'; } catch {} // real camera footage: temporal smoothness over per-frame sharpness
    st.label = track.label;
    if (video) { video.srcObject = stream; video.muted = true; video.play().catch(() => {}); } // Safari: muted+playsinline autoplays
    for (const d of displays.values()) d.tr?.sender.replaceTrack(track).catch(() => {}); // same kind: no renegotiation needed
  }

  // --- WebRTC, one connection per display ---
  async function tune(sender) {
    try {
      const p = sender.getParameters(); if (!p.encodings?.length) p.encodings = [{}];
      Object.assign(p.encodings[0], { maxBitrate, scaleResolutionDownBy: 1, networkPriority: 'high' });
      p.degradationPreference = degradation;
      await sender.setParameters(p);
    } catch (e) { console.warn('camlink: setParameters', e.message); }
  }
  function peer(did) {
    const d = displays.get(did);
    if (d.pc && !['failed', 'closed', 'disconnected'].includes(d.pc.connectionState)) return d.pc;
    d.pc?.close();
    const pc = d.pc = new RTCPeerConnection(ICE);
    d.tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    preferH264(d.tr, 'send'); tune(d.tr.sender);
    d.dc = pc.createDataChannel('cam', { ordered: false, maxRetransmits: 0 }); // RTT probes + encoder ticks: stale ones are useless
    d.dc.onmessage = e => { try { const m = JSON.parse(e.data); if (m.k === 'ping') d.dc.send(JSON.stringify({ k: 'pong', t: m.t })); } catch {} };
    pc.onicecandidate = e => e.candidate && link.send({ type: 'signal', kind: 'ice', to: did, candidate: e.candidate });
    pc.onnegotiationneeded = async () => {
      try { d.making = true; await pc.setLocalDescription(await pc.createOffer()); link.send({ type: 'signal', kind: 'sdp', to: did, description: pc.localDescription }); }
      catch (e) { console.warn('camlink: offer', e.message); } finally { d.making = false; }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') tune(d.tr.sender); // encodings definitely exist now
      if (pc.connectionState === 'failed') { pc.close(); d.pc = null; } // the display notices and asks again (or for JPEG)
      count();
    };
    return pc;
  }
  function drop(did) { const d = displays.get(did); if (!d) return; d.pc?.close(); displays.delete(did); count(); }
  const count = () => {
    let w = 0, j = 0; for (const d of displays.values()) d.mode === 'jpeg' ? j++ : d.pc?.connectionState === 'connected' && w++;
    st.webrtc = w; st.jpeg = j; st.displays = displays.size; st.mode = !running ? 'idle' : jpegOn() ? (w ? 'webrtc+jpeg' : 'jpeg') : w ? 'webrtc' : 'waiting';
    if (state.displays !== displays.size) set({ displays: displays.size });
  };

  // --- signalling ---
  async function onSignal(m) {
    const did = m.from; if (!did || !running) return;
    let d = displays.get(did); if (!d) displays.set(did, d = { mode: 'webrtc', seen: 0, pc: null });
    d.seen = Date.now();
    try {
      if (m.kind === 'want' || m.kind === 'alive') { d.mode = m.mode === 'jpeg' ? 'jpeg' : 'webrtc'; if (d.mode === 'jpeg') { d.pc?.close(); d.pc = null; } else if (m.kind === 'want' || !d.pc) peer(did); }
      else if (m.kind === 'bye') return drop(did);
      else if (m.kind === 'sdp' && m.description?.type === 'answer' && d.pc) await d.pc.setRemoteDescription(m.description);
      else if (m.kind === 'ice' && d.pc && m.candidate) await d.pc.addIceCandidate(m.candidate);
    } catch (e) { console.warn('camlink:', m.kind, e.message); }
    count();
  }
  function onMessage(m) {
    if (m.type === 'signal') return onSignal(m);
    if (m.type === 'replaced') { stop(); set({ replaced: true, error: '別の端末がカメラになりました' }); } // newest wins: we bow out for good (no auto-reconnect, or the two phones would keep replacing each other)
    else if (m.type === 'displays' && m.count === 0) { for (const did of [...displays.keys()]) drop(did); }
  }
  setInterval(() => { const t = Date.now() - 10e3; for (const [did, d] of displays) if (d.seen < t) drop(did); }, 5000); // silent displays are gone

  // --- JPEG fallback over the socket ---
  const jpegOn = () => forced || [...displays.values()].some(d => d.mode === 'jpeg');
  const cv = document.createElement('canvas'); let busy = false, jpegFrames = 0, jpegBytes = 0, lastJpeg = 0;
  const hdr = ts => { const b = new DataView(new ArrayBuffer(9)); b.setUint8(0, 0x43); b.setFloat64(1, ts); return b.buffer; };
  async function jpegTick() {
    if (!running) return;
    // ride the preview's frame callbacks when we can (grab a frame the moment it lands, not at a random timer phase)
    video?.requestVideoFrameCallback ? video.requestVideoFrameCallback(jpegTick) : setTimeout(jpegTick, 1000 / J.fps);
    // only when the socket has drained: a slow Wi-Fi must cost frames, never seconds of queue (= latency)
    const t = performance.now();
    if (!jpegOn() || busy || !video?.videoWidth || link.buffered > 300e3 || t - lastJpeg < 1000 / J.fps - 4) return;
    lastJpeg = t; busy = true;
    try {
      const w = Math.min(J.width, video.videoWidth), h = Math.round(w * video.videoHeight / video.videoWidth);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      cv.getContext('2d').drawImage(video, 0, 0, w, h);
      const ts = link.now();
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', J.quality));
      if (blob) { link.sendRaw(new Blob([hdr(ts), blob])); jpegFrames++; jpegBytes += blob.size + 9; }
    } finally { busy = false; }
  }

  // --- stats: 1 Hz ---
  let prev = null;
  async function statsTick() {
    if (!running) return;
    setTimeout(statsTick, 1000);
    st.rtt = link.clock.rtt;
    const s = track?.getSettings?.() ?? {}; st.width = video?.videoWidth || s.width || 0; st.height = video?.videoHeight || s.height || 0;
    const d = [...displays.values()].find(x => x.pc?.connectionState === 'connected');
    let tick = null;
    if (d) {
      const r = await d.pc.getStats().catch(() => null);
      const o = r && [...r.values()].find(x => x.type === 'outbound-rtp' && x.kind === 'video');
      if (o) {
        const t = performance.now();
        if (prev && o.framesEncoded >= prev.framesEncoded) {
          const dt = (t - prev.t) / 1000, df = o.framesEncoded - prev.framesEncoded;
          st.fps = Math.round(df / dt); st.kbps = Math.round((o.bytesSent - prev.bytesSent) * 8 / dt / 1000);
          st.encodeMs = df ? Math.round((o.totalEncodeTime - prev.totalEncodeTime) / df * 1000) : 0;
        }
        prev = { t, framesEncoded: o.framesEncoded, bytesSent: o.bytesSent, totalEncodeTime: o.totalEncodeTime };
        st.codec = codecOf(r, o.codecId) ?? st.codec; st.limit = o.qualityLimitationReason ?? ''; // 'cpu' | 'bandwidth' | 'none': why the picture shrank
        st.targetKbps = Math.round((o.targetBitrate ?? 0) / 1000); // what the bandwidth estimator currently allows the encoder
        st.bweKbps = Math.round(([...r.values()].find(x => x.type === 'candidate-pair' && x.nominated && x.availableOutgoingBitrate)?.availableOutgoingBitrate ?? 0) / 1000);
        if (o.frameWidth) { st.width = o.frameWidth; st.height = o.frameHeight; }
        tick = JSON.stringify({ k: 'tick', enc: st.encodeMs, fps: st.fps, w: st.width, h: st.height, t: link.now() });
      }
    } else { prev = null; }
    if (!d || jpegOn()) { // JPEG numbers when that is what (also) goes out
      const jf = jpegFrames, jb = jpegBytes; jpegFrames = jpegBytes = 0;
      if (!d) { st.fps = jf; st.kbps = Math.round(jb * 8 / 1000); st.codec = jf ? 'JPEG' : ''; }
      st.jpegFps = jf; st.jpegKbps = Math.round(jb * 8 / 1000);
    } else st.jpegFps = st.jpegKbps = 0;
    if (tick) for (const x of displays.values()) if (x.dc?.readyState === 'open') x.dc.send(tick);
    count();
  }

  // --- screen wake lock (Chrome 84 / iOS Safari 16.4; a playing inline video also keeps iOS awake) ---
  async function keepAwake() { try { wake?.release?.(); wake = await navigator.wakeLock?.request('screen'); } catch {} }
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') keepAwake(); });

  async function start(o = {}) {
    want = o;
    await openCamera(o);
    running = true; set({ replaced: false, error: '' });
    link ??= openLink({ url, hello: () => ({ type: 'hello', role: 'cam', id, name }), onMessage, onBinary: () => {},
      onState: ws => { set({ ws }); if (ws !== 'open') for (const d of displays.values()) { d.pc?.close(); d.pc = null; } } }); // displays re-ask after a reconnect
    keepAwake(); jpegTick(); statsTick(); count();
  }
  function stop(closeLink = true) {
    running = false; stopStream();
    for (const did of [...displays.keys()]) drop(did);
    if (closeLink) { link?.close(); link = null; }
    wake?.release?.(); wake = null; prev = null; st.fps = st.kbps = 0; st.mode = 'idle'; set({ ws: closeLink ? 'closed' : state.ws });
  }
  async function listCameras() {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const back = all.filter(d => /back|rear|背面|environment|facing back|後面/i.test(d.label)); // iOS: "背面カメラ"/"Back …", Android: "camera2 0, facing back"
    return (back.length ? back : all).map(d => ({ id: d.deviceId, label: d.label || 'camera' }));
  }
  return {
    id, start, stop, listCameras,
    setCamera: deviceId => openCamera({ ...want, stream: undefined, deviceId }),
    setSize: (width, height) => openCamera({ ...want, stream: undefined, width, height }),
    forceJpeg(on) { forced = !!on; link?.send({ type: 'signal', kind: 'mode', mode: on ? 'jpeg' : 'auto' }); if (on) for (const d of displays.values()) { d.pc?.close(); d.pc = null; } count(); },
    get forcedJpeg() { return forced; },
    getStats: () => ({ ...st, clockOffset: Math.round(link?.clock.offset ?? 0) }),
    onState(f) { listeners.add(f); f({ ...state }); return () => listeners.delete(f); },
    get stream() { return stream; },
  };
}

/* ============================================================================================================== receiver */
/**
 * createCamReceiver({ url, onStream, onFrame, onState, name, fallbackMs })
 *  onStream(MediaStream)  the remote WebRTC stream, or the canvas stream carrying decoded JPEG frames (fires on every switch)
 *  onFrame(ImageBitmap)   JPEG mode only, per decoded frame; the bitmap is closed when the callback returns
 *  onState({ mode:'idle'|'connecting'|'webrtc'|'jpeg', cam:{id,name}|null, ws, reason })
 *  fallbackMs             no WebRTC track within this long after asking → JPEG (default 6000)
 * → { requestFallback(), requestWebRTC(), getStats(), close(), mode, canvas, id }
 */
export function createCamReceiver({ url = defaultCamUrl(), onStream, onFrame, onState, name = 'display', fallbackMs = 6000 } = {}) {
  const id = uid();
  let cam = null, pc = null, dc = null, pending = [], remote = null, pref = 'auto', camForced = false, cur = null, mode = 'idle', ws = 'closed', fbTimer = 0, discTimer = 0;
  const canvas = document.createElement('canvas'); let cstream = null, latest = null, decoding = false;
  const st = { mode, width: 0, height: 0, fps: 0, kbps: 0, codec: '', latencyMs: NaN, latencyKind: '', peerRtt: NaN, rtt: NaN, encodeMs: 0, procMs: NaN, cam: null };
  let frames = 0, bytes = 0, latSum = 0, latN = 0, prev = null;
  let link; // opened at the bottom: openLink reports 'connecting' synchronously, before the helpers below exist
  const emit = reason => onState?.({ mode, cam, ws, reason });
  const setMode = (m, reason) => { if (m !== mode) { mode = m; st.mode = m; Object.assign(st, { fps: 0, kbps: 0, codec: '', latencyMs: NaN, latencyKind: '', procMs: NaN }); emit(reason); } };
  const sendSig = o => link.send({ type: 'signal', ...o });

  function teardown() { clearTimeout(fbTimer); clearTimeout(discTimer); pc?.close(); pc = dc = null; pending = []; remote = null; prev = null; }
  function ask(m) {
    cur = m; sendSig({ kind: 'want', mode: m });
    clearTimeout(fbTimer);
    if (m === 'webrtc') { setMode('connecting', 'want webrtc'); fbTimer = setTimeout(() => { if (mode !== 'webrtc') fallback('no WebRTC track in ' + fallbackMs + ' ms'); }, fallbackMs); }
    else setMode('jpeg', 'want jpeg');
  }
  function fallback(reason) { teardown(); ask('jpeg'); emit(reason); }
  function reset() { // a cam (re)appeared: start clean with the preferred transport
    teardown(); if (!cam) return setMode('idle', 'no cam');
    ask(pref === 'jpeg' || camForced ? 'jpeg' : 'webrtc');
  }
  setInterval(() => cam && sendSig({ kind: 'alive', mode: cur }), 3000); // keeps the cam's display list (and its JPEG loop) honest
  addEventListener('pagehide', () => sendSig({ kind: 'bye' }));

  function makePc() {
    teardown(); clearTimeout(fbTimer); fbTimer = setTimeout(() => { if (mode !== 'webrtc') fallback('offer but no track'); }, fallbackMs);
    pc = new RTCPeerConnection(ICE);
    pc.onicecandidate = e => e.candidate && sendSig({ kind: 'ice', candidate: e.candidate });
    pc.ontrack = e => {
      remote = e.streams[0] ?? new MediaStream([e.track]);
      clearTimeout(fbTimer); setMode('webrtc', 'track'); onStream?.(remote);
      e.track.onmute = () => {}; // Safari fires mute/unmute on orientation flips: nothing to do, the element follows
    };
    pc.ondatachannel = e => { dc = e.channel; dc.onmessage = ev => { try { const m = JSON.parse(ev.data); if (m.k === 'pong') st.peerRtt = Math.round(performance.now() - m.t); else if (m.k === 'tick') st.encodeMs = m.enc; } catch {} }; };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed') fallback('ice failed');
      else if (s === 'disconnected') { clearTimeout(discTimer); discTimer = setTimeout(() => pc?.connectionState === 'disconnected' && fallback('disconnected'), 3000); }
      else if (s === 'connected') clearTimeout(discTimer);
    };
    return pc;
  }
  async function onSignal(m) {
    try {
      if (m.kind === 'mode') { camForced = m.mode === 'jpeg'; if (camForced) fallback('cam forced jpeg'); else if (pref !== 'jpeg') reset(); return; }
      if (cur === 'jpeg') return; // ignore late WebRTC chatter: we asked for pictures
      if (m.kind === 'sdp' && m.description?.type === 'offer') {
        const p = makePc();
        await p.setRemoteDescription(m.description);
        for (const t of p.getTransceivers()) preferH264(t, 'recv');
        await p.setLocalDescription(await p.createAnswer());
        sendSig({ kind: 'sdp', description: p.localDescription });
        for (const c of pending) await p.addIceCandidate(c).catch(() => {}); pending = [];
      } else if (m.kind === 'ice' && m.candidate) {
        if (pc?.remoteDescription) await pc.addIceCandidate(m.candidate); else pending.push(m.candidate);
      }
    } catch (e) { console.warn('camlink:', m.kind, e.message); }
  }
  function onMessage(m) {
    if (m.type === 'signal') return onSignal(m);
    if (m.type === 'cams') {
      const c = m.list?.[0] ?? null;
      if (c?.id !== cam?.id) { cam = c; st.cam = c; camForced = false; reset(); } // new cam id = new phone or a reload: renegotiate
    }
  }

  // --- JPEG frames: decode the newest only, paint, hand out as a 30 fps canvas stream ---
  function onBinary(buf) {
    if (cur !== 'jpeg') return; // a sibling display is in JPEG mode; not our picture to decode
    const u8 = new Uint8Array(buf); if (u8[0] !== 0x43) return;
    const hasTs = u8[1] !== 0xff, ts = hasTs ? new DataView(buf).getFloat64(1) : NaN, off = hasTs ? 9 : 1; // tolerate 'C'+JPEG
    latest = { blob: new Blob([u8.subarray(off)], { type: 'image/jpeg' }), ts }; bytes += u8.length;
    if (!decoding) decodeLoop();
  }
  async function decodeLoop() {
    decoding = true;
    while (latest) {
      const { blob, ts } = latest; latest = null;
      try {
        const bmp = await createImageBitmap(blob);
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        if (!cstream) { cstream = canvas.captureStream(30); }
        if (mode !== 'jpeg' || !remote) { remote = cstream; setMode('jpeg', 'frames'); onStream?.(cstream); }
        else if (remote !== cstream) { remote = cstream; onStream?.(cstream); }
        frames++; if (ts) { latSum += link.now() - ts; latN++; }
        st.width = bmp.width; st.height = bmp.height;
        try { onFrame?.(bmp); } finally { bmp.close(); }
      } catch (e) { console.warn('camlink: jpeg decode', e.message); }
    }
    decoding = false;
  }

  // --- stats 1 Hz; latency: JPEG = measured against the server-synced clock; WebRTC = estimate from parts we can measure ---
  setInterval(async () => {
    st.rtt = link.clock.rtt;
    if (mode === 'jpeg') {
      st.fps = frames; st.kbps = Math.round(bytes * 8 / 1000); st.codec = 'JPEG';
      st.latencyMs = latN ? Math.round(latSum / latN) : NaN; st.latencyKind = 'measured'; st.procMs = NaN;
      frames = bytes = latSum = latN = 0;
    } else if (pc && mode === 'webrtc') {
      if (dc?.readyState === 'open') dc.send(JSON.stringify({ k: 'ping', t: performance.now() }));
      const r = await pc.getStats().catch(() => null);
      const i = r && [...r.values()].find(x => x.type === 'inbound-rtp' && x.kind === 'video');
      if (i) {
        const t = performance.now();
        if (prev) {
          const dt = (t - prev.t) / 1000, df = i.framesDecoded - prev.framesDecoded;
          st.fps = Math.round(df / dt); st.kbps = Math.round((i.bytesReceived - prev.bytesReceived) * 8 / dt / 1000);
          // Chrome: totalProcessingDelay = last packet received → frame decoded (jitter buffer + decode); else jitter buffer + decode time
          const proc = i.totalProcessingDelay != null ? i.totalProcessingDelay - prev.totalProcessingDelay
            : (i.jitterBufferDelay - prev.jitterBufferDelay) + (i.totalDecodeTime - prev.totalDecodeTime);
          st.procMs = df ? Math.round(proc / df * 1000) : st.procMs;
          // capture→encode ≈ half a frame interval, + encoder (cam tick), + one-way network, + receive→decoded, + one vsync to paint
          st.latencyMs = st.fps ? Math.round(500 / st.fps + (st.encodeMs || 0) + (st.peerRtt || 0) / 2 + (st.procMs || 0) + 16) : NaN;
          st.latencyKind = 'estimated';
        }
        prev = { t, framesDecoded: i.framesDecoded, bytesReceived: i.bytesReceived, totalProcessingDelay: i.totalProcessingDelay, jitterBufferDelay: i.jitterBufferDelay, totalDecodeTime: i.totalDecodeTime };
        st.codec = codecOf(r, i.codecId) ?? st.codec; if (i.frameWidth) { st.width = i.frameWidth; st.height = i.frameHeight; }
      }
    } else { st.fps = st.kbps = 0; st.latencyMs = NaN; prev = null; }
  }, 1000);

  link = openLink({ url, hello: () => ({ type: 'hello', role: 'display', id, name }), onMessage, onBinary, onState: s => { ws = s; if (s !== 'open') { cam = null; teardown(); setMode('idle', 'ws ' + s); } emit(); } });
  return {
    id, canvas,
    get mode() { return mode; }, get cam() { return cam; },
    requestFallback() { pref = 'jpeg'; fallback('requested'); },
    requestWebRTC() { pref = 'webrtc'; camForced = false; if (cam) { teardown(); ask('webrtc'); } },
    getStats: () => ({ ...st, clockOffset: Math.round(link.clock.offset) }),
    close() { sendSig({ kind: 'bye' }); teardown(); link.close(); setMode('idle', 'closed'); },
  };
}

/* ============================================================================================ test helpers (cam-test.html) */
// A clock painted into the picture as 28 black/white cells (each 1/60 of the width, top-left) so the receiving page can read
// the true glass-to-glass delay from the pixels: [white][black][24 bits of server-clock ms, MSB first][parity][white].
// Geometry scales with the picture width, so it survives the encoder downscaling the frame.
const BITS = 24, N = BITS + 4, geo = w => ({ x: w / 80, y: w / 80, cell: w / 60 });
export function drawClockBar(ctx, tMs) {
  const { x, y, cell } = geo(ctx.canvas.width), v = Math.round(tMs) & 0xffffff, par = (v.toString(2).split('1').length - 1) & 1;
  const cells = [1, 0, ...Array.from({ length: BITS }, (_, i) => (v >> (BITS - 1 - i)) & 1), par, 1];
  cells.forEach((b, i) => { ctx.fillStyle = b ? '#fff' : '#000'; ctx.fillRect(x + i * cell, y, cell + 1, cell); });
}
/** Reads the bar from a <video>/canvas → ms value (24 bit) or NaN. `work` is a reusable 2d canvas. */
export function readClockBar(src, work) {
  const sw = src.videoWidth || src.width, { x, y, cell } = geo(sw), w = N * 8, n = N; // resample each cell to 8 px
  if (work.width !== w || work.height !== 1) { work.width = w; work.height = 1; }
  const g = work.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, x, y + cell / 2, N * cell, 1, 0, 0, w, 1); // one scanline through the cell centres
  const px = g.getImageData(0, 0, w, 1).data, lum = i => px[(i * 8 + 4) * 4 + 1] > 128 ? 1 : 0, bits = BITS;
  if (!lum(0) || lum(1) || !lum(n - 1)) return NaN;
  let v = 0, ones = 0; for (let i = 0; i < bits; i++) { const b = lum(2 + i); v = v * 2 + b; ones += b; }
  return (ones & 1) === lum(n - 2) ? v : NaN;
}
