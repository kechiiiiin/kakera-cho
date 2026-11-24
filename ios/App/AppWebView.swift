import SwiftUI
import WebKit

/// Web の画面（App.tsx まるごと）を WKWebView で開く。かたちにする・かたち一覧/読む・日記一覧・公開名変換・写真の選択・日記にする・ことば。
/// 設計: jinsei vault hestia/projects/blog-cms-design/かけら帳iOS構想.md §3.3（Web を直せば iPhone も同じに直る）
///
///   - 同梱: ios/editor-web/（kapp.html・app-entry.tsx）を `make editor-web` で App/EditorWeb/kapp.* に束ねたもの。kakera-editor://app/ から配る
///   - 初めの画面は URL の hash（kapp.html#katachi など）。App.tsx の start に入る
///   - 通信: 画面の /api/* は BundleSchemeHandler（relayAPI）が本番のかけら帳へサービストークンをつけて中継する。
///     ⚠️ 鍵は WebView に渡さない（JS から読めるところに置かない）
///   - 外へのリンク（http/https の本体の移動・別窓）は Safari で開く。埋め込み（YouTube・Spotify の iframe）だけは中で読む
///   - 顔の検出（MediaPipe）は Web と同じく CDN（cdn.jsdelivr.net・storage.googleapis.com）から読む
enum WebStart: String, Identifiable {
    case compose
    case katachi
    case nikki
    case words

    var id: String { rawValue }
}

@MainActor
final class AppWebController: NSObject, ObservableObject {
    let webView: WKWebView

    init(start: WebStart) {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(relayAPI: true), forURLScheme: KEditorController.scheme)
        config.websiteDataStore = .nonPersistent()
        config.dataDetectorTypes = []
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        #if DEBUG
        // 読み込みや JS の失敗を Xcode のコンソールへ（検査用）。名前は書く欄（kakera）と分ける
        config.userContentController.add(self, name: "kakeraLog")
        let report = """
        window.addEventListener('error', function (e) {
          window.webkit.messageHandlers.kakeraLog.postMessage('error: ' + String(e.message) + ' @' + e.filename + ':' + e.lineno);
        });
        window.addEventListener('unhandledrejection', function (e) {
          window.webkit.messageHandlers.kakeraLog.postMessage('unhandled: ' + String(e.reason));
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
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.load(URLRequest(url: URL(string: "\(KEditorController.scheme)://app/kapp.html#\(start.rawValue)")!))
    }

    #if DEBUG
    /// 検査: 起動引数 -kakeraWebProbe のとき、読み込み後に CDN（MediaPipe の wasm とモデル）へ届くか・顔の検出器が作れるか・
    /// 中継で multipart の本文が届くか（file を付けない POST /api/photo → 400「file がありません」なら本文は届いている。何も保存されない）を
    /// コンソールへ出す
    private func probe() {
        let js = """
        const out = [];
        const v = '0.10.35';
        const wasm = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + v + '/wasm';
        const model = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite';
        try { const r = await fetch(wasm + '/vision_wasm_internal.wasm'); out.push('wasm ' + r.status + ' ' + (await r.arrayBuffer()).byteLength); } catch (e) { out.push('wasm NG ' + e); }
        try { const r = await fetch(model); out.push('model ' + r.status + ' ' + (await r.arrayBuffer()).byteLength); } catch (e) { out.push('model NG ' + e); }
        try {
          const m = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + v + '/vision_bundle.mjs');
          const fs = await m.FilesetResolver.forVisionTasks(wasm);
          const d = await m.FaceDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: model, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.4 });
          const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').fillRect(0, 0, 64, 64);
          out.push('detector OK faces=' + d.detect(c).detections.length);
          d.close();
        } catch (e) { out.push('detector NG ' + e); }
        try {
          const f = new FormData(); f.append('kakera_id', 'probe'); f.append('n', '1');
          const r = await fetch('/api/photo', { method: 'POST', body: f });
          out.push('multipart ' + r.status + ' ' + (await r.text()));
        } catch (e) { out.push('multipart NG ' + e); }
        try {
          const r = await fetch('/api/katachi');
          out.push('relay-headers ' + r.status + ' [' + [...r.headers.keys()].join(',') + '] cookie=' + JSON.stringify(document.cookie));
        } catch (e) { out.push('relay-headers NG ' + e); }
        return out.join(' | ');
        """
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
            switch r {
            case .success(let v): print("[kakera-web-probe] \(v)")
            case .failure(let e): print("[kakera-web-probe] 失敗: \(e)")
            }
        }
    }
    #endif
}

#if DEBUG
extension AppWebController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        print("[kakera-web] js: \(message.body)")
    }
}
#endif

extension AppWebController: WKNavigationDelegate, WKUIDelegate {
    /// 同梱のページだけを本体で読む。本体を外へ移すリンクは Safari で開く。埋め込み（iframe）の読み込みはそのまま通す
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        if url.scheme == KEditorController.scheme { return .allow }
        let isMain = navigationAction.targetFrame?.isMainFrame ?? true
        if !isMain { return .allow } // YouTube・Spotify・X の埋め込み
        if url.scheme == "http" || url.scheme == "https" { await UIApplication.shared.open(url) }
        return .cancel
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        print("[kakera-web] 読み込めませんでした: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        #if DEBUG
        print("[kakera-web] 読み込み完了 \(webView.url?.absoluteString ?? "")")
        if ProcessInfo.processInfo.arguments.contains("-kakeraWebProbe") { probe() }
        #endif
    }

    /// target="_blank" のリンク（本文のリンク・リンクカード・日記の URL）は Safari で開く
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" { UIApplication.shared.open(url) }
        return nil
    }

    /// window.confirm（消す・解く・保存せずに進む の念押し）。WKWebView は既定では常に「いいえ」になるので、ここで出す
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        guard let top = KEditorController.topViewController() else { return false }
        return await withCheckedContinuation { c in
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "キャンセル", style: .cancel) { _ in c.resume(returning: false) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in c.resume(returning: true) })
            top.present(a, animated: true)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        guard let top = KEditorController.topViewController() else { return }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in c.resume() })
            top.present(a, animated: true)
        }
    }
}

private struct AppWebRepresentable: UIViewRepresentable {
    let controller: AppWebController
    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// 全画面で開く Web の画面。Web の上の帯とタブは隠し（editor-web/app.css）、アプリの帯（左に「‹ かけら」・下に罫）を置いて
/// 日ごとの画面から続いて見えるようにする（2026-11-24 本人「別サイトに行っているような違和感」）。常にライト
struct AppWebScreen: View {
    @StateObject private var controller: AppWebController
    @Environment(\.dismiss) private var dismiss

    init(start: WebStart) {
        _controller = StateObject(wrappedValue: AppWebController(start: start))
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    Button { dismiss() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left").font(.system(size: 14, weight: .regular))
                            Text("かけら").font(Theme.gothic(15, weight: .medium))
                        }
                        .frame(minHeight: 36)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(LinkButtonStyle(color: Theme.ink))
                    .accessibilityIdentifier("closeWeb")
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 6)
                Rule()
            }
            .background(Theme.paper.ignoresSafeArea(edges: .top))
            AppWebRepresentable(controller: controller)
        }
        .background(Theme.paper.ignoresSafeArea())
            .preferredColorScheme(.light)
    }
}
