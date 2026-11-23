import CoreLocation
import Photos
import SwiftUI

/// 行った場所: その日の写真の位置情報を、端末の中で地名（市区町村＋あれば施設名）にまとめる。
/// **サーバーへは送らない**（位置も地名も港に入れない）。地名にするのは CLGeocoder（Apple の逆ジオコーディング）
struct Place: Identifiable, Hashable {
    /// 「かけらにした」印の鍵にも使う（日付＋地名）
    let id: String
    let name: String
    /// その場所で撮った最初の一枚の時刻
    let firstAt: Date
    let lastAt: Date
    let photoCount: Int

    var markKey: String { "place|\(id)" }
}

@MainActor
@Observable
final class PlaceMaterials {
    private(set) var places: [Place] = []
    private(set) var loading = false
    /// 位置情報のある写真があったか（無ければ区画を出さない）
    private(set) var hasLocatedPhotos = false
    private(set) var failed = false

    private var token = UUID()
    /// 地名の控え（緯度経度を約100mで丸めた鍵）。アプリを閉じると消える
    private static var cache: [String: String] = [:]

    /// 一続きの場所とみなす距離（これより離れたら別の場所）
    private static let clusterMeters: CLLocationDistance = 800
    /// 地名を引く上限（CLGeocoder は短い間に多く引くと断られる）
    private static let maxLookups = 12

    func load(day: String, assets: [PHAsset]) {
        let t = UUID()
        token = t
        let located = assets.compactMap { a -> (Date, CLLocation)? in
            guard let loc = a.location, let d = a.creationDate, CLLocationCoordinate2DIsValid(loc.coordinate),
                  !(loc.coordinate.latitude == 0 && loc.coordinate.longitude == 0) else { return nil }
            return (d, loc)
        }.sorted { $0.0 < $1.0 }
        hasLocatedPhotos = !located.isEmpty
        failed = false
        guard !located.isEmpty else {
            places = []
            loading = false
            return
        }

        // 時刻順に、前の塊の最初の地点から離れたら次の塊
        var clusters: [(anchor: CLLocation, first: Date, last: Date, count: Int)] = []
        for (d, loc) in located {
            if let last = clusters.last, last.anchor.distance(from: loc) <= Self.clusterMeters {
                clusters[clusters.count - 1].last = d
                clusters[clusters.count - 1].count += 1
            } else {
                clusters.append((loc, d, d, 1))
            }
        }
        clusters = Array(clusters.prefix(Self.maxLookups))
        loading = true
        Task {
            var out: [Place] = []
            var anyFailed = false
            for c in clusters {
                guard token == t else { return }
                guard let name = await Self.name(for: c.anchor) else { anyFailed = true; continue }
                // 続けて同じ地名なら一つにまとめる
                if let prev = out.last, prev.name == name {
                    out[out.count - 1] = Place(id: prev.id, name: name, firstAt: prev.firstAt, lastAt: c.last, photoCount: prev.photoCount + c.count)
                } else {
                    out.append(Place(id: "\(day)|\(name)", name: name, firstAt: c.first, lastAt: c.last, photoCount: c.count))
                }
            }
            guard token == t else { return }
            // 同じ地名に戻ってきたときは id を分ける（印が混ざらないように）
            var seen: [String: Int] = [:]
            places = out.map { p in
                let n = (seen[p.id] ?? 0) + 1
                seen[p.id] = n
                return n == 1 ? p : Place(id: "\(p.id)#\(n)", name: p.name, firstAt: p.firstAt, lastAt: p.lastAt, photoCount: p.photoCount)
            }
            failed = anyFailed && places.isEmpty
            loading = false
        }
    }

    private static func cacheKey(_ loc: CLLocation) -> String {
        String(format: "%.3f,%.3f", loc.coordinate.latitude, loc.coordinate.longitude)
    }

    /// 市区町村＋あれば施設名（例「渋谷区・代々木公園」）
    private static func name(for loc: CLLocation) async -> String? {
        let key = cacheKey(loc)
        if let hit = cache[key] { return hit }
        let marks = try? await CLGeocoder().reverseGeocodeLocation(loc, preferredLocale: Locale(identifier: "ja_JP"))
        guard let p = marks?.first else { return nil }
        let city = p.locality ?? p.subAdministrativeArea ?? p.administrativeArea
        // 住所（番地）ではなく施設の名前だけを拾う
        let facility = p.areasOfInterest?.first ?? p.name.flatMap { n in
            n.rangeOfCharacter(from: .decimalDigits) == nil && n != city && n != p.thoroughfare && n != p.subLocality ? n : nil
        }
        let parts = [city, facility].compactMap { $0 }.filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        let name = parts.joined(separator: "・")
        cache[key] = name
        return name
    }
}

/// 行った場所の付箋
struct PlacesNote: View {
    let places: PlaceMaterials
    let used: UsedMarks
    let onMake: (Place) -> Void

    var body: some View {
        if places.hasLocatedPhotos {
            VStack(alignment: .leading, spacing: 0) {
                NoteHeading(title: "行った場所", count: places.places.count, note: "写真の位置から・端末の中だけ")
                if places.loading && places.places.isEmpty {
                    HStack(spacing: 6) { ProgressView().controlSize(.small); Text("地名を調べています").font(Theme.gothic(13)).foregroundStyle(Theme.muted) }
                } else if places.places.isEmpty {
                    Text(places.failed ? "地名を調べられませんでした（通信を確かめてください）" : "地名が分かりませんでした")
                        .font(Theme.gothic(13)).foregroundStyle(Theme.muted)
                }
                ForEach(places.places) { p in
                    Button { onMake(p) } label: {
                        MaterialLine(time: p.firstAt, title: p.name,
                                     sub: p.photoCount > 1 ? "写真 \(p.photoCount) 枚" : nil,
                                     used: used.materials.contains(p.markKey))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("place-\(p.name)")
                    .ruledRow(last: p.id == places.places.last?.id)
                }
            }
        }
    }
}
