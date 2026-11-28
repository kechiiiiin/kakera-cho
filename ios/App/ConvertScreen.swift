import SwiftUI

// 変換（Web の ConvertScreen.tsx・NameMarks.tsx・FacePhoto.tsx）。
// 名前の決まり（記号を解く・括弧を外す・切れ・日記を組む・Markdown・集計）は Swift に写さず、
// 画面が持っている状態（辞書・文書・写真の選択）を POST /api/native/convert-view に送って、Web と同じ関数で組んでもらう。
// 選択の保存は Web と同じ口（name-choice・photo-choice・publish-body・photo-face）。書き出しもサーバが D1 から解き直す。

// MARK: - 印の描き方

enum NameMarks {
    static let scheme = "kakera-mark"

    static func url(seg: String, id: String) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "m"
        c.queryItems = [URLQueryItem(name: "seg", value: seg), URLQueryItem(name: "id", value: id)]
        return c.url
    }

    static func parse(_ url: URL) -> (seg: String, id: String)? {
        guard url.scheme == scheme, let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let seg = q.first(where: { $0.name == "seg" })?.value, let id = q.first(where: { $0.name == "id" })?.value else { return nil }
        return (seg, id)
    }

    /// [range) の素の文字を、印を挟みながら（位置は UTF-16）。pressable なら印は押せるリンク
    static func attributed(_ text: String, spans: [ResolvedSpan], range: NSRange, pressable: Bool, seg: String = "",
                           style: (inout AttributedString) -> Void = { _ in }) -> AttributedString {
        let ns = text as NSString
        var out = AttributedString()
        func plain(_ a: Int, _ b: Int) {
            guard b > a else { return }
            var p = AttributedString(ns.substring(with: NSRange(location: a, length: b - a)))
            style(&p)
            out += p
        }
        var cur = range.location
        let end = range.location + range.length
        for m in spans where m.start >= range.location && m.start < end {
            if m.start > cur { plain(cur, m.start) }
            var w = AttributedString(m.word)
            style(&w)
            switch m.status {
            case "exception":
                w.foregroundColor = Theme.ink
                w.underlineStyle = .init(pattern: .dot, color: Color(uiColor: UIColor(hex: 0xC7C2B6)))
            case "reject":
                w.foregroundColor = Theme.accent
                w.backgroundColor = Theme.accent.opacity(0.11)
                w.underlineStyle = .init(pattern: .solid, color: Theme.accent)
                w.font = Theme.gothic(15, weight: .bold)
            case "edit":
                w.foregroundColor = Theme.ink
                w.backgroundColor = Color(uiColor: UIColor(hex: 0xECE9E1))
                w.underlineStyle = .init(pattern: .dash, color: Theme.ink)
            default:
                // 辞書どおり（Web の .mk-dict は灰の下線）。実画面で下線が落ちることがあるので、淡い地も付けて見分ける
                w.foregroundColor = Theme.ink
                w.backgroundColor = Color(uiColor: UIColor(hex: 0xEDEAE3))
                w.underlineStyle = .init(pattern: .solid, color: Color(uiColor: UIColor(hex: 0xA7A296)))
            }
            if pressable, m.status != "exception", let u = url(seg: seg, id: m.id) { w.link = u }
            out += w
            cur = m.end
        }
        if cur < end { plain(cur, end) }
        return out
    }
}

/// 公開名変換の印つき本文（段落と写真に分けて描く・NameMarks.tsx の MarkedBody）
struct MarkedBody: View {
    let seg: ConvertSeg
    let hidden: Set<String>
    let onToggle: (String) -> Void
    let photo: (String, String) -> AnyView

    private enum Part: Identifiable {
        case para(Int, NSRange, [String])
        case image(Int, ViewToken)
        var id: Int { switch self { case .para(let i, _, _), .image(let i, _): return i } }
    }

    private var parts: [Part] {
        let ns = seg.text as NSString
        var out: [Part] = []
        var para: [ViewToken] = []
        func flush(_ i: Int) {
            guard let first = para.first, let last = para.last else { return }
            var a = first.start, b = last.end
            while a < b, let s = Unicode.Scalar(ns.character(at: a)), CharacterSet.whitespacesAndNewlines.contains(s) { a += 1 }
            while b > a, let s = Unicode.Scalar(ns.character(at: b - 1)), CharacterSet.whitespacesAndNewlines.contains(s) { b -= 1 }
            // リンクの表示文字の中の写真（出す／出さないの切り替えを段落の下に出す）
            var inner: [String] = []
            func walk(_ ts: [ViewToken]) {
                for t in ts {
                    if t.kind == "image", let k = t.photoKey { inner.append(k) }
                    walk(t.label ?? [])
                    walk(t.alt ?? [])
                }
            }
            walk(para)
            if a < b { out.append(.para(i, NSRange(location: a, length: b - a), inner)) }
            para = []
        }
        for (i, t) in seg.tokens.enumerated() {
            if t.kind != "image" { para.append(t); continue }
            flush(i * 2)
            out.append(.image(i * 2 + 1, t))
        }
        flush(seg.tokens.count * 2 + 2)
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(parts) { p in
                switch p {
                case .para(_, let r, let inner):
                    Text(paragraph(r))
                        .font(Theme.gothic(15)).foregroundStyle(Theme.ink).lineSpacing(5)
                        .tint(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(inner, id: \.self) { k in PhotoSwitch(off: hidden.contains(k)) { onToggle(k) } }
                case .image(_, let t):
                    imageBlock(t)
                }
            }
        }
    }

    /// 写真の代替文字（と題）。公開 HTML の alt に出るので見えないままにしない
    private func altText(_ t: ViewToken) -> AttributedString {
        var a = inlineText(t.alt ?? [], t.start, t.end)
        if let title = t.title {
            a += AttributedString("（")
            a += NameMarks.attributed(seg.text, spans: seg.spans, range: NSRange(location: title.start, length: title.end - title.start), pressable: true, seg: seg.seg)
            a += AttributedString("）")
        }
        return a
    }

    private func paragraph(_ r: NSRange) -> AttributedString { inlineText(seg.tokens, r.location, r.location + r.length) }

    /// 段落の中の切れ（text・url・raw・link・リンクの中の画像）。リンクは淡い点線だけ（印と見分けるため）。[a, b) の外の素の文字は落とす
    private func inlineText(_ tokens: [ViewToken], _ a0: Int, _ b0: Int) -> AttributedString {
        var out = AttributedString()
        func inline(_ tokens: [ViewToken], _ a: Int, _ b: Int) {
            for t in tokens {
                let s = max(t.start, a), e = min(t.end, b)
                guard e > s else { continue }
                switch t.kind {
                case "url":
                    out += NameMarks.attributed(seg.text, spans: seg.spans, range: NSRange(location: t.start, length: t.end - t.start), pressable: true, seg: seg.seg) {
                        $0.underlineStyle = .init(pattern: .dot, color: Theme.muted)
                    }
                case "link":
                    let before = out.characters.count
                    inline(t.label ?? [], t.start, t.end)
                    let range = out.index(out.startIndex, offsetByCharacters: before)..<out.endIndex
                    if out.underlineStyle == nil { out[range].underlineStyle = .init(pattern: .dot, color: Theme.muted) }
                    if let title = t.title {
                        out += AttributedString("（")
                        out += NameMarks.attributed(seg.text, spans: seg.spans, range: NSRange(location: title.start, length: title.end - title.start), pressable: true, seg: seg.seg)
                        out += AttributedString("）")
                    }
                case "image":
                    var open = AttributedString("［画像" + ((t.alt ?? []).isEmpty ? "" : "　"))
                    open.foregroundColor = Theme.muted
                    out += open
                    inline(t.alt ?? [], t.start, t.end)
                    var close = AttributedString("］")
                    close.foregroundColor = Theme.muted
                    out += close
                default:
                    let rr = t.kind == "text" ? NSRange(location: s, length: e - s) : NSRange(location: t.start, length: t.end - t.start)
                    out += NameMarks.attributed(seg.text, spans: seg.spans, range: rr, pressable: true, seg: seg.seg)
                }
            }
        }
        inline(tokens, a0, b0)
        return out
    }

    @ViewBuilder
    private func imageBlock(_ t: ViewToken) -> some View {
        let key = t.photoKey
        let off = key.map { hidden.contains($0) } ?? false
        let altHasText = (t.alt ?? []).contains { a in
            (seg.text as NSString).substring(with: NSRange(location: a.start, length: a.end - a.start)).trimmingCharacters(in: .whitespaces).count > 0
        }
        VStack(alignment: .leading, spacing: 6) {
            if t.srcOk == true, let url = t.url?.trimmingCharacters(in: .whitespaces) {
                Group {
                    if let key, !off {
                        photo(key, url)
                    } else if url.hasPrefix("/api/photo/") {
                        AssembledPhoto(path: url, clipTall: false)
                    } else {
                        Text(url).font(Theme.mono(11)).foregroundStyle(Theme.muted)
                    }
                }
                .opacity(off ? 0.35 : 1)
            }
            if let key { PhotoSwitch(off: off) { onToggle(key) } }
            if altHasText || t.title != nil {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("代替文字").font(Theme.gothic(10.5)).foregroundStyle(Theme.muted)
                    Text(altText(t))
                        .font(Theme.gothic(13)).tint(Theme.ink)
                }
            }
        }
    }
}

/// 写真の下の「日記に出す」のチェック（既定は付いている）。外すと写真を薄くして「日記に出さない」の札
struct PhotoSwitch: View {
    let off: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 8) {
                CheckBox(checked: !off)
                Text("日記に出す").font(Theme.gothic(12.5)).foregroundStyle(Theme.ink)
                if off {
                    Text("日記に出さない").font(Theme.gothic(10.5)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                }
            }
            .frame(minHeight: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("photoSwitch")
        .accessibilityValue(off ? "出さない" : "出す")
    }
}

// MARK: - 変換の画面

struct ConvertScreen: View {
    let katachiId: String
    let order: [String]
    let titleInput: String

    @Environment(AppNav.self) private var nav
    @State private var store = KakeraStore.shared
    @State private var entries: [NameEntry]?
    @State private var title = ""
    @State private var description = ""
    @State private var dictRev = ""
    @State private var docs: [DocView] = []
    @State private var carried = false
    @State private var photos: [PhotoChoice] = []
    @State private var carriedPhotos = 0
    @State private var pbCards: LinkCards = [:]
    @State private var failed: String?
    @State private var view: ConvertView?
    @State private var version = 0
    @State private var mode = "marks"
    @State private var markSheet: MarkSheet?
    @State private var confirmReject = false
    @State private var busy = false
    @State private var busyLabel: String?
    @State private var pbEdit: PBEdit?
    @State private var pbBusy = false
    @State private var confirmDiscard: String?
    @State private var faces: [String: PhotoFaceState] = [:]
    @State private var faceErrors: [String: String] = [:]
    @State private var requested = Set<String>()
    @State private var scanning: String?
    @State private var scanProgress: (Int, Int)?
    /// この端末で検出した写真（Web の MediaPipe の「検出が済んだ」印は付けないので、画面の中だけで覚える）
    @State private var scannedHere = Set<String>()
    @State private var flashSeg: String?

    struct MarkSheet: Identifiable, Equatable {
        let seg: String
        let id: String
        var editing = false
        var draft = ""
        var identity: String { "\(seg):\(id)" }
        var id_: String { identity }
    }

    struct PBEdit: Equatable {
        let seg: String
        var draft: String
        let initial: String
        let shown: String
    }

    private var detail: KatachiDetail? { store.details[katachiId] }
    private var cards: LinkCards { (detail?.cards ?? [:]).merging(pbCards) { a, _ in a } }

    var body: some View {
        ScrollViewReader { proxy in
            Screen {
                BackRow("組み直す") { nav.pop() }
                PageTitle(title: "変換", sub: "名前を公開用に置き換えました。印を押すと、その箇所だけ選び直せます。")
                if let failed {
                    warn("読み込めませんでした: \(failed)")
                } else if entries == nil || view == nil {
                    Text("読み込んでいます").emptyNote()
                } else if let v = view {
                    content(v)
                }
            }
            .onChange(of: flashSeg) { _, s in
                guard let s else { return }
                withAnimation { proxy.scrollTo(s, anchor: .center) }
                flashSeg = nil
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if let m = NameMarks.parse(url) {
                markSheet = MarkSheet(seg: m.seg, id: m.id)
                return .handled
            }
            return .systemAction
        })
        .task { await open() }
        .task(id: version) { await recompute() }
        .sheet(item: Binding(get: { markSheet.map { IdentifiedSheet(value: $0) } }, set: { markSheet = $0?.value })) { s in
            markSheetView(s.value).presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $confirmReject) { rejectSheet.presentationDetents([.medium, .large]) }
        .confirmationDialog("日記用に直した文を捨てて、原本に戻します。よろしいですか？",
                            isPresented: Binding(get: { confirmDiscard != nil }, set: { if !$0 { confirmDiscard = nil } }), titleVisibility: .visible) {
            Button("原本に戻す", role: .destructive) { if let s = confirmDiscard { Task { await discardPb(s) } } }
        }
    }

    struct IdentifiedSheet: Identifiable { let value: MarkSheet; var id: String { value.identity } }

    // MARK: 読み込み・組み直し

    private func open() async {
        guard entries == nil else { return }
        do {
            if store.details[katachiId] == nil { try await store.loadDetail(katachiId) }
            // 文書の同期は name-choice で走る。写真の選択・日記用の文の読み込みはその後に
            let r = try await API.shared.loadNameChoices(katachiId: katachiId, kakeraIds: order, title: titleInput)
            async let hidden = API.shared.loadPhotoChoices(katachiId: katachiId, kakeraIds: order)
            async let pb = API.shared.loadPublishBodies(katachiId: katachiId)
            let (h, c) = try await (hidden, pb)
            pbCards = c
            photos = h
            carriedPhotos = h.count
            title = r.title
            description = r.description ?? ""
            dictRev = r.dictRev
            docs = r.docs
            carried = r.docs.contains { $0.refs.contains { $0.action != "approve" } }
            entries = r.entries
            version += 1
        } catch {
            failed = error.localizedDescription
            Toast.shared.say(error.localizedDescription)
        }
    }

    private func recompute() async {
        guard let entries, let d = detail else { return }
        do {
            let v = try await API.shared.convertView(katachiDate: d.katachi.date, kakera: d.kakera, order: order, title: title,
                                                     description: description, entries: entries, docs: docs, photos: photos, cards: cards)
            guard !Task.isCancelled else { return }
            view = v
            await loadFaces(v.wantFaces)
        } catch {
            if !Task.isCancelled { Toast.shared.say(error.localizedDescription) }
        }
    }

    /// 日記に出す写真の顔の枠を読む（まだ読んでいない写真だけ）。検出はしない（「顔を探す」を押したときだけ）
    private func loadFaces(_ keys: [String]) async {
        let unknown = keys.filter { !requested.contains($0) }
        guard !unknown.isEmpty else { return }
        requested.formUnion(unknown)
        do {
            for st in try await API.shared.loadPhotoFaces(keys: unknown) { faces[st.key] = st }
        } catch {
            for k in unknown { faceErrors[k] = error.localizedDescription }
        }
    }

    // MARK: 中身

    @ViewBuilder
    private func content(_ v: ConvertView) -> some View {
        if carried || carriedPhotos > 0 {
            carry(rich([("前回の選択を引き継いでいます。", false)] + (carriedPhotos > 0 ? [("写真 ", false), ("\(carriedPhotos)", true), (" 枚は日記に出さないままです。", false)] : [])))
        }
        ForEach(v.lostNotes, id: \.key) { n in carry(rich([(n.label, true), (" " + n.line, false)])) }
        if !v.staleNums.isEmpty {
            carry(rich([("かけら \(v.staleNums.map(String.init).joined(separator: "・"))", true), (" は日記用に直したあとで原本が変わっています。選ぶまでは直した文で出ます。", false)]))
        }
        if v.dictEmpty { warn("名前の辞書が空です。このまま書き出すと、名前は置き換わりません（日記タブの「名前の辞書」から足せます）。") }
        if let e = v.assembleError, !v.segs.contains(where: { $0.error != nil }) { warn(e) }

        modeTabs.padding(.vertical, 10)

        switch mode {
        case "md":
            note("astro-blog に書き出す中身です。リンク先・裸の URL・写真の URL は元のまま（写真の URL だけ、書き出すときに公開用へ差し替わります）。日記に出さない写真は入りません。")
            if let md = v.markdown {
                Text(md).font(Theme.mono(11.5)).foregroundStyle(Theme.ink).textSelection(.enabled)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                    .accessibilityIdentifier("markdown")
            } else {
                warn(v.assembleError ?? v.segs.first { $0.error != nil }?.error ?? "")
            }
        case "plain":
            note("公開されたら、こう読めます（印なし）。顔のモザイクは、書き出すときに写真へかかります（ここでは素顔のまま）。")
            if let a = v.assembled {
                Text(a.title.isEmpty ? (detail?.katachi.date ?? "") : a.title).font(Theme.gothic(19, weight: .semibold)).padding(.top, 6)
                if !a.description.isEmpty { Text(a.description).font(Theme.gothic(13.5)).foregroundStyle(Theme.muted).padding(.top, 4) }
                ForEach(a.bodies.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }, id: \.seg) { b in
                    Rule().padding(.vertical, 14)
                    if let h = b.timeHead { Text(h.label).font(Theme.mono(12)).foregroundStyle(Theme.muted).padding(.bottom, 6) }
                    RichTextView(b.text, cards: cards, clipTall: false)
                }
            } else {
                warn(v.assembleError ?? v.segs.first { $0.error != nil }?.error ?? "")
            }
        default:
            tally(v)
            if !v.wantFaces.isEmpty {
                note("顔は自動では探しません。隠したい顔がある写真は、写真の下の「顔を探す」か「囲む」を使ってください。")
            }
            marks(v)
        }

        if v.counts.reject > 0 {
            Text("実名のまま出る箇所 \(v.counts.reject)").font(Theme.gothic(12.5, weight: .semibold)).foregroundStyle(Theme.accent).padding(.top, 26)
        }
        if v.composedEmpty {
            Text("日記に出す内容がありません。写真をすべて出さないにしたかけらは日記から外れます。")
                .font(Theme.gothic(12.5, weight: .semibold)).foregroundStyle(Theme.accent).padding(.top, 12).fixedSize(horizontal: false, vertical: true)
        }
        Button(busy ? (busyLabel ?? "書き出しています") : "書き出す") {
            if v.counts.reject > 0 { confirmReject = true } else { Task { await publish(v, confirmRealNames: false) } }
        }
        .buttonStyle(CTAButtonStyle(fullWidth: true))
        .disabled(busy || order.isEmpty || v.composedEmpty || v.cannotExport || pbEdit != nil || pbBusy)
        .padding(.top, v.counts.reject > 0 || v.composedEmpty ? 10 : 26)
        .accessibilityIdentifier("publish")
        note("ここで選んだことは日記にだけ効きます。かけらの原本は実名のまま残ります。")
    }

    private var modeTabs: some View {
        HStack(spacing: 0) {
            ForEach([("marks", "印つき"), ("plain", "公開される姿"), ("md", "Markdown")], id: \.0) { m, label in
                Button { mode = m } label: {
                    Text(label).font(Theme.gothic(12.5, weight: mode == m ? .bold : .regular))
                        .foregroundStyle(mode == m ? Theme.ink : Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        .overlay(alignment: .bottom) { if mode == m { Rectangle().fill(Theme.ink).frame(height: 2) } }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mode-\(m)")
                if m != "md" { Rectangle().fill(Theme.line).frame(width: 1, height: 38) }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
    }

    private func tally(_ v: ConvertView) -> some View {
        let c = v.counts
        var faceHidden = 0, faceShown = 0
        for k in v.wantFaces { if let st = faces[k] { let h = FaceRules.hidden(st.faces).count; faceHidden += h; faceShown += st.faces.count - h } }
        func item(_ label: String, _ n: Int, rej: Bool = false) -> some View {
            HStack(spacing: 4) {
                Text(label).font(Theme.gothic(11.5)).foregroundStyle(Theme.muted)
                Text("\(n)").font(Theme.mono(12, weight: .semibold)).foregroundStyle(rej ? Theme.accent : Theme.ink)
            }
            .opacity(n == 0 ? 0.5 : 1)
        }
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                item("辞書どおり", c.dict)
                item("手で直した", c.edit)
                item("実名のまま", c.reject, rej: true)
                item("例外", c.exc)
            }
            HStack(spacing: 14) {
                if v.photoCount.shown + v.photoCount.hidden > 0 {
                    Text("写真 出す \(v.photoCount.shown)／出さない \(v.photoCount.hidden)").font(Theme.gothic(11.5)).foregroundStyle(Theme.muted)
                }
                if !v.wantFaces.isEmpty {
                    Text("顔 隠す \(faceHidden)／出す \(faceShown)").font(Theme.gothic(11.5)).foregroundStyle(Theme.muted)
                }
            }
        }
        .padding(.bottom, 8)
        .accessibilityIdentifier("tally")
    }

    @ViewBuilder
    private func marks(_ v: ConvertView) -> some View {
        let titleSeg = v.segs.first { $0.seg == "title" }
        let descSeg = v.segs.first { $0.seg == "description" }
        label("タイトル")
        if let e = titleSeg?.error { warn(e) }
        if let t = titleSeg, !t.text.isEmpty {
            Text(NameMarks.attributed(t.text, spans: t.spans, range: NSRange(location: 0, length: (t.text as NSString).length), pressable: true, seg: t.seg))
                .font(Theme.gothic(18, weight: .semibold)).foregroundStyle(Theme.ink).tint(Theme.ink).id("title")
        } else {
            Text(detail?.katachi.date ?? "").font(Theme.gothic(18)).foregroundStyle(Theme.muted)
        }
        label("説明").padding(.top, 14)
        if let d = descSeg {
            if let e = d.error { warn(e) }
            Text(NameMarks.attributed(d.text, spans: d.spans, range: NSRange(location: 0, length: (d.text as NSString).length), pressable: true, seg: d.seg))
                .font(Theme.gothic(13.5)).foregroundStyle(Theme.muted).tint(Theme.ink).id("description")
        } else {
            Text("なし（ブログの紹介文が出ます）").font(Theme.gothic(13.5)).foregroundStyle(Theme.muted)
        }
        ForEach(v.segs.filter { !$0.isHead }) { s in
            bodySeg(s).id(s.seg)
        }
    }

    @ViewBuilder
    private func bodySeg(_ s: ConvertSeg) -> some View {
        let editing = pbEdit?.seg == s.seg ? pbEdit : nil
        VStack(alignment: .leading, spacing: 8) {
            Rule().padding(.vertical, 12)
            HStack(spacing: 8) {
                label(s.fullLabel)
                if s.hasPub {
                    Text("日記用に直しています").font(Theme.gothic(10.5)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                }
            }
            if let e = s.error {
                staleBox(head: e, sub: nil, original: nil) {
                    if s.hasPub { Button("原本に戻す") { confirmDiscard = s.seg }.buttonStyle(DangerButtonStyle()).disabled(pbBusy) }
                }
            }
            if s.stale && editing == nil && s.error == nil {
                staleBox(head: "原本が変わっています", sub: "日記用に直したあとで、かけらの原本が直されました。選ぶまでは直した文で出ます。", original: s.original) {
                    Button("書き換えを使う") { Task { await acceptPb(s.seg) } }.buttonStyle(GhostButtonStyle()).disabled(pbBusy)
                    Button("原本に戻す") { confirmDiscard = s.seg }.buttonStyle(DangerButtonStyle()).disabled(pbBusy)
                }
            }
            if let editing {
                pbEditor(s, editing)
            } else if s.error == nil {
                if s.empty {
                    Text("このかけらは日記に出る内容がないので外れます").font(Theme.gothic(12)).foregroundStyle(Theme.muted)
                }
                MarkedBody(seg: s, hidden: Set(photos.filter { $0.kakeraId == s.seg }.map(\.key)), onToggle: { togglePhoto(s.seg, $0) }) { key, src in
                    AnyView(photoView(key: key, src: src))
                }
                HStack {
                    Spacer()
                    Button(s.hasPub ? "日記用の文を直す" : "日記用に直す") {
                        pbEdit = PBEdit(seg: s.seg, draft: s.text, initial: s.rawText, shown: s.text)
                    }
                    .buttonStyle(LinkButtonStyle(color: Theme.muted))
                    .disabled(pbBusy || pbEdit != nil)
                    .accessibilityIdentifier("pbOpen-\(s.num)")
                }
            }
        }
    }

    @ViewBuilder
    private func photoView(key: String, src: String) -> some View {
        if FaceRules.isFacePhotoKey(key) {
            FacePhotoView(
                src: src, state: faces[key], scanned: (faces[key]?.scanned ?? false) || scannedHere.contains(key),
                scanning: scanning == key, busyElsewhere: scanning != nil && scanning != key,
                progress: scanning == key ? scanProgress : nil, error: faceErrors[key],
                onChange: { changeFaces(key, $0) }, onScan: { Task { await scan(key) } },
                onReload: { requested.remove(key); faceErrors[key] = nil; version += 1 })
        } else {
            AssembledPhoto(path: src, clipTall: false)
        }
    }

    private func staleBox<Actions: View>(head: String, sub: String?, original: String?, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(head).font(Theme.gothic(13, weight: .semibold)).foregroundStyle(Theme.accent)
            if let sub { Text(sub).font(Theme.gothic(12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            if let original {
                DisclosureGroup("今の原本を見る") {
                    Text(original).font(Theme.gothic(13)).foregroundStyle(Theme.ink).frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(Theme.gothic(12)).tint(Theme.muted)
            }
            HStack(spacing: 8) { actions() }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.accent.opacity(0.5), lineWidth: Theme.hairline))
    }

    private func pbEditor(_ s: ConvertSeg, _ e: PBEdit) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: Binding(get: { pbEdit?.draft ?? "" }, set: { pbEdit?.draft = $0 }))
                .font(Theme.gothic(15)).frame(minHeight: 140)
                .scrollContentBackground(.hidden)
                .padding(6)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                .accessibilityIdentifier("pbEditor")
            Text("日記にだけ効きます。かけらの原本は変わりません。触らなかった名前の選択は残ります。新しく打った名前は、保存すると印で置き換わります。")
                .font(Theme.gothic(11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(pbBusy ? "保存しています" : "保存") { Task { await savePb(s) } }.buttonStyle(PrimaryButtonStyle()).disabled(pbBusy)
                Button("取消") { pbEdit = nil }.buttonStyle(GhostButtonStyle()).disabled(pbBusy)
                if s.hasPub { Button("原本に戻す") { confirmDiscard = s.seg }.buttonStyle(DangerButtonStyle()).disabled(pbBusy) }
            }
        }
    }

    private func label(_ s: String) -> some View { Text(s).sectionHeading().padding(.top, 6).padding(.bottom, 2) }

    private func note(_ s: String) -> some View {
        Text(s).font(Theme.gothic(11.5)).foregroundStyle(Theme.muted).lineSpacing(3).padding(.vertical, 6).fixedSize(horizontal: false, vertical: true)
    }

    private func warn(_ s: String) -> some View {
        Text(s).font(Theme.gothic(12.5)).foregroundStyle(Theme.accent).lineSpacing(3)
            .padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.accent, lineWidth: Theme.hairline))
            .padding(.bottom, 12)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func carry(_ t: AttributedString) -> some View {
        Text(t).font(Theme.gothic(12.5)).foregroundStyle(Theme.muted).lineSpacing(3).padding(.bottom, 8).fixedSize(horizontal: false, vertical: true)
    }

    /// 文字の切れ（太字にするか・朱にするか）をつないだ一文
    private func rich(_ parts: [(String, Bool)], accent: Bool = false) -> AttributedString {
        var out = AttributedString()
        for (s, strong) in parts {
            var p = AttributedString(s)
            if strong {
                p.font = Theme.gothic(12.5, weight: .semibold)
                p.foregroundColor = accent ? Theme.accent : Theme.ink
            }
            out += p
        }
        return out
    }

    // MARK: 印のシート

    private func markSheetView(_ sheet: MarkSheet) -> some View {
        let s = view?.segs.first { $0.seg == sheet.seg }
        let m = s?.spans.first { $0.id == sheet.id && $0.status != "exception" }
        let ref = docs.first { $0.seg == sheet.seg && $0.refs.contains { $0.id == sheet.id } }?.refs.first { $0.id == sheet.id }
        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let s, let m, let ref {
                    let st = m.status
                    let editing = sheet.editing || st == "edit"
                    let draft = sheet.editing ? sheet.draft : (st == "edit" ? (ref.text ?? "") : "")
                    Text(s.fullLabel).font(Theme.gothic(11.5)).foregroundStyle(Theme.muted).padding(.top, 20)
                    HStack(spacing: 8) {
                        Text(m.source).font(Theme.gothic(18, weight: .semibold))
                        Text("→").foregroundStyle(Theme.muted)
                        Text(m.word).font(Theme.gothic(18, weight: .semibold))
                    }
                    Text(snippet(s.text, m.start, m.end)).font(Theme.gothic(13)).foregroundStyle(Theme.muted)
                    option(on: st == "dict", main: "承認", sub: m.target.map { "辞書どおり「\($0)」" } ?? "辞書にない名前です") {
                        Task { await choose(s, m, "approve") }
                    }
                    .disabled(m.target == nil)
                    option(on: st == "edit", main: "手で直す", sub: st == "edit" ? "「\(ref.text ?? "")」（この箇所だけ）" : "この箇所だけ別の言葉に") {
                        markSheet = MarkSheet(seg: sheet.seg, id: sheet.id, editing: true, draft: draft)
                    }
                    if editing {
                        HStack(spacing: 8) {
                            // ⚠️ 確定の Enter で決めない（onSubmit は使わない。決めるのはボタンだけ）
                            TextField("この箇所だけの言葉", text: Binding(get: { markSheet?.draft ?? draft },
                                                                    set: { markSheet = MarkSheet(seg: sheet.seg, id: sheet.id, editing: true, draft: $0) }))
                                .font(Theme.gothic(15)).padding(.horizontal, 10).frame(minHeight: 40)
                                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                                .accessibilityIdentifier("markEdit")
                            Button("決める") { Task { await choose(s, m, "edit", markSheet?.draft ?? draft) } }.buttonStyle(PrimaryButtonStyle())
                        }
                    }
                    option(on: st == "reject", main: "拒否", sub: "実名のまま「\(m.source)」を出す", danger: true) {
                        Task { await choose(s, m, "reject") }
                    }
                    Text("どれを選んでも、かけらの原本は変わりません。" + (s.seg == "title" ? "タイトルは X にも投稿されます。" : "") + (s.seg == "description" ? "説明は X のカードにも出ます。" : ""))
                        .font(Theme.gothic(11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("その箇所はもうありません").emptyNote().padding(.top, 20)
                }
                HStack { Spacer(); Button("閉じる") { markSheet = nil }.buttonStyle(GhostButtonStyle()) }.padding(.top, 6)
            }
            .padding(.horizontal, 18).padding(.bottom, 20)
        }
        .background(Theme.paper.ignoresSafeArea())
    }

    private func option(on: Bool, main: String, sub: String, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                CheckBox(checked: on)
                Text(main).font(Theme.gothic(15, weight: .semibold)).foregroundStyle(danger ? Theme.accent : Theme.ink)
                Text(sub).font(Theme.gothic(12.5)).foregroundStyle(Theme.muted).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(12)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(on ? Theme.ink : Theme.line, lineWidth: Theme.hairline))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("opt-\(main)")
    }

    private func snippet(_ text: String, _ start: Int, _ end: Int) -> AttributedString {
        let ns = text as NSString
        let a = max(0, start - 14), b = min(ns.length, end + 14)
        func flat(_ s: String) -> String { s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression) }
        var out = AttributedString((a > 0 ? "…" : "") + flat(ns.substring(with: NSRange(location: a, length: start - a))))
        var w = AttributedString(ns.substring(with: NSRange(location: start, length: end - start)))
        w.font = Theme.gothic(13, weight: .bold)
        w.foregroundColor = Theme.ink
        out += w
        out += AttributedString(flat(ns.substring(with: NSRange(location: end, length: b - end))) + (b < ns.length ? "…" : ""))
        return out
    }

    private var rejectSheet: some View {
        let rejects: [(ConvertSeg, ResolvedSpan)] = (view?.rejects ?? []).compactMap { r in
            guard let s = view?.segs.first(where: { $0.seg == r.seg }), let m = s.spans.first(where: { $0.id == r.id }) else { return nil }
            return (s, m)
        }
        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("実名のまま出る箇所が \(Text("\(rejects.count)").foregroundStyle(Theme.accent)) つあります")
                    .font(Theme.gothic(16, weight: .semibold)).padding(.top, 22)
                ForEach(Array(rejects.enumerated()), id: \.offset) { _, x in
                    Button {
                        confirmReject = false
                        mode = "marks"
                        flashSeg = x.0.seg
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Text(x.1.source).font(Theme.gothic(14, weight: .semibold)).foregroundStyle(Theme.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(x.0.fullLabel).font(Theme.gothic(11)).foregroundStyle(Theme.muted)
                                Text(snippet(x.0.text, x.1.start, x.1.end)).font(Theme.gothic(12.5)).foregroundStyle(Theme.muted)
                            }
                            Spacer(minLength: 0)
                            Text("›").foregroundStyle(Theme.muted)
                        }
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .ruledRow()
                }
                Text(rich([("このまま書き出すと、公開される日記に実名が出ます。", false),
                           (rejects.contains { $0.0.seg == "title" } ? "タイトルに入っているので X にも出ます。" : "", true),
                           (rejects.contains { $0.0.seg == "description" } ? "説明に入っているので X のカードにも出ます。" : "", true),
                           ("行を押すとその箇所へ戻ります。", false)], accent: true))
                    .font(Theme.gothic(12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button("戻って見直す") { confirmReject = false }.buttonStyle(GhostButtonStyle())
                    Spacer()
                    Button("実名のまま書き出す") {
                        confirmReject = false
                        if let v = view { Task { await publish(v, confirmRealNames: true) } }
                    }
                    .buttonStyle(DangerButtonStyle()).disabled(busy)
                    .accessibilityIdentifier("publishReal")
                }
                .padding(.top, 6)
            }
            .padding(.horizontal, 18).padding(.bottom, 20)
        }
        .background(Theme.paper.ignoresSafeArea())
    }

    // MARK: 選ぶ・保存する

    /// 記号一つの選択を保存する（サーバが整えた記号で画面の文書を差し替える）
    private func choose(_ s: ConvertSeg, _ m: ResolvedSpan, _ action: String, _ text: String? = nil) async {
        do {
            let ref = try await API.shared.saveNameChoice(katachiId: katachiId, refId: m.id, action: action, text: text)
            if action == "edit" && ref.action == "approve" { Toast.shared.say("辞書どおりと同じなので、承認にしました") }
            docs = docs.map { d in
                var d = d
                d.refs = d.refs.map { $0.id == ref.id ? ref : $0 }
                return d
            }
            markSheet = nil
            version += 1
            flashSeg = s.seg
        } catch {
            Toast.shared.say("選択を保存できませんでした: \(error.localizedDescription)")
        }
    }

    private func togglePhoto(_ seg: String, _ key: String) {
        if photos.contains(where: { $0.kakeraId == seg && $0.key == key }) {
            photos.removeAll { $0.kakeraId == seg && $0.key == key }
        } else {
            photos.append(PhotoChoice(kakeraId: seg, key: key))
        }
        version += 1
        let next = photos
        Task {
            do { try await API.shared.savePhotoChoices(katachiId: katachiId, kakeraIds: order, photos: next) } catch {
                Toast.shared.say("写真の選択を保存できませんでした: \(error.localizedDescription)")
            }
        }
    }

    private func replaceDocs(_ seg: String, publish: DocView?, kakera: DocView?) {
        docs = docs.filter { !($0.seg == seg && ($0.kind == "publish" || (kakera != nil && $0.kind == "kakera"))) }
            + (kakera.map { [$0] } ?? []) + (publish.map { [$0] } ?? [])
        version += 1
    }

    private func savePb(_ s: ConvertSeg) async {
        guard let e = pbEdit, e.seg == s.seg else { return }
        if e.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Toast.shared.say("本文が空です。日記に出さないなら「組み直す」で外してください")
            return
        }
        // 開いたときの文から何も変えていないなら、書き換えを作らない
        if e.draft == e.shown { pbEdit = nil; return }
        pbBusy = true
        defer { pbBusy = false }
        do {
            let r = try await API.shared.savePublishBody(katachiId: katachiId, kakeraId: s.seg, base: e.initial, text: e.draft)
            pbCards.merge(r.cards) { _, b in b }
            replaceDocs(s.seg, publish: r.publish, kakera: r.kakera)
            pbEdit = nil
            if r.publish == nil { Toast.shared.say(s.hasPub ? "原本と同じ文になったので、原本のまま出します" : "原本と同じ文なので、原本のまま出します") }
        } catch {
            Toast.shared.say("日記用の文を保存できませんでした: \(error.localizedDescription)")
        }
    }

    private func acceptPb(_ seg: String) async {
        pbBusy = true
        defer { pbBusy = false }
        do {
            let row = try await API.shared.acceptPublishBody(katachiId: katachiId, kakeraId: seg)
            docs = docs.map { d in
                guard d.seg == seg, d.kind == "publish" else { return d }
                var d = d
                d.basis = row.basis
                d.stale = row.stale ?? false
                return d
            }
            version += 1
        } catch {
            Toast.shared.say("選べませんでした: \(error.localizedDescription)")
        }
    }

    private func discardPb(_ seg: String) async {
        pbBusy = true
        defer { pbBusy = false }
        do {
            try await API.shared.deletePublishBody(katachiId: katachiId, kakeraId: seg)
            replaceDocs(seg, publish: nil, kakera: nil)
            pbEdit = nil
        } catch {
            Toast.shared.say("原本に戻せませんでした: \(error.localizedDescription)")
        }
    }

    // MARK: 顔

    private func changeFaces(_ key: String, _ next: [PhotoFace]) {
        guard var st = faces[key] else { return }
        st.faces = next
        st.masked = false
        faces[key] = st
        Task {
            do {
                let saved = try await API.shared.savePhotoFaces(key: key, faces: next)
                if faces[key]?.faces == next { faces[key] = saved }
            } catch {
                Toast.shared.say("顔の枠を保存できませんでした: \(error.localizedDescription)")
            }
        }
    }

    /// 「顔を探す」: その写真だけ検出して、自動の枠を入れ替える（手で足した枠は残す）。一度に 1 枚だけ
    private func scan(_ key: String) async {
        guard scanning == nil, let st = faces[key] else { return }
        scanning = key
        scanProgress = nil
        faceErrors[key] = nil
        defer { scanning = nil; scanProgress = nil }
        do {
            let found = try await Faces.detect(key: key) { done, total in scanProgress = (done, total) }
            let manual = st.faces.filter { $0.source == "manual" }
            let next = found + manual
            faces[key]?.faces = next
            faces[key]?.masked = false
            faces[key] = try await API.shared.savePhotoFaces(key: key, faces: next)
            scannedHere.insert(key)
        } catch {
            faceErrors[key] = error.localizedDescription
        }
    }

    /// 書き出しの手前: 隠す枠のある写真のモザイク済みの版を作って置く
    private func prepareMasks(_ v: ConvertView) async throws -> Bool {
        if scanning != nil {
            Toast.shared.say("顔を探している途中です。終わってから書き出してください。")
            return false
        }
        let unread = v.wantFaces.filter { faces[$0] == nil }
        if !unread.isEmpty {
            Toast.shared.say("顔の枠を読み込めていない写真が \(unread.count) 枚あります。読み込めてから書き出してください。")
            return false
        }
        let todo = v.wantFaces.compactMap { k -> (String, [PhotoFace], String)? in
            guard let st = faces[k], let fp = FaceRules.fingerprint(st.faces), !(st.masked && st.fp == fp) else { return nil }
            return (k, st.faces, fp)
        }
        for (i, t) in todo.enumerated() {
            busyLabel = "モザイクをかけています（\(i + 1)／\(todo.count)）"
            guard let jpeg = try await Faces.maskedJPEG(key: t.0, faces: t.1) else { continue }
            try await API.shared.uploadMaskedPhoto(key: t.0, fp: t.2, jpeg: jpeg)
            faces[t.0]?.fp = t.2
            faces[t.0]?.masked = true
        }
        return true
    }

    private func publish(_ v: ConvertView, confirmRealNames: Bool) async {
        busy = true
        defer { busy = false; busyLabel = nil }
        do {
            guard try await prepareMasks(v) else { return }
        } catch {
            Toast.shared.say("モザイクをかけた写真を用意できませんでした: \(error.localizedDescription)")
            return
        }
        busyLabel = nil
        do {
            let r = try await API.shared.publishNikki(katachiId: katachiId, kakeraIds: order, title: titleInput, choices: v.choices, photos: photos,
                                                      confirmRealNames: confirmRealNames, docRevs: v.docRevs, dictRev: dictRev)
            _ = try? await store.loadDetail(katachiId)
            try? await store.loadKatachiList()
            Toast.shared.say((r.staleLeft ?? 0) > 0
                             ? "日記にしました。ただ、古い写真を \(r.staleLeft!) 枚消せませんでした（もう一度書き出すと消えます）"
                             : "日記にしました")
            nav.requestStart = .nikki
        } catch {
            Toast.shared.say(error.localizedDescription)
        }
    }
}

// MARK: - 写真と顔の枠（Web の FacePhoto.tsx）

struct FacePhotoView: View {
    let src: String
    let state: PhotoFaceState?
    let scanned: Bool
    let scanning: Bool
    let busyElsewhere: Bool
    let progress: (Int, Int)?
    let error: String?
    let onChange: ([PhotoFace]) -> Void
    let onScan: () -> Void
    let onReload: () -> Void

    @State private var image: UIImage?
    @State private var drawing = false
    @State private var draft: CGRect?

    private var faces: [PhotoFace] { state?.faces ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            stage
            HStack(spacing: 8) {
                status.font(Theme.gothic(12)).foregroundStyle(Theme.muted)
                Spacer(minLength: 4)
                if state == nil && error != nil {
                    Button("読み直す", action: onReload).buttonStyle(GhostButtonStyle())
                }
                if state != nil {
                    Button(scanned ? "顔を探し直す" : "顔を探す", action: onScan)
                        .buttonStyle(GhostButtonStyle())
                        .disabled(scanning || busyElsewhere || drawing)
                        .accessibilityIdentifier("scanFaces")
                    Button(drawing ? "やめる" : "囲む") { drawing.toggle(); draft = nil }
                        .buttonStyle(GhostButtonStyle())
                        .disabled(scanning)
                        .accessibilityIdentifier("drawFace")
                }
            }
        }
        .task(id: src) { image = await PhotoCache.shared.image(src) }
    }

    @ViewBuilder
    private var status: some View {
        let hidden = FaceRules.hidden(faces).count
        if scanning, let p = progress, p.1 > 1 { Text("顔を探しています（\(p.0)／\(p.1)）") }
        else if scanning { Text("顔を探しています…") }
        else if let error { Text("\(state != nil ? "顔を探せませんでした" : "顔の枠を読めませんでした")（\(error)）").foregroundStyle(Theme.accent) }
        else if state == nil { Text("読み込んでいます…") }
        else if !faces.isEmpty { Text("顔 隠す \(hidden)／出す \(faces.count - hidden)") }
        else if scanned { Text("顔は見つかりませんでした") }
        else { Text("顔は探していません") }
    }

    private var stage: some View {
        let aspect = image.map { $0.size.width > 0 ? $0.size.height / $0.size.width : 0.75 } ?? 0.75
        return GeometryReader { g in
            let W = g.size.width, H = g.size.height
            ZStack(alignment: .topLeading) {
                if let image {
                    Image(uiImage: image).resizable().frame(width: W, height: H)
                } else {
                    Theme.line.opacity(0.5).overlay(ProgressView())
                }
                ForEach(faces) { f in
                    faceBox(f).frame(width: f.w * W, height: f.h * H).offset(x: f.x * W, y: f.y * H)
                }
                if let d = draft {
                    Rectangle().strokeBorder(Theme.accent, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]))
                        .frame(width: d.width, height: d.height).offset(x: d.minX, y: d.minY)
                }
            }
            .contentShape(Rectangle())
            .gesture(drawing ? DragGesture(minimumDistance: 0).onChanged { v in
                let a = clamp(v.startLocation, W, H), b = clamp(v.location, W, H)
                draft = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
            }.onEnded { _ in
                guard let d = draft else { return }
                draft = nil
                guard let box = FaceRules.normalizeBox(x: d.minX / W, y: d.minY / H, w: d.width / W, h: d.height / H),
                      box.w >= 0.02, box.h >= 0.02 else { return } // 打ち損じ。囲むモードのまま描き直せる
                drawing = false
                onChange(faces + [PhotoFace(id: "m" + String(UUID().uuidString.prefix(8)).lowercased().replacingOccurrences(of: "-", with: ""),
                                            x: box.x, y: box.y, w: box.w, h: box.h, source: "manual", shown: false)])
            } : nil)
        }
        .aspectRatio(1 / max(0.1, aspect), contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }

    private func clamp(_ p: CGPoint, _ W: CGFloat, _ H: CGFloat) -> CGPoint {
        CGPoint(x: min(W, max(0, p.x)), y: min(H, max(0, p.y)))
    }

    private func faceBox(_ f: PhotoFace) -> some View {
        let masked = !f.shown
        return ZStack(alignment: .topTrailing) {
            if masked {
                Rectangle().fill(.ultraThinMaterial)
                Rectangle().fill(Color.black.opacity(0.25))
                Rectangle().strokeBorder(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 1, dash: f.source == "manual" ? [4, 3] : []))
            } else {
                Rectangle().strokeBorder(Color.white.opacity(0.9), lineWidth: 1)
                    .overlay(Rectangle().strokeBorder(Color.black.opacity(0.45), lineWidth: 0.5).padding(-1))
            }
            if f.source == "manual" && !drawing {
                Button { onChange(faces.filter { $0.id != f.id }) } label: {
                    Text("×").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.ink)
                        .frame(width: 20, height: 20).background(Color.white.opacity(0.9))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("この枠を消す")
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard !drawing, state != nil, !scanning else { return }
            onChange(faces.map { $0.id == f.id ? PhotoFace(id: $0.id, x: $0.x, y: $0.y, w: $0.w, h: $0.h, source: $0.source, shown: !$0.shown) : $0 })
        }
        .onLongPressGesture(minimumDuration: 0.6) {
            guard !drawing, f.source == "manual" else { return }
            onChange(faces.filter { $0.id != f.id })
        }
        .allowsHitTesting(!drawing)
        .accessibilityLabel("\(f.source == "manual" ? "囲んだ枠" : "顔")（\(f.shown ? "出す" : "隠す")）")
    }
}
