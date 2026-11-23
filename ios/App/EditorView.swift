import PhotosUI
import SwiftUI

/// 書きかけ・直しかけのかけら
struct Draft: Identifiable {
    /// かけらの id（新しいものは端末で採番した ULID）
    let id: String
    var body: String
    var writtenAt: Date
    /// 写真の置き場所（R2 の key）に使う written_at。新しいかけらは作った時点の値、直すときは元の値（Web 版と同じく key は変えない）
    let photoWrittenAt: String
    /// 直すときの元のかけら。新しいかけらなら nil
    let original: Kakera?
    /// 保存できたら「かけらにした」印を付けるもの
    var photoAssetIDs: [String] = []
    var tayoriItemID: Int?
    /// 港の材料・行った場所の印の鍵（「出どころ|id」）
    var materialKey: String?

    static func new(body: String = "", at date: Date, photoAssetIDs: [String] = [], tayoriItemID: Int? = nil, materialKey: String? = nil,
                    id: String = ULID.make()) -> Draft {
        Draft(id: id, body: body, writtenAt: date, photoWrittenAt: JST.writtenAt(date), original: nil,
              photoAssetIDs: photoAssetIDs, tayoriItemID: tayoriItemID, materialKey: materialKey)
    }

    static func edit(_ k: Kakera) -> Draft {
        Draft(id: k.id, body: k.body, writtenAt: k.writtenDate, photoWrittenAt: k.writtenAt, original: k)
    }
}

/// かけらを書く・直す・消す。本文欄は Web 版と同じ k-editor（WKWebView・KEditorView.swift）。保存の形は今までどおり Markdown。
/// 日時・保存・やめる・消すはネイティブ。並びは Web の書く欄と同じ 本文 → 道具 → 日時と保存 → やめる／消す。
/// **保存はボタンだけ**（日本語入力の確定の Enter で保存しない。k-editor も確定の Enter を送信にしない）
struct EditorView: View {
    @State var draft: Draft
    /// その日のリンクカード（本文の URL の行をカードで見せる。無い URL は URL のまま）
    let cards: LinkCards
    /// 保存・削除が済んだら呼ぶ（一覧を読み直す）
    let onDone: () -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var editor = KEditorController()
    @State private var saving = false
    @State private var error: String?
    @State private var confirmDelete = false
    @State private var confirmDiscard = false

    private let initialBody: String
    private let initialDate: Date

    init(draft: Draft, cards: LinkCards = [:], onDone: @escaping () -> Void) {
        _draft = State(initialValue: draft)
        self.cards = cards
        self.onDone = onDone
        initialBody = draft.body
        initialDate = draft.writtenAt
    }

    private var isNew: Bool { draft.original == nil }
    private var trimmed: String { draft.body.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var dirty: Bool { draft.body != initialBody || draft.writtenAt != initialDate || isNew && !trimmed.isEmpty }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                Text(isNew ? "かけらを書く" : "かけらを直す")
                    .font(Theme.gothic(17, weight: .medium)).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 18).padding(.top, 20).padding(.bottom, 12)

                // 本文と道具（k-editor）。道具は本文の枠の直下、キーボードが出ればその上に乗る
                KEditorView(controller: editor)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("bodyEditor")

                if let error {
                    Text(error).font(Theme.gothic(13)).foregroundStyle(Theme.accent)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 18).padding(.top, 8)
                }

                // .composer-actions: 書いた日時（左）と保存（右）。罫を挟む
                Rule().padding(.horizontal, 18).padding(.top, 8)
                HStack(spacing: 8) {
                    pickerChip(JST.dayKey(draft.writtenAt), components: .date)
                        .accessibilityIdentifier("writtenAt")
                    pickerChip(JST.time(draft.writtenAt), components: .hourAndMinute)
                    Spacer(minLength: 4)
                    if saving {
                        ProgressView().frame(minWidth: 60, minHeight: 38)
                    } else {
                        Button("保存") { Task { await save() } }
                            .buttonStyle(PrimaryButtonStyle())
                            .disabled(trimmed.isEmpty)
                            .accessibilityIdentifier("save")
                    }
                }
                .padding(.horizontal, 18).padding(.top, 10)

                // その下に やめる／消す（Web のその場編集の 取消／削除）
                HStack(spacing: 8) {
                    Button("やめる") { if dirty { confirmDiscard = true } else { dismiss() } }
                        .buttonStyle(GhostButtonStyle())
                        .disabled(saving)
                    if !isNew && draft.original?.katachiId != nil {
                        Text("かたちの中のかけらです。消すと、かたちからも消えます。")
                            .font(Theme.gothic(10.5)).foregroundStyle(Theme.muted).lineSpacing(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 4)
                    if !isNew {
                        Button("消す") { confirmDelete = true }
                            .buttonStyle(DangerButtonStyle())
                            .disabled(saving)
                            .accessibilityIdentifier("delete")
                    }
                }
                .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 10)
            }
            .background(Theme.paper.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .interactiveDismissDisabled(dirty || saving)
            .confirmationDialog("書いた内容を捨てますか", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("捨てる", role: .destructive) { dismiss() }
            }
            .confirmationDialog("このかけらを消しますか（元に戻せません）", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("消す", role: .destructive) { Task { await remove() } }
            }
            .onAppear {
                editor.kakeraId = draft.id
                editor.photoWrittenAt = draft.photoWrittenAt
                editor.onChange = { md in draft.body = md }
                editor.onError = { m in error = m }
                // 新しいかけら（材料からの書きかけも）は開いたらすぐ書けるように
                editor.start(markdown: draft.body, cards: cards, focus: isNew)
            }
        }
    }

    /// 書いた日時の欄。見えるのは等幅の数字と罫の枠（.icon-btn の形）。押すと端末の日時の選び方が開く
    /// （システムの DatePicker を透明にして重ねる。丸いカプセルを出さないため）
    private func pickerChip(_ label: String, components: DatePickerComponents) -> some View {
        Text(label)
            .font(Theme.mono(12.5)).foregroundStyle(Theme.ink)
            .padding(.horizontal, 12).frame(minHeight: 36)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
            .overlay {
                DatePicker("書いた日時", selection: $draft.writtenAt, in: ...Date().addingTimeInterval(60), displayedComponents: components)
                    .labelsHidden()
                    .environment(\.timeZone, JST.timeZone)
                    .colorMultiply(.clear)
            }
            .clipped()
    }

    private func save() async {
        saving = true
        error = nil
        defer { saving = false }
        // 変更の知らせを待たず、保存の直前に k-editor から取り直す（打った直後に押しても取りこぼさない）
        if let md = await editor.currentMarkdown() { draft.body = md }
        guard !trimmed.isEmpty else { return }
        do {
            if let original = draft.original {
                let bodyChanged = trimmed != original.body
                // サーバは分まで（秒は 00）。分が変わったときだけ送る
                let timeChanged = JST.writtenAt(draft.writtenAt).prefix(16) != JST.writtenAt(original.writtenDate).prefix(16)
                if bodyChanged || timeChanged {
                    _ = try await API.shared.updateKakera(id: original.id, body: bodyChanged ? trimmed : nil,
                                                          writtenAt: timeChanged ? JST.writtenAt(draft.writtenAt) : nil)
                }
            } else {
                _ = try await API.shared.createKakera(id: draft.id, body: trimmed, writtenAt: JST.writtenAt(draft.writtenAt))
            }
            if !draft.photoAssetIDs.isEmpty { UsedMarks.shared.markPhotos(draft.photoAssetIDs) }
            if let item = draft.tayoriItemID { UsedMarks.shared.markItem(item) }
            if let key = draft.materialKey { UsedMarks.shared.markMaterial(key) }
            onDone()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remove() async {
        guard let original = draft.original else { return }
        saving = true
        defer { saving = false }
        do {
            try await API.shared.deleteKakera(id: original.id)
            onDone()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
