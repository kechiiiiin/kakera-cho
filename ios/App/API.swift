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

/// 便りの既読記事（GET /api/items/read-on の1件）
struct ReadItem: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let url: String?
    let feedTitle: String
    let readAt: String
    let comment: String?

    var readDate: Date? { JST.parse(readAt) }
}

private struct KakeraList: Decodable { let kakera: [Kakera] }
private struct KakeraEnvelope: Decodable { let kakera: Kakera }
private struct PhotoUploaded: Decodable { let key: String; let url: String }
private struct ReadItemList: Decodable { let items: [ReadItem] }

// MARK: - 下まわり

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Access のログイン画面への 302 を追わない
    }
}

/// かけら帳と便りの Worker を叩く。サービストークンは本番の二つのホストにだけ付ける（ServerConfig.mayCarryToken）
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

    // MARK: 便り

    /// その日（JST）に既読にした記事（read_at 昇順）
    func readOn(_ day: String) async throws -> [ReadItem] {
        let r: ReadItemList = try await call(.tayori, "GET", "/api/items/read-on", query: [URLQueryItem(name: "date", value: day)])
        return r.items
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
