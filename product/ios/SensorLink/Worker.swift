import Foundation

/// Single-thread worker that drops jobs while busy, so every detector always works on the newest frame.
final class Worker {
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var busy = false
    private var n = 0
    private var t0 = Date()
    private var _hz = 0.0

    init(_ name: String) { queue = DispatchQueue(label: name, qos: .userInitiated) }

    var hz: Double { lock.lock(); defer { lock.unlock() }; return _hz }
    var idle: Bool { lock.lock(); defer { lock.unlock() }; return !busy }

    func offer(_ job: @escaping () -> Void) {
        lock.lock()
        if busy { lock.unlock(); return }
        busy = true
        lock.unlock()
        queue.async { [self] in
            job()
            lock.lock()
            busy = false
            n += 1
            if n >= 10 {
                let dt = max(Date().timeIntervalSince(t0), 0.001)
                _hz = Double(n) / dt
                n = 0; t0 = Date()
            }
            lock.unlock()
        }
    }
}

/// Rounds like Vision.kt's r4: four decimals keep the packets small.
func r4(_ x: Double) -> Double { (x * 1e4).rounded() / 1e4 }
func r4(_ x: Float) -> Double { r4(Double(x)) }

/// Phone wall clock in seconds (the Kotlin side's System.currentTimeMillis() / 1000).
func wallNow() -> Double { Date().timeIntervalSince1970 }
