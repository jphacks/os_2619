package jp.jphacks.sensorlink

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Two WebSockets to the PC: one for small, low-latency JSON packets and one for JPEG video,
 * so a large frame never delays sensor data. Reconnects every second while enabled.
 */
class Link(private val id: String, private val name: String) {
    private val http = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var data: WebSocket? = null
    @Volatile private var video: WebSocket? = null
    private var gen = 0
    private var url = ""
    private var bestRtt = Double.MAX_VALUE

    @Volatile var status = "not connected"; private set
    @Volatile var slot = "-"; private set
    /** PC clock minus phone clock, in seconds (lowest-RTT ping wins). */
    @Volatile var offset = 0.0; private set
    @Volatile var rttMs = 0.0; private set

    /** Phone wall time converted to the PC clock, seconds. */
    fun pcTime(wallMs: Long = System.currentTimeMillis()) = wallMs / 1000.0 + offset

    fun connect(host: String, port: Int) {
        close()
        url = "ws://$host:$port/ws"
        bestRtt = Double.MAX_VALUE
        open(++gen)
    }

    fun close() {
        gen++
        data?.close(1000, null); video?.close(1000, null)
        data = null; video = null
        status = "not connected"; slot = "-"
    }

    private fun open(g: Int) {
        status = "connecting to $url"
        data = http.newWebSocket(Request.Builder().url(url).build(), Listener(g, "phone"))
        video = http.newWebSocket(Request.Builder().url(url).build(), Listener(g, "video"))
        pingLoop(g)
    }

    private fun pingLoop(g: Int) {
        if (g != gen) return
        data?.send("""{"type":"ping","t0":${System.currentTimeMillis() / 1000.0}}""")
        main.postDelayed({ pingLoop(g) }, 1000)
    }

    private inner class Listener(val g: Int, val role: String) : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) {
            ws.send(JSONObject().put("type", "hello").put("role", role).put("id", id).put("name", name).toString())
            if (role == "phone") status = "connected"
        }

        override fun onMessage(ws: WebSocket, text: String) {
            val k = runCatching { JSONObject(text) }.getOrNull() ?: return
            when (k.optString("type")) {
                "pong" -> {
                    val t1 = System.currentTimeMillis() / 1000.0
                    val t0 = k.getDouble("t0")
                    val rtt = t1 - t0
                    // lowest RTT gives the tightest offset; slowly forget it so drift is tracked
                    bestRtt *= 1.01
                    if (rtt <= bestRtt) { bestRtt = rtt; offset = k.getDouble("ts") - (t0 + t1) / 2 }
                    rttMs = rtt * 1000
                }
                "welcome" -> slot = k.optString("slot", "-")
                "full" -> status = "PC already has 2 phones"
            }
        }

        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) = retry("error: ${t.message}")
        override fun onClosed(ws: WebSocket, code: Int, reason: String) = retry("closed")

        private fun retry(why: String) {
            if (g != gen) return
            // drop both sockets and start over, so data and video always come back together
            gen++
            data?.cancel(); video?.cancel()
            status = "$why, retrying"; slot = "-"
            val next = gen
            main.postDelayed({ if (next == gen) open(next) }, 1000)
        }
    }

    /** Sensor packet. Dropped instead of queued if the link is backed up: stale data is useless. */
    fun send(json: JSONObject) {
        val ws = data ?: return
        if (ws.queueSize() < 64 * 1024) ws.send(json.toString())
    }

    /** True if the video socket is idle, i.e. a new frame would go out right away. */
    fun videoReady() = video?.let { it.queueSize() == 0L && status == "connected" } ?: false

    fun sendVideo(jpeg: ByteArray) { video?.send(jpeg.toByteString()) }
}
