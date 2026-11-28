import XCTest

/// 1日のページ段階5（月カレンダー・検索・書き出し）を実画面で通す。make shots-tsuki。
/// 前もってローカルのかけら帳に API でかけら・場所・気分を入れる（気分は D1 にあっても画面に出ないことを見る）。
/// スクリーンショットは stage5-*.png と、気分を外した画面の nokibun-*.png
final class DayPageTsukiShots: XCTestCase {
    private var app: XCUIApplication!
    private var shots: URL?
    private let base = "http://127.0.0.1:4321"

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-kakeraBaseURL", base, "-minatoBaseURL", "http://127.0.0.1:8793"]
        if let dir = ProcessInfo.processInfo.environment["KAKERA_SHOTS"] { shots = URL(fileURLWithPath: dir) }
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

    /// 11月に印の付く日と気分の入った日を足す（同じ id なので二度目は 409 で増えない）
    private func seed() {
        call("POST", "/api/kakera", json: ["id": "01KR0000000000000000000001", "body": "十日の短いかけら", "written_at": "2026-11-10T08:00:00+09:00"])
        call("POST", "/api/place", json: ["id": "01KR0000000000000000000002", "at": "2026-11-15T13:00:00+09:00", "name": "銀杏並木の公園",
                                          "lat": 35.6745, "lng": 139.7171])
        call("PUT", "/api/day/2026-11-12", json: ["mood": "疲"])
        call("PUT", "/api/day/2026-11-15", json: ["mood": "楽"])
    }

    private func shot(_ name: String, prefix: String = "stage5") {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        if let shots { try? png.write(to: shots.appendingPathComponent("\(prefix)-\(name).png")) }
    }

    /// 気分を外した画面: 気分の入った日（11/15・楽）の1日のページの頭と、月カレンダー
    func testNoKibun() throws {
        seed()
        app.launch()
        XCTAssertTrue(app.buttons["dayTitle"].waitForExistence(timeout: 30))
        app.buttons["dayTitle"].tap()
        let d15 = app.buttons["cal-2026-11-15"]
        XCTAssertTrue(d15.waitForExistence(timeout: 10))
        XCTAssertTrue(waitFor { d15.label.contains("書いた日") }, d15.label)
        XCTAssertFalse(any("label == %@", "気分").exists, "凡例に気分が無い")
        XCTAssertFalse(any("label == %@", "楽").exists, "升目に気分の字が無い")
        sleep(1)
        shot("2-tsuki", prefix: "nokibun")
        d15.tap()
        XCTAssertTrue(waitFor { self.app.buttons["dayTitle"].label.contains("11月15日") }, app.buttons["dayTitle"].label)
        XCTAssertTrue(any("label CONTAINS %@", "銀杏並木の公園").waitForExistence(timeout: 20))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "kibun-")).count, 0, "気分のハンコが無い")
        sleep(1)
        shot("1-top", prefix: "nokibun")
    }

    private func any(_ pred: String, _ arg: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: pred, arg)).firstMatch
    }

    private func waitFor(_ seconds: TimeInterval = 20, _ cond: @escaping () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if cond() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        return cond()
    }

    func testMonthSearchExport() throws {
        seed()
        app.launch()
        XCTAssertTrue(app.buttons["dayTitle"].waitForExistence(timeout: 30))

        // 月カレンダー: 書いた日の印（気分は D1 にあっても出さない）・未来は押せない・押すとその日へ
        app.buttons["dayTitle"].tap()
        XCTAssertTrue(app.staticTexts["monthTitle"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["monthTitle"].label, "2026年11月")
        let d27 = app.buttons["cal-2026-11-27"], d15 = app.buttons["cal-2026-11-15"], d12 = app.buttons["cal-2026-11-12"]
        XCTAssertTrue(waitFor { d27.label.contains("書いた日") }, d27.label)
        XCTAssertTrue(d15.label.contains("書いた日"), d15.label)
        XCTAssertFalse(d12.label.contains("書いた日"), d12.label)
        for d in [d27, d15, d12] { XCTAssertFalse(d.label.contains("気分"), d.label) }
        // 未来の日（明日。月末なら次の月なので見ない）は押せない。日付を固定すると、その日が来たとき落ちる
        var jst = Calendar(identifier: .gregorian)
        jst.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let tomorrow = jst.date(byAdding: .day, value: 1, to: Date())!
        let f = DateFormatter()
        f.calendar = jst; f.timeZone = jst.timeZone; f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"
        let tomorrowKey = f.string(from: tomorrow)
        if tomorrowKey.hasPrefix("2026-11") {
            XCTAssertFalse(app.buttons["cal-\(tomorrowKey)"].isEnabled, "未来の日は押せない")
        }
        XCTAssertFalse(app.buttons["nextMonth"].isEnabled)
        sleep(1)
        shot("1-month")
        app.buttons["prevMonth"].tap()
        XCTAssertTrue(waitFor { self.app.staticTexts["monthTitle"].label == "2026年10月" })
        shot("2-prev-month")
        app.buttons["nextMonth"].tap()
        XCTAssertTrue(waitFor { self.app.staticTexts["monthTitle"].label == "2026年11月" })
        app.buttons["cal-2026-11-10"].tap()
        XCTAssertTrue(waitFor { self.app.buttons["dayTitle"].label.contains("11月10日") }, app.buttons["dayTitle"].label)
        XCTAssertTrue(any("label CONTAINS %@", "十日の短いかけら").waitForExistence(timeout: 20))
        shot("3-picked-day")

        // 検索: かけらと場所名が日付つきで出る。押すとその日へ
        app.tapMenu("openSearch", label: "さがす")
        let field = app.textFields["daySearchField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.typeText("銀杏")
        let place = any("identifier == %@", "hit-b-01KR0000000000000000000002")
        XCTAssertTrue(place.waitForExistence(timeout: 20))
        XCTAssertTrue(any("label CONTAINS %@", "すっかり黄色").exists, "かけらの本文も出る")
        sleep(1)
        shot("4-search")
        place.tap()
        XCTAssertTrue(waitFor { self.app.buttons["dayTitle"].label.contains("11月15日") }, app.buttons["dayTitle"].label)
        XCTAssertTrue(any("label CONTAINS %@", "銀杏並木の公園").waitForExistence(timeout: 20))
        shot("5-search-picked")

        // かたち一覧の既存の検索も動く（results を読む）
        app.tapMenu("open-katachi", label: "かたち")
        let katachiSearch = app.textFields["search"]
        XCTAssertTrue(katachiSearch.waitForExistence(timeout: 20))
        katachiSearch.tap()
        katachiSearch.typeText("銀杏")
        XCTAssertTrue(any("label CONTAINS %@", "すっかり黄色").waitForExistence(timeout: 20), "かたちの検索に、かたちの中のかけらが出る")
        sleep(1)
        shot("6-katachi-search")
    }

    func testExportShareSheet() throws {
        app.launch()
        app.tapMenu("openSettings", label: "設定")
        let export = app.buttons["exportAll"]
        XCTAssertTrue(export.waitForExistence(timeout: 10))
        shot("7-settings")
        export.tap()
        // 共有シート（ファイル名 kakera-YYYY-MM-DD.txt）
        let sheet = app.otherElements["ActivityListView"]
        let fileName = any("label CONTAINS %@", "kakera-")
        XCTAssertTrue(waitFor(30) { sheet.exists || fileName.exists }, "共有シートが出る")
        sleep(2)
        shot("8-share-sheet")
    }
}
