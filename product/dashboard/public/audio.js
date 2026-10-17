// Game audio for the display page: Web Audio, one AudioContext, buffers decoded once.
// Mix practice used (see the lead's report for sources):
// - every asset is loudness-normalised to REF_LUFS from offline BS.1770 measurements (ffmpeg ebur128), so the MIX table
//   below is a pure mix decision in dB and does not fight the files' own levels
// - buses: voices -> sfx / amb / bgm -> master (mute, user volume) -> trim -> limiter -> out
// - BGM is ducked sidechain-style (a gain node on the music path) under hits and, deeply, under specials
// - voice limits per event key (steal the oldest with a short fade) and a retrigger guard, so stacked hits stay clear
// - small random pitch / gain per one-shot so repeated shots do not sound like a machine gun of one sample
// - stereo pan from the source's world x; capped so a PA in a hall still plays both sides
// - every start / stop / level change is a short ramp (no clicks); loops are pre-crossfaded at load (no seam)
// Autoplay: Chrome keeps the context suspended until a user gesture ON THIS PAGE. BroadcastChannel messages from
// admin.html are not gestures. unlock() is idempotent; the first pointerdown / keydown / touchend on the page calls it.

const FILES = ['bgm', 'charge', 'fire1', 'fire2', 'fire3', 'lightning1', 'lightning2', 'lightning3'];
// integrated loudness (LUFS) of the part we actually play; re-measure if a file changes:
//   ffmpeg -ss A -to B -i f.mp3 -af ebur128 -f null -
const LUFS = { bgm: -9.1, charge: -13.7, fire1: -12.8, fire2: -8.9, fire3: -10.9, lightning1: -5.1, lightning2: -12.8, lightning3: -7.2 }; // fire3: its first 3 s (BED); lightning3: 0-6 s faded from 3 s (BIG_HIT)
const REF_LUFS = -16;
// what plays what: 1 = shot, 2 = hit / special burst, 3 = aura bed (fire) / the 大 hit (thunder, bigHit)
const EL = { fire: { shot: 'fire1', hit: 'fire2', bed: 'fire3' }, thunder: { shot: 'lightning1', hit: 'lightning2', bigHit: 'lightning3' } };
// thunder's 大: silent launch; on the hit lightning3 plays full until fadeAt, linearly down to silence at end (s) (10/18)
const BIG_HIT = { fadeAt: 3, end: 6 };
// loop regions [start, end, crossfade] s: the beds ramp in for ~1 s and decay for 10+ s, so only the steady middle loops
const LOOPS = { charge: [.2, 4.4, .35] };
// the bed (fire3) plays once from the top: full until fadeAt, down to silence at end (s), no loop (10/18)
const BED = { fadeAt: 2, end: 3 };
const BGM_LOOP = [.09, 82]; // music starts at .14 s and ends in a tail at ~81.3 s; both ends are below -45 dBFS
// mix in dB relative to REF (hit at full power = 0 dB anchor)
const CHARGE_PITCH = { s: .85, m: 1.1, l: 1.45 }; // playback rate (pitch) per charge tier
const MIX = { shot: -5, shotSpan: 4, hit: 0, hitSpan: 6, special: 3, charge: -10, chargeSpan: 5, bed: -17, bgm: -8 };
const DUCK = { hit: [-3, .12, .35], special: [-10, 1.0, .5] }; // [dB, hold s, release s]; attack is DUCK_ATK
const DUCK_ATK = .04;
const LIMIT = { shot: 3, hit: 3, special: 1, play: 4 }; // simultaneous voices per key (key = kind:element)
const MAX_SFX = 16, RETRIGGER = .03;                    // global cap, same key closer than this is dropped
const VAR = { semis: .6, db: 1.5 };                     // ± random pitch (semitones) and gain (dB) per one-shot
const PAN_MAX = .8;
const FADE = .012;                                       // in / steal fade s
const db = d => Math.pow(10, d / 20);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd = r => (Math.random() * 2 - 1) * r;

export function createAudio({ base = 'audio/' } = {}) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  const node = (g = 1) => { const n = ctx.createGain(); n.gain.value = g; return n; };
  // ---- graph ----
  const limiter = ctx.createDynamicsCompressor(); // fast, high ratio: a brickwall-ish limiter for stacked hits
  limiter.threshold.value = -8; limiter.knee.value = 3; limiter.ratio.value = 16; limiter.attack.value = .002; limiter.release.value = .15;
  const trim = node(db(-4));                       // the compressor adds auto make-up gain (~+4 dB here); take it back
  const meter = ctx.createAnalyser(); meter.fftSize = 2048;
  const master = node(), mute = node();
  master.connect(mute).connect(trim).connect(limiter).connect(ctx.destination); limiter.connect(meter);
  const bus = { bgm: node(), sfx: node(), amb: node() };
  const duckG = node();
  bus.bgm.connect(master); bus.sfx.connect(master); bus.amb.connect(master);
  duckG.connect(bus.bgm);
  const vol = { master: .8, bgm: .7, sfx: 1, amb: .8 };
  const curve = v => v * v; // slider 0..1 -> gain: squared is close to perceived loudness and makes 0.5 ~ -12 dB
  const gainOf = { master, ...bus };
  for (const k in vol) gainOf[k].gain.value = curve(vol[k]);
  let muted = false;

  // ---- assets ----
  const buf = {}, norm = {};
  let loaded = false;
  function loopBuffer(b, [a, e, x]) { // seamless loop: the region's tail is equal-power crossfaded into its head
    const sr = b.sampleRate, A = Math.round(a * sr), N = Math.min(b.length, Math.round(e * sr)) - A, X = Math.round(x * sr);
    if (N <= 2 * X) return b;
    const out = ctx.createBuffer(b.numberOfChannels, N - X, sr);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const s = b.getChannelData(c), o = out.getChannelData(c);
      for (let i = 0; i < N - X; i++) o[i] = s[A + X + i];
      for (let i = 0; i < X; i++) { const t = i / X; o[N - 2 * X + i] = s[A + N - X + i] * Math.cos(t * Math.PI / 2) + s[A + i] * Math.sin(t * Math.PI / 2); }
    }
    return out;
  }
  async function load() {
    const failed = [];
    await Promise.all(FILES.map(async name => {
      try {
        const r = await fetch(base + name + '.mp3');
        if (!r.ok) throw new Error(r.status);
        const b = await ctx.decodeAudioData(await r.arrayBuffer());
        buf[name] = LOOPS[name] ? loopBuffer(b, LOOPS[name]) : b;
        norm[name] = db(REF_LUFS - (LUFS[name] ?? REF_LUFS));
      } catch (e) { failed.push(name); console.warn('audio: failed', name, e.message ?? e); }
    }));
    loaded = true;
    return { ok: FILES.filter(n => !failed.includes(n)), failed };
  }

  // ---- unlock ----
  const gestures = ['pointerdown', 'keydown', 'touchend'];
  const onGesture = () => unlock();
  function unlock() { // -> Promise<boolean running>; safe to call any number of times
    if (ctx.state === 'running' || ctx.state === 'closed') return Promise.resolve(ctx.state === 'running');
    return ctx.resume().then(() => ctx.state === 'running', () => false);
  }
  ctx.onstatechange = () => { if (ctx.state === 'running') for (const g of gestures) removeEventListener(g, onGesture, true); };
  for (const g of gestures) addEventListener(g, onGesture, true);

  // ---- one-shots with voice limiting ----
  const voices = []; // { key, src, g, t0 } in start order
  function kill(v, fade = FADE) {
    const t = ctx.currentTime;
    v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + fade);
    try { v.src.stop(t + fade + .005); } catch {}
  }
  function voice(key, name, { gain = 1, pan = 0, rate = 1, dur = 0, rel = .25, vary = true, fade = null } = {}) {
    const b = buf[name];
    if (!b || ctx.state !== 'running' || muted) return null;
    const t = ctx.currentTime, same = voices.filter(v => v.key === key);
    if (same.length && t - same[same.length - 1].t0 < RETRIGGER) return null;
    const kind = key.split(':')[0];
    for (let i = 0; i <= same.length - (LIMIT[kind] ?? 4); i++) { kill(same[i]); voices.splice(voices.indexOf(same[i]), 1); }
    if (voices.length >= MAX_SFX) kill(voices.shift());
    const src = ctx.createBufferSource(), g = ctx.createGain(), p = ctx.createStereoPanner();
    src.buffer = b;
    src.playbackRate.value = rate * (vary ? Math.pow(2, rnd(VAR.semis) / 12) : 1);
    const peak = gain * norm[name] * (vary ? db(rnd(VAR.db)) : 1);
    p.pan.value = clamp(pan, -1, 1) * PAN_MAX;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + FADE * .25); // transients survive a 3 ms fade-in
    src.start(t);
    const len = b.duration / src.playbackRate.value;
    if (dur && dur < len) { g.gain.setValueAtTime(peak, t + dur); g.gain.setTargetAtTime(0, t + dur, rel / 4); src.stop(t + dur + rel * 1.5); }
    if (fade && fade[0] < len) { g.gain.setValueAtTime(peak, t + fade[0]); g.gain.linearRampToValueAtTime(0, t + fade[1]); src.stop(t + fade[1] + .01); } // fade: [from, silent at] s
    src.connect(g).connect(p).connect(bus.sfx);
    const v = { key, src, g, t0: t };
    src.onended = () => { const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1); src.disconnect(); g.disconnect(); p.disconnect(); };
    voices.push(v);
    return v;
  }

  // ---- BGM ducking: the deepest request wins until it is over ----
  let duckEnd = 0, duckDepth = 1;
  function duck([d, hold, rel]) {
    const t = ctx.currentTime, target = db(d);
    if (t < duckEnd && target > duckDepth) return; // a deeper duck is running
    const g = duckG.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    g.linearRampToValueAtTime(target, t + DUCK_ATK);
    g.setValueAtTime(target, t + DUCK_ATK + hold);
    g.linearRampToValueAtTime(1, t + DUCK_ATK + hold + rel);
    duckEnd = t + DUCK_ATK + hold; duckDepth = target;
  }

  // ---- loops: bgm, one charge voice and one bed voice per slot ----
  function loopVoice(name, out, { start = 0, end = 0 } = {}) { // created silent; caller ramps g
    const src = ctx.createBufferSource(), g = node(0), p = ctx.createStereoPanner();
    src.buffer = buf[name]; src.loop = true;
    if (end) { src.loopStart = start; src.loopEnd = end; }
    src.connect(g).connect(p).connect(out);
    src.start(ctx.currentTime, start);
    return { src, g, p, name };
  }
  function release(v, tc) { // fade by time constant, stop once inaudible
    if (!v) return;
    const t = ctx.currentTime;
    v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.setTargetAtTime(0, t, tc);
    v.src.stop(t + tc * 7);
    v.src.onended = () => { v.src.disconnect(); v.g.disconnect(); v.p.disconnect(); };
  }
  let music = null, musicOn = false;
  function bgm(on) {
    on = !!on;
    if (on === musicOn && (!on || music)) return; // cheap enough to call every frame
    if (on && (!buf.bgm || ctx.state !== 'running')) return; // retried on the next call after unlock / load
    musicOn = on;
    if (on) { music = loopVoice('bgm', duckG, { start: BGM_LOOP[0], end: BGM_LOOP[1] }); music.g.gain.setTargetAtTime(db(MIX.bgm) * norm.bgm, ctx.currentTime, .4); }
    else { release(music, .6); music = null; } // ~2 s to silence
  }
  const chg = { A: null, B: null };
  function charge(slot, on, level = 0, pan = 0, tier = 's') {
    let v = chg[slot];
    if (!on) { if (v) { release(v, .05); chg[slot] = null; } return; }
    if (!buf.charge || ctx.state !== 'running' || muted) return;
    if (!v) { v = chg[slot] = loopVoice('charge', bus.sfx); v.lvl = -1; v.pan = 9; v.tier = null; v.src.playbackRate.value = CHARGE_PITCH[tier] ?? CHARGE_PITCH.s; } // start at the tier's pitch: no glide down from 1.0
    const t = ctx.currentTime, l = clamp(level, 0, 1);
    if (Math.abs(l - v.lvl) < .01 && Math.abs(pan - v.pan) < .02 && tier === v.tier) return; // per-frame calls: skip unchanged
    v.lvl = l; v.pan = pan; v.tier = tier;
    v.g.gain.setTargetAtTime(db(MIX.charge + MIX.chargeSpan * l) * norm.charge, t, .03);
    v.src.playbackRate.setTargetAtTime(CHARGE_PITCH[tier] ?? CHARGE_PITCH.s, t, .03); // a riser in steps: each tier is higher, the same tier keeps one pitch
    v.p.pan.setTargetAtTime(clamp(pan, -1, 1) * PAN_MAX, t, .05);
  }
  /** One 3 s pass of a bed: plays from 0, full until BED.fadeAt, linearly down to silence at BED.end, then stops. The level
   *  (g, set by aura()) and this fade (f) are separate gains, so level changes never undo the fade. The voice stays in
   *  beds[slot] after it ends, so a continuing aura does not restart it; it plays again once the aura has gone quiet. */
  function bedVoice(name) {
    const src = ctx.createBufferSource(), f = ctx.createGain(), g = node(0), p = ctx.createStereoPanner(), t = ctx.currentTime;
    src.buffer = buf[name]; src.connect(f).connect(g).connect(p).connect(bus.amb);
    f.gain.setValueAtTime(1, t); f.gain.setValueAtTime(1, t + BED.fadeAt); f.gain.linearRampToValueAtTime(0, t + BED.end);
    src.start(t, 0); src.stop(t + BED.end + .02);
    src.onended = () => { src.disconnect(); f.disconnect(); };
    return { src, g, p, name, t0: t };
  }
  // beds: called every frame. Only touches AudioParams when the value moved, allocates nothing on the steady path.
  const beds = { A: { v: null, el: '', lvl: -1, pan: 9, zero: 0, seen: 0 }, B: { v: null, el: '', lvl: -1, pan: 9, zero: 0, seen: 0 } };
  function aura(slot, element, level = 0, pan = 0) {
    const s = beds[slot], t = ctx.currentTime, name = EL[element]?.bed;
    if (!s || !name) return;
    s.seen = t;
    const l = muted || ctx.state !== 'running' ? 0 : clamp(level, 0, 1);
    if (s.v && s.el !== element) { release(s.v, .15); s.v = null; }
    if (!s.v) {
      if (l <= 0 || !buf[name]) return;
      s.v = bedVoice(name); s.el = element; s.lvl = -1; s.pan = 9;
    }
    if (l > 0) s.zero = 0; else if (!s.zero) s.zero = t;
    if (Math.abs(l - s.lvl) > .01) { s.v.g.gain.setTargetAtTime(db(MIX.bed) * norm[name] * l, t, .15); s.lvl = l; }
    if (Math.abs(pan - s.pan) > .02) { s.v.p.pan.setTargetAtTime(clamp(pan, -1, 1) * PAN_MAX, t, .1); s.pan = pan; }
    if (s.zero && t - s.zero > 1) { release(s.v, .05); s.v = null; } // silent for 1 s: free the voice
  }
  // a slot nobody updates (setup phase, player offline) fades out on its own
  const idle = setInterval(() => { for (const k in beds) if (beds[k].v && ctx.currentTime - beds[k].seen > .3) aura(k, beds[k].el, 0, beds[k].pan); }, 250);

  // ---- game events ----
  const key = (k, el) => k + ':' + el;
  function shot(element, pan = 0, power = .5) {
    const e = EL[element]; if (!e) return;
    const p = clamp(power, 0, 1);
    voice(key('shot', element), e.shot, { pan, gain: db(MIX.shot - MIX.shotSpan * (1 - p)), rate: 1.06 - .12 * p }); // heavier shot: lower
  }
  function hit(element, pan = 0, power = .5) {
    const e = EL[element]; if (!e) return;
    const p = clamp(power, 0, 1);
    if (e.bigHit && p >= 1) { voice(key('special', element) + 'hit', e.bigHit, { pan: pan * .5, gain: db(MIX.special), vary: false, fade: [BIG_HIT.fadeAt, BIG_HIT.end] }); duck(DUCK.special); return; } // the 大 hit (game.js TIER.l.hit = 1)
    // fire2 is a 4 s roar: a normal hit takes its head and lets it go; a stronger hit lets more of it ring
    voice(key('hit', element), e.hit, { pan, gain: db(MIX.hit - MIX.hitSpan * (1 - p)), dur: .5 + .7 * p, rel: .35 });
    if (p >= .5) duck(DUCK.hit);
  }
  function special(element, pan = 0) {
    const e = EL[element]; if (!e) return;
    if (element === 'fire') return shot(element, pan, .6); // trial (10/18): fire's 大 launches with the 中 shot sound (power .6 = game.js TIER.m), no 4.5 s fire2 burst
    if (e.bigHit) return; // thunder's 大: no launch sound, only the hit (lightning3)
    voice(key('special', element), e.shot, { pan, gain: db(MIX.shot + 2), rate: .9, vary: false });  // launch
    voice(key('special', element) + 'b', e.hit, { pan: pan * .5, gain: db(MIX.special), rate: .88, vary: false }); // full, lower burst, wider
    duck(DUCK.special);
  }
  function play(name, { gain = 1, pan = 0, rate = 1 } = {}) { return !!voice(key('play', name), name, { gain, pan, rate, vary: false }); }

  function setVolume(b, v) {
    if (!(b in vol)) return;
    vol[b] = clamp(+v || 0, 0, 1);
    gainOf[b].gain.setTargetAtTime(curve(vol[b]), ctx.currentTime, .05);
  }
  function setMuted(on) {
    muted = !!on;
    mute.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, .03);
    if (muted) { charge('A', false); charge('B', false); }
  }
  function stopAll() {
    for (const v of voices.splice(0)) kill(v, .05);
    charge('A', false); charge('B', false);
    for (const k in beds) { release(beds[k].v, .05); beds[k].v = null; }
    release(music, .05); music = null; musicOn = false;
  }
  const peakBuf = new Float32Array(meter.fftSize);
  function peak() { meter.getFloatTimeDomainData(peakBuf); let m = 0; for (let i = 0; i < peakBuf.length; i++) { const a = Math.abs(peakBuf[i]); if (a > m) m = a; } return m; }
  function dispose() {
    stopAll(); clearInterval(idle);
    for (const g of gestures) removeEventListener(g, onGesture, true);
    setTimeout(() => ctx.close().catch(() => {}), 200);
  }

  return {
    load, unlock,
    get unlocked() { return ctx.state === 'running'; }, get loaded() { return loaded; },
    setVolume, get volumes() { return { ...vol }; }, setMuted, get muted() { return muted; },
    bgm, shot, hit, special, charge, aura, play, stopAll, dispose,
    peak, // output peak (linear) over the last ~43 ms, for meters / tests
    ctx,
  };
}
