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

    private struct Loop { let node: AVAudioPlayerNode; let vari: AVAudioUnitVarispeed; let buf: AVAudioPCMBuffer }

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
            let node = AVAudioPlayerNode(), vari = AVAudioUnitVarispeed()
            engine.attach(node); engine.attach(vari)
            engine.connect(node, to: vari, format: buf.format)
            engine.connect(vari, to: engine.mainMixerNode, format: buf.format)
            loops[name] = Loop(node: node, vari: vari, buf: buf)
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
            }
            if tier == "l" && self.tier != "l", let s = self.stings[element] { s.currentTime = 0; s.play() } // 大 reached
            self.tier = tier
            loop.vari.rate = ChargeSound.pitch[tier] ?? ChargeSound.pitch["s"]!
            // audio.js: db(MIX.charge + MIX.chargeSpan * level), here relative to a full charge (0 dB on the phone's speaker)
            loop.node.volume = Float(pow(10, ChargeSound.spanDb * (min(max(level, 0), 1) - 1) / 20))
            if first { self.watchLease() }
        }
    }

    func stop() { q.async { [weak self] in self?.stopNow() } }

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
