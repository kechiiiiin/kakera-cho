import SwiftUI

/// 日ごとの画面の上の入口（かたち・日記・ことば）と、かけら一覧の「かたちにする」
enum AppStart: String, Identifiable {
    case compose
    case katachi
    case nikki
    case words

    var id: String { rawValue }
}

/// 入口の先の行き先（Web の App.tsx の View と同じ並び）
enum Route: Hashable {
    case read(String)
    case assemble(String)
    case convert(katachiId: String, order: [String], title: String)
    case nameMap
    case word(String)
}

@Observable
@MainActor
final class AppNav {
    var path: [Route] = []
    /// 入口を切り替えてほしいとき（書き出した後は日記の一覧へ）
    var requestStart: AppStart?
    func push(_ r: Route) { path.append(r) }
    func pop() { if !path.isEmpty { path.removeLast() } }
    /// 行き先を全部閉じて、入口の画面へ
    func popToRoot() { path.removeAll() }
}

/// 全画面で開く、かたち・日記・ことば・かたちにする（Web の画面の同梱をやめてネイティブに・かけら帳ネイティブ化設計）。
/// 上にアプリの帯「‹ かけら」と、Web のタブと同じ かたち／日記／ことば。閉じると日ごとの画面へ戻り、かけら一覧を読み直す
struct AppScreens: View {
    @State var start: AppStart
    @State private var nav = AppNav()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            topbar
            NavigationStack(path: $nav.path) {
                root
                    .navigationDestination(for: Route.self) { r in destination(r) }
            }
        }
        .background(Theme.paper.ignoresSafeArea())
        .environment(nav)
        .toastOverlay()
        #if DEBUG
        .task { await debugPush() }
        #endif
        .onChange(of: nav.requestStart) { _, s in
            guard let s else { return }
            nav.popToRoot()
            start = s
            nav.requestStart = nil
        }
    }

    #if DEBUG
    /// 検査: 起動引数 -kakeraPush read:<id>,assemble:<id>,convert:<id>,nameMap,word:<言葉> で行き先まで開く（スクリーンショット用）
    private func debugPush() async {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-kakeraPush"), args.index(after: i) < args.endIndex else { return }
        for item in args[args.index(after: i)].split(separator: ",").map(String.init) {
            let p = item.split(separator: ":", maxSplits: 1).map(String.init)
            switch p.first {
            case "read": nav.push(.read(p[1]))
            case "assemble": nav.push(.assemble(p[1]))
            case "convert":
                guard let d = try? await KakeraStore.shared.loadDetail(p[1]) else { continue }
                let order = OrderRules.initialOrder(kakera: d.kakera.map { ($0.id, $0.writtenAt) }, publishedIds: d.publishedIds)
                nav.push(.convert(katachiId: p[1], order: order, title: d.katachi.title))
            case "nameMap": nav.push(.nameMap)
            case "word": nav.push(.word(p[1]))
            default: break
            }
        }
    }
    #endif

    private var topbar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button("‹ かけら") { dismiss() }
                    .buttonStyle(LinkButtonStyle(color: Theme.ink))
                    .accessibilityIdentifier("closeApp")
                Spacer()
                ForEach([(AppStart.katachi, "かたち"), (.nikki, "日記"), (.words, "ことば")], id: \.0) { s, label in
                    Button {
                        nav.popToRoot()
                        start = s
                    } label: {
                        Text(label).font(Theme.gothic(12.5, weight: .medium)).tracking(12.5 * 0.02)
                            .padding(.horizontal, 5).frame(minHeight: 36)
                            .overlay(alignment: .bottom) {
                                if start == s { Rectangle().fill(Theme.ink).frame(height: 1.5) }
                            }
                    }
                    .buttonStyle(LinkButtonStyle(color: start == s ? Theme.ink : Theme.muted))
                    .accessibilityIdentifier("tab-\(s.rawValue)")
                }
            }
            .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 4)
            Rule()
        }
        .background(Theme.paper.ignoresSafeArea(edges: .top))
    }

    @ViewBuilder
    private var root: some View {
        switch start {
        case .compose: ComposeScreen(onBack: { dismiss() })
        case .katachi: KatachiListScreen()
        case .nikki: NikkiListScreen()
        case .words: WordsScreen()
        }
    }

    @ViewBuilder
    private func destination(_ r: Route) -> some View {
        switch r {
        case .read(let id): ReadScreen(id: id)
        case .assemble(let id): AssembleScreen(id: id)
        case .convert(let id, let order, let title): ConvertScreen(katachiId: id, order: order, titleInput: title)
        case .nameMap: NameMapScreen()
        case .word(let w): WordPageScreen(word: w)
        }
    }
}

/// 画面の地（罫と余白だけ・ナビゲーションバーは出さない）
struct Screen<Content: View>: View {
    var read = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 40)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .background((read ? Color.white : Theme.paper).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }
}

// MARK: - かたち（一覧・検索）

struct KatachiListScreen: View {
    @Environment(AppNav.self) private var nav
    @State private var store = KakeraStore.shared
    @State private var query = ""
    @State private var results: [SearchResult]?

    private var inSearch: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        Screen {
            Text("かたち").font(Theme.gothic(19, weight: .medium)).foregroundStyle(Theme.ink).padding(.bottom, 12)
            TextField("検索", text: $query)
                .font(Theme.gothic(15)).padding(.horizontal, 12).frame(minHeight: 40)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                .submitLabel(.search)
                .accessibilityIdentifier("search")
                .padding(.bottom, 8)
            if inSearch {
                if let results {
                    if results.isEmpty { Text("見つかりませんでした").emptyNote() }
                    ForEach(results) { r in
                        row(id: r.id, title: r.title.isEmpty ? r.date : r.title, untitled: r.title.isEmpty,
                            date: "\(r.date.dropFirst(5)) (\(DayText.weekday(r.date)))", nikki: r.hasNikki) {
                            ForEach(r.matches, id: \.kakeraId) { m in
                                highlighted(m.excerpt)
                            }
                        }
                    }
                } else {
                    Text("調べています").emptyNote()
                }
            } else if !store.katachiLoaded {
                Text("読み込んでいます").emptyNote()
            } else if store.katachiList.isEmpty {
                Text("まだかたちがありません").emptyNote()
            } else {
                ForEach(months, id: \.0) { m, rows in
                    Text(DayText.month(m)).font(Theme.gothic(12, weight: .semibold)).foregroundStyle(Theme.muted)
                        .tracking(12 * 0.06).padding(.top, 22).padding(.bottom, 4)
                    ForEach(rows) { k in
                        row(id: k.id, title: k.title.isEmpty ? k.lead : k.title, untitled: k.title.isEmpty,
                            date: "\(k.date.dropFirst(8)) (\(DayText.weekday(k.date)))", nikki: k.hasNikki) { EmptyView() }
                    }
                }
            }
        }
        .refreshable { await Toast.shared.guarded { try await store.loadKatachiList() } }
        .task { await Toast.shared.guarded { try await store.loadKatachiList() } }
        // 打つたびに 250ms 待って引く。空にしたら結果を捨てて一覧に戻る
        .task(id: query) {
            results = nil
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !q.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            do {
                let r = try await API.shared.search(q)
                if !Task.isCancelled { results = r }
            } catch {
                if !Task.isCancelled { Toast.shared.say(error.localizedDescription) }
            }
        }
    }

    private var months: [(String, [KatachiSummary])] {
        var order: [String] = []
        var by: [String: [KatachiSummary]] = [:]
        for k in store.katachiList {
            let m = String(k.date.prefix(7))
            if by[m] == nil { order.append(m) }
            by[m, default: []].append(k)
        }
        return order.map { ($0, by[$0]!) }
    }

    private func highlighted(_ text: String) -> some View {
        var a = AttributedString()
        for (s, hit) in Highlight.pieces(text, query: query) {
            var p = AttributedString(s)
            if hit { p.foregroundColor = Theme.accent; p.font = Theme.gothic(12.5, weight: .semibold) }
            a += p
        }
        return Text(a).font(Theme.gothic(12.5)).foregroundStyle(Theme.muted).lineLimit(3)
    }

    private func row<Extra: View>(id: String, title: String, untitled: Bool, date: String, nikki: Bool,
                                  @ViewBuilder extra: () -> Extra) -> some View {
        Button { nav.push(.read(id)) } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(Theme.gothic(15, weight: untitled ? .regular : .medium))
                        .foregroundStyle(untitled ? Theme.muted : Theme.ink).lineLimit(2).multilineTextAlignment(.leading)
                    Text(date).font(Theme.mono(11.5)).foregroundStyle(Theme.muted)
                    extra()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if nikki { NikkiBadge() }
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .ruledRow()
    }
}

/// 「日記あり」（.badge-published: 朱の小さな札）
struct NikkiBadge: View {
    var body: some View {
        Text("日記あり").font(Theme.gothic(10.5, weight: .medium)).foregroundStyle(Theme.accent)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.accent, lineWidth: Theme.hairline))
    }
}

// MARK: - かたちを読む

struct ReadScreen: View {
    let id: String
    @Environment(AppNav.self) private var nav
    @State private var store = KakeraStore.shared
    @State private var editing = false
    @State private var titleDraft = ""
    @State private var dateDraft = ""
    @State private var busy = false
    @State private var picking = false
    @State private var editDraft: Draft?
    @State private var confirmDate = false
    @State private var confirmDetach: String?
    @State private var confirmDissolve = false

    private var detail: KatachiDetail? { store.details[id] }

    var body: some View {
        Screen(read: !editing) {
            BackRow(label: "一覧へ戻る", action: { nav.pop() }) {
                Button(editing ? "読む" : "直す") {
                    if let d = detail {
                        titleDraft = d.katachi.title
                        dateDraft = d.katachi.date
                    }
                    editing.toggle()
                }
                .buttonStyle(GhostButtonStyle())
                .accessibilityIdentifier("modeToggle")
            }
            if let d = detail {
                content(d)
            } else {
                Text("読み込んでいます").emptyNote()
            }
        }
        .environment(\.richContext, RichContext(openWord: { nav.push(.word($0)) }, mincho: !editing))
        .task { await Toast.shared.guarded { try await store.loadDetail(id) } }
        .sheet(item: $editDraft) { d in
            EditorView(draft: d, cards: detail?.cards ?? [:]) {
                Task {
                    await Toast.shared.guarded {
                        try await store.loadDetail(id)
                        try await store.loadKatachiList()
                    }
                }
            }
        }
        .sheet(isPresented: $picking) {
            KakeraPickSheet { ids in
                let next = try await API.shared.addKakera(toKatachi: id, kakeraIds: ids)
                store.details[id] = next
                try await store.loadNagare()
                try await store.loadKatachiList()
                Toast.shared.say(KakeraStore.addedMessage(next))
                picking = false
            }
        }
        .confirmationDialog(dateConfirmText, isPresented: $confirmDate, titleVisibility: .visible) {
            Button("日付を変える") { Task { await changeDate(moveNikki: true) } }
        }
        .confirmationDialog("このかけらをかたちから外して、かけらたちへ戻します。よろしいですか？",
                            isPresented: Binding(get: { confirmDetach != nil }, set: { if !$0 { confirmDetach = nil } }), titleVisibility: .visible) {
            Button("かけらたちへ戻す") {
                guard let k = confirmDetach else { return }
                Task { await run("かけらたちへ戻しました") {
                    try await API.shared.detachKakera(katachiId: id, kakeraId: k)
                    try await store.loadDetail(id)
                    try await store.loadNagare()
                    try await store.loadKatachiList()
                } }
            }
        }
        .confirmationDialog("このかたちを解きます。中のかけらはかけらたちへ戻ります。よろしいですか？", isPresented: $confirmDissolve, titleVisibility: .visible) {
            Button("かたちを解く", role: .destructive) {
                Task { await run("かたちを解きました") {
                    try await API.shared.dissolveKatachi(id)
                    try await store.loadNagare()
                    try await store.loadKatachiList()
                    store.details[id] = nil
                    nav.pop()
                } }
            }
        }
    }

    private var dateConfirmText: String {
        "このかたちは日記になっています。日付を \(dateDraft) に変えると、公開中の日記の日付と URL も変わります（旧 URL は新しい方へ転送します。X には投稿しません）。よろしいですか？"
    }

    /// 題は1行。改行は空白にして前後を落とす
    private var titleNorm: String {
        titleDraft.replacingOccurrences(of: #"\s*[\r\n]+\s*"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private func content(_ d: KatachiDetail) -> some View {
        let k = d.katachi
        if editing {
            Text(DayText.heading(k.date)).font(Theme.mono(12)).foregroundStyle(Theme.muted).padding(.top, 8)
            FieldBox(label: "かたちの題") {
                TextField(DayText.literary(k.date), text: $titleDraft, axis: .vertical).lineLimit(1...3)
                    .accessibilityIdentifier("titleField")
            }
            HStack {
                Spacer()
                Button("題を変える") {
                    Task { await run("題を変えました") {
                        store.details[id] = try await API.shared.updateKatachi(id, ["title": titleNorm])
                        titleDraft = titleNorm
                        try await store.loadKatachiList()
                    } }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy || titleNorm == k.title)
            }
            .padding(.top, 8)
            if d.nikki != nil { note("公開中の日記の題は、次に日記へ書き足すときに変わります") }
            FieldBox(label: "かたちの日付") { DayField(day: $dateDraft) }
            HStack {
                Spacer()
                Button("日付を変える") {
                    if d.nikki != nil { confirmDate = true } else { Task { await changeDate(moveNikki: false) } }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy || dateDraft.isEmpty || dateDraft == k.date)
            }
            .padding(.top, 8)
            if d.nikki != nil { note("日記になっています。変えると公開中の日記の日付と URL も変わります") }
            if !d.kakera.isEmpty {
                TimeBulkBar(shown: d.kakera.filter { $0.showTime == true }.count, total: d.kakera.count, disabled: busy) { show in
                    Task { await setTime(d.kakera.map(\.id), show) }
                }
                .padding(.top, 18)
                if d.nikki != nil { note("公開中の日記の時刻は、次に日記へ書き足すときに変わります") }
            }
        } else if !k.title.isEmpty {
            Text(DayText.heading(k.date)).font(Theme.mono(12)).foregroundStyle(Theme.muted).padding(.top, 8)
            readTitle(k.title)
        } else {
            readTitle(DayText.literary(k.date))
        }

        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(d.kakera.enumerated()), id: \.element.id) { i, kk in
                VStack(alignment: .leading, spacing: 8) {
                    if kk.showTime == true {
                        Text(TimeLabel.label(kk.writtenAt, katachiDate: k.date)).font(Theme.mono(12)).foregroundStyle(Theme.muted)
                    }
                    RichTextView(kk.body, cards: d.cards)
                    if editing {
                        HStack(spacing: 8) {
                            Button("直す") { editDraft = .edit(kk.kakera) }.buttonStyle(GhostButtonStyle())
                            Button("かけらたちへ戻す") { confirmDetach = kk.id }.buttonStyle(GhostButtonStyle())
                            Spacer(minLength: 0)
                            TimeToggle(checked: kk.showTime == true, disabled: busy) { on in Task { await setTime([kk.id], on) } }
                        }
                    }
                }
                .padding(.vertical, 22)
                .overlay(alignment: .bottom) { if i < d.kakera.count - 1 { Rule() } }
            }
        }

        if editing {
            Button("かけらを足す") { picking = true }
                .buttonStyle(GhostButtonStyle(fullWidth: true)).padding(.top, 20)
                .accessibilityIdentifier("addKakera")
        }
        Button(d.nikki != nil ? "日記に書き足す" : "日記にする") { nav.push(.assemble(id)) }
            .buttonStyle(CTAButtonStyle(fullWidth: true))
            .padding(.top, editing ? 14 : 26)
            .accessibilityIdentifier("toAssemble")
        if editing && d.nikki == nil {
            Button("かたちを解く") { confirmDissolve = true }
                .buttonStyle(GhostButtonStyle(fullWidth: true)).padding(.top, 14)
        }
    }

    private func readTitle(_ t: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(t).font(Theme.mincho(26)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 16)
            Rule()
        }
        .padding(.top, 6)
    }

    private func note(_ s: String) -> some View {
        Text(s).font(Theme.gothic(11.5)).foregroundStyle(Theme.muted).lineSpacing(3).padding(.top, 6).fixedSize(horizontal: false, vertical: true)
    }

    private func run(_ done: String?, _ f: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await f()
            if let done { Toast.shared.say(done) }
        } catch {
            Toast.shared.say(error.localizedDescription)
        }
    }

    private func changeDate(moveNikki: Bool) async {
        let date = dateDraft
        await run(moveNikki ? "日付を変えました。公開中の日記も新しい日付・URL に移しました" : "日付を変えました") {
            var patch: [String: Any] = ["date": date]
            if moveNikki { patch["move_nikki"] = true }
            store.details[id] = try await API.shared.updateKatachi(id, patch)
            try await store.loadKatachiList()
        }
    }

    private func setTime(_ ids: [String], _ show: Bool) async {
        await run(nil) { store.details[id] = try await API.shared.setShowTime(katachiId: id, kakeraIds: ids, show: show) }
    }
}
