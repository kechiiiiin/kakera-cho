import XCTest

/// 見た目の刷新「C 丸 時間の帳」（かけら帳1日のページ設計「見た目の刷新」）を実画面で通す。make shots-c2。
/// 写真（build/stage2-media）・予定（-kakeraSeedEvents）・場所（API で入れる）・かけら（シード済み）・軌跡（-kakeraFakeTrack tokyo）
/// のそろった日、何も無い日、キーボードを出した下の帯、☰ のメニュー、月カレンダー、ほかの画面を撮る。
/// スクリーンショットは TEST_RUNNER_KAKERA_SHOTS に c2-*.png。モック attachments/kakera-ui-2026-11-28/c2.png と見比べる
final class DayPageC2Shots: XCTestCase {
    private var app: XCUIApplication!
    private var shots: URL?
    private let day = "2026-11-27"
    private let emptyDay = "2026-11-04" // 11/3 は祝日のカレンダーに予定がある
    private let base = "http://127.0.0.1:4321"

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        if let dir = ProcessInfo.processInfo.environment["KAKERA_SHOTS"] { shots = URL(fileURLWithPath: dir) }
    }

    private func launch(_ extra: [String] = []) {
        app.launchArguments = ["-kakeraBaseURL", base, "-minatoBaseURL", "http://127.0.0.1:8793", "-kakeraSeedEvents", day,
                               "-kakeraResetPhotoAdds"] + extra
        app.launch()
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

    /// その日の場所を入れ直す（座標つきの手入力・自動・座標なし）。外した印も取る
    private func seedPlaces() {
        if let d = call("GET", "/api/place?date=\(day)"), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            for p in o["places"] as? [[String: Any]] ?? [] { call("DELETE", "/api/place/\(p["id"] as! String)") }
        }
        call("POST", "/api/place", json: ["id": "01KQ0000000000000000000001", "at": "\(day)T14:00:00+09:00", "name": "上野公園",
                                          "lat": 35.7148, "lng": 139.7731])
        call("POST", "/api/place", json: ["id": "01KQ0000000000000000000003", "at": "\(day)T16:20:00+09:00", "name": "アメ横",
                                          "lat": 35.7101, "lng": 139.7745, "source": "visit"])
        call("POST", "/api/place", json: ["id": "01KQ0000000000000000000002", "at": "\(day)T19:30:00+09:00", "name": "名前だけの店"])
        struct E: Decodable { struct R: Decodable { let kind: String; let ref: String }; let hidden: [R] }
        if let d = call("GET", "/api/timeline-hidden?date=\(day)"), let e = try? JSONDecoder().decode(E.self, from: d) {
            for h in e.hidden {
                call("DELETE", "/api/timeline-hidden?kind=\(h.kind)&ref=\(h.ref.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)")
            }
        }
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let shots { try? png.write(to: shots.appendingPathComponent("c2-\(name).png")) }
    }

    private func any(_ pred: String, _ arg: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: pred, arg)).firstMatch
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
    private func go(to d: String) {
        app.buttons["dayTitle"].tap()
        let cell = app.buttons["cal-\(d)"]
        if !cell.waitForExistence(timeout: 10) {
            app.buttons["prevMonth"].tap()
        }
        XCTAssertTrue(cell.waitForExistence(timeout: 10))
        cell.tap()
    }

    private func allowPhotosIfAsked() {
        let ask = app.buttons["allowTimelinePhotos"]
        if ask.waitForExistence(timeout: 10) {
            ask.tap()
            let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            sleep(2)
            shot("0b-photo-permission")
            let full = sb.buttons.matching(NSPredicate(format: "label CONTAINS 'フル' OR label CONTAINS 'Full' OR label CONTAINS 'すべて' OR label BEGINSWITH 'Allow'")).firstMatch
            if full.waitForExistence(timeout: 10) { full.tap() }
        }
    }

    /// 写真・予定・場所・かけら・軌跡のそろった日
    func testFullDay() throws {
        seedPlaces()
        launch(["-kakeraFakeTrack", "tokyo,24,\(day)T13:30:00+09:00,170"])
        XCTAssertTrue(app.buttons["prevDay"].waitForExistence(timeout: 30))
        shot("0-today")
        go(to: day) // 日付が変わっても同じ日へ（前の日のボタンに頼らない）
        XCTAssertTrue(any("label CONTAINS %@", "06:40").waitForExistence(timeout: 60))
        allowPhotosIfAsked()
        XCTAssertTrue(any("label == %@", "写真 08:05").waitForExistence(timeout: 20), "写真が並ぶ")
        XCTAssertTrue(any("label CONTAINS %@", "上野公園").waitForExistence(timeout: 20), "場所が並ぶ")
        XCTAssertTrue(app.buttons["goToday"].exists, "今日以外は「今日へ」")
        XCTAssertFalse(app.buttons["write"].exists, "大きな「書く」は無い")
        sleep(3)
        shot("1-full-top")
        app.swipeUp()
        sleep(1)
        shot("2-full-mid")
        let chizu = byID("chizu")
        scrollToShow(chizu)
        sleep(2)
        shot("3-full-map")
        app.swipeUp(); app.swipeUp()
        sleep(1)
        shot("4-full-materials")

        // 写真を押すと拡大
        for _ in 0..<8 { app.swipeDown() }
        let thumb = any("label == %@", "写真 08:05")
        scrollToShow(thumb)
        thumb.tap()
        XCTAssertTrue(app.staticTexts["photoViewerIndex"].waitForExistence(timeout: 10))
        sleep(1)
        shot("5-viewer")
        app.buttons["closeViewer"].tap()
    }

    /// 何も無い日・キーボードを出した下の帯・☰・月カレンダー
    func testEmptyDayDockMenuMonth() throws {
        launch()
        XCTAssertTrue(app.buttons["dayTitle"].waitForExistence(timeout: 30))
        go(to: emptyDay)
        sleep(4)
        shot("6-empty-day")
        XCTAssertTrue(any("label CONTAINS %@", "この日の記録はまだありません").waitForExistence(timeout: 30))

        // 空のまま ＋ なら書く画面
        XCTAssertTrue(app.buttons["entryAdd"].waitForExistence(timeout: 10))
        app.buttons["entryAdd"].tap()
        sleep(2)
        shot("13-editor")
        app.buttons["やめる"].firstMatch.tap()
        if app.buttons["捨てる"].waitForExistence(timeout: 2) { app.buttons["捨てる"].tap() }

        // 下の帯: 欄を押すとキーボードの上に上がる
        let field = byID("entryText")
        field.tap()
        sleep(1)
        shot("7-dock-keyboard")
        field.typeText("帯から書くかけら")
        sleep(1)
        shot("7b-dock-typed")
        app.buttons["entryKind-basho"].tap()
        sleep(1)
        shot("7c-dock-basho")
        // 足さずに置いておく（＋ は押さない）。キーボードを下げる
        app.buttons["entryKind-kakera"].tap()
        app.swipeDown()

        // ☰
        app.buttons["openMenu"].tap()
        sleep(1)
        shot("8-menu")
        let katachi = app.buttons["open-katachi"].exists ? app.buttons["open-katachi"] : app.collectionViews.buttons["かたち"]
        XCTAssertTrue(katachi.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["openSettings"].exists || app.collectionViews.buttons["設定"].exists)
        katachi.tap()
        XCTAssertTrue(app.textFields["search"].waitForExistence(timeout: 30))
        sleep(2)
        shot("10-katachi")
        app.buttons["tab-nikki"].tap()
        sleep(3)
        shot("11-nikki")
        app.buttons["tab-words"].tap()
        sleep(3)
        shot("12-words")
        app.buttons["closeApp"].tap()

        // 月カレンダー
        XCTAssertTrue(app.buttons["dayTitle"].waitForExistence(timeout: 10))
        app.buttons["dayTitle"].tap()
        XCTAssertTrue(app.staticTexts["monthTitle"].waitForExistence(timeout: 10))
        sleep(2)
        shot("9-month")
        app.buttons["閉じる"].firstMatch.tap()


        // 設定
        app.tapMenu("openSettings", label: "設定")
        XCTAssertTrue(app.buttons["exportAll"].waitForExistence(timeout: 10))
        sleep(1)
        shot("14-settings")
    }
}
