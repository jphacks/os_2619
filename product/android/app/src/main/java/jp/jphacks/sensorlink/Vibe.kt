package jp.jphacks.sensorlink

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * The phone's vibration on the PC's word (`vibrate` packets, game.js):
 * charge = keep vibrating (the PC repeats it; with no repeat for LEASE_MS it stops by itself, so a lost PC or link cannot leave it on),
 * win = on / off 5 times, off = stop. Same timings as Vibe.swift.
 * hit() (a `flash` packet: this player took a hit) = one short, light buzz; a charge vibration resumes with the next charge packet.
 */
class Vibe(context: Context) {
    private val vibrator: Vibrator =
        if (Build.VERSION.SDK_INT >= 31) context.getSystemService(VibratorManager::class.java).defaultVibrator
        else context.getSystemService(Vibrator::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var charging = false // main thread
    private val leaseOver = Runnable { stop() }

    /** Any thread. */
    fun handle(kind: String) {
        main.post {
            when (kind) {
                "charge" -> charge()
                "win" -> win()
                "off" -> stop()
            }
        }
    }

    private fun charge() {
        main.removeCallbacks(leaseOver)
        main.postDelayed(leaseOver, LEASE_MS)
        if (charging) return
        charging = true
        vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 60_000), 0)) // repeats until cancelled
    }

    /** Any thread. */
    fun hit() {
        main.post {
            charging = false // the next charge packet (every 0.25 s) starts the charge vibration again
            vibrator.cancel()
            vibrator.vibrate(VibrationEffect.createOneShot(HIT_MS, if (vibrator.hasAmplitudeControl()) HIT_AMP else VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    private fun win() {
        stop()
        // wait 0, on, off, on, off, ... on: the waveform starts with a wait
        val timings = LongArray(PULSES * 2) { if (it == 0) 0 else if (it % 2 == 1) PULSE_ON_MS else PULSE_OFF_MS }
        vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
    }

    private fun stop() {
        main.removeCallbacks(leaseOver)
        charging = false
        vibrator.cancel()
    }

    private companion object {
        const val LEASE_MS = 1000L
        const val PULSE_ON_MS = 400L
        const val PULSE_OFF_MS = 300L
        const val PULSES = 5
        const val HIT_MS = 80L
        const val HIT_AMP = 140 // of 255: light
    }
}
