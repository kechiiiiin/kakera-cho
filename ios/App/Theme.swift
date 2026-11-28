import SwiftUI
import UIKit

/// Web 版の書く側（src/styles/app.css 冒頭 §9「素っ気ない道具」）に揃えた見た目。
///   ゴシック（ヒラギノ角ゴ）。カードと影を使わず罫線だけで区切る。角丸 2pt 以下。
///   塗りの主ボタンは書く画面の「保存」だけ（黒の塗りに白文字）。ほかは 1pt の罫の枠・灰の文字か、文字だけのリンク。
///   取り返しのつかない操作（削除）は朱の文字と枠。差し色は朱ひとつだけ（リンクと行動）。絵文字を使わない。
///   等幅は数字・記号・ラベルだけ。ダークモード対応はしない（アプリは常にライト）。
/// 色は #app の変数と同じ値: --bg #fdfdfc・--fg #17171a・--muted #86837c・--line #e4e1da・--accent #b03a2e
enum Theme {
    /// 地（--bg）
    static let paper = Color(uiColor: UIColor(hex: 0xFDFDFC))
    /// 文字（--fg）
    static let ink = Color(uiColor: UIColor(hex: 0x17171A))
    /// 灰（--muted）
    static let muted = Color(uiColor: UIColor(hex: 0x86837C))
    /// 罫（--line）
    static let line = Color(uiColor: UIColor(hex: 0xE4E1DA))
    /// 朱（--accent）。リンクと行動だけに使う
    static let accent = Color(uiColor: UIColor(hex: 0xB03A2E))

    /// 罫の太さ（Web の 1px）
    static let hairline: CGFloat = 1
    /// 角丸（Web の 2px）
    static let radius: CGFloat = 2

    // MARK: 書体

    private static func font(_ names: [String], size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        for n in names where UIFont(name: n, size: size) != nil {
            return .custom(n, size: size, relativeTo: style)
        }
        return .system(size: size)
    }

    /// ヒラギノ角ゴ（本文・ボタン・見出し）。W3（ふつう）・W5（500）・W6（600/700）
    static func gothic(_ size: CGFloat, weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        let names: [String]
        switch weight {
        case .semibold, .bold, .heavy, .black: names = ["HiraginoSans-W6", "HiraKakuProN-W6"]
        case .medium: names = ["HiraginoSans-W5", "HiraginoSans-W4", "HiraginoSans-W3", "HiraKakuProN-W3"]
        default: names = ["HiraginoSans-W3", "HiraKakuProN-W3"]
        }
        return font(names, size: size, relativeTo: style)
    }

    static func gothic(_ size: CGFloat, bold: Bool) -> Font { gothic(size, weight: bold ? .semibold : .regular) }

    /// 明朝（読む側・かたちの組版。Web の .mode-read と同じヒラギノ明朝）
    static func mincho(_ size: CGFloat, bold: Bool = false) -> Font {
        font(bold ? ["HiraMinProN-W6"] : ["HiraMinProN-W3"], size: size, relativeTo: .body)
    }

    /// 等幅（数字・記号・ラベルだけ。ui-monospace / SF Mono）
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    static func uiGothic(_ size: CGFloat) -> UIFont {
        UIFont(name: "HiraginoSans-W3", size: size) ?? UIFont(name: "HiraKakuProN-W3", size: size) ?? .systemFont(ofSize: size)
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

// MARK: - 罫・見出し

/// 1pt の罫（横線）
struct Rule: View {
    var body: some View { Rectangle().fill(Theme.line).frame(height: Theme.hairline) }
}

/// 節の見出し（.section-head: 11pt・600・灰・字間 .06em）と、右に添えるもの
struct SectionHead<Trailing: View>: View {
    let title: String
    var count: Int? = nil
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).sectionHeading()
            if let count, count > 0 {
                Text("\(count)").font(Theme.mono(11)).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 4)
            trailing()
        }
        .padding(.top, 26).padding(.bottom, 10)
    }
}

/// 大きな節の見出し（「かけら」「思い出す材料」）。黒 14pt 700・上に広い余白・下に黒の 1pt 罫
/// （Web のタブの「選ばれている」下線と同じ黒の線の使い方。行の罫 #e4e1da・塊の頭の灰の罫と区別する）
struct MajorHead<Trailing: View>: View {
    let title: String
    var count: Int? = nil
    var top: CGFloat = 44
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 8) {
                Text(title).font(Theme.gothic(14, weight: .bold)).tracking(14 * 0.04).foregroundStyle(Theme.ink)
                if let count, count > 0 {
                    Text("\(count)").font(Theme.mono(11.5)).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 4)
                trailing()
            }
            .frame(minHeight: 36)
            .padding(.bottom, 6)
            Rectangle().fill(Theme.muted).frame(height: Theme.hairline)
        }
        .padding(.top, top)
    }
}

extension MajorHead where Trailing == EmptyView {
    init(title: String, count: Int? = nil, top: CGFloat = 44) {
        self.init(title: title, count: count, top: top) { EmptyView() }
    }
}

extension SectionHead where Trailing == EmptyView {
    init(title: String, count: Int? = nil) {
        self.init(title: title, count: count) { EmptyView() }
    }
}

extension View {
    /// 節の見出しの字（11pt・600・灰・字間 .06em）
    func sectionHeading() -> some View {
        self.font(Theme.gothic(11, weight: .semibold)).foregroundStyle(Theme.muted).tracking(11 * 0.06)
    }

    /// .page-sub（灰 12.5pt の小さな一行）
    func pageSub() -> some View {
        self.font(Theme.gothic(12.5)).foregroundStyle(Theme.muted)
    }

    /// 罫で区切った並びの一行（上に罫。最後の行は lastRule で下にも罫）
    func ruledRow(first: Bool = false, last: Bool = false) -> some View {
        VStack(spacing: 0) {
            if !first { Rule() }
            self
            if last { Rule() }
        }
    }
}

// MARK: - ボタン（Web の .btn-* と同じ作法）

/// .btn-primary: 黒の塗りに白文字。**書く画面の「保存」だけ**に使う
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.gothic(12, weight: .bold)).tracking(12 * 0.02)
            .foregroundStyle(Theme.paper)
            .padding(.horizontal, 18).frame(minHeight: 38)
            .background(Theme.ink, in: RoundedRectangle(cornerRadius: Theme.radius))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.35)
    }
}

/// .btn-cta: 朱の枠と文字（塗らない）。前へ進める一つの行動に
struct CTAButtonStyle: ButtonStyle {
    var fullWidth = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.gothic(12, weight: .semibold)).tracking(12 * 0.02)
            .foregroundStyle(enabled ? Theme.accent : Theme.muted)
            .padding(.horizontal, 18).frame(minHeight: 38)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background(Theme.paper, in: RoundedRectangle(cornerRadius: Theme.radius))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(enabled ? Theme.accent : Theme.line, lineWidth: Theme.hairline))
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// .icon-btn / .btn-ghost: 1pt の罫の枠・灰の文字
struct GhostButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.gothic(12, weight: .medium))
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, compact ? 0 : 14).frame(minWidth: 36, minHeight: 36)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
            .contentShape(Rectangle())
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
    }
}

/// .btn-danger: 朱の文字と枠（取り返しのつかない操作）
struct DangerButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.gothic(12, weight: .medium))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 14).frame(minHeight: 36)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.accent, lineWidth: Theme.hairline))
            .contentShape(Rectangle())
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
    }
}

/// .link-btn: 文字だけ（12pt・500）。既定は黒、リンクは朱
struct LinkButtonStyle: ButtonStyle {
    var color: Color = Theme.ink
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.gothic(12, weight: .medium))
            .foregroundStyle(enabled ? color : Theme.muted)
            .frame(minHeight: 38)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
