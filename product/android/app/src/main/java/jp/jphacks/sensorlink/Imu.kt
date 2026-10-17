package jp.jphacks.sensorlink

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.UUID
import kotlin.math.cos
import kotlin.math.sin

/** One IMU sample. Angles in degrees (WitMotion roll X, pitch Y, yaw Z), acc in m/s², gyro in deg/s. */
class ImuSample(val wallMs: Long, val euler: FloatArray, val acc: FloatArray, val gyro: FloatArray, val q: DoubleArray)

/** WitMotion WT9011DCL (BLE 5.0) over GATT. Auto-reconnects to the last device until [disconnect]. */
@SuppressLint("MissingPermission") // permissions are requested in MainActivity before any call
class Imu(ctx: Context, private val onSample: (ImuSample) -> Unit) {
    private val app = ctx.applicationContext
    private val adapter = (app.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private val main = Handler(Looper.getMainLooper())
    private var gatt: BluetoothGatt? = null
    private var address: String? = null
    private var scanCb: ScanCallback? = null
    private val ops = ArrayDeque<(BluetoothGatt) -> Unit>() // GATT allows one operation in flight

    @Volatile var status = "no IMU"; private set
    @Volatile var last: ImuSample? = null; private set
    @Volatile var hz = 0.0; private set
    private var tare = doubleArrayOf(1.0, 0.0, 0.0, 0.0)
    private var count = 0
    private var countStart = System.currentTimeMillis()

    fun scan(onFound: (BluetoothDevice, String) -> Unit) {
        stopScan()
        val cb = object : ScanCallback() {
            override fun onScanResult(type: Int, r: ScanResult) {
                val n = r.scanRecord?.deviceName ?: r.device.name ?: return
                main.post { onFound(r.device, n) }
            }
        }
        scanCb = cb
        adapter.bluetoothLeScanner?.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
    }

    fun stopScan() {
        scanCb?.let { adapter.bluetoothLeScanner?.stopScan(it) }
        scanCb = null
    }

    fun connect(addr: String) {
        disconnect()
        address = addr
        status = "connecting $addr"
        gatt = adapter.getRemoteDevice(addr).connectGatt(app, false, cb, BluetoothDevice.TRANSPORT_LE)
    }

    fun disconnect() {
        address = null
        gatt?.close(); gatt = null
        ops.clear()
        status = "no IMU"; last = null
    }

    /** Current orientation becomes the identity of [ImuSample.q]. */
    fun calibrate() { last?.let { tare = conj(eulerToQ(it.euler)) } }

    private fun queue(op: (BluetoothGatt) -> Unit) { main.post { ops.addLast(op); if (ops.size == 1) gatt?.let(op) } }
    private fun next() { main.post { ops.removeFirstOrNull(); gatt?.let { g -> ops.firstOrNull()?.invoke(g) } } }

    private fun write(g: BluetoothGatt, c: BluetoothGattCharacteristic, v: ByteArray) {
        if (Build.VERSION.SDK_INT >= 33) g.writeCharacteristic(c, v, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
        else @Suppress("DEPRECATION") { c.value = v; g.writeCharacteristic(c) }
    }

    private val cb = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, st: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                status = "discovering"
                g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH) // ~7.5 ms interval, lowest latency
                g.discoverServices()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                g.close()
                main.post {
                    if (gatt !== g) return@post
                    gatt = null; ops.clear(); last = null
                    val a = address ?: return@post
                    status = "lost, reconnecting"
                    main.postDelayed({ if (address == a && gatt == null) connect(a) }, 1500)
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, st: Int) {
            val svc = g.getService(SVC) ?: run { status = "not a WitMotion BLE device"; return }
            val notify = svc.getCharacteristic(NOTIFY)
            val wr = svc.getCharacteristic(WRITE)
            g.setCharacteristicNotification(notify, true)
            queue { gg ->
                val d = notify.getDescriptor(CCCD)
                val v = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                if (Build.VERSION.SDK_INT >= 33) gg.writeDescriptor(d, v) else @Suppress("DEPRECATION") { d.value = v; gg.writeDescriptor(d) }
            }
            // unlock, then output rate 0x09 = 100 Hz
            queue { gg -> write(gg, wr, byteArrayOf(0xFF.toByte(), 0xAA.toByte(), 0x69, 0x88.toByte(), 0xB5.toByte())) }
            queue { gg -> write(gg, wr, byteArrayOf(0xFF.toByte(), 0xAA.toByte(), 0x03, 0x09, 0x00)) }
            status = "connected ${g.device.name ?: g.device.address}"
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, st: Int) = next()
        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, st: Int) = next()

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, v: ByteArray) = parse(v)
        @Deprecated("pre-33 path")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION") if (Build.VERSION.SDK_INT < 33) parse(c.value)
        }
    }

    private fun parse(v: ByteArray) {
        val now = System.currentTimeMillis()
        var i = 0
        while (i + 20 <= v.size) {
            if (v[i] == 0x55.toByte() && v[i + 1] == 0x61.toByte()) {
                fun s(j: Int) = ((v[i + 2 + 2 * j].toInt() and 0xFF) or (v[i + 3 + 2 * j].toInt() shl 8)).toShort() / 32768f
                val e = floatArrayOf(s(6) * 180, s(7) * 180, s(8) * 180)
                val sample = ImuSample(
                    now, e,
                    floatArrayOf(s(0) * 16 * 9.81f, s(1) * 16 * 9.81f, s(2) * 16 * 9.81f),
                    floatArrayOf(s(3) * 2000, s(4) * 2000, s(5) * 2000),
                    mul(tare, eulerToQ(e)),
                )
                last = sample
                if (++count == 50) { hz = count * 1000.0 / (now - countStart).coerceAtLeast(1); count = 0; countStart = now }
                onSample(sample)
            }
            i += 20
        }
    }

    companion object {
        val SVC: UUID = UUID.fromString("0000ffe5-0000-1000-8000-00805f9a34fb")
        val NOTIFY: UUID = UUID.fromString("0000ffe4-0000-1000-8000-00805f9a34fb")
        val WRITE: UUID = UUID.fromString("0000ffe9-0000-1000-8000-00805f9a34fb")
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /** WitMotion angles are Z-Y-X (yaw, pitch, roll). Returns [w, x, y, z]. */
        fun eulerToQ(e: FloatArray): DoubleArray {
            val r = Math.toRadians(e[0].toDouble()) / 2; val p = Math.toRadians(e[1].toDouble()) / 2; val y = Math.toRadians(e[2].toDouble()) / 2
            val cr = cos(r); val sr = sin(r); val cp = cos(p); val sp = sin(p); val cy = cos(y); val sy = sin(y)
            return doubleArrayOf(
                cr * cp * cy + sr * sp * sy,
                sr * cp * cy - cr * sp * sy,
                cr * sp * cy + sr * cp * sy,
                cr * cp * sy - sr * sp * cy,
            )
        }

        fun conj(q: DoubleArray) = doubleArrayOf(q[0], -q[1], -q[2], -q[3])

        fun mul(a: DoubleArray, b: DoubleArray) = doubleArrayOf(
            a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
            a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
            a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
            a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
        )
    }
}
