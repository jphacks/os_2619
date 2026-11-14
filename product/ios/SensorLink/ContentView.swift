import SwiftUI

/// Camera picture with the detected tags drawn on top, the status lines, and the buttons (IMU / Calibrate / LAN / Scan / Stick / HP).
struct ContentView: View {
    @EnvironmentObject var model: Model
    @State private var showImu = false
    @State private var showLan = false
    @State private var showScan = false
    @State private var showSaved = false
    @State private var showSticks = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraView().ignoresSafeArea()
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(model.lines.enumerated()), id: \.offset) { _, s in
                    Text(s)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(.white)
                        .shadow(color: .black, radius: 2)
                }
                if model.preview == nil {
                    Text("starting camera…").foregroundColor(.white)
                }
                Spacer()
                if let t = model.toast {
                    Text(t)
                        .padding(8)
                        .background(Color.black.opacity(0.7))
                        .cornerRadius(8)
                        .frame(maxWidth: .infinity)
                }
                HStack(spacing: 8) {
                    Button("IMU") { showImu = true }
                    Button("Calibrate") { model.calibrate() }
                    Button("LAN") { showLan = true }
                    Button(model.scanning ? "Finish" : "Scan") { showScan = true }
                    Button("Stick") { showSticks = true }
                    Button("HP") { model.openHp() }
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(Color.black.opacity(0.6))
            }
            .padding(.horizontal, 8)
            if model.hpOpen { HpScreen().environmentObject(model) }
            Color(red: 1, green: 0, blue: 0).opacity(model.hitRed).ignoresSafeArea().allowsHitTesting(false) // a hit: pure #FF0000 blinking, over everything, buttons too (the HP screen as well)
        }
        .sheet(isPresented: $showImu) { ImuSheet().environmentObject(model) }
        .sheet(isPresented: $showLan) { LanSheet().environmentObject(model) }
        .sheet(isPresented: $showSaved) { SavedScansSheet().environmentObject(model) }
        .sheet(isPresented: $showSticks) { StickSheet().environmentObject(model) }
        .alert(model.scanning ? "Finish the scan?" : "Scan the stick", isPresented: $showScan) {
            if model.scanning {
                Button("Send to PC") { model.scanFinish() }
                Button("Cancel scan", role: .destructive) { model.scanCancel() }
                Button("Keep scanning", role: .cancel) {}
            } else {
                Button("Start") { model.scanStart() }
                Button("Saved (\(model.scan.saved().count))") { showSaved = true }
                Button("Cancel", role: .cancel) {}
            }
        } message: { Text(scanMessage) }
    }

    // The stick scan (Scan.swift; the same words as the Android app)
    private var scanMessage: String {
        if model.scanning { return "\(model.scan.count) pictures. The PC needs 6 at least; more angles give a better shape. They are also saved on this phone." }
        return "The PC turns photos into a 3D model of your stick's shape. Open the PC dashboard first (connection screen).\n\n" +
            "1. Lay the magic circle flat and lay the stick straight across its middle, its GRIP (handle) end toward tag T0 (id 0).\n" +
            "2. Keep anything else that is not black or white off the circle (hands, feet, bags). Don't move the circle or the stick from now on.\n" +
            "3. Tap Start and walk slowly around it twice, 0.8-1.2 m away: once high, looking down, and once low, about 30° above the floor. " +
            "A photo is taken every half second while 2 or more tags show green; get the whole stick in the picture.\n" +
            "4. Tap Finish (after about 30 pictures). The model appears on the PC's connection screen and in the game."
    }
}

struct CameraView: View {
    @EnvironmentObject var model: Model

    var body: some View {
        GeometryReader { geo in
            if let img = model.preview {
                let fit = fitted(img.size, in: geo.size)
                ZStack(alignment: .topLeading) {
                    Image(uiImage: img)
                        .resizable()
                        .frame(width: fit.width, height: fit.height)
                    Canvas { ctx, _ in
                        for m in model.marks where m.corners.count == 4 {
                            var path = Path()
                            for (j, c) in m.corners.enumerated() {
                                let pt = CGPoint(x: c[0] * fit.width, y: c[1] * fit.height)
                                if j == 0 { path.move(to: pt) } else { path.addLine(to: pt) }
                            }
                            path.closeSubpath()
                            ctx.stroke(path, with: .color(.green), lineWidth: 3)
                            let label = "id \(m.id)" + (m.distance.map { String(format: " %.2fm", $0) } ?? "")
                            ctx.draw(Text(label).font(.system(size: 14)).foregroundColor(.white),
                                     at: CGPoint(x: m.corners[0][0] * fit.width + 24, y: m.corners[0][1] * fit.height - 10))
                        }
                    }
                    .frame(width: fit.width, height: fit.height)
                }
                .frame(width: fit.width, height: fit.height)
                .position(x: geo.size.width / 2, y: geo.size.height / 2)
            }
        }
    }

    private func fitted(_ s: CGSize, in box: CGSize) -> CGSize {
        let k = min(box.width / s.width, box.height / s.height)
        return CGSize(width: s.width * k, height: s.height * k)
    }
}

struct ImuSheet: View {
    @EnvironmentObject var model: Model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                Section(header: Text("Scanning (WitMotion names start with WT)")) {
                    ForEach(model.found) { d in
                        Button("\(d.name)   \(d.id.uuidString.prefix(8))") {
                            model.pickImu(d.id)
                            dismiss()
                        }
                    }
                }
                Section {
                    Button("Disconnect", role: .destructive) { model.forgetImu(); dismiss() }
                }
            }
            .navigationTitle("Pair IMU")
            .navigationBarItems(trailing: Button("Close") { dismiss() })
        }
        .onAppear { model.scanImu() }
        .onDisappear { model.stopScan() }
    }
}

/// The scans saved on this phone (Scan.saved): tap one to send it to the PC again, swipe to delete (the same as Android's Saved).
struct SavedScansSheet: View {
    @EnvironmentObject var model: Model
    @Environment(\.dismiss) private var dismiss
    @State private var files: [URL] = []

    var body: some View {
        NavigationView {
            List {
                Section(footer: Text("Tap one to send it to the PC again; swipe left to delete.")) {
                    if files.isEmpty { Text("No saved scans yet") }
                    ForEach(files, id: \.self) { u in
                        Button(model.scan.label(u)) { model.resendScan(u); dismiss() }
                    }
                    .onDelete { idx in
                        for i in idx { try? FileManager.default.removeItem(at: files[i]) }
                        files = model.scan.saved()
                    }
                }
            }
            .navigationTitle("Saved scans")
            .navigationBarItems(trailing: Button("Close") { dismiss() })
            .onAppear { files = model.scan.saved() }
        }
    }
}

struct LanSheet: View {
    @EnvironmentObject var model: Model
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var port = ""

    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("\(model.link.status)  slot \(model.link.slot)")) {
                    TextField("PC IP address", text: $host)
                        .keyboardType(.numbersAndPunctuation)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                    TextField("port", text: $port).keyboardType(.numberPad)
                }
                Button("Connect / reconnect") {
                    guard let p = Int(port), (1...65535).contains(p), !host.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                    model.connectLan(host: host.trimmingCharacters(in: .whitespaces), port: p)
                    dismiss()
                }
                Button("Disconnect", role: .destructive) { model.disconnectLan(); dismiss() }
            }
            .navigationTitle("LAN connection")
            .navigationBarItems(trailing: Button("Close") { dismiss() })
        }
        .onAppear { host = model.host; port = String(model.port) }
    }
}

/// The HP screen (match mode), on black and at full brightness: two pill-shaped bars (ends fully rounded), no pictures, in the
/// top 70%, mirrored vertically to match Android. The opponent's is 80% of the own one both ways. The player looks at the
/// opponent (in the acrylic's reflection), the chest and its phone are turned foeYaw off that (Model.foeTurn): the bars turn
/// by that turn as seen on the tilted screen (a turn about the vertical shows on it times how much the screen faces up) and
/// are as big as fits: their outermost points touch the area's edges (Android's HpBar the same). Each bar: a white outline, a little
/// gap, the HP left filled from the left with a light running across it; green, yellow at half, blinking red at a quarter, and a big
/// warning sign (yellow triangle, black !) at a tenth. Instead, as big as fits: 3, 2, 1 in the countdown, FULLSTICK! as the fight
/// starts, YOU WIN / YOU LOSE when it is over, turned like the bars. A long press calibrates, mid-match too.
struct HpScreen: View {
    @EnvironmentObject var model: Model
    // in units of the own bar's length, centred on 0: the opponent's (80% of the own one, both ways) above, a gap, the own one
    private static let foeR = CGRect(x: -0.4, y: -0.174, width: 0.8, height: 0.128)
    private static let mineR = CGRect(x: -0.5, y: 0.014, width: 1, height: 0.16)
    private static let line: CGFloat = 0.07, pad: CGFloat = 0.09 // the outline's width and the gap inside it, x the bar's height
    private static let shine = 1.4, shineW: CGFloat = 0.25 // the light: seconds per crossing, its width x the inner pill's length
    private static let signH: CGFloat = 1.5, signR = HpScreen.signH / sqrt(3) + 0.1 // the warning sign's height, and a circle round it (the fit keeps room for it), x the bar's height
    private static let goS = 1.2 // FULLSTICK! shows this long as the fight starts, s

    /// how many bars show the warning sign (a tenth of the HP or less)
    static func warns(_ i: HpInfo) -> Int {
        [i.hp / Swift.max(1, i.max), i.foeSlot != nil ? i.foeHp / Swift.max(1, i.foeMax) : nil].compactMap { $0 }.filter { $0 <= 0.1 }.count
    }

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height * 0.7, info = model.hp
            // tried on the rig: a foe to the left turns it anticlockwise on the screen (clockwise as drawn, then flipped)
            let turn = atan2(sin(model.foeTurn) * model.screenUp, cos(model.foeTurn))
            ZStack(alignment: .topLeading) {
                Color.black
                TimelineView(.animation) { tl in
                    let t = tl.date.timeIntervalSinceReferenceDate, since = tl.date.timeIntervalSince(model.phaseAt)
                    Group {
                        if info.result == "win" || info.result == "lose" { words(["YOU", info.result == "win" ? "WIN" : "LOSE"], turn, w, h) }
                        else if model.matchPhase == "countdown" { words(["\(Swift.max(1, 3 - Int(since)))"], turn, w, h) } // the dashboard's countdown is 3 s
                        else if model.matchPhase == "fight" && since < HpScreen.goS { words(["FULLSTICK!"], turn, w, h) }
                        else { Canvas { ctx, size in draw(ctx, size, info, turn, t) } }
                    }
                    .frame(width: w, height: h)
                    .scaleEffect(x: 1, y: -1) // mirror the HP display vertically, as Android's HpBar does
                }
                if model.matchPhase != "countdown" && model.matchPhase != "fight" {
                    VStack {
                        Spacer()
                        Button("Close") { model.closeHp() }
                            .foregroundColor(.gray)
                            .padding(.bottom, 24)
                    }
                    .frame(width: w, height: g.size.height)
                }
            }
            .contentShape(Rectangle())
            .onLongPressGesture(minimumDuration: 0.5) { model.calibrate(); UIImpactFeedbackGenerator(style: .heavy).impactOccurred() }
        }
        .ignoresSafeArea()
    }

    /// white bold lines, turned by `turn` like the bars and as big as fits w x h (the turned block's corners touch its edges), centred
    /// (Android's drawWords the same)
    private func words(_ lines: [String], _ turn: Double, _ w: CGFloat, _ h: CGFloat) -> some View {
        let f = UIFont.systemFont(ofSize: 100, weight: .black)
        let tw = lines.map { ($0 as NSString).size(withAttributes: [.font: f]).width }.max() ?? 1, th = CGFloat(lines.count) * f.lineHeight
        let cs = CGFloat(abs(cos(turn))), sn = CGFloat(abs(sin(turn)))
        let size = 100 * Swift.min(w / (tw * cs + th * sn), h / (tw * sn + th * cs)) * 0.98 // a hair under: SwiftUI's lines are a little taller
        return Text(lines.joined(separator: "\n")).font(.system(size: size, weight: .black)).foregroundColor(.white)
            .multilineTextAlignment(.center).lineLimit(lines.count).fixedSize()
            .rotationEffect(.radians(turn)).frame(width: w, height: h)
    }

    private func share(_ v: Double, _ m: Double) -> CGFloat { CGFloat(Swift.max(0, Swift.min(1, v / Swift.max(1, m)))) }

    private func draw(_ ctx: GraphicsContext, _ size: CGSize, _ info: HpInfo, _ turn: Double, _ t: Double) {
        let bars = info.foeSlot != nil ? [HpScreen.foeR, HpScreen.mineR] : [HpScreen.mineR] // nil: a PC too old to say who the opponent is
        // the turned bars' exact extent: each pill is its two end circles' centres turned, plus the radius all round; and the warning
        // sign's circle round the bar's middle (always: the bars keep their size when it shows)
        let cs = CGFloat(cos(turn)), sn = CGFloat(sin(turn))
        let big = CGFloat.greatestFiniteMagnitude
        var x0 = big, x1 = -big, y0 = big, y1 = -big
        for r in bars {
            let rad = r.height / 2, y = r.midY
            for (x, rr) in [(r.minX + rad, rad), (r.maxX - rad, rad), (r.midX, HpScreen.signR * r.height)] {
                let rx = x * cs - y * sn, ry = x * sn + y * cs
                x0 = Swift.min(x0, rx - rr); x1 = Swift.max(x1, rx + rr); y0 = Swift.min(y0, ry - rr); y1 = Swift.max(y1, ry + rr)
            }
        }
        let scale = Swift.min(size.width / (x1 - x0), size.height / (y1 - y0))
        var c = ctx
        c.translateBy(x: size.width / 2 - scale * (x0 + x1) / 2, y: size.height / 2 - scale * (y0 + y1) / 2)
        c.scaleBy(x: scale, y: scale)
        c.rotate(by: .radians(turn))
        if info.foeSlot != nil { bar(c, HpScreen.foeR, share(info.foeHp, info.foeMax), t) }
        bar(c, HpScreen.mineR, share(info.hp, info.max), t)
    }

    /// the white outline, the HP left inside it from the left (nothing where it was lost), the light, the warning sign (Android the same)
    private func bar(_ c: GraphicsContext, _ r: CGRect, _ s: CGFloat, _ t: Double) {
        let bh = r.height, lw = HpScreen.line * bh, pad = HpScreen.pad * bh
        let o = r.insetBy(dx: lw / 2, dy: lw / 2)
        c.stroke(Path(roundedRect: o, cornerRadius: o.height / 2), with: .color(.white), lineWidth: lw)
        let inner = r.insetBy(dx: lw + pad, dy: lw + pad)
        let color = s > 0.5 ? Color(red: 0, green: 1, blue: 0) // pure colours: bright and readable when reflected in a clear file (Android the same)
            : s > 0.25 ? Color(red: 1, green: 1, blue: 0)
            : (t * 2).truncatingRemainder(dividingBy: 1) < 0.5 ? Color(red: 1, green: 0, blue: 0) // a pinch: red, blinking twice a second
            : Color(red: 1, green: 0, blue: 0).opacity(0.25)
        if s > 0 {
            var inside = c
            inside.clip(to: Path(roundedRect: inner, cornerRadius: inner.height / 2))
            let fill = Path(CGRect(x: inner.minX, y: inner.minY, width: inner.width * s, height: inner.height))
            inside.fill(fill, with: .color(color))
            // the light: a soft white band crossing the inner pill's length every `shine` s, left to right, only over the HP left
            let x = inner.minX - HpScreen.shineW * inner.width + CGFloat((t / HpScreen.shine).truncatingRemainder(dividingBy: 1)) * (1 + HpScreen.shineW) * inner.width
            inside.fill(fill, with: .linearGradient(Gradient(colors: [.white.opacity(0), .white.opacity(0.6), .white.opacity(0)]),
                                                    startPoint: CGPoint(x: x, y: 0), endPoint: CGPoint(x: x + HpScreen.shineW * inner.width, y: 0)))
        }
        if s <= 0.1 { sign(c, CGPoint(x: r.midX, y: r.midY), HpScreen.signH * bh) }
    }

    /// a warning sign of height hh centred on p: a yellow triangle with rounded corners, a black ! (Android the same)
    private func sign(_ c: GraphicsContext, _ p: CGPoint, _ hh: CGFloat) {
        let hw = hh / sqrt(3)
        var tri = Path()
        tri.move(to: CGPoint(x: p.x, y: p.y - hh / 2)); tri.addLine(to: CGPoint(x: p.x + hw, y: p.y + hh / 2)); tri.addLine(to: CGPoint(x: p.x - hw, y: p.y + hh / 2)); tri.closeSubpath()
        let yellow = Color(red: 1, green: 1, blue: 0)
        c.fill(tri, with: .color(yellow))
        c.stroke(tri, with: .color(yellow), style: StrokeStyle(lineWidth: 0.12 * hh, lineJoin: .round))
        let bw = 0.07 * hh
        c.fill(Path(roundedRect: CGRect(x: p.x - bw, y: p.y - 0.2 * hh, width: 2 * bw, height: 0.42 * hh), cornerRadius: bw), with: .color(.black))
        c.fill(Path(ellipseIn: CGRect(x: p.x - 1.1 * bw, y: p.y + 0.36 * hh - 1.1 * bw, width: 2.2 * bw, height: 2.2 * bw)), with: .color(.black))
    }
}
