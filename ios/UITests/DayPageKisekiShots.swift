import XCTest

/// 移動の軌跡（かけら帳1日のページ設計「追加: 移動の軌跡」）を実画面で通す。make shots-kiseki。
/// 擬似の軌跡は DEBUG の -kakeraFakeTrack で端末の溜まりに入れ、本物と同じ道（溜める → POST /api/track）でローカルのかけら帳に送る。
/// 長い日（福岡〜北九州・駅をたどる）と短い日（福岡市内・西新 → 地行 → 大濠公園 → 天神）の2日。ピンは駅の場所。
/// スクリーンショットは TEST_RUNNER_KAKERA_SHOTS に track-*.png
final class DayPageKisekiShots: XCTestCase {
    private var app: XCUIApplication!
    private var shots: URL?
    private let base = "http://127.0.0.1:4321"
    private let longDay = "2026-11-25"
    private let shortDay = "2026-11-26"
    private let noTrackDay = "2026-11-27"
    private let longCount = 40
    private let shortCount = 30

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        if let dir = ProcessInfo.processInfo.environment["KAKERA_SHOTS"] { shots = URL(fileURLWithPath: dir) }
    }

    private func launch(_ extra: [String]) {
        app.launchArguments = ["-kakeraBaseURL", base, "-minatoBaseURL", "http://127.0.0.1:8793"] + extra
        app.launch()
    }

    private var fakeTracks: [String] {
        ["-kakeraFakeTrack", "kitakyushu,\(longCount),\(longDay)T09:00:00+09:00,150",
         "-kakeraFakeTrack", "fukuoka,\(shortCount),\(shortDay)T10:00:00+09:00,120"]
    }

    @discardableResult
    private func call(_ method: String, _ path: String, json: [String: Any]? = nil) -> Data? {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = method
        req.setValue(base, forHTTPHeaderField: "Origin")
        if let json {
            req.httpBody = try? JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let sem = DispatchSemaphore(value: 0)
        var out: Data?
        URLSession.shared.dataTask(with: req) { d, _, _ in out = d; sem.signal() }.resume()
        sem.wait()
        return out
    }

    private func trackCount(_ day: String) -> Int {
        guard let d = call("GET", "/api/track?date=\(day)"),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return -1 }
        return (o["points"] as? [Any])?.count ?? -1
    }

    /// ピン（駅の場所）。同じ id なので二度目は 409 で増えない
    private func seedPlaces() {
        let places: [(String, String, String, Double, Double)] = [
            ("01KS0000000000000000000001", "\(longDay)T09:00:00+09:00", "博多駅", 33.5897, 130.4207),
            ("01KS0000000000000000000002", "\(longDay)T11:30:00+09:00", "小倉駅", 33.8868, 130.8826),
            ("01KS0000000000000000000003", "\(shortDay)T10:00:00+09:00", "西新駅", 33.5836, 130.3594),
            ("01KS0000000000000000000004", "\(shortDay)T12:00:00+09:00", "天神駅", 33.5911, 130.3989),
        ]
        for p in places {
            call("POST", "/api/place", json: ["id": p.0, "at": p.1, "name": p.2, "lat": p.3, "lng": p.4])
        }
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        if let shots { try? png.write(to: shots.appendingPathComponent("track-\(name).png")) }
    }

    private func byID(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func scrollToShow(_ e: XCUIElement) {
        for _ in 0..<12 where !(e.exists && e.isHittable) { app.swipeUp() }
    }

    private func waitFor(_ seconds: TimeInterval = 20, _ cond: @escaping () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if cond() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        return cond()
    }

    /// 月カレンダーからその日へ
    private func open(_ day: String) {
        let title = app.buttons["dayTitle"]
        for _ in 0..<12 where !title.isHittable { app.swipeDown() }
        title.tap()
        let cell = app.buttons["cal-\(day)"]
        XCTAssertTrue(cell.waitForExistence(timeout: 20), day)
        cell.tap()
    }

    /// 地図の下の一行（「移動 12.3 km・8,432歩」）から km を読む
    private func km(_ s: String) -> Double? {
        guard let r = s.range(of: #"移動 ([0-9.]+) km"#, options: .regularExpression) else { return nil }
        return Double(s[r].dropFirst(3).dropLast(3))
    }

    func testTrackOnMap() throws {
        seedPlaces()
        launch(["-kakeraResetTrack"] + fakeTracks)
        XCTAssertTrue(app.buttons["dayTitle"].waitForExistence(timeout: 30))
        // 端末の溜まりから送られて、D1 に点が入る
        XCTAssertTrue(waitFor(60) { self.trackCount(self.longDay) == self.longCount }, "長い日 \(trackCount(longDay))")
        XCTAssertTrue(waitFor(30) { self.trackCount(self.shortDay) == self.shortCount }, "短い日 \(trackCount(shortDay))")

        // 長い日: 軌跡の線・範囲・下の一行
        open(longDay)
        let summary = byID("chizuSummary")
        XCTAssertTrue(summary.waitForExistence(timeout: 30))
        scrollToShow(byID("googleMapsRoute"))
        sleep(5) // 地図の絵が出るのを待つ
        shot("1-long")
        let longKm = km(summary.label) ?? -1
        XCTAssertGreaterThan(longKm, 50, summary.label)
        XCTAssertLessThan(longKm, 120, summary.label)

        // 押すと全画面（動かせる・拡大できる・閉じられる）
        // 地図の要素は中身の分も "chizu" で当たるので、最初のものの真ん中を押す
        byID("chizu").firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let full = byID("chizuFull")
        XCTAssertTrue(full.waitForExistence(timeout: 10))
        sleep(4)
        shot("3-full")
        full.pinch(withScale: 2.5, velocity: 2)
        sleep(1)
        full.swipeLeft()
        sleep(3)
        shot("3b-full-moved")
        app.buttons["chizuClose"].tap()
        XCTAssertTrue(waitFor(10) { !full.exists })

        // 短い日（市内）
        open(shortDay)
        let summary2 = byID("chizuSummary")
        XCTAssertTrue(waitFor(30) { summary2.exists && (self.km(summary2.label) ?? 99) < 15 }, summary2.exists ? summary2.label : "なし")
        scrollToShow(byID("googleMapsRoute"))
        sleep(5)
        shot("2-short")

        // 軌跡の無い日は今のまま（下の一行が出ない）
        open(noTrackDay)
        let map = byID("chizu").firstMatch
        scrollToShow(map)
        if map.exists {
            scrollToShow(byID("googleMapsRoute"))
            sleep(4)
            shot("4-none")
            XCTAssertFalse(byID("chizuSummary").exists, "軌跡の無い日は一行を出さない")
        }

        // 開き直して同じ点がまた届いても二重にならない（端末の溜まりを空にしても、サーバが同じ id を飛ばす）
        app.terminate()
        launch(["-kakeraResetTrack"] + fakeTracks)
        XCTAssertTrue(app.buttons["dayTitle"].waitForExistence(timeout: 30))
        sleep(6)
        XCTAssertEqual(trackCount(longDay), longCount, "二重にならない")
        XCTAssertEqual(trackCount(shortDay), shortCount, "二重にならない")

        // 設定の文言
        app.buttons["openSettings"].tap()
        let toggle = app.switches["visitToggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertTrue(toggle.label.contains("行った場所と軌跡を自動で残す"), toggle.label)
        sleep(1)
        shot("5-setting")
    }
}
