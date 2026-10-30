import Foundation

/// RuneTag reader for the floor sheets 0-3 when the PC says marker = rune: a line-for-line port of Rune.kt, itself a port of
/// detectRunes in dashboard/public/runetag.js (the marker, its code and the method are described there; keep the three in step).
/// Plain Swift on a grey byte array. Corners are those of the virtual RUNE square (side SQUARE), in OpenCV order:
/// tag (-h,h), (h,h), (h,-h), (-h,-h).
enum Rune {
    static let SQUARE = 0.2
    static let S = 18
    private static let RINGS: [Double] = [0.108, 0.08, 0.05926]
    private static let DOT = 0.085
    static let IDS = 0...3
    private static let CODES: [[Int]] = [
        [5, 1, 6, 7, 4, 5, 3, 1, 7, 4, 3, 1, 2, 5, 4, 4, 7, 7],
        [1, 7, 6, 1, 3, 1, 4, 6, 5, 2, 4, 3, 1, 2, 4, 7, 2, 5],
        [2, 6, 6, 4, 4, 4, 3, 2, 1, 4, 2, 3, 1, 4, 1, 5, 5, 3],
        [1, 3, 4, 3, 3, 6, 7, 7, 2, 3, 6, 2, 3, 7, 5, 6, 7, 6],
    ]
    private static let K = RINGS.count
    private static let STEP = 2 * Double.pi / Double(S)
    private static let RHO = 1 / DOT

    struct Found {
        let id: Int
        let corners: [Double]
        let err: Int
        let n: Int
        let rms: Double
    }
    private struct Blob {
        let x: Double
        let y: Double
        let cov: [Double]
        let n: Int
        let a: Double
    }
    private struct Hit {
        let k: Int
        let j: Int
        let i: Int
    }
    private struct Read {
        let bits: [Int]
        let hits: [Hit]
        let known: Int
    }
    private typealias Near = (Double, Double, Double, (Int) -> Void) -> Void

    private static func slotPos(_ k: Int, _ j: Int) -> [Double] {
        let a = Double.pi / 2 - Double(j) * STEP
        return [RINGS[k] * cos(a), RINGS[k] * sin(a)]
    }

    private static func bit(_ id: Int, _ j: Int, _ k: Int) -> Int { (CODES[id][j] >> k) & 1 }

    static func detect(_ g: [UInt8], _ w: Int, _ h: Int, ids: ClosedRange<Int> = Rune.IDS) -> [Found] {
        var found = [Int: Found]()
        let m = Double(min(w, h))
        let rads = [max(4, Int((m / 40.0).rounded())), Int((m / 10.0).rounded())]
        for rad in rads {
            for f in pass(blobs(g, w, h, rad), w, h, ids) {
                if let o = found[f.id], !(f.n - 2 * f.err > o.n - 2 * o.err) { continue }
                found[f.id] = f
            }
        }
        return Array(found.values)
    }

    private static func blobs(_ g: [UInt8], _ w: Int, _ h: Int, _ rad: Int) -> [Blob] {
        let w1 = w + 1
        var ii = [Double](repeating: 0, count: w1 * (h + 1))
        for y in 0..<h {
            var row = 0.0
            for x in 0..<w {
                row += Double(g[y * w + x])
                ii[(y + 1) * w1 + x + 1] = ii[y * w1 + x + 1] + row
            }
        }
        var bin = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            let y0 = max(0, y - rad), y1 = min(h, y + rad + 1)
            for x in 0..<w {
                let x0 = max(0, x - rad), x1 = min(w, x + rad + 1)
                let n = Double((y1 - y0) * (x1 - x0))
                let sum = ii[y1 * w1 + x1] - ii[y0 * w1 + x1] - ii[y1 * w1 + x0] + ii[y0 * w1 + x0]
                // clearly darker than the neighbourhood
                bin[y * w + x] = Double(g[y * w + x]) * n < sum * 0.85 - 6.0 * n ? 1 : 0
            }
        }
        var out = [Blob]()
        var stack = [Int](repeating: 0, count: w * h)
        let maxN = w * h / 50
        for s in 0..<(w * h) {
            if bin[s] != 1 { continue }
            var top = 0, n = 0
            var sx = 0.0, sy = 0.0, sxx = 0.0, sxy = 0.0, syy = 0.0
            var edge = false
            stack[top] = s; top += 1
            bin[s] = 2
            while top > 0 {
                top -= 1
                let p = stack[top]
                let px = p % w, py = p / w
                let cx = Double(px) + 0.5, cy = Double(py) + 0.5
                n += 1; sx += cx; sy += cy; sxx += cx * cx; sxy += cx * cy; syy += cy * cy
                if px == 0 || py == 0 || px == w - 1 || py == h - 1 { edge = true }
                if px > 0 && bin[p - 1] == 1 { bin[p - 1] = 2; stack[top] = p - 1; top += 1 }
                if px < w - 1 && bin[p + 1] == 1 { bin[p + 1] = 2; stack[top] = p + 1; top += 1 }
                if py > 0 && bin[p - w] == 1 { bin[p - w] = 2; stack[top] = p - w; top += 1 }
                if py < h - 1 && bin[p + w] == 1 { bin[p + w] = 2; stack[top] = p + w; top += 1 }
            }
            if edge || n < 6 || n > maxN { continue }
            let nd = Double(n)
            let x = sx / nd, y = sy / nd
            // plus the pixel's own spread
            let cov = [sxx / nd - x * x + 1.0 / 12, sxy / nd - x * y, syy / nd - y * y + 1.0 / 12]
            let tr = cov[0] + cov[2]
            let dt = cov[0] * cov[2] - cov[1] * cov[1]
            let d = sqrt(max(0.0, tr * tr / 4 - dt))
            let l1 = tr / 2 + d, l2 = tr / 2 - d
            if !(l2 > 0) { continue }
            let fill = nd / (4 * Double.pi * sqrt(l1 * l2)) // area / area of the ellipse with the same moments
            if fill < 0.7 || fill > 1.3 || l2 / l1 < 0.04 { continue }
            out.append(Blob(x: x, y: y, cov: cov, n: n, a: 2 * sqrt(l1)))
        }
        return out
    }

    private static func pass(_ blobs: [Blob], _ w: Int, _ h: Int, _ ids: ClosedRange<Int>) -> [Found] {
        let b = blobs.sorted { $0.n > $1.n }
        let byX = b.indices.sorted { b[$0].x < b[$1].x }
        let xs = byX.map { b[$0].x }
        func lower(_ v: Double) -> Int {
            var lo = 0, hi = xs.count
            while lo < hi {
                let m = (lo + hi) / 2
                if xs[m] < v { lo = m + 1 } else { hi = m }
            }
            return lo
        }
        func near(_ x: Double, _ y: Double, _ r: Double, _ cb: (Int) -> Void) {
            var t = lower(x - r)
            while t < xs.count && xs[t] <= x + r {
                if abs(b[byX[t]].y - y) <= r { cb(byX[t]) }
                t += 1
            }
        }
        var used = [Bool](repeating: false, count: b.count)
        var out = [Found]()
        for si in 0..<min(b.count, 400) {
            if used[si] { continue }
            let s = b[si]
            let mi = sqrtSym(inv2(s.cov)).map { $0 / 2 } // whitens the seed dot to radius 1
            let reach = 2.8 * RHO * s.a
            var cand = [(Int, [Double])]()
            var t = lower(s.x - reach)
            while t < xs.count && xs[t] <= s.x + reach {
                let i = byX[t]
                let o = b[i]
                t += 1
                if i == si || used[i] || abs(o.y - s.y) > reach { continue }
                let p = mul2(mi, o.x - s.x, o.y - s.y)
                let rs = sqrt(sqrt(det2(mulT(mi, o.cov)))) * 2 // its radius in seed radii
                if rs > 0.78 && rs < 1.28 && hypot(p[0], p[1]) < 2 * RHO * 1.35 { cand.append((i, p)) }
            }
            if cand.count < 5 { continue }
            cand.sort { hypot($0.1[0], $0.1[1]) < hypot($1.1[0], $1.1[1]) }
            let cs = Array(cand.prefix(24))
            var best: [(Int, [Double])]? = nil
            for a in 0..<cs.count {
                for c in (a + 1)..<cs.count { // circle through the seed and two more
                    let pp = cs[a].1, q = cs[c].1
                    let d = 2 * (pp[0] * q[1] - pp[1] * q[0])
                    if abs(d) < 1e-9 { continue }
                    let p2 = pp[0] * pp[0] + pp[1] * pp[1], q2 = q[0] * q[0] + q[1] * q[1]
                    let cx = (p2 * q[1] - q2 * pp[1]) / d, cy = (q2 * pp[0] - p2 * q[0]) / d
                    let r = hypot(cx, cy)
                    if r < 0.7 * RHO || r > 1.4 * RHO { continue }
                    let inl = cs.filter { abs(hypot($0.1[0] - cx, $0.1[1] - cy) - r) < 0.12 * r }
                    if best == nil || inl.count > best!.count { best = inl }
                }
            }
            guard let bst = best, bst.count >= 5 else { continue }
            guard let m = readMarker(b, near, [si] + bst.map { $0.0 }, w, h, ids) else { continue }
            for i in m.1 { used[i] = true }
            out.append(m.0)
        }
        return out
    }

    private static func readMarker(_ b: [Blob], _ near: Near, _ ring: [Int], _ w: Int, _ h: Int, _ ids: ClosedRange<Int>) -> (Found, [Int])? {
        let p = ring.map { [b[$0].x, b[$0].y] }
        guard let e = fitEllipse(p) else { return nil }
        let r = sqrtSym(e.1)
        let ang = p.map { v -> [Double] in
            let q = mul2(r, v[0] - e.0[0], v[1] - e.0[1])
            return [hypot(q[0], q[1]), atan2(q[1], q[0])]
        }
        if ang.contains(where: { abs($0[0] - 1) > 0.12 }) { return nil }
        let ord = ang.indices.sorted { ang[$0][1] < ang[$1][1] }
        var sec = [Int](repeating: 0, count: p.count)
        var j = 0
        for t in 0..<ord.count { // image angles grow clockwise as seen, like the sector numbers
            sec[ord[t]] = j
            var gap = ang[ord[(t + 1) % ord.count]][1] - ang[ord[t]][1]
            if gap <= 0 { gap += 2 * Double.pi }
            let m = Int((gap / STEP).rounded())
            if m < 1 || abs(gap - Double(m) * STEP) > 0.4 * STEP { return nil }
            j += m
        }
        if j != S { return nil }
        var bestErr = 99, second = 99, bestId = -1, bestR = 0
        var bestRead: Read? = nil
        for k in 0..<K {
            guard var hm = homography(sec.map { slotPos(k, $0) }, p) else { continue }
            var read: Read? = nil
            for _ in 0..<3 {
                let rd = readSlots(b, near, hm, w, h)
                read = rd
                if rd.hits.count < 6 { break }
                guard let nh = homography(rd.hits.map { slotPos($0.k, $0.j) }, rd.hits.map { [b[$0.i].x, b[$0.i].y] }) else { break }
                hm = nh
            }
            guard let rd = read, rd.known >= 30 else { continue }
            for id in ids {
                for rr in 0..<S { // observed sector jj is the code's sector jj + rr
                    var err = 0
                    for jj in 0..<S {
                        for kk in 0..<K {
                            let v = rd.bits[kk * S + jj]
                            if v >= 0 && v != bit(id, (jj + rr) % S, kk) { err += 1 }
                        }
                    }
                    if err < bestErr {
                        second = min(second, bestErr)
                        bestErr = err; bestId = id; bestR = rr; bestRead = rd
                    } else if err < second {
                        second = err
                    }
                }
            }
        }
        guard let br = bestRead else { return nil }
        if bestErr > 7 || second < bestErr + 6 { return nil }
        // the true sector numbers from here on; read again through the refitted homography, keeping only dots where the code has one
        let fit = { (hs: [Hit]) -> [Double]? in
            homography(hs.map { slotPos($0.k, $0.j) }, hs.map { [b[$0.i].x, b[$0.i].y] })
        }
        var hits = br.hits.map { Hit(k: $0.k, j: ($0.j + bestR) % S, i: $0.i) }.filter { bit(bestId, $0.j, $0.k) == 1 }
        var err = bestErr
        for _ in 0..<2 {
            if hits.count < 8 { break }
            guard let fh = fit(hits) else { break }
            let rd = readSlots(b, near, fh, w, h)
            err = 0
            for k in 0..<K {
                for jj in 0..<S {
                    let v = rd.bits[k * S + jj]
                    if v >= 0 && v != bit(bestId, jj, k) { err += 1 }
                }
            }
            hits = rd.hits.filter { bit(bestId, $0.j, $0.k) == 1 }
        }
        if hits.count < 8 || err > 7 { return nil }
        guard let hm = fit(hits) else { return nil }
        var ss = 0.0
        for o in hits {
            let q = slotPos(o.k, o.j)
            let pr = project(hm, q[0], q[1])
            let dx = pr[0] - b[o.i].x, dy = pr[1] - b[o.i].y
            ss += dx * dx + dy * dy
        }
        let hs = SQUARE / 2
        var corners = [Double](repeating: 0, count: 8)
        let sq: [[Double]] = [[-hs, hs], [hs, hs], [hs, -hs], [-hs, -hs]]
        for (i, c) in sq.enumerated() {
            let q = project(hm, c[0], c[1])
            corners[2 * i] = q[0]
            corners[2 * i + 1] = q[1]
        }
        return (Found(id: bestId, corners: corners, err: err, n: hits.count, rms: sqrt(ss / Double(hits.count))), (br.hits + hits).map { $0.i })
    }

    /// Look for a dot at every slot through hm: bits (1 dot, 0 none, -1 unknown) and the dots it found.
    private static func readSlots(_ b: [Blob], _ near: Near, _ hm: [Double], _ w: Int, _ h: Int) -> Read {
        var bits = [Int](repeating: -1, count: S * K)
        var hits = [Hit]()
        var known = 0
        for k in 0..<K {
            for j in 0..<S {
                let xy = slotPos(k, j)
                let x = xy[0], y = xy[1]
                let c = project(hm, x, y)
                let pr = project(hm, x * (1 + DOT), y * (1 + DOT))
                let pt = project(hm, x - y * DOT, y + x * DOT)
                let er = hypot(pr[0] - c[0], pr[1] - c[1])
                let et = hypot(pt[0] - c[0], pt[1] - c[1])
                if !(c[0] > er && c[1] > er && c[0] < Double(w) - er && c[1] < Double(h) - er) || !(er + et).isFinite { continue }
                let e = sqrt(er * et)
                if e < 1.2 { continue } // too small to see: unknown, not empty
                known += 1
                bits[k * S + j] = 0
                let tol = max(1.5, 0.9 * max(er, et))
                var bi = -1
                var bd = tol
                near(c[0], c[1], tol) { i in
                    let o = b[i]
                    let d = hypot(o.x - c[0], o.y - c[1])
                    if d < bd {
                        let rb = sqrt(Double(o.n) / Double.pi)
                        if rb > 0.5 * e && rb < 2 * e + 1 { bd = d; bi = i }
                    }
                }
                if bi >= 0 {
                    bits[k * S + j] = 1
                    hits.append(Hit(k: k, j: j, i: bi))
                }
            }
        }
        return Read(bits: bits, hits: hits, known: known)
    }

    // MARK: small linear algebra (as runetag.js)

    private static func jacobi(_ a0: [[Double]]) -> ([Double], [[Double]]) {
        let n = a0.count
        var a = a0
        var v = (0..<n).map { i in (0..<n).map { $0 == i ? 1.0 : 0.0 } }
        var tot = 0.0
        for r in a { for x in r { tot += x * x } }
        for _ in 0..<50 {
            var off = 0.0
            for p in 0..<n { for q in (p + 1)..<n { off += a[p][q] * a[p][q] } }
            if off <= 1e-30 * tot { break }
            for p in 0..<n {
                for q in (p + 1)..<n {
                    if a[p][q] == 0.0 { continue }
                    let th = (a[q][q] - a[p][p]) / (2 * a[p][q])
                    let t = (th >= 0 ? 1.0 : -1.0) / (abs(th) + sqrt(th * th + 1))
                    let c = 1 / sqrt(t * t + 1), s = t * c
                    for k in 0..<n { let x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y }
                    for k in 0..<n { let x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y }
                    for k in 0..<n { let x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y }
                }
            }
        }
        return ((0..<n).map { a[$0][$0] }, v)
    }

    private static func nullVec(_ rows: [[Double]]) -> [Double] {
        let n = rows[0].count
        var m = [[Double]](repeating: [Double](repeating: 0, count: n), count: n)
        for r in rows { for i in 0..<n { for j in i..<n { m[i][j] += r[i] * r[j] } } }
        for i in 0..<n { for j in 0..<i { m[i][j] = m[j][i] } }
        let (vals, v) = jacobi(m)
        var k = 0
        for i in 1..<n where vals[i] < vals[k] { k = i }
        return (0..<n).map { v[$0][k] }
    }

    private struct Norm {
        let s: Double
        let mx: Double
        let my: Double
    }

    private static func normalizer(_ p: [[Double]]) -> Norm {
        let cnt = Double(p.count)
        let mx = p.reduce(0.0) { $0 + $1[0] } / cnt
        let my = p.reduce(0.0) { $0 + $1[1] } / cnt
        let d = p.reduce(0.0) { $0 + hypot($1[0] - mx, $1[1] - my) } / cnt
        return Norm(s: sqrt(2.0) / (d > 0 ? d : 1.0), mx: mx, my: my)
    }

    private static func mul3(_ a: [Double], _ b: [Double]) -> [Double] {
        (0..<9).map { idx in
            let i = idx / 3, j = idx % 3
            return a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]
        }
    }

    private static func homography(_ src: [[Double]], _ dst: [[Double]]) -> [Double]? {
        if src.count < 4 { return nil }
        let a = normalizer(src), bn = normalizer(dst)
        var rows = [[Double]]()
        for i in 0..<src.count {
            let x = (src[i][0] - a.mx) * a.s, y = (src[i][1] - a.my) * a.s
            let u = (dst[i][0] - bn.mx) * bn.s, v = (dst[i][1] - bn.my) * bn.s
            rows.append([-x, -y, -1.0, 0.0, 0.0, 0.0, u * x, u * y, u])
            rows.append([0.0, 0.0, 0.0, -x, -y, -1.0, v * x, v * y, v])
        }
        let hn = nullVec(rows)
        let ta = [a.s, 0.0, -a.s * a.mx, 0.0, a.s, -a.s * a.my, 0.0, 0.0, 1.0]
        let tbi = [1 / bn.s, 0.0, bn.mx, 0.0, 1 / bn.s, bn.my, 0.0, 0.0, 1.0]
        let hm = mul3(mul3(tbi, hn), ta)
        let s = hm[8] != 0.0 ? hm[8] : 1.0
        return hm.map { $0 / s }
    }

    private static func project(_ hm: [Double], _ x: Double, _ y: Double) -> [Double] {
        let w = hm[6] * x + hm[7] * y + hm[8]
        return [(hm[0] * x + hm[1] * y + hm[2]) / w, (hm[3] * x + hm[4] * y + hm[5]) / w]
    }

    /// Ellipse through points: centre and [m11, m12, m22] with (p - c)ᵀ M (p - c) = 1, or nil.
    private static func fitEllipse(_ p: [[Double]]) -> ([Double], [Double])? {
        let nz = normalizer(p)
        let v = nullVec(p.map { pt -> [Double] in
            let x = (pt[0] - nz.mx) * nz.s, y = (pt[1] - nz.my) * nz.s
            return [x * x, x * y, y * y, x, y, 1.0]
        })
        let a = v[0], b = v[1], c = v[2], d = v[3], e = v[4], f = v[5]
        let det = 4 * a * c - b * b
        if !(det > 0) { return nil }
        let x0 = (b * e - 2 * c * d) / det, y0 = (b * d - 2 * a * e) / det
        let fv = a * x0 * x0 + b * x0 * y0 + c * y0 * y0 + d * x0 + e * y0 + f
        if fv == 0.0 || fv.isNaN { return nil }
        let k = -1 / fv
        let s2 = nz.s * nz.s
        let m = [a * k * s2, b / 2 * k * s2, c * k * s2]
        if !(m[0] > 0 && m[0] * m[2] - m[1] * m[1] > 0) { return nil }
        return ([x0 / nz.s + nz.mx, y0 / nz.s + nz.my], m)
    }

    private static func sqrtSym(_ m: [Double]) -> [Double] {
        let sd = sqrt(m[0] * m[2] - m[1] * m[1])
        let t = sqrt(m[0] + m[2] + 2 * sd)
        return [(m[0] + sd) / t, m[1] / t, (m[2] + sd) / t]
    }

    private static func mul2(_ m: [Double], _ x: Double, _ y: Double) -> [Double] { [m[0] * x + m[1] * y, m[1] * x + m[2] * y] }

    private static func inv2(_ m: [Double]) -> [Double] {
        let d = m[0] * m[2] - m[1] * m[1]
        return [m[2] / d, -m[1] / d, m[0] / d]
    }

    private static func det2(_ m: [Double]) -> Double { m[0] * m[2] - m[1] * m[1] }

    /// M C Mᵀ for symmetric 2x2.
    private static func mulT(_ m: [Double], _ c: [Double]) -> [Double] {
        let x = m[0] * c[0] + m[1] * c[1], y = m[0] * c[1] + m[1] * c[2]
        let z = m[1] * c[0] + m[2] * c[1], u = m[1] * c[1] + m[2] * c[2]
        return [x * m[0] + y * m[1], x * m[1] + y * m[2], z * m[1] + u * m[2]]
    }
}
