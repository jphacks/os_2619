import CoreImage
import ImageIO
import Foundation

/// Stick scan, as Scan.kt: pictures of the stick lying on the mahoujin, each with the tags seen in it, to the PC as
/// { type: "scan", step: "start" | "stick" | "done" | "cancel", n, w, h, k, tags, jpg }. The dashboard builds the 3D shape (stickscan.js)
/// and the server answers { type: "stick" } (Link.stick). A picture every 0.5 s while 2+ floor tags show.
final class Scan {
    static let max = 40
    private static let width: CGFloat = 480

    private let link: Link
    private let ci = CIContext()
    private let lock = NSLock()
    private var on = false, n = 0, last = 0.0

    init(link: Link) { self.link = link }

    var count: Int { lock.lock(); defer { lock.unlock() }; return n }

    func start() { lock.lock(); on = true; n = 0; lock.unlock(); send("start") }
    func finish() { lock.lock(); on = false; lock.unlock(); send("done") }
    func cancel() { lock.lock(); on = false; lock.unlock(); send("cancel") }

    private func send(_ s: String) { link.send(["type": "scan", "step": s, "t": link.pcTime()], big: true) }

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
        link.send([
            "type": "scan", "step": "stick", "t": link.pcTime(), "n": i,
            "w": Int(small.extent.width.rounded()), "h": Int(small.extent.height.rounded()), "k": k, "tags": tags,
            "jpg": jpg.base64EncodedString(),
        ], big: true)
    }

    func status() -> String? {
        lock.lock(); let (o, c) = (on, n); lock.unlock()
        if o { return "SCAN: \(c) / \(Scan.max) pictures" + (c >= Scan.max ? " (enough: tap Finish)" : " (needs 2+ green tags)") }
        return link.stick.map { "stick model on the PC: \($0)" }
    }
}
