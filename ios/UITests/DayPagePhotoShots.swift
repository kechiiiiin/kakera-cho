import XCTest

/// 1日のページ段階2（写真）を実画面で通す。make shots-photos が写真の許可を取り消し、検証用の写真（撮影日時・位置入り）を入れてから回す。
/// スクリーンショットは TEST_RUNNER_KAKERA_SHOTS に stage2-*.png で書く
final class DayPagePhotoShots: XCTestCase {
    private var app: XCUIApplication!
    private var shots: URL?

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-kakeraBaseURL", "http://127.0.0.1:4321", "-minatoBaseURL", "http://127.0.0.1:8793", "-kakeraResetPhotoAdds"]
        resetHidden(day: "2026-11-27")
        if let dir = ProcessInfo.processInfo.environment["KAKERA_SHOTS"] { shots = URL(fileURLWithPath: dir) }
        app.launch()
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
        if let shots { try? png.write(to: shots.appendingPathComponent("stage2-\(name).png")) }
    }

    private func any(_ pred: String, _ arg: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: pred, arg)).firstMatch
    }

    private func text(_ t: String) -> XCUIElement { any("label CONTAINS %@", t) }
    private func photo(_ hhmm: String) -> XCUIElement { any("label == %@", "写真 \(hhmm)") }

    private func scrollToShow(_ e: XCUIElement, up: Bool = true) {
        for _ in 0..<8 where !(e.exists && e.isHittable) { up ? app.swipeUp() : app.swipeDown() }
    }

    private func waitFor(_ seconds: TimeInterval = 20, _ cond: @escaping () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if cond() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        return cond()
    }

    /// 写真の許可のアラート（springboard 側）で「フルアクセス」を押す
    private func allowFullAccess() {
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let full = sb.buttons.matching(NSPredicate(format: "label CONTAINS 'フル' OR label CONTAINS 'Full' OR label CONTAINS 'すべて'")).firstMatch
        if full.waitForExistence(timeout: 10) { full.tap() }
    }

    func testPhotos() throws {
        XCTAssertTrue(app.buttons["prevDay"].waitForExistence(timeout: 30))
        app.buttons["prevDay"].tap()
        XCTAssertTrue(text("06:40").waitForExistence(timeout: 60))

        // 権限: 理由を出してから求める。許可の前もかけら・場所は出ている
        let ask = app.buttons["allowTimelinePhotos"]
        XCTAssertTrue(ask.waitForExistence(timeout: 10), "理由の案内が出る")
        shot("1-ask")
        ask.tap()
        allowFullAccess()
        XCTAssertTrue(photo("08:05").waitForExistence(timeout: 20))
        sleep(2)
        shot("2-list")

        // 撮影時刻の位置: 12:30:40 の写真は 12:30 のかけらより前（同じ分は 写真→かけら）、12:30 より後の 15:05 より前
        let p1230 = photo("12:30")
        scrollToShow(p1230)
        let lunch = text("昼ごはん")
        XCTAssertTrue(lunch.exists)
        XCTAssertLessThan(p1230.frame.minY, lunch.frame.minY)
        shot("3-same-minute")

        // 拡大して左右で送る・閉じる
        p1230.tap()
        XCTAssertTrue(app.staticTexts["photoViewerIndex"].waitForExistence(timeout: 10))
        sleep(1)
        shot("4-viewer")
        XCTAssertEqual(app.staticTexts["photoViewerIndex"].label, "2 / 3")
        app.swipeLeft()
        XCTAssertTrue(waitFor { self.app.staticTexts["photoViewerIndex"].label == "3 / 3" })
        app.buttons["closeViewer"].tap()
        XCTAssertTrue(waitFor { !self.app.staticTexts["photoViewerIndex"].exists })

        // × で外す（17:20）
        let p1720 = photo("17:20")
        scrollToShow(p1720)
        let x = app.buttons["delete-photo-" + (p1720.identifier.replacingOccurrences(of: "photoThumb-", with: ""))]
        XCTAssertTrue(x.exists)
        x.tap()
        XCTAssertTrue(waitFor { !self.photo("17:20").exists })
        shot("5-hidden")

        // 写真を追加: 外した 17:20 を戻し、11/20 の写真を足す
        let add = app.buttons["addPhotos"]
        scrollToShow(add)
        add.tap()
        sleep(3)
        shot("6-picker")
        if let dir = shots { try? app.debugDescription.write(to: dir.appendingPathComponent("stage2-picker-tree.txt"), atomically: true, encoding: .utf8) }
        try pickInPicker()
        sleep(4)
        shot("6c-after-done")
        XCTAssertTrue(waitFor(30) { self.photo("17:20").exists && self.photo("10:10").exists })
        scrollToShow(photo("10:10"), up: false)
        sleep(1)
        shot("7-added")
        XCTAssertTrue(text("11/20").exists, "別の日の写真に撮った日を添える")
    }

    /// ピッカーで 17:20 と 11/20 の写真を選んで「追加」。ピッカーの絵のラベルは日時を含む
    private func pickInPicker() throws {
        // ピッカーの絵は「写真, 11月27日, 17:20」のようなラベルの Image（まとめた親の要素は避ける）
        let cells = app.images.matching(NSPredicate(format: "label CONTAINS '11月27日, 17:20'"))
        let other = app.images.matching(NSPredicate(format: "label CONTAINS '11月20日, 10:10'"))
        XCTAssertTrue(cells.firstMatch.waitForExistence(timeout: 15), "ピッカーに 17:20 の写真")
        // ピッカーは別のプロセスが描くので、要素の位置を画面の座標で押す
        tapCenter(of: cells.firstMatch)
        XCTAssertTrue(other.firstMatch.waitForExistence(timeout: 5), "ピッカーに 11/20 の写真")
        tapCenter(of: other.firstMatch)
        sleep(1)
        shot("6b-picked")
        // ⚠️「追加」は裏のアプリの入力欄のボタンと同じ名前なので使わない。ピッカーの右上は「完了」
        let done = app.buttons.matching(NSPredicate(format: "label == '完了' OR label == 'Done'")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        tapCenter(of: done)
    }

    private func tapCenter(of e: XCUIElement) {
        let f = e.frame
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: f.midX, dy: f.midY)).tap()
    }
}
