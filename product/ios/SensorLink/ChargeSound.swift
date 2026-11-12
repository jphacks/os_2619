import AVFoundation

/// The PC's charge sound, on the phone too (`vibrate` packets with kind = charge, game.js stepBuzz): the element's loop
/// (charge_<element>.mp3, the same files as dashboard/public/audio), looped over the same region with the same crossfade, the
/// same pitch per tier, louder as the charge fills, and the 大 sting (full_<element>) when the tier reaches 大. Same as
/// ChargeSound.kt and audio.js charge() (LOOPS, CHARGE_PITCH, MIX.chargeSpan). The PC repeats the packet every 0.25 s; with
/// no repeat for `lease` s it stops by itself (like Vibe), so a lost PC or link cannot leave it on. Any thread.
final class ChargeSound {
    private static let lease = 1.0
    private static let spanDb = 5.0 // audio.js MIX.chargeSpan
    private static let elements = ["fire", "thunder", "water", "wind"]
    private static let pitch: [String: Float] = ["s": 0.85, "m": 1.1, "l": 1.45] // audio.js CHARGE_PITCH
    // audio.js LOOPS: [start, end, crossfade] s
    private static let regions: [String: [Double]] = ["charge": [0.2, 4.4, 0.35]]
        .merging(Dictionary(uniqueKeysWithValues: elements.map { ("charge_\($0)", [0.25, 4.75, 0.4]) })) { a, _ in a }

    private struct Loop { let node: AVAudioPlayerNode; let vari: AVAudioUnitVarispeed; let buf: AVAudioPCMBuffer; let rev: AVAudioPlayerNode }
    // audio.js FAIL_REV: the reversed run on a failed charge
    private static let failFade = 0.3, failSpan = 0.35, failMin = 1.8, failMax = 4.0
    private var heard = 0.0, heardAt = 0.0, rate: Float = 1, vol: Float = 1 // s of the loop played up to heardAt (the pitch changes the pace)

    private let q = DispatchQueue(label: "chargesound")
    private let engine = AVAudioEngine()
    private var loops: [String: Loop] = [:]
    private var stings: [String: AVAudioPlayer] = [:]
    private var cur: String?
    private var tier: String?
    private var leaseEnd = 0.0

    init() { q.async { self.setup() } }

    private static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    private func setup() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        for (name, r) in ChargeSound.regions {
            guard let url = Bundle.main.url(forResource: name, withExtension: "mp3"), let buf = ChargeSound.loopBuffer(url, r) else { continue }
            let node = AVAudioPlayerNode(), vari = AVAudioUnitVarispeed(), rev = AVAudioPlayerNode()
            engine.attach(node); engine.attach(vari); engine.attach(rev)
            engine.connect(node, to: vari, format: buf.format)
            engine.connect(vari, to: engine.mainMixerNode, format: buf.format)
            engine.connect(rev, to: engine.mainMixerNode, format: buf.format)
            loops[name] = Loop(node: node, vari: vari, buf: buf, rev: rev)
        }
        for e in ChargeSound.elements {
            if let url = Bundle.main.url(forResource: "full_\(e)", withExtension: "mp3"), let p = try? AVAudioPlayer(contentsOf: url) { p.prepareToPlay(); stings[e] = p }
        }
        engine.prepare()
        try? engine.start()
    }

    /// One `charge` packet: element (fire / thunder / water / wind), tier s / m / l, level 0...1.
    func charge(element: String, tier: String, level: Double) {
        q.async { [weak self] in
            guard let self = self else { return }
            let name = self.loops["charge_\(element)"] != nil ? "charge_\(element)" : "charge"
            guard let loop = self.loops[name] else { return }
            if !self.engine.isRunning { try? self.engine.start() } // an interruption (a call, Siri) stops the engine
            let first = self.cur == nil
            self.leaseEnd = ChargeSound.now() + ChargeSound.lease
            if self.cur != name {
                self.stopNow()
                loop.node.scheduleBuffer(loop.buf, at: nil, options: [.loops])
                loop.node.play()
                self.cur = name
                self.heard = 0; self.heardAt = ChargeSound.now()
            }
            if tier == "l" && self.tier != "l", let s = self.stings[element] { s.currentTime = 0; s.play() } // 大 reached
            if tier != self.tier { let t = ChargeSound.now(); self.heard += (t - self.heardAt) * Double(self.rate); self.heardAt = t; self.rate = ChargeSound.pitch[tier] ?? ChargeSound.pitch["s"]! }
            self.tier = tier
            loop.vari.rate = self.rate
            // audio.js: db(MIX.charge + MIX.chargeSpan * level), here relative to a full charge (0 dB on the phone's speaker)
            self.vol = Float(pow(10, ChargeSound.spanDb * (min(max(level, 0), 1) - 1) / 20))
            loop.node.volume = self.vol
            if first { self.watchLease() }
        }
    }

    func stop() { q.async { [weak self] in self?.stopNow() } }

    /// The charge broke off (audio.js chargeFail): instead of a cut, the charge heard so far plays backwards, fast, from where
    /// the loop is now, fading to silence over failFade s.
    func fail() {
        q.async { [weak self] in
            guard let self = self, let name = self.cur, let loop = self.loops[name], let s = loop.buf.floatChannelData else { return }
            let sofar = self.heard + (ChargeSound.now() - self.heardAt) * Double(self.rate)
            let frames = Int(loop.buf.frameLength)
            var pos = 0.0
            if let nt = loop.node.lastRenderTime, let pt = loop.node.playerTime(forNodeTime: nt) { pos = Double(pt.sampleTime) }
            pos = pos.truncatingRemainder(dividingBy: Double(frames)); if pos < 0 { pos += Double(frames) }
            self.stopNow()
            guard sofar >= 0.05, frames > 1 else { return }
            let sr = loop.buf.format.sampleRate, ch = Int(loop.buf.format.channelCount)
            let speed = Double(self.rate) * min(max(min(sofar, 3) / ChargeSound.failSpan, ChargeSound.failMin), ChargeSound.failMax)
            let n = Int((ChargeSound.failFade * sr).rounded())
            guard let out = AVAudioPCMBuffer(pcmFormat: loop.buf.format, frameCapacity: AVAudioFrameCount(n)), let o = out.floatChannelData else { return }
            out.frameLength = AVAudioFrameCount(n)
            for i in 0..<n {
                var x = (pos - Double(i) * speed).truncatingRemainder(dividingBy: Double(frames)); if x < 0 { x += Double(frames) }
                let k = Int(x) % frames, k1 = (k + 1) % frames, a = Float(x - Double(Int(x)))
                let g = self.vol * (1 - Float(i) / Float(n))
                for c in 0..<ch { o[c][i] = (s[c][k] * (1 - a) + s[c][k1] * a) * g }
            }
            if !self.engine.isRunning { try? self.engine.start() }
            loop.rev.stop(); loop.rev.scheduleBuffer(out, at: nil); loop.rev.play()
        }
    }

    private func stopNow() {
        if let c = cur { loops[c]?.node.stop() }
        cur = nil; tier = nil
    }

    private func watchLease() {
        q.asyncAfter(deadline: .now() + max(0.05, leaseEnd - ChargeSound.now())) { [weak self] in
            guard let self = self, self.cur != nil else { return }
            if ChargeSound.now() >= self.leaseEnd { self.stopNow() } else { self.watchLease() }
        }
    }

    /// The file's [a, e) s with its last x s equal-power crossfaded into its head (audio.js loopBuffer), to loop with no seam.
    private static func loopBuffer(_ url: URL, _ r: [Double]) -> AVAudioPCMBuffer? {
        guard let f = try? AVAudioFile(forReading: url),
              let src = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)),
              (try? f.read(into: src)) != nil, let s = src.floatChannelData else { return nil }
        let sr = f.processingFormat.sampleRate, len = Int(src.frameLength)
        let a = Int((r[0] * sr).rounded()), n = min(len, Int((r[1] * sr).rounded())) - a, x = Int((r[2] * sr).rounded())
        guard n > 2 * x, let out = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(n - x)), let o = out.floatChannelData else { return nil }
        out.frameLength = AVAudioFrameCount(n - x)
        for c in 0..<Int(f.processingFormat.channelCount) {
            for i in 0..<(n - 2 * x) { o[c][i] = s[c][a + x + i] }
            for i in 0..<x {
                let t = Float(i) / Float(x)
                o[c][n - 2 * x + i] = s[c][a + n - x + i] * cos(t * .pi / 2) + s[c][a + i] * sin(t * .pi / 2)
            }
        }
        return out
    }
}
