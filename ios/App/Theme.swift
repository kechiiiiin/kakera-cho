import SwiftUI
import UIKit

/// 紙の手帳らしい見た目（第二弾・本人の選択）。色は Web 版（src/styles/app.css の #app）と同じ値:
///   --bg #fdfdfc（生成りの紙）・--fg #17171a・--muted #86837c・--line #e4e1da・--accent #b03a2e（朱）
/// ダークモードは墨色の紙に同系の朱（Web 版はダークを持たないので、ここだけの値）
/// 書体: 日付と見出しは明朝（Hiragino Mincho ProN）、本文はヒラギノ角ゴ。端末に無ければシステムの書体
enum Theme {
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    /// 紙（画面の地）
    static let paper = dynamic(0xFDFDFC, 0x1B1A18)
    /// 紙片（かけらのカード・編集欄）。地より一段明るい（ダークでは一段浮かせる）
    static let sheet = dynamic(0xFFFFFF, 0x252421)
    static let ink = dynamic(0x17171A, 0xE9E5DC)
    static let muted = dynamic(0x86837C, 0x9A958A)
    static let line = dynamic(0xE4E1DA, 0x3A3732)
    /// 朱。ダークでは少し明るくして沈まないように
    static let accent = dynamic(0xB03A2E, 0xD9634F)
    static let shadow = Color.black.opacity(0.06)

    /// 付箋（材料の種類ごとの淡い色。派手にしない）
    static func note(_ kind: String) -> Color {
        switch kind {
        case "tayori": return dynamic(0xEEF2F3, 0x232A2C)    // 記事: 青灰
        case "nobu": return dynamic(0xF5EFE2, 0x2C2820)      // 本: 麦
        case "health": return dynamic(0xEEF3EA, 0x232A22)    // からだ: 若草
        case "weather": return dynamic(0xEDF1F6, 0x22272E)   // 天気: 空
        case "vault-log": return dynamic(0xF6EEEB, 0x2D2423) // ヘスティア: 薄紅
        case "ambient": return dynamic(0xF0EEF4, 0x26242C)   // Mac: 藤
        case "hevy": return dynamic(0xF3F0E8, 0x2A2822)      // 筋トレ: 砂
        case "place": return dynamic(0xF2F2E6, 0x282820)     // 行った場所: 若菜
        default: return dynamic(0xF3F2EE, 0x262522)
        }
    }

    // MARK: 書体

    private static func font(_ names: [String], size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        for n in names where UIFont(name: n, size: size) != nil {
            return .custom(n, size: size, relativeTo: style)
        }
        return .system(size: size)
    }

    /// 明朝（日付・見出し）
    static func mincho(_ size: CGFloat, bold: Bool = false, relativeTo style: Font.TextStyle = .body) -> Font {
        font(bold ? ["HiraMinProN-W6", "HiraMinProN-W3"] : ["HiraMinProN-W3"], size: size, relativeTo: style)
    }

    /// ヒラギノ角ゴ（本文）
    static func gothic(_ size: CGFloat, bold: Bool = false, relativeTo style: Font.TextStyle = .body) -> Font {
        font(bold ? ["HiraginoSans-W6", "HiraKakuProN-W6"] : ["HiraginoSans-W3", "HiraKakuProN-W3"], size: size, relativeTo: style)
    }

    static func uiGothic(_ size: CGFloat) -> UIFont {
        UIFont(name: "HiraginoSans-W3", size: size) ?? UIFont(name: "HiraKakuProN-W3", size: size) ?? .systemFont(ofSize: size)
    }

    static func uiMincho(_ size: CGFloat) -> UIFont {
        UIFont(name: "HiraMinProN-W6", size: size) ?? UIFont(name: "HiraMinProN-W3", size: size) ?? .systemFont(ofSize: size, weight: .semibold)
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// 紙片のカード（細い罫・わずかな影）
struct PaperCard: ViewModifier {
    var fill: Color = Theme.sheet
    var padding: CGFloat = 14

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 3))
            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 0.5))
            .shadow(color: Theme.shadow, radius: 2, x: 0, y: 1)
    }
}

/// 付箋（種類ごとの淡い色・上辺に少し濃い帯）
struct StickyNote: ViewModifier {
    let kind: String

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.note(kind))
            .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 0.5) }
            .shadow(color: Theme.shadow, radius: 1.5, x: 0, y: 1)
    }
}

extension View {
    func paperCard(fill: Color = Theme.sheet, padding: CGFloat = 14) -> some View { modifier(PaperCard(fill: fill, padding: padding)) }
    func stickyNote(_ kind: String) -> some View { modifier(StickyNote(kind: kind)) }

    /// 見出し（明朝・小さめ・薄墨）
    func sectionHeading() -> some View {
        self.font(Theme.mincho(15, bold: true, relativeTo: .subheadline)).foregroundStyle(Theme.ink)
    }
}
