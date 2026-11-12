import SwiftUI

/// One saved stick in the Stick menu (server.mjs stickList).
struct StickItem: Identifiable {
    let id: String, name: String, element: String, power: Double, speed: Double, image: String?
}

/// The elements' colours (dashboard sticks.js) and names.
let elementColor: [String: Color] = ["fire": Color(red: 1, green: 0.478, blue: 0.102), "thunder": Color(red: 1, green: 0.824, blue: 0.239),
                                     "water": Color(red: 0.184, green: 0.49, blue: 1), "wind": Color(red: 0.847, green: 0.957, blue: 0.949)]
let elementName = ["fire": "Fire", "thunder": "Thunder", "water": "Water", "wind": "Wind"]

/// The Stick button: every stick saved on the PC (scanned by this phone or any other) with its scan photo, tap one to use it.
/// server.mjs answers { type: 'stickList' } with the sticks and their photos' paths (fetched over HTTP: a list of models was too slow on
/// the phones' link); { type: 'pickStick', id } puts one on this phone's slot.
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
                    guard let id = s["id"] as? String else { return nil }
                    let st = s["stats"] as? [String: Any]
                    return StickItem(id: id, name: (s["name"] as? String) ?? "", element: (s["element"] as? String) ?? "fire",
                                     power: (st?["power"] as? NSNumber)?.doubleValue ?? 1, speed: (st?["speed"] as? NSNumber)?.doubleValue ?? 1, image: s["image"] as? String)
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
            Group {
                if let p = s.image, p.hasPrefix("/"), let u = URL(string: "http://\(model.host):\(model.port)\(p)") {
                    AsyncImage(url: u) { img in img.resizable().scaledToFill() } placeholder: { Color.black }
                } else {
                    Text("No photo").foregroundColor(.gray)
                }
            }
            .frame(maxWidth: .infinity).frame(height: 140).clipped()
            Text(label)
                .font(.system(size: 14))
                .foregroundColor(elementColor[s.element] ?? .white)
        }
        .padding(8)
        .background(used ? Color(red: 0.165, green: 0.2, blue: 0.275) : Color(red: 0.086, green: 0.094, blue: 0.114))
        .cornerRadius(6)
    }
}
