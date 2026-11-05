import Foundation

/// One upright camera frame. Intrinsics are in pixels of `gray`. `t` is capture time on the PC clock (s).
struct TagFrame {
    let gray: GrayImage
    let t: Double
    let fx: Double
    let fy: Double
    let cx: Double
    let cy: Double
}

/// Black-square size (m) of every tag. The printed paper is 200 mm square with a white margin of a tenth on each side, so the black square is 160 mm.
/// A RuneTag (marker rune, the mahoujin ids 0-6) reports the corners of its virtual 224 mm square instead (Rune.SQUARE).
func tagSizeOf(_ id: Int, rune: Bool = false) -> Double {
    rune && Rune.IDS.contains(id) ? Rune.SQUARE : 0.16
}

/// AprilTag tag36h11 via OpenCV's aruco module (and RuneTags 0-6 via Rune.swift when `rune`), pose by solvePnP.
/// Positions in the OpenCV camera frame (x right, y down, z forward), metres. Output matches Vision.kt packet for packet.
final class TagDetector {
    private let bridge = TagBridge()
    /// One line about the last frame for the status text: picture size and brightness, RuneTags found and how long Rune took, AprilTags and rejected squares.
    private(set) var info = ""

    func detect(_ f: TagFrame, rune: Bool) -> [[String: Any]] {
        let w = Double(f.gray.width), h = Double(f.gray.height)
        var found = [(id: Int, c: [Double])]()
        var runeInfo = "rune off"
        // AprilTags on another core while the RuneTags are read
        var april = [[AnyHashable: Any]]()
        let aprilDone = DispatchGroup()
        DispatchQueue.global(qos: .userInitiated).async(group: aprilDone) { [bridge] in april = bridge.detectAprilTags(f.gray) }
        if rune {
            let t0 = Date()
            let g = [UInt8](f.gray.data)
            let runes = Rune.detect(g, Int(f.gray.width), Int(f.gray.height))
            for m in runes { found.append((m.id, m.corners)) }
            runeInfo = String(format: "rune %d in %.0f ms", runes.count, Date().timeIntervalSince(t0) * 1000)
        }
        aprilDone.wait()
        info = String(format: "img %dx%d mean %.0f  %@  april %d  rejected %d", f.gray.width, f.gray.height, bridge.lastMean, runeInfo, april.count, bridge.lastRejected)
        for t in april {
            guard let id = (t["id"] as? NSNumber)?.intValue, let c = t["c"] as? [NSNumber] else { continue }
            if rune && Rune.IDS.contains(id) { continue }
            found.append((id, c.map { $0.doubleValue }))
        }
        var out = [[String: Any]]()
        for (id, c) in found {
            let size = tagSizeOf(id, rune: rune)
            var tag: [String: Any] = [
                "id": id,
                "sz": size,
                "c": (0..<4).map { j in [r4(c[2 * j] / w), r4(c[2 * j + 1] / h)] },
            ]
            if let pose = TagBridge.solveSquare(c.map { NSNumber(value: $0) }, size: size, fx: f.fx, fy: f.fy, cx: f.cx, cy: f.cy),
               let p = pose["p"] as? [NSNumber], let r = pose["r"] as? [NSNumber] {
                tag["p"] = p.map { r4($0.doubleValue) }
                tag["r"] = r.map { r4($0.doubleValue) }
            }
            out.append(tag)
        }
        return out
    }
}
