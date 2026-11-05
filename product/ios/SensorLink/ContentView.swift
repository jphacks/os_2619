import SwiftUI
import WebKit

/// Camera picture with the detected tags drawn on top, the status lines, and the three buttons (IMU / Calibrate / LAN).
struct ContentView: View {
    @EnvironmentObject var model: Model
    @State private var showImu = false
    @State private var showLan = false
    @State private var showStick = false
    @State private var showScan = false

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
                    Button("枝") { showStick = true }
                        .disabled(model.inMatch) // no stick changes during a match
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(Color.black.opacity(0.6))
            }
            .padding(.horizontal, 8)
            Color.red.opacity(model.hitRed).ignoresSafeArea().allowsHitTesting(false) // a hit: over everything, buttons too
        }
        .sheet(isPresented: $showImu) { ImuSheet().environmentObject(model) }
        .sheet(isPresented: $showLan) { LanSheet().environmentObject(model) }
        .sheet(isPresented: $showStick) { StickSheet(url: URL(string: "http://\(model.host):\(model.port)/sticks.html")!).environmentObject(model) }
        .alert(model.scanning ? "Finish the scan?" : "Scan the stick", isPresented: $showScan) {
            if model.scanning {
                Button("Send to PC") { model.scanFinish() }
                Button("Cancel scan", role: .destructive) { model.scanCancel() }
                Button("Keep scanning", role: .cancel) {}
            } else {
                Button("Start") { model.scanStart() }
                Button("Cancel", role: .cancel) {}
            }
        } message: { Text(scanMessage) }
    }

    // The stick scan (Scan.swift; the same words as the Android app)
    private var scanMessage: String {
        if model.scanning { return "\(model.scan.count) pictures. The PC needs 6 at least; more angles give a better shape." }
        return "The PC turns photos into a 3D model of your stick's shape. Open the PC dashboard first (connection screen).\n\n" +
            "1. Lay the magic circle flat and lay the stick straight across its middle, its TIP toward tag T0 (the top of the poster).\n" +
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

/// The PC's branch-scan page (sticks.html) inside the app: its photo button opens the camera, and the page measures and uploads.
struct StickSheet: View {
    let url: URL
    @EnvironmentObject var model: Model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            Group {
                if model.lanUp {
                    WebView(url: url)
                } else {
                    VStack(spacing: 12) {
                        Text("PC につながっていません").font(.headline)
                        Text("閉じて LAN を開き、PC の IP とポートを入れてください。\n今の行き先: \(url.host ?? "") : \(url.port ?? 0)")
                            .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                    }.padding()
                }
            }
                .navigationTitle("枝をスキャン")
                .navigationBarTitleDisplayMode(.inline)
                .navigationBarItems(trailing: Button("閉じる") { dismiss() })
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> WKWebView {
        let v = WKWebView()
        v.load(URLRequest(url: url))
        return v
    }
    func updateUIView(_ v: WKWebView, context: Context) {}
}
