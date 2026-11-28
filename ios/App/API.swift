import Foundation

enum APIError: LocalizedError, Equatable {
    case notConfigured(Service)
    case unauthorized(Service)
    case http(Int, String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured(let s): return "\(s.name)につなぐ設定がありません（右上の設定でサービストークンを入れてください）"
        case .unauthorized(let s): return "\(s.name)の Cloudflare Access を通れませんでした（サービストークンを確かめてください）"
        case .transport(let m): return "通信できませんでした（\(m)）"
        case .http(let code, let e): return "エラー（\(code)）\(e)"
        }
    }
}

// MARK: - 形

/// かけら（kakera-cho の Kakera と同じ形）
struct Kakera: Codable, Identifiable, Hashable {
    let id: String
    var body: String
    /// ISO8601（+09:00 付き）
    var writtenAt: String
    var katachiId: String?
    var updatedAt: String

    var writtenDate: Date { JST.parse(writtenAt) ?? .distantPast }
}

/// 港（minato）の材料1件（GET /api/materials の items の1件）。detail は出どころごとに形が違う JSON
struct Material: Decodable, Identifiable, Hashable {
    let id: Int
    let source: String
    let externalId: String
    /// +09:00 付き。日単位のもの（天気・からだ帳の一日・読んだ日・vault の log）は nil
    let occurredAt: String?
    let date: String
    let title: String
    let url: String?
    let detail: JSONValue

    var occurredDate: Date? { occurredAt.flatMap(JST.parse) }
    /// 「かけらにした」印の鍵（出どころ＋出どころの中の id。港の行 id は入れ替えで変わるので使わない）
    var markKey: String { "\(source)|\(externalId)" }
    /// 便りの記事なら便りの item id（港の external_id は `item:<id>`）。第一弾の印（便りの id）と同じ数
    var tayoriItemID: Int? {
        guard source == "tayori", externalId.hasPrefix("item:") else { return nil }
        return Int(externalId.dropFirst(5))
    }
}

struct MaterialGroup: Decodable, Hashable {
    let source: String
    let label: String
    let count: Int
    let items: [Material]
}

/// 出どころごとのその日の最後の集め（ok / skipped / error）
struct MaterialStatus: Decodable, Hashable {
    let source: String
    let label: String
    let status: String
    let count: Int
    let reason: String?
    let runAt: String?
    let trigger: String?
}

struct MaterialsResponse: Decodable {
    let date: String
    let groups: [MaterialGroup]
    let status: [MaterialStatus]
}

struct CollectResult: Decodable, Hashable {
    let source: String
    let label: String
    let status: String
    let count: Int
    let reason: String?
}

struct CollectResponse: Decodable {
    let date: String
    let results: [CollectResult]
}

/// 形の決まっていない JSON（材料の detail）
enum JSONValue: Decodable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    /// 鍵は snake_case で書く。デコーダの convertFromSnakeCase が辞書の鍵も camelCase にすることがあるので両方見る
    subscript(key: String) -> JSONValue? {
        guard case .object(let o) = self else { return nil }
        if let v = o[key] { return v }
        let parts = key.split(separator: "_")
        guard parts.count > 1 else { return nil }
        let camel = String(parts[0]) + parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
        return o[camel]
    }

    var string: String? {
        if case .string(let s) = self, !s.isEmpty { return s }
        return nil
    }

    var number: Double? {
        if case .number(let n) = self { return n }
        return nil
    }

    var array: [JSONValue] {
        if case .array(let a) = self { return a }
        return []
    }
}

private struct KakeraList: Decodable { let kakera: [Kakera] }
private struct CardsEnvelope: Decodable { let cards: LinkCards? }
private struct KakeraEnvelope: Decodable { let kakera: Kakera }
private struct DayEnvelope: Decodable { struct Day: Decodable { let date: String; let mood: String? }; let day: Day }
private struct BashoListEnvelope: Decodable { let places: [Basho] }
private struct BashoEnvelope: Decodable { let place: Basho }
private struct TrackListEnvelope: Decodable { let points: [TrackPoint] }
private struct TrackSent: Decodable { let added: Int; let skipped: Int }
private struct DaysEnvelope: Decodable { let days: [DaySummaryRow] }
private struct DaySearchEnvelope: Decodable { let kakera: [KakeraHit]?; let places: [PlaceHit]? }
private struct HiddenEnvelope: Decodable { struct Row: Decodable { let kind: String; let ref: String; let date: String }; let hidden: [Row] }
private struct PhotoUploaded: Decodable { let key: String; let url: String }
private struct KatachiListEnvelope: Decodable { let katachi: [KatachiSummary] }
private struct DetailEnvelope: Decodable {
    let katachi: Katachi
    let kakera: [KatachiKakera]
    let nikki: Nikki?
    let publishedIds: [String]?
}
private struct SearchEnvelope: Decodable { let results: [SearchResult] }
private struct WordsEnvelope: Decodable { let words: [WordSummary] }
private struct WordEnvelope: Decodable { let word: String; let kakera: [WordKakera] }
private struct EntriesEnvelope: Decodable { let entries: [NameEntry] }
private struct RefEnvelope: Decodable { let ref: NameRef }
private struct PublishBodySaved: Decodable { let publish: DocView?; let kakera: DocView? }
private struct PublishBodyEnvelope: Decodable { let publishBody: PublishBodyView }
private struct PhotosEnvelope: Decodable { let photos: [PhotoChoice] }
private struct FacesEnvelope: Decodable { let photos: [PhotoFaceState] }
private struct FaceEnvelope: Decodable { let photo: PhotoFaceState }
private struct TextsEnvelope: Decodable { let texts: [String] }
private struct RowsEnvelope: Decodable { let rows: [WordPlanRow] }

// MARK: - 下まわり

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Access のログイン画面への 302 を追わない
    }
}

/// かけら帳と港の Worker を叩く。サービストークンは本番の二つのホストにだけ付ける（ServerConfig.mayCarryToken）
final class API: @unchecked Sendable {
    static let shared = API()

    private let session: URLSession
    private let noRedirect = NoRedirect()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60 // 写真を上げるときは遅い回線だと時間がかかる
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    func isConfigured(_ s: Service) -> Bool {
        guard ServerConfig.baseURL(s) != nil else { return false }
        return ServerConfig.isLocalDev(s) || AccessTokenStore.isComplete
    }

    // MARK: かけら帳

    /// その日（JST）に書いたかけら全部（かたちの中も含む・書いた順）
    /// cards は本文の中の URL のリンクカード（正規化 URL → カード）。⚠️ キーが URL なので snake_case 変換を通さない別の decoder で読む
    func kakera(on day: String) async throws -> (kakera: [Kakera], cards: LinkCards) {
        let data = try await raw(.kakera, "GET", "/api/kakera", query: [URLQueryItem(name: "date", value: day)])
        do {
            let list = try decoder.decode(KakeraList.self, from: data)
            let cards = (try? JSONDecoder().decode(CardsEnvelope.self, from: data))?.cards ?? [:]
            return (list.kakera, cards)
        } catch {
            throw APIError.transport("応答を読めませんでした")
        }
    }

    /// 新しいかけら。id は端末で採番した ULID、writtenAt は +09:00 付き
    func createKakera(id: String, body: String, writtenAt: String) async throws -> Kakera {
        let r: KakeraEnvelope = try await call(.kakera, "POST", "/api/kakera", json: ["id": id, "body": body, "written_at": writtenAt])
        return r.kakera
    }

    /// 直す。送ったものだけ変わる（written_at はサーバで秒が 00 になる・未来は 400）
    func updateKakera(id: String, body: String?, writtenAt: String?) async throws -> Kakera {
        var b: [String: Any] = [:]
        if let body { b["body"] = body }
        if let writtenAt { b["written_at"] = writtenAt }
        let r: KakeraEnvelope = try await call(.kakera, "PATCH", "/api/kakera/\(id)", json: b)
        return r.kakera
    }

    func deleteKakera(id: String) async throws {
        _ = try await raw(.kakera, "DELETE", "/api/kakera/\(id)")
    }

    // MARK: 1日のページ（気分・場所・一覧から外した印。Web の src/pages/api/day/・place/・timeline-hidden.ts）

    /// その日の気分（押していない日は nil）
    func kibun(on day: String) async throws -> Kibun? {
        let r: DayEnvelope = try await call(.kakera, "GET", "/api/day/\(day)")
        return r.day.mood.flatMap(Kibun.init(rawValue:))
    }

    /// 気分を付ける・外す（nil）
    func setKibun(_ kibun: Kibun?, on day: String) async throws -> Kibun? {
        let r: DayEnvelope = try await call(.kakera, "PUT", "/api/day/\(day)", json: ["mood": kibun.map { $0.rawValue as Any } ?? NSNull()])
        return r.day.mood.flatMap(Kibun.init(rawValue:))
    }

    /// その日（JST）の場所（時刻順）
    func basho(on day: String) async throws -> [Basho] {
        let r: BashoListEnvelope = try await call(.kakera, "GET", "/api/place", query: [URLQueryItem(name: "date", value: day)])
        return r.places
    }

    /// 場所を足す。id は端末で採番した ULID、at は +09:00 付き。座標が取れなければ送らない
    func createBasho(id: String, at: String, name: String, coordinate: (lat: Double, lng: Double)?,
                     source: String = "manual") async throws -> Basho {
        var b: [String: Any] = ["id": id, "at": at, "name": name, "source": source]
        if let c = coordinate { b["lat"] = c.lat; b["lng"] = c.lng }
        let r: BashoEnvelope = try await call(.kakera, "POST", "/api/place", json: b)
        return r.place
    }

    func deleteBasho(id: String) async throws {
        _ = try await raw(.kakera, "DELETE", "/api/place/\(id)")
    }

    /// その日（JST）の軌跡の点（時刻順・Web の GET /api/track）
    func track(on day: String) async throws -> [TrackPoint] {
        let r: TrackListEnvelope = try await call(.kakera, "GET", "/api/track", query: [URLQueryItem(name: "date", value: day)])
        return r.points
    }

    /// 軌跡の点をまとめて送る（Kiseki.batchMax まで）。同じ id はサーバが黙って飛ばす
    @discardableResult
    func sendTrack(_ points: [TrackPoint]) async throws -> (added: Int, skipped: Int) {
        let list: [[String: Any]] = points.map {
            ["id": $0.id, "at": $0.at, "lat": $0.lat, "lng": $0.lng, "accuracy": $0.accuracy.map { $0 as Any } ?? NSNull(), "source": $0.source]
        }
        let r: TrackSent = try await call(.kakera, "POST", "/api/track", json: ["points": list])
        return (r.added, r.skipped)
    }

    /// その日の一覧から外した印（kind → ref の集まり。写真は localIdentifier、予定は「eventIdentifier|その回の開始」）
    func hidden(on day: String) async throws -> [String: Set<String>] {
        let r: HiddenEnvelope = try await call(.kakera, "GET", "/api/timeline-hidden", query: [URLQueryItem(name: "date", value: day)])
        return Dictionary(grouping: r.hidden, by: \.kind).mapValues { Set($0.map(\.ref)) }
    }

    /// 月カレンダー: その月の日ごとの かけら・場所の数と気分（どれかがある日だけ）
    func days(month: String) async throws -> [DaySummaryRow] {
        let r: DaysEnvelope = try await call(.kakera, "GET", "/api/days", query: [URLQueryItem(name: "month", value: month)])
        return r.days
    }

    /// 1日のページの検索: かけら（全部）の本文と場所の名前（日付つき）。かたち一覧の検索（search）とは別の配列を読む
    func daySearch(_ q: String) async throws -> (kakera: [KakeraHit], places: [PlaceHit]) {
        let r: DaySearchEnvelope = try await call(.kakera, "GET", "/api/search", query: [URLQueryItem(name: "q", value: q)])
        return (r.kakera ?? [], r.places ?? [])
    }

    /// 全期間の書き出し（テキスト）
    func exportText() async throws -> String {
        String(decoding: try await raw(.kakera, "GET", "/api/export"), as: UTF8.self)
    }

    /// 一覧から外す（写真のライブラリ・カレンダーからは消さない）
    func hide(kind: String, ref: String, on day: String) async throws {
        _ = try await send("POST", "/api/timeline-hidden", ["kind": kind, "ref": ref, "date": day])
    }

    /// 外した印を取って一覧に戻す
    func unhide(kind: String, ref: String) async throws {
        _ = try await raw(.kakera, "DELETE", "/api/timeline-hidden", query: [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "ref", value: ref)])
    }

    /// 写真（JPEG）を上げる。戻りは本文に書く相対 URL（/api/photo/kakera/...）。Web 版と同じ multipart の形
    func uploadPhoto(jpeg: Data, kakeraId: String, writtenAt: String, n: Int) async throws -> String {
        let boundary = "kakera-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(jpeg)
        body.append("\r\n".data(using: .utf8)!)
        field("kakera_id", kakeraId)
        field("written_at", writtenAt)
        field("n", String(n))
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        let data = try await raw(.kakera, "POST", "/api/photo", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
        guard let r = try? decoder.decode(PhotoUploaded.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return r.url
    }

    /// 本文の写真（/api/photo/... の相対 URL）を取る
    func photoData(path: String) async throws -> Data {
        guard path.hasPrefix("/api/photo/") else { throw APIError.http(400, "写真の URL ではありません") }
        return try await raw(.kakera, "GET", path)
    }

    // MARK: 港

    /// その日（JST）の材料を出どころごとに。status は出どころごとの最後の集め
    func materials(on day: String) async throws -> MaterialsResponse {
        try await call(.minato, "GET", "/api/materials", query: [URLQueryItem(name: "date", value: day)])
    }

    /// 今すぐ集める（その日の分）。Mac から送るもの（vault の log・Mac の作業）は次の送り出しを待つ
    func collect(on day: String) async throws -> CollectResponse {
        try await call(.minato, "POST", "/api/collect", json: ["date": day])
    }

    // MARK: かたち・日記・ことば（Web の App.tsx と同じ /api/*）

    /// まだかたちになっていないかけら（新しい順）と、その中の URL のカード
    func nagare() async throws -> (kakera: [Kakera], cards: LinkCards) {
        let data = try await raw(.kakera, "GET", "/api/kakera", query: [URLQueryItem(name: "unassigned", value: "1")])
        guard let list = try? decoder.decode(KakeraList.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return (list.kakera, cardsIn(data))
    }

    func katachiList() async throws -> [KatachiSummary] {
        let r: KatachiListEnvelope = try await call(.kakera, "GET", "/api/katachi")
        return r.katachi
    }

    func katachi(_ id: String) async throws -> KatachiDetail {
        try detail(try await raw(.kakera, "GET", "/api/katachi/\(id)"))
    }

    func createKatachi(id: String, date: String, title: String, kakeraIds: [String], showTimeIds: [String]) async throws -> KatachiDetail {
        try detail(try await send("POST", "/api/katachi", ["id": id, "date": date, "title": title, "kakera_ids": kakeraIds, "show_time_ids": showTimeIds]))
    }

    func setShowTime(katachiId: String, kakeraIds: [String], show: Bool) async throws -> KatachiDetail {
        try detail(try await send("PUT", "/api/katachi/\(katachiId)/show-time", ["kakera_ids": kakeraIds, "show": show]))
    }

    /// date・title・description・move_nikki のうち渡したものだけ
    func updateKatachi(_ id: String, _ patch: [String: Any]) async throws -> KatachiDetail {
        try detail(try await send("PATCH", "/api/katachi/\(id)", patch))
    }

    func dissolveKatachi(_ id: String) async throws {
        _ = try await raw(.kakera, "DELETE", "/api/katachi/\(id)")
    }

    func addKakera(toKatachi id: String, kakeraIds: [String]) async throws -> KatachiDetail {
        try detail(try await send("POST", "/api/katachi/\(id)/kakera", ["kakera_ids": kakeraIds]))
    }

    func detachKakera(katachiId: String, kakeraId: String) async throws {
        _ = try await raw(.kakera, "DELETE", "/api/katachi/\(katachiId)/kakera/\(kakeraId)")
    }

    func search(_ q: String) async throws -> [SearchResult] {
        let r: SearchEnvelope = try await call(.kakera, "GET", "/api/search", query: [URLQueryItem(name: "q", value: q)])
        return r.results
    }

    func words() async throws -> [WordSummary] {
        let r: WordsEnvelope = try await call(.kakera, "GET", "/api/words")
        return r.words
    }

    /// 言葉のページ（言葉は実名を含みうるので POST で読む）
    func word(_ word: String) async throws -> WordDetail {
        let data = try await send("POST", "/api/words", ["word": word])
        guard let r = try? decoder.decode(WordEnvelope.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return WordDetail(word: r.word, kakera: r.kakera, cards: cardsIn(data))
    }

    // MARK: 公開名変換

    func nameMap() async throws -> [NameEntry] {
        let r: EntriesEnvelope = try await call(.kakera, "GET", "/api/name-map")
        return r.entries
    }

    func addNameEntry(source: String, target: String, exception: Bool) async throws {
        _ = try await send("POST", "/api/name-map", ["source": source, "target": target, "exception": exception])
    }

    func updateNameEntry(_ id: String, source: String, target: String, exception: Bool) async throws {
        _ = try await send("PATCH", "/api/name-map/\(id)", ["source": source, "target": target, "exception": exception])
    }

    func deleteNameEntry(_ id: String) async throws {
        _ = try await raw(.kakera, "DELETE", "/api/name-map/\(id)")
    }

    /// 変換ページを開くとき（文書の同期が走る）
    func loadNameChoices(katachiId: String, kakeraIds: [String], title: String) async throws -> NameChoiceLoad {
        let data = try await send("POST", "/api/katachi/\(katachiId)/name-choice", ["kakera_ids": kakeraIds, "title": title])
        guard let r = try? decoder.decode(NameChoiceLoad.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return r
    }

    /// 記号一つの選択を覚える。戻りはサーバが整えた記号（辞書どおりと同じ言葉なら approve になる）
    func saveNameChoice(katachiId: String, refId: String, action: String, text: String?) async throws -> NameRef {
        var b: [String: Any] = ["ref_id": refId, "action": action]
        if let text { b["text"] = text }
        let data = try await send("PUT", "/api/katachi/\(katachiId)/name-choice", b)
        guard let r = try? decoder.decode(RefEnvelope.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return r.ref
    }

    func loadPublishBodies(katachiId: String) async throws -> LinkCards {
        cardsIn(try await raw(.kakera, "GET", "/api/katachi/\(katachiId)/publish-body"))
    }

    /// 日記用に直した文を保存する。publish が nil なら原本と同じ文になった（書き換えを持たない）
    func savePublishBody(katachiId: String, kakeraId: String, base: String, text: String) async throws -> (publish: DocView?, kakera: DocView?, cards: LinkCards) {
        let data = try await send("PUT", "/api/katachi/\(katachiId)/publish-body/\(kakeraId)", ["base": base, "text": text])
        guard let r = try? decoder.decode(PublishBodySaved.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return (r.publish, r.kakera, cardsIn(data))
    }

    func acceptPublishBody(katachiId: String, kakeraId: String) async throws -> PublishBodyView {
        let r: PublishBodyEnvelope = try await call(.kakera, "PATCH", "/api/katachi/\(katachiId)/publish-body/\(kakeraId)")
        return r.publishBody
    }

    func deletePublishBody(katachiId: String, kakeraId: String) async throws {
        _ = try await raw(.kakera, "DELETE", "/api/katachi/\(katachiId)/publish-body/\(kakeraId)")
    }

    func loadPhotoChoices(katachiId: String, kakeraIds: [String]) async throws -> [PhotoChoice] {
        let data = try await send("POST", "/api/katachi/\(katachiId)/photo-choice", ["kakera_ids": kakeraIds])
        guard let r = try? decoder.decode(PhotosEnvelope.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return r.photos
    }

    func savePhotoChoices(katachiId: String, kakeraIds: [String], photos: [PhotoChoice]) async throws {
        _ = try await send("PUT", "/api/katachi/\(katachiId)/photo-choice",
                           ["kakera_ids": kakeraIds, "photos": photos.map { ["kakera_id": $0.kakeraId, "key": $0.key] }])
    }

    func loadPhotoFaces(keys: [String]) async throws -> [PhotoFaceState] {
        let data = try await send("POST", "/api/photo-face", ["keys": keys])
        guard let r = try? decoder.decode(FacesEnvelope.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return r.photos
    }

    /// 写真 1 枚の枠を丸ごと入れ替える。⚠️ model は送らない（Web の MediaPipe の検出だけが「検出が済んだ」印を付ける）
    func savePhotoFaces(key: String, faces: [PhotoFace]) async throws -> PhotoFaceState {
        let list = faces.map { f -> [String: Any] in
            ["id": f.id, "x": f.x, "y": f.y, "w": f.w, "h": f.h, "source": f.source, "shown": f.shown]
        }
        let data = try await send("PUT", "/api/photo-face", ["key": key, "faces": list])
        guard let r = try? decoder.decode(FaceEnvelope.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return r.photo
    }

    /// モザイク済みの JPEG を置く（form: key / fp / file）
    func uploadMaskedPhoto(key: String, fp: String, jpeg: Data) async throws {
        let boundary = "kakera-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        field("key", key)
        field("fp", fp)
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"masked.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(jpeg)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        _ = try await raw(.kakera, "POST", "/api/photo-face/masked", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
    }

    /// 書き出す（本文とタイトルはサーバが D1 の文書から解き直す）
    func publishNikki(katachiId: String, kakeraIds: [String], title: String, choices: [RefChoice], photos: [PhotoChoice],
                      confirmRealNames: Bool, docRevs: [ConvertView.DocRev], dictRev: String) async throws -> PublishResult {
        let body: [String: Any] = [
            "kakera_ids": kakeraIds,
            "title": title,
            "choices": choices.map { c -> [String: Any] in
                var o: [String: Any] = ["ref_id": c.refId, "action": c.action]
                if let t = c.text { o["text"] = t }
                return o
            },
            "photos": photos.map { ["kakera_id": $0.kakeraId, "key": $0.key] },
            "confirm_real_names": confirmRealNames,
            "doc_revs": docRevs.map { ["doc_id": $0.docId, "rev": $0.rev] },
            "dict_rev": dictRev,
        ]
        let data = try await send("POST", "/api/katachi/\(katachiId)/nikki", body)
        guard let r = try? decoder.decode(PublishResult.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return r
    }

    // MARK: iPhone 版のための計算の口（/api/native/*・Web の決まりをサーバで当てる）

    /// 選ぶ所の抜粋（Web の textForPick）
    func pickTexts(_ bodies: [String], cards: LinkCards) async throws -> [String] {
        guard !bodies.isEmpty else { return [] }
        let r: TextsEnvelope = try await callJSON("POST", "/api/native/pick-texts", ["bodies": bodies, "cards": Self.cardsJSON(cards)])
        return r.texts
    }

    /// かたちにする前の、既にページがある言葉の確認の行
    func wordPlan(kakera: [(id: String, body: String)], pages: [String], cards: LinkCards) async throws -> [WordPlanRow] {
        let r: RowsEnvelope = try await callJSON("POST", "/api/native/word-plan", [
            "kakera": kakera.map { ["id": $0.id, "body": $0.body] }, "pages": pages, "cards": Self.cardsJSON(cards),
        ])
        return r.rows
    }

    /// 名前の辞書の試し書き
    func nameTry(text: String, entries: [NameEntry]) async throws -> NameTry {
        try await callJSON("POST", "/api/native/name-try", [
            "text": text, "entries": entries.map { ["id": $0.id, "source": $0.source, "target": $0.target] },
        ])
    }

    /// 変換ページに出すもの（Web の ConvertScreen が画面の中で組むものを、サーバが同じ関数で組む）
    func convertView(katachiDate: String, kakera: [KatachiKakera], order: [String], title: String, description: String,
                     entries: [NameEntry], docs: [DocView], photos: [PhotoChoice], cards: LinkCards) async throws -> ConvertView {
        try await callJSON("POST", "/api/native/convert-view", [
            "katachi_date": katachiDate,
            "kakera": kakera.map { ["id": $0.id, "body": $0.body, "written_at": $0.writtenAt, "show_time": $0.showTime ?? false] },
            "order": order,
            "title": title,
            "description": description,
            "entries": entries.map { ["id": $0.id, "source": $0.source, "target": $0.target] },
            "docs": try Self.snakeJSON(docs),
            "photos": photos.map { ["kakera_id": $0.kakeraId, "key": $0.key] },
            "cards": Self.cardsJSON(cards),
        ])
    }

    // MARK: 形の読み書きの手伝い

    private func detail(_ data: Data) throws -> KatachiDetail {
        guard let r = try? decoder.decode(DetailEnvelope.self, from: data) else { throw APIError.transport("応答を読めませんでした") }
        return KatachiDetail(katachi: r.katachi, kakera: r.kakera, nikki: r.nikki, publishedIds: r.publishedIds ?? [], cards: cardsIn(data))
    }

    /// 本文に出てくる URL のカード（⚠️ 鍵が URL なので snake_case 変換を通さない decoder で読む）
    private func cardsIn(_ data: Data) -> LinkCards {
        (try? JSONDecoder().decode(CardsEnvelope.self, from: data))?.cards ?? [:]
    }

    static func cardsJSON(_ cards: LinkCards) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, c) in cards {
            out[k] = ["url": c.url, "title": c.title, "description": c.description, "siteName": c.siteName ?? "",
                      "domain": c.domain, "image": c.image as Any? ?? NSNull()]
        }
        return out
    }

    /// Encodable を snake_case の JSON の値に（DocView を name-choice が返した形のまま送り返す）
    static func snakeJSON<T: Encodable>(_ v: T) throws -> Any {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return try JSONSerialization.jsonObject(with: try e.encode(v))
    }

    private func send(_ method: String, _ path: String, _ json: [String: Any]) async throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await raw(.kakera, method, path, body: body, contentType: "application/json")
    }

    private func callJSON<T: Decodable>(_ method: String, _ path: String, _ json: [String: Any]) async throws -> T {
        let data = try await send(method, path, json)
        do { return try decoder.decode(T.self, from: data) } catch { throw APIError.transport("応答を読めませんでした") }
    }

    // MARK: 共通

    /// サービストークン（本番の二つのホストだけ）と、かけら帳の GET 以外に要る Origin を付ける
    private func authorize(_ req: inout URLRequest, _ s: Service, method: String, base: URL) throws {
        guard let url = req.url else { throw APIError.notConfigured(s) }
        if ServerConfig.mayCarryToken(url) {
            guard let id = AccessTokenStore.idValue, let secret = AccessTokenStore.secretValue else { throw APIError.notConfigured(s) }
            req.setValue(id, forHTTPHeaderField: "CF-Access-Client-Id")
            req.setValue(secret, forHTTPHeaderField: "CF-Access-Client-Secret")
        } else if !ServerConfig.isLocalDev(s) {
            throw APIError.notConfigured(s)
        }
        // かけら帳（Astro）は GET 以外で Origin を見る（checkOrigin）。自分の origin を名乗る
        if s == .kakera, method != "GET", let scheme = base.scheme, let host = base.host {
            req.setValue("\(scheme)://\(host)\(base.port.map { ":\($0)" } ?? "")", forHTTPHeaderField: "Origin")
        }
    }

    private func call<T: Decodable>(_ s: Service, _ method: String, _ path: String, query: [URLQueryItem] = [], json: [String: Any]? = nil) async throws -> T {
        let body = try json.map { try JSONSerialization.data(withJSONObject: $0) }
        let data = try await raw(s, method, path, query: query, body: body, contentType: json == nil ? nil : "application/json")
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.transport("応答を読めませんでした")
        }
    }

    private func raw(_ s: Service, _ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, contentType: String? = nil) async throws -> Data {
        guard let base = ServerConfig.baseURL(s), var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw APIError.notConfigured(s)
        }
        comps.path = path
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { throw APIError.notConfigured(s) }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        try authorize(&req, s, method: method, base: base)
        if let body {
            req.httpBody = body
            if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req, delegate: noRedirect)
        } catch {
            throw APIError.transport((error as NSError).localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport("応答がありません") }
        if (300..<400).contains(http.statusCode) || http.statusCode == 401 || http.statusCode == 403 {
            throw APIError.unauthorized(s)
        }
        guard (200..<300).contains(http.statusCode) else {
            let e = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                ?? String(decoding: data.prefix(200), as: UTF8.self)
            throw APIError.http(http.statusCode, e)
        }
        return data
    }
}
