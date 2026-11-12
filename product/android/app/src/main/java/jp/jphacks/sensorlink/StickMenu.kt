package jp.jphacks.sensorlink

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.SystemClock
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/** The elements' colours (dashboard sticks.js) and names. */
val ELEMENT_COLOR = mapOf("fire" to 0xFFFF7A1A.toInt(), "thunder" to 0xFFFFD23D.toInt(), "water" to 0xFF2F7DFF.toInt(), "wind" to 0xFFD8F4F2.toInt())
val ELEMENT_NAME = mapOf("fire" to "Fire", "thunder" to "Thunder", "water" to "Water", "wind" to "Wind")

/**
 * The Stick button: every stick saved on the PC (scanned by this phone or any other) turning slowly, tap one to use it.
 * server.mjs answers { type: 'stickList' } with the sticks and their models; { type: 'pickStick', id } puts one on this phone's slot.
 * The same menu as iOS StickMenu.swift.
 */
fun showStickMenu(a: Activity, link: Link) {
    val dp = a.resources.displayMetrics.density
    val list = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding((16 * dp).toInt(), (8 * dp).toInt(), (16 * dp).toInt(), 0) }
    fun note(t: String) { list.removeAllViews(); list.addView(TextView(a).apply { text = t; textSize = 15f; setPadding(0, (8 * dp).toInt(), 0, (8 * dp).toInt()) }) }
    val dlg = AlertDialog.Builder(a).setTitle("Sticks").setView(ScrollView(a).apply { addView(list) }).setNegativeButton("Close", null).create()
    dlg.setOnDismissListener { link.onStickList = null }
    link.onStickList = { k ->
        a.runOnUiThread {
            if (!dlg.isShowing) return@runOnUiThread
            val sticks = k.optJSONArray("sticks")
            if (sticks == null || sticks.length() == 0) return@runOnUiThread note("No sticks yet. Make one with Scan.")
            list.removeAllViews()
            for (i in 0 until sticks.length()) {
                val s = sticks.getJSONObject(i)
                val id = s.optString("id"); val name = s.optString("name"); val el = s.optString("element", "fire")
                val st = s.optJSONObject("stats"); val used = id == k.optString("current")
                list.addView(LinearLayout(a).apply {
                    orientation = LinearLayout.VERTICAL
                    setBackgroundColor(if (used) 0xFF2A3346.toInt() else 0xFF16181D.toInt())
                    setPadding((8 * dp).toInt(), (4 * dp).toInt(), (8 * dp).toInt(), (8 * dp).toInt())
                    addView(StickView(a, s.getJSONObject("model")), LinearLayout.LayoutParams(-1, (120 * dp).toInt()))
                    addView(TextView(a).apply {
                        text = "$name   ${ELEMENT_NAME[el] ?: el}   power ×%.2f  speed ×%.2f%s".format(st?.optDouble("power", 1.0) ?: 1.0, st?.optDouble("speed", 1.0) ?: 1.0, if (used) "   (in use)" else "")
                        setTextColor(ELEMENT_COLOR[el] ?: Color.WHITE); textSize = 14f
                    })
                    setOnClickListener {
                        link.send(JSONObject().put("type", "pickStick").put("id", id))
                        Toast.makeText(a, "Using $name", Toast.LENGTH_SHORT).show(); dlg.dismiss()
                    }
                }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = (8 * dp).toInt() })
            }
        }
    }
    note(if (link.status == "connected") "Asking the PC…" else "Not connected to the PC: connect with LAN first.")
    dlg.show()
    link.send(JSONObject().put("type", "stickList"))
}

/**
 * A scanned stick model (dashboard stickscan.js v 3: nodes [side, along] in m, edges, radius r [grip, tip]) turning slowly about its
 * own length, seen a little from above and from the side; grip on the left. Wood brown, lighter where it is nearer.
 */
class StickView(ctx: Context, m: JSONObject) : View(ctx) {
    private val len = m.optDouble("length", 1.0)
    private val r0 = m.optJSONArray("r")?.optDouble(0, .01) ?: .01
    private val r1 = m.optJSONArray("r")?.optDouble(1, .01) ?: .01
    private val side: DoubleArray; private val along: DoubleArray; private val edges: IntArray
    init {
        val n = m.optJSONArray("nodes"); val e = m.optJSONArray("edges")
        side = DoubleArray(n?.length() ?: 0) { n!!.getJSONArray(it).getDouble(0) }
        along = DoubleArray(side.size) { n!!.getJSONArray(it).getDouble(1) }
        edges = IntArray(2 * (e?.length() ?: 0)) { e!!.getJSONArray(it / 2).getInt(it % 2) }
    }
    private val reach = (side.maxOfOrNull { abs(it) } ?: 0.0) + r0 // how far it reaches from its axis
    private val t0 = SystemClock.uptimeMillis()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val px = DoubleArray(side.size); private val py = DoubleArray(side.size); private val pz = DoubleArray(side.size)

    private fun rAt(a: Double) = r0 + (r1 - r0) * (a / len + .5).coerceIn(0.0, 1.0)

    override fun onDraw(c: Canvas) {
        val th = (SystemClock.uptimeMillis() - t0) / 1000.0 * SPIN
        val k = min(width * .9 / len, height * .42 / reach.coerceAtLeast(.02))
        for (i in side.indices) { // turn about the length (x), then the fixed view: yaw about y, pitch about x
            val x = along[i]; val y = side[i] * cos(th); val z = side[i] * sin(th)
            val x1 = x * cos(YAW) + z * sin(YAW); val z1 = -x * sin(YAW) + z * cos(YAW)
            px[i] = x1; py[i] = y * cos(PITCH) - z1 * sin(PITCH); pz[i] = y * sin(PITCH) + z1 * cos(PITCH)
        }
        val order = (0 until edges.size / 2).sortedBy { pz[edges[2 * it]] + pz[edges[2 * it + 1]] } // far ones first
        for (j in order) {
            val i0 = edges[2 * j]; val i1 = edges[2 * j + 1]
            val near = (((pz[i0] + pz[i1]) / 2) / (len / 2)).coerceIn(-1.0, 1.0)
            val f = .85 + .3 * near
            paint.color = Color.rgb((0x9a * f).toInt().coerceAtMost(255), (0x6a * f).toInt(), (0x3e * f).toInt())
            paint.strokeWidth = (2 * k * (rAt(along[i0]) + rAt(along[i1])) / 2).toFloat().coerceAtLeast(2f)
            c.drawLine((width / 2 + px[i0] * k).toFloat(), (height / 2 - py[i0] * k).toFloat(), (width / 2 + px[i1] * k).toFloat(), (height / 2 - py[i1] * k).toFloat(), paint)
        }
        postInvalidateOnAnimation()
    }

    private companion object { const val SPIN = .7; const val YAW = .25; const val PITCH = .3 } // rad / s; the view's fixed turn, rad
}
