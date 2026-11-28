import XCTest

/// 1日のページ（段階1）を実画面で通す: 一覧に既存のかけらが時刻順に出る・気分のハンコが無い・場所とかけらの追加と削除。
/// 2026-11-28 の見た目の刷新（C 丸）後は、入力は下の帯（entryKind-*・entryText・entryAdd）、時刻は分の字の読み上げ（「06:40」）で探す。
/// ローカルのかけら帳（astro dev :4321・DEV_BYPASS_AUTH）に向けて起動し、要所でスクリーンショットを
/// TEST_RUNNER_KAKERA_SHOTS（make shots が ios/build を渡す）に stage1-*.png で書く。`make test` には入れない（ローカルの Worker が要る）
final class DayPageShots: XCTestCase {
    private var app: XCUIApplication!
    private var shots: URL?

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-kakeraBaseURL", "http://127.0.0.1:4321", "-minatoBaseURL", "http://127.0.0.1:8793"]
        if let dir = ProcessInfo.processInfo.environment["KAKERA_SHOTS"] { shots = URL(fileURLWithPath: dir) }
        app.launch()
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let shots { try? png.write(to: shots.appendingPathComponent("stage1-\(name).png")) }
    }

    private func field() -> XCUIElement { byID("entryText") }

    private func byID(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func deleteButtons(_ prefix: String) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
    }

    /// 下へ送って見えるまで。下の帯とキーボードが出ていても一覧を送れるよう、画面の上半分をつまんで引く
    private func scrollToShow(_ e: XCUIElement) {
        for _ in 0..<14 where !(e.exists && e.isHittable) {
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.42))
            from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.16)))
        }
    }

    /// 行は子の文字がまとまって一つの要素になることがあるので、ラベルに含むもので探す
    private func text(_ t: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", t)).firstMatch
    }

    func testDayPage() throws {
        app.goToDay("2026-11-27") // シードした日（前の日のボタンに頼らない）
        // 前の日（シードした日）: かけら6件が時刻順に並ぶ
        XCTAssertTrue(text("06:40").waitForExistence(timeout: 60))
        sleep(2)
        shot("1-list")
        let times = ["06:40", "09:15", "12:30", "15:05", "19:45", "23:58"]
        var lastY: CGFloat = -1
        for t in times {
            let e = text(t)
            scrollToShow(e)
            XCTAssertTrue(e.exists, t)
            if lastY >= 0, e.frame.minY < lastY { app.swipeDown() } // 位置の比較は同じ画面内でだけ
            lastY = e.frame.minY
        }
        app.swipeDown(); app.swipeDown(); app.swipeDown()

        // 気分のハンコは出さない（2026-11-28 に外した）
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "kibun-")).count, 0)

        // 場所を足す（Return では足さない）
        let field = byID("entryText")
        scrollToShow(app.buttons["entryKind-basho"])
        app.buttons["entryKind-basho"].tap()
        scrollToShow(field)
        field.tap()
        field.typeText("東京駅\n")
        sleep(2)
        // 足すと欄は空に戻る。Return の後も文字が残っていれば足していない（下の帯はキーボードの上にあり、見える行の数では比べない）
        XCTAssertTrue((field.value as? String ?? "").contains("東京駅"), "Return で追加しない")
        shot("3-basho-typed")
        scrollToShow(app.buttons["entryAdd"])
        app.buttons["entryAdd"].tap()
        XCTAssertTrue(waitFor(40) { !(self.field().value as? String ?? "").contains("東京駅") }, "足すと欄が空に戻る")
        scrollToShow(text("東京駅"))
        XCTAssertTrue(text("東京駅").exists)
        app.swipeDown(); app.swipeDown(); app.swipeDown()
        sleep(1)
        shot("4-basho-added")

        // かけらを足す
        scrollToShow(app.buttons["entryKind-kakera"])
        app.buttons["entryKind-kakera"].tap()
        scrollToShow(field)
        field.tap()
        field.typeText("入力欄から足したかけら")
        scrollToShow(app.buttons["entryAdd"])
        shot("5a-kakera-typed")
        app.buttons["entryAdd"].tap()
        XCTAssertTrue(waitFor(40) { !(self.field().value as? String ?? "").contains("足した") }, "足すと欄が空に戻る")
        scrollToShow(text("入力欄から足したかけら")) // 行は一覧の末尾（遅延で描くので下へ送って探す）
        if !text("入力欄から足したかけら").exists, let shots {
            shot("5x-debug")
            try? app.debugDescription.write(to: shots.appendingPathComponent("stage1-debug.txt"), atomically: true, encoding: .utf8)
        }
        XCTAssertTrue(text("入力欄から足したかけら").exists)
        shot("5-kakera-added")

        // 場所の × はすぐ消える
        // 足した場所＝最後の場所の行（23:59 近く。ほかの場所の行は残す）
        let places = deleteButtons("delete-basho-")
        let b = places.element(boundBy: places.count - 1)
        scrollToShow(b)
        b.tap()
        XCTAssertTrue(waitFor { !self.text("東京駅").exists })

        // かけらの × は念押しのあと消える（足したかけら＝最後の行）
        let rows = deleteButtons("delete-kakera-")
        let last = rows.element(boundBy: rows.count - 1)
        scrollToShow(last)
        last.tap()
        let confirm = app.buttons["消す"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        shot("6-confirm-delete")
        confirm.tap()
        XCTAssertTrue(waitFor { !self.text("入力欄から足したかけら").exists })
        app.swipeDown(); app.swipeDown(); app.swipeDown()
        sleep(1)
        shot("7-after-delete")
    }

    private func waitFor(_ seconds: TimeInterval = 20, _ cond: @escaping () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if cond() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
        return cond()
    }
}
