import Foundation
import Security

/// つなぐ先は二つ: かけら帳（かけらの読み書き・写真）と港（その日の材料。読んだ記事も港の tayori から）。
/// 第一弾は便りを直接呼んでいたが、第二弾で港へ寄せた（便りは港の cron が呼ぶ）
enum Service: String, CaseIterable {
    case kakera
    case minato

    var name: String { self == .kakera ? "かけら帳" : "港" }
    fileprivate var infoKey: String { self == .kakera ? "KakeraServerURL" : "MinatoServerURL" }
    fileprivate var debugKey: String { self == .kakera ? "debugKakeraBaseURL" : "debugMinatoBaseURL" }
    fileprivate var launchFlag: String { self == .kakera ? "-kakeraBaseURL" : "-minatoBaseURL" }
}

enum ServerConfig {
    /// 本番。Info.plist の KakeraServerURL / MinatoServerURL（project.yml の KAKERA_SERVER_URL / MINATO_SERVER_URL から入る）
    static func productionURL(_ s: Service) -> URL? {
        guard let str = Bundle.main.object(forInfoDictionaryKey: s.infoKey) as? String,
              let url = URL(string: str), url.scheme == "https", url.host?.isEmpty == false else { return nil }
        return url
    }

    #if DEBUG
    /// **DEBUG ビルドだけ**: シミュレータでローカルの Worker を見る。
    /// 起動引数 `-kakeraBaseURL http://127.0.0.1:4321 -minatoBaseURL http://127.0.0.1:8793` を覚える（`-kakeraBaseURL reset` で消す）
    static func applyLaunchOverride() {
        let args = ProcessInfo.processInfo.arguments
        for s in Service.allCases {
            guard let i = args.firstIndex(of: s.launchFlag), args.index(after: i) < args.endIndex else { continue }
            let v = args[args.index(after: i)]
            if v == "reset" { UserDefaults.standard.removeObject(forKey: s.debugKey) } else { UserDefaults.standard.set(v, forKey: s.debugKey) }
        }
    }

    static func debugURL(_ s: Service) -> URL? {
        guard let str = UserDefaults.standard.string(forKey: s.debugKey), let url = URL(string: str),
              let scheme = url.scheme, scheme == "http" || scheme == "https", url.host?.isEmpty == false else { return nil }
        return url
    }
    #endif

    static func baseURL(_ s: Service) -> URL? {
        #if DEBUG
        if let u = debugURL(s) { return u }
        #endif
        return productionURL(s)
    }

    /// ローカルの Worker（認証を迂回する dev）に向いているか。DEBUG のときだけ true になりうる
    static func isLocalDev(_ s: Service) -> Bool {
        #if DEBUG
        guard let host = debugURL(s)?.host else { return false }
        return host == "127.0.0.1" || host == "localhost"
        #else
        return false
        #endif
    }

    /// サービストークンを付けてよい先か。**本番の二つのホスト（かけら帳・港。https）だけ**。それ以外へは秘密を送らない
    static func mayCarryToken(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return Service.allCases.contains { productionURL($0)?.host?.lowercased() == host }
    }
}

/// Keychain の汎用パスワード1項目（便り・nobu-ios と同じ作り）。アクセシビリティは AfterFirstUnlockThisDeviceOnly（バックアップに乗らない）
struct KeychainSecret {
    private static let service = "jp.kechiiiiin.kakera"
    let account: String

    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: account]
    }

    func save(_ value: String) throws {
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return } // 空文字は削除
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Keychain への保存に失敗 (status=\(status))"])
        }
    }

    func load() -> String? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let s = String(data: data, encoding: .utf8), !s.isEmpty else { return nil }
        return s
    }
}

/// Cloudflare Access のサービストークン「kakera-ios」（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）。
/// かけら帳と港の両方の Access アプリに入れてあり、同じ値を両方へ付ける。
/// 読む順: Keychain（設定画面や tmp/ から入れた上書き値）→ ビルドに埋め込んだ値（Info.plist。`make archive` が Mac のキーチェーンから入れる。Debug では空）
enum AccessTokenStore {
    static let clientID = KeychainSecret(account: "cf-access-client-id")
    static let clientSecret = KeychainSecret(account: "cf-access-client-secret")

    private static func embedded(_ key: String) -> String? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let v = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return v.isEmpty || v.hasPrefix("$(") ? nil : v
    }

    static var idValue: String? { clientID.load() ?? embedded("KakeraAccessClientID") }
    static var secretValue: String? { clientSecret.load() ?? embedded("KakeraAccessClientSecret") }
    static var isComplete: Bool { idValue != nil && secretValue != nil }

    /// 画面に出してよい手がかり（Client ID の先頭だけ。シークレットは出さない）
    static var hint: String? { idValue.map { String($0.prefix(8)) + "…" } }
}

/// Mac からサービストークンを流し込む入口（便りと同じ作り）。⚠️ シークレットはソースに含めない。
/// 1. ファイル: `simctl` / `devicectl device copy to` でアプリのコンテナの tmp/ に
///    `kakera-import-access-client-id` と `kakera-import-access-client-secret` を置くと、次の起動で Keychain へ移して**即削除**
/// 2. 起動引数: `-kakeraAccessId <id> -kakeraAccessSecret <secret>`（手元のテスト用）
/// 3. 設定画面の欄に貼る
enum LaunchConfig {
    static func applyIfPresent() {
        let fm = FileManager.default
        let items: [(String, KeychainSecret)] = [
            ("kakera-import-access-client-id", AccessTokenStore.clientID),
            ("kakera-import-access-client-secret", AccessTokenStore.clientSecret),
        ]
        for (name, secret) in items {
            let url = fm.temporaryDirectory.appendingPathComponent(name)
            guard fm.fileExists(atPath: url.path) else { continue }
            defer { try? fm.removeItem(at: url) }
            if let data = try? Data(contentsOf: url) {
                let v = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                if !v.isEmpty { try? secret.save(v) }
            }
        }
        let args = ProcessInfo.processInfo.arguments
        func value(after flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), args.index(after: i) < args.endIndex else { return nil }
            let v = args[args.index(after: i)]
            return v.hasPrefix("-") ? nil : v
        }
        if let id = value(after: "-kakeraAccessId") { try? AccessTokenStore.clientID.save(id) }
        if let s = value(after: "-kakeraAccessSecret") { try? AccessTokenStore.clientSecret.save(s) }
    }
}
