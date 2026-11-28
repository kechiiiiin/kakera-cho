import XCTest

/// 1日のページの ☰（見た目の刷新・C 丸 2026-11-28）: かたちにする・かたち・日記・ことば・さがす・設定は ☰ の中に移った。
/// 項目は識別子で探し、見つからなければメニューの中の同じ字のボタンを押す（一覧の「設定」等と取り違えないように）
extension XCUIApplication {
    func tapMenu(_ id: String, label: String) {
        let menu = buttons["openMenu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 30), "☰ がある")
        menu.tap()
        let byID = buttons[id]
        if byID.waitForExistence(timeout: 3) { byID.tap(); return }
        let inMenu = collectionViews.buttons[label]
        if inMenu.waitForExistence(timeout: 3) { inMenu.tap(); return }
        buttons[label].firstMatch.tap()
    }
}

extension XCUIApplication {
    /// 月カレンダーからその日へ（日付が変わっても同じ日を開けるように。今月か前の月まで）
    func goToDay(_ d: String) {
        XCTAssertTrue(buttons["dayTitle"].waitForExistence(timeout: 30))
        buttons["dayTitle"].tap()
        let cell = buttons["cal-\(d)"]
        if !cell.waitForExistence(timeout: 10) { buttons["prevMonth"].tap() }
        XCTAssertTrue(cell.waitForExistence(timeout: 10), "月カレンダーに \(d)")
        cell.tap()
    }
}
