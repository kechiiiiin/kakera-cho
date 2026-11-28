import CoreLocation
import MapKit
import SwiftUI
import XCTest
@testable import Kakera

/// 移動の軌跡（かけら帳1日のページ設計「追加: 移動の軌跡」）: 点の id・溜まり・送る区切り・距離・地図の範囲・下の一行・API の形の読み。
/// Web の src/lib/kakera/track.ts（TRACK_BATCH_MAX・TrackPoint の形）と対になる。座標は公共の場所（駅）の近く。
@MainActor
final class KisekiTests: XCTestCase {
    private func date(_ s: String) -> Date { JST.parse(s)! }
    private let ulidPattern = "^[0-9A-HJKMNP-TV-Z]{26}$"

    private func loc(_ lat: Double, _ lng: Double, _ at: String, accuracy: Double = 100) -> CLLocation {
        CLLocation(coordinate: .init(latitude: lat, longitude: lng), altitude: 0, horizontalAccuracy: accuracy,
                   verticalAccuracy: -1, timestamp: date(at))
    }

    private func point(_ id: String, _ lat: Double, _ lng: Double) -> TrackPoint {
        TrackPoint(id: id, at: "2026-11-27T12:00:00+09:00", lat: lat, lng: lng, accuracy: nil, source: "slc")
    }

    func testBatchMaxSameAsWeb() {
        XCTAssertEqual(Kiseki.batchMax, 500)
    }

    func testSlcPointIDIsStableULID() throws {
        let p = try XCTUnwrap(Kiseki.slcPoint(loc(33.5897, 130.4207, "2026-11-27T08:15:42+09:00")))
        XCTAssertNotNil(p.id.range(of: ulidPattern, options: .regularExpression), "Web の isUlid を通る形")
        XCTAssertEqual(p.at, "2026-11-27T08:15:42+09:00")
        XCTAssertEqual(p.source, "slc")
        XCTAssertEqual(p.accuracy, 100)
        // 同じ点は同じ id、時刻か位置が違えば別
        XCTAssertEqual(p.id, Kiseki.slcPoint(loc(33.5897, 130.4207, "2026-11-27T08:15:42+09:00"))?.id)
        XCTAssertNotEqual(p.id, Kiseki.slcPoint(loc(33.5897, 130.4207, "2026-11-27T08:15:43+09:00"))?.id)
        XCTAssertNotEqual(p.id, Kiseki.slcPoint(loc(33.5907, 130.4207, "2026-11-27T08:15:42+09:00"))?.id)
        // 時刻の部分は at の秒（ULID の並びが時刻順になる）
        XCTAssertEqual(String(p.id.prefix(10)), String(ULID.make(date("2026-11-27T08:15:42+09:00")).prefix(10)))
    }

    func testSlcPointDropsBadLocations() {
        XCTAssertNil(Kiseki.slcPoint(loc(33.5, 130.4, "2026-11-27T08:00:00+09:00", accuracy: -1)), "精度が無い")
        XCTAssertNil(Kiseki.slcPoint(loc(33.5, 130.4, "2026-11-27T08:00:00+09:00", accuracy: 8000)), "粗すぎる")
        XCTAssertNil(Kiseki.slcPoint(loc(0, 0, "2026-11-27T08:00:00+09:00")), "0,0")
        XCTAssertNil(Kiseki.slcPoint(CLLocation(coordinate: .init(latitude: 33.5, longitude: 130.4), altitude: 0, horizontalAccuracy: 50,
                                                verticalAccuracy: -1, timestamp: Date().addingTimeInterval(3600))), "未来")
    }

    func testVisitPointSameIDForSameVisit() throws {
        let c = CLLocationCoordinate2D(latitude: 33.88681, longitude: 130.88262)
        let a = try XCTUnwrap(Kiseki.visitPoint(arrival: date("2026-11-27T16:20:05+09:00"), coordinate: c))
        let b = try XCTUnwrap(Kiseki.visitPoint(arrival: date("2026-11-27T16:20:40+09:00"), coordinate: .init(latitude: 33.88683, longitude: 130.88264)))
        XCTAssertEqual(a.id, b.id, "同じ訪問が数秒ずれて届いても同じ id")
        XCTAssertEqual(a.source, "visit")
        XCTAssertNotNil(a.id.range(of: ulidPattern, options: .regularExpression))
        // 訪問（place）の id とは別（表が違うので重ならなくてよいが、念のため別の鍵）
        XCTAssertNotEqual(a.id, Houmon.visitID(arrival: date("2026-11-27T16:20:05+09:00"), coordinate: c))
    }

    func testMergedSkipsSameIDAndKeepsNewest() {
        let a = point("A", 33.5, 130.3), b = point("B", 33.6, 130.4)
        XCTAssertEqual(Kiseki.merged([a], adding: [a, b, b]).map(\.id), ["A", "B"])
        let many = (0..<(Kiseki.pendingMax + 3)).map { point("P\($0)", 33.5, 130.3) }
        let kept = Kiseki.merged([], adding: many)
        XCTAssertEqual(kept.count, Kiseki.pendingMax)
        XCTAssertEqual(kept.first?.id, "P3", "上限を超えたら古いものから捨てる")
    }

    func testBatchesSplitByMax() {
        let list = (0..<1201).map { point("P\($0)", 33.5, 130.3) }
        XCTAssertEqual(Kiseki.batches(list).map(\.count), [500, 500, 201])
        XCTAssertTrue(Kiseki.batches([]).isEmpty)
    }

    func testDistance() {
        // 博多駅 → 小倉駅（直線で約 54km: 緯度差 33.0km・経度差 42.8km）
        let d = Kiseki.distanceMeters([point("1", 33.5897, 130.4207), point("2", 33.8868, 130.8826)])
        XCTAssertEqual(d / 1000, 54.0, accuracy: 0.5)
        XCTAssertEqual(Kiseki.distanceMeters([point("1", 33.5, 130.3)]), 0)
        XCTAssertEqual(Kiseki.distanceLabel(12_345), "12.3 km")
        XCTAssertEqual(Kiseki.distanceLabel(0), "0.0 km")
    }

    func testRegionCoversAllWithMinimumSpan() throws {
        let coords = [CLLocationCoordinate2D(latitude: 33.5897, longitude: 130.4207), .init(latitude: 33.8868, longitude: 130.8826)]
        let r = try XCTUnwrap(Kiseki.region(coords))
        for c in coords {
            XCTAssertLessThanOrEqual(abs(c.latitude - r.center.latitude), r.span.latitudeDelta / 2)
            XCTAssertLessThanOrEqual(abs(c.longitude - r.center.longitude), r.span.longitudeDelta / 2)
        }
        let one = try XCTUnwrap(Kiseki.region([coords[0]]))
        XCTAssertEqual(one.span.latitudeDelta, 0.018, accuracy: 0.0001, "狭すぎる日は約2km四方")
        XCTAssertNil(Kiseki.region([]))
    }

    func testSummaryLine() {
        let track = [point("1", 33.5836, 130.3594), point("2", 33.5911, 130.3989)]
        let s = ChizuContent.summary(track: track, steps: "8,432歩")
        XCTAssertTrue(s?.hasPrefix("移動 ") == true && s?.hasSuffix(" km・8,432歩") == true, s ?? "")
        XCTAssertEqual(ChizuContent.summary(track: track, steps: nil)?.contains("歩"), false)
        XCTAssertNil(ChizuContent.summary(track: [track[0]], steps: "8,432歩"), "軌跡の無い日は今のまま（出さない）")
    }

    func testCameraUsesTrackWhenPresent() {
        let pin = ChizuPin(number: 1, itemID: "p1", lat: 33.5836, lng: 130.3594, title: "")
        let track = [point("1", 33.5897, 130.4207), point("2", 33.8868, 130.8826)]
        XCTAssertNotNil(ChizuSection.camera([pin], track: track).region, "軌跡がある日は軌跡とピンが入る範囲")
        XCTAssertEqual(ChizuSection.camera([pin], track: track).region?.span.latitudeDelta ?? 0, (33.8868 - 33.5836) * 1.3, accuracy: 0.0001)
        XCTAssertEqual(ChizuSection.camera([pin]).region?.center.latitude ?? 0, 33.5836, accuracy: 0.0001, "無い日は今のまま（1つなら2km四方）")
    }

    func testDecodeTrackAsWebSendsIt() throws {
        let json = #"{"points":[{"id":"01JD0000000000000000000000","at":"2026-11-27T08:00:00+09:00","lat":33.5897,"lng":130.4207,"accuracy":120,"source":"slc","created_at":"x"},{"id":"01JD0000000000000000000001","at":"2026-11-27T09:00:00+09:00","lat":33.8868,"lng":130.8826,"accuracy":null,"source":"visit","created_at":"x"}]}"#
        struct Envelope: Decodable { let points: [TrackPoint] }
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let points = try d.decode(Envelope.self, from: Data(json.utf8)).points
        XCTAssertEqual(points.map(\.source), ["slc", "visit"])
        XCTAssertEqual(points[0].accuracy, 120)
        XCTAssertNil(points[1].accuracy)
    }

    #if DEBUG
    func testFakeTrackFollowsRouteInOrder() {
        let route = KisekiQueue.fakeRoutes["fukuoka"]!
        let pts = KisekiQueue.fakeTrack(route, count: 40, start: date("2026-11-26T10:00:00+09:00"), minutes: 120)
        XCTAssertEqual(pts.count, 40)
        XCTAssertEqual(pts.first?.lat ?? 0, route.first!.0, accuracy: 1e-9)
        XCTAssertEqual(pts.last?.lng ?? 0, route.last!.1, accuracy: 1e-9)
        XCTAssertEqual(pts.first?.at, "2026-11-26T10:00:00+09:00")
        XCTAssertEqual(pts.last?.at, "2026-11-26T12:00:00+09:00")
        XCTAssertEqual(Set(pts.map(\.id)).count, 40)
    }
    #endif
}
