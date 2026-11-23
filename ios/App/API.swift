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
private struct KakeraEnvelope: Decodable { let kakera: Kakera }
private struct PhotoUploaded: Decodable { let key: String; let url: String }

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
    func kakera(on day: String) async throws -> [Kakera] {
        let r: KakeraList = try await call(.kakera, "GET", "/api/kakera", query: [URLQueryItem(name: "date", value: day)])
        return r.kakera
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

    // MARK: 共通

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
