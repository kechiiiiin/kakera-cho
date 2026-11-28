import XCTest

/// 1日のページ段階3（予定）を実画面で通す。make shots-events がカレンダーの許可を取り消してから回す。
/// 予定は DEBUG の起動引数 -kakeraSeedEvents で検証用のカレンダー「かけら帳の検証」に入れる（ほかのカレンダーには触らない）。
/// スクリーンショットは TEST_RUNNER_KAKERA_SHOTS に stage3-*.png で書く
final class DayPageEventShots: XCTestCase {
    private var app: XCUIApplication!
    private var shots: URL?
    private let day = "2026-11-27"

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-kakeraBaseURL", "http://127.0.0.1:4321", "-minatoBaseURL", "http://127.0.0.1:8793",
                               "-kakeraSeedEvents", day]
        if let dir = ProcessInfo.processInfo.environment["KAKERA_SHOTS"] { shots = URL(fileURLWithPath: dir) }
    }

    /// 前の回の「外した」印をローカルのかけら帳から取る（毎回同じ所から始める）
    private func resetHidden(day: String) {
        let base = "http://127.0.0.1:4321"
        func call(_ method: String, _ path: String) -> Data? {
            var req = URLRequest(url: URL(string: base + path)!)
            req.httpMethod = method
            req.setValue(base, forHTTPHeaderField: "Origin")
            let sem = DispatchSemaphore(value: 0)
            var out: Data?
            URLSession.shared.dataTask(with: req) { d, _, _ in out = d; sem.signal() }.resume()
            sem.wait()
            return out
        }
        struct Envelope: Decodable { struct Row: Decodable { let kind: String; let ref: String }; let hidden: [Row] }
        guard let d = call("GET", "/api/timeline-hidden?date=\(day)"), let e = try? JSONDecoder().decode(Envelope.self, from: d) else { return }
        for h in e.hidden {
            let ref = h.ref.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? h.ref
            _ = call("DELETE", "/api/timeline-hidden?kind=\(h.kind)&ref=\(ref)")
        }
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        if let shots { try? png.write(to: shots.appendingPathComponent("stage3-\(name).png")) }
    }

    private func any(_ pred: String, _ arg: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: pred, arg)).firstMatch
    }

    private func text(_ t: String) -> XCUIElement { any("label CONTAINS %@", t) }
    private func yotei(_ title: String) -> XCUIElement { any("identifier == %@", "yotei-\(title)") }

    private func scrollToShow(_ e: XCUIElement, up: Bool = true) {
        for _ in 0..<10 where !(e.exists && e.isHittable) { up ? app.swipeUp() : app.swipeDown() }
    }

    private func toTop() { for _ in 0..<4 { app.swipeDown() } }

    private func waitFor(_ seconds: TimeInterval = 20, _ cond: @escaping () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if cond() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        return cond()
    }

    private func allowCalendar() {
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let ok = sb.buttons.matching(NSPredicate(format: "label CONTAINS 'フル' OR label CONTAINS 'Full' OR label == 'OK' OR label == '許可'")).firstMatch
        if ok.waitForExistence(timeout: 10) { ok.tap() }
    }

    func testEvents() throws {
        resetHidden(day: day)
        resetHidden(day: "2026-11-28")
        app.launch()
        app.goToDay("2026-11-27") // 検証の日（前の日のボタンに頼らない）
        XCTAssertTrue(text("06:40").waitForExistence(timeout: 60))

        // 権限: 理由を出してから求める。許可の前もかけら・写真は出ている
        let ask = app.buttons["allowTimelineEvents"]
        XCTAssertTrue(ask.waitForExistence(timeout: 10), "理由の案内が出る")
        shot("1-ask")
        ask.tap()
        allowCalendar()
        XCTAssertTrue(yotei("祝日のような終日の予定").waitForExistence(timeout: 30))
        sleep(2)
        toTop()
        shot("2-top")

        // 終日が先頭・日をまたぐ予定は 0:00 から・その後にかけら
        let allDay = yotei("祝日のような終日の予定"), bus = yotei("夜行バス"), morning = text("朝いちばん")
        XCTAssertTrue(bus.exists && morning.exists)
        XCTAssertLessThan(allDay.frame.minY, bus.frame.minY)
        XCTAssertLessThan(bus.frame.minY, morning.frame.minY)
        XCTAssertTrue(bus.label.contains("前日から・01:30まで"), bus.label)

        // 場所つき
        let meeting = yotei("打ち合わせ")
        scrollToShow(meeting)
        XCTAssertTrue(meeting.label.contains("東京駅"), meeting.label)
        XCTAssertTrue(meeting.label.contains("11:30まで"), meeting.label)

        // 同じ分（12:30）は 予定→写真→かけら
        let lunchEvent = yotei("昼の約束"), photo = any("label == %@", "写真 12:30"), lunch = text("昼ごはん")
        scrollToShow(photo)
        XCTAssertTrue(lunchEvent.exists && lunch.exists)
        XCTAssertLessThan(lunchEvent.frame.minY, photo.frame.minY)
        XCTAssertLessThan(photo.frame.minY, lunch.frame.minY)
        shot("3-noon")
        let night = yotei("夜の勉強会")
        scrollToShow(night)
        XCTAssertTrue(night.label.contains("翌日まで"), night.label)

        // × で繰り返しのこの回だけ外す
        toTop()
        let walk = yotei("朝の散歩")
        scrollToShow(walk)
        let x = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'delete-yotei-' AND identifier CONTAINS '|2026-11-27T07:30'")).firstMatch
        XCTAssertTrue(x.exists)
        x.tap()
        XCTAssertTrue(waitFor { !self.yotei("朝の散歩").exists })
        shot("4-hidden")

        // 次の日（同じ繰り返しの別の回）は残る
        toTop()
        app.buttons["nextDay"].tap()
        XCTAssertTrue(yotei("朝の散歩").waitForExistence(timeout: 20), "繰り返しの他の回は残る")
        sleep(1)
        shot("5-next-day")
        // 同じ題の回がその日の夜にもあることがある（検証のカレンダーに別の日の種が残る）ので、どれかが前日からの回なら良い
        let nights = app.descendants(matching: .any).matching(identifier: "yotei-夜の勉強会").allElementsBoundByIndex.map(\.label)
        XCTAssertTrue(nights.contains { $0.contains("前日から・01:00まで") }, nights.joined(separator: " / "))
        // 戻っても外したまま
        app.buttons["prevDay"].tap()
        XCTAssertTrue(yotei("打ち合わせ").waitForExistence(timeout: 20))
        XCTAssertFalse(yotei("朝の散歩").exists)
    }

    /// make shots-events がカレンダーの許可を取り消してから呼ぶ: 一行と「設定」だけで、他の行は出る
    func testDenied() throws {
        app.launch()
        app.goToDay("2026-11-27") // 検証の日（前の日のボタンに頼らない）
        XCTAssertTrue(text("06:40").waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["eventsDenied"].waitForExistence(timeout: 10))
        XCTAssertFalse(yotei("打ち合わせ").exists)
        sleep(1)
        shot("6-denied")
    }
}
