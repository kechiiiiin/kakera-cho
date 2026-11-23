import Photos
import SwiftUI

/// 日ごとの画面: 日付を左右で移る（既定は今日）。その日のかけら（時刻順・紙片のカード）と、下に「思い出す材料」
/// （写真・行った場所・港の材料を付箋の塊で）
struct DayView: View {
    @State private var day = JST.todayKey
    @State private var kakera: [Kakera] = []
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
    @State private var configVersion = 0
    @Environment(\.scenePhase) private var scenePhase

    private var isToday: Bool { day >= JST.todayKey }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    dateHeader
                    kakeraSection
                    MaterialsHeader(minato: minato, canCollect: API.shared.isConfigured(.minato)) {
                        Task { await minato.collectNow() }
                    }
                    PhotosNote(photos: photos, used: used, busy: busy != nil) { makeFromPhotos($0) }
                    PlacesNote(places: places, used: used) { makeFromPlace($0) }
                    minatoSection
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Theme.paper.ignoresSafeArea())
            .refreshable { await reload() }
            .simultaneousGesture(DragGesture(minimumDistance: 40).onEnded { v in
                guard abs(v.translation.width) > 90, abs(v.translation.width) > abs(v.translation.height) * 2 else { return }
                move(v.translation.width > 0 ? -1 : 1)
            })
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.paper, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("設定")
                }
                if !isToday {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("今日") { day = JST.todayKey }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { writeBar }
            .overlay {
                if let busy {
                    VStack(spacing: 10) { ProgressView(); Text(busy).font(Theme.gothic(14)) }
                        .padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
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
                EditorView(draft: d) { Task { await reload() } }
            }
            .sheet(isPresented: $showSettings, onDismiss: { configVersion += 1 }) { SettingsView() }
            .alert("うまくいきませんでした", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(alert ?? "")
            }
        }
    }

    // MARK: 日付

    /// 明朝の日付と、その下にその日の天気・気温・歩数（港の weather・health。無ければ出さない）
    private var dateHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Button { move(-1) } label: { Image(systemName: "chevron.left").frame(width: 32, height: 36) }
                    .accessibilityLabel("前の日").accessibilityIdentifier("prevDay")
                Text(JST.title(day))
                    .font(Theme.mincho(26, bold: true, relativeTo: .title))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .accessibilityIdentifier("dayTitle")
                Button { move(1) } label: { Image(systemName: "chevron.right").frame(width: 32, height: 36) }
                    .disabled(isToday)
                    .accessibilityLabel("次の日").accessibilityIdentifier("nextDay")
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.accent)
            if let s = minato.daySummary {
                Text(s).font(Theme.gothic(13)).foregroundStyle(Theme.muted)
                    .lineLimit(1).minimumScaleFactor(0.8)
                    .padding(.leading, 36)
                    .accessibilityIdentifier("daySummary")
            }
            Rectangle().fill(Theme.accent.opacity(0.55)).frame(height: 0.75).padding(.top, 4)
        }
        .padding(.top, 4)
    }

    private func move(_ days: Int) {
        let next = JST.shift(day, days: days)
        if next > JST.todayKey { return }
        day = next
    }

    // MARK: かけら

    @ViewBuilder
    private var kakeraSection: some View {
        Text("かけら").font(Theme.mincho(17, bold: true, relativeTo: .headline)).foregroundStyle(Theme.ink)
            .padding(.top, 4)
        if !API.shared.isConfigured(.kakera) {
            VStack(alignment: .leading, spacing: 8) {
                Text("かけら帳につなぐサービストークンが入っていません。").font(Theme.gothic(14)).foregroundStyle(Theme.ink)
                Button("設定を開く") { showSettings = true }.font(Theme.gothic(14))
            }
            .paperCard()
        } else if let kakeraError {
            Text(kakeraError).font(Theme.gothic(13)).foregroundStyle(Theme.accent).paperCard()
        } else if loadedKakera && kakera.isEmpty {
            Text("この日のかけらはまだありません").font(Theme.gothic(14)).foregroundStyle(Theme.muted)
                .padding(.vertical, 6)
        }
        ForEach(kakera) { k in
            Button { draft = .edit(k) } label: { KakeraRow(kakera: k) }
                .buttonStyle(.plain)
        }
    }

    private var writeBar: some View {
        Button {
            draft = .new(at: newKakeraDate())
        } label: {
            Label("書く", systemImage: "square.and.pencil")
                .font(Theme.gothic(16, bold: true))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.accent)
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 6)
        // 下に流れる付箋と重ならないよう、紙色で薄く受ける
        .background(LinearGradient(colors: [Theme.paper.opacity(0), Theme.paper.opacity(0.95), Theme.paper],
                                   startPoint: .top, endPoint: .center).ignoresSafeArea())
        .disabled(!API.shared.isConfigured(.kakera))
        .accessibilityIdentifier("write")
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
            Text(e).font(Theme.gothic(13)).foregroundStyle(Theme.accent).paperCard()
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
        async let k: Result<[Kakera], Error> = capture { try await API.shared.kakera(on: target) }
        async let m: Void = minato.load(target)
        let (kr, _) = await (k, m)
        guard target == day else { return } // 読み込み中に日付が変わった
        switch kr {
        case .success(let list): kakera = list; kakeraError = nil
        case .failure(let e): kakera = []; kakeraError = API.shared.isConfigured(.kakera) ? e.localizedDescription : nil
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

/// かけら（紙片のカード。時刻は小さく朱色）
struct KakeraRow: View {
    let kakera: Kakera

    var body: some View {
        let photos = KakeraBody.photoURLs(kakera.body)
        let text = KakeraBody.text(kakera.body)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(JST.time(kakera.writtenDate))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.accent)
                if kakera.katachiId != nil {
                    Text("かたち").font(Theme.gothic(10)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 0.75))
                }
            }
            if !text.isEmpty {
                Text(text).font(Theme.gothic(15)).foregroundStyle(Theme.ink).lineSpacing(4)
                    .lineLimit(8).frame(maxWidth: .infinity, alignment: .leading)
                    .multilineTextAlignment(.leading)
            }
            if !photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) { ForEach(photos, id: \.self) { RemotePhoto(path: $0) } }
                }
            }
        }
        .paperCard()
        .contentShape(Rectangle())
    }
}
