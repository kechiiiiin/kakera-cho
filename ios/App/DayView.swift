import Photos
import SwiftUI

/// 日ごとの画面: 日付を左右で移る（既定は今日）。その日のかけら（時刻順・罫で区切った行）と、下に「思い出す材料」
/// （写真・行った場所・港の材料を、見出しと罫の行の塊で）。見た目は Web 版の書く側（.topbar・.page-date・.frag-list）
struct DayView: View {
    @State private var day = JST.todayKey
    @State private var kakera: [Kakera] = []
    @State private var cards: LinkCards = [:]
    @State private var kakeraError: String?
    @State private var loadedKakera = false
    @State private var photos = PhotoMaterials()
    @State private var places = PlaceMaterials()
    @State private var minato = MinatoMaterials()
    @State private var used = UsedMarks.shared
    @State private var draft: Draft?
    @State private var busy: String?
    @State private var alert: String?
    @State private var showSettings = false
    /// Web の画面（かたち・日記・ことば・かたちにする）を全画面で開いているとき
    @State private var web: WebStart?
    @State private var configVersion = 0
    @Environment(\.scenePhase) private var scenePhase

    private var isToday: Bool { day >= JST.todayKey }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    dateHeader
                    kakeraSection
                    MaterialsHeader(minato: minato, canCollect: API.shared.isConfigured(.minato)) {
                        Task { await minato.collectNow() }
                    }
                    PhotosNote(photos: photos, used: used, busy: busy != nil) { makeFromPhotos($0) }
                    PlacesNote(places: places, used: used) { makeFromPlace($0) }
                    minatoSection
                }
                .padding(.horizontal, 18)
                .padding(.top, 20)
                .padding(.bottom, 24)
            }
            .background(Theme.paper.ignoresSafeArea())
            .refreshable { await reload() }
            .simultaneousGesture(DragGesture(minimumDistance: 40).onEnded { v in
                guard abs(v.translation.width) > 90, abs(v.translation.width) > abs(v.translation.height) * 2 else { return }
                move(v.translation.width > 0 ? -1 : 1)
            })
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) { topbar }
            .safeAreaInset(edge: .bottom, spacing: 0) { writeBar }
            .overlay {
                if let busy {
                    HStack(spacing: 10) { ProgressView(); Text(busy).font(Theme.gothic(13)).foregroundStyle(Theme.ink) }
                        .padding(.horizontal, 18).padding(.vertical, 14)
                        .background(Theme.paper, in: RoundedRectangle(cornerRadius: Theme.radius))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                }
            }
            .task(id: "\(day)#\(configVersion)") { await reload() }
            .onChange(of: scenePhase) { _, p in
                if p == .active {
                    photos.load(day)
                    places.load(day: day, assets: photos.assets)
                }
            }
            .onChange(of: photos.status) { _, _ in places.load(day: day, assets: photos.assets) }
            .sheet(item: $draft) { d in
                EditorView(draft: d, cards: cards) { Task { await reload() } }
            }
            .sheet(isPresented: $showSettings, onDismiss: { configVersion += 1 }) { SettingsView() }
            // 閉じたら、かたちの札が付いた・外れたかけらを読み直す
            .fullScreenCover(item: $web, onDismiss: { Task { await reload() } }) { start in
                AppWebScreen(start: start)
            }
            #if DEBUG
            .onAppear {
                // 検査: 起動引数 -kakeraOpenWeb katachi などで、その画面の Web を開いた状態で始める
                let args = ProcessInfo.processInfo.arguments
                if let i = args.firstIndex(of: "-kakeraOpenWeb"), args.index(after: i) < args.endIndex {
                    web = WebStart(rawValue: args[args.index(after: i)])
                }
            }
            #endif
            .alert("うまくいきませんでした", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(alert ?? "")
            }
        }
    }

    // MARK: 上部（.topbar: 「かけら帳」と下罫）

    private var topbar: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 8) {
                Text("かけら帳").font(Theme.gothic(16, weight: .semibold)).tracking(16 * 0.02).foregroundStyle(Theme.ink)
                Spacer()
                // Web の画面へ（App.tsx の同梱）。Web のタブ（nav.tabs: 灰 12.5pt・500）と同じ字で
                ForEach([(WebStart.katachi, "かたち"), (.nikki, "日記"), (.words, "ことば")], id: \.0) { start, label in
                    Button { web = start } label: {
                        Text(label).font(Theme.gothic(12.5, weight: .medium)).tracking(12.5 * 0.02)
                            .padding(.horizontal, 5).frame(minHeight: 36)
                    }
                    .buttonStyle(LinkButtonStyle(color: Theme.muted))
                    .disabled(!API.shared.isConfigured(.kakera))
                    .accessibilityIdentifier("web-\(start.rawValue)")
                }
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape").font(.system(size: 15, weight: .regular))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(LinkButtonStyle(color: Theme.muted))
                .accessibilityLabel("設定")
            }
            .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 6)
            Rule()
        }
        .background(Theme.paper.ignoresSafeArea(edges: .top))
    }

    // MARK: 日付（.page-date と .page-sub）

    /// 等幅の日付と、その下にその日の天気・気温・歩数（港の weather・health。無ければ出さない）
    private var dateHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 6) {
                Text(JST.title(day))
                    .font(Theme.mono(19, weight: .medium))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .accessibilityIdentifier("dayTitle")
                Spacer(minLength: 4)
                if !isToday {
                    Button("今日") { day = JST.todayKey }
                        .buttonStyle(LinkButtonStyle(color: Theme.accent))
                        .padding(.trailing, 4)
                }
                Button { move(-1) } label: { Image(systemName: "chevron.left").font(.system(size: 13)) }
                    .buttonStyle(GhostButtonStyle(compact: true))
                    .accessibilityLabel("前の日").accessibilityIdentifier("prevDay")
                Button { move(1) } label: { Image(systemName: "chevron.right").font(.system(size: 13)) }
                    .buttonStyle(GhostButtonStyle(compact: true))
                    .disabled(isToday)
                    .accessibilityLabel("次の日").accessibilityIdentifier("nextDay")
            }
            if let s = minato.daySummary {
                Text(s).pageSub()
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .accessibilityIdentifier("daySummary")
            }
        }
    }

    private func move(_ days: Int) {
        let next = JST.shift(day, days: days)
        if next > JST.todayKey { return }
        day = next
    }

    // MARK: かけら

    @ViewBuilder
    private var kakeraSection: some View {
        MajorHead(title: "かけら", count: kakera.count, top: 32) {
            // Web の「かたちにする」（.link-btn・黒の文字だけ）。かけらたちから選んで並べる
            Button("かたちにする") { web = .compose }
                .buttonStyle(LinkButtonStyle())
                .disabled(!API.shared.isConfigured(.kakera))
                .accessibilityIdentifier("web-compose")
        }
            .padding(.bottom, kakera.isEmpty ? 10 : 0)
        if !API.shared.isConfigured(.kakera) {
            VStack(alignment: .leading, spacing: 8) {
                Text("かけら帳につなぐサービストークンが入っていません。").font(Theme.gothic(14)).foregroundStyle(Theme.ink)
                Button("設定を開く") { showSettings = true }.buttonStyle(LinkButtonStyle(color: Theme.accent))
            }
        } else if let kakeraError {
            Text(kakeraError).font(Theme.gothic(13)).foregroundStyle(Theme.accent)
        } else if loadedKakera && kakera.isEmpty {
            Text("この日のかけらはまだありません").font(Theme.gothic(14)).foregroundStyle(Theme.muted)
                .padding(.vertical, 6)
        }
        // 行を押すと直す画面。⚠️ Button にすると中のリンク・リンクカードが押せないので、行は onTapGesture で開く
        ForEach(kakera) { k in
            KakeraRow(kakera: k, cards: cards)
                .onTapGesture { draft = .edit(k) }
                .accessibilityAddTraits(.isButton)
                .ruledRow(first: k.id == kakera.first?.id, last: k.id == kakera.last?.id)
        }
    }

    /// 「書く」: Web で前へ進める一つの行動に使う .btn-cta（朱の枠と文字・塗らない）を、下の罫の上に幅いっぱいで
    private var writeBar: some View {
        VStack(spacing: 0) {
            Rule()
            Button {
                draft = .new(at: newKakeraDate())
            } label: {
                Text("書く").font(Theme.gothic(14, weight: .semibold))
            }
            .buttonStyle(CTAButtonStyle(fullWidth: true))
            .disabled(!API.shared.isConfigured(.kakera))
            .accessibilityIdentifier("write")
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 6)
        }
        .background(Theme.paper.ignoresSafeArea(edges: .bottom))
    }

    /// 今日なら今。過去の日なら、その日の最後のかけらの1分後（無ければ 12:00）。後で直せる
    private func newKakeraDate() -> Date {
        if isToday { return Date() }
        guard let r = JST.dayRange(day) else { return Date() }
        if let last = kakera.last?.writtenDate, last.addingTimeInterval(60) < r.end { return last.addingTimeInterval(60) }
        return r.start.addingTimeInterval(12 * 3600)
    }

    // MARK: 港の材料

    @ViewBuilder
    private var minatoSection: some View {
        if !API.shared.isConfigured(.minato) {
            Text("港につなぐ設定がありません").font(Theme.gothic(13)).foregroundStyle(Theme.muted)
        } else if let e = minato.error {
            Text(e).font(Theme.gothic(13)).foregroundStyle(Theme.accent).padding(.vertical, 4)
        } else if minato.loaded && minato.sortedGroups.isEmpty {
            Text("港にこの日の材料はまだありません").font(Theme.gothic(13)).foregroundStyle(Theme.muted)
                .padding(.vertical, 4)
        }
        ForEach(minato.sortedGroups, id: \.source) { g in
            MaterialGroupNote(group: g, used: used) { makeFromMaterial($0) }
        }
    }

    // MARK: 読み込み

    private func reload() async {
        let target = day
        photos.load(target)
        places.load(day: target, assets: photos.assets)
        async let k: Result<(kakera: [Kakera], cards: LinkCards), Error> = capture { try await API.shared.kakera(on: target) }
        async let m: Void = minato.load(target)
        let (kr, _) = await (k, m)
        guard target == day else { return } // 読み込み中に日付が変わった
        switch kr {
        case .success(let r): kakera = r.kakera; cards = r.cards; kakeraError = nil
        case .failure(let e): kakera = []; cards = [:]; kakeraError = API.shared.isConfigured(.kakera) ? e.localizedDescription : nil
        }
        loadedKakera = true
    }

    private func capture<T>(_ f: () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await f()) } catch { return .failure(error) }
    }

    // MARK: 材料 → かけら

    /// 写真を上げ、写真の記法を本文に入れた書きかけを開く。時刻は一番早い一枚の撮影時刻
    private func makeFromPhotos(_ assets: [PHAsset]) {
        let sorted = assets.sorted { ($0.creationDate ?? .distantFuture) < ($1.creationDate ?? .distantFuture) }
        guard !sorted.isEmpty else { return }
        let at = sorted.first?.creationDate ?? Date()
        var d = Draft.new(at: at, photoAssetIDs: sorted.map(\.localIdentifier))
        Task {
            var urls: [String] = []
            for (i, a) in sorted.enumerated() {
                busy = "写真を上げています（\(i + 1)/\(sorted.count)）"
                do {
                    let jpeg = try await PhotoMaterials.jpeg(for: a)
                    urls.append(try await API.shared.uploadPhoto(jpeg: jpeg, kakeraId: d.id, writtenAt: d.photoWrittenAt, n: i + 1))
                } catch {
                    busy = nil
                    alert = "写真を上げられませんでした: \(error.localizedDescription)"
                    return
                }
            }
            busy = nil
            d.body = KakeraBody.appendingPhotos("", urls)
            draft = d
        }
    }

    /// 港の材料から書きかけを開く。時刻は材料の時刻、無ければ書いた時刻（いま）
    private func makeFromMaterial(_ m: Material) {
        let at = m.occurredDate ?? Date()
        if let item = m.tayoriItemID {
            draft = .new(body: MinatoMaterials.body(m), at: at, tayoriItemID: item)
        } else {
            draft = .new(body: MinatoMaterials.body(m), at: at, materialKey: m.markKey)
        }
    }

    /// 地名を本文にした書きかけ。時刻はその場所の最初の一枚
    private func makeFromPlace(_ p: Place) {
        draft = .new(body: p.name + "\n", at: p.firstAt, materialKey: p.markKey)
    }
}

/// かけらの一行（.frag-row: 本文が左で幅いっぱい・全文、時刻は灰 11pt の等幅で右。gap 10・上下 14）。
/// 本文は Web の RichText と同じ規則で描く（写真は幅いっぱい・行として独立した URL はリンクカード）。
/// Web の流れにはかたち入りのかけらは出ないが、iOS の日の画面は全部出すので、時刻の下に灰の等幅で小さく「かたち」と添える
struct KakeraRow: View {
    let kakera: Kakera
    let cards: LinkCards

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RichTextView(kakera.body, cards: cards)
            VStack(alignment: .trailing, spacing: 3) {
                Text(JST.time(kakera.writtenDate))
                    .font(Theme.mono(11))
                    .foregroundStyle(Theme.muted)
                if kakera.katachiId != nil {
                    Text("かたち").font(Theme.mono(9.5)).foregroundStyle(Theme.muted.opacity(0.8))
                }
            }
            .padding(.top, 4)
            .fixedSize()
        }
        .padding(.vertical, 14).padding(.horizontal, 2)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
