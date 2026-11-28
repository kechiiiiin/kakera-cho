import SwiftUI

@main
struct KakeraApp: App {
    init() {
        #if DEBUG
        ServerConfig.applyLaunchOverride()
        #endif
        LaunchConfig.applyIfPresent()
        // 行った場所の自動記録: オンなら訪問の監視を続け、溜まっているものを送る（位置で起こされたときもここを通る）
        Task { @MainActor in
            #if DEBUG
            await VisitRecorder.shared.applyLaunchArguments()
            #endif
            VisitRecorder.shared.resume()
        }
    }

    var body: some Scene {
        WindowGroup {
            // ダークモード対応はしない（Web 版 §9 と同じ）。常にライト
            DayView().tint(Theme.accent).preferredColorScheme(.light)
        }
    }
}
