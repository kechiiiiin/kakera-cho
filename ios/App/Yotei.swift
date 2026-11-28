import CoreLocation
import EventKit
import SwiftUI

// 1日のページの予定（かけら帳1日のページ設計・段階3）: 端末のカレンダー（EventKit）から、その日（JST）に重なる予定を読む。
// 保存も送信もしない。一覧から外した印だけ Web の /api/timeline-hidden（kind=event・src/pages/api/timeline-hidden.ts）に置く。
// iPhone に入れた Google アカウントの予定も、端末のカレンダーとして読める。

/// 予定の一回分（繰り返し予定は回ごとに別の行）
struct Yotei: Hashable {
    /// 外す印の ref:「eventIdentifier|その回の開始日時（+09:00）」。繰り返し予定は全回で eventIdentifier が同じなので回の開始で分ける
    let ref: String
    let title: String
    let start: Date
    let end: Date
    let isAllDay: Bool
    /// 場所の文字（無ければ nil）
    let locationName: String?
    /// 予定の位置（structuredLocation.geoLocation・段階4の地図で使う）
    let location: CLLocation?

    static func ref(eventIdentifier: String, start: Date) -> String { "\(eventIdentifier)|\(JST.writtenAt(start))" }

    /// その日にかかる分（日をまたぐ予定は、その日の 0:00〜24:00 に切る）
    func clipped(to day: String) -> (start: Date, end: Date, fromBefore: Bool, toAfter: Bool) {
        guard let r = JST.dayRange(day) else { return (start, end, false, false) }
        return (max(start, r.start), min(end, r.end), start < r.start, end > r.end)
    }

    /// 一覧の時刻（終日は その日の 0:00、日をまたいで前から続く予定も 0:00）
    func shownAt(on day: String) -> Date { isAllDay ? (JST.dayRange(day)?.start ?? start) : clipped(to: day).start }

    /// 「10:00〜11:30」。日をまたぐなら「前日から〜01:30」「22:00〜翌日まで」
    func rangeLabel(on day: String) -> String {
        if isAllDay { return "終日" }
        let c = clipped(to: day)
        let from = c.fromBefore ? "前日から" : JST.time(c.start)
        let to = c.toAfter ? "翌日まで" : JST.time(c.end)
        return "\(from)〜\(to)"
    }
}

/// 端末のカレンダー。許可を求めるのは画面の「予定を並べる」を押してから（理由を先に出す）
@MainActor
@Observable
final class CalendarMaterials {
    private(set) var status: EKAuthorizationStatus = EKEventStore.authorizationStatus(for: .event)
    private(set) var events: [Yotei] = []
    private(set) var day: String = ""
    @ObservationIgnored private let store = EKEventStore()
    @ObservationIgnored private var observer: NSObjectProtocol?

    var canRead: Bool { status == .fullAccess }

    init() {
        // カレンダーが変わったら（同期・ほかのアプリでの編集）読み直す
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    func load(_ day: String) {
        self.day = day
        reload()
    }

    private func reload() {
        status = EKEventStore.authorizationStatus(for: .event)
        guard canRead, let r = JST.dayRange(day) else {
            events = []
            return
        }
        let predicate = store.predicateForEvents(withStart: r.start, end: r.end, calendars: nil)
        events = store.events(matching: predicate)
            .filter { $0.endDate > r.start && $0.startDate < r.end } // その日に重なるものだけ（終わりがちょうど 0:00 の予定は前日のもの）
            .map(Self.yotei)
    }

    func requestAccess() async {
        _ = try? await store.requestFullAccessToEvents()
        reload()
    }

    private static func yotei(_ e: EKEvent) -> Yotei {
        let geo = e.structuredLocation?.geoLocation
        let validGeo = geo.flatMap { CLLocationCoordinate2DIsValid($0.coordinate) && !($0.coordinate.latitude == 0 && $0.coordinate.longitude == 0) ? $0 : nil }
        let place = e.location?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Yotei(ref: Yotei.ref(eventIdentifier: e.eventIdentifier ?? e.calendarItemIdentifier, start: e.startDate),
                     title: (e.title?.isEmpty == false ? e.title! : "（無題の予定）"),
                     start: e.startDate, end: e.endDate, isAllDay: e.isAllDay,
                     locationName: place?.isEmpty == false ? place : nil, location: validGeo)
    }

    #if DEBUG
    /// 検査だけ: 起動引数 -kakeraSeedEvents YYYY-MM-DD で、検証用のカレンダー「かけら帳の検証」に予定を入れ直す
    /// （終日・時刻つき・場所つき・場所の文字だけ・繰り返し・日をまたぐもの）。ほかのカレンダーには触らない
    func seedForTesting(day: String) {
        guard canRead, let r = JST.dayRange(day) else { return }
        let name = "かけら帳の検証"
        let calendar: EKCalendar
        if let c = store.calendars(for: .event).first(where: { $0.title == name }) {
            calendar = c
            let range = store.predicateForEvents(withStart: r.start.addingTimeInterval(-7 * 86400), end: r.end.addingTimeInterval(7 * 86400), calendars: [c])
            for e in store.events(matching: range) { try? store.remove(e, span: .futureEvents, commit: false) }
        } else {
            calendar = EKCalendar(for: .event, eventStore: store)
            calendar.title = name
            calendar.source = store.sources.first(where: { $0.sourceType == .local }) ?? store.defaultCalendarForNewEvents?.source
            try? store.saveCalendar(calendar, commit: false)
        }
        func add(_ title: String, _ start: Date, _ end: Date, allDay: Bool = false, place: String? = nil,
                 geo: CLLocation? = nil, rule: EKRecurrenceRule? = nil) {
            let e = EKEvent(eventStore: store)
            e.calendar = calendar
            e.title = title
            e.startDate = start
            e.endDate = end
            e.isAllDay = allDay
            if let place {
                let s = EKStructuredLocation(title: place)
                s.geoLocation = geo
                e.structuredLocation = s
            }
            if let rule { e.addRecurrenceRule(rule) }
            try? store.save(e, span: .futureEvents, commit: false)
        }
        let h: (Double) -> Date = { r.start.addingTimeInterval($0 * 3600) }
        add("祝日のような終日の予定", r.start, r.start.addingTimeInterval(86400 - 1), allDay: true)
        add("夜行バス", h(-2), h(1.5)) // 前日 22:00〜01:30
        add("朝の散歩", h(7.5).addingTimeInterval(-2 * 86400), h(8).addingTimeInterval(-2 * 86400),
            rule: EKRecurrenceRule(recurrenceWith: .daily, interval: 1, end: EKRecurrenceEnd(occurrenceCount: 5)))
        add("打ち合わせ", h(10), h(11.5), place: "東京駅", geo: CLLocation(latitude: 35.6812, longitude: 139.7671))
        add("昼の約束", h(12.5), h(13))
        add("夜の勉強会", h(22), h(25)) // 22:00〜翌 01:00
        add("夕方の買い物", h(18), h(19), place: "新宿駅") // 位置なし・場所の文字だけ（端末でジオコーディングする）
        try? store.commit()
        reload()
    }
    #endif
}

/// 一覧で予定を読む前の案内（理由を出してから求める）・拒否のときの一行と「設定」
struct CalendarAccessNote: View {
    let status: EKAuthorizationStatus
    let onRequest: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        switch status {
        case .notDetermined:
            VStack(alignment: .leading, spacing: 6) {
                Text("その日の予定も時刻の位置に並べられます。端末のカレンダーから読むだけで、保存も送信もしません。")
                    .font(Theme.gothic(12)).foregroundStyle(Theme.muted).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                Button("予定を並べる") { onRequest() }
                    .buttonStyle(LinkButtonStyle(color: Theme.accent))
                    .accessibilityIdentifier("allowTimelineEvents")
            }
            .padding(.vertical, 8)
        case .fullAccess:
            EmptyView()
        default:
            // 拒否・制限・書き込みだけ（読めない）
            HStack(spacing: 8) {
                Text("カレンダーを読めないので、予定は並びません").font(Theme.gothic(11)).foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("eventsDenied")
                Button("設定") { if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) } }
                    .buttonStyle(LinkButtonStyle(color: Theme.accent))
            }
        }
    }
}
