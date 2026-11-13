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

/// The HP screen (match mode), on black and at full brightness. The display fills the top half,
/// mirrored vertically to match Android. Both HP bars are flat with parallel slanted ends.
/// The opponent's avatar and bar at full size however far it is (no perspective; Android the same). A long press calibrates, mid-match too.
struct HpScreen: View {
    @EnvironmentObject var model: Model

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height / 2, info = model.hp
            ZStack(alignment: .topLeading) {
                Color.black
                ZStack(alignment: .topLeading) {
                    if let slot = info.foeSlot { // nil: a PC too old to say who the opponent is
                        foe(info, slot: slot, w: w, h: h)
                            .frame(width: w, height: h, alignment: .topLeading)
                    }
                    mine(info, w: w, h: h)
                        .frame(width: w, height: h, alignment: .topLeading)
                }
                .frame(width: w, height: h, alignment: .topLeading)
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

    private func foe(_ info: HpInfo, slot: String, w: CGFloat, h: CGFloat) -> some View {
        let size: CGFloat = Swift.min(h * 0.42, w * 0.3), cy: CGFloat = h * 0.27, x0: CGFloat = w * 0.05
        let bh: CGFloat = size * 0.2, bx: CGFloat = x0 + size + w * 0.04
        let bw: CGFloat = w * 0.95 - bx
        let color: Color = slot == "A" ? Color(red: 1, green: 0.851, blue: 0.749) : Color(red: 0.749, green: 0.867, blue: 1) // the players' colours (field3d.js TEAM), near white: the phone gives off more light (Android the same)
        let picture: String = info.foeChara == "chaoben" ? "AvatarChaoben" : "AvatarWizard" + slot
        return ZStack(alignment: .topLeading) {
            Image(picture).resizable().interpolation(.high)
                .frame(width: size, height: size)
                .offset(x: x0, y: cy - size / 2)
            SlashBar(progress: share(info.foeHp, info.foeMax), color: color)
                .frame(width: bw, height: bh)
                .offset(x: bx, y: cy - bh / 2)
        }
    }

    private func mine(_ info: HpInfo, w: CGFloat, h: CGFloat) -> some View {
        let remaining = share(info.hp, info.max)
        let gx: CGFloat = w * 0.03, gh: CGFloat = Swift.min(h * 0.12, w * 0.095)
        let gw: CGFloat = w - 2 * gx, gy: CGFloat = h * 0.74 - gh / 2
        let color: Color
        if remaining > 0.5 {
            color = Color(red: 0.224, green: 1, blue: 0.078) // vivid neon green #39FF14: stays bright and readable when reflected in a clear file (Android the same)
        } else if remaining > 0.25 {
            color = Color(red: 1, green: 0.941, blue: 0.722)
        } else {
            color = Color(red: 1, green: 0.769, blue: 0.769)
        }
        return ZStack(alignment: .topLeading) {
            Text("あなた")
                .font(.system(size: gh * 0.42, weight: .medium))
                .foregroundColor(Color.white.opacity(0.85))
                .offset(x: gx + gh * 0.15, y: gy - gh * 0.72)
            SlashBar(progress: remaining, color: color)
                .frame(width: gw, height: gh)
                .offset(x: gx, y: gy)
                .animation(.easeOut(duration: 0.25), value: remaining)
        }
    }
}

private struct SlashBar: View {
    let progress: CGFloat
    let color: Color

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                SlashShape().fill(Color(red: 0.898, green: 0.169, blue: 0.169)) // the HP lost: red (Android the same)
                    .frame(width: g.size.width, height: g.size.height)
                if progress > 0 {
                    SlashShape().fill(color)
                        .frame(width: g.size.width * progress, height: g.size.height)
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .leading)
        }
    }
}

private struct SlashShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard rect.width > 0, rect.height > 0 else { return path }
        let slant = Swift.min(rect.height * 0.38, rect.width * 0.25)
        // HpScreen mirrors this shape vertically, so the visible ends slope like /.
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - slant, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + slant, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}
