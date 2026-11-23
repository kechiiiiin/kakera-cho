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

/// かけらを書く・直す・消す。本文はプレーンなテキスト（Markdown のまま）。
/// **保存はボタンだけ**（TextEditor の Return は改行。日本語入力の確定の Enter で保存しない）
struct EditorView: View {
    @State var draft: Draft
    /// 保存・削除が済んだら呼ぶ（一覧を読み直す）
    let onDone: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var uploading: String?
    @State private var error: String?
    @State private var confirmDelete = false
    @State private var confirmDiscard = false
    @State private var picks: [PhotosPickerItem] = []
    @FocusState private var focused: Bool

    private let initialBody: String
    private let initialDate: Date

    init(draft: Draft, onDone: @escaping () -> Void) {
        _draft = State(initialValue: draft)
        self.onDone = onDone
        initialBody = draft.body
        initialDate = draft.writtenAt
    }

    private var isNew: Bool { draft.original == nil }
    private var trimmed: String { draft.body.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var dirty: Bool { draft.body != initialBody || draft.writtenAt != initialDate || isNew && !trimmed.isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // .page-date（17pt の題）と .page-sub
                    Text(isNew ? "かけらを書く" : "かけらを直す")
                        .font(Theme.gothic(17, weight: .medium)).foregroundStyle(Theme.ink)
                        .padding(.bottom, 4)
                    Text("Markdown のまま書けます。URL だけの行はリンクカードになります。")
                        .pageSub().lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 18)

                    // 本文欄（.frag-edit textarea: 罫 1pt・角丸 2pt・内側 10pt）
                    TextEditor(text: $draft.body)
                        .focused($focused)
                        .frame(minHeight: 220)
                        .font(Theme.gothic(16))
                        .foregroundStyle(Theme.ink)
                        .lineSpacing(5)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .padding(5)
                        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.line, lineWidth: Theme.hairline))
                        .accessibilityIdentifier("bodyEditor")

                    let urls = KakeraBody.photoURLs(draft.body)
                    if !urls.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) { ForEach(urls, id: \.self) { RemotePhoto(path: $0, side: 52) } }
                        }
                        .padding(.top, 10)
                    }

                    // 道具（.icon-btn）と書いた日時
                    HStack(spacing: 8) {
                        if let uploading {
                            HStack(spacing: 6) { ProgressView().controlSize(.small); Text(uploading).font(Theme.gothic(12)).foregroundStyle(Theme.muted) }
                                .frame(minHeight: 36)
                        } else {
                            PhotosPicker(selection: $picks, maxSelectionCount: 10, matching: .images, photoLibrary: .shared()) {
                                Text("写真")
                            }
                            .buttonStyle(GhostButtonStyle())
                            .accessibilityIdentifier("addPhoto")
                        }
                        Spacer(minLength: 4)
                        pickerChip(JST.dayKey(draft.writtenAt), components: .date)
                            .accessibilityIdentifier("writtenAt")
                        pickerChip(JST.time(draft.writtenAt), components: .hourAndMinute)
                    }
                    .padding(.top, 10)

                    if let error {
                        Text(error).font(Theme.gothic(13)).foregroundStyle(Theme.accent)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 12)
                    }

                    // 下に罫を挟んで、保存（黒塗り）・やめる・消す（.frag-edit-actions）
                    Rule().padding(.top, 14)
                    HStack(spacing: 8) {
                        if saving {
                            ProgressView().frame(minWidth: 60, minHeight: 38)
                        } else {
                            Button("保存") { Task { await save() } }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(trimmed.isEmpty || uploading != nil)
                                .accessibilityIdentifier("save")
                        }
                        Button("やめる") { if dirty { confirmDiscard = true } else { dismiss() } }
                            .buttonStyle(GhostButtonStyle())
                            .disabled(saving)
                        Spacer(minLength: 4)
                        if !isNew {
                            Button("消す") { confirmDelete = true }
                                .buttonStyle(DangerButtonStyle())
                                .disabled(saving)
                                .accessibilityIdentifier("delete")
                        }
                    }
                    .padding(.top, 14)
                    if !isNew && draft.original?.katachiId != nil {
                        Text("このかけらは、かたちの中にあります。消すと、かたちからも消えます。")
                            .font(Theme.gothic(11)).foregroundStyle(Theme.muted).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 10)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 20)
                .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.paper.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .interactiveDismissDisabled(dirty || saving)
            .confirmationDialog("書いた内容を捨てますか", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("捨てる", role: .destructive) { dismiss() }
            }
            .confirmationDialog("このかけらを消しますか（元に戻せません）", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("消す", role: .destructive) { Task { await remove() } }
            }
            .onChange(of: picks) { _, items in
                guard !items.isEmpty else { return }
                picks = []
                Task { await attach(items) }
            }
            .onAppear { if isNew && draft.body.isEmpty { focused = true } }
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

    private func attach(_ items: [PhotosPickerItem]) async {
        error = nil
        var urls: [String] = []
        let start = KakeraBody.photoURLs(draft.body).count
        for (i, item) in items.enumerated() {
            uploading = "写真を上げています（\(i + 1)/\(items.count)）"
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { throw APIError.transport("写真を読めませんでした") }
                let jpeg = try JPEG.make(from: data)
                urls.append(try await API.shared.uploadPhoto(jpeg: jpeg, kakeraId: draft.id, writtenAt: draft.photoWrittenAt, n: start + i + 1))
            } catch {
                self.error = "写真を上げられませんでした: \(error.localizedDescription)"
                break
            }
        }
        draft.body = KakeraBody.appendingPhotos(draft.body, urls)
        uploading = nil
    }

    private func save() async {
        saving = true
        error = nil
        defer { saving = false }
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
