import ARKit
import CoreImage
import SwiftUI
import UIKit

/// A detected tag as the overlay draws it: corners in 0...1 of the upright picture.
struct TagMark: Identifiable {
    let id: Int
    let corners: [[Double]]
    let distance: Double?
}

struct ImuDevice: Identifiable {
    let id: UUID
    let name: String
}

/// Everything MainActivity.kt does: ARKit pose + camera frames in, IMU in, JSON packets out to the PC.
final class Model: NSObject, ObservableObject, ARSessionDelegate {
    // UI state (main thread only)
    @Published var lines: [String] = []
    @Published var preview: UIImage?
    @Published var marks: [TagMark] = []
    @Published var toast: String?
    @Published var found: [ImuDevice] = []

    let link: Link
    private(set) var imu: Imu!
    let session = ARSession()

    private let prefs = UserDefaults.standard
    private let convertW = Worker("convert")
    private let tagW = Worker("tags")
    private let detector = TagDetector()
    private let ciContext = CIContext()
    private let arQueue = DispatchQueue(label: "ar", qos: .userInitiated)

    // written on the AR / worker queues, read on main for the status text
    private let lock = NSLock()
    private var camPose: simd_float4x4?
    private var arOrigin: simd_float4x4?
    private var arText = "AR: starting"
    private var arError: String?
    private var lastTags = [Int]()
    private var lastImgTs = 0.0
    private var lastPreview = 0.0

    private static let imageFps = 30.0 // tag detection rate (camera max); the AR pose is sent every frame

    var host: String { prefs.string(forKey: "host") ?? "192.168.0.10" }
    var port: Int { prefs.object(forKey: "port") == nil ? 8000 : prefs.integer(forKey: "port") }

    override init() {
        let id: String
        if let saved = UserDefaults.standard.string(forKey: "id") { id = saved } else {
            id = UUID().uuidString
            UserDefaults.standard.set(id, forKey: "id")
        }
        link = Link(id: id, name: UIDevice.current.name)
        super.init()
        imu = Imu { [weak self] s in
            guard let self = self else { return }
            self.link.send([
                "type": "imu", "t": self.link.pcTime(s.wall),
                "euler": s.euler.map { r4($0) }, "acc": s.acc.map { r4($0) }, "gyro": s.gyro.map { r4($0) },
                "q": s.q.map { r4($0) },
            ])
        }
        session.delegate = self
        session.delegateQueue = arQueue
    }

    func start() {
        UIApplication.shared.isIdleTimerDisabled = true
        link.connect(host: host, port: port)
        if let s = prefs.string(forKey: "imu"), let u = UUID(uuidString: s) { imu.connect(u) }
        let cfg = ARWorldTrackingConfiguration()
        cfg.planeDetection = [.horizontal, .vertical]
        cfg.isAutoFocusEnabled = true
        session.run(cfg)
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    // MARK: ARSessionDelegate (AR queue)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let cam = frame.camera
        let ageS = ProcessInfo.processInfo.systemUptime - frame.timestamp
        let now = wallNow()
        let t = link.pcTime((0.0...0.5).contains(ageS) ? now - ageS : now)

        var tracking = "STOPPED", reason = "NONE"
        switch cam.trackingState {
        case .normal:
            tracking = "TRACKING"
        case .limited(let r):
            tracking = "PAUSED"
            switch r {
            case .excessiveMotion: reason = "EXCESSIVE_MOTION"
            case .insufficientFeatures: reason = "INSUFFICIENT_FEATURES"
            case .initializing: reason = "INITIALIZING"
            case .relocalizing: reason = "RELOCALIZING"
            @unknown default: reason = "BAD_STATE"
            }
        case .notAvailable:
            break
        }

        // ARKit's camera transform is the same frame as ARCore's Camera.getPose(): the sensor's landscape axes (x right, y up,
        // -z forward) in a gravity-aligned world (y up), so it goes out as wp/wq unchanged.
        let world = cam.transform
        lock.lock()
        if tracking == "TRACKING" { camPose = world }
        let origin = arOrigin
        lock.unlock()
        let rel = origin.map { simd_mul(simd_inverse($0), world) } ?? world
        let planes = frame.anchors.filter { $0 is ARPlaneAnchor }.count
        let (p, q) = Model.pose(rel)
        let (wp, wq) = Model.pose(world)
        link.send([
            "type": "ar", "t": t, "tracking": tracking, "reason": reason,
            "p": p, "q": q, "planes": planes, "wp": wp, "wq": wq,
        ])
        let text = "AR: \(tracking)\(reason != "NONE" ? " (\(reason))" : "")  planes \(planes)  " +
            String(format: "pos %.2f %.2f %.2f", p[0], p[1], p[2])
        lock.lock(); arText = text; arError = nil; lock.unlock()

        if !convertW.idle { return }
        if frame.timestamp - lastImgTs < 1.0 / Model.imageFps { return }
        lastImgTs = frame.timestamp
        let pb = frame.capturedImage
        let k = cam.intrinsics
        let res = cam.imageResolution
        // columns of the intrinsics matrix: (fx,0,0), (0,fy,0), (cx,cy,1)
        let fx = Double(k[0][0]), fy = Double(k[1][1]), cx = Double(k[2][0]), cy = Double(k[2][1])
        let h = Double(res.height)
        convertW.offer { [weak self] in
            guard let self = self, let gray = TagBridge.uprightGray(pb) else { return }
            // the picture is rotated 90° clockwise: (x, y) -> (h-1-y, x) swaps the focal lengths and moves the principal point
            let fr = TagFrame(gray: gray, t: t, fx: fy, fy: fx, cx: h - 1 - cy, cy: cx)
            self.showPreview(pb)
            self.tagW.offer { [weak self] in
                guard let self = self else { return }
                let r = self.detector.detect(fr, rune: self.link.marker == "rune")
                let w = Double(gray.width), hh = Double(gray.height)
                self.link.send([
                    "type": "tags", "t": fr.t, "tags": r,
                    "k": [r4(fr.fx / w), r4(fr.fy / hh), r4(fr.cx / w), r4(fr.cy / hh)],
                ])
                let marks: [TagMark] = r.compactMap { tag in
                    guard let id = tag["id"] as? Int, let c = tag["c"] as? [[Double]] else { return nil }
                    return TagMark(id: id, corners: c, distance: (tag["p"] as? [Double])?[2])
                }
                self.lock.lock(); self.lastTags = marks.map { $0.id }; self.lock.unlock()
                DispatchQueue.main.async { self.marks = marks }
            }
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        lock.lock(); arError = "AR failed: \(error.localizedDescription)"; lock.unlock()
    }

    private func showPreview(_ pb: CVPixelBuffer) {
        let now = wallNow()
        if now - lastPreview < 0.1 { return }
        lastPreview = now
        let img = CIImage(cvPixelBuffer: pb).oriented(.right) // landscape sensor -> upright, like the grey picture
        guard let cg = ciContext.createCGImage(img, from: img.extent) else { return }
        let ui = UIImage(cgImage: cg)
        DispatchQueue.main.async { self.preview = ui }
    }

    private static func pose(_ m: simd_float4x4) -> ([Double], [Double]) {
        let t = m.columns.3
        let q = simd_quatf(m)
        return ([r4(t.x), r4(t.y), r4(t.z)], [r4(q.imag.x), r4(q.imag.y), r4(q.imag.z), r4(q.real)])
    }

    // MARK: UI actions (main thread)

    func calibrate() {
        imu.calibrate()
        lock.lock()
        arOrigin = camPose
        let tracked = camPose != nil
        lock.unlock()
        link.send(["type": "calib", "t": link.pcTime()])
        showToast(tracked ? "IMU zeroed, AR origin set here" : "IMU zeroed (AR not tracking yet)")
    }

    func connectLan(host: String, port: Int) {
        prefs.set(host, forKey: "host")
        prefs.set(port, forKey: "port")
        link.connect(host: host, port: port)
    }

    func disconnectLan() { link.close() }

    func scanImu() {
        found = []
        imu.scan { [weak self] id, name in
            guard let self = self, !self.found.contains(where: { $0.id == id }) else { return }
            // WitMotion sensors first
            if name.hasPrefix("WT") { self.found.insert(ImuDevice(id: id, name: name), at: 0) } else { self.found.append(ImuDevice(id: id, name: name)) }
        }
    }

    func stopScan() { imu.stopScan() }

    func pickImu(_ id: UUID) {
        imu.connect(id)
        prefs.set(id.uuidString, forKey: "imu")
    }

    func forgetImu() {
        imu.disconnect()
        prefs.removeObject(forKey: "imu")
    }

    private func showToast(_ s: String) {
        toast = s
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            if self?.toast == s { self?.toast = nil }
        }
    }

    private func refresh() {
        lock.lock()
        let ar = arError ?? arText
        let tags = lastTags
        lock.unlock()
        var imuLine = "IMU: \(imu.status)"
        if let l = imu.last { imuLine += String(format: "  %.0f Hz  r %.0f p %.0f y %.0f", imu.hz, l.euler[0], l.euler[1], l.euler[2]) }
        lines = [
            String(format: "LAN: %@  slot %@  rtt %.0f ms  floor tags: %@", link.status, link.slot, link.rttMs, link.marker == "rune" ? "RuneTag" : "AprilTag"),
            imuLine,
            ar,
            String(format: "Hz  cam %.0f  tag %.0f", convertW.hz, tagW.hz),
            "tags: " + tags.map(String.init).joined(separator: ", "),
        ]
    }
}
