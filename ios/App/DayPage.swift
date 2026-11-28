import MapKit
import Photos
import PhotosUI
import SwiftUI

// 1日のページの部品（かけら帳1日のページ設計・段階1〜2）: 気分のハンコ・きょうの一覧（かけら＋場所＋写真を時刻順）・入力欄。
// Web の src/lib/kakera/day-input.ts（気分の5つ・場所の検査）・day-db.ts（Day / Place の形）・
// src/pages/api/day/[date].ts・src/pages/api/place/ と対になる。並べ方と時刻の初期値は DayPage に置いて XCTest で確かめる。

/// 気分のハンコ（Web の MOODS と同じ5つ・同じ並び）
enum Kibun: String, CaseIterable, Identifiable {
    case ureshii = "嬉"
    case tanoshii = "楽"
    case odayaka = "穏"
    case tsukare = "疲"
    case kanashii = "哀"

    var id: String { rawValue }
}

/// 行った場所（D1 の place・Web の Place と同じ形）。座標は端末でジオコーディングしたもの（取れなければ nil）
struct Basho: Codable, Identifiable, Hashable {
    let id: String
    /// ISO8601（+09:00 付き）
    var at: String
    var name: String
    var lat: Double?
    var lng: Double?
    /// manual（手入力）| visit（訪問の自動検出・段階5）
    var source: String
    var createdAt: String
    var updatedAt: String

    var atDate: Date { JST.parse(at) ?? .distantPast }
}

/// 一覧の写真（端末のライブラリから毎回読む・上げない）。別の日に撮って足した写真は shownAt をこの日の同じ時刻に置く
struct TimelinePhoto: Hashable {
    let asset: PHAsset
    /// 一覧で並べる時刻（その日に撮った写真は撮影時刻そのもの）
    let shownAt: Date
    /// 別の日に撮って「写真を追加」で足した（端末の UserDefaults の印）
    let added: Bool

    var ref: String { asset.localIdentifier }
    var takenAt: Date? { asset.creationDate }
    /// 撮った位置（段階4の地図で使う）
    var location: CLLocation? {
        guard let l = asset.location, CLLocationCoordinate2DIsValid(l.coordinate),
              !(l.coordinate.latitude == 0 && l.coordinate.longitude == 0) else { return nil }
        return l
    }
}

/// きょうの一覧の一行（段階1はかけらと場所、段階2で写真。予定は段階3で足す）
enum TimelineItem: Identifiable, Hashable {
    case basho(Basho)
    case photo(TimelinePhoto)
    case kakera(Kakera)

    var id: String {
        switch self {
        case .kakera(let k): return "kakera-\(k.id)"
        case .basho(let b): return "basho-\(b.id)"
        case .photo(let p): return "photo-\(p.ref)"
        }
    }

    var date: Date {
        switch self {
        case .kakera(let k): return k.writtenDate
        case .basho(let b): return b.atDate
        case .photo(let p): return p.shownAt
        }
    }

    /// 同じ時刻（分まで同じ）のときの並び: 予定(0)→場所(1)→写真(2)→かけら(3)。予定は段階3で 0 に入る
    var kindRank: Int {
        switch self {
        case .basho: return 1
        case .photo: return 2
        case .kakera: return 3
        }
    }

    /// 同じ時刻・同じ種類のときの並び（かけら・場所は ULID なので作った順）
    var sortKey: String {
        switch self {
        case .kakera(let k): return k.id
        case .basho(let b): return b.id
        case .photo(let p): return p.ref
        }
    }

    /// 並べ順の比較。画面に出す時刻（分）で比べ、同じ分なら種類の順、その中は秒まで含めた時刻、最後に id
    static func ordered(_ a: TimelineItem, _ b: TimelineItem) -> Bool {
        let ma = (a.date.timeIntervalSince1970 / 60).rounded(.down), mb = (b.date.timeIntervalSince1970 / 60).rounded(.down)
        if ma != mb { return ma < mb }
        if a.kindRank != b.kindRank { return a.kindRank < b.kindRank }
        if a.date != b.date { return a.date < b.date }
        return a.sortKey < b.sortKey
    }
}

enum EntryKind: String, CaseIterable, Identifiable {
    case kakera, basho
    var id: String { rawValue }
    var label: String { self == .kakera ? "かけら" : "場所" }
}

enum DayPage {
    /// かけら・場所・写真を時刻順に1本にする（同じ分は 予定→場所→写真→かけら）
    static func merge(kakera: [Kakera], basho: [Basho], photos: [TimelinePhoto] = []) -> [TimelineItem] {
        (kakera.map(TimelineItem.kakera) + basho.map(TimelineItem.basho) + photos.map(TimelineItem.photo))
            .sorted(by: TimelineItem.ordered)
    }

    /// 別の日に撮った写真を、この日の同じ時刻（JST の時・分・秒）に置く
    static func shownAt(taken: Date, on day: String) -> Date {
        guard let r = JST.dayRange(day), let takenDay = JST.dayRange(JST.dayKey(taken)) else { return taken }
        return r.start.addingTimeInterval(taken.timeIntervalSince(takenDay.start))
    }

    /// 一覧に出す写真の参照: その日に撮ったもの（外した印のあるものを除く）＋足したもの（重なりは1回）
    static func photoRefs(dayRefs: [String], hidden: Set<String>, added: [String]) -> (own: [String], added: [String]) {
        let own = dayRefs.filter { !hidden.contains($0) }
        let ownSet = Set(dayRefs)
        var seen = Set<String>()
        let extra = added.filter { !ownSet.contains($0) && seen.insert($0).inserted }
        return (own, extra)
    }

    /// 入力欄の時刻の初期値: 今日なら今。過去の日は最後の項目の1分後（その日を越えるなら越えない所まで）、項目が無ければ 12:00
    static func defaultEntryDate(day: String, items: [TimelineItem], now: Date = Date()) -> Date {
        guard let r = JST.dayRange(day), day < JST.dayKey(now) else { return now }
        if let last = items.map(\.date).max() {
            let next = last.addingTimeInterval(60)
            return next < r.end ? next : r.end.addingTimeInterval(-60)
        }
        return r.start.addingTimeInterval(12 * 3600)
    }

    /// 選べる時刻（その日の 0:00〜23:59。今日なら今まで）
    static func entryRange(day: String, now: Date = Date()) -> ClosedRange<Date> {
        guard let r = JST.dayRange(day) else { return now...now }
        let upper = min(r.end.addingTimeInterval(-60), now)
        return r.start...max(r.start, upper)
    }
}

/// 場所の名前から座標を引く（端末の中で・Apple の地図）。取れなければ nil（名前だけ残す）。
/// iOS 26 で CLGeocoder の住所の引きは非推奨になったので MKGeocodingRequest。施設名（公園・駅など）は住所として
/// 引けないことがあるので、取れなければ地図の検索（MKLocalSearch）でもう一度引く。どちらも MapKit（新しいライブラリは入れない）
enum BashoGeocoder {
    static func coordinate(for name: String) async -> (lat: Double, lng: Double)? {
        await withTaskGroup(of: (lat: Double, lng: Double)?.self) { group in
            group.addTask { await lookup(name) }
            group.addTask {
                try? await Task.sleep(for: .seconds(10)) // 通信が詰まっても追加を待たせすぎない
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private static func lookup(_ name: String) async -> (lat: Double, lng: Double)? {
        if let request = MKGeocodingRequest(addressString: name) {
            request.preferredLocale = Locale(identifier: "ja_JP")
            if let item = try? await request.mapItems.first, let c = valid(item.location.coordinate) { return c }
        }
        let search = MKLocalSearch.Request()
        search.naturalLanguageQuery = name
        search.resultTypes = [.pointOfInterest, .address]
        if let r = try? await MKLocalSearch(request: search).start(), let item = r.mapItems.first,
           let c = valid(item.location.coordinate) { return c }
        return nil
    }

    private static func valid(_ c: CLLocationCoordinate2D) -> (lat: Double, lng: Double)? {
        guard CLLocationCoordinate2DIsValid(c), !(c.latitude == 0 && c.longitude == 0) else { return nil }
        return (c.latitude, c.longitude)
    }
}

// MARK: - 気分のハンコ

/// 嬉・楽・穏・疲・哀 の丸印。押した一つだけ朱の丸印になる。もう一度押すと外れる
struct KibunStamps: View {
    let selected: Kibun?
    let enabled: Bool
    let onTap: (Kibun) -> Void

    var body: some View {
        HStack(spacing: 10) {
            ForEach(Kibun.allCases) { k in
                let on = selected == k
                Button { onTap(k) } label: {
                    Text(k.rawValue)
                        .font(Theme.gothic(15, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.accent : Theme.muted)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(on ? Theme.accent.opacity(0.06) : Theme.paper))
                        .overlay(Circle().strokeBorder(on ? Theme.accent : Theme.line, lineWidth: on ? 1.5 : Theme.hairline))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                .opacity(enabled ? 1 : 0.4)
                .accessibilityLabel("気分 \(k.rawValue)")
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("kibun-\(k.rawValue)")
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 18)
    }
}

// MARK: - きょうの一覧

/// 種類の印（罫と墨の小さな記号）: かけらは墨の小さな四角、場所は墨の輪、写真は墨の枠の四角
struct KindMark: View {
    let item: TimelineItem

    var body: some View {
        Group {
            switch item {
            case .kakera:
                Rectangle().fill(Theme.ink).frame(width: 5, height: 5)
            case .basho:
                Circle().strokeBorder(Theme.ink, lineWidth: 1.2).frame(width: 8, height: 8)
            case .photo:
                Rectangle().strokeBorder(Theme.ink, lineWidth: 1.2).frame(width: 8, height: 8)
            }
        }
        .frame(width: 10, height: 10)
    }
}

/// 一覧の一行: 時刻｜種類の印｜内容｜×。左の縦線は一覧の側（TimelineList）が引く
struct TimelineRow: View {
    let item: TimelineItem
    let cards: LinkCards
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(JST.time(item.date)).font(Theme.mono(11)).foregroundStyle(Theme.muted)
                if case .kakera(let k) = item, k.katachiId != nil {
                    Text("かたち").font(Theme.mono(9.5)).foregroundStyle(Theme.muted.opacity(0.8))
                }
                if case .photo(let p) = item, p.added, let taken = p.takenAt {
                    // 別の日に撮って足した写真は、撮った日を小さく添える
                    Text(JST.shortDate(taken)).font(Theme.mono(9.5)).foregroundStyle(Theme.muted.opacity(0.8))
                }
            }
            .frame(width: 40, alignment: .leading)
            .padding(.top, 4)
            KindMark(item: item).padding(.top, 6)
            content.frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onDelete) {
                Image(systemName: "xmark").font(.system(size: 10, weight: .regular))
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(LinkButtonStyle(color: Theme.muted))
            .accessibilityLabel("消す")
            .accessibilityIdentifier("delete-\(item.id)")
        }
        .padding(.vertical, 12)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var content: some View {
        switch item {
        case .kakera(let k):
            RichTextView(k.body, cards: cards)
        case .basho(let b):
            VStack(alignment: .leading, spacing: 3) {
                Text(b.name).font(Theme.gothic(15)).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if b.lat == nil {
                    Text("位置なし").font(Theme.mono(9.5)).foregroundStyle(Theme.muted)
                }
            }
            .padding(.top, 1)
        case .photo(let p):
            // 小さな絵（多い日でも重くならないよう、この大きさで読む）
            AssetThumb(asset: p.asset, side: TimelineRow.thumbSide)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                .accessibilityLabel("写真 \(JST.time(p.shownAt))")
                .accessibilityIdentifier("photoThumb-\(p.ref)")
        }
    }

    static let thumbSide: CGFloat = 72
}

/// 一覧の左に通す縦線（時刻の列の左端・1pt の罫）
struct TimelineRail: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.leading, 12)
            .overlay(alignment: .leading) {
                Rectangle().fill(Theme.line).frame(width: Theme.hairline)
            }
    }
}

// MARK: - 入力欄

/// かけら｜場所 の切り替え（罫の枠の二つ割り。選んでいる方は墨の文字と下線）
struct EntryKindToggle: View {
    @Binding var kind: EntryKind

    var body: some View {
        HStack(spacing: 0) {
            ForEach(EntryKind.allCases) { k in
                let on = kind == k
                Button { kind = k } label: {
                    Text(k.label)
                        .font(Theme.gothic(12.5, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.ink : Theme.muted)
                        .frame(width: 64, height: 34)
                        .background(on ? Theme.line.opacity(0.45) : Theme.paper)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("entryKind-\(k.rawValue)")
                if k == .kakera { Rectangle().fill(Theme.line).frame(width: Theme.hairline, height: 34) }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
    }
}

/// 入力欄: かけら｜場所・時刻・テキスト・追加、その下に「写真を追加」。
/// **追加はボタンだけ**（onSubmit を付けない。日本語入力の確定の Enter で追加しない。かけらの欄の Enter は改行）
struct EntryBox: View {
    @Binding var kind: EntryKind
    @Binding var at: Date
    @Binding var text: String
    let range: ClosedRange<Date>
    let adding: Bool
    let enabled: Bool
    var focused: FocusState<Bool>.Binding
    /// 「写真を追加」で選んだもの（DayView が受け取って空に戻す）
    @Binding var pickedPhotos: [PhotosPickerItem]
    let onAdd: () -> Void

    private var canAdd: Bool { enabled && !adding && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                EntryKindToggle(kind: $kind)
                Spacer(minLength: 4)
                DatePicker("時刻", selection: $at, in: range, displayedComponents: .hourAndMinute)
                    .labelsHidden()
                    .tint(Theme.accent)
                    .environment(\.timeZone, JST.timeZone)
                    .environment(\.locale, Locale(identifier: "ja_JP"))
                    .accessibilityIdentifier("entryTime")
            }
            // 追加は欄の右に置く（キーボードが出ても欄と一緒に見える）
            HStack(alignment: .bottom, spacing: 8) {
                Group {
                    if kind == .kakera {
                        TextField("かけらを書く", text: $text, axis: .vertical).lineLimit(1...6)
                    } else {
                        TextField("場所の名前（例: 駅前の公園）", text: $text).submitLabel(.done)
                    }
                }
                .focused(focused)
                .font(Theme.gothic(15))
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 10).padding(.vertical, 9)
                .frame(minHeight: 38)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                .accessibilityIdentifier("entryText")
                Button(action: onAdd) {
                    if adding { ProgressView().controlSize(.small) } else { Text("追加") }
                }
                .buttonStyle(CTAButtonStyle())
                .disabled(!canAdd)
                .accessibilityIdentifier("entryAdd")
            }
            HStack(spacing: 10) {
                // 写真ピッカー。外した写真なら一覧に戻し、別の日の写真ならこの日の一覧に足す（アップロードはしない）
                PhotosPicker(selection: $pickedPhotos, matching: .images, photoLibrary: .shared()) {
                    Text("写真を追加")
                }
                .buttonStyle(LinkButtonStyle(color: Theme.accent))
                .disabled(!enabled)
                .accessibilityIdentifier("addPhotos")
                if kind == .basho {
                    Text("名前から位置を探して一緒に残します").font(Theme.gothic(11)).foregroundStyle(Theme.muted)
                }
            }
        }
        .padding(.top, 16)
    }
}

// MARK: - 写真

/// 別の日に撮った写真を、その日の一覧に足した印（写真は端末にしか無いので、印も端末の UserDefaults に置く）
enum PhotoAdds {
    private static let key = "kakera.timeline.addedPhotos"

    private static var all: [String: [String]] {
        get { UserDefaults.standard.dictionary(forKey: key) as? [String: [String]] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    static func refs(on day: String) -> [String] { all[day] ?? [] }

    static func add(_ ref: String, on day: String) {
        var a = all
        var list = a[day] ?? []
        if !list.contains(ref) { list.append(ref) }
        a[day] = list
        all = a
    }

    #if DEBUG
    static func removeAll() { UserDefaults.standard.removeObject(forKey: key) }
    #endif

    static func remove(_ ref: String, on day: String) {
        var a = all
        a[day]?.removeAll { $0 == ref }
        if a[day]?.isEmpty == true { a[day] = nil }
        all = a
    }
}

/// 一覧の写真を全画面で見る。左右で同じ日の写真を送る。閉じるボタン（下へ払っても閉じる）
struct PhotoViewer: View {
    let photos: [TimelinePhoto]
    @State var index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(photos.enumerated()), id: \.element.ref) { i, p in
                    FullAsset(asset: p.asset).tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            .accessibilityIdentifier("photoViewer")
            HStack {
                if photos.indices.contains(index) {
                    Text(JST.time(photos[index].shownAt)).font(Theme.mono(13)).foregroundStyle(.white.opacity(0.85))
                    Text("\(index + 1) / \(photos.count)").font(Theme.mono(11)).foregroundStyle(.white.opacity(0.6))
                        .accessibilityIdentifier("photoViewerIndex")
                }
                Spacer()
                Button("閉じる") { dismiss() }
                    .font(Theme.gothic(13, weight: .medium)).foregroundStyle(.white)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("closeViewer")
            }
            .padding(.horizontal, 18)
        }
        .gesture(DragGesture(minimumDistance: 30).onEnded { v in
            if v.translation.height > 120, abs(v.translation.width) < v.translation.height { dismiss() }
        })
    }
}

/// 全画面の一枚（画面の大きさで読む。iCloud にしか無い写真も取りに行く）
struct FullAsset: View {
    let asset: PHAsset
    @State private var image: UIImage?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { g in
            ZStack {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    ProgressView().tint(.white)
                }
            }
            .frame(width: g.size.width, height: g.size.height)
            .task(id: asset.localIdentifier) {
                let opts = PHImageRequestOptions()
                opts.deliveryMode = .opportunistic
                opts.isNetworkAccessAllowed = true
                let px = CGSize(width: g.size.width * displayScale, height: g.size.height * displayScale)
                PHImageManager.default().requestImage(for: asset, targetSize: px, contentMode: .aspectFit, options: opts) { img, _ in
                    if let img { Task { @MainActor in image = img } }
                }
            }
        }
    }
}

/// 一覧で写真を読む前の案内（理由を出してから求める）・拒否・限定のときの一行
struct PhotoAccessNote: View {
    let status: PHAuthorizationStatus
    let onRequest: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        switch status {
        case .notDetermined:
            VStack(alignment: .leading, spacing: 6) {
                Text("その日に撮った写真も、撮った時刻の位置に並べられます。写真は端末から読むだけで、どこにも上げません。")
                    .font(Theme.gothic(12)).foregroundStyle(Theme.muted).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                Button("写真を並べる") { onRequest() }
                    .buttonStyle(LinkButtonStyle(color: Theme.accent))
                    .accessibilityIdentifier("allowTimelinePhotos")
            }
            .padding(.vertical, 8)
        case .denied, .restricted:
            HStack(spacing: 8) {
                Text("写真へのアクセスが無いので、写真は並びません").font(Theme.gothic(11)).foregroundStyle(Theme.muted)
                Button("設定") { if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) } }
                    .buttonStyle(LinkButtonStyle(color: Theme.accent))
            }
        case .limited:
            Text("選んだ写真だけが並んでいます").font(Theme.gothic(11)).foregroundStyle(Theme.muted).padding(.vertical, 4)
        default:
            EmptyView()
        }
    }
}
