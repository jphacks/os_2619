package jp.jphacks.sensorlink

import android.app.Activity
import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import kotlin.system.exitProcess

/** Catches any uncaught exception, saves it to crash.txt and shows it in CrashActivity (separate process) so a launch crash is readable on the device. */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Log.i("SensorLink", "App.onCreate sdk=${Build.VERSION.SDK_INT} model=${Build.MODEL} abis=${Build.SUPPORTED_ABIS.joinToString()}")
        val old = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                val text = "thread=${t.name}\nsdk=${Build.VERSION.SDK_INT} model=${Build.MODEL} abis=${Build.SUPPORTED_ABIS.joinToString()}\n\n${Log.getStackTraceString(e)}"
                Log.e("SensorLink", "FATAL\n$text")
                File(filesDir, "crash.txt").writeText(text)
                startActivity(Intent(this, CrashActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            } catch (_: Throwable) {
            }
            if (t.name != "main" || old == null) { exitProcess(10) } else { Thread.sleep(500); old.uncaughtException(t, e) }
        }
    }
}

class CrashActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val text = try { File(filesDir, "crash.txt").readText() } catch (e: Exception) { "no crash.txt: $e" }
        val tv = TextView(this).apply { this.text = text; textSize = 11f; setTextIsSelectable(true); setPadding(24, 24, 24, 24) }
        val copy = Button(this).apply {
            this.text = "Copy crash log"
            setOnClickListener {
                (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("crash", text))
                Toast.makeText(this@CrashActivity, "Copied", Toast.LENGTH_SHORT).show()
            }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(copy)
            addView(ScrollView(this@CrashActivity).apply { addView(tv) })
        })
    }
}
