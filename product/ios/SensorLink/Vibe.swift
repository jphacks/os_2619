import CoreHaptics
import Foundation

/**
 * The phone's vibration on the PC's word (`vibrate` packets, game.js):
 * charge = keep vibrating (the PC repeats it; with no repeat for `lease` s it stops by itself, so a lost PC or link cannot leave it on),
 * win = on / off 5 times, off = stop. Same timings as Vibe.kt.
 * hit() (a `flash` packet: this player took a hit) = one short, light buzz; a charge vibration resumes with the next charge packet.
 */
final class Vibe {
    private static let lease = 1.0
    private static let longest = 25.0 // Core Haptics limits one continuous event to 30 s: start a new one before that
    private static let pulseOn = 0.4, pulseOff = 0.3, pulses = 5
    private static let hitS = 0.08, hitIntensity: Float = 0.55 // light

    private let q = DispatchQueue(label: "vibe")
    private var engine: CHHapticEngine?
    private var player: CHHapticPatternPlayer?
    private var chargeFrom: Double? // when the running charge vibration started
    private var leaseEnd = 0.0

    func handle(_ kind: String) {
        q.async { [weak self] in
            guard let self = self else { return }
            switch kind {
            case "charge": self.charge()
            case "win": self.win()
            case "off": self.stop()
            default: break
            }
        }
    }

    private static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    private static func event(at t: Double, for d: Double) -> CHHapticEvent {
        CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
        ], relativeTime: t, duration: d)
    }

    private func charge() {
        let t = Vibe.now()
        leaseEnd = t + Vibe.lease
        let first = chargeFrom == nil
        if first || t - chargeFrom! > Vibe.longest {
            chargeFrom = t
            play([Vibe.event(at: 0, for: 30)])
        }
        if first { watchLease() }
    }

    private func watchLease() {
        q.asyncAfter(deadline: .now() + max(0.05, leaseEnd - Vibe.now())) { [weak self] in
            guard let self = self, self.chargeFrom != nil else { return }
            if Vibe.now() >= self.leaseEnd { self.stop() } else { self.watchLease() }
        }
    }

    func hit() {
        q.async { [weak self] in
            guard let self = self else { return }
            self.chargeFrom = nil // the next charge packet (every 0.25 s) starts the charge vibration again
            self.play([CHHapticEvent(eventType: .hapticContinuous, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: Vibe.hitIntensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
            ], relativeTime: 0, duration: Vibe.hitS)])
        }
    }

    private func win() {
        chargeFrom = nil
        play((0..<Vibe.pulses).map { Vibe.event(at: Double($0) * (Vibe.pulseOn + Vibe.pulseOff), for: Vibe.pulseOn) })
    }

    private func stop() {
        chargeFrom = nil
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
    }

    private func play(_ events: [CHHapticEvent]) {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        do {
            if engine == nil {
                let e = try CHHapticEngine()
                e.playsHapticsOnly = true
                // the system stopped or reset the engine (app in the background, ...): the next packet makes a new one
                let lost = { [weak self] in
                    self?.q.async { self?.engine = nil; self?.player = nil; self?.chargeFrom = nil }
                }
                e.stoppedHandler = { _ in lost() }
                e.resetHandler = { lost() }
                engine = e
            }
            try engine?.start()
            try? player?.stop(atTime: CHHapticTimeImmediate)
            player = try engine?.makePlayer(with: CHHapticPattern(events: events, parameters: []))
            try player?.start(atTime: CHHapticTimeImmediate)
        } catch {
            engine = nil; player = nil
        }
    }
}
