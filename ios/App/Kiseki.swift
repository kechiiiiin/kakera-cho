import CoreLocation
import CryptoKit
import MapKit
import SwiftUI

// 移動の軌跡（かけら帳1日のページ設計「追加: 移動の軌跡」・2026-11-28）: 大きな位置の変化（significant location change）と
// 訪問（CLVisit）の点を、Web の POST /api/track（src/pages/api/track.ts・src/lib/kakera/track.ts）にまとめて送る。
// 送れなければ端末の UserDefaults に溜めて、次に前に出たとき送る（訪問 Houmon.swift と同じ作り）。
// 二重にしない: 点の id（ULID）を時刻と位置から決めて作る。同じ点が二度届いても同じ id になり、サーバは同じ id を黙って飛ばす。
// 控え（kakera-data）と書き出しには入らない（Web 側で載せない）。

/// 軌跡の点（D1 の track_point・Web の TrackPoint と同じ形。created_at は読まない）
struct TrackPoint: Codable, Hashable {
    let id: String
    /// ISO8601（+09:00 付き）
    let at: String
    let lat: Double
    let lng: Double
    /// 水平の精度（メートル）。取れなければ nil
    let accuracy: Double?
    /// slc（大きな位置の変化）| visit（訪問の到着点）
    let source: String

    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lng) }
}

enum Kiseki {
    /// 1回の POST で送る点の上限（Web の TRACK_BATCH_MAX と同じ）
    static let batchMax = 500
    /// 端末に溜めておく点の上限（古いものから捨てる。大きな位置の変化は1日に数十点なので、ひと月以上は持てる）
    static let pendingMax = 20000
    /// これより粗い点は捨てる（基地局だけの位置は数kmずれる）
    static let worstAccuracy: CLLocationAccuracy = 5000

    /// 鍵から決まる ULID（時刻の部分は at の秒・残りは鍵のハッシュ）。同じ点は何度作っても同じ id
    static func pointID(at: Date, key: String) -> String {
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var ms = UInt64(max(0, (at.timeIntervalSince1970).rounded(.down) * 1000))
        var time = [Character](repeating: "0", count: 10)
        for i in stride(from: 9, through: 0, by: -1) {
            time[i] = alphabet[Int(ms % 32)]
            ms /= 32
        }
        let digest = SHA256.hash(data: Data(key.utf8))
        return String(time + digest.prefix(16).map { alphabet[Int($0 % 32)] })
    }

    /// 大きな位置の変化の点。鍵は秒＋位置（小数5桁・約1m）
    static func slcPoint(_ l: CLLocation) -> TrackPoint? {
        guard valid(l.coordinate), l.horizontalAccuracy >= 0, l.horizontalAccuracy <= worstAccuracy,
              l.timestamp <= Date().addingTimeInterval(60) else { return nil }
        let sec = Int(l.timestamp.timeIntervalSince1970.rounded(.down))
        let key = String(format: "slc|%d|%.5f|%.5f", sec, l.coordinate.latitude, l.coordinate.longitude)
        return TrackPoint(id: pointID(at: l.timestamp, key: key), at: JST.writtenAt(l.timestamp),
                          lat: l.coordinate.latitude, lng: l.coordinate.longitude, accuracy: l.horizontalAccuracy, source: "slc")
    }

    /// 訪問の到着点。鍵は訪問と同じ（到着の分＋位置 小数3桁）なので、同じ訪問が数秒ずれて届いても同じ id
    static func visitPoint(arrival: Date, coordinate: CLLocationCoordinate2D, accuracy: CLLocationAccuracy? = nil) -> TrackPoint? {
        guard valid(coordinate), arrival != .distantPast, arrival <= Date().addingTimeInterval(60) else { return nil }
        let minute = Date(timeIntervalSince1970: (arrival.timeIntervalSince1970 / 60).rounded(.down) * 60)
        let key = "visit|" + Houmon.key(arrival: arrival, coordinate: coordinate)
        return TrackPoint(id: pointID(at: minute, key: key), at: JST.writtenAt(arrival),
                          lat: coordinate.latitude, lng: coordinate.longitude,
                          accuracy: accuracy.flatMap { $0 >= 0 ? $0 : nil }, source: "visit")
    }

    private static func valid(_ c: CLLocationCoordinate2D) -> Bool {
        CLLocationCoordinate2DIsValid(c) && !(c.latitude == 0 && c.longitude == 0)
    }

    /// 溜まりに足す（同じ id は足さない・上限を超えたら古いものから捨てる）
    static func merged(_ pending: [TrackPoint], adding new: [TrackPoint]) -> [TrackPoint] {
        var seen = Set(pending.map(\.id))
        var out = pending
        for p in new where seen.insert(p.id).inserted { out.append(p) }
        return Array(out.suffix(pendingMax))
    }

    /// 送る区切り（batchMax ずつ）
    static func batches(_ list: [TrackPoint]) -> [[TrackPoint]] {
        stride(from: 0, to: list.count, by: batchMax).map { Array(list[$0..<min($0 + batchMax, list.count)]) }
    }

    /// 時刻順に結んだ線の長さ（メートル）
    static func distanceMeters(_ track: [TrackPoint]) -> Double {
        zip(track, track.dropFirst()).reduce(0) { sum, pair in
            sum + CLLocation(latitude: pair.0.lat, longitude: pair.0.lng).distance(from: CLLocation(latitude: pair.1.lat, longitude: pair.1.lng))
        }
    }

    /// 「12.3 km」（小数1桁）
    static func distanceLabel(_ meters: Double) -> String { String(format: "%.1f km", meters / 1000) }

    /// 全部の座標が入る範囲（少し余白を付ける）。狭すぎる日は約2km四方。座標が無ければ nil
    static func region(_ coords: [CLLocationCoordinate2D]) -> MKCoordinateRegion? {
        guard let first = coords.first else { return nil }
        var minLat = first.latitude, maxLat = first.latitude, minLng = first.longitude, maxLng = first.longitude
        for c in coords {
            minLat = min(minLat, c.latitude); maxLat = max(maxLat, c.latitude)
            minLng = min(minLng, c.longitude); maxLng = max(maxLng, c.longitude)
        }
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2)
        let minSpan = 0.018 // 約2km
        return MKCoordinateRegion(center: center, span: MKCoordinateSpan(latitudeDelta: max((maxLat - minLat) * 1.3, minSpan),
                                                                         longitudeDelta: max((maxLng - minLng) * 1.3, minSpan)))
    }
}

extension Notification.Name {
    /// 軌跡の点を送り終えた。1日のページが軌跡を読み直す
    static let kakeraTrackChanged = Notification.Name("kakeraTrackChanged")
}

/// 軌跡の溜まりと送り（VisitRecorder が点を渡す。設定のスイッチは訪問と一つ）
@MainActor
enum KisekiQueue {
    private static let pendingKey = "kakera.track.pending"
    private static var flushing = false

    static var pending: [TrackPoint] {
        get {
            guard let d = UserDefaults.standard.data(forKey: pendingKey) else { return [] }
            return (try? JSONDecoder().decode([TrackPoint].self, from: d)) ?? []
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: pendingKey) }
    }

    /// 点を受けて溜め、すぐ送ってみる（通信できなければ溜めたまま）
    static func receive(_ points: [TrackPoint]) async {
        guard !points.isEmpty else { return }
        pending = Kiseki.merged(pending, adding: points)
        await flush()
    }

    /// 溜まっている点を batchMax ずつ送る。送れた区切りを外す。400（形が違う）の区切りは溜め続けない。通信できなければ残す
    static func flush() async {
        guard !flushing, !pending.isEmpty, API.shared.isConfigured(.kakera) else { return }
        flushing = true
        defer { flushing = false }
        var sentAny = false
        for batch in Kiseki.batches(pending) {
            let ids = Set(batch.map(\.id))
            do {
                _ = try await API.shared.sendTrack(batch)
                sentAny = true
            } catch APIError.http(400, _) {
                // 形が違う（未来の時刻など）。捨てて次へ
            } catch {
                break // 通信できない・認証が通らない: 残して次の機会に
            }
            pending.removeAll { ids.contains($0.id) }
        }
        if sentAny { NotificationCenter.default.post(name: .kakeraTrackChanged, object: nil) }
    }

    #if DEBUG
    static func reset() { UserDefaults.standard.removeObject(forKey: pendingKey) }

    /// 検査だけ: 公共の場所（駅・公園）を順にたどる擬似の軌跡。名前 → 経由する座標
    static let fakeRoutes: [String: [(Double, Double)]] = [
        // 福岡市内: 西新駅 → 地行（PayPayドームの近く）→ 大濠公園 → 天神駅
        "fukuoka": [(33.5836, 130.3594), (33.5935, 130.3640), (33.5954, 130.3622), (33.5870, 130.3770),
                    (33.5860, 130.3765), (33.5890, 130.3900), (33.5911, 130.3989)],
        // 福岡〜北九州: 博多駅 → 香椎駅 → 古賀駅 → 赤間駅 → 折尾駅 → 黒崎駅 → 小倉駅
        "kitakyushu": [(33.5897, 130.4207), (33.6590, 130.4440), (33.7270, 130.4710), (33.8070, 130.5690),
                       (33.8640, 130.7090), (33.8670, 130.7650), (33.8868, 130.8826)],
        // 東京: 東京駅 → 秋葉原駅 → 上野駅 → 上野公園（見た目の刷新 C 丸の実画面・写真や予定と同じ日に重ねる）
        "tokyo": [(35.6812, 139.7671), (35.6984, 139.7731), (35.7138, 139.7773), (35.7148, 139.7731)],
    ]

    /// 経由地のあいだを直線で割って count 点にする（時刻は start から minutes 分かけて等間隔）
    static func fakeTrack(_ route: [(Double, Double)], count: Int, start: Date, minutes: Double) -> [TrackPoint] {
        guard route.count >= 2, count >= 2 else { return [] }
        return (0..<count).compactMap { i in
            let t = Double(i) / Double(count - 1)
            let x = t * Double(route.count - 1)
            let j = min(Int(x), route.count - 2), f = x - Double(j)
            let lat = route[j].0 + (route[j + 1].0 - route[j].0) * f
            let lng = route[j].1 + (route[j + 1].1 - route[j].1) * f
            let at = start.addingTimeInterval(t * minutes * 60)
            return Kiseki.slcPoint(CLLocation(coordinate: .init(latitude: lat, longitude: lng), altitude: 0,
                                              horizontalAccuracy: 150, verticalAccuracy: -1, timestamp: at))
        }
    }

    /// 起動引数 -kakeraFakeTrack "名前,点の数,開始(+09:00),分"（繰り返し可）。-kakeraResetTrack で溜まりを空にして始める
    static func applyLaunchArguments() async {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-kakeraResetTrack") { reset() }
        var points: [TrackPoint] = []
        for (i, a) in args.enumerated() where a == "-kakeraFakeTrack" && i + 1 < args.count {
            let p = args[i + 1].split(separator: ",").map(String.init)
            guard p.count == 4, let route = fakeRoutes[p[0]], let n = Int(p[1]), let start = JST.parse(p[2]),
                  let minutes = Double(p[3]) else { continue }
            points += fakeTrack(route, count: n, start: start, minutes: minutes)
        }
        await receive(points)
    }
    #endif
}

// MARK: - 地図の中身（1日のページの地図と全画面の地図で同じもの）

@MainActor
enum ChizuContent {
    /// 軌跡がある日（2点以上）は軌跡を太い朱の線で描き、ピン同士の直線は描かない。無い日はピン同士を細い墨の線で結ぶ（今のまま）
    @MapContentBuilder
    static func content(pins: [ChizuPin], track: [TrackPoint], pinSize: CGFloat = 22) -> some MapContent {
        if track.count >= 2 {
            MapPolyline(coordinates: track.map(\.coordinate))
                .stroke(Theme.accent, style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round))
        } else if pins.count >= 2 {
            MapPolyline(coordinates: pins.map(\.coordinate))
                .stroke(Theme.ink.opacity(0.7), lineWidth: 2)
        }
        ForEach(pins) { p in
            Annotation(p.title, coordinate: p.coordinate, anchor: .center) {
                PinNumber(number: p.number, size: pinSize)
                    .accessibilityIdentifier("pin-\(p.number)")
            }
            .annotationTitles(.hidden)
        }
    }

    /// 地図を作り直す鍵（ピンと軌跡の中身が変わったら変わる）
    static func identity(pins: [ChizuPin], track: [TrackPoint]) -> String {
        pins.map { "\($0.itemID)@\($0.lat),\($0.lng)" }.joined(separator: "|") + "#" + track.map(\.id).joined(separator: ",")
    }

    /// 地図の下の一行: 軌跡の移動距離と港の歩数（どちらかが無ければその分だけ）。軌跡が無い日は出さない（今のまま）
    static func summary(track: [TrackPoint], steps: String?) -> String? {
        guard track.count >= 2 else { return nil }
        return (["移動 " + Kiseki.distanceLabel(Kiseki.distanceMeters(track))] + [steps].compactMap { $0 }).joined(separator: "・")
    }
}

/// 全画面の地図（指で動かせる・拡大できる・閉じられる）
struct ChizuFullScreen: View {
    let pins: [ChizuPin]
    let track: [TrackPoint]
    let summary: String?
    @State private var position: MapCameraPosition
    @Environment(\.dismiss) private var dismiss

    init(pins: [ChizuPin], track: [TrackPoint], summary: String?, camera: MapCameraPosition) {
        self.pins = pins
        self.track = track
        self.summary = summary
        _position = State(initialValue: camera)
    }

    var body: some View {
        Map(position: $position) { ChizuContent.content(pins: pins, track: track, pinSize: 26) }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .ignoresSafeArea(edges: .bottom)
            .accessibilityIdentifier("chizuFull")
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    HStack {
                        Text("きょうの地図").font(Theme.gothic(15, weight: .semibold)).foregroundStyle(Theme.ink)
                        Spacer()
                        Button("閉じる") { dismiss() }
                            .buttonStyle(LinkButtonStyle(color: Theme.accent))
                            .accessibilityIdentifier("chizuClose")
                    }
                    .padding(.horizontal, 18).padding(.vertical, 10)
                    if let summary {
                        Text(summary).pageSub().frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 18).padding(.bottom, 8)
                    }
                    Rule()
                }
                .background(Theme.paper.ignoresSafeArea(edges: .top))
            }
    }
}
