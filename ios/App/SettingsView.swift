import SwiftUI

/// サービストークンの入れ直し（ふつうは TestFlight のビルドに埋め込んであるので触らない）。
/// 保存はボタンだけ（欄の Return で保存しない）
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var clientID = ""
    @State private var clientSecret = ""
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .center) {
                        Text("設定").font(Theme.gothic(17, weight: .medium)).foregroundStyle(Theme.ink)
                        Spacer()
                        Button("閉じる") { dismiss() }.buttonStyle(LinkButtonStyle())
                    }

                    SectionHead(title: "Access のサービストークン")
                    VStack(alignment: .leading, spacing: 10) {
                        row("いまの Client ID", AccessTokenStore.hint ?? "なし")
                        field("CF-Access-Client-Id", text: $clientID)
                        field("CF-Access-Client-Secret", text: $clientSecret)
                        HStack(spacing: 10) {
                            Button("保存") { save() }
                                .buttonStyle(GhostButtonStyle())
                                .disabled(clientID.trimmingCharacters(in: .whitespaces).isEmpty || clientSecret.trimmingCharacters(in: .whitespaces).isEmpty)
                            if let message { Text(message).font(Theme.gothic(12)).foregroundStyle(Theme.muted) }
                        }
                        Text("かけら帳と港の両方に同じトークンを付けます。ビルドに入っている値より、ここで入れた値が優先されます。")
                            .font(Theme.gothic(11)).foregroundStyle(Theme.muted).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    SectionHead(title: "つなぎ先")
                    VStack(spacing: 0) {
                        ForEach(Array(Service.allCases.enumerated()), id: \.offset) { i, s in
                            row(s.name, ServerConfig.baseURL(s)?.absoluteString ?? "なし")
                                .padding(.vertical, 12)
                                .ruledRow(last: i == Service.allCases.count - 1)
                        }
                    }
                }
                .padding(.horizontal, 18).padding(.top, 20).padding(.bottom, 40)
            }
            .background(Theme.paper.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    /// 名前（灰）と値（等幅）の一行
    private func row(_ name: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(name).font(Theme.gothic(13)).foregroundStyle(Theme.ink)
            Spacer(minLength: 8)
            Text(value).font(Theme.mono(11.5)).foregroundStyle(Theme.muted)
                .lineLimit(1).truncationMode(.middle)
        }
    }

    /// 罫 1pt・角丸 2pt の入力欄（Return で保存しない）
    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        SecureField(placeholder, text: text)
            .font(Theme.mono(13))
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .padding(10)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
    }

    private func save() {
        do {
            try AccessTokenStore.clientID.save(clientID.trimmingCharacters(in: .whitespacesAndNewlines))
            try AccessTokenStore.clientSecret.save(clientSecret.trimmingCharacters(in: .whitespacesAndNewlines))
            clientID = ""
            clientSecret = ""
            message = "保存しました"
        } catch {
            message = error.localizedDescription
        }
    }
}
