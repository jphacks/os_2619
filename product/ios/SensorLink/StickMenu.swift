import SwiftUI

/// A scanned stick model (dashboard stickscan.js v 3: nodes [side, along] in m, edges, radius r [grip, tip]).
struct StickShape {
    let side: [Double], along: [Double], edges: [(Int, Int)], len: Double, r0: Double, r1: Double

    init?(_ m: [String: Any]) {
        guard let nodes = m["nodes"] as? [[NSNumber]], let e = m["edges"] as? [[NSNumber]], let len = (m["length"] as? NSNumber)?.doubleValue, len > 0 else { return nil }
        side = nodes.map { $0.first?.doubleValue ?? 0 }; along = nodes.map { $0.count > 1 ? $0[1].doubleValue : 0 }
        edges = e.compactMap { $0.count == 2 && $0[0].intValue < nodes.count && $0[1].intValue < nodes.count ? ($0[0].intValue, $0[1].intValue) : nil }
        self.len = len
        let r = (m["r"] as? [NSNumber])?.map { $0.doubleValue } ?? []
        r0 = r.first ?? 0.01; r1 = r.count > 1 ? r[1] : r0
    }
    func rAt(_ a: Double) -> Double { r0 + (r1 - r0) * Swift.min(1, Swift.max(0, a / len + 0.5)) }
}

/// One saved stick in the Stick menu (server.mjs stickList).
struct StickItem: Identifiable {
    let id: String, name: String, element: String, power: Double, speed: Double, shape: StickShape
}

/// The elements' colours (dashboard sticks.js) and names.
let elementColor: [String: Color] = ["fire": Color(red: 1, green: 0.478, blue: 0.102), "thunder": Color(red: 1, green: 0.824, blue: 0.239),
                                     "water": Color(red: 0.184, green: 0.49, blue: 1), "wind": Color(red: 0.847, green: 0.957, blue: 0.949)]
let elementName = ["fire": "Fire", "thunder": "Thunder", "water": "Water", "wind": "Wind"]

/// The Stick button: every stick saved on the PC (scanned by this phone or any other) turning slowly, tap one to use it.
/// server.mjs answers { type: 'stickList' } with the sticks and their models; { type: 'pickStick', id } puts one on this phone's slot.
/// The same menu as Android StickMenu.kt.
struct StickSheet: View {
    @EnvironmentObject var model: Model
    @Environment(\.dismiss) private var dismiss
    @State private var sticks: [StickItem]?
    @State private var current: String?

    var body: some View {
        NavigationView {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let list = sticks {
                        if list.isEmpty { Text("No sticks yet. Make one with Scan.") }
                        ForEach(list) { s in
                            Button { pick(s) } label: { card(s) }
                        }
                    } else {
                        Text(model.link.status == "connected" ? "Asking the PC…" : "Not connected to the PC: connect with LAN first.")
                    }
                }
                .padding()
            }
            .navigationTitle("Sticks")
            .navigationBarItems(trailing: Button("Close") { dismiss() })
        }
        .onAppear {
            model.link.onStickList = { k in
                let list = ((k["sticks"] as? [[String: Any]]) ?? []).compactMap { s -> StickItem? in
                    guard let id = s["id"] as? String, let m = s["model"] as? [String: Any], let shape = StickShape(m) else { return nil }
                    let st = s["stats"] as? [String: Any]
                    return StickItem(id: id, name: (s["name"] as? String) ?? "", element: (s["element"] as? String) ?? "fire",
                                     power: (st?["power"] as? NSNumber)?.doubleValue ?? 1, speed: (st?["speed"] as? NSNumber)?.doubleValue ?? 1, shape: shape)
                }
                let cur = k["current"] as? String
                DispatchQueue.main.async { sticks = list; current = cur }
            }
            model.link.send(["type": "stickList"])
        }
        .onDisappear { model.link.onStickList = nil }
    }

    private func pick(_ s: StickItem) {
        model.link.send(["type": "pickStick", "id": s.id])
        model.showToast("Using \(s.name)")
        dismiss()
    }

    private func card(_ s: StickItem) -> some View {
        let used = s.id == current
        let label = "\(s.name)   \(elementName[s.element] ?? s.element)   " + String(format: "power ×%.2f  speed ×%.2f", s.power, s.speed) + (used ? "   (in use)" : "")
        return VStack(alignment: .leading, spacing: 2) {
            StickTurntable(shape: s.shape).frame(height: 120)
            Text(label)
                .font(.system(size: 14))
                .foregroundColor(elementColor[s.element] ?? .white)
        }
        .padding(8)
        .background(used ? Color(red: 0.165, green: 0.2, blue: 0.275) : Color(red: 0.086, green: 0.094, blue: 0.114))
        .cornerRadius(6)
    }
}

/// The model turning slowly about its own length, seen a little from above and from the side; grip on the left.
/// Wood brown, lighter where it is nearer. The same drawing as Android StickView.
struct StickTurntable: View {
    let shape: StickShape
    private static let spin = 0.7, yaw = 0.25, pitch = 0.3 // rad / s; the view's fixed turn, rad

    var body: some View {
        TimelineView(.animation) { tl in
            Canvas { ctx, size in
                let s = shape, th = tl.date.timeIntervalSinceReferenceDate * Self.spin
                let reach = (s.side.map { abs($0) }.max() ?? 0) + s.r0
                let k = Swift.min(Double(size.width) * 0.9 / s.len, Double(size.height) * 0.42 / Swift.max(reach, 0.02))
                var px = [Double](), py = [Double](), pz = [Double]()
                for i in s.side.indices { // turn about the length (x), then the fixed view: yaw about y, pitch about x
                    let x = s.along[i], y = s.side[i] * cos(th), z = s.side[i] * sin(th)
                    let x1 = x * cos(Self.yaw) + z * sin(Self.yaw), z1 = -x * sin(Self.yaw) + z * cos(Self.yaw)
                    px.append(x1); py.append(y * cos(Self.pitch) - z1 * sin(Self.pitch)); pz.append(y * sin(Self.pitch) + z1 * cos(Self.pitch))
                }
                let cx = Double(size.width) / 2, cy = Double(size.height) / 2
                for (i0, i1) in s.edges.sorted(by: { pz[$0.0] + pz[$0.1] < pz[$1.0] + pz[$1.1] }) { // far ones first
                    let near = Swift.min(1, Swift.max(-1, (pz[i0] + pz[i1]) / 2 / (s.len / 2))), f = 0.85 + 0.3 * near
                    var p = Path()
                    p.move(to: CGPoint(x: cx + px[i0] * k, y: cy - py[i0] * k)); p.addLine(to: CGPoint(x: cx + px[i1] * k, y: cy - py[i1] * k))
                    ctx.stroke(p, with: .color(Color(red: Swift.min(1, 154.0 / 255 * f), green: 106.0 / 255 * f, blue: 62.0 / 255 * f)),
                               style: StrokeStyle(lineWidth: Swift.max(2, k * (s.rAt(s.along[i0]) + s.rAt(s.along[i1]))), lineCap: .round))
                }
            }
        }
    }
}
