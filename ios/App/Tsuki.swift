import SwiftUI

// 月カレンダー（かけら帳1日のページ設計・段階5）: 日付の見出しを押すと出るシート。書いた日（かけらか場所がある日）に印、気分を小さく。
// Web の GET /api/days?month=YYYY-MM（src/pages/api/days.ts・src/lib/kakera/day-search.ts の monthDays）を読む。

/// その月の日ごと（Web の DaySummary と同じ形）
struct DaySummaryRow: Decodable, Hashable {
    let date: String
    let kakera: Int
    let places: Int
    let mood: String?

    var written: Bool { kakera + places > 0 }
}

enum Tsuki {
    /// 'YYYY-MM'
    static func monthKey(_ day: String) -> String { String(day.prefix(7)) }

    static func shift(_ month: String, by n: Int) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return month }
        let total = parts[0] * 12 + (parts[1] - 1) + n
        return String(format: "%04d-%02d", total / 12, total % 12 + 1)
    }

    /// 月の升目（日曜はじまり）。前の空き升は nil
    static func cells(_ month: String) -> [String?] {
        guard let first = JST.dayRange("\(month)-01")?.start else { return [] }
        let weekday = JST.calendar.component(.weekday, from: first) // 1 = 日
        let days = JST.calendar.range(of: .day, in: .month, for: first)?.count ?? 30
        return Array(repeating: nil, count: weekday - 1) + (1...days).map { String(format: "%@-%02d", month, $0) }
    }

    static func title(_ month: String) -> String {
        let p = month.split(separator: "-")
        guard p.count == 2, let m = Int(p[1]) else { return month }
        return "\(p[0])年\(m)月"
    }
}

/// 月カレンダーのシート。押すとその日へ。未来の日は押せない
struct TsukiSheet: View {
    let current: String
    let onPick: (String) -> Void
    @State private var month: String
    @State private var days: [String: DaySummaryRow] = [:]
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    init(current: String, onPick: @escaping (String) -> Void) {
        self.current = current
        self.onPick = onPick
        _month = State(initialValue: Tsuki.monthKey(current))
    }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)
    private var today: String { JST.todayKey }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 6) {
                Text(Tsuki.title(month)).font(Theme.mono(17, weight: .medium)).foregroundStyle(Theme.ink)
                    .accessibilityIdentifier("monthTitle")
                Spacer()
                Button { month = Tsuki.shift(month, by: -1) } label: { Image(systemName: "chevron.left").font(.system(size: 13)) }
                    .buttonStyle(GhostButtonStyle(compact: true)).accessibilityLabel("前の月").accessibilityIdentifier("prevMonth")
                Button { month = Tsuki.shift(month, by: 1) } label: { Image(systemName: "chevron.right").font(.system(size: 13)) }
                    .buttonStyle(GhostButtonStyle(compact: true)).disabled(month >= Tsuki.monthKey(today))
                    .accessibilityLabel("次の月").accessibilityIdentifier("nextMonth")
                Button("閉じる") { dismiss() }.buttonStyle(LinkButtonStyle()).padding(.leading, 6)
            }
            .padding(.bottom, 14)
            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(Array(["日", "月", "火", "水", "木", "金", "土"].enumerated()), id: \.offset) { _, w in
                    Text(w).sectionHeading().frame(maxWidth: .infinity).padding(.bottom, 6)
                }
                ForEach(Array(Tsuki.cells(month).enumerated()), id: \.offset) { _, d in
                    if let d { cell(d) } else { Color.clear.frame(height: 52) }
                }
            }
            Rule().padding(.top, 6)
            HStack(spacing: 14) {
                HStack(spacing: 5) { Circle().fill(Theme.ink).frame(width: 4, height: 4); Text("書いた日") }
                HStack(spacing: 5) { Text("嬉").font(Theme.gothic(10)).foregroundStyle(Theme.accent); Text("気分") }
            }
            .font(Theme.gothic(11)).foregroundStyle(Theme.muted).padding(.top, 8)
            if let error { Text(error).font(Theme.gothic(12)).foregroundStyle(Theme.accent).padding(.top, 8) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18).padding(.top, 22)
        .background(Theme.paper.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .task(id: month) {
            let target = month
            do {
                let rows = try await API.shared.days(month: target)
                if target == month { days = Dictionary(uniqueKeysWithValues: rows.map { ($0.date, $0) }); error = nil }
            } catch {
                if target == month { days = [:]; self.error = error.localizedDescription }
            }
        }
    }

    private func cell(_ d: String) -> some View {
        let future = d > today
        let s = days[d]
        let isCurrent = d == current
        return Button {
            onPick(d)
            dismiss()
        } label: {
            VStack(spacing: 3) {
                Text("\(Int(d.suffix(2)) ?? 0)")
                    .font(Theme.mono(14, weight: d == today ? .semibold : .regular))
                    .foregroundStyle(future ? Theme.line : Theme.ink)
                HStack(spacing: 2) {
                    if s?.written == true { Circle().fill(Theme.ink).frame(width: 4, height: 4) }
                    if let m = s?.mood { Text(m).font(Theme.gothic(9.5)).foregroundStyle(Theme.accent) }
                }
                .frame(height: 12)
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(isCurrent ? Theme.ink : .clear, lineWidth: Theme.hairline))
            .overlay(alignment: .bottom) {
                if d == today { Rectangle().fill(Theme.accent).frame(width: 14, height: 1.5).padding(.bottom, 2) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(future)
        .accessibilityLabel("\(Int(d.suffix(2)) ?? 0)日" + (s?.written == true ? "・書いた日" : "") + (s?.mood.map { "・気分 \($0)" } ?? ""))
        .accessibilityIdentifier("cal-\(d)")
    }
}
