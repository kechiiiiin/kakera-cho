import Photos
import PhotosUI
import SwiftUI

/// 日ごとの画面（1日1ページの手帳・かけら帳1日のページ設計）: 日付を左右で移る（既定は今日）。並びは
/// 日付 → きょうの一覧（かけら＋場所を時刻順・左に縦線）→ 入力欄 → 思い出す材料（写真・行った場所・港の材料）→ 書く。
/// 見た目は Web 版の書く側（.topbar・.page-date・.frag-list）。API は Web と同じ（/api/kakera・/api/day/:date・/api/place）
struct DayView: View {
    @State private var day = JST.todayKey
    @State private var kakera: [Kakera] = []
    @State private var cards: LinkCards = [:]
    @State private var kakeraError: String?
    @State private var loadedKakera = false
    @State private var basho: [Basho] = []
    /// その日の移動の軌跡（GET /api/track・時刻順）。読めなければ空（地図は今のまま）
    @State private var kiseki: [TrackPoint] = []
    /// 場所が読めなかったとき（かけらは読めていることがある）
    @State private var dayError: String?
    /// 場所を読み終えた日（読み終える前は入力欄で足させない）
    @State private var loadedDay: String?
    @State private var entryKind: EntryKind = .kakera
    @State private var entryAt = Date()
    @State private var entryText = ""
    @State private var entryDay: String?
    @State private var adding = false
    /// 入力欄に書いている間は「書く」の帯を出さない（キーボードの上に乗って欄を隠すので）
    @FocusState private var entryFocused: Bool
    /// 一覧から外した写真（D1 の timeline_hidden・kind=photo）。読めなければ空（全部出す）
    @State private var hiddenPhotos: Set<String> = []
    /// 別の日に撮って足した写真（端末の UserDefaults の印から引いたもの）
    @State private var addedAssets: [PHAsset] = []
    @State private var pickedPhotos: [PhotosPickerItem] = []
    /// 全画面で見ている写真（同じ日の写真を左右で送る）
    @State private var viewer: ViewerStart?
    /// × で消すかけら（念押しのあと消す）
    @State private var pendingDelete: Kakera?
    @State private var photos = PhotoMaterials()
    @State private var calendar = CalendarMaterials()
    /// 位置の無い予定の、場所の文字から引いた座標（メモリの控えから）
    @State private var yoteiGeo: [String: GeoPoint] = [:]
    /// 一覧から外した予定の回（D1 の timeline_hidden・kind=event）
    @State private var hiddenEvents: Set<String> = []
    @State private var places = PlaceMaterials()
    @State private var minato = MinatoMaterials()
    @State private var used = UsedMarks.shared
    @State private var draft: Draft?
    @State private var busy: String?
    @State private var alert: String?
    @State private var showSettings = false
    @State private var showMonth = false
    @State private var showSearch = false
    /// かたち・日記・ことば・かたちにする（ネイティブの画面・AppScreens.swift）を全画面で開いているとき
    @State private var web: AppStart?
    @State private var configVersion = 0
    @Environment(\.scenePhase) private var scenePhase

    private var isToday: Bool { day >= JST.todayKey }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    dateHeader
                    timelineSection
                    if API.shared.isConfigured(.kakera) {
                        EntryBox(kind: $entryKind, at: $entryAt, text: $entryText, range: DayPage.entryRange(day: day),
                                 adding: adding, enabled: loadedKakera && loadedDay == day, focused: $entryFocused,
                                 pickedPhotos: $pickedPhotos) { addEntry() }
                        ChizuSection(pins: pins, track: kiseki, steps: minato.daySummary)
                    }
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
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) { if !entryFocused { writeBar } }
            .overlay {
                if let busy {
                    HStack(spacing: 10) { ProgressView(); Text(busy).font(Theme.gothic(13)).foregroundStyle(Theme.ink) }
                        .padding(.horizontal, 18).padding(.vertical, 14)
                        .background(Theme.paper, in: RoundedRectangle(cornerRadius: Theme.radius))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                }
            }
            .task(id: "\(day)#\(configVersion)") { await reload() }
            // 位置の無い予定は場所の文字から座標を引く（控えにあるものは引き直さない）
            .task(id: "\(day)#\(calendar.events.count)#\(loadedDay ?? "")") { await geocodeYotei() }
            .onReceive(NotificationCenter.default.publisher(for: .kakeraPlacesChanged)) { _ in
                Task { await reloadBasho() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .kakeraTrackChanged)) { _ in
                Task { await reloadKiseki() }
            }
            .onChange(of: day) { _, _ in loadedDay = nil; kiseki = [] }
            .onChange(of: scenePhase) { _, p in
                if p == .active {
                    Task { await VisitRecorder.shared.flush() } // 溜まっている訪問と軌跡の点を送る
                    calendar.load(day)
                    photos.load(day)
                    places.load(day: day, assets: photos.assets)
                }
            }
            .onChange(of: photos.status) { _, _ in places.load(day: day, assets: photos.assets); addedAssets = Self.fetchAdded(day) }
            .onChange(of: pickedPhotos) { _, items in
                guard !items.isEmpty else { return }
                pickedPhotos = []
                addPicked(items.compactMap(\.itemIdentifier))
            }
            .fullScreenCover(item: $viewer) { v in PhotoViewer(photos: v.photos, index: v.index) }
            .sheet(item: $draft) { d in
                EditorView(draft: d, cards: cards) { Task { await reload() } }
            }
            .sheet(isPresented: $showSettings, onDismiss: { configVersion += 1 }) { SettingsView() }
            .sheet(isPresented: $showMonth) { TsukiSheet(current: day) { day = $0 } }
            .sheet(isPresented: $showSearch) { DaySearchSheet { day = $0 } }
            // 閉じたら、かたちの札が付いた・外れたかけらを読み直す
            .fullScreenCover(item: $web, onDismiss: { Task { await reload() } }) { start in
                AppScreens(start: start)
            }
            .toastOverlay()
            #if DEBUG
            .onAppear {
                // 検査: 起動引数 -kakeraOpen katachi などで、その画面を開いた状態で始める
                let args = ProcessInfo.processInfo.arguments
                // 検査: -kakeraResetPhotoAdds で「別の日から足した写真」の印を空にして始める（UI テストを毎回同じ所から）
                if args.contains("-kakeraResetPhotoAdds") { PhotoAdds.removeAll() }
                seedEventsIfAsked()
                if let i = args.firstIndex(of: "-kakeraOpen"), args.index(after: i) < args.endIndex {
                    web = AppStart(rawValue: args[args.index(after: i)])
                }
            }
            #endif
            .confirmationDialog("このかけらを消しますか（元に戻せません）",
                                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                                titleVisibility: .visible, presenting: pendingDelete) { k in
                Button("消す", role: .destructive) { removeKakera(k) }
            }
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
                // かたち・日記・ことばへ。Web のタブ（nav.tabs: 灰 12.5pt・500）と同じ字で
                ForEach([(AppStart.katachi, "かたち"), (.nikki, "日記"), (.words, "ことば")], id: \.0) { start, label in
                    Button { web = start } label: {
                        Text(label).font(Theme.gothic(12.5, weight: .medium)).tracking(12.5 * 0.02)
                            .padding(.horizontal, 5).frame(minHeight: 36)
                    }
                    .buttonStyle(LinkButtonStyle(color: Theme.muted))
                    .disabled(!API.shared.isConfigured(.kakera))
                    .accessibilityIdentifier("open-\(start.rawValue)")
                }
                Button { showSearch = true } label: {
                    Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .regular))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(LinkButtonStyle(color: Theme.muted))
                .disabled(!API.shared.isConfigured(.kakera))
                .accessibilityLabel("さがす")
                .accessibilityIdentifier("openSearch")
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape").font(.system(size: 15, weight: .regular))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(LinkButtonStyle(color: Theme.muted))
                .accessibilityLabel("設定")
                .accessibilityIdentifier("openSettings")
            }
            .padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 6)
            Rule()
        }
        .background(Theme.paper.ignoresSafeArea(edges: .top))
    }

    // MARK: 日付（.page-date と .page-sub）

    /// 等幅の日付と、その下にその日の歩数（港の health。無ければ出さない）。天気は出さない（2026-11-28）
    private var dateHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 6) {
                // 押すと月カレンダー
                Button { showMonth = true } label: {
                    Text(JST.title(day))
                        .font(Theme.mono(19, weight: .medium))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
                .buttonStyle(.plain)
                .disabled(!API.shared.isConfigured(.kakera))
                .accessibilityHint("月のカレンダーを開く")
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

    // MARK: きょうの一覧（かけら＋場所を時刻順）

    /// 地図のピン（一覧の上から番号）と、行 id → 番号
    private var pins: [ChizuPin] { Chizu.pins(timeline, geocoded: yoteiGeo) }

    private func geocodeYotei() async {
        let names = calendar.events.filter { $0.location == nil }.compactMap(\.locationName)
        guard !names.isEmpty else { return }
        yoteiGeo = YoteiGeocodeCache.known(names)
        let found = await YoteiGeocodeCache.lookup(names)
        yoteiGeo = found
    }

    /// 軌跡の点を送り終えたら、軌跡だけ読み直す
    private func reloadKiseki() async {
        let target = day
        if let list = try? await API.shared.track(on: target), target == day { kiseki = list }
    }

    /// 自動で残した場所を送り終えたら、場所だけ読み直す
    private func reloadBasho() async {
        let target = day
        if let list = try? await API.shared.basho(on: target), target == day { basho = list }
    }

    private var timeline: [TimelineItem] {
        DayPage.merge(kakera: kakera, basho: basho, photos: timelinePhotos, yotei: timelineYotei)
    }

    /// 一覧の予定（外した回を除く。外した印を読み終えるまで出さない）
    private var timelineYotei: [TimelineYotei] {
        guard calendar.day == day, loadedDay == day else { return [] }
        return DayPage.yotei(calendar.events, on: day, hidden: hiddenEvents)
    }

    /// 一覧の写真: その日に撮ったもの（外したものを除く）＋別の日から足したもの（この日の同じ時刻に置く）
    private var timelinePhotos: [TimelinePhoto] {
        guard photos.day == day, loadedDay == day else { return [] } // 外した印を読み終えるまで出さない（外した写真が一瞬出ない）
        let refs = DayPage.photoRefs(dayRefs: photos.assets.map(\.localIdentifier), hidden: hiddenPhotos,
                                     added: addedAssets.map(\.localIdentifier))
        let own = Set(refs.own), extra = Set(refs.added)
        return photos.assets.filter { own.contains($0.localIdentifier) }.map {
            TimelinePhoto(asset: $0, shownAt: $0.creationDate ?? .distantPast, added: false)
        } + addedAssets.filter { extra.contains($0.localIdentifier) }.map {
            TimelinePhoto(asset: $0, shownAt: DayPage.shownAt(taken: $0.creationDate ?? .distantPast, on: day), added: true)
        }
    }

    /// 足した印（UserDefaults）から写真を引く。消えた写真・見えない写真（限定アクセスの外）は黙って飛ばす
    private static func fetchAdded(_ day: String) -> [PHAsset] {
        let refs = PhotoAdds.refs(on: day)
        let st = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard !refs.isEmpty, st == .authorized || st == .limited else { return [] }
        let r = PHAsset.fetchAssets(withLocalIdentifiers: refs, options: nil)
        var list: [PHAsset] = []
        r.enumerateObjects { a, _, _ in list.append(a) }
        return list
    }

    @ViewBuilder
    private var timelineSection: some View {
        let items = timeline
        let numbers = Dictionary(uniqueKeysWithValues: pins.map { ($0.itemID, $0.number) })
        MajorHead(title: isToday ? "きょう" : "この日", count: items.count, top: 28) {
            // Web の「かたちにする」（.link-btn・黒の文字だけ）。かけらたちから選んで並べる（ComposeScreen）
            Button("かたちにする") { web = .compose }
                .buttonStyle(LinkButtonStyle())
                .disabled(!API.shared.isConfigured(.kakera))
                .accessibilityIdentifier("open-compose")
        }
            .padding(.bottom, items.isEmpty ? 10 : 0)
        if !API.shared.isConfigured(.kakera) {
            VStack(alignment: .leading, spacing: 8) {
                Text("かけら帳につなぐサービストークンが入っていません。").font(Theme.gothic(14)).foregroundStyle(Theme.ink)
                Button("設定を開く") { showSettings = true }.buttonStyle(LinkButtonStyle(color: Theme.accent))
            }
        } else if let kakeraError {
            Text(kakeraError).font(Theme.gothic(13)).foregroundStyle(Theme.accent)
        } else if loadedKakera && items.isEmpty {
            Text("この日の記録はまだありません").font(Theme.gothic(14)).foregroundStyle(Theme.muted)
                .padding(.vertical, 6)
        }
        if let dayError {
            Text(dayError).font(Theme.gothic(12)).foregroundStyle(Theme.accent).padding(.vertical, 4)
        }
        if API.shared.isConfigured(.kakera) {
            CalendarAccessNote(status: calendar.status) { Task { await calendar.requestAccess(); seedEventsIfAsked() } }
            PhotoAccessNote(status: photos.status) { Task { await photos.requestAccess() } }
        }
        // かけらの行を押すと直す画面。⚠️ Button にすると中のリンク・リンクカードが押せないので、行は onTapGesture で開く
        // 行は LazyVStack の直の子にする（写真の多い日も、見えている行の絵だけを読む）。縦線は行ごとに引いてつなげる
        ForEach(items) { item in
            row(item, in: items, number: numbers[item.id])
                .ruledRow(first: item.id == items.first?.id)
                .modifier(TimelineRail())
        }
    }

    @ViewBuilder
    private func row(_ item: TimelineItem, in items: [TimelineItem], number: Int?) -> some View {
        switch item {
        case .kakera(let k):
            TimelineRow(item: item, cards: cards, number: number) { pendingDelete = k }
                .onTapGesture { draft = .edit(k) }
                .accessibilityAddTraits(.isButton)
        case .basho(let b):
            TimelineRow(item: item, cards: cards, number: number) { removeBasho(b) }
        case .yotei(let y):
            TimelineRow(item: item, cards: cards, number: number) { hideYotei(y) }
        case .photo(let p):
            TimelineRow(item: item, cards: cards, number: number) { hidePhoto(p) }
                .onTapGesture {
                    let list = items.compactMap { if case .photo(let q) = $0 { return q } else { return nil } }
                    viewer = ViewerStart(photos: list, index: list.firstIndex(of: p) ?? 0)
                }
                .accessibilityAddTraits(.isButton)
        }
    }

    // MARK: 写真（外す・戻す・別の日から足す）

    /// 写真の ×: その日に撮ったものは外した印（D1）、足したものは足した印（端末）を取る。ライブラリからは消さない
    private func hidePhoto(_ p: TimelinePhoto) {
        let target = day
        if p.added {
            PhotoAdds.remove(p.ref, on: target)
            addedAssets.removeAll { $0.localIdentifier == p.ref }
            return
        }
        hiddenPhotos.insert(p.ref)
        Task {
            do {
                try await API.shared.hide(kind: "photo", ref: p.ref, on: target)
            } catch {
                if target == day { hiddenPhotos.remove(p.ref) }
                alert = "写真を外せませんでした: \(error.localizedDescription)"
            }
        }
    }

    /// 予定の ×: その回だけを一覧から外す（繰り返しの他の回は残る）。カレンダー本体は消さない
    private func hideYotei(_ y: TimelineYotei) {
        let target = day
        hiddenEvents.insert(y.ref)
        Task {
            do {
                try await API.shared.hide(kind: "event", ref: y.ref, on: target)
            } catch {
                if target == day { hiddenEvents.remove(y.ref) }
                alert = "予定を外せませんでした: \(error.localizedDescription)"
            }
        }
    }

    /// 検査だけ（DEBUG）: 起動引数 -kakeraSeedEvents YYYY-MM-DD で検証用のカレンダーに予定を入れる
    private func seedEventsIfAsked() {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-kakeraSeedEvents"), args.index(after: i) < args.endIndex {
            calendar.seedForTesting(day: args[args.index(after: i)])
            calendar.load(day)
        }
        #endif
    }

    /// 「写真を追加」で選んだ写真: 外したものなら印を取って戻す。別の日に撮ったものはこの日の一覧に足す
    private func addPicked(_ refs: [String]) {
        let target = day
        Task {
            if !photos.canRead { await photos.requestAccess() }
            guard photos.canRead else {
                alert = "写真へのアクセスが無いので、写真を一覧に足せません"
                return
            }
            let found = PHAsset.fetchAssets(withLocalIdentifiers: refs, options: nil)
            var assets: [PHAsset] = []
            found.enumerateObjects { a, _, _ in assets.append(a) }
            var missing = refs.count - assets.count
            for a in assets {
                let ref = a.localIdentifier
                if hiddenPhotos.contains(ref) {
                    do {
                        try await API.shared.unhide(kind: "photo", ref: ref)
                        if target == day { hiddenPhotos.remove(ref) }
                    } catch {
                        alert = "写真を戻せませんでした: \(error.localizedDescription)"
                    }
                } else if let d = a.creationDate, JST.dayKey(d) != target {
                    PhotoAdds.add(ref, on: target)
                } else if a.creationDate == nil {
                    missing += 1
                }
                // その日に撮って外していない写真は、もう一覧にある
            }
            guard target == day else { return }
            addedAssets = Self.fetchAdded(target)
            if missing > 0 { Toast.shared.say("見えない写真がありました（限定アクセスの外・撮影日時なし）") }
        }
    }

    // MARK: 追加・削除

    /// 入力欄の追加。かけらは本文そのまま POST /api/kakera、場所は端末で座標を引いてから POST /api/place
    private func addEntry() {
        let target = day
        let text = entryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !adding else { return }
        let range = DayPage.entryRange(day: target)
        let at = min(max(entryAt, range.lowerBound), range.upperBound)
        let kind = entryKind
        adding = true
        Task {
            defer { adding = false }
            do {
                switch kind {
                case .kakera:
                    let k = try await API.shared.createKakera(id: ULID.make(), body: text, writtenAt: JST.writtenAt(at))
                    if target == day { kakera.append(k) }
                case .basho:
                    let name = text.replacingOccurrences(of: "\n", with: " ")
                    let coordinate = await BashoGeocoder.coordinate(for: name)
                    let b = try await API.shared.createBasho(id: ULID.make(), at: JST.writtenAt(at), name: name, coordinate: coordinate)
                    if target == day { basho.append(b) }
                    if coordinate == nil { Toast.shared.say("位置は見つかりませんでした（名前だけ残しました）") }
                }
                guard target == day else { return }
                entryText = ""
                entryAt = DayPage.defaultEntryDate(day: day, items: timeline)
            } catch {
                alert = "追加できませんでした: \(error.localizedDescription)"
            }
        }
    }

    /// かけらの ×（念押しのあと）。直す画面の「消す」と同じ DELETE /api/kakera/:id
    private func removeKakera(_ k: Kakera) {
        Task {
            do {
                try await API.shared.deleteKakera(id: k.id)
                kakera.removeAll { $0.id == k.id }
            } catch {
                alert = "消せませんでした: \(error.localizedDescription)"
            }
        }
    }

    /// 場所の ×（念押しなしで消す）
    private func removeBasho(_ b: Basho) {
        Task {
            do {
                try await API.shared.deleteBasho(id: b.id)
                basho.removeAll { $0.id == b.id }
            } catch {
                alert = "消せませんでした: \(error.localizedDescription)"
            }
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
        async let b: Result<[Basho], Error> = capture { try await API.shared.basho(on: target) }
        calendar.load(target)
        async let h: Result<[String: Set<String>], Error> = capture { try await API.shared.hidden(on: target) }
        async let m: Void = minato.load(target)
        async let t: [TrackPoint]? = try? API.shared.track(on: target)
        let (kr, br, hr, _, tr) = await (k, b, h, m, t)
        guard target == day else { return } // 読み込み中に日付が変わった
        kiseki = tr ?? []
        let hiddenAll = (try? hr.get()) ?? [:]
        hiddenPhotos = hiddenAll["photo"] ?? []
        hiddenEvents = hiddenAll["event"] ?? []
        addedAssets = Self.fetchAdded(target)
        switch kr {
        case .success(let r): kakera = r.kakera; cards = r.cards; kakeraError = nil
        case .failure(let e): kakera = []; cards = [:]; kakeraError = API.shared.isConfigured(.kakera) ? e.localizedDescription : nil
        }
        loadedKakera = true
        let configured = API.shared.isConfigured(.kakera)
        switch br {
        case .success(let places):
            basho = places; dayError = nil
        case .failure(let e):
            basho = []
            dayError = configured && kakeraError == nil ? "場所を読めませんでした（\(e.localizedDescription)）" : nil
        }
        loadedDay = target
        // 入力欄の時刻は日を移ったときだけ初期値に戻す（引っぱって読み直しても、選んだ時刻は動かさない）
        if entryDay != target {
            entryDay = target
            entryAt = DayPage.defaultEntryDate(day: target, items: timeline)
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

/// 全画面の写真の開き方（どの写真の並びの何枚目から）
struct ViewerStart: Identifiable {
    let id = UUID()
    let photos: [TimelinePhoto]
    let index: Int
}
