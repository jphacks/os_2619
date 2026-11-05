package jp.jphacks.sensorlink

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Stick scan: pictures of the stick lying on the mahoujin, each with the tags seen in it, to the PC as
 * { type: "scan", step: "start" | "stick" | "done" | "cancel", n, w, h, k, tags, jpg }. The dashboard builds the 3D shape (stickscan.js)
 * and the server answers { type: "stick" } (Link.stick). A picture is kept every 0.5 s while 2+ floor tags show.
 */
class Scan(private val link: Link) {
    @Volatile var on = false; private set
    @Volatile var n = 0; private set
    private var lastMs = 0L

    fun start() { n = 0; on = true; send("start") }
    fun finish() { on = false; send("done") }
    fun cancel() { on = false; send("cancel") }

    private fun send(s: String) = link.sendBig(JSONObject().put("type", "scan").put("step", s).put("t", link.pcTime()))

    /** Tag worker: a frame's colour picture (upright) with the tags found in it and its intrinsics k (as in the tags packet). */
    fun offer(bmp: Bitmap, tags: JSONArray, k: JSONArray) {
        if (!on || n >= MAX) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastMs < 500) return
        if ((0 until tags.length()).count { tags.getJSONObject(it).getInt("id") in 0..6 } < 2) return
        lastMs = now
        val h = W * bmp.height / bmp.width // keep the aspect: the PC takes square pixels
        val small = Bitmap.createScaledBitmap(bmp, W, h, true)
        val jpg = ByteArrayOutputStream().also { small.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
        link.sendBig(JSONObject().put("type", "scan").put("step", "stick").put("t", link.pcTime()).put("n", n++)
            .put("w", W).put("h", h).put("k", k).put("tags", tags).put("jpg", Base64.encodeToString(jpg, Base64.NO_WRAP)))
    }

    fun status(): String? = if (on) "SCAN: $n / $MAX pictures" + (if (n >= MAX) " (enough: tap Finish)" else " (needs 2+ green tags)")
        else link.stick?.let { "stick model on the PC: $it" }

    companion object {
        const val MAX = 40
        private const val W = 480
    }
}
