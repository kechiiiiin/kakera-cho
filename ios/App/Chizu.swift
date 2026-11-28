import MapKit
import SwiftUI

// 1日のページの地図（かけら帳1日のページ設計・段階4・軌跡は「追加: 移動の軌跡」）: 座標のある行（場所・位置つきの予定・位置つきの写真。外した行は除く）を
// 一覧の上から 1, 2, 3… と番号を振ってピンにし、時刻順に線で結ぶ。軌跡（Web の GET /api/track）がある日は、軌跡を太い朱の線で描き
// ピン同士の直線は描かない（ピンと番号は残す）。Web には対応する画面が無い（地図は iPhone だけ）。
// 場所の座標は Web の place（src/lib/kakera/day-db.ts の lat / lng）、予定・写真の座標は端末から読む。

/// 地図のピン（一覧の行と同じ番号）
struct ChizuPin: Identifiable, Hashable {
    let number: Int
    /// 一覧の行の id（TimelineItem.id）
    let itemID: String
    let lat: Double
    let lng: Double
    let title: String

    var id: String { itemID }
    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lng) }
}

enum Chizu {
    /// 一覧の並び（時刻順）のまま、座標のある行に 1 から番号を振る。
    /// 予定は位置が無くても場所の文字をジオコーディングした座標（geocoded・場所の文字 → 座標）があれば使う
    static func pins(_ items: [TimelineItem], geocoded: [String: GeoPoint] = [:]) -> [ChizuPin] {
        var out: [ChizuPin] = []
        for item in items {
            guard let (p, title) = point(item, geocoded: geocoded) else { continue }
            out.append(ChizuPin(number: out.count + 1, itemID: item.id, lat: p.lat, lng: p.lng, title: title))
        }
        return out
    }

    private static func point(_ item: TimelineItem, geocoded: [String: GeoPoint]) -> (GeoPoint, String)? {
        switch item {
        case .basho(let b):
            guard let lat = b.lat, let lng = b.lng else { return nil }
            return (GeoPoint(lat: lat, lng: lng), b.name)
        case .photo(let p):
            guard let l = p.location else { return nil }
            return (GeoPoint(l.coordinate), "写真 \(JST.time(p.shownAt))")
        case .yotei(let y):
            if let l = y.yotei.location { return (GeoPoint(l.coordinate), y.yotei.title) }
            if let name = y.yotei.locationName, let g = geocoded[name] { return (g, y.yotei.title) }
            return nil
        case .kakera:
            return nil
        }
    }

    /// Google マップの経由地の上限（API の決まり）
    static let maxWaypoints = 9
    /// 移動の手段（電車と徒歩の暮らしに合わせて transit。Google マップ側で変えられる）
    static let travelMode = "transit"

    /// 「Google マップでルート」の URL。ピンが2つ未満なら nil。経由地は9まで（多ければ均等に間引く）
    static func googleMapsURL(_ pins: [ChizuPin]) -> URL? {
        guard pins.count >= 2, let first = pins.first, let last = pins.last else { return nil }
        let middle = Array(pins.dropFirst().dropLast())
        var c = URLComponents(string: "https://www.google.com/maps/dir/")!
        c.queryItems = [
            URLQueryItem(name: "api", value: "1"),
            URLQueryItem(name: "origin", value: latLng(first)),
            URLQueryItem(name: "destination", value: latLng(last)),
            URLQueryItem(name: "waypoints", value: thin(middle, to: maxWaypoints).map(latLng).joined(separator: "|")),
            URLQueryItem(name: "travelmode", value: travelMode),
        ]
        return c.url
    }

    /// 均等に間引く（先頭と末尾は残す）
    static func thin<T>(_ list: [T], to n: Int) -> [T] {
        guard list.count > n, n > 0 else { return list }
        if n == 1 { return [list[list.count / 2]] }
        return (0..<n).map { i in list[Int((Double(i) * Double(list.count - 1) / Double(n - 1)).rounded())] }
    }

    private static func latLng(_ p: ChizuPin) -> String { String(format: "%.6f,%.6f", p.lat, p.lng) }
}

/// 座標（緯度・経度）。ジオコーディングの控えにも使う
struct GeoPoint: Hashable {
    let lat: Double
    let lng: Double

    init(lat: Double, lng: Double) { self.lat = lat; self.lng = lng }
    init(_ c: CLLocationCoordinate2D) { self.init(lat: c.latitude, lng: c.longitude) }
}

/// 予定の場所の文字 → 座標の控え（メモリだけ・取れなかったものも覚えて引き直さない）
@MainActor
enum YoteiGeocodeCache {
    private static var cache: [String: GeoPoint?] = [:]

    static func known(_ names: [String]) -> [String: GeoPoint] {
        var out: [String: GeoPoint] = [:]
        for n in names { if let g = cache[n] ?? nil { out[n] = g } }
        return out
    }

    /// まだ引いていない名前だけ引く
    static func lookup(_ names: [String]) async -> [String: GeoPoint] {
        for n in Set(names) where cache[n] == nil {
            let c = await BashoGeocoder.coordinate(for: n)
            cache[n] = .some(c.map { GeoPoint(lat: $0.lat, lng: $0.lng) })
        }
        return known(names)
    }
}

/// 番号の丸（一覧の行と地図のピンで同じ見た目）
struct PinNumber: View {
    let number: Int
    var size: CGFloat = 16

    var body: some View {
        Text("\(number)")
            .font(Theme.mono(size * 0.6, weight: .semibold))
            .foregroundStyle(Theme.ink)
            .frame(width: size, height: size)
            .background(Circle().fill(Theme.paper))
            .overlay(Circle().strokeBorder(Theme.ink, lineWidth: 1))
    }
}

/// 「きょうの地図」。ピンも軌跡も無い日は一行だけ。押すと全画面の地図（指で動かせる）
struct ChizuSection: View {
    let pins: [ChizuPin]
    /// その日の軌跡の点（時刻順・Web の GET /api/track）。2点以上で線を描く
    var track: [TrackPoint] = []
    /// 港の歩数（日付の下の一行と同じ出どころ・MinatoMaterials.daySummary）
    var steps: String? = nil
    @State private var position: MapCameraPosition = .automatic
    @State private var full = false

    /// 軌跡がある日は軌跡とピンの全部が入る範囲。無い日は今のまま:
    /// ピンが1つだけの日は寄りすぎるので約2km四方、2つ以上は全部が入る範囲（自動）
    static func camera(_ pins: [ChizuPin], track: [TrackPoint] = []) -> MapCameraPosition {
        if track.count >= 2, let r = Kiseki.region(track.map(\.coordinate) + pins.map(\.coordinate)) { return .region(r) }
        guard pins.count == 1, let p = pins.first else { return .automatic }
        return .region(MKCoordinateRegion(center: p.coordinate, latitudinalMeters: 2000, longitudinalMeters: 2000))
    }

    private var hasTrack: Bool { track.count >= 2 }
    private var summary: String? { ChizuContent.summary(track: track, steps: steps) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHead(title: "きょうの地図", count: pins.count)
                .padding(.bottom, -10)
            if pins.isEmpty && !hasTrack {
                Text("この日は位置の分かる記録がありません").font(Theme.gothic(12)).foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("chizuEmpty")
            } else {
                // 動かさない地図（ページを縦に送る指が地図を引きずらないように）。押すと全画面で動かせる地図
                Map(position: $position, interactionModes: []) { ChizuContent.content(pins: pins, track: track) }
                .mapStyle(.standard(pointsOfInterest: .excludingAll))
                // 線（MapPolyline）は中身が変わっても描き直されないことがある（日を移ると前の日の線が残った）ので、
                // ピンか軌跡が変わったら地図ごと作り直す
                .id(ChizuContent.identity(pins: pins, track: track))
                .frame(height: 260)
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                .overlay {
                    // 地図の上の透明な面で押したことを受ける（地図そのものは押しても何もしない）
                    Color.clear.contentShape(Rectangle()).onTapGesture { full = true }.accessibilityHidden(true)
                }
                .accessibilityIdentifier("chizu")
                .accessibilityValue(pins.map { String($0.number) }.joined(separator: ","))
                .accessibilityHint(hasTrack ? "軌跡 \(track.count) 点" : "")
                .accessibilityAction(named: "全画面で見る") { full = true }
                if let summary {
                    Text(summary).pageSub()
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .accessibilityIdentifier("chizuSummary")
                }
                if let url = Chizu.googleMapsURL(pins) {
                    Link("Google マップでルート", destination: url)
                        .buttonStyle(LinkButtonStyle(color: Theme.accent))
                        .accessibilityIdentifier("googleMapsRoute")
                        .accessibilityValue(url.absoluteString)
                }
            }
        }
        .onAppear { position = Self.camera(pins, track: track) }
        .onChange(of: pins) { _, p in position = Self.camera(p, track: track) }
        .onChange(of: track) { _, t in position = Self.camera(pins, track: t) }
        .fullScreenCover(isPresented: $full) {
            ChizuFullScreen(pins: pins, track: track, summary: summary, camera: Self.camera(pins, track: track))
        }
    }
}
