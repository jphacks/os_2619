import AVFoundation

/// The sound of taking a hit, played together with the torch (`flash` packets): damage.mp3, the same file as
/// dashboard/public/audio/damage.mp3 and Android's res/raw/damage.mp3. Loaded once, so a hit plays with no delay. Any thread.
final class HitSound {
    private let player: AVAudioPlayer?
    private let q = DispatchQueue(label: "hitsound")

    init() {
        // playback: still heard with the silent switch on (the phone is on the chest in a match); mixes with anything else
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        player = Bundle.main.url(forResource: "damage", withExtension: "mp3").flatMap { try? AVAudioPlayer(contentsOf: $0) }
        player?.prepareToPlay()
    }

    func play() {
        q.async { [player] in
            guard let p = player else { return }
            p.currentTime = 0 // another hit restarts it
            p.play()
        }
    }
}
