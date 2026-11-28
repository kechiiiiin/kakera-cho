import CryptoKit
import Foundation

// Web 版（src/lib/*.ts）の決まりのうち、画面が手元で当てる小さなものの写し（かけら帳ネイティブ化設計「共有データ」）。
// どれも Tests/RulesTests.swift で Web のテスト（vitest）と同じ入出力を確かめている。
// ⚠️ Web 側を直したら、ここも同じように直してテストを足すこと。
// 名前の置き換え・言葉の候補・抜粋のような大きな決まりは写さず、/api/native/* でサーバに当ててもらう（API.swift）。
// 位置（start・end）は Web と同じ UTF-16 の単位で扱う（NSString で切る）。

// MARK: - 時刻の札（src/lib/kakera/time-label.ts）

enum TimeLabel {
    /// かたちの日付と同じ日は HH:MM、違う日は MM-DD HH:MM、年まで違えば YYYY-MM-DD HH:MM
    static func label(_ writtenAt: String, katachiDate: String) -> String {
        let day = String(writtenAt.prefix(10))
        let hhmm = String(writtenAt.dropFirst(11).prefix(5))
        if day == katachiDate { return hhmm }
        if day.prefix(4) != katachiDate.prefix(4) { return "\(day) \(hhmm)" }
        return "\(day.dropFirst(5)) \(hhmm)"
    }

    static func head(writtenAt: String, showTime: Bool?, katachiDate: String) -> TimeHead? {
        guard showTime == true else { return nil }
        return TimeHead(label: label(writtenAt, katachiDate: katachiDate), datetime: writtenAt)
    }
}

// MARK: - 日記の説明（src/lib/publish/diary-file.ts）

enum Description {
    static let max = 200

    /// JavaScript の String.prototype.trim が落とす文字（WhiteSpace と LineTerminator）
    private static let jsSpace: CharacterSet = {
        var s = CharacterSet(charactersIn: "\u{0009}\u{000B}\u{000C}\u{0020}\u{00A0}\u{FEFF}\u{000A}\u{000D}\u{2028}\u{2029}")
        s.insert(charactersIn: "\u{1680}")
        s.insert(charactersIn: Unicode.Scalar(0x2000)!...Unicode.Scalar(0x200A)!)
        s.formUnion(CharacterSet(charactersIn: "\u{202F}\u{205F}\u{3000}"))
        return s
    }()

    static func jsTrim(_ s: String) -> String { s.trimmingCharacters(in: jsSpace) }

    private static let breaks = try! NSRegularExpression(pattern: "[ \\t]*[\\r\\n\\u0085\\u2028\\u2029]+[ \\t]*")

    /// 改行（CR/LF・U+0085・U+2028・U+2029）とタブを前後の半角空白ごと一つの空白に、前後の空白を落とす。全角空白は残す
    static func flatten(_ s: String) -> String {
        let ns = s as NSString
        let once = breaks.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: ns.length), withTemplate: " ")
        return jsTrim(once.replacingOccurrences(of: "\t", with: " "))
    }

    /// 文字数（コードポイント単位・Array.from(s).length と同じ）
    static func length(_ s: String) -> Int { s.unicodeScalars.count }
}

// MARK: - 日付の見せ方（src/components/format.ts）

enum DayText {
    private static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]

    static func weekday(_ dateKey: String) -> String {
        guard let r = JST.dayRange(dateKey) else { return "" }
        return weekdays[JST.calendar.component(.weekday, from: r.start) - 1]
    }

    /// 流れの日ごとの小見出し（例: 09-12 (土)）
    static func group(_ dateKey: String) -> String { "\(dateKey.dropFirst(5)) (\(weekday(dateKey)))" }

    /// 書く側の日付（例: 2026-09-12 (土)）
    static func heading(_ dateKey: String) -> String { "\(dateKey) (\(weekday(dateKey)))" }

    /// 読む側の日付（例: 2026年9月12日（土））
    static func literary(_ dateKey: String) -> String {
        let p = dateKey.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return dateKey }
        return "\(p[0])年\(p[1])月\(p[2])日（\(weekday(dateKey))）"
    }

    /// 月の見出し（例: 2026年9月）
    static func month(_ monthKey: String) -> String {
        let p = monthKey.split(separator: "-")
        guard p.count == 2, let m = Int(p[1]) else { return monthKey }
        return "\(p[0])年\(m)月"
    }

    /// 公開された日記の URL（NikkiListScreen.tsx の publishedUrl）
    static func publishedURL(_ date: String) -> String {
        "https://www.kechiiiiin.com/diary/\(date.replacingOccurrences(of: "-", with: "/"))/"
    }

    /// 分の単位で同じ日時か（WhenPicker.tsx の sameMinute）
    static func sameMinute(_ a: String, _ b: String) -> Bool { a.prefix(16) == b.prefix(16) }
}

// MARK: - 埋め込み（src/lib/markdown.ts の matchEmbed・parseEmbedTokens）

enum Embed: Hashable {
    case youtube(id: String)
    case tweet(url: String)
    case spotify(type: String, id: String)

    private static func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }
    private static let youtube = re(#"^https://(?:youtu\.be/|(?:www\.|m\.)?youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/))([A-Za-z0-9_-]{11})"#)
    private static let tweet = re(#"^https://(?:x\.com|(?:mobile\.)?twitter\.com)/[A-Za-z0-9_]+/status/\d+"#)
    private static let spotify = re(#"^https://open\.spotify\.com/(track|album|artist|playlist|episode|show)/([a-zA-Z0-9]+)"#)

    private static func groups(_ r: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = r.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    /// URL ひとつを埋め込みの種別に振り分ける。対象外なら nil
    static func match(_ url: String) -> Embed? {
        guard MD.isSafeHref(url) else { return nil }
        if let g = groups(youtube, url) { return .youtube(id: g[1]) }
        if groups(tweet, url) != nil { return .tweet(url: url) }
        if let g = groups(spotify, url) { return .spotify(type: g[1], id: g[2]) }
        return nil
    }

    /// 行として独立した埋め込みの URL（Spotify は前後が空行か本文の端のときだけ）。行の番号と埋め込み
    static func lines(_ text: String) -> [(line: Int, embed: Embed)] {
        let lines = text.components(separatedBy: "\n")
        let blank = { (s: String) in s.allSatisfy { $0 == " " || $0 == "\t" } }
        var out: [(Int, Embed)] = []
        for (i, line) in lines.enumerated() {
            guard !line.isEmpty, let e = match(line) else { continue }
            if case .spotify = e {
                let alone = (i == 0 || blank(lines[i - 1])) && (i == lines.count - 1 || blank(lines[i + 1]))
                if !alone { continue }
            }
            out.append((i, e))
        }
        return out
    }

    /// カードに出す名前と、押したときに開く URL（中で再生しない・アプリか Safari で開く）
    var title: String {
        switch self {
        case .youtube: return "YouTube"
        case .tweet: return "X（Twitter）のポスト"
        case .spotify(let type, _):
            let names = ["track": "曲", "album": "アルバム", "artist": "アーティスト", "playlist": "プレイリスト", "episode": "エピソード", "show": "番組"]
            return "Spotify の\(names[type] ?? type)"
        }
    }

    var openURL: URL? {
        switch self {
        case .youtube(let id): return URL(string: "https://www.youtube.com/watch?v=\(id)")
        case .tweet(let url): return URL(string: url)
        case .spotify(let type, let id): return URL(string: "https://open.spotify.com/\(type)/\(id)")
        }
    }
}

// MARK: - 言葉（src/lib/markdown.ts の wrapWordCandidates・wordsOf と word-links.ts の wordLinkEdits）

enum WordRules {
    /// 候補の範囲（UTF-16）を [[ ]] で囲む。後ろから当てる
    static func wrap(_ body: String, _ spans: [(start: Int, end: Int)]) -> String {
        var out = body as NSString
        for s in spans.sorted(by: { $0.start > $1.start }) {
            let inner = out.substring(with: NSRange(location: s.start, length: s.end - s.start))
            out = out.replacingCharacters(in: NSRange(location: s.start, length: s.end - s.start), with: "[[\(inner)]]") as NSString
        }
        return out as String
    }

    /// 選んだ行を、かけらごとの新しい本文にする（行の無いかけらは含めない・かけらは最初に出てきた順）
    static func edits(_ rows: [WordPlanRow], bodies: [String: String]) -> [(id: String, body: String)] {
        var order: [String] = []
        var by: [String: [WordPlanRow]] = [:]
        for r in rows {
            if by[r.kakeraId] == nil { order.append(r.kakeraId) }
            by[r.kakeraId, default: []].append(r)
        }
        return order.compactMap { id in
            guard let body = bodies[id], let list = by[id] else { return nil }
            return (id, wrap(body, list.map { ($0.start, $0.end) }))
        }
    }

    /// 本文に出てくる言葉（重複なし・出てきた順）。読む画面が言葉のリンクに描くものと同じ
    static func wordsOf(_ body: String) -> [String] {
        var seen: [String] = []
        func walk(_ nodes: [Inline]) {
            for n in nodes {
                switch n {
                case .word(let w, _): if !seen.contains(w) { seen.append(w) }
                case .strong(let k), .em(let k), .del(let k): walk(k)
                default: break
                }
            }
        }
        walk(InlineParser.parse(body))
        return seen
    }
}

// MARK: - 選ぶ・並べる（ComposeScreen.tsx・AssembleScreen.tsx）

enum OrderRules {
    /// 書いた順（古い順・同時刻は id 順）。サーバの WRITTEN_ORDER と揃える
    static func writtenOrder(_ a: (writtenAt: String, id: String), _ b: (writtenAt: String, id: String)) -> Bool {
        if a.writtenAt != b.writtenAt { return a.writtenAt < b.writtenAt }
        return a.id < b.id
    }

    /// かたちの日付の既定: 選んだ中で一番古いかけらの日
    static func composeDate(_ picked: [String], writtenAt: [String: String]) -> String {
        let min = picked.compactMap { writtenAt[$0] }.min()
        return min.map { String($0.prefix(10)) } ?? ""
    }

    /// 日記の並びに新しく選んだかけらを差し込む位置: written_at が同じか前の最後のかけらの直後（無ければ先頭）
    static func insertPosition(_ current: [String], id: String, writtenAt: [String: String]) -> Int {
        guard let target = writtenAt[id] else { return current.count }
        var last = -1
        for (i, x) in current.enumerated() {
            if let w = writtenAt[x], w <= target { last = i }
        }
        return last + 1
    }

    /// 日記に出すかけらの既定の並び（初めては全部を書いた順・同時刻は元の並び。書き足すときは前回出したもの）
    static func initialOrder(kakera: [(id: String, writtenAt: String)], publishedIds: [String]) -> [String] {
        if publishedIds.isEmpty {
            return kakera.enumerated()
                .sorted { a, b in a.element.writtenAt != b.element.writtenAt ? a.element.writtenAt < b.element.writtenAt : a.offset < b.offset }
                .map(\.element.id)
        }
        let ids = Set(kakera.map(\.id))
        return publishedIds.filter { ids.contains($0) }
    }
}

// MARK: - 縮める大きさ（src/lib/image/fit-size.ts）

enum FitSize {
    struct Limit { let maxEdge: Double; let maxArea: Double }
    static let longAspect = 2.0
    static let uploadNormal = Limit(maxEdge: 16_384, maxArea: 2048 * 2048)
    static let uploadLong = Limit(maxEdge: 16_384, maxArea: 12_000_000)

    static func aspect(_ w: Double, _ h: Double) -> Double {
        guard w > 0, h > 0 else { return 0 }
        return max(w, h) / min(w, h)
    }

    /// 縦横比を保って上限の内側に（大きくしない・丸めで上限を越えない）
    static func fit(_ width: Double, _ height: Double, _ limit: Limit) -> (width: Int, height: Int, scale: Double) {
        guard width > 0, height > 0 else { return (0, 0, 0) }
        let scale = min(1, limit.maxEdge / max(width, height), (limit.maxArea / (width * height)).squareRoot())
        if scale >= 1 { return (Int(width), Int(height), 1) }
        var w = max(1, Int(floor(width * scale)))
        var h = max(1, Int(floor(height * scale)))
        while Double(w * h) > limit.maxArea {
            if w >= h {
                w = max(1, w - 1)
                h = max(1, Int(floor(Double(w) * height / width)))
            } else {
                h = max(1, h - 1)
                w = max(1, Int(floor(Double(h) * width / height)))
            }
        }
        return (w, h, Double(w) / width)
    }

    /// アップロード前（普通の写真は面積 ≤ 2048×2048、細長い画像は面積 ≤ 12MP・長辺 ≤ 16384px）
    static func upload(_ w: Double, _ h: Double) -> (width: Int, height: Int, scale: Double) {
        fit(w, h, aspect(w, h) > longAspect ? uploadLong : uploadNormal)
    }
}

// MARK: - 顔（src/lib/publish/photo-face.ts）

enum FaceRules {
    static let maxFaces = 200
    static let mosaicExpand = 0.2
    static let mosaicBlockDiv = 8.0
    static let mosaicMinBlock = 8
    static let mosaicVersion = "v1"
    static let canvasEdge = 4096.0
    static let canvasEdgeLong = 16_384.0
    static let canvasArea = 16_000_000.0
    static let tileSizes = [1024, 384]

    private static let facePhotoKey = try! NSRegularExpression(pattern: #"^kakera/\d{4}/\d{2}/[A-Za-z0-9_.-]+$"#)

    /// 顔の検出・モザイクをかける写真か（かけらに貼った写真だけ）
    static func isFacePhotoKey(_ key: String) -> Bool {
        let ns = key as NSString
        return facePhotoKey.firstMatch(in: key, range: NSRange(location: 0, length: ns.length)) != nil && !key.contains("..")
    }

    static func round4(_ n: Double) -> Double { (n * 10000).rounded(.toNearestOrAwayFromZero) / 10000 }
    private static func clamp01(_ n: Double) -> Double { min(1, max(0, n)) }

    /// 比率の枠を写真の内側に収めて小数 4 桁に丸める。小さすぎる枠は nil
    static func normalizeBox(x: Double, y: Double, w: Double, h: Double) -> (x: Double, y: Double, w: Double, h: Double)? {
        guard [x, y, w, h].allSatisfy(\.isFinite) else { return nil }
        let x0 = clamp01(x), y0 = clamp01(y), x1 = clamp01(x + w), y1 = clamp01(y + h)
        let bw = round4(x1 - x0), bh = round4(y1 - y0)
        if bw < 0.002 || bh < 0.002 { return nil }
        return (round4(x0), round4(y0), bw, bh)
    }

    static func hidden(_ faces: [PhotoFace]) -> [PhotoFace] { faces.filter { !$0.shown } }

    /// 隠す枠の指紋（SHA-256 の先頭 8 桁）。隠す枠が無ければ nil。並び・出す枠・id に左右されない
    static func fingerprint(_ faces: [PhotoFace]) -> String? {
        let parts = hidden(faces).map { f in
            [f.x, f.y, f.w, f.h].map { String(format: "%.4f", round4($0)) }.joined(separator: ",")
        }.sorted()
        guard !parts.isEmpty else { return nil }
        let text = "\(mosaicVersion)|\(parts.joined(separator: "|"))"
        let digest = SHA256.hash(data: Data(text.utf8))
        return digest.prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    static func iou(_ a: (x: Double, y: Double, w: Double, h: Double), _ b: (x: Double, y: Double, w: Double, h: Double)) -> Double {
        let ix = max(0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x))
        let iy = max(0, min(a.y + a.h, b.y + b.h) - max(a.y, b.y))
        let inter = ix * iy
        let union = a.w * a.h + b.w * b.h - inter
        return union > 0 ? inter / union : 0
    }

    struct Found { let x: Double; let y: Double; let w: Double; let h: Double; let score: Double }

    /// 全体と区画で検出した枠を一つにまとめる（IoU 0.3 以上か、小さい方の 6 割以上が入るなら確からしい方を残す）。全部「隠す」で始める
    static func merge(_ found: [Found]) -> [PhotoFace] {
        typealias Box = (x: Double, y: Double, w: Double, h: Double)
        var boxed: [(box: Box, score: Double)] = []
        for f in found {
            if let b = normalizeBox(x: f.x, y: f.y, w: f.w, h: f.h) { boxed.append((b, f.score)) }
        }
        // 確からしい順（同じなら元の並び・JS の sort は安定）
        let indexed = Array(boxed.enumerated())
        let sorted: [(box: Box, score: Double)] = indexed.sorted { a, b in
            if a.element.score != b.element.score { return a.element.score > b.element.score }
            return a.offset < b.offset
        }.map { $0.element }
        var kept: [(box: Box, score: Double)] = []
        for f in sorted {
            let dup = kept.contains { k in
                if iou(k.box, f.box) >= 0.3 { return true }
                let ix = max(0, min(k.box.x + k.box.w, f.box.x + f.box.w) - max(k.box.x, f.box.x))
                let iy = max(0, min(k.box.y + k.box.h, f.box.y + f.box.h) - max(k.box.y, f.box.y))
                let small = min(k.box.w * k.box.h, f.box.w * f.box.h)
                return small > 0 && (ix * iy) / small >= 0.6
            }
            if !dup { kept.append(f) }
        }
        return kept.enumerated()
            .sorted { a, b in
                if a.element.box.y != b.element.box.y { return a.element.box.y < b.element.box.y }
                if a.element.box.x != b.element.box.x { return a.element.box.x < b.element.box.x }
                return a.offset < b.offset
            }
            .prefix(maxFaces)
            .enumerated()
            .map { i, f in
                PhotoFace(id: "a\(i + 1)", x: f.element.box.x, y: f.element.box.y, w: f.element.box.w, h: f.element.box.h, source: "auto", shown: false)
            }
    }

    /// 検出・モザイクに使う大きさ（面積 16MP 以下・長辺 4096px、細長い画像は 16384px 以下）
    static func canvasSize(_ w: Double, _ h: Double, limit: FitSize.Limit? = nil) -> (width: Int, height: Int, scale: Double) {
        let lim = limit ?? (FitSize.aspect(w, h) > FitSize.longAspect
            ? FitSize.Limit(maxEdge: canvasEdgeLong, maxArea: canvasArea)
            : FitSize.Limit(maxEdge: canvasEdge, maxArea: canvasArea))
        return FitSize.fit(w, h, lim)
    }

    struct Rect: Hashable { let x: Int; let y: Int; let w: Int; let h: Int }

    /// 区画（大きさごとに 2 割重ねて端まで。写真がその大きさ以下なら作らない）
    static func tiles(_ width: Int, _ height: Int, sizes: [Int] = tileSizes, overlap: Double = 0.2) -> [Rect] {
        var out: [Rect] = []
        for tile in sizes {
            if max(width, height) <= tile { continue }
            func along(_ len: Int) -> [(Int, Int)] {
                let size = min(tile, len)
                if size >= len { return [(0, len)] }
                let step = max(1, Int(floor(Double(size) * (1 - overlap))))
                var starts: [Int] = []
                var s = 0
                while s + size < len { starts.append(s); s += step }
                let end = len - size
                let last = starts[starts.count - 1]
                if starts.count > 1 && Double(end - last) < Double(size) * 0.1 { starts[starts.count - 1] = end } else { starts.append(end) }
                var seen = Set<Int>()
                return starts.filter { seen.insert($0).inserted }.map { ($0, size) }
            }
            for (y, h) in along(height) { for (x, w) in along(width) { out.append(Rect(x: x, y: y, w: w, h: h)) } }
        }
        return out
    }

    /// モザイクをかける四角とブロック（枠を 20% 広げる・ブロックは顔の幅の 1/8、最小 8px）
    static func mosaicRect(x: Double, y: Double, w: Double, h: Double, width: Int, height: Int) -> (x: Int, y: Int, w: Int, h: Int, block: Int) {
        let W = Double(width), H = Double(height)
        let fw = w * W, fh = h * H
        let x0 = max(0, Int(floor(x * W - fw * mosaicExpand)))
        let y0 = max(0, Int(floor(y * H - fh * mosaicExpand)))
        let x1 = min(width, Int(ceil(x * W + fw * (1 + mosaicExpand))))
        let y1 = min(height, Int(ceil(y * H + fh * (1 + mosaicExpand))))
        let block = max(mosaicMinBlock, Int((fw / mosaicBlockDiv).rounded(.toNearestOrAwayFromZero)))
        return (x0, y0, max(0, x1 - x0), max(0, y1 - y0), block)
    }

    /// RGBA の画素列の四角い範囲を、ブロックごとの平均色で塗りつぶす（ぼかしではなくモザイク）
    static func pixelate(_ data: inout [UInt8], width: Int, x rx: Int, y ry: Int, w rw: Int, h rh: Int, block: Int) {
        var by = ry
        while by < ry + rh {
            var bx = rx
            while bx < rx + rw {
                let ex = min(bx + block, rx + rw), ey = min(by + block, ry + rh)
                var r = 0, g = 0, b = 0, a = 0, n = 0
                for yy in by..<ey {
                    for xx in bx..<ex {
                        let i = (yy * width + xx) * 4
                        r += Int(data[i]); g += Int(data[i + 1]); b += Int(data[i + 2]); a += Int(data[i + 3]); n += 1
                    }
                }
                if n > 0 {
                    func avg(_ v: Int) -> UInt8 { UInt8((Double(v) / Double(n)).rounded(.toNearestOrAwayFromZero)) }
                    let c = [avg(r), avg(g), avg(b), avg(a)]
                    for yy in by..<ey {
                        for xx in bx..<ex {
                            let i = (yy * width + xx) * 4
                            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3]
                        }
                    }
                }
                bx += block
            }
            by += block
        }
    }
}

// MARK: - 検索の当たり（KatachiListScreen.tsx の highlight）

enum Highlight {
    /// 小文字にして探し、当たった所を印にした切れ（文字・当たりか）
    static func pieces(_ text: String, query: String) -> [(String, Bool)] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [(text, false)] }
        let ns = text as NSString
        let lower = text.lowercased() as NSString
        let needle = q.lowercased()
        let qlen = (q as NSString).length
        guard lower.length == ns.length else { return [(text, false)] } // 小文字で長さが変わる文字は印を付けない
        var out: [(String, Bool)] = []
        var i = 0
        while i < ns.length {
            let r = lower.range(of: needle, range: NSRange(location: i, length: ns.length - i))
            if r.location == NSNotFound { out.append((ns.substring(from: i), false)); break }
            if r.location > i { out.append((ns.substring(with: NSRange(location: i, length: r.location - i)), false)) }
            let len = min(qlen, ns.length - r.location)
            out.append((ns.substring(with: NSRange(location: r.location, length: len)), true))
            i = r.location + len
        }
        return out
    }
}
