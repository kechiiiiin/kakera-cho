import Photos
import SwiftUI

/// 日ごとの画面: 日付を左右で移る（既定は今日）。その日のかけら（時刻順）と、下に「思い出す材料」（写真・読んだ記事）
struct DayView: View {
    @State private var day = JST.todayKey
    @State private var kakera: [Kakera] = []
    @State private var kakeraError: String?
    @State private var loadedKakera = false
    @State private var reads: [ReadItem] = []
    @State private var readsError: String?
    @State private var photos = PhotoMaterials()
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
            List {
                kakeraSection
                PhotoMaterialsSection(photos: photos, used: used, busy: busy != nil) { makeFromPhotos($0) }
                readsSection
            }
            .listStyle(.insetGrouped)
            .refreshable { await reload() }
            .simultaneousGesture(DragGesture(minimumDistance: 40).onEnded { v in
                guard abs(v.translation.width) > 90, abs(v.translation.width) > abs(v.translation.height) * 2 else { return }
                move(v.translation.width > 0 ? -1 : 1)
            })
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { dateBar }
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
                    VStack(spacing: 10) { ProgressView(); Text(busy).font(.subheadline) }
                        .padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
            .task(id: "\(day)#\(configVersion)") { await reload() }
            .onChange(of: scenePhase) { _, p in if p == .active { photos.load(day) } }
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

    private var dateBar: some View {
        HStack(spacing: 14) {
            Button { move(-1) } label: { Image(systemName: "chevron.left") }
                .accessibilityLabel("前の日").accessibilityIdentifier("prevDay")
            Text(JST.title(day)).font(.headline).monospacedDigit().accessibilityIdentifier("dayTitle")
            Button { move(1) } label: { Image(systemName: "chevron.right") }
                .disabled(isToday)
                .accessibilityLabel("次の日").accessibilityIdentifier("nextDay")
        }
    }

    private func move(_ days: Int) {
        let next = JST.shift(day, days: days)
        if next > JST.todayKey { return }
        day = next
    }

    // MARK: かけら

    private var kakeraSection: some View {
        Section {
            if !API.shared.isConfigured(.kakera) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("かけら帳につなぐサービストークンが入っていません。").font(.subheadline)
                    Button("設定を開く") { showSettings = true }
                }
            } else if let kakeraError {
                Text(kakeraError).font(.subheadline).foregroundStyle(.red)
            } else if loadedKakera && kakera.isEmpty {
                Text("この日のかけらはまだありません").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(kakera) { k in
                Button { draft = .edit(k) } label: { KakeraRow(kakera: k) }
                    .buttonStyle(.plain)
            }
        } header: {
            Text("かけら")
        }
    }

    private var writeBar: some View {
        Button {
            draft = .new(at: newKakeraDate())
        } label: {
            Label("書く", systemImage: "square.and.pencil")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .padding(.horizontal, 20)
        .padding(.bottom, 6)
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

    // MARK: 読んだ記事

    private var readsSection: some View {
        Section {
            if !API.shared.isConfigured(.tayori) {
                Text("便りにつなぐ設定がありません").font(.subheadline).foregroundStyle(.secondary)
            } else if let readsError {
                Text(readsError).font(.subheadline).foregroundStyle(.red)
            } else if reads.isEmpty {
                Text("この日に読んだ記事はありません").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(reads) { item in
                Button { makeFromRead(item) } label: { ReadRow(item: item, used: used.items.contains(item.id)) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("read-\(item.id)")
            }
        } header: {
            Text("読んだ記事")
        }
    }

    // MARK: 読み込み

    private func reload() async {
        let target = day
        photos.load(target)
        async let k: Result<[Kakera], Error> = capture { try await API.shared.kakera(on: target) }
        async let r: Result<[ReadItem], Error> = capture { try await API.shared.readOn(target) }
        let (kr, rr) = await (k, r)
        guard target == day else { return } // 読み込み中に日付が変わった
        switch kr {
        case .success(let list): kakera = list; kakeraError = nil
        case .failure(let e): kakera = []; kakeraError = API.shared.isConfigured(.kakera) ? e.localizedDescription : nil
        }
        loadedKakera = true
        switch rr {
        case .success(let list): reads = list; readsError = nil
        case .failure(let e): reads = []; readsError = API.shared.isConfigured(.tayori) ? e.localizedDescription : nil
        }
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

    /// URL を一行に置いた書きかけを開く（便りのコメントがあれば添える）。時刻は既読時刻
    private func makeFromRead(_ item: ReadItem) {
        var body = item.url ?? item.title
        if let c = item.comment, !c.isEmpty { body += "\n\n" + c }
        body += "\n"
        draft = .new(body: body, at: item.readDate ?? Date(), tayoriItemID: item.id)
    }
}

struct KakeraRow: View {
    let kakera: Kakera

    var body: some View {
        let photos = KakeraBody.photoURLs(kakera.body)
        let text = KakeraBody.text(kakera.body)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(JST.time(kakera.writtenDate)).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                if kakera.katachiId != nil {
                    Text("かたち").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color(uiColor: .secondarySystemFill), in: Capsule())
                }
            }
            if !text.isEmpty {
                Text(text).font(.body).lineLimit(8).frame(maxWidth: .infinity, alignment: .leading)
            }
            if !photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) { ForEach(photos, id: \.self) { RemotePhoto(path: $0) } }
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

struct ReadRow: View {
    let item: ReadItem
    let used: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title).font(.subheadline.weight(.medium)).lineLimit(2)
            HStack(spacing: 6) {
                if let d = item.readDate { Text(JST.time(d)).monospacedDigit() }
                Text(item.feedTitle).lineLimit(1)
                if used {
                    Text("かけらにした").font(.caption2.bold()).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.accent.opacity(0.15), in: Capsule()).foregroundStyle(Theme.accent)
                }
            }
            .font(.caption).foregroundStyle(.secondary)
            if let c = item.comment, !c.isEmpty {
                Text(c).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
