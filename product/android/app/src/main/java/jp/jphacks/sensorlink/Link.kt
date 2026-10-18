package jp.jphacks.sensorlink

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/**
 * One WebSocket to the PC for small, low-latency JSON packets (no picture: the PC never used it for the game).
 * Reconnects every second while enabled. On a slow link (a hotspot that carries ~50 KB/s) every byte that waits in a
 * buffer is latency, so both the app's queue and the kernel's send buffer are kept small and stale packets are dropped.
 */
class Link(private val id: String, private val name: String) {
    private val http = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).socketFactory(SmallBuffers).build()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var data: WebSocket? = null
    private var gen = 0
    private var url = ""
    private var bestRtt = Double.MAX_VALUE

    @Volatile var status = "not connected"; private set
    @Volatile var slot = "-"; private set
    /** PC clock minus phone clock, in seconds (lowest-RTT ping wins). */
    @Volatile var offset = 0.0; private set
    @Volatile var rttMs = 0.0; private set
    /** The floor sheets' marker the PC chose: "april" or "rune" (Rune.kt reads ids 0-3 then). Older servers say nothing: april. */
    @Volatile var marker = "april"; private set

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
        data?.close(1000, null)
        data = null
        status = "not connected"; slot = "-"
    }

    private fun open(g: Int) {
        status = "connecting to $url"
        data = http.newWebSocket(Request.Builder().url(url).build(), Listener(g, "phone"))
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
            status = "open, waiting for the PC" // "connected" only once the PC answers: an open socket alone proved nothing (MTU)
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
                "welcome" -> { slot = k.optString("slot", "-"); marker = k.optString("marker", "april"); status = "connected" }
                "marker" -> marker = k.optString("marker", marker)
                "full" -> status = "PC already has 2 phones"
            }
        }

        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) = retry("error: ${t.message}")
        override fun onClosed(ws: WebSocket, code: Int, reason: String) = retry("closed")

        private fun retry(why: String) {
            if (g != gen) return
            gen++
            data?.cancel()
            status = "$why, retrying"; slot = "-"
            val next = gen
            main.postDelayed({ if (next == gen) open(next) }, 1000)
        }
    }

    /**
     * Sensor packet. Dropped instead of queued if the link is backed up: stale data is useless. 4 KB is ~0.15 s of the
     * ~25 KB/s the sensors make (64 KB was 1-3 s behind on a slow hotspot, and the pings waited behind it too).
     */
    fun send(json: JSONObject) {
        val ws = data ?: return
        if (ws.queueSize() < QUEUE) ws.send(json.toString())
    }

    private companion object {
        const val QUEUE = 4 * 1024L
        const val SNDBUF = 8 * 1024 // the kernel doubles it; left alone it grows to hundreds of KB
    }

    /** Plain sockets with a small send buffer and no Nagle delay (many small packets, each wanted now). */
    private object SmallBuffers : SocketFactory() {
        private val base = SocketFactory.getDefault()
        private fun Socket.tune() = apply { sendBufferSize = SNDBUF; tcpNoDelay = true }
        override fun createSocket() = base.createSocket().tune()
        override fun createSocket(host: String, port: Int) = Socket().tune().apply { connect(InetSocketAddress(host, port)) }
        override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int) =
            Socket().tune().apply { bind(InetSocketAddress(local, localPort)); connect(InetSocketAddress(host, port)) }
        override fun createSocket(host: InetAddress, port: Int) = Socket().tune().apply { connect(InetSocketAddress(host, port)) }
        override fun createSocket(address: InetAddress, port: Int, local: InetAddress, localPort: Int) =
            Socket().tune().apply { bind(InetSocketAddress(local, localPort)); connect(InetSocketAddress(address, port)) }
    }
}
