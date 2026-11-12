import Foundation

/**
 * One WebSocket to the PC for small, low-latency JSON packets (same protocol as Link.kt).
 * Reconnects every second while enabled. Stale packets are dropped instead of queued: on a slow link every byte that
 * waits in a buffer is latency.
 */
final class Link: NSObject, URLSessionWebSocketDelegate, URLSessionTaskDelegate {
    private let id: String
    private let name: String
    private let lock = NSLock()
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var gen = 0
    private var url = ""
    private var bestRtt = Double.greatestFiniteMagnitude
    private var pending = 0 // bytes handed to the socket and not yet reported as sent

    private var _status = "not connected"
    private var _slot = "-"
    private var _offset = 0.0
    private var _rttMs = 0.0
    private var _marker = "april"
    private var _phase = "setup"
    private var _stick: String?

    private static let queueLimit = 4 * 1024

    var status: String { lock.lock(); defer { lock.unlock() }; return _status }
    var slot: String { lock.lock(); defer { lock.unlock() }; return _slot }
    /// PC clock minus phone clock, in seconds (lowest-RTT ping wins).
    var offset: Double { lock.lock(); defer { lock.unlock() }; return _offset }
    var rttMs: Double { lock.lock(); defer { lock.unlock() }; return _rttMs }
    /// The floor sheets' marker the PC chose: "april" or "rune". Older servers say nothing: april.
    var marker: String { lock.lock(); defer { lock.unlock() }; return _marker }
    /// the dashboard's game phase (setup / countdown / fight / result), sent by the server
    var phase: String { lock.lock(); defer { lock.unlock() }; return _phase }
    /// The PC says this phone's player was hit: light the torch for this many ms. Set before connect; called on the socket's queue.
    var onFlash: ((Int) -> Void)?
    /// The PC's vibration word: charge, win or off (Vibe.swift). Set before connect; called on the socket's queue.
    var onVibrate: ((String) -> Void)?
    /// A `vibrate` charge packet also says what the PC's charge sound is doing: element, tier (s / m / l), level 0...1.
    var onCharge: ((String, String, Double) -> Void)?
    /// A game sound for this player (`sfx`, dashboard app.js phoneSound): its voices (GameSound.play). The socket's queue.
    var onSound: (([[String: Any]]) -> Void)?
    /// The charge broke off (`sfx` kind chargeFail): ChargeSound.fail. The socket's queue.
    var onChargeFail: (() -> Void)?
    /// The PC's word on this slot's scanned stick (dashboard stickscan.js): "91 cm", "none", or nil before it said anything.
    var stick: String? { lock.lock(); defer { lock.unlock() }; return _stick }

    init(id: String, name: String) {
        self.id = id
        self.name = name
        super.init()
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: q)
    }

    /// Phone wall time converted to the PC clock, seconds.
    func pcTime(_ wall: Double = wallNow()) -> Double { wall + offset }

    func connect(host: String, port: Int) {
        close()
        lock.lock()
        url = "ws://\(host):\(port)/ws"
        bestRtt = Double.greatestFiniteMagnitude
        gen += 1
        let g = gen
        lock.unlock()
        open(g)
    }

    func close() {
        lock.lock()
        gen += 1
        let t = task
        task = nil
        _status = "not connected"; _slot = "-"
        lock.unlock()
        t?.cancel(with: .normalClosure, reason: nil)
    }

    private func open(_ g: Int) {
        lock.lock()
        guard g == gen, let u = URL(string: url) else {
            if g == gen { _status = "bad address" }
            lock.unlock(); return
        }
        _status = "connecting to \(url)"
        pending = 0
        let t = session.webSocketTask(with: u)
        t.taskDescription = String(g)
        task = t
        lock.unlock()
        t.resume()
        receive(t, g)
        pingLoop(g)
    }

    private func isCurrent(_ g: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return g == gen }

    private func receive(_ t: URLSessionWebSocketTask, _ g: Int) {
        t.receive { [weak self] result in
            guard let self = self, self.isCurrent(g) else { return }
            switch result {
            case .failure(let e):
                self.retry(g, "error: \(e.localizedDescription)")
            case .success(let msg):
                if case .string(let s) = msg { self.handle(s) }
                self.receive(t, g)
            }
        }
    }

    private func pingLoop(_ g: Int) {
        lock.lock()
        guard g == gen, let t = task else { lock.unlock(); return }
        lock.unlock()
        t.send(.string("{\"type\":\"ping\",\"t0\":\(wallNow())}")) { _ in }
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in self?.pingLoop(g) }
    }

    private func handle(_ text: String) {
        guard let d = text.data(using: .utf8),
              let k = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        switch k["type"] as? String {
        case "pong":
            let t1 = wallNow()
            guard let t0 = (k["t0"] as? NSNumber)?.doubleValue, let ts = (k["ts"] as? NSNumber)?.doubleValue else { return }
            let rtt = t1 - t0
            lock.lock()
            // lowest RTT gives the tightest offset; slowly forget it so drift is tracked
            bestRtt *= 1.01
            if rtt <= bestRtt { bestRtt = rtt; _offset = ts - (t0 + t1) / 2 }
            _rttMs = rtt * 1000
            lock.unlock()
        case "welcome":
            lock.lock()
            if let s = k["slot"] as? String { _slot = s } else if let n = k["slot"] as? NSNumber { _slot = n.stringValue } else { _slot = "-" }
            _marker = (k["marker"] as? String) ?? "april"
            _status = "connected"
            lock.unlock()
        case "marker":
            if let m = k["marker"] as? String { lock.lock(); _marker = m; lock.unlock() }
        case "match":
            if let p = k["phase"] as? String { lock.lock(); _phase = p; lock.unlock() }
        case "flash":
            if let ms = (k["ms"] as? NSNumber)?.intValue { onFlash?(ms) }
        case "sfx":
            if (k["kind"] as? String) == "chargeFail" { onChargeFail?() } else if let v = k["voices"] as? [[String: Any]] { onSound?(v) }
        case "vibrate":
            if let kind = k["kind"] as? String {
                onVibrate?(kind)
                if kind == "charge" { onCharge?((k["element"] as? String) ?? "", (k["tier"] as? String) ?? "s", (k["level"] as? NSNumber)?.doubleValue ?? 0) }
            }
        case "stick":
            let len = ((k["model"] as? [String: Any])?["length"] as? NSNumber)?.doubleValue
            lock.lock(); _stick = len.map { String(format: "%.0f cm", $0 * 100) } ?? "none"; lock.unlock()
        case "full":
            lock.lock(); _status = "PC already has 2 phones"; lock.unlock()
        default:
            break
        }
    }

    private func retry(_ g: Int, _ why: String) {
        lock.lock()
        guard g == gen else { lock.unlock(); return }
        gen += 1
        let next = gen
        let t = task
        task = nil
        _status = "\(why), retrying"; _slot = "-"
        lock.unlock()
        t?.cancel()
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self = self, self.isCurrent(next) else { return }
            self.open(next)
        }
    }

    /// Sensor packet. Dropped instead of queued if the link is backed up: stale data is useless.
    /// `big`: a packet that must arrive however late (a stick scan picture), queued up to 8 MB; sensor packets are dropped meanwhile.
    func send(_ json: [String: Any], big: Bool = false) {
        lock.lock()
        guard let t = task, pending < (big ? 8_000_000 : Link.queueLimit) else { lock.unlock(); return }
        lock.unlock()
        guard JSONSerialization.isValidJSONObject(json), // NaN would otherwise raise an Objective-C exception
              let d = try? JSONSerialization.data(withJSONObject: json),
              let s = String(data: d, encoding: .utf8) else { return }
        let n = d.count
        lock.lock(); pending += n; lock.unlock()
        t.send(.string(s)) { [weak self] _ in
            guard let self = self else { return }
            self.lock.lock(); self.pending = max(0, self.pending - n); self.lock.unlock()
        }
    }

    // MARK: URLSession delegate

    private func generation(of task: URLSessionTask) -> Int { Int(task.taskDescription ?? "") ?? -1 }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        let g = generation(of: webSocketTask)
        guard isCurrent(g) else { return }
        let hello: [String: Any] = ["type": "hello", "role": "phone", "id": id, "name": name]
        if let d = try? JSONSerialization.data(withJSONObject: hello), let s = String(data: d, encoding: .utf8) {
            webSocketTask.send(.string(s)) { _ in }
        }
        lock.lock()
        _status = "open, waiting for the PC" // "connected" only once the PC answers
        lock.unlock()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        retry(generation(of: webSocketTask), "closed")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        retry(generation(of: task), error.map { "error: \($0.localizedDescription)" } ?? "closed")
    }
}
