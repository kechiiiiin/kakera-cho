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
            Form {
                Section {
                    LabeledContent("いまの Client ID", value: AccessTokenStore.hint ?? "なし")
                    SecureField("CF-Access-Client-Id", text: $clientID)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("CF-Access-Client-Secret", text: $clientSecret)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("保存") { save() }
                        .disabled(clientID.trimmingCharacters(in: .whitespaces).isEmpty || clientSecret.trimmingCharacters(in: .whitespaces).isEmpty)
                    if let message { Text(message).font(Theme.gothic(12)).foregroundStyle(Theme.muted) }
                } header: {
                    Text("Access のサービストークン").font(Theme.mincho(14, bold: true)).foregroundStyle(Theme.ink)
                } footer: {
                    Text("かけら帳と港の両方に同じトークンを付けます。ビルドに入っている値より、ここで入れた値が優先されます。")
                        .font(Theme.gothic(11)).foregroundStyle(Theme.muted).lineSpacing(3)
                }
                .listRowBackground(Theme.sheet)

                Section {
                    ForEach(Service.allCases, id: \.self) { s in
                        LabeledContent(s.name, value: ServerConfig.baseURL(s)?.absoluteString ?? "なし")
                    }
                } header: {
                    Text("つなぎ先").font(Theme.mincho(14, bold: true)).foregroundStyle(Theme.ink)
                }
                .listRowBackground(Theme.sheet)
            }
            .font(Theme.gothic(15))
            .scrollContentBackground(.hidden)
            .background(Theme.paper.ignoresSafeArea())
            .navigationTitle("設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.paper, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("設定").font(Theme.mincho(17, bold: true, relativeTo: .headline)).foregroundStyle(Theme.ink)
                }
                ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } }
            }
        }
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
