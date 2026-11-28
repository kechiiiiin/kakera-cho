import SwiftUI

// MARK: - 日記（一覧・Web の NikkiListScreen.tsx）

struct NikkiListScreen: View {
    @Environment(AppNav.self) private var nav
    @State private var store = KakeraStore.shared

    var body: some View {
        Screen {
            HStack(alignment: .firstTextBaseline) {
                Text("日記").font(Theme.gothic(19, weight: .medium)).foregroundStyle(Theme.ink)
                Spacer()
                Button("名前の辞書") { nav.push(.nameMap) }
                    .buttonStyle(LinkButtonStyle(color: Theme.muted))
                    .accessibilityIdentifier("nameMap")
            }
            Text("これまでに日記にしたものの一覧です。").pageSub().padding(.bottom, 10)
            let list = store.katachiList.filter(\.hasNikki)
            if !store.katachiLoaded {
                Text("読み込んでいます").emptyNote()
            } else if list.isEmpty {
                Text("まだ日記になったものがありません").emptyNote()
            }
            ForEach(list) { k in
                VStack(alignment: .leading, spacing: 4) {
                    Button { nav.push(.read(k.id)) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(k.date).font(Theme.mono(11.5)).foregroundStyle(Theme.muted)
                            Text(k.title.isEmpty ? DayText.literary(k.date) : k.title)
                                .font(Theme.gothic(15, weight: .medium)).foregroundStyle(Theme.ink).multilineTextAlignment(.leading)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if let url = URL(string: DayText.publishedURL(k.date)) {
                        Link(DayText.publishedURL(k.date), destination: url)
                            .font(Theme.mono(11)).foregroundStyle(Theme.accent).lineLimit(1).truncationMode(.middle)
                    }
                }
                .padding(.vertical, 12)
                .ruledRow()
            }
        }
        .refreshable { await Toast.shared.guarded { try await store.loadKatachiList() } }
        .task { await Toast.shared.guarded { try await store.loadKatachiList() } }
    }
}

// MARK: - 名前の辞書（Web の NameMapScreen.tsx）

struct NameMapScreen: View {
    @Environment(AppNav.self) private var nav
    @State private var entries: [NameEntry]?
    @State private var editId: String?
    @State private var edit = NameDraft()
    @State private var arm = false
    @State private var add = NameDraft()
    @State private var tryText = ""
    @State private var tried: NameTry?
    @State private var busy = false

    struct NameDraft: Equatable {
        var source = ""
        var target = ""
        var exception = false
    }

    var body: some View {
        Screen {
            BackRow("日記へ戻る") { nav.pop() }
            PageTitle(title: "名前の辞書")
            Text("日記に書き出すときだけ、左の言葉を右に置き換えます。かけらは変わりません。\(Text("長い語から先に当てる").font(Theme.gothic(12.5, weight: .semibold)).foregroundStyle(Theme.ink))ので、例外に足した語の中にある短い名前には当たりません。")
                .pageSub().fixedSize(horizontal: false, vertical: true)
            if let list = entries {
                let rep = list.filter { !$0.isException }
                let exc = list.filter(\.isException)
                SectionHead(title: "置き換え（\(rep.count)）")
                if rep.isEmpty { Text("ありません").emptyNote() }
                ForEach(rep) { row($0) }
                SectionHead(title: "例外・置き換えない（\(exc.count)）")
                if exc.isEmpty { Text("ありません").emptyNote() }
                ForEach(exc) { row($0) }
            } else {
                Text("読み込んでいます").emptyNote()
            }
            SectionHead(title: "足す")
            draftFields($add)
            HStack {
                Spacer()
                Button("辞書に足す") {
                    guard check(add, id: nil) else { return }
                    Task { await run("辞書に足しました") {
                        try await API.shared.addNameEntry(source: trim(add.source), target: trim(add.target), exception: add.exception)
                        try await reload()
                        add = NameDraft()
                    } }
                }
                .buttonStyle(GhostButtonStyle())
                .disabled(busy || entries == nil)
                .accessibilityIdentifier("addEntry")
            }
            .padding(.top, 8)
            SectionHead(title: "試し書き")
            TextField("ここに書くと、置き換えた結果が下に出ます", text: $tryText)
                .font(Theme.gothic(15)).padding(.horizontal, 12).frame(minHeight: 42)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                .accessibilityIdentifier("tryText")
            Group {
                if tryText.isEmpty {
                    Text("（ここに結果が出ます）").foregroundStyle(Theme.muted)
                } else if let tried {
                    MarkedText(text: tried.text, spans: tried.spans)
                }
            }
            .font(Theme.gothic(15)).padding(.top, 10)
            Text("辞書はかけら帳のデータベースにだけ置きます（リポジトリには書きません）。直すと、次に組み直した日記から効きます。")
                .font(Theme.gothic(11.5)).foregroundStyle(Theme.muted).padding(.top, 18).fixedSize(horizontal: false, vertical: true)
        }
        .task { await Toast.shared.guarded { try await reload() } }
        .task(id: "\(tryText)#\(entries?.count ?? -1)#\(entries?.map(\.target).joined() ?? "")") {
            guard !tryText.isEmpty, let entries else { tried = nil; return }
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            if let r = try? await API.shared.nameTry(text: tryText, entries: entries), !Task.isCancelled { tried = r }
        }
    }

    private func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func reload() async throws { entries = try await API.shared.nameMap() }

    /// 画面の側でも最低限は確かめる（サーバでも同じことを確かめる）
    private func check(_ d: NameDraft, id: String?) -> Bool {
        let source = trim(d.source)
        if source.isEmpty { Toast.shared.say("置き換え元を入れてください"); return false }
        if !d.exception && trim(d.target).isEmpty { Toast.shared.say("置き換え先を入れてください（置き換えないなら例外に）"); return false }
        if (entries ?? []).contains(where: { $0.source == source && $0.id != id }) { Toast.shared.say("「\(source)」はもう辞書にあります"); return false }
        return true
    }

    private func run(_ done: String, _ f: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do { try await f(); Toast.shared.say(done) } catch { Toast.shared.say(error.localizedDescription) }
    }

    @ViewBuilder
    private func row(_ e: NameEntry) -> some View {
        if editId == e.id {
            VStack(alignment: .leading, spacing: 8) {
                draftFields($edit)
                HStack(spacing: 8) {
                    Button("保存") {
                        guard check(edit, id: e.id) else { return }
                        Task { await run("辞書を直しました。次に組み直した日記から効きます") {
                            try await API.shared.updateNameEntry(e.id, source: trim(edit.source), target: trim(edit.target), exception: edit.exception)
                            try await reload()
                            editId = nil
                        } }
                    }
                    .buttonStyle(PrimaryButtonStyle()).disabled(busy)
                    Button("やめる") { editId = nil }.buttonStyle(GhostButtonStyle())
                    Spacer()
                    Button(arm ? "本当に消す" : "消す") {
                        if !arm { arm = true; return }
                        Task { await run("消しました。辞書どおりだった箇所は実名に戻り、手で直した言葉は残ります") {
                            try await API.shared.deleteNameEntry(e.id)
                            try await reload()
                            editId = nil
                            arm = false
                        } }
                    }
                    .buttonStyle(DangerButtonStyle()).disabled(busy)
                }
            }
            .padding(.vertical, 12)
            .ruledRow()
        } else {
            Button {
                editId = e.id
                arm = false
                edit = NameDraft(source: e.source, target: e.isException ? "" : e.target, exception: e.isException)
            } label: {
                HStack(spacing: 8) {
                    Text(e.source).font(Theme.gothic(15)).foregroundStyle(Theme.ink)
                    Text("→").font(Theme.gothic(13)).foregroundStyle(Theme.muted)
                    Text(e.isException ? "そのまま" : e.target).font(Theme.gothic(15)).foregroundStyle(e.isException ? Theme.muted : Theme.ink)
                    Spacer()
                    Text("›").foregroundStyle(Theme.muted)
                }
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .ruledRow()
        }
    }

    private func draftFields(_ d: Binding<NameDraft>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField("置き換え元", text: d.source).nameField()
                Text("→").foregroundStyle(Theme.muted)
                TextField(d.wrappedValue.exception ? "そのまま" : "置き換え先", text: d.target).nameField()
                    .disabled(d.wrappedValue.exception)
            }
            Button {
                d.wrappedValue.exception.toggle()
                d.wrappedValue.target = ""
            } label: {
                HStack(spacing: 8) {
                    CheckBox(checked: d.wrappedValue.exception)
                    Text("例外（置き換えずにそのまま出す）").font(Theme.gothic(13)).foregroundStyle(Theme.ink)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

private extension View {
    func nameField() -> some View {
        self.font(Theme.gothic(15)).padding(.horizontal, 10).frame(minHeight: 40)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
            .textInputAutocapitalization(.never).autocorrectionDisabled()
    }
}

/// 印つきの文（押せない印・試し書き）。位置は UTF-16
struct MarkedText: View {
    let text: String
    let spans: [ResolvedSpan]

    var body: some View {
        Text(NameMarks.attributed(text, spans: spans, range: NSRange(location: 0, length: (text as NSString).length), pressable: false))
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - ことば（Web の WordsScreen.tsx）

struct WordsScreen: View {
    @Environment(AppNav.self) private var nav
    @State private var list: [WordSummary]?

    var body: some View {
        Screen {
            Text("ことば").font(Theme.gothic(19, weight: .medium)).foregroundStyle(Theme.ink).padding(.bottom, 8)
            if let list {
                if list.isEmpty {
                    Text("まだ言葉がありません。書く欄で言葉を選んで [[ ]] を押すと、ここに溜まります").emptyNote()
                } else {
                    Text("\(list.count)個の言葉。新しく書いた順。").pageSub().padding(.bottom, 8)
                    ForEach(list) { w in
                        Button { nav.push(.word(w.word)) } label: {
                            HStack(spacing: 10) {
                                Text(w.word).font(Theme.gothic(15)).foregroundStyle(Theme.accent)
                                Spacer()
                                Text(String(w.lastWrittenAt.prefix(10).dropFirst(5)).replacingOccurrences(of: "-", with: "/"))
                                    .font(Theme.mono(11.5)).foregroundStyle(Theme.muted)
                                Text("\(w.count)").font(Theme.mono(11.5)).foregroundStyle(Theme.muted).frame(minWidth: 22, alignment: .trailing)
                            }
                            .padding(.vertical, 11)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .ruledRow(first: w.id == list.first?.id)
                        .accessibilityIdentifier("word-\(w.word)")
                    }
                }
            } else {
                Text("読み込んでいます").emptyNote()
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do { list = try await API.shared.words() } catch { Toast.shared.say(error.localizedDescription) }
    }
}

/// 言葉のページ。集まったかけらを日ごとに（時刻・居場所）。ページの言葉自身は太字で、他の言葉はリンク
struct WordPageScreen: View {
    let word: String
    @Environment(AppNav.self) private var nav
    @State private var detail: WordDetail?

    private var backLabel: String {
        let p = nav.path
        guard p.count >= 2 else { return "ことば" }
        switch p[p.count - 2] {
        case .word(let w): return w
        case .read: return "かたち"
        default: return "ことば"
        }
    }

    var body: some View {
        Screen {
            BackRow(backLabel) { nav.pop() }
            Text(word).font(Theme.gothic(24, weight: .semibold)).foregroundStyle(Theme.ink).padding(.bottom, 6)
            if let d = detail {
                Text("\(d.kakera.count)個のかけら").pageSub().padding(.bottom, 6)
                ForEach(Array(d.kakera.enumerated()), id: \.element.id) { i, k in
                    let day = String(k.writtenAt.prefix(10))
                    if i == 0 || String(d.kakera[i - 1].writtenAt.prefix(10)) != day {
                        Text(DayText.group(day)).font(Theme.mono(11.5)).foregroundStyle(Theme.muted).padding(.top, 18).padding(.bottom, 4)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        RichTextView(k.body, cards: d.cards)
                        Text("\(String(k.writtenAt.dropFirst(11).prefix(5))) ・ \(place(k))").font(Theme.mono(11)).foregroundStyle(Theme.muted)
                    }
                    .padding(.vertical, 12)
                    .ruledRow()
                }
            } else {
                Text("読み込んでいます").emptyNote()
            }
        }
        .environment(\.richContext, RichContext(openWord: { w in if w != word { nav.push(.word(w)) } }, hereWord: word))
        .task(id: word) {
            detail = nil
            do { detail = try await API.shared.word(word) } catch { Toast.shared.say(error.localizedDescription) }
        }
    }

    /// かけらの居場所（`かけらたち`・`かたち 11/1`）
    private func place(_ k: WordKakera) -> String {
        guard let d = k.katachiDate else { return "かけらたち" }
        let p = d.split(separator: "-").compactMap { Int($0) }
        return p.count == 3 ? "かたち \(p[1])/\(p[2])" : "かたち"
    }
}
