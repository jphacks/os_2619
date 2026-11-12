package jp.jphacks.sensorlink

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool

/**
 * The sound of taking a hit, played together with the torch (`flash` packets): res/raw/damage.mp3
 * (the same file as dashboard/public/audio/damage.mp3, which the dashboard's settings play to audition it).
 * SoundPool: decoded once at start, so a hit plays with no delay. Any thread.
 */
class HitSound(context: Context) {
    private val pool = SoundPool.Builder().setMaxStreams(2)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        .build()
    @Volatile private var ready = false
    private val id = pool.load(context, R.raw.damage, 1)

    init { pool.setOnLoadCompleteListener { _, s, status -> if (s == id && status == 0) ready = true } }

    fun play() { if (ready) pool.play(id, 1f, 1f, 1, 0, 1f) }

    fun release() = pool.release()
}
