import SwiftUI

@main
struct KakeraApp: App {
    init() {
        #if DEBUG
        ServerConfig.applyLaunchOverride()
        #endif
        LaunchConfig.applyIfPresent()
    }

    var body: some Scene {
        WindowGroup {
            DayView().tint(Theme.accent)
        }
    }
}
