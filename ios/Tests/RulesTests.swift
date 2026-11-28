import XCTest
@testable import Kakera

/// Web 版から Swift に移した決まりが、Web と同じ入力で同じ出力になるか（かけら帳ネイティブ化設計 受け入れ条件）。
/// 期待値は Fixtures/rules.json（ios/scripts/rule-fixtures.ts が Web の関数そのものから書き出したもの・make fixtures）と、
/// vitest（src/lib/**/*.test.ts）の入出力の写し。
final class RulesTests: XCTestCase {
    private static let fixtures: [String: Any] = {
        let url = Bundle(for: RulesTests.self).url(forResource: "rules", withExtension: "json")!
        return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }()

    private func list(_ key: String) -> [[String: Any]] { Self.fixtures[key] as! [[String: Any]] }

    private func embedJSON(_ e: Embed?) -> [String: String]? {
        switch e {
        case .youtube(let id)?: return ["kind": "youtube", "id": id]
        case .tweet(let url)?: return ["kind": "tweet", "url": url]
        case .spotify(let type, let id)?: return ["kind": "spotify", "type": type, "id": id]
        case nil: return nil
        }
    }

    // MARK: 埋め込み（markdown.ts の matchEmbed・parseEmbedTokens）

    func testMatchEmbedSameAsWeb() {
        for c in list("embeds") {
            let url = c["url"] as! String
            XCTAssertEqual(embedJSON(Embed.match(url)), c["embed"] as? [String: String], url)
        }
    }

    func testEmbedLinesSameAsWeb() {
        for c in list("embedLines") {
            let text = c["text"] as! String
            let want = (c["lines"] as! [[String: Any]]).map { ($0["line"] as! Int, $0["embed"] as! [String: String]) }
            let got = Embed.lines(text).map { ($0.line, embedJSON($0.embed)!) }
            XCTAssertEqual(got.map(\.0), want.map(\.0), text)
            XCTAssertEqual(got.map(\.1), want.map(\.1), text)
        }
    }

    // MARK: 説明（diary-file.ts）

    func testDescriptionSameAsWeb() {
        for c in list("descriptions") {
            let input = c["input"] as! String
            XCTAssertEqual(Description.flatten(input), c["flat"] as! String, input.debugDescription)
            XCTAssertEqual(Description.length(Description.flatten(input)), c["length"] as! Int)
            XCTAssertEqual(Description.length(input), c["rawLength"] as! Int)
        }
        XCTAssertEqual(Description.max, 200)
    }

    // MARK: 時刻の札（time-label.ts・time-label.test.ts）

    func testTimeLabelSameAsWeb() {
        for c in list("times") {
            let w = c["written_at"] as! String, d = c["date"] as! String
            XCTAssertEqual(TimeLabel.label(w, katachiDate: d), c["label"] as! String)
            let head = c["head"] as! [String: String]
            XCTAssertEqual(TimeLabel.head(writtenAt: w, showTime: true, katachiDate: d), TimeHead(label: head["label"]!, datetime: head["datetime"]!))
        }
        // time-label.test.ts の写し
        XCTAssertEqual(TimeLabel.label("2026-10-10T23:59:00+09:00", katachiDate: "2026-10-10"), "23:59")
        XCTAssertEqual(TimeLabel.label("2026-10-11T00:00:00+09:00", katachiDate: "2026-10-10"), "10-11 00:00")
        XCTAssertNil(TimeLabel.head(writtenAt: "2026-10-10T06:00:00+09:00", showTime: false, katachiDate: "2026-10-10"))
        XCTAssertNil(TimeLabel.head(writtenAt: "2026-10-10T06:00:00+09:00", showTime: nil, katachiDate: "2026-10-10"))
    }

    // MARK: 言葉（markdown.ts の wrapWordCandidates・wordsOf）

    func testWrapWordCandidatesSameAsWeb() {
        for c in list("wraps") {
            let body = c["body"] as! String
            let spans = (c["candidates"] as! [[String: Any]]).map { ($0["start"] as! Int, $0["end"] as! Int) }
            XCTAssertEqual(WordRules.wrap(body, spans.map { (start: $0.0, end: $0.1) }), c["wrapped"] as! String, body)
        }
    }

    func testWordsOfSameAsWeb() {
        for c in list("wordsOf") {
            let body = c["body"] as! String
            XCTAssertEqual(WordRules.wordsOf(body), c["words"] as! [String], body)
        }
    }

    func testWordLinkEditsGroupByKakera() {
        // word-links.test.ts の wordLinkEdits と同じ考え: 選んだ行の無いかけらは含めない・同じかけらの行はまとめて囲む
        let rows = [
            WordPlanRow(key: "A:猫", kakeraId: "A", word: "猫", start: 0, end: 1, before: "", after: ""),
            WordPlanRow(key: "B:犬", kakeraId: "B", word: "犬", start: 2, end: 3, before: "", after: ""),
            WordPlanRow(key: "A:鳥", kakeraId: "A", word: "鳥", start: 2, end: 3, before: "", after: ""),
        ]
        let edits = WordRules.edits(rows, bodies: ["A": "猫と鳥", "B": "朝の犬", "C": "猫"])
        XCTAssertEqual(edits.map(\.id), ["A", "B"])
        XCTAssertEqual(edits.map(\.body), ["[[猫]]と[[鳥]]", "朝の[[犬]]"])
    }

    // MARK: 選ぶ・並べる（ComposeScreen.tsx・AssembleScreen.tsx）

    func testInsertPositionLikeAssembleScreen() {
        let w = ["a": "2026-11-01T08:00:00+09:00", "b": "2026-11-01T09:00:00+09:00", "c": "2026-11-01T10:00:00+09:00",
                 "x": "2026-11-01T09:00:00+09:00", "y": "2026-11-01T07:00:00+09:00"]
        XCTAssertEqual(OrderRules.insertPosition(["a", "c"], id: "b", writtenAt: w), 1)
        // 同じ時刻なら既存の後ろ（<=）
        XCTAssertEqual(OrderRules.insertPosition(["a", "b", "c"], id: "x", writtenAt: w), 2)
        // 手で並べ替えた後でも「written_at が以下の最後のかけら」の直後
        XCTAssertEqual(OrderRules.insertPosition(["c", "a"], id: "b", writtenAt: w), 2)
        // 前に来るものが無ければ先頭
        XCTAssertEqual(OrderRules.insertPosition(["a", "c"], id: "y", writtenAt: w), 0)
    }

    func testInitialOrderAndComposeDate() {
        let k = [("k2", "2026-11-02T08:00:00+09:00"), ("k1", "2026-11-01T08:00:00+09:00"), ("k3", "2026-11-01T08:00:00+09:00")]
        XCTAssertEqual(OrderRules.initialOrder(kakera: k.map { (id: $0.0, writtenAt: $0.1) }, publishedIds: []), ["k1", "k3", "k2"])
        XCTAssertEqual(OrderRules.initialOrder(kakera: k.map { (id: $0.0, writtenAt: $0.1) }, publishedIds: ["k2", "gone", "k1"]), ["k2", "k1"])
        XCTAssertEqual(OrderRules.composeDate(["k2", "k3"], writtenAt: Dictionary(uniqueKeysWithValues: k)), "2026-11-01")
        XCTAssertEqual(OrderRules.composeDate([], writtenAt: [:]), "")
        XCTAssertTrue(OrderRules.writtenOrder(("2026-11-01T08:00:00+09:00", "A"), ("2026-11-01T08:00:00+09:00", "B")))
    }

    // MARK: 縮める大きさ（fit-size.ts・fit-size.test.ts）

    func testFitUploadSizeSameAsWeb() {
        for c in list("upload") {
            let w = (c["w"] as! NSNumber).doubleValue, h = (c["h"] as! NSNumber).doubleValue
            let o = c["out"] as! [String: NSNumber]
            let got = FitSize.upload(w, h)
            XCTAssertEqual(got.width, o["width"]!.intValue, "\(w)×\(h)")
            XCTAssertEqual(got.height, o["height"]!.intValue, "\(w)×\(h)")
            XCTAssertEqual(got.scale, o["scale"]!.doubleValue, accuracy: 1e-12)
        }
    }

    func testCanvasSizeSameAsWeb() {
        for c in list("canvas") {
            let w = (c["w"] as! NSNumber).doubleValue, h = (c["h"] as! NSNumber).doubleValue
            let o = c["out"] as! [String: NSNumber]
            let got = FaceRules.canvasSize(w, h)
            XCTAssertEqual(got.width, o["width"]!.intValue, "\(w)×\(h)")
            XCTAssertEqual(got.height, o["height"]!.intValue, "\(w)×\(h)")
        }
        // photo-face.test.ts の写し
        XCTAssertEqual(FaceRules.canvasSize(3000, 9000, limit: .init(maxEdge: 4096, maxArea: 16_000_000)).width, 1365)
    }

    // MARK: 顔（photo-face.ts・photo-face.test.ts）

    func testFaceTilesSameAsWeb() {
        for c in list("tiles") {
            let w = c["w"] as! Int, h = c["h"] as! Int
            let want = (c["out"] as! [[String: Int]]).map { FaceRules.Rect(x: $0["x"]!, y: $0["y"]!, w: $0["w"]!, h: $0["h"]!) }
            XCTAssertEqual(FaceRules.tiles(w, h), want, "\(w)×\(h)")
        }
        // 4032×3024 を縮めた大きさで 150 区画（photo-face.test.ts）
        let c = FaceRules.canvasSize(4032, 3024)
        XCTAssertEqual(FaceRules.tiles(c.width, c.height).count, 150)
    }

    func testMosaicRectSameAsWeb() {
        for c in list("mosaic") {
            let f = c["face"] as! [String: Double]
            let o = c["out"] as! [String: Int]
            let r = FaceRules.mosaicRect(x: f["x"]!, y: f["y"]!, w: f["w"]!, h: f["h"]!, width: c["w"] as! Int, height: c["h"] as! Int)
            XCTAssertEqual([r.x, r.y, r.w, r.h, r.block], [o["x"]!, o["y"]!, o["w"]!, o["h"]!, o["block"]!])
        }
    }

    private func faces(_ raw: [[String: Any]]) -> [PhotoFace] {
        raw.map { PhotoFace(id: $0["id"] as! String, x: ($0["x"] as! NSNumber).doubleValue, y: ($0["y"] as! NSNumber).doubleValue,
                            w: ($0["w"] as! NSNumber).doubleValue, h: ($0["h"] as! NSNumber).doubleValue,
                            source: $0["source"] as! String, shown: $0["shown"] as! Bool) }
    }

    func testFingerprintSameAsWeb() {
        for c in list("fingerprints") {
            XCTAssertEqual(FaceRules.fingerprint(faces(c["faces"] as! [[String: Any]])), c["fp"] as? String)
        }
    }

    func testMergeDetectionsSameAsWeb() {
        for c in list("merges") {
            let found = (c["found"] as! [[String: NSNumber]]).map {
                FaceRules.Found(x: $0["x"]!.doubleValue, y: $0["y"]!.doubleValue, w: $0["w"]!.doubleValue, h: $0["h"]!.doubleValue, score: $0["score"]!.doubleValue)
            }
            XCTAssertEqual(FaceRules.merge(found), faces(c["out"] as! [[String: Any]]))
        }
    }

    func testNormalizeBoxSameAsWeb() {
        for c in list("boxes") {
            let b = c["box"] as! [String: NSNumber]
            let got = FaceRules.normalizeBox(x: b["x"]!.doubleValue, y: b["y"]!.doubleValue, w: b["w"]!.doubleValue, h: b["h"]!.doubleValue)
            if let o = c["out"] as? [String: NSNumber] {
                XCTAssertEqual(got.map { [$0.x, $0.y, $0.w, $0.h] }, [o["x"]!.doubleValue, o["y"]!.doubleValue, o["w"]!.doubleValue, o["h"]!.doubleValue])
            } else {
                XCTAssertNil(got)
            }
        }
    }

    func testFacePhotoKeyAndExifSameAsWeb() {
        for c in list("faceKeys") { XCTAssertEqual(FaceRules.isFacePhotoKey(c["key"] as! String), c["ok"] as! Bool, c["key"] as! String) }
        for c in list("exif") {
            XCTAssertEqual(FaceRules.hasExif(Data((c["bytes"] as! [Int]).map { UInt8($0) })), c["exif"] as! Bool)
        }
    }

    func testPixelateSameAsWeb() {
        let c = Self.fixtures["pixelate"] as! [String: Any]
        var data = (c["input"] as! [Int]).map { UInt8($0) }
        let r = c["rect"] as! [String: Int]
        FaceRules.pixelate(&data, width: c["width"] as! Int, x: r["x"]!, y: r["y"]!, w: r["w"]!, h: r["h"]!, block: r["block"]!)
        XCTAssertEqual(data, (c["output"] as! [Int]).map { UInt8($0) })
    }

    /// 作り直した JPEG に EXIF が載らない（サーバの /api/photo-face/masked は EXIF 入りを受け取らない）
    func testMaskedJpegHasNoExif() throws {
        let size = CGSize(width: 64, height: 48)
        let img = UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(origin: .zero, size: size))
            UIColor.blue.setFill(); ctx.fill(CGRect(x: 10, y: 10, width: 20, height: 20))
        }
        let canvas = Faces.Canvas(image: img.cgImage!, width: img.cgImage!.width, height: img.cgImage!.height)
        let jpeg = try Faces.mask(canvas, [PhotoFace(id: "a1", x: 0.1, y: 0.1, w: 0.4, h: 0.5, source: "auto", shown: false)])
        XCTAssertTrue(FaceRules.isJpeg(jpeg))
        XCTAssertFalse(FaceRules.hasExif(jpeg))
    }

    // MARK: 日付の見せ方（format.ts）

    func testDayText() {
        XCTAssertEqual(DayText.group("2026-09-12"), "09-12 (土)")
        XCTAssertEqual(DayText.heading("2026-09-12"), "2026-09-12 (土)")
        XCTAssertEqual(DayText.literary("2026-09-12"), "2026年9月12日（土）")
        XCTAssertEqual(DayText.month("2026-09"), "2026年9月")
        XCTAssertEqual(DayText.publishedURL("2026-11-28"), "https://www.kechiiiiin.com/diary/2026/11/28/")
        XCTAssertTrue(DayText.sameMinute("2026-11-28T08:00:00+09:00", "2026-11-28T08:00:59+09:00"))
    }

    func testHighlight() {
        let p = Highlight.pieces("京都で京都の朝", query: "京都")
        XCTAssertEqual(p.map(\.0), ["京都", "で", "京都", "の朝"])
        XCTAssertEqual(p.map(\.1), [true, false, true, false])
        XCTAssertEqual(Highlight.pieces("ABCabc", query: "b").filter(\.1).map(\.0), ["B", "b"])
    }
}
