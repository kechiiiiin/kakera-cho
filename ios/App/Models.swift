import Foundation

// かけら帳の Web 版と共有する形（src/lib/kakera/types.ts・src/lib/names/*・src/lib/publish/*）。
// JSON は snake_case。API.swift の decoder は convertFromSnakeCase で読む（⚠️ 辞書の鍵が URL の cards は別の decoder）。

/// かけら（かたちの中身では showTime も入る）
extension Kakera {
    var dayKey: String { String(writtenAt.prefix(10)) }
    var hhmm: String { String(writtenAt.dropFirst(11).prefix(5)) }
}

struct Katachi: Codable, Hashable {
    let id: String
    /// 'YYYY-MM-DD'
    var date: String
    var title: String
    var description: String?
    var updatedAt: String
}

struct KatachiSummary: Codable, Hashable, Identifiable {
    let id: String
    let date: String
    let title: String
    let description: String?
    let updatedAt: String
    let hasNikki: Bool
    let lead: String
}

struct Nikki: Codable, Hashable {
    let katachiId: String
    let slug: String
    let publishedAt: String
    let updatedAt: String
}

/// かたちの中のかけら（show_time つき）
struct KatachiKakera: Codable, Hashable, Identifiable {
    let id: String
    var body: String
    var writtenAt: String
    var katachiId: String?
    var updatedAt: String
    var showTime: Bool?

    var kakera: Kakera { Kakera(id: id, body: body, writtenAt: writtenAt, katachiId: katachiId, updatedAt: updatedAt) }
    var hhmm: String { String(writtenAt.dropFirst(11).prefix(5)) }
}

struct KatachiDetail: Hashable {
    var katachi: Katachi
    var kakera: [KatachiKakera]
    var nikki: Nikki?
    var publishedIds: [String]
    var cards: LinkCards
}

struct SearchMatch: Codable, Hashable {
    let kakeraId: String
    let excerpt: String
}

struct SearchResult: Codable, Hashable, Identifiable {
    let id: String
    let date: String
    let title: String
    let hasNikki: Bool
    let matches: [SearchMatch]
}

struct WordSummary: Codable, Hashable, Identifiable {
    let word: String
    let count: Int
    let lastWrittenAt: String
    var id: String { word }
}

struct WordKakera: Codable, Hashable, Identifiable {
    let id: String
    let body: String
    let writtenAt: String
    let katachiId: String?
    let katachiDate: String?
}

struct WordDetail: Hashable {
    let word: String
    let kakera: [WordKakera]
    let cards: LinkCards
}

// MARK: - 公開名変換

struct NameEntry: Codable, Hashable, Identifiable {
    let id: String
    var source: String
    var target: String
    var updatedAt: String?

    var isException: Bool { source == target }
}

/// 文書の切れ（{t: 文字} か {r: 記号の id}）
enum DocSegment: Codable, Hashable {
    case text(String)
    case ref(String)

    private enum K: String, CodingKey { case t, r }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        if let t = try c.decodeIfPresent(String.self, forKey: .t) { self = .text(t) }
        else { self = .ref(try c.decode(String.self, forKey: .r)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case .text(let t): try c.encode(t, forKey: .t)
        case .ref(let r): try c.encode(r, forKey: .r)
        }
    }
}

struct NameRef: Codable, Hashable {
    let id: String
    let source: String
    var action: String
    var text: String?
}

struct LostChoice: Codable, Hashable {
    let source: String
    let action: String
    let text: String?
    let now: String?
}

/// name-choice が返す文書（そのまま /api/native/convert-view へ送り返す）
struct DocView: Codable, Hashable {
    let seg: String
    let kind: String
    let docId: String
    var rev: String
    var segments: [DocSegment]?
    var refs: [NameRef]
    var lostChoices: [LostChoice]
    var basis: String?
    var stale: Bool
    var updatedAt: String
}

struct NameChoiceLoad: Decodable {
    let entries: [NameEntry]
    let title: String
    let description: String?
    let dictRev: String
    let docs: [DocView]
}

struct PhotoChoice: Codable, Hashable {
    let kakeraId: String
    let key: String
}

struct PublishBodyView: Codable, Hashable {
    let basis: String?
    let stale: Bool?
}

// MARK: - 顔

struct PhotoFace: Codable, Hashable, Identifiable {
    let id: String
    var x: Double
    var y: Double
    var w: Double
    var h: Double
    let source: String
    var shown: Bool
}

struct PhotoFaceState: Codable, Hashable {
    let key: String
    var scanned: Bool
    var faces: [PhotoFace]
    var fp: String?
    var masked: Bool
}

// MARK: - 変換ページ（POST /api/native/convert-view の返す形・src/lib/native/convert-view.ts）

struct ResolvedSpan: Codable, Hashable {
    let id: String
    let start: Int
    let end: Int
    let source: String
    /// dict / edit / reject / exception
    let status: String
    let word: String
    let target: String?
}

struct TextSpan: Codable, Hashable {
    let start: Int
    let end: Int
}

/// 名前の切れ（text / url / raw / link / image）。位置は UTF-16
struct ViewToken: Decodable, Hashable {
    let kind: String
    let start: Int
    let end: Int
    let label: [ViewToken]?
    let href: String?
    let title: TextSpan?
    let alt: [ViewToken]?
    let url: String?
    let photoKey: String?
    let srcOk: Bool?
}

struct TimeHead: Codable, Hashable {
    let label: String
    let datetime: String
}

struct ConvertSeg: Decodable, Hashable, Identifiable {
    let seg: String
    let label: String
    let num: Int
    let kakeraId: String?
    let time: String?
    let hasPub: Bool
    let stale: Bool
    let text: String
    let rawText: String
    let spans: [ResolvedSpan]
    let tokens: [ViewToken]
    let error: String?
    let photoKeys: [String]
    let empty: Bool
    let timeHead: TimeHead?
    let original: String?

    var id: String { seg }
    var isHead: Bool { seg == "title" || seg == "description" }
    var fullLabel: String { label + (time.map { "・\($0)" } ?? "") }
}

struct ConvertAssembled: Decodable, Hashable {
    struct Body: Decodable, Hashable {
        let seg: String
        let text: String
        let timeHead: TimeHead?
    }
    let title: String
    let description: String
    let bodies: [Body]
}

struct RefChoice: Codable, Hashable {
    let refId: String
    let action: String
    let text: String?
}

struct ConvertView: Decodable, Hashable {
    struct Counts: Decodable, Hashable { let dict: Int; let edit: Int; let reject: Int; let exc: Int }
    struct PhotoCount: Decodable, Hashable { let shown: Int; let hidden: Int }
    struct Reject: Decodable, Hashable { let seg: String; let id: String }
    struct Lost: Decodable, Hashable { let key: String; let label: String; let line: String }
    struct DocRev: Codable, Hashable { let docId: String; let rev: String }

    let segs: [ConvertSeg]
    let assembled: ConvertAssembled?
    let assembleError: String?
    let markdown: String?
    let counts: Counts
    let photoCount: PhotoCount
    let wantFaces: [String]
    let rejects: [Reject]
    let lostNotes: [Lost]
    let staleNums: [Int]
    let composedEmpty: Bool
    let cannotExport: Bool
    let dictEmpty: Bool
    let choices: [RefChoice]
    let docRevs: [DocRev]
}

struct WordPlanRow: Decodable, Hashable, Identifiable {
    let key: String
    let kakeraId: String
    let word: String
    let start: Int
    let end: Int
    let before: String
    let after: String
    var id: String { key }
}

struct NameTry: Decodable, Hashable {
    let text: String
    let spans: [ResolvedSpan]
}

struct PublishResult: Decodable {
    let ok: Bool
    let path: String?
    let slug: String?
    let staleLeft: Int?
}
