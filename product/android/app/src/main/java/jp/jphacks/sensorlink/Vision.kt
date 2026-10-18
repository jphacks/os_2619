package jp.jphacks.sensorlink

import android.graphics.Bitmap
import org.json.JSONArray
import org.json.JSONObject
import org.opencv.android.Utils
import org.opencv.calib3d.Calib3d
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfDouble
import org.opencv.core.MatOfPoint2f
import org.opencv.core.MatOfPoint3f
import org.opencv.core.Point3
import org.opencv.imgproc.Imgproc
import org.opencv.objdetect.ArucoDetector
import org.opencv.objdetect.DetectorParameters
import org.opencv.objdetect.Objdetect
import kotlin.math.round

/** One upright camera frame. Intrinsics are in pixels of [bmp]. [t] is capture time on the PC clock (s). */
class Frame(val bmp: Bitmap, val t: Double, val fx: Double, val fy: Double, val cx: Double, val cy: Double)

fun r4(x: Double) = round(x * 1e4) / 1e4
fun r4(x: Float) = r4(x.toDouble())

/** Black-square size (m) of every tag. The printed paper is 200 mm square with a white margin of a tenth on each side, so the black square is 160 mm.
 *  A RuneTag (marker rune, ids 0-3) reports the corners of its virtual 200 mm square instead (Rune.SQUARE). */
fun tagSizeOf(id: Int, rune: Boolean = false) = if (rune && id in Rune.IDS) Rune.SQUARE else 0.16

/** AprilTag tag36h11 via OpenCV's aruco module (and RuneTags 0-3 via Rune.kt when [rune]), pose by solvePnP. Positions in the OpenCV camera frame (x right, y down, z forward), metres. */
class TagDetector {
    private val det = ArucoDetector(
        Objdetect.getPredefinedDictionary(Objdetect.DICT_APRILTAG_36h11),
        DetectorParameters().apply { set_cornerRefinementMethod(Objdetect.CORNER_REFINE_SUBPIX) },
    )
    private val rgba = Mat()
    private val gray = Mat()

    fun detect(f: Frame, rune: Boolean = false): JSONArray {
        Utils.bitmapToMat(f.bmp, rgba)
        Imgproc.cvtColor(rgba, gray, Imgproc.COLOR_RGBA2GRAY)
        val found = ArrayList<Pair<Int, FloatArray>>() // id, corners (x, y) x 4 in OpenCV order
        if (rune) {
            val g = ByteArray(gray.cols() * gray.rows()).also { gray.get(0, 0, it) }
            for (m in Rune.detect(g, gray.cols(), gray.rows())) found.add(m.id to FloatArray(8) { m.corners[it].toFloat() })
        }
        val corners = ArrayList<Mat>()
        val ids = Mat()
        det.detectMarkers(gray, corners, ids)
        for (i in 0 until ids.rows()) {
            val id = ids.get(i, 0)[0].toInt()
            if (!(rune && id in Rune.IDS)) found.add(id to FloatArray(8).also { corners[i].get(0, 0, it) })
            corners[i].release()
        }
        val out = JSONArray()
        val k = Mat(3, 3, CvType.CV_64F).apply { put(0, 0, f.fx, 0.0, f.cx, 0.0, f.fy, f.cy, 0.0, 0.0, 1.0) }
        for ((id, c) in found) {
            val size = tagSizeOf(id, rune)
            val h = size / 2
            val obj = MatOfPoint3f(Point3(-h, h, 0.0), Point3(h, h, 0.0), Point3(h, -h, 0.0), Point3(-h, -h, 0.0))
            val rvec = Mat(); val tvec = Mat()
            val ok = Calib3d.solvePnP(obj, MatOfPoint2f(*Array(4) { org.opencv.core.Point(c[2 * it].toDouble(), c[2 * it + 1].toDouble()) }),
                k, MatOfDouble(), rvec, tvec, false, Calib3d.SOLVEPNP_IPPE_SQUARE)
            val tag = JSONObject().put("id", id).put("sz", size)
                .put("c", JSONArray().apply { for (j in 0 until 4) put(JSONArray().put(r4(c[2 * j] / f.bmp.width)).put(r4(c[2 * j + 1] / f.bmp.height))) })
            if (ok) {
                tag.put("p", JSONArray().put(r4(tvec.get(0, 0)[0])).put(r4(tvec.get(1, 0)[0])).put(r4(tvec.get(2, 0)[0])))
                tag.put("r", JSONArray().put(r4(rvec.get(0, 0)[0])).put(r4(rvec.get(1, 0)[0])).put(r4(rvec.get(2, 0)[0])))
            }
            out.put(tag)
            rvec.release(); tvec.release(); obj.release()
        }
        ids.release(); k.release()
        return out
    }
}
