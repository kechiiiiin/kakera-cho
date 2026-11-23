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
            // ダークモード対応はしない（Web 版 §9 と同じ）。常にライト
            DayView().tint(Theme.accent).preferredColorScheme(.light)
        }
    }
}
