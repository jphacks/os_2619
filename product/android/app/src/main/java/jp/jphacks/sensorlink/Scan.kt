package jp.jphacks.sensorlink

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Stick scan: pictures of the stick lying on the mahoujin, each with the tags seen in it, to the PC as
 * { type: "scan", step: "start" | "stick" | "done" | "cancel", n, w, h, k, tags, jpg }. The dashboard builds the 3D shape (stickscan.js)
 * and the server answers { type: "stick" } (Link.stick). A picture is kept every 0.5 s while 2+ floor tags show.
 * Each finished scan is also saved on the phone (dir: scan-<time>-<pictures>.jsonl, a picture packet per line) and can be sent to the
 * PC again later (resend): when the PC was not connected, or to build the model again.
 */
class Scan(private val link: Link, private val dir: File) {
    @Volatile var on = false; private set
    @Volatile var n = 0; private set
    private var lastMs = 0L
    private val pics = mutableListOf<String>() // this scan's picture packets, saved by finish()

    fun start() { n = 0; synchronized(pics) { pics.clear() }; on = true; send("start") }
    /** Ends the scan: the pictures saved on the phone, "done" to the PC (false: not connected). */
    fun finish(): Boolean { on = false; save(); return send("done") }
    fun cancel() { on = false; synchronized(pics) { pics.clear() }; send("cancel") }

    private fun send(s: String) = link.sendBig(JSONObject().put("type", "scan").put("step", s).put("t", link.pcTime()))

    private fun save() {
        val list = synchronized(pics) { pics.toList().also { pics.clear() } }
        if (list.isEmpty()) return
        dir.mkdirs()
        File(dir, "scan-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())}-${list.size}.jsonl").writeText(list.joinToString("\n"))
    }

    /** The saved scans, newest first. */
    fun saved(): List<File> = dir.listFiles { f -> f.name.endsWith(".jsonl") }?.sortedByDescending { it.name } ?: emptyList()

    /** "2026-11-12 16:54, 40 pictures" from a saved scan's file name. */
    fun label(f: File): String = Regex("scan-(\\d{4})(\\d\\d)(\\d\\d)-(\\d\\d)(\\d\\d)\\d\\d-(\\d+)").find(f.name)?.destructured
        ?.let { (y, mo, d, h, mi, c) -> "$y-$mo-$d $h:$mi, $c pictures" } ?: f.name

    /** A saved scan to the PC again, as if just taken: start, its pictures, done. False if not sent (scanning now, or no PC). */
    fun resend(f: File): Boolean {
        if (on || !send("start")) return false
        f.readLines().filter { it.isNotBlank() }.forEach { link.sendBig(JSONObject(it)) }
        return send("done")
    }

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
        val p = JSONObject().put("type", "scan").put("step", "stick").put("t", link.pcTime()).put("n", n++)
            .put("w", W).put("h", h).put("k", k).put("tags", tags).put("jpg", Base64.encodeToString(jpg, Base64.NO_WRAP))
        synchronized(pics) { pics += p.toString() }
        link.sendBig(p)
    }

    fun status(): String? = if (on) "SCAN: $n / $MAX pictures" + (if (n >= MAX) " (enough: tap Finish)" else " (needs 2+ green tags)")
        else link.stick?.let { "stick model on the PC: $it" }

    companion object {
        const val MAX = 40
        private const val W = 480
    }
}
