import CoreBluetooth
import Foundation

/// One IMU sample. Angles in degrees (WitMotion roll X, pitch Y, yaw Z), acc in m/s², gyro in deg/s.
struct ImuSample {
    let wall: Double
    let euler: [Float]
    let acc: [Float]
    let gyro: [Float]
    let q: [Double] // [w, x, y, z]
}

/// WitMotion WT9011DCL (BLE 5.0) over GATT. Auto-reconnects to the last device until `disconnect()`.
/// Everything runs on the main queue (CBCentralManager's default), so no locking is needed.
final class Imu: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let service = CBUUID(string: "FFE5")
    static let notifyChar = CBUUID(string: "FFE4")
    static let writeChar = CBUUID(string: "FFE9")

    private let onSample: (ImuSample) -> Void
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var known = [UUID: CBPeripheral]() // everything the scan saw: CoreBluetooth drops peripherals nobody holds
    private var address: UUID?
    private var onFound: ((UUID, String) -> Void)?
    private var scanning = false

    private(set) var status = "no IMU"
    private(set) var last: ImuSample?
    private(set) var hz = 0.0
    private var tare: [Double] = [1, 0, 0, 0]
    private var count = 0
    private var countStart = wallNow()

    init(onSample: @escaping (ImuSample) -> Void) {
        self.onSample = onSample
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    func scan(onFound: @escaping (UUID, String) -> Void) {
        stopScan()
        self.onFound = onFound
        scanning = true
        startScanIfPossible()
    }

    func stopScan() {
        scanning = false
        onFound = nil
        if central.state == .poweredOn { central.stopScan() }
    }

    private func startScanIfPossible() {
        if scanning, central.state == .poweredOn {
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        }
    }

    func connect(_ id: UUID) {
        disconnect()
        address = id
        status = "connecting \(id.uuidString.prefix(8))"
        tryConnect()
    }

    func disconnect() {
        address = nil
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        peripheral = nil
        status = "no IMU"
        last = nil
    }

    /// Current orientation becomes the identity of `ImuSample.q`.
    func calibrate() {
        if let l = last { tare = Imu.conj(Imu.eulerToQ(l.euler)) }
    }

    private func tryConnect() {
        guard let a = address, peripheral == nil, central.state == .poweredOn else { return }
        if let p = known[a] ?? central.retrievePeripherals(withIdentifiers: [a]).first {
            known[a] = p
            peripheral = p
            p.delegate = self
            central.connect(p, options: nil)
        } else {
            // a saved device that iOS no longer knows: scan until it shows up again
            status = "searching for the IMU"
            central.scanForPeripherals(withServices: nil, options: nil)
        }
    }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            startScanIfPossible()
            tryConnect()
        case .unauthorized: status = "Bluetooth not allowed (Settings)"
        case .poweredOff: status = "Bluetooth is off"
        default: break
        }
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        known[p.identifier] = p
        if let a = address, a == p.identifier, peripheral == nil {
            if !scanning { c.stopScan() }
            tryConnect()
        }
        guard scanning, let cb = onFound else { return }
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? p.name
        if let name = name { cb(p.identifier, name) }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        status = "discovering"
        p.discoverServices([Imu.service])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { lost(p) }
    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) { lost(p) }

    private func lost(_ p: CBPeripheral) {
        guard peripheral === p else { return }
        peripheral = nil
        last = nil
        guard let a = address else { return }
        status = "lost, reconnecting"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self, self.address == a, self.peripheral == nil else { return }
            self.tryConnect()
        }
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = p.services?.first(where: { $0.uuid == Imu.service }) else {
            status = "not a WitMotion BLE device"
            return
        }
        p.discoverCharacteristics([Imu.notifyChar, Imu.writeChar], for: svc)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor svc: CBService, error: Error?) {
        guard let notify = svc.characteristics?.first(where: { $0.uuid == Imu.notifyChar }),
              let wr = svc.characteristics?.first(where: { $0.uuid == Imu.writeChar }) else {
            status = "not a WitMotion BLE device"
            return
        }
        p.setNotifyValue(true, for: notify)
        let type: CBCharacteristicWriteType = wr.properties.contains(.write) ? .withResponse : .withoutResponse
        // unlock, then output rate 0x09 = 100 Hz (the sensor wants a pause between the two)
        p.writeValue(Data([0xFF, 0xAA, 0x69, 0x88, 0xB5]), for: wr, type: type)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self, weak p] in
            guard let self = self, let p = p, self.peripheral === p else { return }
            p.writeValue(Data([0xFF, 0xAA, 0x03, 0x09, 0x00]), for: wr, type: type)
        }
        let label = p.name ?? String(p.identifier.uuidString.prefix(8))
        status = "connected \(label)"
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard c.uuid == Imu.notifyChar, let d = c.value else { return }
        parse([UInt8](d))
    }

    private func parse(_ v: [UInt8]) {
        let now = wallNow()
        var i = 0
        while i + 20 <= v.count {
            if v[i] == 0x55 && v[i + 1] == 0x61 {
                let base = i
                func s(_ j: Int) -> Float {
                    let raw = UInt16(v[base + 2 + 2 * j]) | (UInt16(v[base + 3 + 2 * j]) << 8)
                    return Float(Int16(bitPattern: raw)) / 32768
                }
                let e: [Float] = [s(6) * 180, s(7) * 180, s(8) * 180]
                let sample = ImuSample(
                    wall: now, euler: e,
                    acc: [s(0) * 16 * 9.81, s(1) * 16 * 9.81, s(2) * 16 * 9.81],
                    gyro: [s(3) * 2000, s(4) * 2000, s(5) * 2000],
                    q: Imu.mul(tare, Imu.eulerToQ(e)))
                last = sample
                count += 1
                if count == 50 {
                    hz = Double(count) / max(now - countStart, 0.001)
                    count = 0
                    countStart = now
                }
                onSample(sample)
            }
            i += 20
        }
    }

    // MARK: quaternions

    /// WitMotion angles are Z-Y-X (yaw, pitch, roll). Returns [w, x, y, z].
    static func eulerToQ(_ e: [Float]) -> [Double] {
        let r = Double(e[0]) * .pi / 180 / 2
        let p = Double(e[1]) * .pi / 180 / 2
        let y = Double(e[2]) * .pi / 180 / 2
        let cr = cos(r), sr = sin(r), cp = cos(p), sp = sin(p), cy = cos(y), sy = sin(y)
        return [
            cr * cp * cy + sr * sp * sy,
            sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
        ]
    }

    static func conj(_ q: [Double]) -> [Double] { [q[0], -q[1], -q[2], -q[3]] }

    static func mul(_ a: [Double], _ b: [Double]) -> [Double] {
        [
            a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
            a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
            a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
            a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
        ]
    }
}
