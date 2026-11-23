import ObjectiveC
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// 書く欄: Web 版と同じ k-editor を WKWebView に載せる（ios/editor-web/ を束ねた App/EditorWeb/kedit.* を同梱・ネットから読まない）。
///
/// 橋渡し（ios/editor-web/entry.ts の頭に一覧）:
///   - 初期の Markdown とリンクカードは callAsyncJavaScript の引数で渡す（文字列連結で JS を組まない）
///   - 変更のたびに JS から serialize した Markdown が届く。保存は Swift のボタンで、直前に getMarkdown() を取り直して使う
///   - 写真は JS から頼まれて Swift が選ばせ（PHPicker）・JPEG にし・POST /api/photo で上げ、URL を返す
///   - 写真・カードの画像（/api/photo/...）は kakera-editor://app/api/photo/... を WKURLSchemeHandler が認証つきで中継する
/// ⚠️ サービストークンは WebView に渡さない。WebView が外へ取りに行くことも無い（http(s) へのナビゲーションは Safari へ回す）
@MainActor
final class KEditorController: NSObject, ObservableObject {
    static let scheme = "kakera-editor"

    let webView: WKWebView
    /// 変更のたび
    var onChange: ((String) -> Void)?
    /// 失敗の知らせ（写真を上げられなかった等）
    var onError: ((String) -> Void)?
    /// 写真を上げる先の鍵（かけらの id と、写真の key に使う written_at）
    var kakeraId = ""
    var photoWrittenAt = ""

    private var initial: (markdown: String, cards: LinkCards, focus: Bool)?
    private var ready = false
    private var picked: [String: NSItemProvider] = [:]
    private var pickContinuation: CheckedContinuation<[NSItemProvider], Never>?

    override init() {
        let config = WKWebViewConfiguration()
        let handler = PhotoSchemeHandler()
        config.setURLSchemeHandler(handler, forURLScheme: Self.scheme)
        config.websiteDataStore = .nonPersistent()
        config.dataDetectorTypes = []
        webView = NoAccessoryWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "kakera")
        #if DEBUG
        // 読み込みや JS の失敗を Xcode のコンソールへ（検査用）
        let report = """
        window.addEventListener('error', function (e) {
          window.webkit.messageHandlers.kakera.postMessage({ type: 'log', message: String(e.message) + ' @' + e.filename + ':' + e.lineno });
        });
        window.addEventListener('unhandledrejection', function (e) {
          window.webkit.messageHandlers.kakera.postMessage({ type: 'log', message: 'unhandled: ' + String(e.reason) });
        });
        """
        config.userContentController.addUserScript(WKUserScript(source: report, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif

        webView.isOpaque = false
        webView.backgroundColor = UIColor(hex: 0xFDFDFC)
        webView.scrollView.backgroundColor = UIColor(hex: 0xFDFDFC)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.overrideUserInterfaceStyle = .light
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.load(URLRequest(url: URL(string: "\(Self.scheme)://app/kedit.html")!))
    }

    /// 最初の本文を入れる（読み込みが済んでいなければ、済んだときに入れる）
    func start(markdown: String, cards: LinkCards, focus: Bool) {
        initial = (markdown, cards, focus)
        if ready { push() }
    }

    private func push() {
        guard let initial else { return }
        var options: [String: Any] = [
            "markdown": initial.markdown,
            "cards": Self.cardsJSON(initial.cards),
            "placeholder": "いま、何が浮かびましたか",
            "focus": initial.focus,
        ]
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-kakeraRoundTripCheck") { options["checkRoundTrip"] = true }
        #endif
        webView.callAsyncJavaScript("window.kakeraInit(init)", arguments: ["init": options], in: nil, in: .page) { _ in }
        if initial.focus { focusEditor() }
    }

    /// 開いたらキーボードを出して本文へ（WebView を先に first responder にしてから JS で focus）
    func focusEditor() {
        webView.becomeFirstResponder()
        webView.callAsyncJavaScript("window.kakeraFocus && window.kakeraFocus()", arguments: [:], in: nil, in: .page) { _ in }
    }

    /// いまの本文（保存の直前に取り直す）
    func currentMarkdown() async -> String? {
        guard ready else { return nil }
        let r = try? await webView.callAsyncJavaScript("return window.kakeraGetMarkdown()", arguments: [:], contentWorld: .page)
        return r as? String
    }

    private static func cardsJSON(_ cards: LinkCards) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, c) in cards {
            out[k] = ["url": c.url, "title": c.title, "description": c.description, "siteName": c.siteName ?? "",
                      "domain": c.domain, "image": c.image as Any? ?? NSNull()]
        }
        return out
    }

    // MARK: 写真

    /// PHPicker で選ばせ、選んだ写真に札を付けて返す（上げるのは札ごとに upload で）
    private func pick() async -> [String] {
        let providers = await withCheckedContinuation { (c: CheckedContinuation<[NSItemProvider], Never>) in
            pickContinuation = c
            var conf = PHPickerConfiguration(photoLibrary: .shared())
            conf.filter = .images
            conf.selectionLimit = 10
            conf.selection = .ordered
            let picker = PHPickerViewController(configuration: conf)
            picker.delegate = self
            guard let top = Self.topViewController() else { c.resume(returning: []); pickContinuation = nil; return }
            top.present(picker, animated: true)
        }
        return providers.map { p in
            let token = "photo-" + UUID().uuidString
            picked[token] = p
            return token
        }
    }

    private func upload(token: String, n: Int) async throws -> String {
        guard let provider = picked.removeValue(forKey: token) else { throw APIError.transport("選んだ写真が見つかりません") }
        let data = try await Self.loadImageData(provider)
        let jpeg = try JPEG.make(from: data) // HEIC もここで JPEG に
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-kakeraDryRunUpload") {
            print("[kakera-editor] upload 直前で止めました（試験）: token=\(token) n=\(n) jpeg=\(jpeg.count)B kakeraId=\(kakeraId)")
            throw APIError.transport("試験のため上げずに止めました")
        }
        #endif
        return try await API.shared.uploadPhoto(jpeg: jpeg, kakeraId: kakeraId, writtenAt: photoWrittenAt, n: n)
    }

    private static func loadImageData(_ p: NSItemProvider) async throws -> Data {
        try await withCheckedThrowingContinuation { c in
            p.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, error in
                if let data { c.resume(returning: data) } else {
                    c.resume(throwing: error ?? APIError.transport("写真を読めませんでした"))
                }
            }
        }
    }

    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController
        while let p = top?.presentedViewController { top = p }
        return top
    }
}

extension KEditorController: WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return (nil, nil) }
        switch type {
        case "ready":
            #if DEBUG
            print("[kakera-editor] ready")
            #endif
            ready = true
            push()
            return (nil, nil)
        case "change":
            if let md = body["markdown"] as? String { onChange?(md) }
            return (nil, nil)
        case "pick":
            return (await pick(), nil)
        case "upload":
            let token = body["token"] as? String ?? ""
            let n = (body["n"] as? NSNumber)?.intValue ?? 1
            do {
                return (try await upload(token: token, n: n), nil)
            } catch {
                let m = "写真を上げられませんでした: \(error.localizedDescription)"
                onError?(m)
                return (nil, m)
            }
        case "log":
            #if DEBUG
            print("[kakera-editor] js: \(body["message"] ?? "")")
            #endif
            return (nil, nil)
        case "roundtrip":
            #if DEBUG
            print("[kakera-roundtrip] id=\(kakeraId) same=\(body["same"] ?? "?") in=\(body["inLength"] ?? "?") out=\(body["outLength"] ?? "?")")
            #endif
            return (nil, nil)
        default:
            return (nil, nil)
        }
    }
}

extension KEditorController: PHPickerViewControllerDelegate {
    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let providers = results.map(\.itemProvider)
        Task { @MainActor in
            picker.dismiss(animated: true)
            pickContinuation?.resume(returning: providers)
            pickContinuation = nil
        }
    }
}

extension KEditorController: WKNavigationDelegate, WKUIDelegate {
    /// 同梱のページだけを読む。本文のリンク・カードを押したら Safari で開く
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        if url.scheme == Self.scheme { return .allow }
        if url.scheme == "http" || url.scheme == "https" { await UIApplication.shared.open(url) }
        return .cancel
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        print("[kakera-editor] 読み込めませんでした: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        #if DEBUG
        print("[kakera-editor] 読み込み完了")
        #endif
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" { UIApplication.shared.open(url) }
        return nil
    }
}

/// kakera-editor://app/ の中継。同梱の kedit.* と、/api/photo/...（写真・カードの画像）だけを返す
final class PhotoSchemeHandler: NSObject, WKURLSchemeHandler {
    private var stopped = Set<ObjectIdentifier>()

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path
        if path.hasPrefix("/api/photo/") {
            let id = ObjectIdentifier(task)
            Task { @MainActor in
                do {
                    let data = try await API.shared.photoData(path: path)
                    guard !self.stopped.contains(id) else { return }
                    let type = Self.imageType(data)
                    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                                    headerFields: ["Content-Type": type, "Cache-Control": "max-age=3600"])!)
                    task.didReceive(data)
                    task.didFinish()
                } catch {
                    guard !self.stopped.contains(id) else { return }
                    task.didFailWithError(error)
                }
            }
            return
        }
        let name = (path as NSString).lastPathComponent
        let ext = (name as NSString).pathExtension
        let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8"]
        guard name.hasPrefix("kedit."), let type = types[ext],
              let file = Bundle.main.url(forResource: (name as NSString).deletingPathExtension, withExtension: ext),
              let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    private static func imageType(_ d: Data) -> String {
        guard let b = d.first else { return "application/octet-stream" }
        switch b {
        case 0xFF: return "image/jpeg"
        case 0x89: return "image/png"
        case 0x47: return "image/gif"
        case 0x52: return "image/webp"
        default: return "image/jpeg"
        }
    }
}

/// キーボードの上の「＜ ＞ 完了」の帯を出さない WKWebView。
/// 入力を受ける中の view（WKContentView）の inputAccessoryView を、実行時に作った子クラスで nil にする
final class NoAccessoryWebView: WKWebView {
    private static var patched: [String: AnyClass] = [:]

    override func didMoveToWindow() {
        super.didMoveToWindow()
        removeInputAccessory()
    }

    func removeInputAccessory() {
        guard let content = scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }) else { return }
        let base: AnyClass = type(of: content)
        let baseName = NSStringFromClass(base)
        if baseName.hasSuffix("_KakeraNoAccessory") { return }
        let name = baseName + "_KakeraNoAccessory"
        var cls: AnyClass? = Self.patched[name] ?? NSClassFromString(name)
        if cls == nil, let made = objc_allocateClassPair(base, name, 0) {
            let block: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
            let imp = imp_implementationWithBlock(block)
            let sel = #selector(getter: UIResponder.inputAccessoryView)
            let types = method_getTypeEncoding(class_getInstanceMethod(UIResponder.self, sel)!)
            class_addMethod(made, sel, imp, types)
            objc_registerClassPair(made)
            cls = made
        }
        guard let cls else { return }
        Self.patched[name] = cls
        object_setClass(content, cls)
    }
}

/// SwiftUI に置く口
struct KEditorView: UIViewRepresentable {
    let controller: KEditorController

    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
