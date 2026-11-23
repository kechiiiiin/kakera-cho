import SwiftUI
import UIKit

// かけらの本文を Web 版（src/components/RichText.tsx・src/lib/markdown.ts）と同じ規則で描く。
//   写真の記法 `![](url)` → 幅いっぱいの写真（.assembled-photo）。縦長（高さ÷幅 > 2）は正方形で切って下をぼかす（.tall-img）
//   行として独立した URL でカードがあるもの → リンクカード（.link-card）。カードが無い URL は朱の素のリンク
//   見出し・箇条書き・番号付き・引用・区切り線（splitBlocks の写し）
//   行内: `code`・**太字**・~~打ち消し~~・*斜体*・[文字](url)・[[言葉]]・裸の URL（parseInline の写し）
// ⚠️ Web 側の規則を直したら、ここも同じように直すこと。X / YouTube / Spotify の埋め込みは開かず、素のリンクで代用する

// MARK: - リンクカード（/api/kakera が本文と一緒に返す cards）

/// src/lib/card/types.ts の LinkCard と同じ形
struct LinkCard: Decodable, Hashable {
    let url: String
    let title: String
    let description: String
    let siteName: String?
    let domain: String
    let image: String?
}

typealias LinkCards = [String: LinkCard]

// MARK: - 文字の読み方（markdown.ts の写し）

enum MD {
    static let escapable = Set("\\`*_~[]()!#-<>&|")

    /// http / https だけ。空白・山括弧・引用符・制御文字を含むものは弾く
    static func isSafeHref(_ url: String) -> Bool {
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if u.isEmpty { return false }
        for s in u.unicodeScalars {
            if s.properties.isWhitespace || "<>\"'".unicodeScalars.contains(s) { return false }
            if s.value < 0x21 || s.value == 0x7F { return false }
        }
        let lower = u.lowercased()
        return (lower.hasPrefix("http://") && u.count > 7) || (lower.hasPrefix("https://") && u.count > 8)
    }

    private static func isUrlChar(_ c: Character) -> Bool {
        guard let a = c.asciiValue else { return false }
        return a >= 0x21 && a <= 0x7E
    }

    /// 裸の URL の終わり（ASCII の印字可能文字だけ・釣り合わない閉じ括弧と文末の記号は外す）
    static func matchBareUrl(_ t: [Character], _ i: Int) -> (url: String, end: Int)? {
        var j = i
        while j < t.count, isUrlChar(t[j]) { j += 1 }
        var url = String(t[i..<j])
        let lower = url.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return nil }
        while url.hasSuffix(")") {
            let opens = url.filter { $0 == "(" }.count
            let closes = url.filter { $0 == ")" }.count
            if opens >= closes { break }
            url.removeLast()
        }
        let trailing = Set(".,!?:;'\"`]}>")
        while let last = url.last, trailing.contains(last) { url.removeLast() }
        guard isSafeHref(url) else { return nil }
        return (url, i + url.count)
    }

    /// 行として独立した URL か（parseStandaloneUrls と同じ条件）
    static func standaloneUrl(_ line: String) -> String? {
        guard !line.isEmpty, isSafeHref(line), let m = matchBareUrl(Array(line), 0), m.url == line else { return nil }
        return line
    }

    private static let tracking: Set<String> = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
                                                "fbclid", "gclid", "mc_cid", "mc_eid", "ref_src"]

    /// カードを引くキー（src/lib/card/url.ts の normalizeUrl と同じ規則に寄せる）
    static func normalizeUrl(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isSafeHref(s), var c = URLComponents(string: s), let scheme = c.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = c.host, !host.isEmpty else { return nil }
        c.scheme = scheme
        c.host = host.lowercased()
        c.fragment = nil
        if c.percentEncodedPath.isEmpty { c.percentEncodedPath = "/" }
        if let items = c.queryItems, items.contains(where: { tracking.contains($0.name) }) {
            let kept = items.filter { !tracking.contains($0.name) }
            c.queryItems = kept.isEmpty ? nil : kept
        }
        if (scheme == "https" && c.port == 443) || (scheme == "http" && c.port == 80) { c.port = nil }
        return c.string
    }

    static func card(for url: String, in cards: LinkCards) -> LinkCard? {
        if let key = normalizeUrl(url), let hit = cards[key] { return hit }
        if let hit = cards[url] { return hit }
        let key = normalizeUrl(url)
        return cards.values.first { $0.url == key || $0.url == url }
    }
}

// MARK: - 行内書式

indirect enum Inline {
    case text(String)
    case code(String)
    case strong([Inline])
    case em([Inline])
    case del([Inline])
    case link(String, [Inline])
    case word([Inline])
}

enum InlineParser {
    static func parse(_ text: String) -> [Inline] { nodes(Array(text), noWord: false, noLink: false) }

    private static func starts(_ t: [Character], _ mark: String, _ i: Int) -> Bool {
        let m = Array(mark)
        guard i + m.count <= t.count else { return false }
        return Array(t[i..<(i + m.count)]) == m
    }

    private static func blankLineAt(_ t: [Character], _ i: Int) -> Bool {
        i + 1 < t.count && t[i] == "\n" && t[i + 1] == "\n"
    }

    private static func findClosing(_ t: [Character], _ from: Int, _ mark: String) -> Int {
        var i = from
        while i < t.count {
            if t[i] == "\\" { i += 2; continue }
            if blankLineAt(t, i) { return -1 }
            if starts(t, mark, i) {
                if mark == "*" && i + 1 < t.count && t[i + 1] == "*" { i += 2; continue }
                return i
            }
            i += 1
        }
        return -1
    }

    /// `[ラベル](URL)`
    private static func matchLink(_ t: [Character], _ i: Int) -> (label: [Character], href: String, raw: String, end: Int)? {
        var depth = 0
        var j = i
        while j < t.count {
            let c = t[j]
            if c == "\\" { j += 2; continue }
            if blankLineAt(t, j) { return nil }
            if c == "[" { depth += 1 } else if c == "]" { depth -= 1; if depth == 0 { break } }
            j += 1
        }
        guard j + 1 < t.count, t[j] == "]", t[j + 1] == "(" else { return nil }
        var close = -1
        var k = j + 2
        while k < t.count {
            let c = t[k]
            if c == "\\" { k += 2; continue }
            if c == "\n" { return nil }
            if c == ")" { close = k; break }
            k += 1
        }
        guard close >= 0 else { return nil }
        let dest = String(t[(j + 2)..<close]).trimmingCharacters(in: .whitespaces)
        let href = dest.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        return (Array(t[(i + 1)..<j]), href, String(t[i...close]), close + 1)
    }

    /// `[[言葉]]`（`[ ] 改行` を含まない1文字以上）
    private static func matchWord(_ t: [Character], _ i: Int) -> (inner: [Character], end: Int)? {
        guard starts(t, "[[", i) else { return nil }
        var j = i + 2
        while j < t.count, t[j] != "[", t[j] != "]", t[j] != "\n" { j += 1 }
        guard j > i + 2, starts(t, "]]", j) else { return nil }
        let inner = Array(t[(i + 2)..<j])
        let word = String(inner).replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "~~", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if word.isEmpty { return nil }
        if String(inner).range(of: "`[^`]+`", options: .regularExpression) != nil { return nil }
        return (inner, j + 2)
    }

    private static func nodes(_ t: [Character], noWord: Bool, noLink: Bool) -> [Inline] {
        var out: [Inline] = []
        var buf = ""
        var i = 0
        func flush() { if !buf.isEmpty { out.append(.text(buf)); buf = "" } }

        while i < t.count {
            let c = t[i]
            if c == "\\", i + 1 < t.count, MD.escapable.contains(t[i + 1]) {
                buf.append(t[i + 1]); i += 2; continue
            }
            // 画像記法は文字のまま（写真は別に描く）
            if c == "!", i + 1 < t.count, t[i + 1] == "[", let img = matchLink(t, i + 1) {
                buf += String(t[i..<img.end]); i = img.end; continue
            }
            if c == "`", let close = t[(i + 1)...].firstIndex(of: "`"), close > i + 1 {
                flush(); out.append(.code(String(t[(i + 1)..<close]))); i = close + 1; continue
            }
            if c == "[" {
                let m = noLink ? nil : matchLink(t, i)
                if let m, MD.isSafeHref(m.href) {
                    flush()
                    out.append(.link(m.href.trimmingCharacters(in: .whitespaces), nodes(m.label, noWord: true, noLink: false)))
                    i = m.end; continue
                }
                if let w = matchWord(t, i) {
                    flush()
                    let children = nodes(w.inner, noWord: true, noLink: true)
                    if noWord { out.append(contentsOf: children) } else { out.append(.word(children)) }
                    i = w.end; continue
                }
                if let m {
                    flush(); out.append(.text(m.raw)); i = m.end; continue
                }
            }
            if !noLink, c == "h" || c == "H", let u = MD.matchBareUrl(t, i) {
                flush(); out.append(.link(u.url, [.text(u.url)])); i = u.end; continue
            }
            var matched = false
            for (mark, kind) in [("**", 0), ("~~", 1), ("*", 2)] where starts(t, mark, i) {
                let from = i + mark.count
                let close = findClosing(t, from, mark)
                guard close > from else { continue }
                let inner = Array(t[from..<close])
                if inner.first?.isWhitespace == true || inner.last?.isWhitespace == true { continue }
                flush()
                let kids = nodes(inner, noWord: noWord, noLink: noLink)
                out.append(kind == 0 ? .strong(kids) : kind == 1 ? .del(kids) : .em(kids))
                i = close + mark.count
                matched = true
                break
            }
            if matched { continue }
            buf.append(c)
            i += 1
        }
        flush()
        return out
    }
}

/// 行内の木を AttributedString に（色は朱ひとつ・リンクは細い下線）
struct InlineStyle {
    var size: CGFloat = 16
    var bold = false
    var italic = false
    var strike = false
    var color: Color = Theme.ink

    func font() -> Font {
        let f = Theme.gothic(size, weight: bold ? .bold : .regular)
        return italic ? f.italic() : f
    }
}

enum InlineRender {
    static func attributed(_ nodes: [Inline], _ s: InlineStyle) -> AttributedString {
        var out = AttributedString()
        for n in nodes { out += piece(n, s) }
        return out
    }

    private static func plain(_ text: String, _ s: InlineStyle) -> AttributedString {
        var a = AttributedString(text)
        a.font = s.font()
        a.foregroundColor = s.strike ? Theme.muted : s.color
        if s.strike { a.strikethroughStyle = .init(pattern: .solid, color: Theme.muted) }
        return a
    }

    private static func piece(_ n: Inline, _ s: InlineStyle) -> AttributedString {
        switch n {
        case .text(let v):
            return plain(v, s)
        case .code(let v):
            var a = AttributedString(v)
            a.font = Theme.mono(s.size * 0.92)
            a.foregroundColor = s.color
            a.backgroundColor = Theme.line
            return a
        case .strong(let kids):
            var t = s; t.bold = true
            return attributed(kids, t)
        case .em(let kids):
            var t = s; t.italic = true
            return attributed(kids, t)
        case .del(let kids):
            var t = s; t.strike = true
            return attributed(kids, t)
        case .link(let href, let kids):
            var t = s; t.color = Theme.accent
            var a = attributed(kids, t)
            a.underlineStyle = .init(pattern: .solid, color: Theme.accent)
            if let u = URL(string: href) { a.link = u }
            return a
        case .word(let kids):
            // 言葉のリンク（Web の a.word-link: 朱・1px の下線）。iOS には言葉のページが無いので押せない飾り
            var t = s; t.color = Theme.accent
            var a = attributed(kids, t)
            a.underlineStyle = .init(pattern: .solid, color: Theme.accent)
            return a
        }
    }
}

// MARK: - 行のまとまり（RichText.tsx の splitBlocks の写し）

enum Seg {
    case text(String)
    case blank(Int)
    case heading(Int, String)
    case ul([String])
    case ol(Int, [String])
    case quote(String)
    case hr
}

enum BlockSplitter {
    private static func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }
    private static let hrLine = re(#"^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$"#)
    private static let fenceLine = re(#"^ {0,3}(`{3,}|~{3,})"#)
    private static let heading = re(#"^(#{1,6}) (.*)$"#)
    private static let bullet = re(#"^([-*+]) (.*)$"#)
    private static let ordered = re(#"^(\d{1,9})([.)]) (.*)$"#)
    private static let cont = re(#"^ {2,}(\S.*)$"#)

    private static func groups(_ r: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = r.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    static func split(_ text: String) -> [Seg] {
        let lines = text.components(separatedBy: "\n")
        var segs: [Seg] = []
        var buf: [String] = []
        var fence: String?

        func flush() {
            guard !buf.isEmpty else { return }
            var a = 0, b = buf.count
            while a < b && buf[a].isEmpty { a += 1 }
            while b > a && buf[b - 1].isEmpty { b -= 1 }
            if a > 0 { segs.append(.blank(a)) }
            if b > a { segs.append(.text(buf[a..<b].joined(separator: "\n"))) }
            if buf.count - b > 0 && b > a { segs.append(.blank(buf.count - b)) }
            buf = []
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            if let f = fence {
                buf.append(line)
                if let g = groups(fenceLine, line), g[1].first == f.first, g[1].count >= f.count,
                   line.trimmingCharacters(in: .whitespaces) == g[1] { fence = nil }
                i += 1; continue
            }
            if let g = groups(fenceLine, line) { fence = g[1]; buf.append(line); i += 1; continue }
            if groups(hrLine, line) != nil { flush(); segs.append(.hr); i += 1; continue }
            if let h = groups(heading, line), !h[2].trimmingCharacters(in: .whitespaces).isEmpty {
                flush(); segs.append(.heading(h[1].count, h[2])); i += 1; continue
            }
            let bm = groups(bullet, line)
            let om = bm == nil ? groups(ordered, line) : nil
            if bm != nil || om != nil {
                flush()
                var items: [String] = []
                while i < lines.count {
                    let l = lines[i]
                    let m = groups(hrLine, l) != nil ? nil : groups(bm != nil ? bullet : ordered, l)
                    if let m, bm != nil ? m[1] == bm![1] : m[2] == om![2] {
                        items.append(bm != nil ? m[2] : m[3]); i += 1; continue
                    }
                    if let c = groups(cont, l), !items.isEmpty { items[items.count - 1] += "\n" + c[1]; i += 1; continue }
                    break
                }
                segs.append(bm != nil ? .ul(items) : .ol(Int(om![1]) ?? 1, items))
                continue
            }
            if line.hasPrefix(">") {
                flush()
                var inner: [String] = []
                while i < lines.count, lines[i].hasPrefix(">") {
                    var l = String(lines[i].dropFirst())
                    if l.hasPrefix(" ") { l.removeFirst() }
                    inner.append(l); i += 1
                }
                segs.append(.quote(inner.joined(separator: "\n")))
                continue
            }
            buf.append(line)
            i += 1
        }
        flush()
        return segs
    }
}

// MARK: - 本文の割り方（写真・カード）

enum RichPart: Identifiable {
    case text(Int, String)
    case photo(Int, String)
    case card(Int, String, LinkCard)

    var id: Int {
        switch self { case .text(let i, _), .photo(let i, _), .card(let i, _, _): return i }
    }
}

enum RichSplitter {
    private static let imageToken = try! NSRegularExpression(pattern: #"!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#)

    static func parts(_ body: String, cards: LinkCards) -> [RichPart] {
        let ns = body as NSString
        enum K { case photo(String), card(String, LinkCard) }
        var slots: [(NSRange, K)] = imageToken.matches(in: body, range: NSRange(location: 0, length: ns.length)).map {
            ($0.range, .photo(ns.substring(with: $0.range(at: 1))))
        }
        var pos = 0
        for line in body.components(separatedBy: "\n") {
            let len = (line as NSString).length
            if let url = MD.standaloneUrl(line), let card = MD.card(for: url, in: cards) {
                slots.append((NSRange(location: pos, length: len), .card(url, card)))
            }
            pos += len + 1
        }
        slots.sort { $0.0.location < $1.0.location }

        var out: [RichPart] = []
        var at = 0
        var n = 0
        func addText(_ r: NSRange) {
            guard r.length > 0 else { return }
            let chunk = ns.substring(with: r).trimmingCharacters(in: .whitespacesAndNewlines)
            if !chunk.isEmpty { out.append(.text(n, chunk)); n += 1 }
        }
        for (r, k) in slots where r.location >= at {
            addText(NSRange(location: at, length: r.location - at))
            switch k {
            case .photo(let u): out.append(.photo(n, u))
            case .card(let u, let c): out.append(.card(n, u, c))
            }
            n += 1
            at = r.location + r.length
        }
        addText(NSRange(location: at, length: ns.length - at))
        return out
    }
}

// MARK: - 描く

/// かけらの本文（Web の <RichText imgClass="assembled-photo" clipTall cards={cards} />）
struct RichTextView: View {
    let body_: String
    let cards: LinkCards

    init(_ body: String, cards: LinkCards) {
        self.body_ = body
        self.cards = cards
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(RichSplitter.parts(body_, cards: cards)) { p in
                switch p {
                case .text(_, let t): RichBlock(text: t)
                case .photo(_, let u): AssembledPhoto(path: u)
                case .card(_, let u, let c): LinkCardView(href: u, card: c)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 文字のひとかたまり（見出し・リスト等を開く）
struct RichBlock: View {
    let text: String
    var color: Color = Theme.ink

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(BlockSplitter.split(text).enumerated()), id: \.offset) { _, seg in
                segView(seg)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func para(_ s: String, size: CGFloat = 16, bold: Bool = false) -> some View {
        Text(InlineRender.attributed(InlineParser.parse(s), InlineStyle(size: size, bold: bold, color: color)))
            .lineSpacing(size * 0.3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func segView(_ seg: Seg) -> some View {
        switch seg {
        case .text(let s):
            para(s)
        case .blank(let n):
            Color.clear.frame(height: max(0, CGFloat(n) * 25.6 - 6))
        case .heading(let level, let s):
            para(s, size: [21, 19, 17][safe: level - 1] ?? 16, bold: true)
        case .ul(let items):
            listView(items.map { ("•", $0) })
        case .ol(let start, let items):
            listView(items.enumerated().map { ("\(start + $0.offset).", $0.element) })
        case .quote(let s):
            HStack(alignment: .top, spacing: 0) {
                Rectangle().fill(Theme.line).frame(width: 3)
                RichBlock(text: s, color: Theme.muted).padding(.leading, 14)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .hr:
            Rule().padding(.vertical, 8)
        }
    }

    private func listView(_ rows: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(r.0).font(Theme.gothic(16)).foregroundStyle(color).frame(minWidth: 16, alignment: .trailing)
                    para(r.1)
                }
            }
        }
        .padding(.leading, 4)
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

/// リンクカード（.link-card: 左に 80pt の画像、右に ドメイン（灰）→ タイトル（黒）→ 説明（灰）。罫枠・角丸 5pt）
struct LinkCardView: View {
    let href: String
    let card: LinkCard
    @State private var image: UIImage?

    /// 画像は自分の /api/photo/kakera/cards/* だけ（相手の URL を直接読まない）
    private static let imagePath = try! NSRegularExpression(pattern: #"^/api/photo/kakera/cards/[A-Za-z0-9_.-]+$"#)

    private var imageSrc: String? {
        guard let s = card.image else { return nil }
        let ns = s as NSString
        return Self.imagePath.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) != nil ? s : nil
    }

    var body: some View {
        let content = HStack(alignment: .center, spacing: 12) {
            ZStack {
                Color(uiColor: UIColor(hex: 0xF1EFEA))
                if let image {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: 80, height: 80).clipped()
                } else {
                    Image(systemName: "photo").font(.system(size: 20, weight: .ultraLight))
                        .foregroundStyle(Color(uiColor: UIColor(hex: 0xB9B4A9)))
                }
            }
            .frame(width: 80, height: 80)
            .clipShape(RoundedRectangle(cornerRadius: 3))
            VStack(alignment: .leading, spacing: 2) {
                if !card.domain.isEmpty {
                    Text(card.domain).font(Theme.mono(11.5)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
                }
                Text(card.title).font(Theme.gothic(14.5, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(2).lineSpacing(2)
                    .multilineTextAlignment(.leading)
                if !card.description.isEmpty {
                    Text(card.description).font(Theme.gothic(12.5)).foregroundStyle(Theme.muted).lineLimit(2).lineSpacing(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Theme.line, lineWidth: Theme.hairline))
        .contentShape(Rectangle())
        .padding(.vertical, 2)
        .task(id: imageSrc) {
            if let src = imageSrc { image = await PhotoCache.shared.image(src) }
        }

        if MD.isSafeHref(href), let url = URL(string: href) {
            Link(destination: url) { content }.buttonStyle(.plain)
        } else {
            content
        }
    }
}

/// 写真（.assembled-photo: 幅いっぱい・角丸 2pt）。縦長（高さ÷幅 > 2）は横幅と同じ高さで切り、下を薄くして「全体を見る」
struct AssembledPhoto: View {
    let path: String
    @State private var image: UIImage?
    @State private var failed = false
    @State private var showAll = false

    private static let tallRatio: CGFloat = 2

    var body: some View {
        Group {
            if let image {
                let tall = image.size.width > 0 && image.size.height / image.size.width > Self.tallRatio
                if tall && !showAll {
                    Color.clear
                        .aspectRatio(1, contentMode: .fit)
                        .overlay(alignment: .top) {
                            Image(uiImage: image).resizable().scaledToFill()
                        }
                        .clipped()
                        .overlay {
                            GeometryReader { g in
                                VStack(spacing: 0) {
                                    Spacer(minLength: 0)
                                    LinearGradient(colors: [Theme.paper.opacity(0), Theme.paper], startPoint: .top, endPoint: .bottom)
                                        .frame(height: g.size.height * 0.3)
                                }
                            }
                            .allowsHitTesting(false)
                        }
                        .overlay(alignment: .bottom) {
                            Button("全体を見る") { showAll = true }
                                .font(Theme.mono(12.5)).tracking(12.5 * 0.06)
                                .foregroundStyle(Theme.ink)
                                .padding(.horizontal, 14).padding(.vertical, 6)
                                .background(Theme.paper, in: RoundedRectangle(cornerRadius: Theme.radius))
                                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                                .buttonStyle(.plain)
                                .padding(.bottom, 12)
                        }
                } else {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity)
                }
            } else {
                Theme.line.opacity(0.5)
                    .aspectRatio(4 / 3, contentMode: .fit)
                    .overlay {
                        if failed { Image(systemName: "photo").foregroundStyle(Theme.muted) } else { ProgressView() }
                    }
            }
        }
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        .task(id: path) {
            image = await PhotoCache.shared.image(path)
            failed = image == nil
        }
    }
}
