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
/// are as big as fits: their outermost points touch the area's edges (Android's HpBar the same). A long press calibrates, mid-match too.
struct HpScreen: View {
    @EnvironmentObject var model: Model
    // in units of the own bar's length, centred on 0: the opponent's (80% of the own one, both ways) above, a gap, the own one
    private static let foeR = CGRect(x: -0.4, y: -0.174, width: 0.8, height: 0.128)
    private static let mineR = CGRect(x: -0.5, y: 0.014, width: 1, height: 0.16)

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height * 0.7, info = model.hp
            // tried on the rig: a foe to the left turns it anticlockwise on the screen (clockwise as drawn, then flipped)
            let turn = atan2(sin(model.foeTurn) * model.screenUp, cos(model.foeTurn))
            ZStack(alignment: .topLeading) {
                Color.black
                Canvas { ctx, size in draw(ctx, size, info, turn) }
                    .frame(width: w, height: h)
                    .scaleEffect(x: 1, y: -1) // mirror the HP display vertically, as Android's HpBar does
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

    private func share(_ v: Double, _ m: Double) -> CGFloat { CGFloat(Swift.max(0, Swift.min(1, v / Swift.max(1, m)))) }

    private func draw(_ ctx: GraphicsContext, _ size: CGSize, _ info: HpInfo, _ turn: Double) {
        let bars = info.foeSlot != nil ? [HpScreen.foeR, HpScreen.mineR] : [HpScreen.mineR] // nil: a PC too old to say who the opponent is
        // the turned bars' exact extent: each pill is its two end circles' centres turned, plus the radius all round
        let cs = CGFloat(cos(turn)), sn = CGFloat(sin(turn))
        let big = CGFloat.greatestFiniteMagnitude
        var x0 = big, x1 = -big, y0 = big, y1 = -big
        for r in bars {
            let rad = r.height / 2, y = r.midY
            for x in [r.minX + rad, r.maxX - rad] {
                let rx = x * cs - y * sn, ry = x * sn + y * cs
                x0 = Swift.min(x0, rx - rad); x1 = Swift.max(x1, rx + rad); y0 = Swift.min(y0, ry - rad); y1 = Swift.max(y1, ry + rad)
            }
        }
        let scale = Swift.min(size.width / (x1 - x0), size.height / (y1 - y0))
        var c = ctx
        c.translateBy(x: size.width / 2 - scale * (x0 + x1) / 2, y: size.height / 2 - scale * (y0 + y1) / 2)
        c.scaleBy(x: scale, y: scale)
        c.rotate(by: .radians(turn))
        if let slot = info.foeSlot {
            bar(c, HpScreen.foeR, share(info.foeHp, info.foeMax),
                slot == "A" ? Color(red: 1, green: 0.502, blue: 0) : Color(red: 0, green: 0.749, blue: 1)) // the players' colours (field3d.js TEAM), pure #FF8000 / #00BFFF (Android the same)
        }
        let remaining = share(info.hp, info.max)
        bar(c, HpScreen.mineR, remaining,
            remaining > 0.5 ? Color(red: 0, green: 1, blue: 0) // pure colours: bright and readable when reflected in a clear file (Android the same)
            : remaining > 0.25 ? Color(red: 1, green: 1, blue: 0)
            : Color(red: 1, green: 0.502, blue: 0)) // orange #FF8000: apart from the red of the HP lost
    }

    /// the red pill (the HP lost), and the HP left filled in from the left inside the same pill (Android the same)
    private func bar(_ c: GraphicsContext, _ r: CGRect, _ remaining: CGFloat, _ color: Color) {
        let pill = Path(roundedRect: r, cornerRadius: r.height / 2)
        c.fill(pill, with: .color(Color(red: 1, green: 0, blue: 0)))
        if remaining > 0 {
            var inside = c
            inside.clip(to: pill)
            inside.fill(Path(CGRect(x: r.minX, y: r.minY, width: r.width * remaining, height: r.height)), with: .color(color))
        }
    }
}
