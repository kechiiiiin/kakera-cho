import XCTest
@testable import Kakera

/// 書く欄（MarkdownEditor.swift）の往復と、日本語入力・道具の検査（かけら帳ネイティブ化設計 受け入れ条件）。
/// 本番の全かけらの本文での検査は make roundtrip（本文は build/ にだけ置く・ここには書かない）。
@MainActor
final class EditorRoundTripTests: XCTestCase {
    /// 書く欄に入れて、飾りを付けて、描いて、取り出す
    private func roundTrip(_ body: String, cards: LinkCards = [:]) -> String {
        let c = MarkdownEditorController()
        c.textView.frame = CGRect(x: 0, y: 0, width: 375, height: 600)
        c.start(markdown: body, cards: cards, placeholder: "", focus: false)
        c.textView.layoutIfNeeded()
        c.textView.restyle()
        c.textView.layoutIfNeeded()
        return c.markdown
    }

    private let samples: [String] = [
        "",
        "一行",
        "末尾に空白  \n\n\n",
        "\n\n前に空行",
        "改行\r\nCRLF\rCR",
        "行区切り\u{2028}段落区切り\u{2029}NEL\u{0085}",
        "全角　空白と\u{00A0}NBSP と\tタブ",
        "絵文字😀👨‍👩‍👧と結合文字が\u{3099}と异体字葛\u{E0100}",
        "## 見出し\n### 小見出し\n# 大\n####### 七つ",
        "**太字** と ~~取消~~ と *斜体* と `code`",
        "- 一\n- 二\n  続き\n1. いち\n2) に\n> 引用\n>引用2",
        "---\n***\n___",
        "```\n**囲いの中**\n[[言葉]]\n```\n外",
        "[[言葉]]と[リンク](https://example.com)と https://example.com/a_(b)。",
        "写真\n![](/api/photo/kakera/2026/11/28_0800_01JXXXXXXXXXXXXXXXXXXXXXXX_1.jpg)\n![alt](/api/photo/kakera/2026/11/a.jpg \"題\")",
        "https://youtu.be/dQw4w9WgXcQ\n\nhttps://open.spotify.com/track/abc\n\nhttps://example.com/card",
        "\\*打ち消し\\* と \\[[x]] と <b>html</b> と &amp;",
        String(repeating: "長い本文。", count: 800),
    ]

    func testRoundTripSamples() {
        let card = LinkCard(url: "https://example.com/card", title: "例", description: "説明", siteName: "例", domain: "example.com", image: nil)
        for s in samples {
            XCTAssertEqual(roundTrip(s, cards: ["https://example.com/card": card]), s, s.debugDescription.prefix(60).description)
        }
    }

    /// 触らずに保存すると送らない（本文は1文字も変わらない）。直したら前後の空白を落として送る（Web と同じ）
    func testUntouchedSaveSendsNothing() {
        for s in samples where !s.isEmpty {
            XCTAssertNil(EditorView.bodyPatch(current: roundTrip(s), original: s))
        }
        XCTAssertEqual(EditorView.bodyPatch(current: "直した  \n", original: "元"), "直した")
        XCTAssertNil(EditorView.bodyPatch(current: "元\n", original: "元"))
    }

    /// 本番の全かけらの本文（make roundtrip が KAKERA_BODIES に置いた wrangler の --json の出力）。無ければ飛ばす
    func testRoundTripProductionBodies() throws {
        guard let path = ProcessInfo.processInfo.environment["KAKERA_BODIES"], !path.isEmpty else {
            throw XCTSkip("KAKERA_BODIES が無い（make roundtrip で回す）")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let json = try JSONSerialization.jsonObject(with: data)
        let rows: [[String: Any]] = ((json as? [[String: Any]])?.first?["results"] as? [[String: Any]]) ?? []
        XCTAssertFalse(rows.isEmpty, "本文を読めませんでした")
        var same = 0
        var differ: [String] = []
        for r in rows {
            guard let id = r["id"] as? String, let body = r["body"] as? String else { continue }
            if roundTrip(body) == body && EditorView.bodyPatch(current: roundTrip(body), original: body) == nil {
                same += 1
            } else {
                differ.append(id) // ⚠️ 本文はログに出さない（実名を含む）。id だけ
            }
        }
        print("roundtrip: \(rows.count) 件中 \(same) 件が一致・違う \(differ.count) 件 \(differ.prefix(20))")
        XCTAssertEqual(differ, [], "書く欄を通すと変わる本文があります（id だけ表示）")
    }

    // MARK: 日本語入力

    /// 変換中（markedText がある間）は飾りを付け直さず・知らせもしない。確定してから知らせる。Enter（確定）で何も送らない
    func testMarkedTextIsLeftAlone() {
        let c = MarkdownEditorController()
        c.textView.frame = CGRect(x: 0, y: 0, width: 375, height: 600)
        c.start(markdown: "**太字**の後に", cards: [:], placeholder: "", focus: false)
        var changes: [String] = []
        c.onChange = { changes.append($0) }
        c.textView.selectedRange = NSRange(location: (c.markdown as NSString).length, length: 0)
        c.textView.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0))
        c.textViewDidChange(c.textView)
        XCTAssertNotNil(c.textView.markedTextRange, "変換中の文字が確定されてしまった")
        XCTAssertEqual(changes, [], "変換中に知らせた")
        c.textView.setMarkedText("漢", selectedRange: NSRange(location: 1, length: 0))
        c.textViewDidChange(c.textView)
        XCTAssertNotNil(c.textView.markedTextRange)
        // 確定（日本語入力の Enter）。改行は入らず、保存もしない（保存はボタンだけ）
        c.textView.unmarkText()
        c.textViewDidChange(c.textView)
        XCTAssertEqual(c.markdown, "**太字**の後に漢")
        XCTAssertEqual(changes.last, "**太字**の後に漢")
        XCTAssertNil(c.textView.markedTextRange)
    }

    // MARK: 道具（文字を挿入・囲むだけ）

    private func editor(_ text: String, select: NSRange) -> MarkdownEditorController {
        let c = MarkdownEditorController()
        c.textView.frame = CGRect(x: 0, y: 0, width: 375, height: 600)
        c.start(markdown: text, cards: [:], placeholder: "", focus: false)
        c.textView.selectedRange = select
        return c
    }

    func testToolbarWrapsAndPrefixes() {
        var c = editor("猫と犬", select: NSRange(location: 0, length: 1))
        c.wrap("**")
        XCTAssertEqual(c.markdown, "**猫**と犬")
        c.wrap("**") // もう一度で外す
        XCTAssertEqual(c.markdown, "猫と犬")
        c = editor("猫と犬", select: NSRange(location: 2, length: 1))
        c.wrap("[[", "]]")
        XCTAssertEqual(c.markdown, "猫と[[犬]]")
        c = editor("一行目\n二行目", select: NSRange(location: 5, length: 0))
        c.heading(2)
        XCTAssertEqual(c.markdown, "一行目\n## 二行目")
        c.heading(3)
        XCTAssertEqual(c.markdown, "一行目\n### 二行目")
        c.heading(3)
        XCTAssertEqual(c.markdown, "一行目\n二行目")
        c = editor("一\n二\n三", select: NSRange(location: 0, length: 5))
        c.orderedList()
        XCTAssertEqual(c.markdown, "1. 一\n2. 二\n3. 三")
        c.bulletList()
        XCTAssertEqual(c.markdown, "- 一\n- 二\n- 三")
        c.bulletList()
        XCTAssertEqual(c.markdown, "一\n二\n三")
        c = editor("文", select: NSRange(location: 1, length: 0))
        c.horizontalRule()
        XCTAssertEqual(c.markdown, "文\n---\n")
        c = editor("見て", select: NSRange(location: 0, length: 2))
        c.link("https://example.com")
        XCTAssertEqual(c.markdown, "[見て](https://example.com)")
        c = editor("", select: NSRange(location: 0, length: 0))
        c.embed("https://youtu.be/dQw4w9WgXcQ")
        XCTAssertEqual(c.markdown, "https://youtu.be/dQw4w9WgXcQ\n")
        c.undo()
        XCTAssertEqual(c.markdown, "")
    }
}
