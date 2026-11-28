import XCTest
@testable import Kakera

/// 1日のページ（かけら帳1日のページ設計・段階1）: きょうの一覧の並び・入力欄の時刻の初期値と範囲・API の形の読み。
/// Web の src/lib/kakera/day-input.ts（気分の5つ）・day-db.ts（Place の形）と対になる。
final class DayPageTests: XCTestCase {
    private func kakera(_ id: String, _ at: String, katachi: String? = nil) -> Kakera {
        Kakera(id: id, body: "本文 \(id)", writtenAt: at, katachiId: katachi, updatedAt: at)
    }

    private func basho(_ id: String, _ at: String, lat: Double? = nil) -> Basho {
        Basho(id: id, at: at, name: "場所 \(id)", lat: lat, lng: lat, source: "manual", createdAt: at, updatedAt: at)
    }

    private func date(_ s: String) -> Date { JST.parse(s)! }

    func testKibunSameAsWeb() {
        XCTAssertEqual(Kibun.allCases.map(\.rawValue), ["嬉", "楽", "穏", "疲", "哀"])
    }

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
