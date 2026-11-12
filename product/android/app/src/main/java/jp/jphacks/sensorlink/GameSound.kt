package jp.jphacks.sensorlink

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import org.json.JSONArray
import java.nio.ByteOrder
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * The game's sounds that concern this player (`sfx` packets, dashboard app.js phoneSound): their shot / 大, their guard and
 * reflect, a hit they took or landed. Each voice says which file (res/raw, the same files as dashboard/public/audio) and how
 * the PC plays it (audio.js voice): gain, rate, offset, dur + rel (a release), fade [from, silent at]. The voice is rendered
 * into PCM here exactly so and played once. Files are decoded once at start. Any thread.
 */
class GameSound(private val context: Context) {
    private class Pcm(val data: ShortArray, val rate: Int, val ch: Int)

    private val th = HandlerThread("gamesound").apply { start() }
    private val h = Handler(th.looper)
    private val pcm = HashMap<String, Pcm>() // h thread

    init {
        h.post { for (f in FILES) try { decodeRaw(context, f).let { (d, r, c) -> pcm[f] = Pcm(d, r, c) } } catch (e: Exception) { Log.w("SensorLink", "game sound $f", e) } }
    }

    /** One `sfx` packet's voices: [{ file, gain, rate, offset, dur, rel, fade }]. */
    fun play(voices: JSONArray) = h.post {
        for (i in 0 until voices.length()) {
            val v = voices.optJSONObject(i) ?: continue
            val p = pcm[v.optString("file")] ?: continue
            val fade = v.optJSONArray("fade")?.let { doubleArrayOf(it.optDouble(0), it.optDouble(1)) }
            playPcm(render(p, v.optDouble("gain", 1.0), v.optDouble("rate", 1.0), v.optDouble("offset", 0.0), v.optDouble("dur", 0.0), v.optDouble("rel", .25), fade), p.rate, p.ch, h)
        }
    }

    fun release() = h.post { pcm.clear(); th.quitSafely() }

    /** audio.js voice(): from `offset` s, at `rate`, a 1 ms fade-in; after `dur` s an exponential release (time constant rel / 4,
     *  cut at rel × 1.5); `fade` = a linear fade from fade[0] s to silence at fade[1] s (times on the played sound). */
    private fun render(p: Pcm, gain: Double, rate: Double, offset: Double, dur: Double, rel: Double, fade: DoubleArray?): ShortArray {
        val frames = p.data.size / p.ch
        val len = (frames / p.rate.toDouble() - offset) / rate
        var end = len
        if (dur > 0 && dur < len) end = minOf(end, dur + rel * 1.5)
        if (fade != null && fade[0] < len) end = minOf(end, fade[1])
        val n = (end * p.rate).roundToInt().coerceAtLeast(0)
        val out = ShortArray(n * p.ch)
        for (i in 0 until n) {
            val t = i / p.rate.toDouble()
            var g = gain * minOf(1.0, t / .001)
            if (dur > 0 && dur < len && t > dur) g *= exp(-(t - dur) / (rel / 4))
            if (fade != null && fade[0] < len && t > fade[0]) g *= maxOf(0.0, 1 - (t - fade[0]) / (fade[1] - fade[0]))
            val s = (offset + t * rate) * p.rate
            val k = floor(s).toInt()
            val a = s - k
            if (k + 1 >= frames) break
            for (c in 0 until p.ch) {
                val x = p.data[k * p.ch + c] * (1 - a) + p.data[(k + 1) * p.ch + c] * a
                out[i * p.ch + c] = (x * g).roundToInt().coerceIn(-32768, 32767).toShort()
            }
        }
        return out
    }

    private companion object {
        val FILES = listOf("fire", "lightning", "water", "wind").flatMap { e -> (1..3).map { "$e$it" } } + listOf("guard", "guard_reflect", "swing") // swing: the sword swing (dashboard swing-sense.js)
    }
}

val SOUND_ATTR: AudioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()

/** Plays rendered 16-bit PCM once (a static AudioTrack, released on `h` once it has played). */
fun playPcm(out: ShortArray, rate: Int, ch: Int, h: Handler) {
    if (out.isEmpty()) return
    try {
        val track = AudioTrack.Builder().setAudioAttributes(SOUND_ATTR)
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate)
                .setChannelMask(if (ch == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(out.size * 2).build()
        track.write(out, 0, out.size)
        track.play()
        h.postDelayed({ track.stop(); track.release() }, (out.size / ch) * 1000L / rate + 200)
    } catch (e: Exception) { Log.w("SensorLink", "play pcm", e) }
}

/** Decode res/raw/<name> (mp3 / wav) to interleaved 16-bit PCM: (samples, sample rate, channels). */
fun decodeRaw(context: Context, name: String): Triple<ShortArray, Int, Int> {
    val ex = MediaExtractor()
    context.resources.openRawResourceFd(context.resources.getIdentifier(name, "raw", context.packageName)).use { ex.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
    ex.selectTrack(0)
    val fmt = ex.getTrackFormat(0)
    var rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE); var ch = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    val codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
    codec.configure(fmt, null, null, 0); codec.start()
    val chunks = ArrayList<ShortArray>(); val info = MediaCodec.BufferInfo()
    var inDone = false
    while (true) {
        if (!inDone) {
            val i = codec.dequeueInputBuffer(10_000)
            if (i >= 0) {
                val n = ex.readSampleData(codec.getInputBuffer(i)!!, 0)
                if (n < 0) { codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true }
                else { codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0); ex.advance() }
            }
        }
        val o = codec.dequeueOutputBuffer(info, 10_000)
        if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            codec.outputFormat.let { rate = it.getInteger(MediaFormat.KEY_SAMPLE_RATE); ch = it.getInteger(MediaFormat.KEY_CHANNEL_COUNT) }
        } else if (o >= 0) {
            val b = codec.getOutputBuffer(o)!!.order(ByteOrder.nativeOrder()).asShortBuffer()
            chunks.add(ShortArray(b.remaining()).also { b.get(it) })
            codec.releaseOutputBuffer(o, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
        }
    }
    codec.stop(); codec.release(); ex.release()
    val pcm = ShortArray(chunks.sumOf { it.size }); var k = 0
    for (c in chunks) { c.copyInto(pcm, k); k += c.size }
    return Triple(pcm, rate, ch)
}
