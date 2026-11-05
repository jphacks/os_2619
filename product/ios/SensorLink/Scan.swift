import CoreImage
import ImageIO
import Foundation

/// Stick scan, as Scan.kt: pictures of the empty floor sheets (step bg), then of the stick lying on them (stick), each with the tags
/// seen in it, to the PC as { type: "scan", step: "start" | "bg" | "stick" | "done" | "cancel", n, w, h, k, tags, jpg }. The dashboard
/// builds the 3D model (stickscan.js) and the server answers { type: "stick" } (Link.stick). A picture every 0.5 s while 2+ floor tags show.
final class Scan {
    enum Step { case off, bg, stick }
    static let maxBg = 12, maxStick = 40
    private static let width: CGFloat = 480

    private let link: Link
    private let ci = CIContext()
    private let lock = NSLock()
    private var _step = Step.off
    private var nBg = 0, nStick = 0, last = 0.0

    init(link: Link) { self.link = link }

    var step: Step { lock.lock(); defer { lock.unlock() }; return _step }
    var counts: (bg: Int, stick: Int) { lock.lock(); defer { lock.unlock() }; return (nBg, nStick) }

    func start() { lock.lock(); _step = .bg; nBg = 0; nStick = 0; lock.unlock(); send("start") }
    func next() { lock.lock(); _step = .stick; lock.unlock() }
    func finish() { lock.lock(); _step = .off; lock.unlock(); send("done") }
    func cancel() { lock.lock(); _step = .off; lock.unlock(); send("cancel") }

    private func send(_ s: String) { link.send(["type": "scan", "step": s, "t": link.pcTime()], big: true) }

    /// Tag worker: a frame's camera picture (landscape sensor buffer) with the tags found in it and its intrinsics k (as in the tags packet).
    func offer(_ pb: CVPixelBuffer, tags: [[String: Any]], k: [Double]) {
        let floor = tags.filter { (($0["id"] as? Int) ?? -1) >= 0 && (($0["id"] as? Int) ?? 99) <= 6 }.count
        let now = wallNow()
        lock.lock()
        let s = _step
        let full = s == .bg ? nBg >= Scan.maxBg : nStick >= Scan.maxStick
        guard s != .off, !full, floor >= 2, now - last >= 0.5 else { lock.unlock(); return }
        last = now
        let n: Int
        if s == .bg { n = nBg; nBg += 1 } else { n = nStick; nStick += 1 }
        lock.unlock()
        let img = CIImage(cvPixelBuffer: pb).oriented(.right) // upright, like the grey picture the tags were read from
        let sc = Scan.width / img.extent.width // keep the aspect: the PC takes square pixels
        let small = img.transformed(by: CGAffineTransform(scaleX: sc, y: sc))
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let jpg = ci.jpegRepresentation(of: small, colorSpace: cs,
                                              options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.8])
        else { return }
        link.send([
            "type": "scan", "step": s == .bg ? "bg" : "stick", "t": link.pcTime(), "n": n,
            "w": Int(small.extent.width.rounded()), "h": Int(small.extent.height.rounded()), "k": k, "tags": tags,
            "jpg": jpg.base64EncodedString(),
        ], big: true)
    }

    func status() -> String? {
        let (b, st) = counts
        switch step {
        case .off: return link.stick.map { "stick model on the PC: \($0)" }
        case .bg: return "SCAN 1/2 empty circle: \(b) / \(Scan.maxBg) pictures" + (b >= Scan.maxBg ? " (enough: tap Stick placed)" : " (needs 2+ green tags)")
        case .stick: return "SCAN 2/2 stick: \(st) / \(Scan.maxStick) pictures" + (st >= Scan.maxStick ? " (enough: tap Finish)" : " (needs 2+ green tags)")
        }
    }
}
