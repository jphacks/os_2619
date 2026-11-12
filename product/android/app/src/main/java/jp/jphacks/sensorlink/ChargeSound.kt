package jp.jphacks.sensorlink

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.SoundPool
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * The PC's charge sound, on the phone too (`vibrate` packets with kind = charge, game.js stepBuzz): the element's loop
 * (res/raw/charge_<element>.mp3, the same files as dashboard/public/audio), looped over the same region with the same
 * crossfade, the same pitch per tier, louder as the charge fills, and the 大 sting (full_<element>) when the tier reaches 大.
 * Mirrors audio.js charge(): LOOPS, CHARGE_PITCH, MIX.charge / chargeSpan. The PC repeats the packet every 0.25 s; with no
 * repeat for LEASE_MS it stops by itself (like Vibe), so a lost PC or link cannot leave it on. Any thread.
 */
class ChargeSound(private val context: Context) {
    private class Loop(val track: AudioTrack, val rate: Int, val frames: Int, val pcm: ShortArray, val ch: Int)
    private var startedAt = 0L // elapsedRealtime when the current loop started
    private var heardAt = 0L; private var heard = 0.0 // s of the loop played up to heardAt (the pitch changes the pace)
    private var pitch = 1.0
    private var vol = 1f

    private val th = HandlerThread("chargesound").apply { start() }
    private val h = Handler(th.looper)
    private val loops = HashMap<String, Loop>() // h thread
    private var cur: String? = null
    private var tier: String? = null
    private val leaseOver = Runnable { stopNow() }
    private val stings = SoundPool.Builder().setMaxStreams(2).setAudioAttributes(ATTR).build()
    private val stingId = HashMap<String, Int>()

    init {
        for (e in ELEMENTS) stingId[e] = stings.load(context, raw("full_$e"), 1)
        h.post { for ((name, region) in LOOPS) try { loops[name] = load(name, region) } catch (e: Exception) { Log.w("SensorLink", "charge sound $name", e) } }
    }

    /** One `charge` packet: element (fire / thunder / water / wind), tier s / m / l, level 0..1. */
    fun charge(element: String, tier: String, level: Double) = h.post {
        h.removeCallbacks(leaseOver); h.postDelayed(leaseOver, LEASE_MS)
        val name = if (loops.containsKey("charge_$element")) "charge_$element" else "charge"
        val loop = loops[name] ?: return@post
        if (cur != name) { stopNow(); h.postDelayed(leaseOver, LEASE_MS); loop.track.reloadStaticData(); loop.track.setLoopPoints(0, loop.frames, -1); loop.track.play(); cur = name; this.tier = null; startedAt = SystemClock.elapsedRealtime(); heardAt = startedAt; heard = 0.0 }
        if (tier == "l" && this.tier != "l") stingId[element]?.let { stings.play(it, 1f, 1f, 1, 0, 1f) } // 大 reached
        if (tier != this.tier) { val t = SystemClock.elapsedRealtime(); heard += (t - heardAt) / 1000.0 * pitch; heardAt = t; pitch = PITCH[tier] ?: PITCH.getValue("s") }
        this.tier = tier
        loop.track.playbackRate = (loop.rate * pitch).roundToInt()
        // audio.js: db(MIX.charge + MIX.chargeSpan * level), here relative to a full charge (0 dB on the phone's speaker)
        vol = 10.0.pow(SPAN_DB * (level.coerceIn(0.0, 1.0) - 1) / 20).toFloat()
        loop.track.setVolume(vol)
    }

    /** The charge broke off (audio.js chargeFail): instead of a cut, the charge heard so far plays backwards, fast, from where
     *  the loop is now, fading to silence over FAIL_FADE s. */
    fun fail() = h.post {
        val name = cur ?: return@post
        val loop = loops[name] ?: return@post
        val t = SystemClock.elapsedRealtime()
        val sofar = heard + (t - heardAt) / 1000.0 * pitch
        val pos = loop.track.playbackHeadPosition.toLong().mod(loop.frames.toLong()).toDouble()
        stopNow()
        if (sofar < .05) return@post
        val speed = pitch * (minOf(sofar, 3.0) / FAIL_SPAN).coerceIn(FAIL_MIN, FAIL_MAX)
        val n = (FAIL_FADE * loop.rate).roundToInt(); val ch = loop.ch; val out = ShortArray(n * ch)
        for (i in 0 until n) {
            val s = (pos - i * speed).mod(loop.frames.toDouble()); val k = s.toInt(); val a = s - k; val k1 = (k + 1) % loop.frames
            val g = vol * (1 - i.toDouble() / n)
            for (c in 0 until ch) out[i * ch + c] = ((loop.pcm[k * ch + c] * (1 - a) + loop.pcm[k1 * ch + c] * a) * g).roundToInt().coerceIn(-32768, 32767).toShort()
        }
        playPcm(out, loop.rate, ch, h)
    }

    fun stop() = h.post { stopNow() }

    private fun stopNow() {
        h.removeCallbacks(leaseOver)
        cur?.let { loops[it]?.track?.stop() }
        cur = null; tier = null
    }

    fun release() = h.post { stopNow(); loops.values.forEach { it.track.release() }; loops.clear(); stings.release(); th.quitSafely() }

    private fun raw(name: String) = context.resources.getIdentifier(name, "raw", context.packageName)

    /** Decode res/raw/<name>.mp3 to 16-bit PCM, cut [a, e) s and equal-power crossfade its last x s into its head (audio.js loopBuffer). */
    private fun load(name: String, region: DoubleArray): Loop {
        val (pcm, rate, ch) = decodeRaw(context, name)
        val frames = pcm.size / ch
        val a = (region[0] * rate).roundToInt()
        val n = minOf(frames, (region[1] * rate).roundToInt()) - a
        val x = (region[2] * rate).roundToInt()
        val out = ShortArray((n - x) * ch)
        for (i in 0 until n - 2 * x) for (c in 0 until ch) out[i * ch + c] = pcm[(a + x + i) * ch + c]
        for (i in 0 until x) {
            val t = i.toDouble() / x
            for (c in 0 until ch) {
                val v = pcm[(a + n - x + i) * ch + c] * cos(t * PI / 2) + pcm[(a + i) * ch + c] * sin(t * PI / 2)
                out[(n - 2 * x + i) * ch + c] = v.roundToInt().coerceIn(-32768, 32767).toShort()
            }
        }
        val track = AudioTrack.Builder().setAudioAttributes(ATTR)
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate)
                .setChannelMask(if (ch == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(out.size * 2).build()
        track.write(out, 0, out.size)
        return Loop(track, rate, out.size / ch, out, ch)
    }

    private companion object {
        const val LEASE_MS = 1000L
        const val FAIL_FADE = .3; const val FAIL_SPAN = .35; const val FAIL_MIN = 1.8; const val FAIL_MAX = 4.0 // audio.js FAIL_REV
        const val SPAN_DB = 5.0 // audio.js MIX.chargeSpan
        val ELEMENTS = listOf("fire", "thunder", "water", "wind")
        val PITCH = mapOf("s" to .85, "m" to 1.1, "l" to 1.45) // audio.js CHARGE_PITCH
        // audio.js LOOPS: [start, end, crossfade] s
        val LOOPS = mapOf("charge" to doubleArrayOf(.2, 4.4, .35)) + ELEMENTS.associate { "charge_$it" to doubleArrayOf(.25, 4.75, .4) }
        val ATTR: AudioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
    }
}
