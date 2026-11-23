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
            Form {
                Section {
                    TextEditor(text: $draft.body)
                        .focused($focused)
                        .frame(minHeight: 220)
                        .font(Theme.gothic(16))
                        .foregroundStyle(Theme.ink)
                        .lineSpacing(3)
                        .scrollContentBackground(.hidden)
                        .accessibilityIdentifier("bodyEditor")
                } footer: {
                    Text("Markdown のまま書けます。URL だけの行はリンクカードになります。").font(Theme.gothic(11)).foregroundStyle(Theme.muted).lineSpacing(3)
                }
                .listRowBackground(Theme.sheet)

                let urls = KakeraBody.photoURLs(draft.body)
                Section {
                    if !urls.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) { ForEach(urls, id: \.self) { RemotePhoto(path: $0, side: 84) } }
                        }
                    }
                    if let uploading {
                        HStack { ProgressView(); Text(uploading).font(Theme.gothic(14)) }
                    } else {
                        PhotosPicker(selection: $picks, maxSelectionCount: 10, matching: .images, photoLibrary: .shared()) {
                            Label("写真を添える", systemImage: "photo.badge.plus").font(Theme.gothic(15)).foregroundStyle(Theme.accent)
                        }
                    }
                } header: {
                    Text("写真").font(Theme.mincho(14, bold: true)).foregroundStyle(Theme.ink)
                }
                .listRowBackground(Theme.sheet)

                Section {
                    DatePicker(selection: $draft.writtenAt, in: ...Date().addingTimeInterval(60), displayedComponents: [.date, .hourAndMinute]) {
                        Text("書いた日時").font(Theme.gothic(15)).foregroundStyle(Theme.ink)
                    }
                    .environment(\.timeZone, JST.timeZone)
                    .accessibilityIdentifier("writtenAt")
                }
                .listRowBackground(Theme.sheet)

                if let error {
                    Section { Text(error).foregroundStyle(Theme.accent).font(Theme.gothic(14)) }
                        .listRowBackground(Theme.sheet)
                }

                if !isNew {
                    Section {
                        Button("このかけらを消す", role: .destructive) { confirmDelete = true }
                            .font(Theme.gothic(15))
                            .disabled(saving)
                    } footer: {
                        if draft.original?.katachiId != nil {
                            Text("このかけらは、かたちの中にあります。消すと、かたちからも消えます。").font(Theme.gothic(11)).foregroundStyle(Theme.muted).lineSpacing(3)
                        }
                    }
                    .listRowBackground(Theme.sheet)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.paper.ignoresSafeArea())
            .navigationTitle(isNew ? "かけらを書く" : "かけらを直す")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.paper, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(isNew ? "かけらを書く" : "かけらを直す").font(Theme.mincho(17, bold: true, relativeTo: .headline)).foregroundStyle(Theme.ink)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("やめる") { if dirty { confirmDiscard = true } else { dismiss() } }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("保存") { Task { await save() } }
                            .fontWeight(.semibold)
                            .disabled(trimmed.isEmpty || uploading != nil)
                            .accessibilityIdentifier("save")
                    }
                }
            }
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
