import Foundation
import SwiftUI
import UIKit

/// JST 固定の日付と時刻。かけらの written_at は必ず +09:00 付き（サーバの約束・控えのファイル名がずれないように）
enum JST {
    static let timeZone = TimeZone(identifier: "Asia/Tokyo")!

    static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        c.locale = Locale(identifier: "ja_JP")
        return c
    }

    private static func formatter(_ format: String, locale: String = "en_US_POSIX") -> DateFormatter {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: locale)
        f.timeZone = timeZone
        f.dateFormat = format
        return f
    }

    private static let dayFormatter = formatter("yyyy-MM-dd")
    private static let writtenFormatter = formatter("yyyy-MM-dd'T'HH:mm:ssxxx")
    private static let timeFormatter = formatter("HH:mm")
    private static let titleFormatter = formatter("M月d日（E）", locale: "ja_JP")
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let isoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// 'YYYY-MM-DD'（JST）
    static func dayKey(_ d: Date) -> String { dayFormatter.string(from: d) }
    static var todayKey: String { dayKey(Date()) }

    /// その日の JST 0:00 と翌日 0:00
    static func dayRange(_ key: String) -> (start: Date, end: Date)? {
        guard let start = dayFormatter.date(from: key), let end = calendar.date(byAdding: .day, value: 1, to: start) else { return nil }
        return (start, end)
    }

    static func shift(_ key: String, days: Int) -> String {
        guard let r = dayRange(key), let d = calendar.date(byAdding: .day, value: days, to: r.start) else { return key }
        return dayKey(d)
    }

    /// written_at の形（+09:00 付き・秒まで）
    static func writtenAt(_ d: Date) -> String { writtenFormatter.string(from: d) }

    /// +09:00 付きも、便りの UTC（ミリ秒つき Z）も読む
    static func parse(_ s: String) -> Date? { isoPlain.date(from: s) ?? isoFraction.date(from: s) }

    static func time(_ d: Date) -> String { timeFormatter.string(from: d) }
    static func title(_ key: String) -> String { dayRange(key).map { titleFormatter.string(from: $0.start) } ?? key }
}

/// ULID（Crockford Base32・26文字）。かけらの id は端末で採番する（Web 版の src/lib/ulid.ts と同じ形）
enum ULID {
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func make(_ date: Date = Date()) -> String {
        var ms = UInt64(max(0, date.timeIntervalSince1970 * 1000))
        var time = [Character](repeating: "0", count: 10)
        for i in stride(from: 9, through: 0, by: -1) {
            time[i] = alphabet[Int(ms % 32)]
            ms /= 32
        }
        var rng = SystemRandomNumberGenerator()
        let random = (0..<16).map { _ in alphabet[Int(rng.next(upperBound: UInt8(32)))] }
        return String(time + random)
    }
}

/// 本文（Markdown のまま）の読み方。写真は Web 版と同じ `![](/api/photo/...)` だけの行
enum KakeraBody {
    private static let imageLine = try! NSRegularExpression(pattern: #"^!\[[^\]\n]*\]\(([^)\s]+)(?: "[^"\n]*")?\)$"#)

    /// 写真の行の URL（本文の順）
    static func photoURLs(_ body: String) -> [String] {
        body.split(separator: "\n", omittingEmptySubsequences: false).compactMap { photoURL(in: String($0)) }
    }

    static func photoURL(in line: String) -> String? {
        let ns = line as NSString
        guard let m = imageLine.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    /// 写真の行を除いた文字（一覧の見出し用）
    static func text(_ body: String) -> String {
        body.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { photoURL(in: String($0)) == nil }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 写真の記法（Web 版の k-editor と同じ `![](url)`・1枚1行）
    static func photoLine(_ url: String) -> String { "![](\(url))" }

    /// 本文の末尾に写真の行を足す（前の行とは改行で分ける）
    static func appendingPhotos(_ body: String, _ urls: [String]) -> String {
        guard !urls.isEmpty else { return body }
        let lines = urls.map(photoLine).joined(separator: "\n")
        let head = body.trimmingCharacters(in: .newlines)
        return head.isEmpty ? lines + "\n" : head + "\n" + lines + "\n"
    }
}

/// 「かけらにした」印（端末の中だけ・アプリを開き直しても残る）。写真は PHAsset の localIdentifier、記事は便りの item id
@Observable
final class UsedMarks {
    static let shared = UsedMarks()

    private static let photoKey = "usedPhotoAssets"
    private static let itemKey = "usedTayoriItems"
    private let defaults: UserDefaults

    private(set) var photos: Set<String>
    private(set) var items: Set<Int>

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        photos = Set(defaults.stringArray(forKey: Self.photoKey) ?? [])
        items = Set((defaults.array(forKey: Self.itemKey) as? [Int]) ?? [])
    }

    func markPhotos(_ ids: [String]) {
        photos.formUnion(ids)
        defaults.set(Array(photos), forKey: Self.photoKey)
    }

    func markItem(_ id: Int) {
        items.insert(id)
        defaults.set(Array(items), forKey: Self.itemKey)
    }
}

/// 写真を上げる前に JPEG にする（Web 版 photo.ts / fit-size.ts と同じ縮め方）。
/// 普通の写真（縦横比 2 以下）は面積 ≤ 2048×2048、細長い画像は面積 ≤ 12MP・長辺 ≤ 16384px。品質 0.85。
/// 描き直すので EXIF（位置情報など）は落ちる。HEIC もここで JPEG になる
enum JPEG {
    static func fitSize(width: CGFloat, height: CGFloat) -> CGSize {
        guard width > 0, height > 0 else { return .zero }
        let aspect = max(width, height) / min(width, height)
        let maxArea: CGFloat = aspect > 2 ? 12_000_000 : 2048 * 2048
        let scale = min(1, 16384 / max(width, height), (maxArea / (width * height)).squareRoot())
        if scale >= 1 { return CGSize(width: width, height: height) }
        return CGSize(width: max(1, floor(width * scale)), height: max(1, floor(height * scale)))
    }

    static func make(from data: Data) throws -> Data {
        guard let image = UIImage(data: data) else { throw APIError.transport("写真を読めませんでした") }
        let size = fitSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        guard size.width > 0 else { throw APIError.transport("写真の大きさを読めませんでした") }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let out = UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.85) { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size)) // 向き（EXIF の Orientation）は UIImage が反映する
        }
        return out
    }
}

/// 本文の写真（/api/photo/...）を認証つきで取って出す
@MainActor
final class PhotoCache {
    static let shared = PhotoCache()
    private let cache = NSCache<NSString, UIImage>()

    func image(_ path: String) async -> UIImage? {
        if let hit = cache.object(forKey: path as NSString) { return hit }
        guard let data = try? await API.shared.photoData(path: path), let img = UIImage(data: data) else { return nil }
        cache.setObject(img, forKey: path as NSString)
        return img
    }
}

struct RemotePhoto: View {
    let path: String
    var side: CGFloat = 72
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            Rectangle().fill(Color(uiColor: .secondarySystemFill))
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if failed {
                Image(systemName: "photo").foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: path) {
            image = await PhotoCache.shared.image(path)
            failed = image == nil
        }
    }
}

enum Theme {
    static let accent = Color(red: 0xB0 / 255, green: 0x3A / 255, blue: 0x2E / 255)
}
