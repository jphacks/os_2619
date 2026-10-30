import SwiftUI

@main
struct SensorLinkApp: App {
    @StateObject private var model = Model()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .onAppear { model.start() }
                .preferredColorScheme(.dark)
        }
    }
}
