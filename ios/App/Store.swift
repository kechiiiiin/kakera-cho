import SwiftUI
import UIKit

/// 画面どうしで共有する読み込み済みのもの（Web の App.tsx が持つ nagare・katachiList・detail と同じ役目）
@Observable
@MainActor
final class KakeraStore {
    static let shared = KakeraStore()

    /// まだかたちになっていないかけら（新しい順）と、そのカード
    var nagare: [Kakera] = []
    var nagareCards: LinkCards = [:]
    var nagareLoaded = false
    var katachiList: [KatachiSummary] = []
    var katachiLoaded = false
    var details: [String: KatachiDetail] = [:]

    func loadNagare() async throws {
        let r = try await API.shared.nagare()
        nagare = r.kakera
        nagareCards = r.cards
        nagareLoaded = true
    }

    func loadKatachiList() async throws {
        katachiList = try await API.shared.katachiList()
        katachiLoaded = true
    }

    @discardableResult
    func loadDetail(_ id: String) async throws -> KatachiDetail {
        let d = try await API.shared.katachi(id)
        details[id] = d
        return d
    }

    /// かたちに足した後の知らせ（日記済みのかたちなら、公開中の日記は変わらないことを添える）
    static func addedMessage(_ d: KatachiDetail) -> String {
        let at = "\(d.katachi.date) のかたち"
        return d.nikki != nil ? "\(at)に入れました。公開中の日記は、「日記に書き足す」で選び直すまで変わりません" : "\(at)に入れました"
    }
}

/// 失敗しても画面は壊さず、理由を出して止まる（Web の #toast）。3.6 秒で消える
@Observable
@MainActor
final class Toast {
    static let shared = Toast()
    var message: String?
    private var timer: Task<Void, Never>?

    func say(_ m: String) {
        message = m
        timer?.cancel()
        timer = Task {
            try? await Task.sleep(for: .seconds(3.6))
            if !Task.isCancelled { message = nil }
        }
    }

    /// 投げたら知らせる
    func guarded(_ f: () async throws -> Void) async {
        do { try await f() } catch { say(error.localizedDescription) }
    }
}

struct ToastOverlay: ViewModifier {
    @State private var toast = Toast.shared

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let m = toast.message {
                Text(m)
                    .font(Theme.gothic(13)).foregroundStyle(Theme.paper)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 16).padding(.vertical, 11)
                    .background(Theme.ink.opacity(0.92), in: RoundedRectangle(cornerRadius: Theme.radius))
                    .padding(.horizontal, 18).padding(.bottom, 72)
                    .transition(.opacity)
                    .onTapGesture { toast.message = nil }
                    .accessibilityIdentifier("toast")
            }
        }
        .animation(.easeOut(duration: 0.2), value: toast.message)
    }
}

extension View {
    func toastOverlay() -> some View { modifier(ToastOverlay()) }
}

// MARK: - 共通の部品（Web の .back-row・.page-date・.pick-row・.checkbox・.field・.time-toggle）

/// 「‹ 一覧へ戻る」（.back-btn）。右に添えるもの（「直す」など）
struct BackRow<Trailing: View>: View {
    let label: String
    let action: () -> Void
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack {
            Button("‹ \(label)", action: action)
                .buttonStyle(LinkButtonStyle(color: Theme.muted))
                .accessibilityIdentifier("back")
            Spacer()
            trailing()
        }
        .padding(.bottom, 6)
    }
}

extension BackRow where Trailing == EmptyView {
    init(_ label: String, action: @escaping () -> Void) {
        self.init(label: label, action: action) { EmptyView() }
    }
}

/// 画面の題（.page-date）と添え書き（.page-sub）
struct PageTitle: View {
    let title: String
    var sub: String?
    var size: CGFloat = 17
    var mincho = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(mincho ? Theme.mincho(size + 3) : Theme.gothic(size, weight: .medium))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let sub { Text(sub).pageSub().fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
    }
}

/// 四角いチェック（.checkbox。選ばれたら黒の塗りに白の ✓）
struct CheckBox: View {
    let checked: Bool
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Theme.radiusSmall)
                .fill(checked ? Theme.ink : Theme.paper)
            RoundedRectangle(cornerRadius: Theme.radiusSmall)
                .strokeBorder(checked ? Theme.ink : Theme.muted.opacity(0.6), lineWidth: Theme.hairline)
            if checked { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.paper) }
        }
        .frame(width: 20, height: 20)
    }
}

/// 一覧の行に添える、1枚目の小さなサムネ（2枚以上なら枚数）（RichText.tsx の RowThumb）
struct RowThumb: View {
    let body_: String
    init(_ body: String) { body_ = body }

    var body: some View {
        let urls = KakeraBody.photoURLs(body_)
        if let first = urls.first {
            RemotePhoto(path: first, side: 44)
                .overlay(alignment: .bottomTrailing) {
                    if urls.count > 1 {
                        Text("\(urls.count)").font(Theme.mono(10, weight: .medium)).foregroundStyle(Theme.paper)
                            .padding(.horizontal, 4).background(Theme.ink.opacity(0.75))
                    }
                }
        }
    }
}

/// 選ぶ行（.pick-row: チェック・本文・サムネ）。押すと切り替わる
struct PickRow<Content: View>: View {
    let checked: Bool
    var thumb: String?
    let action: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                CheckBox(checked: checked).padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) { content() }
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let thumb { RowThumb(thumb) }
            }
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(checked ? .isSelected : [])
    }
}

/// 抜粋（.pick-excerpt: 3 行まで）
struct Excerpt: View {
    let text: String
    var body: some View {
        Text(text.isEmpty ? "（写真だけ）" : text)
            .font(Theme.gothic(14)).foregroundStyle(text.isEmpty ? Theme.muted : Theme.ink)
            .lineLimit(3).lineSpacing(3)
            .multilineTextAlignment(.leading)
    }
}

/// 「時刻を出す」（.time-toggle）
struct TimeToggle: View {
    let checked: Bool
    var disabled = false
    let onChange: (Bool) -> Void

    var body: some View {
        Button { onChange(!checked) } label: {
            HStack(spacing: 5) {
                CheckBox(checked: checked).scaleEffect(0.8)
                Text("時刻を出す").font(Theme.gothic(11.5)).foregroundStyle(Theme.muted)
            }
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }
}

/// 「時刻を出すかけら n / m」と「全部に付ける／全部外す」（.time-bulk）
struct TimeBulkBar: View {
    let shown: Int
    let total: Int
    var disabled = false
    let onAll: (Bool) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text("時刻を出すかけら \(shown) / \(total)").font(Theme.gothic(12)).foregroundStyle(Theme.muted)
            Spacer(minLength: 4)
            Button("全部に付ける") { onAll(true) }.buttonStyle(GhostButtonStyle()).disabled(disabled || shown == total)
            Button("全部外す") { onAll(false) }.buttonStyle(GhostButtonStyle()).disabled(disabled || shown == 0)
        }
        .padding(.vertical, 6)
    }
}

/// ラベルつきの入力欄（.field）
struct FieldBox<Content: View>: View {
    let label: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).sectionHeading()
            content()
                .font(Theme.gothic(15)).foregroundStyle(Theme.ink)
                .padding(.horizontal, 12).frame(minHeight: 42)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
        }
        .padding(.top, 14)
    }
}

/// 日付の欄（押すと端末の日付の選び方）。値は 'YYYY-MM-DD'（JST）
struct DayField: View {
    @Binding var day: String
    var placeholder = "日付を選ぶ"

    var body: some View {
        let date = Binding<Date>(get: { JST.dayRange(day)?.start ?? Date() }, set: { day = JST.dayKey($0) })
        ZStack(alignment: .leading) {
            Text(day.isEmpty ? placeholder : DayText.heading(day))
                .font(Theme.mono(14)).foregroundStyle(day.isEmpty ? Theme.muted : Theme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            DatePicker("", selection: date, displayedComponents: .date)
                .labelsHidden()
                .environment(\.timeZone, JST.timeZone)
                .colorMultiply(.clear)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// 下から出るシートの中身の頭（.sh-title・.sh-snip）
struct SheetHead: View {
    let title: String
    var sub: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Theme.gothic(16, weight: .semibold)).foregroundStyle(Theme.ink)
            if let sub { Text(sub).font(Theme.gothic(12.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 22).padding(.bottom, 10)
    }
}

/// 戻る指の動き（左端から）を、ナビゲーションバーを隠した画面でも効かせる
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}
