package jp.jphacks.sensorlink

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import org.json.JSONArray
import org.json.JSONObject
import org.opencv.android.Utils
import org.opencv.calib3d.Calib3d
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfDouble
import org.opencv.core.MatOfPoint2f
import org.opencv.core.MatOfPoint3f
import org.opencv.core.Point3
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import org.opencv.objdetect.ArucoDetector
import org.opencv.objdetect.DetectorParameters
import org.opencv.objdetect.Objdetect
import kotlin.math.round

/** One upright camera frame. Intrinsics are in pixels of [bmp]. [t] is capture time on the PC clock (s). */
class Frame(val bmp: Bitmap, val t: Double, val fx: Double, val fy: Double, val cx: Double, val cy: Double)

fun r4(x: Double) = round(x * 1e4) / 1e4
fun r4(x: Float) = r4(x.toDouble())

/** AprilTag tag36h11 via OpenCV's aruco module, pose by solvePnP. Positions in the OpenCV camera frame (x right, y down, z forward), metres. */
class TagDetector {
    private val det = ArucoDetector(
        Objdetect.getPredefinedDictionary(Objdetect.DICT_APRILTAG_36h11),
        DetectorParameters().apply { set_cornerRefinementMethod(Objdetect.CORNER_REFINE_SUBPIX) },
    )
    private val rgba = Mat()
    private val gray = Mat()

    fun detect(f: Frame, tagSize: Double): JSONArray {
        Utils.bitmapToMat(f.bmp, rgba)
        Imgproc.cvtColor(rgba, gray, Imgproc.COLOR_RGBA2GRAY)
        val corners = ArrayList<Mat>()
        val ids = Mat()
        det.detectMarkers(gray, corners, ids)
        val out = JSONArray()
        val h = tagSize / 2
        val obj = MatOfPoint3f(Point3(-h, h, 0.0), Point3(h, h, 0.0), Point3(h, -h, 0.0), Point3(-h, -h, 0.0))
        val k = Mat(3, 3, CvType.CV_64F).apply { put(0, 0, f.fx, 0.0, f.cx, 0.0, f.fy, f.cy, 0.0, 0.0, 1.0) }
        for (i in 0 until ids.rows()) {
            val c = FloatArray(8).also { corners[i].get(0, 0, it) }
            val rvec = Mat(); val tvec = Mat()
            val ok = Calib3d.solvePnP(obj, MatOfPoint2f(*Array(4) { org.opencv.core.Point(c[2 * it].toDouble(), c[2 * it + 1].toDouble()) }),
                k, MatOfDouble(), rvec, tvec, false, Calib3d.SOLVEPNP_IPPE_SQUARE)
            val tag = JSONObject().put("id", ids.get(i, 0)[0].toInt())
                .put("c", JSONArray().apply { for (j in 0 until 4) put(JSONArray().put(r4(c[2 * j] / f.bmp.width)).put(r4(c[2 * j + 1] / f.bmp.height))) })
            if (ok) {
                tag.put("p", JSONArray().put(r4(tvec.get(0, 0)[0])).put(r4(tvec.get(1, 0)[0])).put(r4(tvec.get(2, 0)[0])))
                tag.put("r", JSONArray().put(r4(rvec.get(0, 0)[0])).put(r4(rvec.get(1, 0)[0])).put(r4(rvec.get(2, 0)[0])))
            }
            out.put(tag)
            rvec.release(); tvec.release(); corners[i].release()
        }
        ids.release(); k.release(); obj.release()
        return out
    }
}

/** Centroid of the largest blob of the target colour. Target is OpenCV HSV (h 0..179, s/v 0..255). */
class ColorDetector {
    private val rgba = Mat(); private val small = Mat(); private val hsv = Mat()
    private val mask = Mat(); private val mask2 = Mat()
    private val labels = Mat(); private val stats = Mat(); private val cents = Mat()
    private val kernel = Imgproc.getStructuringElement(Imgproc.MORPH_ELLIPSE, Size(5.0, 5.0))

    fun detect(f: Frame, h: Double, s: Double, v: Double, hueTol: Double = 12.0): JSONObject {
        Utils.bitmapToMat(f.bmp, rgba)
        Imgproc.resize(rgba, small, Size(rgba.cols() / 2.0, rgba.rows() / 2.0), 0.0, 0.0, Imgproc.INTER_AREA)
        Imgproc.cvtColor(small, hsv, Imgproc.COLOR_RGB2HSV) // RGB2HSV accepts 4-channel input, alpha ignored
        val sMin = maxOf(40.0, s * 0.5); val vMin = maxOf(40.0, v * 0.4)
        val lo = h - hueTol; val hi = h + hueTol
        Core.inRange(hsv, Scalar(maxOf(lo, 0.0), sMin, vMin), Scalar(minOf(hi, 179.0), 255.0, 255.0), mask)
        // hue wraps at 180 (red sits on both ends)
        if (lo < 0 || hi > 179) {
            val (a, b) = if (lo < 0) lo + 180 to 179.0 else 0.0 to hi - 180
            Core.inRange(hsv, Scalar(a, sMin, vMin), Scalar(b, 255.0, 255.0), mask2)
            Core.bitwise_or(mask, mask2, mask)
        }
        Imgproc.morphologyEx(mask, mask, Imgproc.MORPH_OPEN, kernel)
        val n = Imgproc.connectedComponentsWithStats(mask, labels, stats, cents)
        var best = -1; var bestArea = 30.0 // ignore specks
        for (i in 1 until n) { val a = stats.get(i, Imgproc.CC_STAT_AREA)[0]; if (a > bestArea) { bestArea = a; best = i } }
        val o = JSONObject().put("type", "color").put("t", f.t).put("target", JSONArray().put(h).put(s).put(v))
        if (best < 0) return o.put("found", false)
        val w = mask.cols().toDouble(); val hh = mask.rows().toDouble()
        return o.put("found", true)
            .put("x", r4(cents.get(best, 0)[0] / w)).put("y", r4(cents.get(best, 1)[0] / hh))
            .put("area", r4(bestArea / (w * hh)))
            .put("box", JSONArray().put(r4(stats.get(best, Imgproc.CC_STAT_LEFT)[0] / w)).put(r4(stats.get(best, Imgproc.CC_STAT_TOP)[0] / hh))
                .put(r4(stats.get(best, Imgproc.CC_STAT_WIDTH)[0] / w)).put(r4(stats.get(best, Imgproc.CC_STAT_HEIGHT)[0] / hh)))
    }
}

/** MediaPipe hands + pose. Create and call on one thread each (GPU delegate is thread-bound). Falls back to CPU. */
class Hands(ctx: Context) {
    private val lm = gpuOrCpu { d ->
        HandLandmarker.createFromOptions(ctx, HandLandmarker.HandLandmarkerOptions.builder()
            .setBaseOptions(BaseOptions.builder().setModelAssetPath("hand_landmarker.task").setDelegate(d).build())
            .setRunningMode(RunningMode.VIDEO).setNumHands(2).build())
    }

    fun detect(f: Frame): JSONObject {
        val r = lm.detectForVideo(BitmapImageBuilder(f.bmp).build(), clock.next(f))
        val hands = JSONArray()
        r.landmarks().forEachIndexed { i, pts ->
            val cat = r.handedness().getOrNull(i)?.firstOrNull()
            hands.put(JSONObject()
                .put("side", cat?.categoryName() ?: "?").put("score", r4(cat?.score() ?: 0f))
                .put("lm", JSONArray().apply { pts.forEach { put(JSONArray().put(r4(it.x())).put(r4(it.y())).put(r4(it.z()))) } }))
        }
        return JSONObject().put("type", "hands").put("t", f.t).put("hands", hands)
    }

    private val clock = MonoMs()
    fun close() = lm.close()
}

class Pose(ctx: Context) {
    private val lm = gpuOrCpu { d ->
        PoseLandmarker.createFromOptions(ctx, PoseLandmarker.PoseLandmarkerOptions.builder()
            .setBaseOptions(BaseOptions.builder().setModelAssetPath("pose_landmarker_lite.task").setDelegate(d).build())
            .setRunningMode(RunningMode.VIDEO).setNumPoses(1).build())
    }

    fun detect(f: Frame): JSONObject {
        val r = lm.detectForVideo(BitmapImageBuilder(f.bmp).build(), clock.next(f))
        val o = JSONObject().put("type", "pose").put("t", f.t)
        val pts = r.landmarks().firstOrNull() ?: return o.put("found", false)
        return o.put("found", true).put("lm", JSONArray().apply {
            pts.forEach { put(JSONArray().put(r4(it.x())).put(r4(it.y())).put(r4(it.z())).put(r4(it.visibility().orElse(0f)))) }
        })
    }

    private val clock = MonoMs()
    fun close() = lm.close()
}

/** VIDEO mode needs strictly increasing timestamps; the PC clock offset can step backwards. */
private class MonoMs { var last = 0L; fun next(f: Frame) = maxOf(last + 1, (f.t * 1000).toLong()).also { last = it } }

private fun <T> gpuOrCpu(make: (Delegate) -> T): T = try { make(Delegate.GPU) } catch (e: Exception) { make(Delegate.CPU) }
