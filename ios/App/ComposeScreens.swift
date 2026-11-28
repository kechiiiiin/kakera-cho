import SwiftUI

// MARK: - かたちにする（Web の ComposeScreen.tsx）

/// 入れるかけらを選ぶ（未かたちのみ）→ 日付 → 題。かたちの中は常に書いた順。
/// 「かたちにする」を押すと、既にページがある言葉の確認を1枚挟む（候補が無い・索引を取れないときは挟まない）
struct ComposeScreen: View {
    let onBack: () -> Void
    @Environment(AppNav.self) private var nav
    @State private var store = KakeraStore.shared
    @State private var picks = PickTexts.shared
    @State private var picked: [String] = []
    @State private var showTime: [String] = []
    @State private var date = ""
    @State private var dateAuto = true
    @State private var title = ""
    @State private var busy = false
    /// 言葉の確認の行（nil = 確認を開いていない）と、外した行
    @State private var rows: [WordPlanRow]?
    @State private var off: Set<String> = []

    private var byId: [String: Kakera] { Dictionary(store.nagare.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
    private var chosen: [Kakera] {
        let m = byId
        return picked.compactMap { m[$0] }.sorted { OrderRules.writtenOrder(($0.writtenAt, $0.id), ($1.writtenAt, $1.id)) }
    }
    private var writtenAt: [String: String] { Dictionary(store.nagare.map { ($0.id, $0.writtenAt) }, uniquingKeysWith: { a, _ in a }) }

    var body: some View {
        Group {
            if let rows { confirm(rows) } else { pick }
        }
        .task {
            await Toast.shared.guarded { try await store.loadNagare() }
            await picks.ensure(store.nagare.map(\.body), cards: store.nagareCards)
        }
    }

    private var pick: some View {
        Screen {
            BackRow("かけらへ戻る", action: onBack)
            PageTitle(title: "かたちにする", sub: "かけらたちから、ひとつのかたちを作ります。")
            SectionHead(title: "入れるかけらを選ぶ")
            if !store.nagareLoaded {
                Text("読み込んでいます").emptyNote()
            } else if store.nagare.isEmpty {
                Text("まだかたちになっていないかけらがありません").emptyNote()
            }
            ForEach(store.nagare) { k in
                PickRow(checked: picked.contains(k.id), thumb: k.body, action: { toggle(k.id) }) {
                    Excerpt(text: picks.text(k.body))
                    Text("\(DayText.heading(k.dayKey)) \(k.hhmm)").font(Theme.mono(11)).foregroundStyle(Theme.muted)
                }
                .ruledRow(first: k.id == store.nagare.first?.id, last: k.id == store.nagare.last?.id)
                .accessibilityIdentifier("pick-\(k.id)")
            }
            FieldBox(label: "かたちの日付") {
                DayField(day: Binding(get: { date }, set: { date = $0; dateAuto = false }))
            }
            .padding(.top, 10)
            FieldBox(label: "タイトル") {
                TextField("タイトル（任意）", text: $title).accessibilityIdentifier("composeTitle")
            }
            SectionHead(title: "書いた順にかたちになります（\(chosen.count)）")
            if chosen.isEmpty {
                Text("まだ選ばれていません").emptyNote()
            } else {
                TimeBulkBar(shown: chosen.filter { showTime.contains($0.id) }.count, total: chosen.count) { show in
                    showTime = show ? chosen.map(\.id) : []
                }
                ForEach(chosen) { k in
                    HStack(alignment: .top, spacing: 10) {
                        Text(k.hhmm).font(Theme.mono(11.5)).foregroundStyle(Theme.muted).frame(width: 40, alignment: .leading).padding(.top, 2)
                        Excerpt(text: picks.text(k.body)).frame(maxWidth: .infinity, alignment: .leading)
                        TimeToggle(checked: showTime.contains(k.id)) { on in
                            showTime.removeAll { $0 == k.id }
                            if on { showTime.append(k.id) }
                        }
                    }
                    .padding(.vertical, 8)
                    .ruledRow(first: k.id == chosen.first?.id)
                }
            }
            Button(busy ? "確かめています" : "かたちにする") { Task { await create() } }
                .buttonStyle(CTAButtonStyle(fullWidth: true))
                .disabled(chosen.isEmpty || date.isEmpty || busy)
                .padding(.top, 22)
                .accessibilityIdentifier("composeCreate")
        }
    }

    private func confirm(_ rows: [WordPlanRow]) -> some View {
        let count = rows.filter { !off.contains($0.key) }.count
        return Screen {
            BackRow("かけらを選び直す") { if !busy { self.rows = nil } }
            PageTitle(title: "この言葉もリンクにしますか", sub: "すでにページがある言葉です。いらないものは外してください。")
            ForEach(rows) { r in
                PickRow(checked: !off.contains(r.key), action: {
                    guard !busy else { return }
                    if off.contains(r.key) { off.remove(r.key) } else { off.insert(r.key) }
                }) {
                    contextText(r)
                }
                .ruledRow(first: r.key == rows.first?.key, last: r.key == rows.last?.key)
            }
            Button(count > 0 ? "\(count)か所をリンクにして、かたちにする" : "そのまま、かたちにする") {
                Task { await confirmLinks(rows) }
            }
            .buttonStyle(CTAButtonStyle(fullWidth: true))
            .disabled(busy)
            .padding(.top, 22)
            .accessibilityIdentifier("confirmWords")
        }
    }

    private func contextText(_ r: WordPlanRow) -> some View {
        var a = AttributedString(r.before)
        var w = AttributedString(r.word)
        w.foregroundColor = Theme.accent
        w.font = Theme.gothic(14, weight: .semibold)
        a += w
        a += AttributedString(r.after)
        return Text(a).font(Theme.gothic(14)).foregroundStyle(Theme.ink).lineSpacing(3)
    }

    private func toggle(_ id: String) {
        if picked.contains(id) {
            picked.removeAll { $0 == id }
            showTime.removeAll { $0 == id }
        } else {
            picked.append(id)
        }
        if dateAuto { date = OrderRules.composeDate(picked, writtenAt: writtenAt) }
    }

    private func create() async {
        guard !chosen.isEmpty, !busy else { return }
        busy = true
        defer { busy = false }
        // 索引を取れなければ確認を挟まず進む
        let pages = (try? await API.shared.words().map(\.word)) ?? []
        var found: [WordPlanRow] = []
        if !pages.isEmpty {
            do {
                found = try await API.shared.wordPlan(kakera: chosen.map { ($0.id, $0.body) }, pages: pages, cards: store.nagareCards)
            } catch {
                found = []
            }
        }
        if !found.isEmpty {
            off = []
            rows = found
            return
        }
        await finish([])
    }

    private func confirmLinks(_ list: [WordPlanRow]) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let bodies = Dictionary(chosen.map { ($0.id, $0.body) }, uniquingKeysWith: { a, _ in a })
        await finish(WordRules.edits(list.filter { !off.contains($0.key) }, bodies: bodies))
    }

    private func finish(_ edits: [(id: String, body: String)]) async {
        // 本文の直しを順に当てる（並列にしない）。失敗したらそこで止めて、かたちは作らない
        for e in edits {
            do {
                _ = try await API.shared.updateKakera(id: e.id, body: e.body, writtenAt: nil)
            } catch {
                await Toast.shared.guarded { try await store.loadNagare() }
                Toast.shared.say("リンクにできなかったので、かたちは作っていません: \(error.localizedDescription)")
                rows = nil
                return
            }
        }
        if !edits.isEmpty { await Toast.shared.guarded { try await store.loadNagare() } }
        let ids = chosen.map(\.id)
        do {
            let created = try await API.shared.createKatachi(
                id: ULID.make(), date: date.isEmpty ? OrderRules.composeDate(picked, writtenAt: writtenAt) : date,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                kakeraIds: ids, showTimeIds: ids.filter { showTime.contains($0) })
            store.details[created.katachi.id] = created
            try? await store.loadNagare()
            try? await store.loadKatachiList()
            Toast.shared.say("かたちにしました")
            picked = []
            showTime = []
            rows = nil
            nav.push(.read(created.katachi.id))
        } catch {
            Toast.shared.say(error.localizedDescription)
            rows = nil
        }
    }
}

// MARK: - 日記にする（Web の AssembleScreen.tsx・OrderList.tsx）

struct AssembleScreen: View {
    let id: String
    @Environment(AppNav.self) private var nav
    @State private var store = KakeraStore.shared
    @State private var picks = PickTexts.shared
    @State private var order: [String]?
    @State private var title = ""
    @State private var description = ""
    @State private var saving = false
    @State private var reordering = false

    private var detail: KatachiDetail? { store.details[id] }

    var body: some View {
        Screen {
            BackRow("かたちに戻る") { nav.pop() }
            if let d = detail, let order {
                content(d, order)
            } else {
                Text("読み込んでいます").emptyNote()
            }
        }
        .task {
            await Toast.shared.guarded {
                let d: KatachiDetail
                if let have = store.details[id] { d = have } else { d = try await store.loadDetail(id) }
                if order == nil {
                    order = OrderRules.initialOrder(kakera: d.kakera.map { ($0.id, $0.writtenAt) }, publishedIds: d.publishedIds)
                    title = d.katachi.title
                    description = d.katachi.description ?? ""
                }
                await picks.ensure(d.kakera.map(\.body), cards: d.cards)
            }
        }
        .sheet(isPresented: $reordering) {
            if let d = detail, let order {
                ReorderSheet(items: order.compactMap { oid in d.kakera.first { $0.id == oid } }, cards: d.cards) { self.order = $0 }
            }
        }
    }

    @ViewBuilder
    private func content(_ d: KatachiDetail, _ order: [String]) -> some View {
        let byId = Dictionary(d.kakera.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let chosen = order.compactMap { byId[$0] }
        let flat = Description.flatten(description)
        let len = Description.length(flat)
        PageTitle(title: d.nikki != nil ? "日記に書き足す" : "日記にする", sub: "\(DayText.heading(d.katachi.date)) のかたちから組みます")
        SectionHead(title: "日記に出すかけらを選ぶ")
        ForEach(d.kakera) { k in
            PickRow(checked: order.contains(k.id), thumb: k.body, action: { toggle(k.id, d) }) {
                Excerpt(text: picks.text(k.body))
                if d.publishedIds.contains(k.id) {
                    Text("日記に出した").font(Theme.gothic(10.5)).foregroundStyle(Theme.muted)
                }
            }
            .ruledRow(first: k.id == d.kakera.first?.id, last: k.id == d.kakera.last?.id)
        }
        SectionHead(title: "日記はこう並びます（\(order.count)枚）") {
            if order.count > 1 {
                Button("並べ替える") { reordering = true }.buttonStyle(LinkButtonStyle()).accessibilityIdentifier("reorder")
            }
        }
        if chosen.isEmpty {
            Text("まだ選ばれていません").emptyNote()
        }
        ForEach(Array(chosen.enumerated()), id: \.element.id) { i, k in
            HStack(alignment: .top, spacing: 10) {
                Text("\(i + 1)").font(Theme.mono(12)).foregroundStyle(Theme.muted).frame(width: 18, alignment: .trailing).padding(.top, 3)
                // 公開後の見え方のプレビューなので、カードも埋め込みも出す（縦長の写真も切らない）
                RichTextView(k.body, cards: d.cards, clipTall: false)
            }
            .padding(.vertical, 12)
            .ruledRow(first: i == 0, last: i == chosen.count - 1)
        }
        SectionHead(title: "書き出す内容")
        FieldBox(label: "タイトル") {
            TextField(d.katachi.title.isEmpty ? d.katachi.date : d.katachi.title, text: $title).accessibilityIdentifier("pubTitle")
        }
        FieldBox(label: "説明（任意）") {
            TextField("短い一文", text: $description).submitLabel(.done).accessibilityIdentifier("pubDesc")
        }
        Text("\(len) / \(Description.max)").font(Theme.mono(11.5))
            .foregroundStyle(len > Description.max ? Theme.accent : Theme.muted).padding(.top, 4)
        FieldBox(label: "公開日（かたちの日付）") {
            Text(d.katachi.date).font(Theme.mono(14)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
        }
        Button(saving ? "説明を保存しています" : "変換へ進む") { Task { await toConvert(d, chosen.map(\.id)) } }
            .buttonStyle(CTAButtonStyle(fullWidth: true))
            .disabled(order.isEmpty || saving)
            .padding(.top, 22)
            .accessibilityIdentifier("toConvert")
        Text("次の画面で、名前を公開用に置き換えます（タイトルと説明にも）。かけらは実名のまま残ります。")
            .font(Theme.gothic(11.5)).foregroundStyle(Theme.muted).padding(.top, 8).fixedSize(horizontal: false, vertical: true)
        if d.nikki != nil {
            Text("既にある日記を、この内容で丸ごと上書きします（差分の追記ではありません）。X には再投稿されません。")
                .font(Theme.gothic(11.5)).foregroundStyle(Theme.muted).padding(.top, 4).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func toggle(_ kid: String, _ d: KatachiDetail) {
        guard var o = order else { return }
        if o.contains(kid) {
            o.removeAll { $0 == kid }
        } else {
            let pos = OrderRules.insertPosition(o, id: kid, writtenAt: Dictionary(d.kakera.map { ($0.id, $0.writtenAt) }, uniquingKeysWith: { a, _ in a }))
            o.insert(kid, at: pos)
        }
        order = o
    }

    private func toConvert(_ d: KatachiDetail, _ ids: [String]) async {
        let next = Description.flatten(description)
        if Description.length(next) > Description.max {
            Toast.shared.say("説明は\(Description.max)文字までにしてください")
            return
        }
        if next != (d.katachi.description ?? "") {
            saving = true
            defer { saving = false }
            do {
                store.details[id] = try await API.shared.updateKatachi(id, ["description": next])
            } catch {
                Toast.shared.say("説明を保存できませんでした: \(error.localizedDescription)")
                return
            }
        }
        description = next
        nav.push(.convert(katachiId: id, order: ids, title: title.trimmingCharacters(in: .whitespacesAndNewlines)))
    }
}

/// 日記の並びを並べ替える（Web はドラッグ・矢印キー。iOS は List の並べ替えの取っ手）
struct ReorderSheet: View {
    let items: [KatachiKakera]
    let cards: LinkCards
    let onDone: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var list: [KatachiKakera] = []
    @State private var picks = PickTexts.shared

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(list.enumerated()), id: \.element.id) { i, k in
                    HStack(alignment: .top, spacing: 10) {
                        Text("\(i + 1)").font(Theme.mono(12)).foregroundStyle(Theme.muted).frame(width: 18, alignment: .trailing)
                        Excerpt(text: picks.text(k.body))
                        Spacer(minLength: 0)
                        RowThumb(k.body)
                    }
                    .listRowBackground(Theme.paper)
                }
                .onMove { list.move(fromOffsets: $0, toOffset: $1) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.paper)
            .environment(\.editMode, .constant(.active))
            .navigationTitle("並べ替える")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("やめる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("決める") { onDone(list.map(\.id)); dismiss() }.accessibilityIdentifier("reorderDone")
                }
            }
        }
        .onAppear { list = items }
    }
}
