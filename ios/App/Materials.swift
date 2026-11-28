import SwiftUI

/// 港（minato）の材料: その日の分を読んで、種類ごとの塊（付箋）で並べる。押すと書きかけのかけらになる
@MainActor
@Observable
final class MinatoMaterials {
    private(set) var groups: [MaterialGroup] = []
    private(set) var status: [MaterialStatus] = []
    private(set) var error: String?
    private(set) var loaded = false
    private(set) var collecting = false
    /// 「今すぐ集める」の結果のうち、うまくいかなかったもの（小さく理由を出す）
    private(set) var collectNotes: [String] = []
    private(set) var collectedDay: String?
    private var day = ""

    /// 並べる順（本人の挙げた順）。ここに無いものは後ろに港の順で
    static let order = ["tayori", "nobu", "health", "weather", "vault-log", "ambient", "hevy"]

    static func title(_ g: MaterialGroup) -> String {
        switch g.source {
        case "tayori": return "読んだ記事"
        case "nobu": return "本"
        case "health": return "からだ帳"
        case "weather": return "天気"
        case "vault-log": return "ヘスティアとのやりとり"
        case "ambient": return "Mac の作業"
        case "hevy": return "筋トレ（Hevy）"
        default: return g.label
        }
    }

    var sortedGroups: [MaterialGroup] {
        groups.filter { !$0.items.isEmpty }.sorted { a, b in
            (Self.order.firstIndex(of: a.source) ?? 99) < (Self.order.firstIndex(of: b.source) ?? 99)
        }
    }

    /// 港の最後の集めで error になった出どころ（材料が欠けている理由）
    var errors: [MaterialStatus] { status.filter { $0.status == "error" } }

    func load(_ day: String) async {
        if self.day != day {
            self.day = day
            groups = []
            status = []
            loaded = false
            error = nil
            if collectedDay != day { collectNotes = [] }
        }
        guard API.shared.isConfigured(.minato) else {
            loaded = true
            return
        }
        do {
            let r = try await API.shared.materials(on: day)
            guard r.date == self.day else { return }
            groups = r.groups
            status = r.status
            error = nil
        } catch {
            guard day == self.day else { return }
            groups = []
            self.error = error.localizedDescription
        }
        loaded = true
    }

    /// 今すぐ集める → 読み込み直す
    func collectNow() async {
        let target = day
        collecting = true
        defer { collecting = false }
        do {
            let r = try await API.shared.collect(on: target)
            collectedDay = target
            collectNotes = r.results.filter { $0.status != "ok" }.map { res in
                let what = res.status == "skipped" ? "見送り" : "失敗"
                return "\(res.label): \(what)" + (res.reason.map { "（\($0)）" } ?? "")
            }
            collectNotes.append("Mac から送るもの（ヘスティアとのやりとり・Mac の作業）は次の送り出しで入ります")
        } catch {
            collectedDay = target
            collectNotes = ["集められませんでした: \(error.localizedDescription)"]
        }
        await load(target)
    }

    // MARK: その日の一行（歩数）

    /// 例「19,138歩」。無ければ nil。
    /// 天気・気温は出さない（かけら帳1日のページ設計・2026-11-28 啓輔さん）。港の天気の材料はそのまま「思い出す材料」に残る
    var daySummary: String? {
        guard let day = groups.first(where: { $0.source == "health" })?.items.first(where: { $0.detail["kind"]?.string == "day" }),
              let steps = day.detail["metrics"]?.array.first(where: { $0["metric"]?.string == "steps" })?["value"]?.number else { return nil }
        return "\(Self.grouped(Int(steps.rounded())))歩"
    }

    private static func grouped(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }

    // MARK: 材料 → かけら

    /// 一覧に出す小さな添え書き
    static func sub(_ m: Material) -> String? {
        switch m.source {
        case "tayori": return m.detail["feed_title"]?.string
        case "vault-log": return m.detail["kind"]?.string
        case "health":
            if let k = m.detail["kcal"]?.number { return "\(Int(k.rounded()))kcal" }
            return nil
        case "hevy":
            let names = m.detail["exercises"]?.array.compactMap { $0["title"]?.string } ?? []
            return names.isEmpty ? nil : names.prefix(4).joined(separator: "・") + (names.count > 4 ? " ほか" : "")
        default: return nil
        }
    }

    static func displayTitle(_ m: Material) -> String {
        if m.source == "vault-log", let t = m.detail["title"]?.string { return t }
        return m.title
    }

    /// 書きかけの本文
    static func body(_ m: Material) -> String {
        switch m.source {
        case "tayori":
            // 第一弾と同じ: URL を一行に置き（リンクカードになる）、便りのコメントがあれば添える
            var b = m.url ?? m.title
            if let c = m.detail["comment"]?.string { b += "\n\n" + c }
            return b + "\n"
        case "hevy":
            let lines = (m.detail["exercises"]?.array ?? []).compactMap { e -> String? in
                guard let t = e["title"]?.string else { return nil }
                let sets = e["sets"]?.array.count ?? 0
                return sets > 0 ? "- \(t)（\(sets)セット）" : "- \(t)"
            }
            return ([m.title] + lines).joined(separator: "\n") + "\n"
        default:
            var b = displayTitle(m)
            if let u = m.url { b += "\n" + u }
            return b + "\n"
        }
    }
}

// MARK: - 画面の部品

/// 材料の塊の見出し（写真・行った場所・読んだ記事…）。罫は引かず、見出しの黒字と塊の間の余白だけで区切る（2026-11-24 本人「区切りの印象が強い」→ 4案から A「余白だけ」）。
/// 見出しは黒 12.5pt 600・件数は灰の等幅。塊と塊の間は 30pt 空ける
struct NoteHeading: View {
    let title: String
    var count: Int? = nil
    var note: String? = nil
    /// 塊の上の余白。大きな節の罫の直後の最初の塊（写真）だけ詰める
    var top: CGFloat = 30

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title).font(Theme.gothic(12.5, weight: .semibold)).foregroundStyle(Theme.ink)
                if let count, count > 0 {
                    Text("\(count)").font(Theme.mono(11)).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 4)
                if let note {
                    Text(note).font(Theme.gothic(10.5)).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            .padding(.top, 10).padding(.bottom, 8)
        }
        .padding(.top, top)
    }
}

/// 材料の一行（時刻・題・添え書き・使った印）。.frag-row と同じ形
struct MaterialLine: View {
    let time: Date?
    let title: String
    var sub: String? = nil
    var extra: String? = nil
    var used = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if let time {
                Text(JST.time(time))
                    .font(Theme.mono(11))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 36, alignment: .leading)
                    .padding(.top, 3)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(Theme.gothic(15)).foregroundStyle(used ? Theme.muted : Theme.ink).lineLimit(2).lineSpacing(4)
                    .multilineTextAlignment(.leading)
                if sub != nil || used {
                    HStack(spacing: 8) {
                        if let sub { Text(sub).font(Theme.gothic(11.5)).lineLimit(1) }
                        if used { UsedBadge() }
                    }
                    .foregroundStyle(Theme.muted)
                }
                if let extra {
                    Text(extra).font(Theme.gothic(12)).foregroundStyle(Theme.muted).lineLimit(3).lineSpacing(3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 12).padding(.horizontal, 2)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// 「かけらにした」印（灰の等幅のラベル）
struct UsedBadge: View {
    var body: some View {
        Text("かけらにした").font(Theme.mono(10.5)).foregroundStyle(Theme.muted).lineLimit(1).fixedSize()
    }
}

/// 港の一つの塊（見出し＋罫で区切った行）。長い塊は畳む
struct MaterialGroupNote: View {
    let group: MaterialGroup
    let used: UsedMarks
    let onMake: (Material) -> Void
    @State private var expanded = false

    private static let foldAt = 6

    var body: some View {
        let items = expanded ? group.items : Array(group.items.prefix(Self.foldAt))
        VStack(alignment: .leading, spacing: 0) {
            NoteHeading(title: MinatoMaterials.title(group), count: group.items.count)
            ForEach(items) { m in
                Button { onMake(m) } label: {
                    MaterialLine(time: m.occurredDate, title: MinatoMaterials.displayTitle(m), sub: MinatoMaterials.sub(m),
                                 extra: m.source == "tayori" ? m.detail["comment"]?.string : nil, used: used.isUsed(m))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("material-\(m.source)-\(m.externalId)")
                .ruledRow(last: m.id == items.last?.id)
            }
            if group.items.count > Self.foldAt {
                Button {
                    withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
                } label: {
                    if expanded {
                        Text("畳む")
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("ほかも見る")
                            Text("\(group.items.count - Self.foldAt)").font(Theme.mono(11)).foregroundStyle(Theme.muted)
                        }
                    }
                }
                .buttonStyle(LinkButtonStyle())
            }
        }
    }
}

/// 「思い出す材料」の見出しと「今すぐ集める」
struct MaterialsHeader: View {
    let minato: MinatoMaterials
    let canCollect: Bool
    let onCollect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MajorHead(title: "思い出す材料", top: 52) {
                if minato.collecting {
                    HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("集めています") }
                        .font(Theme.gothic(11)).foregroundStyle(Theme.muted)
                        .frame(minHeight: 36)
                } else {
                    Button("今すぐ集める", action: onCollect)
                        .buttonStyle(GhostButtonStyle())
                        .disabled(!canCollect)
                        .accessibilityIdentifier("collectNow")
                }
            }
            ForEach(minato.collectNotes, id: \.self) { n in
                Text(n).font(Theme.gothic(11)).foregroundStyle(Theme.muted).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(minato.errors, id: \.source) { s in
                Text("\(s.label): 前の集めで失敗" + (s.reason.map { "（\($0)）" } ?? ""))
                    .font(Theme.gothic(11)).foregroundStyle(Theme.accent)
                    .lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
