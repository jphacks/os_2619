package jp.jphacks.sensorlink

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Stick scan: pictures of the empty floor sheets (step BG), then of the stick lying on them (STICK), each with the tags seen in it,
 * to the PC as { type: "scan", step: "start" | "bg" | "stick" | "done" | "cancel", n, w, h, k, tags, jpg }. The dashboard builds the
 * 3D model (stickscan.js) and the server answers { type: "stick" } (Link.stick). A picture is kept every 0.5 s while 2+ floor tags show.
 */
class Scan(private val link: Link) {
    enum class Step { OFF, BG, STICK }

    @Volatile var step = Step.OFF; private set
    @Volatile var nBg = 0; private set
    @Volatile var nStick = 0; private set
    private var lastMs = 0L

    fun start() { nBg = 0; nStick = 0; step = Step.BG; send("start") }
    fun next() { step = Step.STICK }
    fun finish() { step = Step.OFF; send("done") }
    fun cancel() { step = Step.OFF; send("cancel") }

    private fun send(s: String) = link.sendBig(JSONObject().put("type", "scan").put("step", s).put("t", link.pcTime()))

    /** Tag worker: a frame's colour picture (upright) with the tags found in it and its intrinsics k (as in the tags packet). */
    fun offer(bmp: Bitmap, tags: JSONArray, k: JSONArray) {
        val s = step
        if (s == Step.OFF || (s == Step.BG && nBg >= MAX_BG) || (s == Step.STICK && nStick >= MAX_STICK)) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastMs < 500) return
        if ((0 until tags.length()).count { tags.getJSONObject(it).getInt("id") in 0..6 } < 2) return
        lastMs = now
        val h = W * bmp.height / bmp.width // keep the aspect: the PC takes square pixels
        val small = Bitmap.createScaledBitmap(bmp, W, h, true)
        val jpg = ByteArrayOutputStream().also { small.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
        val n = if (s == Step.BG) nBg++ else nStick++
        link.sendBig(JSONObject().put("type", "scan").put("step", if (s == Step.BG) "bg" else "stick").put("t", link.pcTime()).put("n", n)
            .put("w", W).put("h", h).put("k", k).put("tags", tags).put("jpg", Base64.encodeToString(jpg, Base64.NO_WRAP)))
    }

    fun status(): String? = when (step) {
        Step.OFF -> link.stick?.let { "stick model on the PC: $it" }
        Step.BG -> "SCAN 1/2 empty circle: $nBg / $MAX_BG pictures" + if (nBg >= MAX_BG) " (enough: tap Stick placed)" else " (needs 2+ green tags)"
        Step.STICK -> "SCAN 2/2 stick: $nStick / $MAX_STICK pictures" + if (nStick >= MAX_STICK) " (enough: tap Finish)" else " (needs 2+ green tags)"
    }

    companion object {
        const val MAX_BG = 12
        const val MAX_STICK = 40
        private const val W = 480
    }
}
