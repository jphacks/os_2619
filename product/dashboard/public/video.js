// The third-person picture in one <video>: phone C's browser (cam.html → /cam, WebRTC or JPEG fallback, camlink.js),
// a camera on this PC, or the rendered dummy room (dummycam.js, for trying everything without hardware).
// Every consumer (game stage, final render, connection screen preview, tag scan, pose tracker) reads this one element.
export const SOURCES = { remote: 'スマホ C', local: 'この PC のカメラ', dummy: 'ダミーの部屋' };

export function createVideoSource(video, { onChange = () => {} } = {}) {
  const S = { mode: null, msg: '', rx: null, dummy: null, cams: [], devices: [], camState: 'idle' };
  const say = m => { S.msg = m; };
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.onloadedmetadata = () => { video.play().catch(() => {}); onChange(); };

  function stopAll() {
    S.rx?.close?.(); S.rx = null;
    S.dummy?.stop?.(); S.dummy = null; video.__dummy = null; // the scan reads the dummy room's own canvas (sharper than its stream)
    video.srcObject?.getTracks?.().forEach(t => t.stop());
    video.srcObject = null;
  }
  async function remote() {
    const M = await import('./camlink.js');
    S.rx = M.createCamReceiver({ name: 'dashboard',
      onStream: stream => { if (video.srcObject !== stream) { video.srcObject = stream; video.play().catch(() => {}); onChange(); } },
      onState: st => {
        S.camState = st.mode; S.cam = st.cam; S.ws = st.ws;
        say(st.ws !== 'open' ? 'サーバーにつないでいます…' : { idle: 'スマホ C の cam.html で「開始」を待っています', connecting: 'スマホ C に接続中…', jpeg: 'JPEG で受信中（WebRTC が使えない）', webrtc: 'WebRTC で受信中' }[st.mode] ?? '');
      } });
  }
  async function local(deviceId) {
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 1920, height: 1080 } });
      try { localStorage.setItem('pd-camdev', deviceId ?? ''); } catch {}
      say('');
    } catch (e) { say(e.name === 'OverconstrainedError' ? '前回のカメラが見つかりません' : 'カメラ: ' + e.message); }
    listDevices();
  }
  async function dummy() {
    const { createDummyCam } = await import('./dummycam.js');
    S.dummy = createDummyCam({ width: 1920, height: 1080 }); // same size as a phone picture, so small far sheets behave alike
    video.srcObject = S.dummy.stream; video.__dummy = S.dummy;
    say('ダミーの部屋（テスト用の描画）');
    onChange();
  }
  async function listDevices() {
    try { S.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map(d => ({ id: d.deviceId, label: d.label || 'カメラ' })); } catch {}
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);

  return {
    video, state: S,
    async set(mode, deviceId) {
      stopAll(); S.mode = mode; say('');
      try {
        if (mode === 'dummy') await dummy();
        else if (mode === 'local') await local(deviceId ?? (localStorage.getItem('pd-camdev') || undefined));
        else await remote();
      } catch (e) { say('映像の入力を開けません: ' + e.message); }
      onChange();
    },
    get dummy() { return S.dummy; },
    stats: () => S.rx?.getStats?.() ?? null,
    jpeg: () => S.rx?.requestFallback?.(), webrtc: () => S.rx?.requestWebRTC?.(),
    listDevices,
  };
}
