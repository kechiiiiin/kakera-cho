import MapKit
import SwiftUI

// 1日のページの部品（かけら帳1日のページ設計・段階1）: 気分のハンコ・きょうの一覧（かけら＋場所を時刻順）・入力欄。
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

/// きょうの一覧の一行（段階1はかけらと場所。予定・写真は段階2・3で足す）
enum TimelineItem: Identifiable, Hashable {
    case kakera(Kakera)
    case basho(Basho)

    var id: String {
        switch self {
        case .kakera(let k): return "kakera-\(k.id)"
        case .basho(let b): return "basho-\(b.id)"
        }
    }

    var date: Date {
        switch self {
        case .kakera(let k): return k.writtenDate
        case .basho(let b): return b.atDate
        }
    }

    /// 同じ時刻のときの並び（ULID なので作った順）
    var sortKey: String {
        switch self {
        case .kakera(let k): return k.id
        case .basho(let b): return b.id
        }
    }
}

enum EntryKind: String, CaseIterable, Identifiable {
    case kakera, basho
    var id: String { rawValue }
    var label: String { self == .kakera ? "かけら" : "場所" }
}

enum DayPage {
    /// かけらと場所を時刻順に1本にする（同じ時刻は id 順）
    static func merge(kakera: [Kakera], basho: [Basho]) -> [TimelineItem] {
        (kakera.map(TimelineItem.kakera) + basho.map(TimelineItem.basho)).sorted {
            $0.date != $1.date ? $0.date < $1.date : $0.sortKey < $1.sortKey
        }
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

/// 種類の印（罫と墨の小さな記号）: かけらは墨の小さな四角、場所は墨の輪
struct KindMark: View {
    let item: TimelineItem

    var body: some View {
        Group {
            switch item {
            case .kakera:
                Rectangle().fill(Theme.ink).frame(width: 5, height: 5)
            case .basho:
                Circle().strokeBorder(Theme.ink, lineWidth: 1.2).frame(width: 8, height: 8)
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
            }
            .frame(width: 36, alignment: .leading)
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
        }
    }
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

/// 入力欄: かけら｜場所・時刻・テキスト・追加。
/// **追加はボタンだけ**（onSubmit を付けない。日本語入力の確定の Enter で追加しない。かけらの欄の Enter は改行）
struct EntryBox: View {
    @Binding var kind: EntryKind
    @Binding var at: Date
    @Binding var text: String
    let range: ClosedRange<Date>
    let adding: Bool
    let enabled: Bool
    var focused: FocusState<Bool>.Binding
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
            if kind == .basho {
                Text("名前から位置を探して一緒に残します").font(Theme.gothic(11)).foregroundStyle(Theme.muted)
            }
        }
        .padding(.top, 16)
    }
}
