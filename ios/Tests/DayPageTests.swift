import CoreLocation
import XCTest
@testable import Kakera

/// 1日のページ（かけら帳1日のページ設計・段階1）: きょうの一覧の並び・入力欄の時刻の初期値と範囲・API の形の読み。
/// Web の src/lib/kakera/day-db.ts（Place の形）と対になる。気分のハンコは 2026-11-28 に画面から外した。
final class DayPageTests: XCTestCase {
    private func kakera(_ id: String, _ at: String, katachi: String? = nil) -> Kakera {
        Kakera(id: id, body: "本文 \(id)", writtenAt: at, katachiId: katachi, updatedAt: at)
    }

    private func basho(_ id: String, _ at: String, lat: Double? = nil) -> Basho {
        Basho(id: id, at: at, name: "場所 \(id)", lat: lat, lng: lat, source: "manual", createdAt: at, updatedAt: at)
    }

    private func date(_ s: String) -> Date { JST.parse(s)! }

    func testMergeIsTimeOrderedAcrossKinds() {
        let items = DayPage.merge(
            kakera: [kakera("K2", "2026-11-27T21:10:00+09:00"), kakera("K1", "2026-11-27T08:05:00+09:00", katachi: "T")],
            basho: [basho("B1", "2026-11-27T12:00:00+09:00"), basho("B0", "2026-11-27T08:05:00+09:00")]
        )
        // 同じ時刻（08:05）は id 順
        XCTAssertEqual(items.map(\.id), ["basho-B0", "kakera-K1", "basho-B1", "kakera-K2"])
    }

    func testSameMinuteOrderIsPlaceThenPhotoThenKakera() {
        // 分が同じなら 予定→場所→写真→かけら（秒が後でも場所が先）
        let items = DayPage.merge(
            kakera: [kakera("K", "2026-11-27T12:30:00+09:00")],
            basho: [basho("B", "2026-11-27T12:30:50+09:00")]
        )
        XCTAssertEqual(items.map(\.id), ["basho-B", "kakera-K"])
        XCTAssertEqual(items.map(\.kindRank), [1, 3])
        // 分が違えば時刻順のまま
        let apart = DayPage.merge(kakera: [kakera("K", "2026-11-27T12:29:59+09:00")], basho: [basho("B", "2026-11-27T12:30:00+09:00")])
        XCTAssertEqual(apart.map(\.id), ["kakera-K", "basho-B"])
    }

    private func yotei(_ title: String, _ start: String, _ end: String, allDay: Bool = false) -> Yotei {
        Yotei(ref: Yotei.ref(eventIdentifier: "EV-\(title)", start: date(start)), title: title, start: date(start), end: date(end),
              isAllDay: allDay, locationName: nil, location: nil)
    }

    func testYoteiRefSeparatesOccurrences() {
        // 繰り返し予定は eventIdentifier が同じなので、回の開始日時で分ける
        XCTAssertEqual(Yotei.ref(eventIdentifier: "ABC:123", start: date("2026-11-27T07:30:00+09:00")), "ABC:123|2026-11-27T07:30:00+09:00")
        XCTAssertNotEqual(Yotei.ref(eventIdentifier: "ABC:123", start: date("2026-11-27T07:30:00+09:00")),
                          Yotei.ref(eventIdentifier: "ABC:123", start: date("2026-11-28T07:30:00+09:00")))
    }

    func testYoteiAcrossDays() {
        let bus = yotei("bus", "2026-11-26T22:00:00+09:00", "2026-11-27T01:30:00+09:00")
        XCTAssertEqual(bus.rangeLabel(on: "2026-11-27"), "前日から〜01:30")
        XCTAssertEqual(bus.shownAt(on: "2026-11-27"), date("2026-11-27T00:00:00+09:00"))
        XCTAssertEqual(bus.rangeLabel(on: "2026-11-26"), "22:00〜翌日まで")
        XCTAssertEqual(yotei("m", "2026-11-27T10:00:00+09:00", "2026-11-27T11:30:00+09:00").rangeLabel(on: "2026-11-27"), "10:00〜11:30")
    }

    func testAllDayFirstThenSameMinuteYoteiBeforeOthers() {
        let ys = DayPage.yotei([
            yotei("lunch", "2026-11-27T12:30:00+09:00", "2026-11-27T13:00:00+09:00"),
            yotei("holiday", "2026-11-27T00:00:00+09:00", "2026-11-27T23:59:59+09:00", allDay: true),
            yotei("bus", "2026-11-26T22:00:00+09:00", "2026-11-27T01:30:00+09:00"),
            yotei("hidden", "2026-11-27T09:00:00+09:00", "2026-11-27T09:30:00+09:00"),
        ], on: "2026-11-27", hidden: [Yotei.ref(eventIdentifier: "EV-hidden", start: date("2026-11-27T09:00:00+09:00"))])
        let items = DayPage.merge(
            kakera: [kakera("K", "2026-11-27T12:30:00+09:00"), kakera("K0", "2026-11-27T00:00:00+09:00")],
            basho: [basho("B", "2026-11-27T12:30:10+09:00")], yotei: ys
        )
        XCTAssertEqual(items.map(\.id).map { $0.components(separatedBy: "|").first! },
                       ["yotei-EV-holiday", "yotei-EV-bus", "kakera-K0", "yotei-EV-lunch", "basho-B", "kakera-K"])
        XCTAssertEqual(items.first?.timeLabel, "終日")
    }

    // MARK: 段階4 地図・訪問

    private func bashoAt(_ id: String, _ at: String, _ lat: Double?, _ lng: Double?) -> Basho {
        Basho(id: id, at: at, name: "場所 \(id)", lat: lat, lng: lng, source: "manual", createdAt: at, updatedAt: at)
    }

    func testPinsNumberRowsWithCoordinatesInListOrder() {
        let withGeo = Yotei(ref: "EV-a|x", title: "会議", start: date("2026-11-27T10:00:00+09:00"), end: date("2026-11-27T11:00:00+09:00"),
                            isAllDay: false, locationName: "どこか", location: nil)
        let noGeo = Yotei(ref: "EV-b|x", title: "電話", start: date("2026-11-27T09:00:00+09:00"), end: date("2026-11-27T09:10:00+09:00"),
                          isAllDay: false, locationName: "わからない所", location: nil)
        let items = DayPage.merge(
            kakera: [kakera("K", "2026-11-27T08:00:00+09:00")],
            basho: [bashoAt("B1", "2026-11-27T07:00:00+09:00", 35.0, 139.0), bashoAt("B2", "2026-11-27T12:00:00+09:00", nil, nil),
                    bashoAt("B3", "2026-11-27T15:00:00+09:00", 35.5, 139.5)],
            yotei: DayPage.yotei([withGeo, noGeo], on: "2026-11-27", hidden: [])
        )
        let pins = Chizu.pins(items, geocoded: ["どこか": GeoPoint(lat: 35.2, lng: 139.2)])
        // かけら・座標の無い場所・引けなかった予定は飛ばし、残りに上から 1, 2, 3
        XCTAssertEqual(pins.map(\.itemID), ["basho-B1", "yotei-EV-a|x", "basho-B3"])
        XCTAssertEqual(pins.map(\.number), [1, 2, 3])
        XCTAssertEqual(pins[1].lat, 35.2)
    }

    private func pin(_ n: Int) -> ChizuPin { ChizuPin(number: n, itemID: "p\(n)", lat: 35 + Double(n) / 100, lng: 139 + Double(n) / 100, title: "") }

    func testGoogleMapsURL() throws {
        XCTAssertNil(Chizu.googleMapsURL([pin(1)]), "ピンが2つ未満なら出さない")
        let two = try XCTUnwrap(Chizu.googleMapsURL([pin(1), pin(2)]))
        XCTAssertEqual(two.absoluteString,
                       "https://www.google.com/maps/dir/?api=1&origin=35.010000,139.010000&destination=35.020000,139.020000&waypoints=&travelmode=transit")
        let many = try XCTUnwrap(Chizu.googleMapsURL((1...15).map(pin)))
        let q = try XCTUnwrap(URLComponents(url: many, resolvingAgainstBaseURL: false)?.queryItems)
        let waypoints = try XCTUnwrap(q.first { $0.name == "waypoints" }?.value).split(separator: "|")
        XCTAssertEqual(waypoints.count, 9, "経由地は9まで")
        XCTAssertEqual(waypoints.first, "35.020000,139.020000")
        XCTAssertEqual(waypoints.last, "35.140000,139.140000")
        XCTAssertEqual(q.first { $0.name == "origin" }?.value, "35.010000,139.010000")
        XCTAssertEqual(q.first { $0.name == "destination" }?.value, "35.150000,139.150000")
    }

    func testThinEvenly() {
        XCTAssertEqual(Chizu.thin(Array(0..<13), to: 9), [0, 2, 3, 5, 6, 8, 9, 11, 12])
        XCTAssertEqual(Chizu.thin([1, 2, 3], to: 9), [1, 2, 3])
    }

    func testVisitIDIsStableULIDPerVisit() {
        let at = date("2026-11-27T14:05:31+09:00")
        let c = CLLocationCoordinate2D(latitude: 35.68123, longitude: 139.76712)
        let id = Houmon.visitID(arrival: at, coordinate: c)
        XCTAssertEqual(id.count, 26)
        XCTAssertNotNil(id.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression), "Web の isUlid を通る形")
        // 同じ訪問（同じ分・約100m以内）は同じ id
        XCTAssertEqual(id, Houmon.visitID(arrival: at.addingTimeInterval(10), coordinate: .init(latitude: 35.6814, longitude: 139.7669)))
        XCTAssertNotEqual(id, Houmon.visitID(arrival: at.addingTimeInterval(120), coordinate: c))
        XCTAssertNotEqual(id, Houmon.visitID(arrival: at, coordinate: .init(latitude: 35.70, longitude: 139.76712)))
        // 時刻の部分は到着の分（ULID の並びが時刻順になる）
        XCTAssertEqual(String(id.prefix(10)), String(ULID.make(date("2026-11-27T14:05:00+09:00")).prefix(10)))
    }

    // MARK: 段階5 月カレンダー・検索

    func testTsukiCells() {
        // 2026-11-01 は日曜（空き升なし）、2026-12-01 は火曜（空き2つ）
        let nov = Tsuki.cells("2026-11")
        XCTAssertEqual(nov.first!, "2026-11-01")
        XCTAssertEqual(nov.count, 30)
        let dec = Tsuki.cells("2026-12")
        XCTAssertEqual(Array(dec.prefix(3)), [nil, nil, "2026-12-01"])
        XCTAssertEqual(dec.last!, "2026-12-31")
        XCTAssertEqual(Tsuki.cells("2028-02").compactMap { $0 }.count, 29)
        XCTAssertEqual(Tsuki.shift("2026-12", by: 1), "2027-01")
        XCTAssertEqual(Tsuki.shift("2026-01", by: -1), "2025-12")
        XCTAssertEqual(Tsuki.title("2026-03"), "2026年3月")
        XCTAssertEqual(Tsuki.monthKey("2026-11-27"), "2026-11")
    }

    func testDaySearchDecodeAndMerge() throws {
        let json = #"{"results":[],"kakera":[{"id":"K1","written_at":"2026-11-03T18:30:00+09:00","excerpt":"銀杏"},{"id":"K0","written_at":"2026-11-03T09:00:00+09:00","excerpt":"銀杏2"}],"places":[{"id":"P1","at":"2026-11-03T10:00:00+09:00","name":"公園"},{"id":"P2","at":"2026-11-20T12:00:00+09:00","name":"駅"}]}"#
        struct E: Decodable { let kakera: [KakeraHit]?; let places: [PlaceHit]? }
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let e = try d.decode(E.self, from: Data(json.utf8))
        let hits = DayHit.merge(kakera: e.kakera ?? [], places: e.places ?? [])
        XCTAssertEqual(hits.map(\.id), ["b-P2", "k-K1", "b-P1", "k-K0"])
        XCTAssertEqual(hits[1].day, "2026-11-03")
        XCTAssertEqual(hits[1].time, "18:30")
        // かたち一覧の検索だけを返す古い形（kakera・places が無い）でも読める
        let old = try d.decode(E.self, from: Data(#"{"results":[]}"#.utf8))
        XCTAssertTrue(DayHit.merge(kakera: old.kakera ?? [], places: old.places ?? []).isEmpty)
        // mood は Web から返ってくるが読まない（気分の表示は外した）
        let days = try d.decode([DaySummaryRow].self, from: Data(#"[{"date":"2026-11-25","kakera":0,"places":0,"mood":"疲"},{"date":"2026-11-26","kakera":1,"places":0,"mood":null}]"#.utf8))
        XCTAssertFalse(days[0].written)
        XCTAssertTrue(days[1].written)
    }

    func testPhotoRefs() {
        let r = DayPage.photoRefs(dayRefs: ["a", "b", "c"], hidden: ["b"], added: ["x", "a", "x", "y"])
        XCTAssertEqual(r.own, ["a", "c"])
        // その日に撮ったもの（外したものも含む）は足した側に出さない。重なりは1回
        XCTAssertEqual(r.added, ["x", "y"])
    }

    func testShownAtKeepsTimeOfDay() {
        let taken = date("2026-11-20T17:42:31+09:00")
        XCTAssertEqual(DayPage.shownAt(taken: taken, on: "2026-11-27"), date("2026-11-27T17:42:31+09:00"))
        XCTAssertEqual(JST.shortDate(taken), "11/20")
    }

    func testDefaultEntryDate() {
        let now = date("2026-11-28T15:42:10+09:00")
        // 今日は今
        XCTAssertEqual(DayPage.defaultEntryDate(day: "2026-11-28", items: [], now: now), now)
        // 過去の日で項目が無ければ 12:00
        XCTAssertEqual(DayPage.defaultEntryDate(day: "2026-11-27", items: [], now: now), date("2026-11-27T12:00:00+09:00"))
        // 過去の日は最後の項目（種類を問わず）の1分後
        let items = DayPage.merge(kakera: [kakera("K", "2026-11-27T09:00:00+09:00")], basho: [basho("B", "2026-11-27T19:30:00+09:00")])
        XCTAssertEqual(DayPage.defaultEntryDate(day: "2026-11-27", items: items, now: now), date("2026-11-27T19:31:00+09:00"))
        // 23:59 の後でも日を越えない
        let late = DayPage.merge(kakera: [kakera("K", "2026-11-27T23:59:30+09:00")], basho: [])
        XCTAssertEqual(JST.dayKey(DayPage.defaultEntryDate(day: "2026-11-27", items: late, now: now)), "2026-11-27")
    }

    func testEntryRange() {
        let now = date("2026-11-28T15:42:00+09:00")
        let today = DayPage.entryRange(day: "2026-11-28", now: now)
        XCTAssertEqual(today.lowerBound, date("2026-11-28T00:00:00+09:00"))
        XCTAssertEqual(today.upperBound, now)
        let past = DayPage.entryRange(day: "2026-11-27", now: now)
        XCTAssertEqual(past.upperBound, date("2026-11-27T23:59:00+09:00"))
    }

    func testDecodePlaceAsWebSendsIt() throws {
        let json = #"{"places":[{"id":"01JD0000000000000000000000","at":"2026-11-27T12:00:00+09:00","name":"駅","lat":35.5,"lng":139.25,"source":"manual","created_at":"x","updated_at":"y"},{"id":"01JD0000000000000000000001","at":"2026-11-27T13:00:00+09:00","name":"家","lat":null,"lng":null,"source":"visit","created_at":"x","updated_at":"y"}]}"#
        struct Envelope: Decodable { let places: [Basho] }
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let places = try d.decode(Envelope.self, from: Data(json.utf8)).places
        XCTAssertEqual(places.map(\.name), ["駅", "家"])
        XCTAssertEqual(places[0].lat, 35.5)
        XCTAssertNil(places[1].lng)
        XCTAssertEqual(places[1].createdAt, "x")
    }
}
