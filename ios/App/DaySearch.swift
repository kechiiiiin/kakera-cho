import SwiftUI

// 1日のページの検索（かけら帳1日のページ設計・段階5）: かけら（本文・流れもかたちの中も）と場所の名前を、日付つきで新しい順に並べる。
// 押すとその日へ。Web の GET /api/search（src/pages/api/search.ts）の kakera・places を読む（かたち一覧の検索は results を読む・別のまま）。

struct KakeraHit: Decodable, Hashable { let id: String; let writtenAt: String; let excerpt: String }
struct PlaceHit: Decodable, Hashable { let id: String; let at: String; let name: String }

/// 検索の一行（かけらか場所）
struct DayHit: Identifiable, Hashable {
    enum Kind: Hashable { case kakera, basho }
    let id: String
    let kind: Kind
    /// +09:00 付き
    let at: String
    let text: String

    var day: String { String(at.prefix(10)) }
    var time: String { String(at.dropFirst(11).prefix(5)) }

    /// 新しい順に1本にする
    static func merge(kakera: [KakeraHit], places: [PlaceHit]) -> [DayHit] {
        (kakera.map { DayHit(id: "k-\($0.id)", kind: .kakera, at: $0.writtenAt, text: $0.excerpt) }
            + places.map { DayHit(id: "b-\($0.id)", kind: .basho, at: $0.at, text: $0.name) })
            .sorted { $0.at != $1.at ? $0.at > $1.at : $0.id < $1.id }
    }
}

/// 検索のシート。打つたびに引く（300ms 待ってから・Enter では引かない）
struct DaySearchSheet: View {
    let onPick: (String) -> Void
    @State private var query = ""
    @State private var hits: [DayHit]?
    @State private var error: String?
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("さがす").font(Theme.gothic(17, weight: .medium)).foregroundStyle(Theme.ink)
                Spacer()
                Button("閉じる") { dismiss() }.buttonStyle(LinkButtonStyle())
            }
            .padding(.bottom, 12)
            TextField("かけらの言葉・場所の名前", text: $query)
                .font(Theme.gothic(15)).padding(.horizontal, 12).frame(minHeight: 40)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                .focused($focused)
                .accessibilityIdentifier("daySearchField")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let error { Text(error).font(Theme.gothic(12)).foregroundStyle(Theme.accent).padding(.vertical, 10) }
                    if let hits, hits.isEmpty {
                        Text("見つかりませんでした").font(Theme.gothic(13)).foregroundStyle(Theme.muted).padding(.vertical, 12)
                    }
                    ForEach(hits ?? []) { h in
                        Button { onPick(h.day); dismiss() } label: { row(h) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("hit-\(h.id)")
                            .ruledRow(first: h.id == hits?.first?.id)
                    }
                }
                .padding(.top, 10)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .padding(.horizontal, 18).padding(.top, 22)
        .background(Theme.paper.ignoresSafeArea())
        .onAppear { focused = true }
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !q.isEmpty else { hits = nil; return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            do {
                let r = try await API.shared.daySearch(q)
                if !Task.isCancelled { hits = DayHit.merge(kakera: r.kakera, places: r.places); error = nil }
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }

    private func row(_ h: DayHit) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(JST.title(h.day)).font(Theme.mono(11)).foregroundStyle(Theme.ink)
                Text(h.time).font(Theme.mono(11)).foregroundStyle(Theme.muted)
            }
            .frame(width: 88, alignment: .leading)
            Group {
                if h.kind == .kakera {
                    Rectangle().fill(Theme.ink).frame(width: 5, height: 5)
                } else {
                    Circle().strokeBorder(Theme.ink, lineWidth: 1.2).frame(width: 8, height: 8)
                }
            }
            .frame(width: 10, height: 10).padding(.top, 4)
            Text(h.text).font(Theme.gothic(14)).foregroundStyle(Theme.ink).lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

/// 書き出したファイルを渡す共有シート（UIActivityViewController）
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
