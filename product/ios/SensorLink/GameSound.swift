import AVFoundation

/// The game's sounds that concern this player (`sfx` packets, dashboard app.js phoneSound): their shot / 大, their guard and
/// reflect, a hit they took or landed. Each voice says which file (the same files as dashboard/public/audio) and how the PC
/// plays it (audio.js voice): gain, rate, offset, dur + rel (a release), fade [from, silent at]. The voice is rendered into a
/// buffer here exactly so and played once. Same as GameSound.kt. Files are read once at start. Any thread.
final class GameSound {
    private static let files = ["fire", "lightning", "water", "wind"].flatMap { e in (1...3).map { "\(e)\($0)" } } + ["guard", "guard_reflect", "damage", "my_shot", "my_launch"]
    private static let perFormat = 4 // voices at once per file format

    private let q = DispatchQueue(label: "gamesound")
    private let engine = AVAudioEngine()
    private var bufs: [String: AVAudioPCMBuffer] = [:]
    private var nodes: [String: [AVAudioPlayerNode]] = [:] // by format: a few players, used in turn
    private var next: [String: Int] = [:]

    init() { q.async { self.setup() } }

    private func setup() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        for name in GameSound.files {
            guard let url = Bundle.main.url(forResource: name, withExtension: "mp3") ?? Bundle.main.url(forResource: name, withExtension: "wav"),
                  let f = try? AVAudioFile(forReading: url),
                  let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)), (try? f.read(into: b)) != nil else { continue }
            bufs[name] = b
            let k = GameSound.key(b.format)
            if nodes[k] == nil {
                nodes[k] = (0..<GameSound.perFormat).map { _ in
                    let n = AVAudioPlayerNode()
                    engine.attach(n); engine.connect(n, to: engine.mainMixerNode, format: b.format)
                    return n
                }
            }
        }
        engine.prepare()
        try? engine.start()
    }

    private static func key(_ f: AVAudioFormat) -> String { "\(f.sampleRate)/\(f.channelCount)" }

    /// One `sfx` packet's voices: [{ file, gain, rate, offset, dur, rel, fade }].
    func play(_ voices: [[String: Any]]) {
        q.async { [weak self] in
            guard let self = self else { return }
            if !self.engine.isRunning { try? self.engine.start() } // an interruption (a call, Siri) stops the engine
            for v in voices {
                guard let name = v["file"] as? String, let src = self.bufs[name] else { continue }
                let d = { (k: String, def: Double) in (v[k] as? NSNumber)?.doubleValue ?? def }
                let fade = (v["fade"] as? [NSNumber]).flatMap { $0.count == 2 ? [$0[0].doubleValue, $0[1].doubleValue] : nil }
                guard let out = GameSound.render(src, gain: d("gain", 1), rate: d("rate", 1), offset: d("offset", 0), dur: d("dur", 0), rel: d("rel", 0.25), fade: fade) else { continue }
                let k = GameSound.key(src.format)
                guard let pool = self.nodes[k], !pool.isEmpty else { continue }
                let i = (self.next[k] ?? 0) % pool.count
                self.next[k] = i + 1
                let n = pool[i]
                n.stop() // the oldest voice of this format makes way
                n.scheduleBuffer(out, at: nil)
                n.play()
            }
        }
    }

    /// audio.js voice(): from `offset` s, at `rate`, a 1 ms fade-in; after `dur` s an exponential release (time constant rel / 4,
    /// cut at rel × 1.5); `fade` = a linear fade from fade[0] s to silence at fade[1] s (times on the played sound).
    static func render(_ p: AVAudioPCMBuffer, gain: Double, rate: Double, offset: Double, dur: Double, rel: Double, fade: [Double]?) -> AVAudioPCMBuffer? {
        guard let s = p.floatChannelData else { return nil }
        let sr = p.format.sampleRate, frames = Int(p.frameLength), ch = Int(p.format.channelCount)
        let len = (Double(frames) / sr - offset) / rate
        var end = len
        if dur > 0 && dur < len { end = min(end, dur + rel * 1.5) }
        if let f = fade, f[0] < len { end = min(end, f[1]) }
        let n = max(0, Int((end * sr).rounded()))
        guard n > 0, let out = AVAudioPCMBuffer(pcmFormat: p.format, frameCapacity: AVAudioFrameCount(n)), let o = out.floatChannelData else { return nil }
        out.frameLength = AVAudioFrameCount(n)
        for i in 0..<n {
            let t = Double(i) / sr
            var g = gain * min(1, t / 0.001)
            if dur > 0 && dur < len && t > dur { g *= exp(-(t - dur) / (rel / 4)) }
            if let f = fade, f[0] < len, t > f[0] { g *= max(0, 1 - (t - f[0]) / (f[1] - f[0])) }
            let x = (offset + t * rate) * sr, k = Int(x), a = Float(x - Double(k))
            if k + 1 >= frames { for c in 0..<ch { o[c][i] = 0 }; continue }
            for c in 0..<ch { o[c][i] = (s[c][k] * (1 - a) + s[c][k + 1] * a) * Float(g) }
        }
        return out
    }
}
