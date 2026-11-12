package jp.jphacks.sensorlink

import android.app.Activity
import android.app.AlertDialog
import android.graphics.BitmapFactory
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.net.URL

/** The elements' colours (dashboard sticks.js) and names. */
val ELEMENT_COLOR = mapOf("fire" to 0xFFFF7A1A.toInt(), "thunder" to 0xFFFFD23D.toInt(), "water" to 0xFF2F7DFF.toInt(), "wind" to 0xFFD8F4F2.toInt())
val ELEMENT_NAME = mapOf("fire" to "Fire", "thunder" to "Thunder", "water" to "Water", "wind" to "Wind")

/**
 * The Stick button: every stick saved on the PC (scanned by this phone or any other) with its scan photo, tap one to use it.
 * server.mjs answers { type: 'stickList' } with the sticks and their photos' paths (fetched over HTTP, one by one: a list of models was too
 * slow on the phones' link); { type: 'pickStick', id } puts one on this phone's slot.
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
                    addView(photo(a, link, s.optString("image").takeIf { it.startsWith("/") }), LinearLayout.LayoutParams(-1, (140 * dp).toInt()))
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

/** The stick's scan photo (GET http://<PC>/sticks/img/<id>.jpg), loaded off the UI thread at half size; "No photo" without one. */
private fun photo(a: Activity, link: Link, path: String?): View {
    if (path == null) return TextView(a).apply { text = "No photo"; gravity = Gravity.CENTER; setTextColor(Color.GRAY) }
    val v = ImageView(a).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
    Thread {
        val bmp = runCatching { URL(link.httpBase + path).openStream().use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = 2 }) } }.getOrNull()
        if (bmp != null) a.runOnUiThread { v.setImageBitmap(bmp) }
    }.start()
    return v
}
