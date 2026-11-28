import MapKit
import Photos
import PhotosUI
import SwiftUI

// 1日のページの部品（かけら帳1日のページ設計・段階1〜2）: きょうの一覧（かけら＋場所＋写真を時刻順）・入力欄。
// 見た目は 2026-11-28 の刷新「C 丸 時間の帳」: 一覧は時ごとの段（左に時、行の左に分）、入力は下の帯（か｜場｜写・丸い欄・朱の ＋）。
// 気分のハンコは 2026-11-28 に画面から外した（D1 の day・/api/day はそのまま残す）。
// Web の src/lib/kakera/day-input.ts（場所の検査）・day-db.ts（Place の形）・
// src/pages/api/day/[date].ts・src/pages/api/place/ と対になる。並べ方と時刻の初期値は DayPage に置いて XCTest で確かめる。

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

/// 一覧の予定（その日に表示する時刻つき）
struct TimelineYotei: Hashable {
    let yotei: Yotei
    /// 一覧で並べる時刻（終日・前日から続く予定はその日の 0:00）
    let shownAt: Date
    /// 「10:00〜11:30」「終日」「前日から〜01:30」
    let rangeLabel: String

    var ref: String { yotei.ref }
}

/// きょうの一覧の一行（段階1はかけらと場所、段階2で写真、段階3で予定）
enum TimelineItem: Identifiable, Hashable {
    case yotei(TimelineYotei)
    case basho(Basho)
    case photo(TimelinePhoto)
    case kakera(Kakera)

    var id: String {
        switch self {
        case .kakera(let k): return "kakera-\(k.id)"
        case .basho(let b): return "basho-\(b.id)"
        case .photo(let p): return "photo-\(p.ref)"
        case .yotei(let y): return "yotei-\(y.ref)"
        }
    }

    var date: Date {
        switch self {
        case .kakera(let k): return k.writtenDate
        case .basho(let b): return b.atDate
        case .photo(let p): return p.shownAt
        case .yotei(let y): return y.shownAt
        }
    }

    /// 終日の予定（一覧の先頭・時刻欄は「終日」）
    var isAllDay: Bool {
        if case .yotei(let y) = self { return y.yotei.isAllDay }
        return false
    }

    /// 時刻欄の文字
    var timeLabel: String { isAllDay ? "終日" : JST.time(date) }

    /// 同じ時刻（分まで同じ）のときの並び: 予定(0)→場所(1)→写真(2)→かけら(3)
    var kindRank: Int {
        switch self {
        case .yotei: return 0
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
        case .yotei(let y): return y.ref
        }
    }

    /// 並べ順の比較。終日の予定が先頭。あとは画面に出す時刻（分）で比べ、同じ分なら種類の順、その中は秒まで含めた時刻、最後に id
    static func ordered(_ a: TimelineItem, _ b: TimelineItem) -> Bool {
        if a.isAllDay != b.isAllDay { return a.isAllDay }
        let ma = (a.date.timeIntervalSince1970 / 60).rounded(.down), mb = (b.date.timeIntervalSince1970 / 60).rounded(.down)
        if ma != mb { return ma < mb }
        if a.kindRank != b.kindRank { return a.kindRank < b.kindRank }
        if a.date != b.date { return a.date < b.date }
        return a.sortKey < b.sortKey
    }
}

enum DayPage {
    /// かけら・場所・写真を時刻順に1本にする（同じ分は 予定→場所→写真→かけら）
    static func merge(kakera: [Kakera], basho: [Basho], photos: [TimelinePhoto] = [], yotei: [TimelineYotei] = []) -> [TimelineItem] {
        (yotei.map(TimelineItem.yotei) + kakera.map(TimelineItem.kakera) + basho.map(TimelineItem.basho) + photos.map(TimelineItem.photo))
            .sorted(by: TimelineItem.ordered)
    }

    /// その日の一覧に出す予定（外した印のある回を除く）
    static func yotei(_ events: [Yotei], on day: String, hidden: Set<String>) -> [TimelineYotei] {
        events.filter { !hidden.contains($0.ref) }.map {
            TimelineYotei(yotei: $0, shownAt: $0.shownAt(on: day), rangeLabel: $0.rangeLabel(on: day))
        }
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

// MARK: - きょうの一覧（時の段・C 丸「時間の帳」）

/// 時の段の一行: 一つの項目か、同じ時の中で続けて撮った写真の並び（横に並べる）
enum HourRow: Identifiable, Hashable {
    case item(TimelineItem)
    case photos([TimelinePhoto])

    var id: String {
        switch self {
        case .item(let i): return i.id
        case .photos(let ps): return "photos-\(ps.first?.ref ?? "")"
        }
    }

    var date: Date {
        switch self {
        case .item(let i): return i.date
        case .photos(let ps): return ps.first?.shownAt ?? .distantPast
        }
    }

    /// 時刻の全体（「08:40」「終日」）。画面には時と分に分けて出し、読み上げと UI テストはこちらで探す
    var timeLabel: String {
        switch self {
        case .item(let i): return i.timeLabel
        case .photos: return JST.time(date)
        }
    }

    /// 行の左の分（「40」）。終日の予定は空
    var minuteLabel: String {
        if case .item(let i) = self, i.isAllDay { return "" }
        return String(JST.time(date).suffix(2))
    }
}

/// 時（「08」・終日は「終日」）ごとの段
struct HourBlock: Identifiable, Hashable {
    let label: String
    var rows: [HourRow]
    var id: String { label }
}

/// 段を一本に並べた一行（LazyVStack の直の子）。id は日・時・行で作る（同じ予定の回は日をまたいでも行の id が同じなので、
/// 日を移ったとき前の日の行の姿が残らないように）
struct HourLine: Identifiable {
    let id: String
    /// 段の最初の行だけ時を出す
    let hour: String?
    let row: HourRow
    let first: Bool
    let last: Bool
}

extension DayPage {
    static func lines(_ blocks: [HourBlock], day: String) -> [HourLine] {
        blocks.flatMap { b in
            b.rows.enumerated().map { i, r in
                HourLine(id: "\(day)|\(b.label)|\(r.id)", hour: i == 0 ? b.label : nil, row: r,
                         first: i == 0, last: i == b.rows.count - 1)
            }
        }
    }

    /// 並べた一覧を時ごとの段にする。終日の予定は先頭の「終日」の段。同じ時の中で続けて並ぶ写真は一つの行にまとめる
    /// （間にかけら等が挟まれば分ける＝時刻の順を崩さない）
    static func hours(_ items: [TimelineItem]) -> [HourBlock] {
        var blocks: [HourBlock] = []
        for item in items {
            let label = item.isAllDay ? "終日" : String(JST.time(item.date).prefix(2))
            if blocks.last?.label != label { blocks.append(HourBlock(label: label, rows: [])) }
            let b = blocks.count - 1
            if case .photo(let p) = item {
                if case .photos(let ps)? = blocks[b].rows.last {
                    blocks[b].rows[blocks[b].rows.count - 1] = .photos(ps + [p])
                } else {
                    blocks[b].rows.append(.photos([p]))
                }
            } else {
                blocks[b].rows.append(.item(item))
            }
        }
        return blocks
    }
}

/// 行の右の薄い ×（今までの「消す・外す」）
struct RowDeleteButton: View {
    let id: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 9.5, weight: .regular))
                .frame(width: 32, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(LinkButtonStyle(color: Theme.muted.opacity(0.55)))
        .accessibilityLabel("消す")
        .accessibilityIdentifier("delete-\(id)")
    }
}

/// 段の中の一行（写真以外）: 分｜（地図の番号）札・内容／小さな字｜×。予定は丸い札、場所は朱の丸い札、かけらは札なし
struct DayItemRow: View {
    let item: TimelineItem
    let day: String
    let cards: LinkCards
    /// 地図のピンと同じ番号（座標のある行だけ）
    var number: Int? = nil
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            content.frame(maxWidth: .infinity, alignment: .leading)
            RowDeleteButton(id: item.id, action: onDelete).padding(.top, -2).padding(.bottom, -6)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var numberMark: some View {
        if let number { PinNumber(number: number, size: 15).accessibilityIdentifier("rowNumber-\(number)") }
    }

    @ViewBuilder
    private var content: some View {
        switch item {
        case .kakera(let k):
            VStack(alignment: .leading, spacing: 3) {
                RichTextView(k.body, cards: cards)
                if k.katachiId != nil {
                    Text("かたち").font(Theme.mono(9.5)).foregroundStyle(Theme.muted.opacity(0.8))
                }
            }
        case .basho(let b):
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .center, spacing: 6) {
                    numberMark
                    Fuda(text: "場所", accent: true)
                    Text(b.name).font(Theme.gothic(15)).foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if b.source == "visit" {
                    Text("自動").font(Theme.gothic(11)).foregroundStyle(Theme.muted)
                } else if b.lat == nil {
                    Text("位置なし").font(Theme.gothic(11)).foregroundStyle(Theme.muted)
                }
            }
        case .yotei(let y):
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .center, spacing: 6) {
                    numberMark
                    Fuda(text: "予定")
                    Text(y.yotei.title).font(Theme.gothic(15)).foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                let sub = [y.yotei.untilLabel(on: day), y.yotei.locationName].compactMap { $0 }
                if !sub.isEmpty {
                    Text(sub.joined(separator: "・")).font(Theme.gothic(11)).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("yotei-\(y.yotei.title)")
        case .photo:
            EmptyView() // 写真は DayPhotoStrip（同じ時の中で横に並べる）
        }
    }
}

/// 同じ時の中で続けて撮った写真の並び（角丸の絵・左から時刻順・幅に収まらなければ折り返す）。
/// 押すと全画面、右上の薄い × で外す、地図の番号は左下、別の日から足した写真は撮った日を下に添える
struct DayPhotoStrip: View {
    let photos: [TimelinePhoto]
    let numbers: [String: Int]
    let onOpen: (TimelinePhoto) -> Void
    let onHide: (TimelinePhoto) -> Void

    static let side: CGFloat = 56

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: Self.side, maximum: Self.side), spacing: 6, alignment: .leading)],
                  alignment: .leading, spacing: 6) {
            ForEach(photos, id: \.ref) { p in thumb(p) }
        }
    }

    private func thumb(_ p: TimelinePhoto) -> some View {
        let item = TimelineItem.photo(p)
        return AssetThumb(asset: p.asset, side: Self.side)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line, lineWidth: Theme.hairline))
            .contentShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .onTapGesture { onOpen(p) }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("写真 \(JST.time(p.shownAt))")
            .accessibilityIdentifier("photoThumb-\(p.ref)")
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 2) {
                    if let n = numbers[item.id] {
                        PinNumber(number: n, size: 15).accessibilityIdentifier("rowNumber-\(n)")
                    }
                    if p.added, let taken = p.takenAt {
                        // 別の日に撮って足した写真は、撮った日を小さく添える
                        Text(JST.shortDate(taken)).font(Theme.mono(9)).foregroundStyle(.white)
                            .padding(.horizontal, 5).padding(.vertical, 0.5)
                            .background(.black.opacity(0.5), in: Capsule())
                    }
                }
                .padding(4)
            }
            .overlay(alignment: .topTrailing) {
                Button { onHide(p) } label: {
                    Image(systemName: "xmark").font(.system(size: 7.5, weight: .semibold))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 17, height: 17)
                        .background(Theme.paper.opacity(0.85), in: Circle())
                        .padding(4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("消す")
                .accessibilityIdentifier("delete-\(item.id)")
            }
    }
}

/// 段の一行の組み立て: 左に時（段の最初の行だけ）・分、右に中身。段の頭に罫1本
struct HourRowFrame<Content: View>: View {
    let hour: String?
    let minute: String
    /// 「08:40」（読み上げ用・分の字に付ける）
    let time: String
    let first: Bool
    let last: Bool
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Text(hour ?? "").font(hour == "終日" ? Theme.gothic(10.5) : Theme.mono(11)).foregroundStyle(Theme.muted)
                .frame(width: 38, alignment: .leading)
                .padding(.top, 2)
            Text(minute).font(Theme.mono(10)).foregroundStyle(Theme.muted)
                .frame(width: 22, alignment: .leading)
                .padding(.top, 4)
                .accessibilityLabel(time)
            content().padding(.leading, 8)
        }
        .padding(.top, first ? 14 : 7)
        .padding(.bottom, last ? 12 : 7)
        .overlay(alignment: .top) { if first { Rule() } }
    }
}

// MARK: - 下の帯（いつも出る・キーボードの上に上がる）

enum EntryKind: String, CaseIterable, Identifiable {
    case kakera, basho
    var id: String { rawValue }
    /// 下の帯の丸い切り替えの字
    var label: String { self == .kakera ? "か" : "場" }
    var placeholder: String { self == .kakera ? "かけらを書く" : "場所の名前" }
}

/// 下の帯: 「か｜場｜写」の丸い切り替え・丸い入力欄（中に時刻。押すと変えられる）・朱の丸い ＋。
/// ＋ は、文字があれば一覧へ追加（かけら・場所）、かけらで空のままなら書く画面（EditorView）。「写」は写真ピッカー。
/// **追加はボタンだけ**（onSubmit を付けない。日本語入力の確定の Enter で追加しない。かけらの欄の Enter は改行）
struct EntryDock: View {
    @Binding var kind: EntryKind
    @Binding var at: Date
    @Binding var text: String
    /// 今日で、時刻をまだ触っていない（欄の時刻は今に付いていく）
    let followsNow: Bool
    let range: ClosedRange<Date>
    let adding: Bool
    /// その日を読み終えた（読み終える前は一覧へ足させない）
    let enabled: Bool
    /// かけら帳につながる（書く画面・写真）
    let configured: Bool
    var focused: FocusState<Bool>.Binding
    @Binding var pickedPhotos: [PhotosPickerItem]
    let onTimeChanged: () -> Void
    let onAdd: () -> Void
    let onWrite: () -> Void

    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canPress: Bool {
        guard configured, !adding else { return false }
        return isEmpty ? kind == .kakera : enabled
    }

    var body: some View {
        VStack(spacing: 0) {
            Rule()
            HStack(alignment: .bottom, spacing: 8) {
                segment
                field
                Button {
                    if isEmpty { onWrite() } else { onAdd() }
                } label: {
                    if adding { ProgressView().tint(Theme.paper).controlSize(.small) } else { Image(systemName: "plus") }
                }
                .buttonStyle(RoundAddButtonStyle())
                .disabled(!canPress)
                .accessibilityLabel(isEmpty ? "書く" : "追加")
                .accessibilityIdentifier("entryAdd")
            }
            .padding(.horizontal, 14).padding(.top, 9).padding(.bottom, 8)
        }
        .background(Theme.paper.ignoresSafeArea(edges: .bottom))
    }

    /// か｜場｜写（選んでいる方は墨の塗りに地の字。写は押すとピッカー）
    private var segment: some View {
        HStack(spacing: 0) {
            ForEach(EntryKind.allCases) { k in
                let on = kind == k
                Button { kind = k } label: {
                    Text(k.label).font(Theme.gothic(12.5, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.paper : Theme.muted)
                        .frame(width: 32, height: 38)
                        .background(on ? Theme.ink : Color.clear)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(k == .kakera ? "かけら" : "場所")
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("entryKind-\(k.rawValue)")
            }
            // 写真ピッカー。外した写真なら一覧に戻し、別の日の写真ならこの日の一覧に足す（アップロードはしない）
            PhotosPicker(selection: $pickedPhotos, matching: .images, photoLibrary: .shared()) {
                Text("写").font(Theme.gothic(12.5)).foregroundStyle(Theme.muted)
                    .frame(width: 32, height: 38)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!configured)
            .accessibilityLabel("写真を追加")
            .accessibilityIdentifier("addPhotos")
        }
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(Theme.line, lineWidth: Theme.hairline))
        .padding(.bottom, 1)
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 6) {
            // か｜場 を切り替えても同じ欄のまま（キーボードを下げない）。場所の改行は足すときに空白にする（DayView.addEntry）
            TextField(kind.placeholder, text: $text, axis: .vertical)
            .lineLimit(1...(kind == .kakera ? 5 : 2))
            .focused(focused)
            .font(Theme.gothic(15))
            .foregroundStyle(Theme.ink)
            .padding(.vertical, 10)
            .accessibilityIdentifier("entryText")
            timeChip.padding(.bottom, 6)
        }
        .padding(.leading, 16).padding(.trailing, 8)
        .frame(minHeight: 40)
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.line, lineWidth: Theme.hairline))
    }

    /// 欄の中の時刻（等幅）。押すと時刻の選び方が開く（システムの DatePicker を透明にして重ねる）
    private var timeChip: some View {
        TimelineView(.everyMinute) { ctx in
            let shown = followsNow ? ctx.date : at
            Text(JST.time(shown))
                .font(Theme.mono(12)).foregroundStyle(Theme.ink)
                .padding(.horizontal, 6).frame(minHeight: 28)
                .overlay {
                    DatePicker("時刻", selection: Binding(get: { followsNow ? Date() : at }, set: { at = $0; onTimeChanged() }),
                               in: range, displayedComponents: .hourAndMinute)
                        .labelsHidden()
                        .environment(\.timeZone, JST.timeZone)
                        .environment(\.locale, Locale(identifier: "ja_JP"))
                        .colorMultiply(.clear)
                }
                .clipped()
                .accessibilityElement(children: .combine)
                .accessibilityLabel("時刻 \(JST.time(shown))")
                .accessibilityIdentifier("entryTime")
        }
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
                    .buttonStyle(CTAButtonStyle())
                    .padding(.top, 4)
                    .accessibilityIdentifier("allowTimelinePhotos")
            }
            .noteBox()
            .padding(.vertical, 6)
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
