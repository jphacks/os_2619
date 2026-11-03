package jp.jphacks.sensorlink

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * RuneTag reader for the mahoujin's 7 tags (ids 0-6) when the PC says marker = rune: a line-for-line port of detectRunes in
 * dashboard/public/runetag.js (the marker, its code and the method are described there; keep the two in step).
 * Plain Kotlin on a grey byte array, no Android or OpenCV, so the same file runs on the desktop JVM for checks.
 * Corners are those of the virtual RUNE square (side SQUARE), in OpenCV order: tag (-h,h), (h,h), (h,-h), (-h,-h).
 */
object Rune {
    const val SQUARE = 0.224
    const val S = 43
    private val RINGS = doubleArrayOf(0.12782, 0.12782 * 5 / 6, 0.12782 * 4 / 6)
    private const val DOT = 1 / 17.8
    val IDS = 0..6
    private val CODES = arrayOf(
        intArrayOf(2, 7, 7, 2, 4, 2, 2, 7, 7, 6, 1, 2, 7, 5, 3, 3, 6, 6, 6, 2, 5, 6, 5, 5, 6, 3, 7, 3, 7, 6, 4, 2, 3, 3, 5, 1, 4, 3, 7, 4, 4, 1, 3),
        intArrayOf(4, 3, 3, 6, 2, 6, 2, 4, 5, 5, 4, 1, 5, 4, 3, 3, 7, 7, 4, 4, 3, 2, 6, 3, 2, 2, 3, 5, 1, 5, 1, 4, 4, 3, 2, 1, 2, 5, 7, 2, 5, 6, 5),
        intArrayOf(2, 2, 2, 7, 5, 7, 3, 7, 1, 6, 6, 5, 4, 6, 2, 4, 3, 4, 4, 5, 2, 3, 1, 2, 3, 2, 5, 2, 5, 6, 6, 5, 1, 4, 4, 7, 2, 5, 6, 1, 3, 2, 4),
        intArrayOf(3, 6, 6, 3, 7, 3, 4, 7, 5, 1, 7, 3, 2, 3, 3, 1, 2, 1, 4, 7, 1, 7, 6, 1, 7, 4, 3, 1, 5, 1, 7, 7, 3, 1, 7, 2, 3, 5, 5, 4, 6, 2, 6),
        intArrayOf(4, 1, 1, 1, 1, 1, 4, 7, 1, 3, 3, 5, 3, 6, 5, 4, 4, 7, 6, 6, 3, 7, 1, 3, 7, 7, 3, 1, 7, 3, 6, 6, 7, 4, 4, 5, 6, 3, 5, 3, 3, 1, 7),
        intArrayOf(6, 1, 1, 1, 1, 1, 4, 2, 3, 1, 4, 3, 3, 5, 7, 7, 3, 3, 7, 6, 4, 5, 7, 4, 5, 6, 1, 2, 6, 1, 7, 6, 1, 7, 3, 1, 1, 2, 5, 1, 4, 6, 2),
        intArrayOf(2, 2, 2, 7, 5, 7, 5, 2, 6, 7, 4, 5, 3, 1, 5, 3, 6, 5, 4, 6, 7, 2, 2, 7, 2, 7, 6, 1, 3, 7, 6, 6, 4, 3, 7, 2, 1, 5, 4, 2, 1, 4, 6),
    )
    private val K = RINGS.size
    private val STEP = 2 * PI / S
    private const val RHO = 1 / DOT

    class Found(val id: Int, val corners: DoubleArray, val err: Int, val n: Int, val rms: Double)
    private class Blob(val x: Double, val y: Double, val cov: DoubleArray, val n: Int, val a: Double)
    private class Hit(val k: Int, val j: Int, val i: Int)
    private class Read(val bits: IntArray, val hits: List<Hit>, val known: Int)

    private fun slotPos(k: Int, j: Int): DoubleArray { val a = -j * STEP; return doubleArrayOf(RINGS[k] * cos(a), RINGS[k] * sin(a)) }
    private fun bit(id: Int, j: Int, k: Int) = CODES[id][j] shr k and 1

    /** ROT[id][r][k]: ring k of code id as a 43-bit word, turned so that bit j is the code's sector (j + r) % S.
     *  Comparing a read with a code is then a popcount per ring instead of 129 single-bit tests. */
    private val ROT: Array<Array<LongArray>> = Array(CODES.size) { id ->
        Array(S) { r -> LongArray(K) { k -> var m = 0L; for (j in 0 until S) if (bit(id, (j + r) % S, k) == 1) m = m or (1L shl j); m } }
    }

    fun detect(g: ByteArray, w: Int, h: Int, ids: IntRange = IDS): List<Found> {
        val found = HashMap<Int, Found>()
        val rads = intArrayOf(max(4, (min(w, h) / 40.0).roundToInt()), (min(w, h) / 10.0).roundToInt())
        // the two blob sizes are independent: read the second on another core, then merge in the same order as one after the other
        var second: List<Found> = emptyList(); var fail: Throwable? = null
        val th = Thread { try { second = pass(blobs(g, w, h, rads[1]), w, h, ids) } catch (e: Throwable) { fail = e } }.also { it.start() }
        val first = pass(blobs(g, w, h, rads[0]), w, h, ids)
        th.join(); fail?.let { throw it }
        for (fs in listOf(first, second)) for (m in fs) {
            val o = found[m.id]
            if (o == null || m.n - 2 * m.err > o.n - 2 * o.err) found[m.id] = m
        }
        return found.values.toList()
    }

    private fun blobs(g: ByteArray, w: Int, h: Int, rad: Int): List<Blob> {
        val w1 = w + 1
        val ii = DoubleArray(w1 * (h + 1))
        for (y in 0 until h) { var row = 0.0; for (x in 0 until w) { row += g[y * w + x].toInt() and 0xff; ii[(y + 1) * w1 + x + 1] = ii[y * w1 + x + 1] + row } }
        val bin = ByteArray(w * h)
        for (y in 0 until h) {
            val y0 = max(0, y - rad); val y1 = min(h, y + rad + 1)
            for (x in 0 until w) {
                val x0 = max(0, x - rad); val x1 = min(w, x + rad + 1); val n = (y1 - y0) * (x1 - x0)
                val sum = ii[y1 * w1 + x1] - ii[y0 * w1 + x1] - ii[y1 * w1 + x0] + ii[y0 * w1 + x0]
                bin[y * w + x] = if ((g[y * w + x].toInt() and 0xff).toDouble() * n < sum * .85 - 6.0 * n) 1 else 0 // clearly darker than the neighbourhood
            }
        }
        val out = ArrayList<Blob>(); val stack = IntArray(w * h); val maxN = w * h / 50
        for (s in 0 until w * h) {
            if (bin[s].toInt() != 1) continue
            var top = 0; var n = 0; var sx = 0.0; var sy = 0.0; var sxx = 0.0; var sxy = 0.0; var syy = 0.0; var edge = false
            stack[top++] = s; bin[s] = 2
            while (top > 0) {
                val p = stack[--top]; val x = p % w; val y = p / w; val cx = x + .5; val cy = y + .5
                n++; sx += cx; sy += cy; sxx += cx * cx; sxy += cx * cy; syy += cy * cy
                if (x == 0 || y == 0 || x == w - 1 || y == h - 1) edge = true
                if (x > 0 && bin[p - 1].toInt() == 1) { bin[p - 1] = 2; stack[top++] = p - 1 }
                if (x < w - 1 && bin[p + 1].toInt() == 1) { bin[p + 1] = 2; stack[top++] = p + 1 }
                if (y > 0 && bin[p - w].toInt() == 1) { bin[p - w] = 2; stack[top++] = p - w }
                if (y < h - 1 && bin[p + w].toInt() == 1) { bin[p + w] = 2; stack[top++] = p + w }
            }
            if (edge || n < 6 || n > maxN) continue
            val x = sx / n; val y = sy / n
            val cov = doubleArrayOf(sxx / n - x * x + 1.0 / 12, sxy / n - x * y, syy / n - y * y + 1.0 / 12) // + pixel's own spread
            val tr = cov[0] + cov[2]; val dt = cov[0] * cov[2] - cov[1] * cov[1]; val d = sqrt(max(0.0, tr * tr / 4 - dt))
            val l1 = tr / 2 + d; val l2 = tr / 2 - d
            if (!(l2 > 0)) continue
            val fill = n / (4 * PI * sqrt(l1 * l2)) // area / area of the ellipse with the same moments
            if (fill < .7 || fill > 1.3 || l2 / l1 < .04) continue
            out.add(Blob(x, y, cov, n, 2 * sqrt(l1)))
        }
        return out
    }

    private fun pass(blobs: List<Blob>, w: Int, h: Int, ids: IntRange): List<Found> {
        val b = blobs.sortedByDescending { it.n }
        val byX = b.indices.sortedBy { b[it].x }; val xs = DoubleArray(byX.size) { b[byX[it]].x }
        fun lower(v: Double): Int { var lo = 0; var hi = xs.size; while (lo < hi) { val m = (lo + hi) ushr 1; if (xs[m] < v) lo = m + 1 else hi = m }; return lo }
        val near: (Double, Double, Double, (Int) -> Unit) -> Unit = { x, y, r, cb ->
            var t = lower(x - r)
            while (t < xs.size && xs[t] <= x + r) { if (abs(b[byX[t]].y - y) <= r) cb(byX[t]); t++ }
        }
        val used = BooleanArray(b.size); val out = ArrayList<Found>()
        for (si in 0 until min(b.size, 400)) {
            if (used[si]) continue
            val s = b[si]; val mi = sqrtSym(inv2(s.cov)).map { it / 2 }.toDoubleArray() // whitens the seed dot to radius 1
            val reach = 2.8 * RHO * s.a
            val cand = ArrayList<Pair<Int, DoubleArray>>()
            var t = lower(s.x - reach)
            while (t < xs.size && xs[t] <= s.x + reach) {
                val i = byX[t]; val o = b[i]; t++
                if (i == si || used[i] || abs(o.y - s.y) > reach) continue
                val p = mul2(mi, o.x - s.x, o.y - s.y); val rs = sqrt(sqrt(det2(mulT(mi, o.cov)))) * 2 // its radius in seed radii
                if (rs > .78 && rs < 1.28 && hypot(p[0], p[1]) < 2 * RHO * 1.35) cand.add(i to p)
            }
            if (cand.size < 5) continue
            cand.sortBy { hypot(it.second[0], it.second[1]) }
            val cs = cand.take(24)
            var best: List<Pair<Int, DoubleArray>>? = null
            for (a in cs.indices) for (c in a + 1 until cs.size) { // circle through the seed and two more
                val pp = cs[a].second; val q = cs[c].second; val d = 2 * (pp[0] * q[1] - pp[1] * q[0]); if (abs(d) < 1e-9) continue
                val p2 = pp[0] * pp[0] + pp[1] * pp[1]; val q2 = q[0] * q[0] + q[1] * q[1]
                val cx = (p2 * q[1] - q2 * pp[1]) / d; val cy = (q2 * pp[0] - p2 * q[0]) / d; val r = hypot(cx, cy)
                if (r < .7 * RHO || r > 1.4 * RHO) continue
                val inl = cs.filter { abs(hypot(it.second[0] - cx, it.second[1] - cy) - r) < .12 * r }
                if (best == null || inl.size > best.size) best = inl
            }
            // the nearest 24 cover only an arc of a 43-sector layer: fit an ellipse through them and collect that layer's dots from every
            // candidate (the layers are >= 1/6 apart, so 0.06 keeps the neighbours out)
            for (it in 0 until 2) {
                val bb = best ?: break; if (bb.size < 4) break
                val e = fitEllipse(listOf(doubleArrayOf(0.0, 0.0)) + bb.map { o -> o.second }) ?: break
                val rr = sqrtSym(e.second)
                best = cand.filter { o -> val q = mul2(rr, o.second[0] - e.first[0], o.second[1] - e.first[1]); abs(hypot(q[0], q[1]) - 1) < .06 }
            }
            if (best == null || best.size < 5) continue
            val m = readMarker(b, near, listOf(si) + best.map { it.first }, w, h, ids) ?: continue
            for (i in m.second) used[i] = true
            out.add(m.first)
        }
        return out
    }

    private fun readMarker(b: List<Blob>, near: (Double, Double, Double, (Int) -> Unit) -> Unit, ring: List<Int>, w: Int, h: Int, ids: IntRange): Pair<Found, List<Int>>? {
        val p = ring.map { doubleArrayOf(b[it].x, b[it].y) }
        val e = fitEllipse(p) ?: return null
        val r = sqrtSym(e.second)
        val ang = p.map { val q = mul2(r, it[0] - e.first[0], it[1] - e.first[1]); doubleArrayOf(hypot(q[0], q[1]), atan2(q[1], q[0])) }
        if (ang.any { abs(it[0] - 1) > .12 }) return null
        // number the dots by the sector gaps between neighbours (image angles grow clockwise as seen): the longest run of clean gaps
        // (1-5 sectors), as perspective bends the angles too much to count all 43 round the ring. Relative numbers: decoding tries every turn
        val n = p.size; val ord = ang.indices.sortedBy { ang[it][1] }
        val gaps = DoubleArray(n) { t -> var g = ang[ord[(t + 1) % n]][1] - ang[ord[t]][1]; if (g <= 0) g += 2 * PI; g / STEP }
        val good = BooleanArray(n) { t -> val m = gaps[t].roundToInt(); m in 1..5 && abs(gaps[t] - m) <= .4 }
        var start = 0; var len = n - 1
        if (!good.all { it }) {
            len = 0
            for (t in 0 until n) if (!good[(t + n - 1) % n]) { var l = 0; while (good[(t + l) % n]) l++; if (l > len) { len = l; start = t } }
        }
        if (len < 4) return null
        val run = ArrayList<DoubleArray>(); val sec = ArrayList<Int>(); var j = 0
        for (t in 0..len) { val u = (start + t) % n; run.add(p[ord[u]]); sec.add(j); j += gaps[u].roundToInt() }
        var bestErr = 99; var second = 99; var bestId = -1; var bestR = 0; var bestRead: Read? = null
        for (k in 0 until K) {
            var hm = homography(sec.map { slotPos(k, it) }, run) ?: continue
            var read: Read? = null
            for (it in 0 until 3) {
                read = readSlots(b, near, hm, w, h)
                if (read.hits.size < 6) break
                hm = homography(read.hits.map { slotPos(it.k, it.j) }, read.hits.map { doubleArrayOf(b[it.i].x, b[it.i].y) }) ?: break
            }
            if (read == null || read.known < 30) continue
            // the read as one 43-bit word per ring: which sectors were seen, and which of those hold a dot
            val seen = LongArray(K); val dots = LongArray(K)
            for (kk in 0 until K) for (jj in 0 until S) { val v = read.bits[kk * S + jj]; if (v >= 0) seen[kk] = seen[kk] or (1L shl jj); if (v == 1) dots[kk] = dots[kk] or (1L shl jj) }
            for (id in ids) for (rr in 0 until S) { // observed sector jj is the code's sector jj + rr
                val word = ROT[id][rr]
                var err = 0
                for (kk in 0 until K) err += java.lang.Long.bitCount((dots[kk] xor word[kk]) and seen[kk])
                if (err < bestErr) { second = min(second, bestErr); bestErr = err; bestId = id; bestR = rr; bestRead = read }
                else if (err < second) second = err
            }
        }
        val br = bestRead ?: return null
        // wrong bits allowed: 1 in 8 of those seen (>= 7); any two words differ in >= 45 of 129, so a right read also wins clearly
        if (bestErr > maxErr(br.known) || second < bestErr + 8) return null
        // the true sector numbers from here on; read again through the refitted homography, keeping only dots where the code has one
        val fit = { hs: List<Hit> -> homography(hs.map { slotPos(it.k, it.j) }, hs.map { doubleArrayOf(b[it.i].x, b[it.i].y) }) }
        var hits = br.hits.map { Hit(it.k, (it.j + bestR) % S, it.i) }.filter { bit(bestId, it.j, it.k) == 1 }
        var err = bestErr; var known = br.known
        for (it in 0 until 2) {
            if (hits.size < 8) break
            val rd = readSlots(b, near, fit(hits) ?: break, w, h)
            err = 0; known = rd.known; for (k in 0 until K) for (jj in 0 until S) { val v = rd.bits[k * S + jj]; if (v >= 0 && v != bit(bestId, jj, k)) err++ }
            hits = rd.hits.filter { bit(bestId, it.j, it.k) == 1 }
        }
        if (hits.size < 8 || err > maxErr(known)) return null
        val hm = fit(hits) ?: return null
        var ss = 0.0
        for (o in hits) { val q = slotPos(o.k, o.j); val pr = project(hm, q[0], q[1]); ss += (pr[0] - b[o.i].x).let { it * it } + (pr[1] - b[o.i].y).let { it * it } }
        val hs = SQUARE / 2; val corners = DoubleArray(8)
        arrayOf(doubleArrayOf(-hs, hs), doubleArrayOf(hs, hs), doubleArrayOf(hs, -hs), doubleArrayOf(-hs, -hs)).forEachIndexed { i, c -> val q = project(hm, c[0], c[1]); corners[2 * i] = q[0]; corners[2 * i + 1] = q[1] }
        return Found(bestId, corners, err, hits.size, sqrt(ss / hits.size)) to (br.hits + hits).map { it.i }
    }

    private fun maxErr(known: Int) = max(7, known shr 3)

    /** Look for a dot at every slot through hm: bits (1 dot, 0 none, -1 unknown) and the dots it found. */
    private fun readSlots(b: List<Blob>, near: (Double, Double, Double, (Int) -> Unit) -> Unit, hm: DoubleArray, w: Int, h: Int): Read {
        val bits = IntArray(S * K) { -1 }; val hits = ArrayList<Hit>(); var known = 0
        for (k in 0 until K) for (j in 0 until S) {
            val xy = slotPos(k, j); val x = xy[0]; val y = xy[1]; val c = project(hm, x, y)
            val pr = project(hm, x * (1 + DOT), y * (1 + DOT)); val pt = project(hm, x - y * DOT, y + x * DOT)
            val er = hypot(pr[0] - c[0], pr[1] - c[1]); val et = hypot(pt[0] - c[0], pt[1] - c[1])
            if (!(c[0] > er && c[1] > er && c[0] < w - er && c[1] < h - er) || !(er + et).isFinite()) continue
            val e = sqrt(er * et)
            if (e < 1.2) continue // too small to see: unknown, not empty
            known++; bits[k * S + j] = 0
            val tol = max(1.5, .9 * max(er, et)); var bi = -1; var bd = tol
            near(c[0], c[1], tol) { i ->
                val o = b[i]; val d = hypot(o.x - c[0], o.y - c[1])
                if (d < bd) { val rb = sqrt(o.n / PI); if (rb > .5 * e && rb < 2 * e + 1) { bd = d; bi = i } }
            }
            if (bi >= 0) { bits[k * S + j] = 1; hits.add(Hit(k, j, bi)) }
        }
        return Read(bits, hits, known)
    }

    // ---- small linear algebra (as runetag.js) ----
    private fun jacobi(a0: Array<DoubleArray>): Pair<DoubleArray, Array<DoubleArray>> {
        val n = a0.size; val a = Array(n) { a0[it].clone() }; val v = Array(n) { i -> DoubleArray(n) { if (it == i) 1.0 else 0.0 } }
        var tot = 0.0; for (r in a) for (x in r) tot += x * x
        for (sweep in 0 until 50) {
            var off = 0.0; for (p in 0 until n) for (q in p + 1 until n) off += a[p][q] * a[p][q]
            if (off <= 1e-30 * tot) break
            for (p in 0 until n) for (q in p + 1 until n) {
                if (a[p][q] == 0.0) continue
                val th = (a[q][q] - a[p][p]) / (2 * a[p][q]); val t = (if (th >= 0) 1.0 else -1.0) / (abs(th) + sqrt(th * th + 1))
                val c = 1 / sqrt(t * t + 1); val s = t * c
                for (k in 0 until n) { val x = a[k][p]; val y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y }
                for (k in 0 until n) { val x = a[p][k]; val y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y }
                for (k in 0 until n) { val x = v[k][p]; val y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y }
            }
        }
        return DoubleArray(n) { a[it][it] } to v
    }
    private fun nullVec(rows: List<DoubleArray>): DoubleArray {
        val n = rows[0].size; val m = Array(n) { DoubleArray(n) }
        for (r in rows) for (i in 0 until n) for (j in i until n) m[i][j] += r[i] * r[j]
        for (i in 0 until n) for (j in 0 until i) m[i][j] = m[j][i]
        val (vals, v) = jacobi(m); var k = 0; for (i in 1 until n) if (vals[i] < vals[k]) k = i
        return DoubleArray(n) { v[it][k] }
    }
    private class Norm(val s: Double, val mx: Double, val my: Double)
    private fun normalizer(p: List<DoubleArray>): Norm {
        val mx = p.sumOf { it[0] } / p.size; val my = p.sumOf { it[1] } / p.size
        val d = p.sumOf { hypot(it[0] - mx, it[1] - my) } / p.size
        return Norm(sqrt(2.0) / (if (d > 0) d else 1.0), mx, my)
    }
    private fun mul3(a: DoubleArray, b: DoubleArray) = DoubleArray(9) { val i = it / 3; val j = it % 3; a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j] }
    private fun homography(src: List<DoubleArray>, dst: List<DoubleArray>): DoubleArray? {
        if (src.size < 4) return null
        val a = normalizer(src); val bn = normalizer(dst); val rows = ArrayList<DoubleArray>()
        for (i in src.indices) {
            val x = (src[i][0] - a.mx) * a.s; val y = (src[i][1] - a.my) * a.s; val u = (dst[i][0] - bn.mx) * bn.s; val v = (dst[i][1] - bn.my) * bn.s
            rows.add(doubleArrayOf(-x, -y, -1.0, 0.0, 0.0, 0.0, u * x, u * y, u)); rows.add(doubleArrayOf(0.0, 0.0, 0.0, -x, -y, -1.0, v * x, v * y, v))
        }
        val hn = nullVec(rows)
        val ta = doubleArrayOf(a.s, 0.0, -a.s * a.mx, 0.0, a.s, -a.s * a.my, 0.0, 0.0, 1.0)
        val tbi = doubleArrayOf(1 / bn.s, 0.0, bn.mx, 0.0, 1 / bn.s, bn.my, 0.0, 0.0, 1.0)
        val hm = mul3(mul3(tbi, hn), ta); val s = if (hm[8] != 0.0) hm[8] else 1.0
        return DoubleArray(9) { hm[it] / s }
    }
    private fun project(hm: DoubleArray, x: Double, y: Double): DoubleArray {
        val w = hm[6] * x + hm[7] * y + hm[8]
        return doubleArrayOf((hm[0] * x + hm[1] * y + hm[2]) / w, (hm[3] * x + hm[4] * y + hm[5]) / w)
    }
    /** Ellipse through points: centre and [m11, m12, m22] with (p - c)ᵀ M (p - c) = 1, or null. */
    private fun fitEllipse(p: List<DoubleArray>): Pair<DoubleArray, DoubleArray>? {
        val nz = normalizer(p)
        val v = nullVec(p.map { val x = (it[0] - nz.mx) * nz.s; val y = (it[1] - nz.my) * nz.s; doubleArrayOf(x * x, x * y, y * y, x, y, 1.0) })
        val (a, b, c, d, e) = v; val f = v[5]
        val det = 4 * a * c - b * b; if (!(det > 0)) return null
        val x0 = (b * e - 2 * c * d) / det; val y0 = (b * d - 2 * a * e) / det
        val fv = a * x0 * x0 + b * x0 * y0 + c * y0 * y0 + d * x0 + e * y0 + f
        if (fv == 0.0 || fv.isNaN()) return null
        val k = -1 / fv; val s2 = nz.s * nz.s; val m = doubleArrayOf(a * k * s2, b / 2 * k * s2, c * k * s2)
        if (!(m[0] > 0 && m[0] * m[2] - m[1] * m[1] > 0)) return null
        return doubleArrayOf(x0 / nz.s + nz.mx, y0 / nz.s + nz.my) to m
    }
    private fun sqrtSym(m: DoubleArray): DoubleArray { val sd = sqrt(m[0] * m[2] - m[1] * m[1]); val t = sqrt(m[0] + m[2] + 2 * sd); return doubleArrayOf((m[0] + sd) / t, m[1] / t, (m[2] + sd) / t) }
    private fun mul2(m: DoubleArray, x: Double, y: Double) = doubleArrayOf(m[0] * x + m[1] * y, m[1] * x + m[2] * y)
    private fun inv2(m: DoubleArray): DoubleArray { val d = m[0] * m[2] - m[1] * m[1]; return doubleArrayOf(m[2] / d, -m[1] / d, m[0] / d) }
    private fun det2(m: DoubleArray) = m[0] * m[2] - m[1] * m[1]
    private fun mulT(m: DoubleArray, c: DoubleArray): DoubleArray { // M C Mᵀ for symmetric 2x2
        val x = m[0] * c[0] + m[1] * c[1]; val y = m[0] * c[1] + m[1] * c[2]; val z = m[1] * c[0] + m[2] * c[1]; val u = m[1] * c[1] + m[2] * c[2]
        return doubleArrayOf(x * m[0] + y * m[1], x * m[1] + y * m[2], z * m[1] + u * m[2])
    }
}
