import CoreLocation
import CryptoKit
import MapKit
import SwiftUI

// 行った場所の自動記録（かけら帳1日のページ設計・段階4）: CLVisit（訪問の自動検出）を受けて、到着時刻で
// Web の POST /api/place（src/pages/api/place/index.ts・source=visit）に送る。送れなければ端末に溜めて、次に開いたとき送る。
// 二重にしない: 訪問ごとに id（ULID）を到着時刻と位置から決めて作る。同じ訪問が二度届いても同じ id になり、
// サーバは同じ id を 409 で断る（＝もう入っている）。端末でも送り済みの鍵を覚えて、同じ訪問は溜めない。

/// 溜めておく訪問（送れるまで端末の UserDefaults に置く）
struct PendingVisit: Codable, Hashable {
    let id: String
    let at: String
    let lat: Double
    let lng: Double
    var name: String?
}

enum Houmon {
    /// 同じ訪問とみなす鍵: 到着の分＋位置（小数3桁・約100m）
    static func key(arrival: Date, coordinate: CLLocationCoordinate2D) -> String {
        let minute = Int((arrival.timeIntervalSince1970 / 60).rounded(.down))
        return String(format: "%d|%.3f|%.3f", minute, coordinate.latitude, coordinate.longitude)
    }

    /// 鍵から決まる ULID（時刻の部分は到着の分・残りは鍵のハッシュ）。同じ訪問は何度作っても同じ id
    /// （秒まで入れると、同じ訪問が数秒ずれて届いたときに別の id になる）
    static func visitID(arrival: Date, coordinate: CLLocationCoordinate2D) -> String {
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        let minute = (arrival.timeIntervalSince1970 / 60).rounded(.down) * 60
        var ms = UInt64(max(0, minute * 1000))
        var time = [Character](repeating: "0", count: 10)
        for i in stride(from: 9, through: 0, by: -1) {
            time[i] = alphabet[Int(ms % 32)]
            ms /= 32
        }
        let digest = SHA256.hash(data: Data(key(arrival: arrival, coordinate: coordinate).utf8))
        let rest = digest.prefix(16).map { alphabet[Int($0 % 32)] }
        return String(time + rest)
    }

    /// 地名: 施設名があれば施設名、無ければ短い住所か市区町村。どれも無ければ nil（送る側で「訪れた場所」）
    static func placeName(_ item: MKMapItem?) -> String? {
        guard let item else { return nil }
        for s in [item.name, item.address?.shortAddress, item.addressRepresentations?.cityWithContext] {
            if let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return s }
        }
        return nil
    }

    static let fallbackName = "訪れた場所"
}

extension Notification.Name {
    /// 場所が足された（自動記録を送り終えた）。1日のページが読み直す
    static let kakeraPlacesChanged = Notification.Name("kakeraPlacesChanged")
}

/// 訪問を受けて送る係。アプリの起動時に作り、オンなら訪問の監視を始める
@MainActor
final class VisitRecorder: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = VisitRecorder()

    private static let enabledKey = "kakera.visit.enabled"
    private static let pendingKey = "kakera.visit.pending"
    private static let sentKey = "kakera.visit.sentKeys"

    private let manager = CLLocationManager()
    @Published private(set) var authorization: CLAuthorizationStatus
    @Published private(set) var enabled: Bool
    @Published var message: String?
    private var flushing = false
    /// 「使用中のみ」の返事を待ってから「常に」を求める
    private var wantsAlwaysAfterWhenInUse = false

    private override init() {
        authorization = manager.authorizationStatus
        enabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
        super.init()
        manager.delegate = self
    }

    /// 起動時: オンで許可があれば監視を続け、溜まっているものを送る
    func resume() {
        if enabled, authorization == .authorizedAlways { manager.startMonitoringVisits() }
        Task { await flush() }
    }

    /// 設定のオン（理由の説明を見せた後に呼ぶ）。使用中のみ → 常に の2段で求める
    func turnOn() {
        setEnabled(true)
        switch manager.authorizationStatus {
        case .notDetermined:
            wantsAlwaysAfterWhenInUse = true
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            manager.requestAlwaysAuthorization()
        case .authorizedAlways:
            manager.startMonitoringVisits()
        default:
            setEnabled(false)
            message = "位置の利用が許可されていません。設定アプリの「かけら帳」→「位置情報」で「常に」にすると使えます"
        }
    }

    func turnOff() {
        manager.stopMonitoringVisits()
        setEnabled(false)
    }

    private func setEnabled(_ on: Bool) {
        enabled = on
        UserDefaults.standard.set(on, forKey: Self.enabledKey)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorization = status
            guard self.enabled else { return }
            switch status {
            case .authorizedWhenInUse:
                if self.wantsAlwaysAfterWhenInUse {
                    self.wantsAlwaysAfterWhenInUse = false
                    self.manager.requestAlwaysAuthorization()
                } else {
                    self.message = "「常に」でないと、アプリを閉じている間の訪問は残せません（設定アプリで変えられます）"
                }
            case .authorizedAlways:
                self.message = nil
                self.manager.startMonitoringVisits()
            case .denied, .restricted:
                self.turnOff()
                self.message = "位置の利用が許可されなかったので、自動では残しません（手入力の場所は使えます）"
            default:
                break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let arrival = visit.arrivalDate, coordinate = visit.coordinate
        Task { @MainActor in await self.receive(arrival: arrival, coordinate: coordinate) }
    }

    /// 訪問を一つ受ける（DEBUG の擬似訪問もここを通る）。到着時刻が分からない・位置が変なものは捨てる
    func receive(arrival: Date, coordinate: CLLocationCoordinate2D) async {
        guard arrival != .distantPast, arrival <= Date().addingTimeInterval(60),
              CLLocationCoordinate2DIsValid(coordinate), !(coordinate.latitude == 0 && coordinate.longitude == 0) else { return }
        let key = Houmon.key(arrival: arrival, coordinate: coordinate)
        var sent = Self.sentKeys
        var pending = Self.pending
        let id = Houmon.visitID(arrival: arrival, coordinate: coordinate)
        guard !sent.contains(key), !pending.contains(where: { $0.id == id }) else { return } // 同じ訪問はもう受けた
        var v = PendingVisit(id: id, at: JST.writtenAt(arrival), lat: coordinate.latitude, lng: coordinate.longitude, name: nil)
        v.name = await Self.reverseName(coordinate)
        pending.append(v)
        Self.pending = pending
        sent.append(key)
        Self.sentKeys = Array(sent.suffix(500))
        await flush()
    }

    /// 溜まっている訪問を送る。送れた・もう入っていた（409）ものを外す。通信できなければ残して次に開いたとき
    func flush() async {
        guard !flushing, !Self.pending.isEmpty, API.shared.isConfigured(.kakera) else { return }
        flushing = true
        defer { flushing = false }
        var sentAny = false
        for v in Self.pending {
            var name = v.name
            if name == nil { name = await Self.reverseName(CLLocationCoordinate2D(latitude: v.lat, longitude: v.lng)) }
            do {
                _ = try await API.shared.createBasho(id: v.id, at: v.at, name: name ?? Houmon.fallbackName,
                                                     coordinate: (v.lat, v.lng), source: "visit")
                Self.pending.removeAll { $0.id == v.id }
                sentAny = true
            } catch APIError.http(409, _) {
                Self.pending.removeAll { $0.id == v.id } // もう入っている（同じ訪問）
            } catch APIError.http(400, _) {
                Self.pending.removeAll { $0.id == v.id } // 形が違う（未来の時刻など）。溜め続けない
            } catch {
                break // 通信できない・認証が通らない: 残して次の機会に
            }
        }
        if sentAny { NotificationCenter.default.post(name: .kakeraPlacesChanged, object: nil) }
    }

    private static func reverseName(_ c: CLLocationCoordinate2D) async -> String? {
        guard let req = MKReverseGeocodingRequest(location: CLLocation(latitude: c.latitude, longitude: c.longitude)) else { return nil }
        req.preferredLocale = Locale(identifier: "ja_JP")
        return Houmon.placeName(try? await req.mapItems.first)
    }

    static var pending: [PendingVisit] {
        get {
            guard let d = UserDefaults.standard.data(forKey: pendingKey) else { return [] }
            return (try? JSONDecoder().decode([PendingVisit].self, from: d)) ?? []
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: pendingKey) }
    }

    private static var sentKeys: [String] {
        get { UserDefaults.standard.stringArray(forKey: sentKey) ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: sentKey) }
    }

    #if DEBUG
    /// 検査だけ: 起動引数 -kakeraFakeVisit "lat,lng,YYYY-MM-DDTHH:mm:ss+09:00"（繰り返し可）で擬似の訪問を受ける。
    /// -kakeraResetVisits で溜めたもの・送り済みの鍵を空にして始める
    func applyLaunchArguments() async {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-kakeraResetVisits") {
            UserDefaults.standard.removeObject(forKey: Self.pendingKey)
            UserDefaults.standard.removeObject(forKey: Self.sentKey)
        }
        for (i, a) in args.enumerated() where a == "-kakeraFakeVisit" && i + 1 < args.count {
            let parts = args[i + 1].split(separator: ",", maxSplits: 2).map(String.init)
            guard parts.count == 3, let lat = Double(parts[0]), let lng = Double(parts[1]), let at = JST.parse(parts[2]) else { continue }
            await receive(arrival: at, coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lng))
        }
    }
    #endif
}

/// 設定画面の「行った場所を自動で残す」。オンにする前に理由を出す
struct VisitSettingSection: View {
    @ObservedObject var recorder = VisitRecorder.shared
    @State private var explaining = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: Binding(get: { recorder.enabled }, set: { on in
                if on { explaining = true } else { recorder.turnOff() }
            })) {
                Text("行った場所を自動で残す").font(Theme.gothic(14)).foregroundStyle(Theme.ink)
            }
            .tint(Theme.accent)
            .accessibilityIdentifier("visitToggle")
            Text("iPhone が「しばらく居た場所」を見つけたら、着いた時刻と地名をその日の一覧に場所として足します。既定はオフ。位置は「常に」の許可が要ります（断っても、手入力の場所はそのまま使えます）。")
                .font(Theme.gothic(11)).foregroundStyle(Theme.muted).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            if let m = recorder.message {
                Text(m).font(Theme.gothic(11)).foregroundStyle(Theme.accent).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("visitMessage")
            }
            if !VisitRecorder.pending.isEmpty {
                Text("送れていない訪問が \(VisitRecorder.pending.count) 件あります（次に開いたとき送ります）")
                    .font(Theme.gothic(11)).foregroundStyle(Theme.muted)
            }
        }
        .alert("行った場所を自動で残しますか", isPresented: $explaining) {
            Button("続ける") { recorder.turnOn() }
                .accessibilityIdentifier("visitContinue")
            Button("やめる", role: .cancel) {}
        } message: {
            Text("位置は訪問を見つけるためだけに使い、着いた時刻・地名・座標だけをかけら帳に送ります。このあと位置の許可を「使用中のみ」→「常に」の順に尋ねます。")
        }
    }
}
