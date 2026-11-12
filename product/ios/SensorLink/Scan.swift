import CoreImage
import ImageIO
import Foundation

/// Stick scan, as Scan.kt: pictures of the stick lying on the mahoujin, each with the tags seen in it, to the PC as
/// { type: "scan", step: "start" | "stick" | "done" | "cancel", n, w, h, k, tags, jpg }. The dashboard builds the 3D shape (stickscan.js)
/// and the server answers { type: "stick" } (Link.stick). A picture every 0.5 s while 2+ floor tags show.
/// Each finished scan is also saved on the phone (Documents/scans: scan-<time>-<pictures>.jsonl, a picture packet per line) and can be
/// sent to the PC again later (resend): when the PC was not connected, or to build the model again.
final class Scan {
    static let max = 40
    private static let width: CGFloat = 480

    private let link: Link
    private let ci = CIContext()
    private let lock = NSLock()
    private var on = false, n = 0, last = 0.0
    private var pics: [String] = [] // this scan's picture packets, saved by finish()
    private let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("scans")

    init(link: Link) { self.link = link }

    var count: Int { lock.lock(); defer { lock.unlock() }; return n }

    func start() { lock.lock(); on = true; n = 0; pics = []; lock.unlock(); send("start") }
    /// Ends the scan: the pictures saved on the phone, "done" to the PC.
    func finish() { lock.lock(); on = false; let list = pics; pics = []; lock.unlock(); save(list); send("done") }
    func cancel() { lock.lock(); on = false; pics = []; lock.unlock(); send("cancel") }

    private func send(_ s: String) { link.send(["type": "scan", "step": s, "t": link.pcTime()], big: true) }

    private func save(_ list: [String]) {
        guard !list.isEmpty else { return }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyyMMdd-HHmmss"
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? list.joined(separator: "\n").write(to: dir.appendingPathComponent("scan-\(f.string(from: Date()))-\(list.count).jsonl"), atomically: true, encoding: .utf8)
    }

    /// The saved scans, newest first.
    func saved() -> [URL] {
        let fs = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return fs.filter { $0.pathExtension == "jsonl" }.sorted { $0.lastPathComponent > $1.lastPathComponent }
    }

    /// "2026-11-12 16:54, 40 pictures" from a saved scan's file name (scan-20261112-165400-40.jsonl).
    func label(_ u: URL) -> String {
        let p = u.deletingPathExtension().lastPathComponent.split(separator: "-").map(String.init)
        guard p.count == 4, p[1].count == 8, p[2].count == 6 else { return u.lastPathComponent }
        let d = Array(p[1]), t = Array(p[2])
        return "\(String(d[0..<4]))-\(String(d[4..<6]))-\(String(d[6..<8])) \(String(t[0..<2])):\(String(t[2..<4])), \(p[3]) pictures"
    }

    /// A saved scan to the PC again, as if just taken: start, its pictures, done. False if not sent (scanning now, or unreadable).
    func resend(_ u: URL) -> Bool {
        lock.lock(); let busy = on; lock.unlock()
        guard !busy, let text = try? String(contentsOf: u, encoding: .utf8) else { return false }
        send("start")
        for line in text.split(separator: "\n") {
            if let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] { link.send(o, big: true) }
        }
        send("done")
        return true
    }

    /// Tag worker: a frame's camera picture (landscape sensor buffer) with the tags found in it and its intrinsics k (as in the tags packet).
    func offer(_ pb: CVPixelBuffer, tags: [[String: Any]], k: [Double]) {
        let floor = tags.filter { (($0["id"] as? Int) ?? -1) >= 0 && (($0["id"] as? Int) ?? 99) <= 6 }.count
        let now = wallNow()
        lock.lock()
        guard on, n < Scan.max, floor >= 2, now - last >= 0.5 else { lock.unlock(); return }
        last = now
        let i = n
        n += 1
        lock.unlock()
        let img = CIImage(cvPixelBuffer: pb).oriented(.right) // upright, like the grey picture the tags were read from
        let sc = Scan.width / img.extent.width // keep the aspect: the PC takes square pixels
        let small = img.transformed(by: CGAffineTransform(scaleX: sc, y: sc))
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let jpg = ci.jpegRepresentation(of: small, colorSpace: cs,
                                              options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.85])
        else { return }
        let p: [String: Any] = [
            "type": "scan", "step": "stick", "t": link.pcTime(), "n": i,
            "w": Int(small.extent.width.rounded()), "h": Int(small.extent.height.rounded()), "k": k, "tags": tags,
            "jpg": jpg.base64EncodedString(),
        ]
        if JSONSerialization.isValidJSONObject(p), let d = try? JSONSerialization.data(withJSONObject: p), let s = String(data: d, encoding: .utf8) {
            lock.lock(); if on { pics.append(s) }; lock.unlock()
        }
        link.send(p, big: true)
    }

    func status() -> String? {
        lock.lock(); let (o, c) = (on, n); lock.unlock()
        if o { return "SCAN: \(c) / \(Scan.max) pictures" + (c >= Scan.max ? " (enough: tap Finish)" : " (needs 2+ green tags)") }
        return link.stick.map { "stick model on the PC: \($0)" }
    }
}
