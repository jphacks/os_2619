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
import android.view.MotionEvent
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
import java.io.ByteArrayOutputStream
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

    private val convertW = Worker("convert")
    private val tagW = Worker("tags")
    private val colorW = Worker("color")
    private val handW = Worker("hands")
    private val poseW = Worker("pose")
    private val videoW = Worker("video")
    private var tagDet: TagDetector? = null
    private var colorDet: ColorDetector? = null
    private var hands: Hands? = null
    private var pose: Pose? = null
    private var lastVideoMs = 0L
    // lazy: Mat() needs the OpenCV native lib, which is only loaded in onCreate (after field initialisers run)
    private val yuv by lazy { Mat() }; private val rgbaL by lazy { Mat() }; private val rgbaU by lazy { Mat() }

    @Volatile var frame: Frame? = null
    @Volatile var tags: JSONArray? = null
    @Volatile var handRes: JSONObject? = null
    @Volatile var poseRes: JSONObject? = null
    @Volatile var colorRes: JSONObject? = null
    /** Target colour in OpenCV HSV, or null if none picked yet. */
    @Volatile var target: DoubleArray? = null
    /** Opponent's colour (same format), and which of the two the next tap on the picture sets. */
    @Volatile var targetOpp: DoubleArray? = null
    @Volatile var colorResOpp: JSONObject? = null
    @Volatile var pickOpp = false

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        Log.i("SensorLink", "onCreate: OpenCV init=" + OpenCVLoader.initLocal())

        val id = prefs.getString("id", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("id", it).apply() }
        link = Link(id, Build.MODEL)
        imu = Imu(this) { s ->
            link.send(JSONObject().put("type", "imu").put("t", link.pcTime(s.wallMs))
                .put("euler", arr(s.euler)).put("acc", arr(s.acc)).put("gyro", arr(s.gyro))
                .put("q", JSONArray().apply { s.q.forEach { put(r4(it)) } }))
        }
        if (prefs.contains("th")) target = doubleArrayOf(prefs.getFloat("th", 0f).toDouble(), prefs.getFloat("ts", 0f).toDouble(), prefs.getFloat("tv", 0f).toDouble())

        gl = GLSurfaceView(this).apply {
            preserveEGLContextOnPause = true
            setEGLContextClientVersion(2)
            setRenderer(this@MainActivity)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        }
        if (prefs.contains("oh")) targetOpp = doubleArrayOf(prefs.getFloat("oh", 0f).toDouble(), prefs.getFloat("os", 0f).toDouble(), prefs.getFloat("ov", 0f).toDouble())
        overlay = Overlay(this)
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setBackgroundColor(0x99000000.toInt())
            fun btn(label: String, onClick: (Button) -> Unit) = addView(Button(context).apply { text = label; setOnClickListener { onClick(this) } },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            btn("Pick: ME") { b -> pickOpp = !pickOpp; b.text = if (pickOpp) "Pick: OPP" else "Pick: ME" }
            btn("IMU") { imuDialog() }
            btn("Calibrate") { calibrate() }
            btn("LAN") { lanDialog() }
        }
        setContentView(FrameLayout(this).apply {
            // ARCore needs a GL context to run; the picture itself is drawn by Overlay from the CPU image
            addView(gl, FrameLayout.LayoutParams(1, 1))
            addView(this@MainActivity.overlay, FrameLayout.LayoutParams(-1, -1))
            addView(bar, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
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
        link.close(); imu.disconnect()
        listOf(convertW, tagW, colorW, handW, poseW, videoW).forEach { it.shutdown() }
        session?.close()
    }

    // ---- GL thread: ARCore update + camera image ----

    private val MAX_TIP_DIST = 0.5
    private var lastImgNs = 0L
    private val IMAGE_FPS = 10 // detection rate; AR pose is still sent every frame

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
        val nv21 = ByteArray(w * h * 3 / 2)
        try {
            val yp = img.planes[0]; val up = img.planes[1]; val vp = img.planes[2]
            val yb = yp.buffer
            for (r in 0 until h) { yb.position(r * yp.rowStride); yb.get(nv21, r * w, w) }
            val ub = up.buffer; val vb = vp.buffer
            var o = w * h
            for (r in 0 until h / 2) for (c in 0 until w / 2) {
                nv21[o++] = vb.get(r * vp.rowStride + c * vp.pixelStride)
                nv21[o++] = ub.get(r * up.rowStride + c * up.pixelStride)
            }
        } finally { img.close() }
        val k = cam.imageIntrinsics
        val fl = k.focalLength; val pp = k.principalPoint
        convertW.offer { onImage(nv21, w, h, t, fl, pp) }
    }

    // ---- worker threads ----

    private fun onImage(nv21: ByteArray, w: Int, h: Int, t: Double, fl: FloatArray, pp: FloatArray) {
        yuv.create(h * 3 / 2, w, CvType.CV_8UC1)
        yuv.put(0, 0, nv21)
        Imgproc.cvtColor(yuv, rgbaL, Imgproc.COLOR_YUV2RGBA_NV21)
        // shortcut: assumes the back camera sensor is mounted at 90° (true for nearly all phones); read SENSOR_ORIENTATION if a device shows it sideways
        Core.rotate(rgbaL, rgbaU, Core.ROTATE_90_CLOCKWISE)
        val bmp = Bitmap.createBitmap(h, w, Bitmap.Config.ARGB_8888)
        Utils.matToBitmap(rgbaU, bmp)
        // rotating (x, y) -> (h-1-y, x) swaps the focal lengths and moves the principal point
        val fr = Frame(bmp, t, fl[1].toDouble(), fl[0].toDouble(), h - 1 - pp[1].toDouble(), pp[0].toDouble())
        frame = fr
        overlay.postInvalidate()

        tagW.offer {
            val r = (tagDet ?: TagDetector().also { tagDet = it }).detect(fr, prefs.getFloat("tag", 0.1f).toDouble())
            tags = r
            link.send(JSONObject().put("type", "tags").put("t", fr.t).put("tags", r)
                .put("k", JSONArray().put(r4(fr.fx / fr.bmp.width)).put(r4(fr.fy / fr.bmp.height)).put(r4(fr.cx / fr.bmp.width)).put(r4(fr.cy / fr.bmp.height))))
        }
        val mine = target; val theirs = targetOpp
        if (mine != null || theirs != null) colorW.offer {
            val d = colorDet ?: ColorDetector().also { colorDet = it }
            mine?.let { val r = d.detect(fr, "me", it[0], it[1], it[2]); colorRes = r; link.send(r) }
            theirs?.let { val r = d.detect(fr, "opp", it[0], it[1], it[2]); colorResOpp = r; link.send(r) }
        }
        handW.offer { val r = (hands ?: Hands(this).also { hands = it }).detect(fr); tagOwners(r); handRes = r; link.send(r) }
        poseW.offer { val r = (pose ?: Pose(this).also { pose = it }).detect(fr); poseRes = r; link.send(r) }
        val now = SystemClock.elapsedRealtime()
        if (now - lastVideoMs >= 66 && link.videoReady()) {
            lastVideoMs = now
            videoW.offer {
                val out = ByteArrayOutputStream(64 * 1024)
                fr.bmp.compress(Bitmap.CompressFormat.JPEG, 60, out)
                link.sendVideo(out.toByteArray())
            }
        }
    }

    /**
     * Adds "owner" ("me" / "opp" / "?") to each hand: the sword-tip colour blobs are already told apart, so each tip
     * claims the nearest hand (one-to-one, within MAX_TIP_DIST in image-fraction units). Unclaimed hands stay "?".
     */
    private fun tagOwners(r: JSONObject) {
        val hs = r.getJSONArray("hands")
        val cen = (0 until hs.length()).map { i ->
            val lm = hs.getJSONObject(i).getJSONArray("lm")
            var sx = 0.0; var sy = 0.0
            for (j in 0 until lm.length()) { sx += lm.getJSONArray(j).getDouble(0); sy += lm.getJSONArray(j).getDouble(1) }
            doubleArrayOf(sx / lm.length(), sy / lm.length())
        }
        val tips = listOf("me" to colorRes, "opp" to colorResOpp).filter { it.second?.optBoolean("found") == true }
            .map { (side, c) -> Triple(side, c!!.getDouble("x"), c.getDouble("y")) }
        val owner = arrayOfNulls<String>(cen.size)
        val pairs = tips.flatMap { (side, tx, ty) -> cen.indices.map { i -> Triple(side, i, Math.hypot(cen[i][0] - tx, cen[i][1] - ty)) } }
            .filter { it.third < MAX_TIP_DIST }.sortedBy { it.third }
        val usedSides = HashSet<String>()
        for ((side, i, _) in pairs) if (owner[i] == null && usedSides.add(side)) owner[i] = side
        for (i in cen.indices) hs.getJSONObject(i).put("owner", owner[i] ?: "?")
    }

    // ---- UI actions ----

    private fun calibrate() {
        imu.calibrate()
        arOrigin = camPose
        link.send(JSONObject().put("type", "calib").put("t", link.pcTime()))
        Toast.makeText(this, if (camPose == null) "IMU zeroed (AR not tracking yet)" else "IMU zeroed, AR origin set here", Toast.LENGTH_SHORT).show()
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
        val tag = field("AprilTag size (m, black square)", prefs.getFloat("tag", 0.1f).toString(),
            InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(48, 16, 48, 0)
            addView(TextView(context).apply { text = "${link.status}\nslot ${link.slot}, rtt %.0f ms".format(link.rttMs) })
            listOf("PC IP" to host, "Port" to port, "Tag size (m)" to tag).forEach { (l, e) -> addView(TextView(context).apply { text = l }); addView(e) }
        }
        AlertDialog.Builder(this).setTitle("LAN connection").setView(box)
            .setPositiveButton("Connect / reconnect") { _, _ ->
                val pt = port.text.toString().toIntOrNull()?.takeIf { it in 1..65535 }
                val ts = tag.text.toString().toFloatOrNull()?.takeIf { it > 0 }
                if (pt == null || ts == null || host.text.isBlank()) { Toast.makeText(this, "invalid port or tag size", Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                prefs.edit().putString("host", host.text.toString().trim()).putInt("port", pt).putFloat("tag", ts).apply()
                link.connect(host.text.toString().trim(), pt)
            }
            .setNeutralButton("Disconnect") { _, _ -> link.close() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Tap on the picture: the average colour around the tap becomes the detection target. */
    fun pickColor(bmp: Bitmap, x: Int, y: Int) {
        var r = 0; var g = 0; var b = 0; var n = 0
        for (yy in (y - 3).coerceAtLeast(0)..(y + 3).coerceAtMost(bmp.height - 1))
            for (xx in (x - 3).coerceAtLeast(0)..(x + 3).coerceAtMost(bmp.width - 1)) {
                val c = bmp.getPixel(xx, yy); r += Color.red(c); g += Color.green(c); b += Color.blue(c); n++
            }
        val hsv = FloatArray(3)
        Color.RGBToHSV(r / n, g / n, b / n, hsv)
        val t = doubleArrayOf(hsv[0] / 2.0, hsv[1] * 255.0, hsv[2] * 255.0)
        val k = if (pickOpp) "o" else "t" // prefs keys: t* = me, o* = opponent
        if (pickOpp) { targetOpp = t; colorResOpp = null } else { target = t; colorRes = null }
        prefs.edit().putFloat(k + "h", t[0].toFloat()).putFloat(k + "s", t[1].toFloat()).putFloat(k + "v", t[2].toFloat()).apply()
        val who = if (pickOpp) "opponent" else "my"
        Toast.makeText(this, if (hsv[1] < 0.25f) "Picked a greyish colour ($who): detection works best on saturated colours" else "Colour picked ($who)", Toast.LENGTH_SHORT).show()
    }

    fun statusLines() = listOf(
        "LAN: ${link.status}  slot ${link.slot}  rtt %.0f ms".format(link.rttMs),
        "IMU: ${imu.status}" + (imu.last?.let { "  %.0f Hz  r %.0f p %.0f y %.0f".format(imu.hz, it.euler[0], it.euler[1], it.euler[2]) } ?: ""),
        arError ?: arText,
        "Hz  cam %.0f  tag %.0f  hand %.0f  pose %.0f  color %.0f".format(convertW.hz, tagW.hz, handW.hz, poseW.hz, colorW.hz),
        "tags: " + (tags?.let { a -> (0 until a.length()).joinToString { a.getJSONObject(it).getInt("id").toString() } } ?: "") +
            "   hands ${handRes?.getJSONArray("hands")?.length() ?: 0}   pose ${if (poseRes?.optBoolean("found") == true) "yes" else "no"}" +
            "   color me ${if (target == null) "tap to pick" else if (colorRes?.optBoolean("found") == true) "found" else "-"}" +
            " opp ${if (targetOpp == null) "tap to pick" else if (colorResOpp?.optBoolean("found") == true) "found" else "-"}",
    )

    private fun arr(a: FloatArray) = JSONArray().apply { a.forEach { put(r4(it)) } }
}

/** Camera picture with everything detected drawn on top. Tapping it picks the detection colour. */
class Overlay(private val a: MainActivity) : View(a) {
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 5f }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 34f; setShadowLayer(4f, 0f, 0f, Color.BLACK) }
    private val dst = RectF()

    override fun onDraw(c: Canvas) {
        c.drawColor(Color.BLACK)
        val f = a.frame
        if (f != null) {
            val s = minOf(width.toFloat() / f.bmp.width, height.toFloat() / f.bmp.height)
            val w = f.bmp.width * s; val h = f.bmp.height * s
            dst.set((width - w) / 2, (height - h) / 2, (width + w) / 2, (height + h) / 2)
            c.drawBitmap(f.bmp, null, dst, null)
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
            a.poseRes?.optJSONArray("lm")?.let { skeleton(c, it, POSE, Color.MAGENTA, ::x, ::y) }
            a.handRes?.getJSONArray("hands")?.let { hs -> for (i in 0 until hs.length()) {
                val hd = hs.getJSONObject(i)
                skeleton(c, hd.getJSONArray("lm"), HAND, when (hd.optString("owner")) { "me" -> Color.CYAN; "opp" -> Color.rgb(255, 128, 0); else -> Color.LTGRAY }, ::x, ::y)
            } }
            listOf(a.colorRes to Color.YELLOW, a.colorResOpp to Color.RED).forEach { (res, col) ->
                res?.takeIf { it.optBoolean("found") }?.let { r ->
                    val b = r.getJSONArray("box")
                    line.color = col
                    c.drawRect(x(b.getDouble(0)), y(b.getDouble(1)), x(b.getDouble(0) + b.getDouble(2)), y(b.getDouble(1) + b.getDouble(3)), line)
                    val cx = x(r.getDouble("x")); val cy = y(r.getDouble("y"))
                    c.drawLine(cx - 30, cy, cx + 30, cy, line); c.drawLine(cx, cy - 30, cx, cy + 30, line)
                    c.drawText(if (r.optString("side") == "opp") "OPP" else "ME", cx + 12, cy - 12, text)
                }
            }
        } else c.drawText("starting camera…", 40f, height / 2f, text)

        listOf(a.target to 260f, a.targetOpp to 360f).forEach { (t, cy) ->
            if (t == null) return@forEach
            fill.color = Color.HSVToColor(floatArrayOf((t[0] * 2).toFloat(), (t[1] / 255).toFloat(), (t[2] / 255).toFloat()))
            c.drawCircle(width - 60f, cy, 36f, fill)
            line.color = Color.WHITE; c.drawCircle(width - 60f, cy, 36f, line)
            c.drawText(if (cy == 260f) "ME" else "OPP", width - 110f, cy + 12, text)
        }
        a.statusLines().forEachIndexed { i, s -> c.drawText(s, 20f, 60f + i * 42f, text) }
        postInvalidateDelayed(100) // keep status text fresh even without frames
    }

    private fun skeleton(c: Canvas, lm: JSONArray, links: IntArray, col: Int, x: (Double) -> Float, y: (Double) -> Float) {
        line.color = col; fill.color = col
        for (i in links.indices step 2) {
            if (links[i + 1] >= lm.length()) continue
            val p = lm.getJSONArray(links[i]); val q = lm.getJSONArray(links[i + 1])
            c.drawLine(x(p.getDouble(0)), y(p.getDouble(1)), x(q.getDouble(0)), y(q.getDouble(1)), line)
        }
        for (i in 0 until lm.length()) { val p = lm.getJSONArray(i); c.drawCircle(x(p.getDouble(0)), y(p.getDouble(1)), 6f, fill) }
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (e.action == MotionEvent.ACTION_UP) {
            val f = a.frame ?: return true
            if (!dst.contains(e.x, e.y)) return true
            a.pickColor(f.bmp, ((e.x - dst.left) / dst.width() * f.bmp.width).toInt(), ((e.y - dst.top) / dst.height() * f.bmp.height).toInt())
        }
        return true
    }

    companion object {
        val HAND = intArrayOf(0,1, 1,2, 2,3, 3,4, 0,5, 5,6, 6,7, 7,8, 5,9, 9,10, 10,11, 11,12, 9,13, 13,14, 14,15, 15,16, 13,17, 0,17, 17,18, 18,19, 19,20)
        val POSE = intArrayOf(11,12, 11,13, 13,15, 12,14, 14,16, 11,23, 12,24, 23,24, 23,25, 25,27, 24,26, 26,28, 27,29, 29,31, 27,31, 28,30, 30,32, 28,32,
            0,1, 1,2, 2,3, 3,7, 0,4, 4,5, 5,6, 6,8, 9,10, 15,17, 15,19, 15,21, 17,19, 16,18, 16,20, 16,22, 18,20)
    }
}
