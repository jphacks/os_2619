package jp.jphacks.sensorlink

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.Surface
import android.view.View
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.ar.core.ArCoreApk
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Plane
import com.google.ar.core.Pose as ArPose
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import org.json.JSONArray
import org.json.JSONObject
import org.opencv.android.OpenCVLoader
import org.opencv.android.Utils
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.imgproc.Imgproc
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/** Single-thread worker that drops jobs while busy, so every detector always works on the newest frame. */
class Worker(name: String) {
    private val ex = Executors.newSingleThreadExecutor { Thread(it, name) }
    private val busy = AtomicBoolean(false)
    private var n = 0
    private var t0 = SystemClock.elapsedRealtime()
    @Volatile var hz = 0.0; private set
    val idle get() = !busy.get()

    fun offer(job: () -> Unit) {
        if (!busy.compareAndSet(false, true)) return
        ex.execute {
            try { job(); tick() } catch (e: Throwable) { Log.e("SensorLink", "worker", e) } finally { busy.set(false) }
        }
    }

    private fun tick() {
        val now = SystemClock.elapsedRealtime()
        if (++n >= 10) { hz = n * 1000.0 / (now - t0).coerceAtLeast(1); n = 0; t0 = now }
    }

    fun shutdown() = ex.shutdown()
}

class MainActivity : Activity(), GLSurfaceView.Renderer {
    private val prefs by lazy { getSharedPreferences("cfg", Context.MODE_PRIVATE) }
    private lateinit var link: Link
    private lateinit var imu: Imu
    private lateinit var scan: Scan
    private lateinit var gl: GLSurfaceView
    private lateinit var overlay: Overlay

    private var session: Session? = null
    private var installRequested = false
    @Volatile private var arError: String? = null
    private var tex = 0
    private var texSession: Session? = null
    @Volatile private var camPose: ArPose? = null
    @Volatile private var arOrigin: ArPose? = null
    @Volatile var arText = "AR: starting"
    // a hit: the torch stays on until this time (elapsedRealtime, ms). ARCore owns the camera, so the GL thread switches it through the session config.
    @Volatile private var torchUntilMs = 0L
    private var torchOn = false // GL thread
    private val vibe by lazy { Vibe(this) }
    private val hitSound by lazy { HitSound(this) }
    private val chargeSound by lazy { ChargeSound(this) }
    private val gameSound by lazy { GameSound(this) }
    // a hit: the whole screen blinks pure #FF0000 (on 60 ms / off 40 ms) for as long as the hit lasts (the torch's time;
    // a newer hit only makes it last longer). Never takes touches: not clickable
    private val hitRed by lazy { View(this).apply { setBackgroundColor(0xFFFF0000.toInt()); alpha = 0f } }
    private var hitRedUntilMs = 0L // UI thread only
    private val blinkRed: Runnable = object : Runnable {
        override fun run() {
            val now = SystemClock.elapsedRealtime()
            if (now >= hitRedUntilMs) { hitRed.alpha = 0f; return }
            hitRed.alpha = if (now % 100 < 60) 1f else 0f
            hitRed.postDelayed(this, 20)
        }
    }

    private val convertW = Worker("convert")
    private val tagW = Worker("tags")
    private var tagDet: TagDetector? = null
    // lazy: Mat() needs the OpenCV native lib, which is only loaded in onCreate (after field initialisers run)
    private val yuv by lazy { Mat() }; private val rgbaL by lazy { Mat() }; private val rgbaU by lazy { Mat() }
    private val grayL by lazy { Mat() }; private val grayU by lazy { Mat() }

    @Volatile var frame: Frame? = null
    @Volatile var preview: Bitmap? = null // colour picture for the screen, ~10 Hz, apart from the grey one the tags are read from
    @Volatile var tags: JSONArray? = null

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        Log.i("SensorLink", "onCreate: OpenCV init=" + OpenCVLoader.initLocal())

        val id = prefs.getString("id", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("id", it).apply() }
        link = Link(id, Build.MODEL)
        link.onVibrate = { vibe.handle(it); if (it == "off" || it == "win") chargeSound.stop() }
        link.onCharge = { el, tier, level -> chargeSound.charge(el, tier, level) }
        link.onSound = { gameSound.play(it) }
        link.onChargeFail = { chargeSound.fail() }
        hitSound; chargeSound; gameSound // load the sounds now, so the first hit / charge is not silent
        link.onFlash = { ms ->
            torchUntilMs = maxOf(torchUntilMs, SystemClock.elapsedRealtime() + ms) // another hit can only make it last longer
            if (ms > 0) { hitSound.play(); vibe.hit() }
            runOnUiThread {
                val now = SystemClock.elapsedRealtime()
                val blinking = now < hitRedUntilMs
                hitRedUntilMs = maxOf(hitRedUntilMs, now + ms)
                if (!blinking) { hitRed.removeCallbacks(blinkRed); blinkRed.run() } // already blinking: it just goes on longer
            }
        }
        scan = Scan(link)
        imu = Imu(this) { s ->
            link.send(JSONObject().put("type", "imu").put("t", link.pcTime(s.wallMs))
                .put("euler", arr(s.euler)).put("acc", arr(s.acc)).put("gyro", arr(s.gyro))
                .put("q", JSONArray().apply { s.q.forEach { put(r4(it)) } }))
        }

        gl = GLSurfaceView(this).apply {
            preserveEGLContextOnPause = true
            setEGLContextClientVersion(2)
            setRenderer(this@MainActivity)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        }
        overlay = Overlay(this)
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setBackgroundColor(0x99000000.toInt())
            fun btn(label: String, onClick: (Button) -> Unit) = addView(Button(context).apply { text = label; setOnClickListener { onClick(this) } },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            btn("IMU") { imuDialog() }
            btn("Calibrate") { calibrate() }
            btn("LAN") { lanDialog() }
            btn("Scan") { scanButton(it) }
        }
        setContentView(FrameLayout(this).apply {
            // ARCore needs a GL context to run; the picture itself is drawn by Overlay from the CPU image
            addView(gl, FrameLayout.LayoutParams(1, 1))
            addView(this@MainActivity.overlay, FrameLayout.LayoutParams(-1, -1))
            addView(bar, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
            addView(hitRed, FrameLayout.LayoutParams(-1, -1)) // last: over everything, buttons too
        })

        val perms = mutableListOf(Manifest.permission.CAMERA)
        perms += if (Build.VERSION.SDK_INT >= 31) listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        requestPermissions(perms.toTypedArray(), 1)

        Log.i("SensorLink", "onCreate: UI ready, connecting link")
        link.connect(prefs.getString("host", "192.168.0.10")!!, prefs.getInt("port", 8000))
    }

    override fun onRequestPermissionsResult(code: Int, p: Array<out String>, r: IntArray) {
        if (btGranted()) prefs.getString("imu", null)?.let { imu.connect(it) }
        if (!camGranted()) Toast.makeText(this, "Camera permission is required", Toast.LENGTH_LONG).show()
        // onResume runs again after the permission dialog closes and starts ARCore
    }

    private fun camGranted() = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    private fun btGranted() = if (Build.VERSION.SDK_INT >= 31) checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        && checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
    else checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    override fun onResume() {
        super.onResume()
        Log.i("SensorLink", "onResume cam=${camGranted()} session=${session != null}")
        if (!camGranted()) return
        if (session == null) {
            try {
                if (ArCoreApk.getInstance().requestInstall(this, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                    installRequested = true; return
                }
                session = Session(this).also { s ->
                    // CPU image: ARCore's default is 640x480, too few pixels for the RuneTag dots. Take the biggest 4:3 one up to 1920x1440 (what ARKit gives iOS).
                    val cfgs = s.getSupportedCameraConfigs(CameraConfigFilter(s).setFacingDirection(CameraConfig.FacingDirection.BACK))
                    val pick = cfgs.filter { it.imageSize.width * 3 == it.imageSize.height * 4 && it.imageSize.width <= 1920 }.maxByOrNull { it.imageSize.width }
                    if (pick != null) s.cameraConfig = pick
                    Log.i("SensorLink", "camera config ${s.cameraConfig.imageSize} (of ${cfgs.map { it.imageSize.toString() }})")
                    s.configure(Config(s).apply { focusMode = Config.FocusMode.AUTO; updateMode = Config.UpdateMode.BLOCKING })
                }
            } catch (e: Exception) { arError = "ARCore unavailable: ${e.message}"; Log.e("SensorLink", "arcore", e); return }
        }
        try { session?.resume() } catch (e: Exception) { arError = "camera busy: ${e.message}"; return }
        gl.onResume()
    }

    override fun onPause() {
        super.onPause()
        gl.onPause()
        session?.pause()
    }

    override fun onDestroy() {
        super.onDestroy()
        link.close(); imu.disconnect(); vibe.handle("off"); hitSound.release(); chargeSound.release(); gameSound.release()
        listOf(convertW, tagW).forEach { it.shutdown() }
        session?.close()
    }

    // ---- GL thread: ARCore update + camera image ----

    private var lastImgNs = 0L
    private var lastPreviewMs = 0L
    private val IMAGE_FPS = 30 // tag detection rate (camera max); AR pose is sent every frame

    override fun onSurfaceCreated(g: GL10?, c: EGLConfig?) {
        val t = IntArray(1)
        GLES20.glGenTextures(1, t, 0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, t[0])
        tex = t[0]; texSession = null
    }

    override fun onSurfaceChanged(g: GL10?, w: Int, h: Int) { session?.setDisplayGeometry(Surface.ROTATION_0, w, h) }

    override fun onDrawFrame(g: GL10?) {
        val s = session ?: return
        if (texSession !== s) { s.setCameraTextureName(tex); texSession = s }
        val torch = SystemClock.elapsedRealtime() < torchUntilMs
        if (torch != torchOn) { // a camera without a flash just stays dark
            torchOn = torch
            try { s.configure(s.config.apply { flashMode = if (torch) Config.FlashMode.TORCH else Config.FlashMode.OFF }) } catch (e: Exception) { Log.w("SensorLink", "torch", e) }
        }
        val f = try { s.update() } catch (e: Exception) { return }
        val cam = f.camera
        // ARCore image timestamps are on the boot clock on practically all devices; fall back to now otherwise
        val now = System.currentTimeMillis()
        val ageMs = (SystemClock.elapsedRealtimeNanos() - f.timestamp) / 1e6
        val t = link.pcTime(if (ageMs in 0.0..500.0) now - ageMs.toLong() else now)

        val tracking = cam.trackingState
        if (tracking == TrackingState.TRACKING) camPose = cam.pose
        val p = arOrigin?.inverse()?.compose(cam.pose) ?: cam.pose
        val planes = s.getAllTrackables(Plane::class.java).count { it.trackingState == TrackingState.TRACKING && it.subsumedBy == null }
        val reason = cam.trackingFailureReason.name
        link.send(JSONObject().put("type", "ar").put("t", t).put("tracking", tracking.name).put("reason", reason)
            .put("p", JSONArray().put(r4(p.tx())).put(r4(p.ty())).put(r4(p.tz())))
            .put("q", JSONArray().put(r4(p.qx())).put(r4(p.qy())).put(r4(p.qz())).put(r4(p.qw())))
            .put("planes", planes)
            // raw ARCore world pose: gravity-aligned (y up), unlike p/q which tilt with the calibration pose; the dashboard map needs it
            .put("wp", JSONArray().put(r4(cam.pose.tx())).put(r4(cam.pose.ty())).put(r4(cam.pose.tz())))
            .put("wq", JSONArray().put(r4(cam.pose.qx())).put(r4(cam.pose.qy())).put(r4(cam.pose.qz())).put(r4(cam.pose.qw()))))
        arText = "AR: $tracking${if (reason != "NONE") " ($reason)" else ""}  planes $planes  " +
            "pos %.2f %.2f %.2f".format(p.tx(), p.ty(), p.tz())

        if (!convertW.idle) return
        if (f.timestamp - lastImgNs < 1_000_000_000L / IMAGE_FPS) return
        val img = try { f.acquireCameraImage() } catch (e: NotYetAvailableException) { return }
        lastImgNs = f.timestamp
        val w = img.width; val h = img.height
        val wantPreview = SystemClock.elapsedRealtime() - lastPreviewMs >= 100
        if (wantPreview) lastPreviewMs = SystemClock.elapsedRealtime()
        val nv21 = ByteArray(if (wantPreview) w * h * 3 / 2 else w * h) // Y plane only unless the screen needs a colour picture
        try {
            val yp = img.planes[0]; val up = img.planes[1]; val vp = img.planes[2]
            val yb = yp.buffer
            for (r in 0 until h) { yb.position(r * yp.rowStride); yb.get(nv21, r * w, w) }
            if (wantPreview) {
                val ub = up.buffer; val vb = vp.buffer
                var o = w * h
                for (r in 0 until h / 2) for (c in 0 until w / 2) {
                    nv21[o++] = vb.get(r * vp.rowStride + c * vp.pixelStride)
                    nv21[o++] = ub.get(r * up.rowStride + c * up.pixelStride)
                }
            }
        } finally { img.close() }
        val k = cam.imageIntrinsics
        val fl = k.focalLength; val pp = k.principalPoint
        convertW.offer { onImage(nv21, wantPreview, w, h, t, fl, pp) }
    }

    // ---- worker threads ----

    private fun onImage(nv21: ByteArray, withColour: Boolean, w: Int, h: Int, t: Double, fl: FloatArray, pp: FloatArray) {
        // the detectors read the camera's Y plane as it is, rotated upright (no colour round trip)
        var colour: Bitmap? = null
        grayL.create(h, w, CvType.CV_8UC1)
        grayL.put(0, 0, nv21, 0, w * h)
        Core.rotate(grayL, grayU, Core.ROTATE_90_CLOCKWISE)
        val g = ByteArray(w * h).also { grayU.get(0, 0, it) }
        if (withColour) {
            yuv.create(h * 3 / 2, w, CvType.CV_8UC1)
            yuv.put(0, 0, nv21)
            Imgproc.cvtColor(yuv, rgbaL, Imgproc.COLOR_YUV2RGBA_NV21)
            Core.rotate(rgbaL, rgbaU, Core.ROTATE_90_CLOCKWISE)
            colour = Bitmap.createBitmap(h, w, Bitmap.Config.ARGB_8888)
            Utils.matToBitmap(rgbaU, colour)
            preview = colour
        }
        // shortcut: assumes the back camera sensor is mounted at 90° (true for nearly all phones); read SENSOR_ORIENTATION if a device shows it sideways
        // rotating (x, y) -> (h-1-y, x) swaps the focal lengths and moves the principal point
        val fr = Frame(g, h, w, t, fl[1].toDouble(), fl[0].toDouble(), h - 1 - pp[1].toDouble(), pp[0].toDouble())
        frame = fr
        overlay.postInvalidate()

        tagW.offer {
            val r = (tagDet ?: TagDetector().also { tagDet = it }).detect(fr, link.marker == "rune")
            tags = r
            val kk = JSONArray().put(r4(fr.fx / fr.width)).put(r4(fr.fy / fr.height)).put(r4(fr.cx / fr.width)).put(r4(fr.cy / fr.height))
            link.send(JSONObject().put("type", "tags").put("t", fr.t).put("tags", r).put("k", kk))
            colour?.let { scan.offer(it, r, kk) }
        }
    }

    // ---- UI actions ----

    private fun calibrate() {
        imu.calibrate()
        arOrigin = camPose
        link.send(JSONObject().put("type", "calib").put("t", link.pcTime()))
        Toast.makeText(this, if (camPose == null) "IMU zeroed (AR not tracking yet)" else "IMU zeroed, AR origin set here", Toast.LENGTH_SHORT).show()
    }

    /** Scan -> (instructions) -> Start -> walk around the stick -> Finish. The PC builds the stick's shape (dashboard stickscan.js). */
    private fun scanButton(b: Button) {
        if (!scan.on) AlertDialog.Builder(this).setTitle("Scan the stick")
            .setMessage("The PC turns photos into a 3D model of your stick's shape. Open the PC dashboard first (connection screen).\n\n" +
                "1. Lay the magic circle flat and lay the stick straight across its middle, its TIP toward tag T0 (the top of the poster).\n" +
                "2. Keep anything else that is not black or white off the circle (hands, feet, bags). Don't move the circle or the stick from now on.\n" +
                "3. Tap Start and walk slowly around it twice, 0.8-1.2 m away: once high, looking down, and once low, about 30° above the floor. " +
                "A photo is taken every half second while 2 or more tags show green; get the whole stick in the picture.\n" +
                "4. Tap Finish (after about 30 pictures). The model appears on the PC's connection screen and in the game.")
            .setPositiveButton("Start") { _, _ -> scan.start(); b.text = "Finish" }
            .setNegativeButton("Cancel", null).show()
        else AlertDialog.Builder(this).setTitle("Finish the scan?")
            .setMessage("${scan.n} pictures. The PC needs 6 at least; more angles give a better shape.")
            .setPositiveButton("Send to PC") { _, _ -> scan.finish(); b.text = "Scan"; Toast.makeText(this, "Sent: the PC builds the model", Toast.LENGTH_LONG).show() }
            .setNeutralButton("Cancel scan") { _, _ -> scan.cancel(); b.text = "Scan" }
            .setNegativeButton("Keep scanning", null).show()
    }

    private fun imuDialog() {
        if (!btGranted()) { requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT), 1); return }
        val names = ArrayList<String>(); val addrs = ArrayList<String>()
        val ad = ArrayAdapter(this, android.R.layout.simple_list_item_1, names)
        AlertDialog.Builder(this)
            .setTitle("Pair IMU — scanning (WitMotion names start with WT)\n${imu.status}")
            .setAdapter(ad) { _, i -> imu.connect(addrs[i]); prefs.edit().putString("imu", addrs[i]).apply() }
            .setNeutralButton("Disconnect") { _, _ -> imu.disconnect(); prefs.edit().remove("imu").apply() }
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { imu.stopScan() }
            .show()
        imu.scan { d, n ->
            if (d.address in addrs) return@scan
            val at = if (n.startsWith("WT")) 0 else addrs.size // WitMotion sensors first
            addrs.add(at, d.address); names.add(at, "$n   ${d.address}")
            ad.notifyDataSetChanged()
        }
    }

    private fun lanDialog() {
        fun field(hint: String, v: String, type: Int) = EditText(this).apply { this.hint = hint; setText(v); inputType = type }
        val host = field("PC IP address", prefs.getString("host", "192.168.0.10")!!, InputType.TYPE_CLASS_TEXT)
        val port = field("port", prefs.getInt("port", 8000).toString(), InputType.TYPE_CLASS_NUMBER)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(48, 16, 48, 0)
            addView(TextView(context).apply { text = "${link.status}\nslot ${link.slot}, rtt %.0f ms".format(link.rttMs) })
            listOf("PC IP" to host, "Port" to port).forEach { (l, e) -> addView(TextView(context).apply { text = l }); addView(e) }
        }
        AlertDialog.Builder(this).setTitle("LAN connection").setView(box)
            .setPositiveButton("Connect / reconnect") { _, _ ->
                val pt = port.text.toString().toIntOrNull()?.takeIf { it in 1..65535 }
                if (pt == null || host.text.isBlank()) { Toast.makeText(this, "invalid port", Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                prefs.edit().putString("host", host.text.toString().trim()).putInt("port", pt).apply()
                link.connect(host.text.toString().trim(), pt)
            }
            .setNeutralButton("Disconnect") { _, _ -> link.close() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    fun statusLines() = listOf(
        "LAN: ${link.status}  slot ${link.slot}  rtt %.0f ms  floor tags: ${if (link.marker == "rune") "RuneTag" else "AprilTag"}".format(link.rttMs),
        "IMU: ${imu.status}" + (imu.last?.let { "  %.0f Hz  p %.0f r %.0f y %.0f".format(imu.hz, it.euler[0], it.euler[1], it.euler[2]) } ?: ""),
        arError ?: arText,
        "Hz  cam %.0f  tag %.0f".format(convertW.hz, tagW.hz),
        "tags: " + (tags?.let { a -> (0 until a.length()).joinToString { a.getJSONObject(it).getInt("id").toString() } } ?: ""),
    ) + listOfNotNull(scan.status())

    private fun arr(a: FloatArray) = JSONArray().apply { a.forEach { put(r4(it)) } }
}

/** Camera picture with the detected tags drawn on top. */
class Overlay(private val a: MainActivity) : View(a) {
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 5f }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 34f; setShadowLayer(4f, 0f, 0f, Color.BLACK) }
    private val dst = RectF()

    override fun onDraw(c: Canvas) {
        c.drawColor(Color.BLACK)
        val bmp = a.preview
        if (bmp != null) {
            val s = minOf(width.toFloat() / bmp.width, height.toFloat() / bmp.height)
            val w = bmp.width * s; val h = bmp.height * s
            dst.set((width - w) / 2, (height - h) / 2, (width + w) / 2, (height + h) / 2)
            c.drawBitmap(bmp, null, dst, null)
            fun x(v: Double) = dst.left + (v * dst.width()).toFloat()
            fun y(v: Double) = dst.top + (v * dst.height()).toFloat()

            a.tags?.let { tags ->
                line.color = Color.GREEN
                for (i in 0 until tags.length()) {
                    val t = tags.getJSONObject(i); val cs = t.getJSONArray("c")
                    val path = Path()
                    for (j in 0 until 4) { val p = cs.getJSONArray(j); if (j == 0) path.moveTo(x(p.getDouble(0)), y(p.getDouble(1))) else path.lineTo(x(p.getDouble(0)), y(p.getDouble(1))) }
                    path.close(); c.drawPath(path, line)
                    val p0 = cs.getJSONArray(0)
                    val d = t.optJSONArray("p")?.let { " %.2fm".format(it.getDouble(2)) } ?: ""
                    c.drawText("id ${t.getInt("id")}$d", x(p0.getDouble(0)), y(p0.getDouble(1)) - 10, text)
                }
            }
        } else c.drawText("starting camera…", 40f, height / 2f, text)

        a.statusLines().forEachIndexed { i, s -> c.drawText(s, 20f, 60f + i * 42f, text) }
        postInvalidateDelayed(100) // keep status text fresh even without frames
    }
}
