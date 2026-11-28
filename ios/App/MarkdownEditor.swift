import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// 書く欄（かけら帳ネイティブ化設計「書く欄」）。Web 版の k-editor の代わり。
//
//   - UITextView（TextKit 2）。持つのは Markdown の文字列そのもの。`## `・`**` などの記号は薄く残し、
//     見出しは大きく・太字は太く・言葉とリンクは朱に「属性だけ」で飾る。文字は1文字も足さない・変えない
//     （触らなければ保存しても同じ文字列。Tests/EditorRoundTripTests.swift で本番の本文を検査する）
//   - 写真の行（`![](/api/photo/…)` だけの行）と、行まるごとの URL（カードのある URL・X / YouTube / Spotify）の下に、
//     行の後ろの余白（paragraphSpacing）を空けて、写真・リンクカードの絵を重ねる。写真には × を付け、押すとその行を消す
//   - 道具（MarkdownToolbar）は文字を挿入するか囲むだけ。UITextInput の replace を通すので「戻す」で戻せる
//   - ⚠️ 日本語入力の変換中（markedTextRange がある間）は飾りを付け直さない（確定を壊さない）。確定した後で付け直す
//   - ⚠️ Enter は改行を入れるだけ。保存は画面のボタンだけ（確定の Enter を送信にしない）

// MARK: - 飾り

/// 本文の文字列に付ける属性（文字は変えない）。行の種類と行内の書式を正規表現で拾う（見た目のためだけ・保存には関わらない）
enum MarkdownStyler {
    static let bodySize: CGFloat = 16
    static var bodyFont: UIFont { Theme.uiGothic(bodySize) }
    static var boldFont: UIFont { UIFont(name: "HiraginoSans-W6", size: bodySize) ?? .boldSystemFont(ofSize: bodySize) }
    static let ink = UIColor(hex: 0x17171A)
    static let muted = UIColor(hex: 0x86837C)
    static let faint = UIColor(hex: 0xB9B4A9)
    static let accent = UIColor(hex: 0xB03A2E)
    static let codeBack = UIColor(hex: 0xF1EFEA)

    static func baseParagraph() -> NSMutableParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.lineSpacing = 5
        return p
    }

    static var baseAttributes: [NSAttributedString.Key: Any] {
        [.font: bodyFont, .foregroundColor: ink, .paragraphStyle: baseParagraph()]
    }

    private static func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }
    private static let heading = re(#"^(#{1,6}) (?=\S)"#)
    private static let bullet = re(#"^([-*+]) "#)
    private static let ordered = re(#"^(\d{1,9}[.)]) "#)
    private static let quote = re(#"^> ?"#)
    private static let hr = re(#"^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$"#)
    private static let fence = re(#"^ {0,3}(`{3,}|~{3,})"#)
    private static let code = re(#"`[^`\n]+`"#)
    private static let bold = re(#"\*\*(?=\S)(.+?)(?<=\S)\*\*"#)
    private static let strike = re(#"~~(?=\S)(.+?)(?<=\S)~~"#)
    private static let italic = re(#"(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])"#)
    private static let link = re(#"(?<!!)\[([^\]\n]+)\]\((https?://[^)\s]+)\)"#)
    private static let word = re(#"\[\[([^\[\]\n]+)\]\]"#)
    private static let bareURL = re(#"https?://[\x21-\x7E]+"#)
    private static let image = re(#"!\[[^\]\n]*\]\([^)\s]+\)"#)

    /// 行の下に絵を出す行（写真・カード・埋め込み）と、その行の範囲
    enum Preview: Equatable {
        case photo(String)
        case card(String, LinkCard)
        case embed(Embed)
    }

    struct Line {
        let range: NSRange
        let text: String
        let preview: Preview?
    }

    static func lines(_ text: String, cards: LinkCards) -> [Line] {
        let ns = text as NSString
        var out: [Line] = []
        var pos = 0
        let parts = text.components(separatedBy: "\n")
        let embeds = Dictionary(Embed.lines(text).map { ($0.line, $0.embed) }, uniquingKeysWith: { a, _ in a })
        for (i, s) in parts.enumerated() {
            let len = (s as NSString).length
            var preview: Preview?
            if let url = KakeraBody.photoURL(in: s), url.hasPrefix("/api/photo/") {
                preview = .photo(url)
            } else if let e = embeds[i] {
                preview = .embed(e)
            } else if Embed.match(s) == nil, let url = MD.standaloneUrl(s), let card = MD.card(for: url, in: cards) {
                preview = .card(url, card)
            }
            out.append(Line(range: NSRange(location: pos, length: len), text: s, preview: preview))
            pos += len + 1
        }
        _ = ns
        return out
    }

    /// 文字列に飾りを付ける（textStorage の属性だけを書き換える）。previewHeight は行の下に空ける高さ
    static func apply(to storage: NSTextStorage, cards: LinkCards, previewHeight: (Preview) -> CGFloat) {
        let text = storage.string
        let full = NSRange(location: 0, length: (text as NSString).length)
        storage.beginEditing()
        storage.setAttributes(baseAttributes, range: full)
        var inFence = false
        for line in lines(text, cards: cards) {
            let s = line.text
            let r = line.range
            let ls = NSRange(location: 0, length: (s as NSString).length)
            func on(_ local: NSRange, _ attrs: [NSAttributedString.Key: Any]) {
                guard local.location != NSNotFound, local.length > 0 else { return }
                storage.addAttributes(attrs, range: NSRange(location: r.location + local.location, length: local.length))
            }
            if fence.firstMatch(in: s, range: ls) != nil || inFence {
                on(ls, [.font: UIFont.monospacedSystemFont(ofSize: 14, weight: .regular), .foregroundColor: muted])
                if fence.firstMatch(in: s, range: ls) != nil { inFence.toggle() }
                continue
            }
            if let p = line.preview {
                let para = baseParagraph()
                para.paragraphSpacing = previewHeight(p) + 10
                para.paragraphSpacingBefore = 4
                if r.length > 0 { on(ls, [.paragraphStyle: para]) }
                if case .photo = p {
                    on(ls, [.font: UIFont.monospacedSystemFont(ofSize: 10.5, weight: .regular), .foregroundColor: faint])
                    continue
                }
                on(ls, [.foregroundColor: accent])
                continue
            }
            if let m = heading.firstMatch(in: s, range: ls) {
                let level = m.range(at: 1).length
                let size: CGFloat = [22, 20, 18][min(level, 3) - 1]
                let f = UIFont(name: "HiraginoSans-W6", size: size) ?? .boldSystemFont(ofSize: size)
                on(ls, [.font: f])
                on(m.range, [.foregroundColor: faint, .font: UIFont(name: "HiraginoSans-W3", size: size * 0.8) ?? f])
            } else if hr.firstMatch(in: s, range: ls) != nil {
                on(ls, [.foregroundColor: faint, .kern: 2])
                continue
            } else if let m = bullet.firstMatch(in: s, range: ls) ?? ordered.firstMatch(in: s, range: ls) {
                on(m.range(at: 1), [.foregroundColor: muted])
            } else if let m = quote.firstMatch(in: s, range: ls) {
                on(ls, [.foregroundColor: muted])
                on(m.range, [.foregroundColor: faint])
            }
            inline(s, ls, on)
        }
        storage.endEditing()
    }

    private static func inline(_ s: String, _ ls: NSRange, _ on: (NSRange, [NSAttributedString.Key: Any]) -> Void) {
        for m in image.matches(in: s, range: ls) {
            on(m.range, [.foregroundColor: faint, .font: UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)])
        }
        for m in bold.matches(in: s, range: ls) {
            on(m.range, [.font: boldFont])
            on(NSRange(location: m.range.location, length: 2), [.foregroundColor: faint])
            on(NSRange(location: m.range.location + m.range.length - 2, length: 2), [.foregroundColor: faint])
        }
        for m in italic.matches(in: s, range: ls) {
            on(m.range(at: 1), [.obliqueness: 0.18])
            on(NSRange(location: m.range.location, length: 1), [.foregroundColor: faint])
            on(NSRange(location: m.range.location + m.range.length - 1, length: 1), [.foregroundColor: faint])
        }
        for m in strike.matches(in: s, range: ls) {
            on(m.range(at: 1), [.strikethroughStyle: NSUnderlineStyle.single.rawValue, .strikethroughColor: muted, .foregroundColor: muted])
            on(NSRange(location: m.range.location, length: 2), [.foregroundColor: faint])
            on(NSRange(location: m.range.location + m.range.length - 2, length: 2), [.foregroundColor: faint])
        }
        for m in bareURL.matches(in: s, range: ls) {
            on(m.range, [.foregroundColor: accent])
        }
        for m in link.matches(in: s, range: ls) {
            on(m.range, [.foregroundColor: faint])
            on(m.range(at: 1), [.foregroundColor: accent, .underlineStyle: NSUnderlineStyle.single.rawValue, .underlineColor: accent])
        }
        for m in word.matches(in: s, range: ls) {
            on(m.range, [.foregroundColor: faint])
            on(m.range(at: 1), [.foregroundColor: accent, .underlineStyle: NSUnderlineStyle.single.rawValue, .underlineColor: accent])
        }
        for m in code.matches(in: s, range: ls) {
            on(m.range, [.font: UIFont.monospacedSystemFont(ofSize: 14, weight: .regular), .backgroundColor: codeBack, .foregroundColor: ink])
        }
    }
}

// MARK: - 文字の欄

/// 本文の UITextView（TextKit 2）。写真・カードの絵は自分の上に重ねる
final class MarkdownTextView: UITextView {
    var cards: LinkCards = [:]
    /// 写真の縦横比（高さ÷幅）。読めたら覚えて、行の下の余白を合わせる
    private var aspects: [String: CGFloat] = [:]
    private var overlays: [String: UIView] = [:]
    private let placeholderLabel = UILabel()
    var placeholder: String = "" { didSet { placeholderLabel.text = placeholder } }
    /// 写真の × を押したとき（その行を消す）
    var onRemovePhotoLine: ((NSRange) -> Void)?

    /// TextKit 2 の置き場（文字は NSTextContentStorage が持つ。textStorage から読むのと同じ文字列）
    private let contentStorage = NSTextContentStorage()

    init() {
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        let layout = NSTextLayoutManager()
        layout.textContainer = container
        contentStorage.addTextLayoutManager(layout)
        super.init(frame: .zero, textContainer: container)
        font = MarkdownStyler.bodyFont
        textColor = MarkdownStyler.ink
        backgroundColor = UIColor(hex: 0xFDFDFC)
        tintColor = MarkdownStyler.accent
        textContainerInset = UIEdgeInsets(top: 14, left: 14, bottom: 40, right: 14)
        alwaysBounceVertical = true
        keyboardDismissMode = .interactive
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
        autocapitalizationType = .none
        dataDetectorTypes = []
        overrideUserInterfaceStyle = .light
        typingAttributes = MarkdownStyler.baseAttributes
        placeholderLabel.font = MarkdownStyler.bodyFont
        placeholderLabel.textColor = MarkdownStyler.faint
        placeholderLabel.numberOfLines = 0
        addSubview(placeholderLabel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    /// 本文を入れる（ここでだけ文字列を丸ごと差し替える）
    func load(_ markdown: String) {
        text = markdown
        restyle()
    }

    /// 飾りを付け直す。⚠️ 変換中（markedTextRange がある間）は何もしない
    func restyle() {
        guard markedTextRange == nil else { return }
        let width = previewWidth
        MarkdownStyler.apply(to: textStorage, cards: cards) { [aspects] p in
            switch p {
            case .photo(let url): return Self.photoHeight(width: width, aspect: aspects[url])
            case .card: return 96
            case .embed: return 78
            }
        }
        typingAttributes = MarkdownStyler.baseAttributes
        placeholderLabel.isHidden = !textStorage.string.isEmpty
        setNeedsLayout()
    }

    private var previewWidth: CGFloat {
        max(120, bounds.width - textContainerInset.left - textContainerInset.right - textContainer.lineFragmentPadding * 2)
    }

    static func photoHeight(width: CGFloat, aspect: CGFloat?) -> CGFloat {
        // 縦長は正方形で切る（Web の .tall-img と同じ考え）。読めるまでは 4:3
        width * min(aspect ?? 0.75, 1.0)
    }

    private var lastWidth: CGFloat = 0

    override func layoutSubviews() {
        super.layoutSubviews()
        let inset = textContainerInset
        let pad = textContainer.lineFragmentPadding
        placeholderLabel.frame = CGRect(x: inset.left + pad, y: inset.top, width: max(0, bounds.width - inset.left - inset.right - pad * 2), height: 24)
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            restyle()
            return
        }
        placeOverlays()
    }

    /// 写真・カードの絵を、その行の文字の下に置く
    private func placeOverlays() {
        guard let tlm = textLayoutManager, let tcm = tlm.textContentManager else { return }
        let text = textStorage.string
        let width = previewWidth
        var wanted = Set<String>()
        for (n, line) in MarkdownStyler.lines(text, cards: cards).enumerated() {
            guard let p = line.preview else { continue }
            let key = "\(n)|\(line.text)"
            wanted.insert(key)
            guard let start = tcm.location(tcm.documentRange.location, offsetBy: line.range.location) else { continue }
            var bottom: CGFloat?
            tlm.enumerateTextLayoutFragments(from: start, options: [.ensuresLayout]) { frag in
                let f = frag.layoutFragmentFrame
                let lineBottom = frag.textLineFragments.last.map { f.minY + $0.typographicBounds.maxY } ?? f.maxY
                bottom = lineBottom
                return false
            }
            guard let b = bottom else { continue }
            let height: CGFloat
            switch p {
            case .photo(let url): height = Self.photoHeight(width: width, aspect: aspects[url])
            case .card: height = 96
            case .embed: height = 78
            }
            let frame = CGRect(x: textContainerInset.left + textContainer.lineFragmentPadding, y: textContainerInset.top + b + 6, width: width, height: height)
            let view = overlays[key] ?? makeOverlay(p, key: key)
            overlays[key] = view
            if view.superview == nil { addSubview(view) }
            view.frame = frame
            if case .photo = p, let close = view.viewWithTag(77) as? UIButton {
                close.accessibilityValue = "\(line.range.location),\(line.range.length)"
                close.frame.origin.x = max(0, frame.width - 40)
            }
        }
        for (k, v) in overlays where !wanted.contains(k) {
            v.removeFromSuperview()
            overlays[k] = nil
        }
    }

    private func makeOverlay(_ p: MarkdownStyler.Preview, key: String) -> UIView {
        switch p {
        case .photo(let url):
            let box = UIView()
            box.clipsToBounds = true
            box.layer.cornerRadius = 2
            box.backgroundColor = UIColor(hex: 0xE4E1DA).withAlphaComponent(0.5)
            let iv = UIImageView()
            iv.contentMode = .scaleAspectFill
            iv.clipsToBounds = true
            iv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            iv.frame = box.bounds
            box.addSubview(iv)
            let close = UIButton(type: .system)
            close.tag = 77
            close.setTitle("×", for: .normal)
            close.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
            close.tintColor = MarkdownStyler.ink
            close.backgroundColor = UIColor(hex: 0xFDFDFC).withAlphaComponent(0.92)
            close.layer.cornerRadius = 2
            close.frame = CGRect(x: 0, y: 8, width: 32, height: 32)
            close.autoresizingMask = [.flexibleLeftMargin]
            close.accessibilityLabel = "この写真を外す"
            close.addAction(UIAction { [weak self, weak close] _ in
                guard let self, let v = close?.accessibilityValue else { return }
                let p = v.split(separator: ",").compactMap { Int($0) }
                guard p.count == 2 else { return }
                self.onRemovePhotoLine?(NSRange(location: p[0], length: p[1]))
            }, for: .touchUpInside)
            box.addSubview(close)
            Task { @MainActor [weak self] in
                guard let img = await PhotoCache.shared.image(url) else { return }
                iv.image = img
                if img.size.width > 0, let self {
                    let a = img.size.height / img.size.width
                    if self.aspects[url] != a {
                        self.aspects[url] = a
                        self.restyle()
                    }
                }
            }
            return box
        case .card(let href, let card):
            let host = UIHostingController(rootView: LinkCardView(href: href, card: card))
            host.view.backgroundColor = .clear
            return host.view
        case .embed(let e):
            let host = UIHostingController(rootView: EmbedCardView(embed: e))
            host.view.backgroundColor = .clear
            return host.view
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        setNeedsLayout()
    }
}

// MARK: - 操作口

/// SwiftUI の画面から書く欄を操作する（道具・保存の直前の取り直し・写真）
@MainActor
final class MarkdownEditorController: NSObject, ObservableObject, UITextViewDelegate, PHPickerViewControllerDelegate {
    let textView = MarkdownTextView()
    /// 変わるたび（変換中は呼ばない）
    var onChange: ((String) -> Void)?
    var onError: ((String) -> Void)?
    /// 写真を上げる先（かけらの id と、写真の key に使う written_at）
    var kakeraId = ""
    var photoWrittenAt = ""
    @Published var uploading: String?
    @Published var canUndo = false
    @Published var canRedo = false
    private var pickContinuation: CheckedContinuation<[NSItemProvider], Never>?

    override init() {
        super.init()
        textView.delegate = self
        textView.onRemovePhotoLine = { [weak self] r in self?.removeLine(r) }
    }

    func start(markdown: String, cards: LinkCards, placeholder: String, focus: Bool) {
        textView.cards = cards
        textView.placeholder = placeholder
        textView.load(markdown)
        if focus {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.textView.becomeFirstResponder()
                let end = (self.textView.text as NSString).length
                self.textView.selectedRange = NSRange(location: end, length: 0)
            }
        }
    }

    /// いまの本文（文字列そのもの）
    var markdown: String { textView.textStorage.string }

    // MARK: UITextViewDelegate

    func textViewDidChange(_ textView: UITextView) {
        refreshUndo()
        // ⚠️ 変換中は飾りも知らせもしない（確定したときにもう一度呼ばれる）
        guard textView.markedTextRange == nil else { return }
        self.textView.restyle()
        onChange?(markdown)
    }

    func textViewDidChangeSelection(_ textView: UITextView) { refreshUndo() }

    private func refreshUndo() {
        canUndo = textView.undoManager?.canUndo ?? false
        canRedo = textView.undoManager?.canRedo ?? false
    }

    // MARK: 文字を入れる・囲む（UITextInput の replace を通す＝戻せる）

    private func commitMarked() {
        if textView.markedTextRange != nil { textView.unmarkText() }
    }

    private func replace(_ range: NSRange, with s: String, select: NSRange? = nil) {
        guard let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
              let end = textView.position(from: start, offset: range.length),
              let r = textView.textRange(from: start, to: end) else { return }
        textView.replace(r, withText: s)
        if let select { textView.selectedRange = select }
        textViewDidChange(textView)
    }

    private var ns: NSString { textView.textStorage.string as NSString }

    /// 選んだ所（無ければカーソルの所）を mark で囲む。既に囲んであれば外す
    func wrap(_ open: String, _ close: String? = nil) {
        commitMarked()
        let close = close ?? open
        let sel = textView.selectedRange
        let s = ns
        let ol = (open as NSString).length, cl = (close as NSString).length
        if sel.location >= ol, sel.location + sel.length + cl <= s.length,
           s.substring(with: NSRange(location: sel.location - ol, length: ol)) == open,
           s.substring(with: NSRange(location: sel.location + sel.length, length: cl)) == close {
            let inner = s.substring(with: sel)
            replace(NSRange(location: sel.location - ol, length: sel.length + ol + cl), with: inner,
                    select: NSRange(location: sel.location - ol, length: sel.length))
            return
        }
        let inner = s.substring(with: sel)
        replace(sel, with: open + inner + close, select: NSRange(location: sel.location + ol, length: (inner as NSString).length))
    }

    /// 選んだ行（カーソルの行）の頭の記号を付ける・外す。prefix が nil なら番号（1. 2. …）
    func toggleLinePrefix(_ prefix: String?, removing: [String]) {
        commitMarked()
        let s = ns
        let lines = s.lineRange(for: textView.selectedRange)
        var block = s.substring(with: lines)
        let endsWithNewline = block.hasSuffix("\n")
        if endsWithNewline { block.removeLast() }
        let rows = block.components(separatedBy: "\n")
        func strip(_ l: String) -> String {
            for p in removing {
                if let r = l.range(of: p, options: .regularExpression), r.lowerBound == l.startIndex { return String(l[r.upperBound...]) }
            }
            return l
        }
        let target = prefix.map { NSRegularExpression.escapedPattern(for: $0) } ?? #"\d{1,9}[.)] "#
        let allHave = rows.allSatisfy { $0.range(of: "^" + target, options: .regularExpression) != nil }
        let out = rows.enumerated().map { i, l -> String in
            let bare = strip(l)
            if allHave { return bare }
            return (prefix ?? "\(i + 1). ") + bare
        }.joined(separator: "\n") + (endsWithNewline ? "\n" : "")
        // 選んだ行のまとまりを選んだままにする（続けて別の記号に切り替えられるように）
        replace(lines, with: out, select: NSRange(location: lines.location, length: (out as NSString).length - (endsWithNewline ? 1 : 0)))
    }

    private static let lineMarks = [#"#{1,6} "#, #"[-*+] "#, #"\d{1,9}[.)] "#, #"> ?"#]

    func heading(_ level: Int) { toggleLinePrefix(String(repeating: "#", count: level) + " ", removing: Self.lineMarks) }
    func bulletList() { toggleLinePrefix("- ", removing: Self.lineMarks) }
    func orderedList() { toggleLinePrefix(nil, removing: Self.lineMarks) }
    func blockquote() { toggleLinePrefix("> ", removing: Self.lineMarks) }

    /// 行として独立させて入れる（区切り線・埋め込みの URL・写真）。カーソルの行が空ならその行に、空でなければ次の行に
    func insertBlock(_ block: String) {
        commitMarked()
        let s = ns
        let sel = textView.selectedRange
        let line = s.lineRange(for: NSRange(location: sel.location, length: 0))
        var lineText = s.substring(with: line)
        let hadNewline = lineText.hasSuffix("\n")
        if hadNewline { lineText.removeLast() }
        if lineText.trimmingCharacters(in: .whitespaces).isEmpty {
            let at = NSRange(location: line.location, length: (lineText as NSString).length)
            let text = block + (hadNewline ? "" : "\n")
            replace(at, with: text, select: NSRange(location: line.location + (block as NSString).length + 1, length: 0))
        } else {
            let end = line.location + (lineText as NSString).length
            let text = "\n" + block + (hadNewline ? "" : "\n")
            replace(NSRange(location: end, length: 0), with: text, select: NSRange(location: end + (text as NSString).length, length: 0))
        }
    }

    func horizontalRule() { insertBlock("---") }

    /// リンク: 選んだ文字があれば [文字](url)、無ければ URL をそのまま
    func link(_ url: String) {
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard MD.isSafeHref(u) else { onError?("http(s) の URL を入れてください"); return }
        commitMarked()
        let sel = textView.selectedRange
        let label = ns.substring(with: sel)
        let text = label.isEmpty ? u : "[\(label)](\(u))"
        replace(sel, with: text, select: NSRange(location: sel.location + (text as NSString).length, length: 0))
    }

    func embed(_ url: String) {
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard MD.isSafeHref(u) else { onError?("http(s) の URL を入れてください"); return }
        insertBlock(u)
    }

    func undo() { textView.undoManager?.undo(); textViewDidChange(textView) }
    func redo() { textView.undoManager?.redo(); textViewDidChange(textView) }

    private func removeLine(_ r: NSRange) {
        let s = ns
        guard r.location + r.length <= s.length else { return }
        var range = r
        if range.location + range.length < s.length { range.length += 1 } // 後ろの改行ごと
        else if range.location > 0 { range = NSRange(location: range.location - 1, length: range.length + 1) }
        replace(range, with: "")
    }

    // MARK: 写真

    func pickPhotos() {
        Task { @MainActor in
            let providers = await withCheckedContinuation { (c: CheckedContinuation<[NSItemProvider], Never>) in
                pickContinuation = c
                var conf = PHPickerConfiguration(photoLibrary: .shared())
                conf.filter = .images
                conf.selectionLimit = 10
                conf.selection = .ordered
                let picker = PHPickerViewController(configuration: conf)
                picker.delegate = self
                guard let top = Self.topViewController() else { c.resume(returning: []); pickContinuation = nil; return }
                top.present(picker, animated: true)
            }
            guard !providers.isEmpty else { return }
            var lines: [String] = []
            for (i, p) in providers.enumerated() {
                uploading = "写真を上げています（\(i + 1)/\(providers.count)）"
                do {
                    let data = try await Self.loadImageData(p)
                    let jpeg = try JPEG.make(from: data)
                    let n = KakeraBody.photoURLs(markdown).count + lines.count + 1
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("-kakeraDryRunUpload") {
                        throw APIError.transport("試験のため上げずに止めました")
                    }
                    #endif
                    let url = try await API.shared.uploadPhoto(jpeg: jpeg, kakeraId: kakeraId, writtenAt: photoWrittenAt, n: n)
                    lines.append(KakeraBody.photoLine(url))
                } catch {
                    onError?("写真を上げられませんでした: \(error.localizedDescription)")
                    break
                }
            }
            uploading = nil
            if !lines.isEmpty { insertBlock(lines.joined(separator: "\n")) }
        }
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let providers = results.map(\.itemProvider)
        Task { @MainActor in
            picker.dismiss(animated: true)
            pickContinuation?.resume(returning: providers)
            pickContinuation = nil
        }
    }

    private static func loadImageData(_ p: NSItemProvider) async throws -> Data {
        try await withCheckedThrowingContinuation { c in
            p.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, error in
                if let data { c.resume(returning: data) } else { c.resume(throwing: error ?? APIError.transport("写真を読めませんでした")) }
            }
        }
    }

    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let p = top?.presentedViewController { top = p }
        return top
    }
}

struct MarkdownEditorView: UIViewRepresentable {
    let controller: MarkdownEditorController

    func makeUIView(context: Context) -> MarkdownTextView { controller.textView }
    func updateUIView(_ uiView: MarkdownTextView, context: Context) {}
}

// MARK: - 道具の並び（Web の TOOLBAR と同じ順: 写真・埋め込み | [[ ]]・見出し・太字・取消線・リンク | リスト・引用・区切り線 | 戻す・やり直す）

struct MarkdownToolbar: View {
    @ObservedObject var controller: MarkdownEditorController
    @State private var asking: Ask?
    @State private var url = ""

    enum Ask: String, Identifiable { case link, embed; var id: String { rawValue } }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                tool("photo", "写真") { controller.pickPhotos() }
                tool("play.rectangle", "埋め込み") { url = ""; asking = .embed }
                divider
                textTool("[[ ]]", "言葉のリンク") { controller.wrap("[[", "]]") }
                textTool("H2", "見出し2") { controller.heading(2) }
                textTool("H3", "見出し3") { controller.heading(3) }
                tool("bold", "太字") { controller.wrap("**") }
                tool("strikethrough", "取消線") { controller.wrap("~~") }
                tool("link", "リンク") { url = ""; asking = .link }
                divider
                tool("list.bullet", "箇条書き") { controller.bulletList() }
                tool("list.number", "番号付き") { controller.orderedList() }
                tool("text.quote", "引用") { controller.blockquote() }
                tool("minus", "区切り線") { controller.horizontalRule() }
                divider
                tool("arrow.uturn.backward", "戻す") { controller.undo() }.disabled(!controller.canUndo)
                tool("arrow.uturn.forward", "やり直す") { controller.redo() }.disabled(!controller.canRedo)
            }
            .padding(.horizontal, 12)
        }
        .frame(height: 40)
        .overlay(alignment: .top) { Rule() }
        .overlay(alignment: .bottom) { Rule() }
        .alert(asking == .link ? "リンクの URL" : "埋め込む URL（X・YouTube・Spotify など）", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })) {
            TextField("https://", text: $url)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("やめる", role: .cancel) { asking = nil }
            Button("入れる") {
                if asking == .link { controller.link(url) } else { controller.embed(url) }
                asking = nil
            }
        }
    }

    private var divider: some View {
        Rectangle().fill(Theme.line).frame(width: 1, height: 18).padding(.horizontal, 4)
    }

    private func tool(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 14, weight: .regular)).frame(width: 34, height: 34)
        }
        .buttonStyle(LinkButtonStyle(color: Theme.ink))
        .accessibilityLabel(label)
    }

    private func textTool(_ text: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text).font(Theme.mono(12.5, weight: .medium)).frame(minWidth: 34, minHeight: 34)
        }
        .buttonStyle(LinkButtonStyle(color: Theme.ink))
        .accessibilityLabel(label)
    }
}
