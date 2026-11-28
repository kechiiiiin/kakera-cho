import XCTest

/// 1日のページ段階4（地図・訪問）を実画面で通す。make shots-chizu が位置の許可を取り消してから回す。
/// 場所はローカルのかけら帳に API で入れ、予定は -kakeraSeedEvents、訪問は DEBUG の擬似訪問 -kakeraFakeVisit で入れる。
/// スクリーンショットは TEST_RUNNER_KAKERA_SHOTS に stage4-*.png、Google マップの URL は stage4-google-url.txt
final class DayPageChizuShots: XCTestCase {
    private var app: XCUIApplication!
    private var shots: URL?
    private let day = "2026-11-27"
    private let base = "http://127.0.0.1:4321"
    /// 擬似の訪問（同じ訪問を秒だけずらして2回）
    private let visitA = "35.689500,139.691700,2026-11-27T16:20:05+09:00"
    private let visitB = "35.689510,139.691720,2026-11-27T16:20:40+09:00"

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        if let dir = ProcessInfo.processInfo.environment["KAKERA_SHOTS"] { shots = URL(fileURLWithPath: dir) }
    }

    private func launch(_ extra: [String]) {
        app.launchArguments = ["-kakeraBaseURL", base, "-minatoBaseURL", "http://127.0.0.1:8793", "-kakeraSeedEvents", day] + extra
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

    private func places() -> [[String: Any]] {
        guard let d = call("GET", "/api/place?date=\(day)"),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [] }
        return o["places"] as? [[String: Any]] ?? []
    }

    /// その日の場所を入れ直す（座標つき1つ・座標なし1つ）。外した印も取る
    private func seedPlaces() {
        for p in places() { call("DELETE", "/api/place/\(p["id"] as! String)") }
        call("POST", "/api/place", json: ["id": "01KQ0000000000000000000001", "at": "\(day)T14:00:00+09:00", "name": "上野公園",
                                          "lat": 35.7148, "lng": 139.7731])
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
        if let shots { try? png.write(to: shots.appendingPathComponent("stage4-\(name).png")) }
    }

    private func any(_ pred: String, _ arg: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: pred, arg)).firstMatch
    }

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

    private func numbers(_ prefix: String) -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).allElementsBoundByIndex
            .map { String($0.identifier.dropFirst(prefix.count)) }
    }

    func testMapNumbersAndVisits() throws {
        seedPlaces()
        // 擬似の訪問を2回（同じ訪問）。端末の溜めと送り済みの鍵は空から
        launch(["-kakeraResetVisits", "-kakeraFakeVisit", visitA, "-kakeraFakeVisit", visitB])
        XCTAssertTrue(app.buttons["prevDay"].waitForExistence(timeout: 30))
        app.buttons["prevDay"].tap()
        XCTAssertTrue(any("label CONTAINS %@", "06:40").waitForExistence(timeout: 60))
        // 写真の許可がまだなら、理由の案内から許可する（位置つきの写真もピンにするため）
        let askPhotos = app.buttons["allowTimelinePhotos"]
        if askPhotos.waitForExistence(timeout: 3) {
            askPhotos.tap()
            let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let full = sb.buttons.matching(NSPredicate(format: "label CONTAINS 'フル' OR label CONTAINS 'Full'")).firstMatch
            if full.waitForExistence(timeout: 10) { full.tap() }
            XCTAssertTrue(any("label == %@", "写真 08:05").waitForExistence(timeout: 20))
        }
        // 訪問は1件だけ・source=visit
        XCTAssertTrue(waitFor(40) { self.places().filter { ($0["source"] as? String) == "visit" }.count == 1 }, "訪問が1件入る")
        sleep(3)
        shot("1-top")

        // 一覧の番号は、見えている行しか描かれないので、上から下まで送りながら集める
        var rowNums = Set(numbers("rowNumber-"))
        for _ in 0..<12 { app.swipeUp(); rowNums.formUnion(numbers("rowNumber-")) }
        for _ in 0..<12 { app.swipeDown() }

        // 自動で残した場所の行
        let visitRow = any("label CONTAINS %@", "自動")
        scrollToShow(visitRow)
        XCTAssertTrue(visitRow.exists)
        sleep(1)
        shot("2-visit-row")

        // 地図: 一覧の番号と地図のピンの番号が一致
        let map = app.descendants(matching: .any)["chizu"]
        scrollToShow(map)
        XCTAssertTrue(map.waitForExistence(timeout: 10))
        sleep(4) // 地図の絵が出るのを待つ
        shot("3-map")
        // 地図の注記は重なると読み上げに一部しか出ないので、地図に添えた番号の並び（accessibilityValue）で見る
        let pinNums = Set(((map.value as? String) ?? "").split(separator: ",").map(String.init))
        XCTAssertFalse(pinNums.isEmpty)
        XCTAssertEqual(rowNums, pinNums, "一覧と地図の番号が一致")
        XCTAssertEqual(pinNums, Set((1...pinNums.count).map(String.init)), "1 から抜けなく")

        // Google マップの URL（開かずに中身を見る）
        let route = app.descendants(matching: .any)["googleMapsRoute"]
        scrollToShow(route)
        XCTAssertTrue(route.exists)
        let url = (route.value as? String) ?? ""
        if let shots { try? url.write(to: shots.appendingPathComponent("stage4-google-url.txt"), atomically: true, encoding: .utf8) }
        XCTAssertTrue(url.hasPrefix("https://www.google.com/maps/dir/?api=1&origin="), url)
        XCTAssertTrue(url.contains("&destination=") && url.contains("&waypoints=") && url.contains("&travelmode=transit"), url)
        let comps = URLComponents(string: url)
        let waypoints = comps?.queryItems?.first { $0.name == "waypoints" }?.value?.split(separator: "|") ?? []
        XCTAssertEqual(waypoints.count, min(9, pinNums.count - 2), "経由地はピンの数-2（9まで）")
        shot("4-route-link")

        // 開き直して同じ訪問がまた届いても二重にならない（端末の鍵を空にしても、サーバが同じ id を断る）
        app.terminate()
        launch(["-kakeraResetVisits", "-kakeraFakeVisit", visitA])
        XCTAssertTrue(app.buttons["prevDay"].waitForExistence(timeout: 30))
        sleep(5)
        XCTAssertEqual(places().filter { ($0["source"] as? String) == "visit" }.count, 1, "二重にならない")
    }

    /// 設定の「行った場所を自動で残す」: 理由 → 使用中のみ → 常に
    func testVisitSettingAsksWithReason() throws {
        launch(["-kakeraResetVisits"])
        XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 30))
        app.buttons["openSettings"].tap()
        let toggle = app.switches["visitToggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        if (toggle.value as? String) == "1" { toggle.switches.firstMatch.tap(); sleep(1) }
        shot("5-setting-off")
        toggle.switches.firstMatch.tap()
        let cont = app.alerts.buttons["続ける"].firstMatch
        XCTAssertTrue(cont.waitForExistence(timeout: 5), "理由を先に出す")
        shot("6-setting-reason")
        cont.tap()
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let whenInUse = sb.buttons.matching(NSPredicate(format: "label CONTAINS '使用中' OR label CONTAINS 'While Using'")).firstMatch
        XCTAssertTrue(whenInUse.waitForExistence(timeout: 10), "使用中のみの確認")
        shot("7-when-in-use")
        whenInUse.tap()
        let always = sb.buttons.matching(NSPredicate(format: "label CONTAINS '常に' OR label CONTAINS 'Always'")).firstMatch
        if always.waitForExistence(timeout: 10) {
            shot("8-always")
            always.tap()
        }
        sleep(2)
        XCTAssertEqual(toggle.value as? String, "1")
        shot("9-setting-on")
    }
}
