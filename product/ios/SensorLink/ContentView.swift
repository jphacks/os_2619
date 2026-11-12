import SwiftUI

/// Camera picture with the detected tags drawn on top, the status lines, and the three buttons (IMU / Calibrate / LAN).
struct ContentView: View {
    @EnvironmentObject var model: Model
    @State private var showImu = false
    @State private var showLan = false
    @State private var showScan = false
    @State private var showSaved = false

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

/// The HP screen (match mode), on black, at full brightness while it is up (Model.openHp); the same as Android's HpBar. The top half:
/// above, the opponent's picture and beside it a plain bar, round at both ends, in the opponent's colour, the two shrinking toward the
/// top centre as the opponent goes away (drawn size ∝ 1 / distance, as in perspective); below, a small "あなた" and this player's bar
/// across the whole width, raised (a darker base under it, shaded top to bottom, a gloss, a bevelled rim) and cut into ten. A small Close at the bottom.
struct HpScreen: View {
    @EnvironmentObject var model: Model
    static let refDist = 1.2 // m: this near or nearer, the opponent at full size (the players start 2.4 m apart: half size)
    static let far: CGFloat = 0.3 // the smallest it gets

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height / 2, info = model.hp
            ZStack(alignment: .topLeading) {
                Color.black
                if let slot = info.foeSlot { // nil: a PC too old to say who the opponent is
                    foe(info, slot: slot, w: w, h: h)
                        .frame(width: w, height: h, alignment: .topLeading)
                        .scaleEffect(near(info.dist), anchor: UnitPoint(x: 0.5, y: 0.02)) // toward the vanishing point, the top centre
                        .animation(.easeOut(duration: 0.15), value: near(info.dist))
                }
                mine(info, w: w, h: h)
                    .frame(width: w, height: h, alignment: .topLeading)
                VStack {
                    Spacer()
                    Button("Close") { model.closeHp() }
                        .foregroundColor(.gray)
                        .padding(.bottom, 24)
                }
                .frame(width: w, height: g.size.height)
            }
        }
        .ignoresSafeArea()
    }

    private func share(_ v: Double, _ m: Double) -> CGFloat { CGFloat(Swift.max(0, Swift.min(1, v / Swift.max(1, m)))) }
    private func near(_ d: Double) -> CGFloat { d > 0 ? Swift.max(Self.far, Swift.min(1, CGFloat(Self.refDist / d))) : 1 }

    private func foe(_ info: HpInfo, slot: String, w: CGFloat, h: CGFloat) -> some View {
        let size: CGFloat = Swift.min(h * 0.42, w * 0.3), cy: CGFloat = h * 0.27, x0: CGFloat = w * 0.05
        let bh: CGFloat = size * 0.2, bx: CGFloat = x0 + size + w * 0.04
        let bw: CGFloat = w * 0.95 - bx
        let color: Color = slot == "A" ? Color(red: 1, green: 0.4, blue: 0) : Color(red: 0, green: 0.47, blue: 1) // the players' colours (field3d.js TEAM)
        let picture: String = info.foeChara == "chaoben" ? "AvatarChaoben" : "AvatarWizard" + slot
        return ZStack(alignment: .topLeading) {
            Image(picture).resizable().interpolation(.high)
                .frame(width: size, height: size)
                .offset(x: x0, y: cy - size / 2)
            ZStack(alignment: .leading) {
                Color(white: 0.17)
                color.frame(width: bw * share(info.foeHp, info.foeMax))
            }
            .frame(width: bw, height: bh)
            .clipShape(Capsule())
            .offset(x: bx, y: cy - bh / 2)
        }
    }

    private func mine(_ info: HpInfo, w: CGFloat, h: CGFloat) -> some View {
        let s: CGFloat = share(info.hp, info.max)
        let gx: CGFloat = w * 0.03, gh: CGFloat = Swift.min(h * 0.2, w * 0.16)
        let gw: CGFloat = w - 2 * gx, gy: CGFloat = h * 0.74 - gh / 2, r: CGFloat = gh / 2
        let lw: CGFloat = Swift.max(1, gh * 0.035 / 2) // points: the cuts are drawn two lines wide
        // what is left: green, yellow under half, red under a quarter
        let base: [Double] = s > 0.5 ? [0.133, 0.816, 0.275] : s > 0.25 ? [1, 0.761, 0.102] : [1, 0.165, 0.165]
        let tone: (Double, Double) -> Color = { to, t in Color(red: base[0] + (to - base[0]) * t, green: base[1] + (to - base[1]) * t, blue: base[2] + (to - base[2]) * t) }
        let lost: [Color] = [Color(red: 0.07, green: 0.01, blue: 0.01), Color(red: 0.23, green: 0.04, blue: 0.04), Color(red: 0.07, green: 0.01, blue: 0.01)]
        let rim: [Color] = [.white, Color(red: 0.54, green: 0.54, blue: 0.59), Color(red: 0.29, green: 0.29, blue: 0.33)]
        return ZStack(alignment: .topLeading) {
            Text("あなた")
                .font(.system(size: gh * 0.3, weight: .bold))
                .foregroundColor(Color.white.opacity(0.85))
                .offset(x: gx + r * 0.5, y: gy - gh * 0.55)
            Capsule() // the base: the bar's thickness, seen under it
                .fill(Color(red: 0.267, green: 0.267, blue: 0.306))
                .frame(width: gw, height: gh)
                .offset(x: gx, y: gy + gh * 0.12)
            ZStack(alignment: .leading) {
                LinearGradient(colors: lost, startPoint: .top, endPoint: .bottom) // what was lost: dark red, deepest at the edges
                LinearGradient(colors: [tone(1, 0.45), tone(0, 0), tone(0, 0.5)], startPoint: .top, endPoint: .bottom) // lit from above
                    .frame(width: gw * s)
                LinearGradient(colors: [Color.white.opacity(0.55), Color.white.opacity(0)], startPoint: .top, endPoint: .bottom) // the gloss
                    .frame(width: gw - r * 0.7, height: gh * 0.38)
                    .clipShape(Capsule())
                    .offset(x: r * 0.35, y: -gh * 0.23)
                ForEach(1..<10, id: \.self) { k in // the cuts: every tenth, the half longer; engraved (a dark line, a light one beside it)
                    HStack(spacing: 0) {
                        Color.black.opacity(0.63).frame(width: lw)
                        Color.white.opacity(0.31).frame(width: lw)
                    }
                    .frame(height: gh * (k == 5 ? 0.8 : 0.48))
                    .offset(x: gw * CGFloat(k) / 10 - lw)
                }
            }
            .frame(width: gw, height: gh)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(LinearGradient(colors: rim, startPoint: .top, endPoint: .bottom), lineWidth: Swift.max(1.5, gh * 0.035))) // the rim: light on top, dark below
            .offset(x: gx, y: gy)
            .animation(.easeOut(duration: 0.25), value: s)
        }
    }
}
