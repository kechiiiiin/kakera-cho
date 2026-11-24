import Photos
import SwiftUI
import UIKit

/// 思い出す材料: その日（JST 0:00〜24:00）に撮った写真
@MainActor
@Observable
final class PhotoMaterials {
    private(set) var status: PHAuthorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    private(set) var assets: [PHAsset] = []
    private(set) var day: String = ""

    var canRead: Bool { status == .authorized || status == .limited }

    func load(_ day: String) {
        self.day = day
        status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard canRead, let range = JST.dayRange(day) else {
            assets = []
            return
        }
        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate < %@ AND mediaType == %d",
                                     range.start as NSDate, range.end as NSDate, PHAssetMediaType.image.rawValue)
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let result = PHAsset.fetchAssets(with: opts)
        var list: [PHAsset] = []
        list.reserveCapacity(result.count)
        result.enumerateObjects { a, _, _ in list.append(a) }
        assets = list
    }

    func requestAccess() async {
        status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        load(day)
    }

    /// 上げる形（JPEG）にする。iCloud にしか無い写真も取りに行く
    nonisolated static func jpeg(for asset: PHAsset) async throws -> Data {
        let opts = PHImageRequestOptions()
        opts.isNetworkAccessAllowed = true
        opts.deliveryMode = .highQualityFormat
        opts.version = .current
        let data: Data = try await withCheckedThrowingContinuation { cont in
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: opts) { data, _, _, info in
                if let data {
                    cont.resume(returning: data)
                } else {
                    let err = (info?[PHImageErrorKey] as? NSError)?.localizedDescription ?? "写真を取り出せませんでした"
                    cont.resume(throwing: APIError.transport(err))
                }
            }
        }
        return try JPEG.make(from: data)
    }
}

/// 端末の写真の小さな絵
struct AssetThumb: View {
    let asset: PHAsset
    var side: CGFloat
    @State private var image: UIImage?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        ZStack {
            Rectangle().fill(Theme.line)
            if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .frame(width: side, height: side)
        .clipped()
        .task(id: asset.localIdentifier) {
            let opts = PHImageRequestOptions()
            opts.deliveryMode = .opportunistic
            opts.isNetworkAccessAllowed = true
            opts.resizeMode = .fast
            let px = side * displayScale
            PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: px, height: px), contentMode: .aspectFill, options: opts) { img, _ in
                if let img { Task { @MainActor in image = img } }
            }
        }
    }
}

/// 写真の材料の区画: 許可・グリッド・複数選択・「かけらにする」
struct PhotosNote: View {
    @Bindable var photos: PhotoMaterials
    let used: UsedMarks
    let busy: Bool
    let onMake: ([PHAsset]) -> Void

    @State private var selected: [String] = []
    @Environment(\.openURL) private var openURL

    private let columns = [GridItem(.adaptive(minimum: 76, maximum: 120), spacing: 3)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            NoteHeading(title: "写真", count: photos.assets.count, top: 14, rule: false)
                .padding(.bottom, -10) // 見出しの下の余白は NoteHeading が持つ
            switch photos.status {
            case .notDetermined:
                VStack(alignment: .leading, spacing: 8) {
                    Text("その日に撮った写真を並べるには、写真へのアクセスを許可してください。")
                        .font(Theme.gothic(13)).foregroundStyle(Theme.muted).lineSpacing(4)
                    Button("写真へのアクセスを許可する") { Task { await photos.requestAccess() } }
                        .buttonStyle(LinkButtonStyle(color: Theme.accent))
                }
            case .denied, .restricted:
                VStack(alignment: .leading, spacing: 8) {
                    Text("写真へのアクセスが許可されていません。設定アプリの「かけら帳」→「写真」で許可すると、その日の写真が並びます。")
                        .font(Theme.gothic(13)).foregroundStyle(Theme.muted).lineSpacing(4)
                    Button("設定を開く") { if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) } }
                        .buttonStyle(LinkButtonStyle(color: Theme.accent))
                }
            default:
                if photos.status == .limited {
                    Text("選んだ写真だけが見えています（設定で「すべての写真」にできます）")
                        .font(Theme.gothic(11)).foregroundStyle(Theme.muted)
                }
                if photos.assets.isEmpty {
                    Text("この日に撮った写真はありません").font(Theme.gothic(13)).foregroundStyle(Theme.muted).lineSpacing(4)
                } else {
                    grid
                    if selected.isEmpty {
                        // 案内文（ボタンに見せない。.page-sub 程度の灰の小さな文字）
                        Text("写真を選ぶとかけらにできます").pageSub()
                    } else {
                        Button {
                            let picked = photos.assets.filter { selected.contains($0.localIdentifier) }
                            onMake(picked)
                            selected = []
                        } label: {
                            HStack(spacing: 6) { Text("かけらにする"); Text("\(selected.count)枚").font(Theme.mono(11)) }
                        }
                        .buttonStyle(CTAButtonStyle())
                        .disabled(busy)
                        .accessibilityIdentifier("makeFromPhotos")
                    }
                }
            }
        }
        .onChange(of: photos.day) { selected = [] }
    }

    private var grid: some View {
        LazyVGrid(columns: columns, spacing: 3) {
            ForEach(photos.assets, id: \.localIdentifier) { a in
                let id = a.localIdentifier
                let isSelected = selected.contains(id)
                Button {
                    if let i = selected.firstIndex(of: id) { selected.remove(at: i) } else { selected.append(id) }
                } label: {
                    GeometryReader { g in
                        AssetThumb(asset: a, side: g.size.width)
                    }
                    .aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
                    .overlay(alignment: .topTrailing) {
                        // 選んだ順の番号（朱の文字と枠。塗らない）
                        if let n = selected.firstIndex(of: id) {
                            Text("\(n + 1)").font(Theme.mono(11, weight: .semibold)).foregroundStyle(Theme.accent)
                                .frame(minWidth: 18, minHeight: 18)
                                .background(Theme.paper, in: RoundedRectangle(cornerRadius: 1))
                                .overlay(RoundedRectangle(cornerRadius: 1).strokeBorder(Theme.accent, lineWidth: Theme.hairline))
                                .padding(4)
                        }
                    }
                    .overlay(alignment: .topLeading) {
                        if used.photos.contains(id) {
                            Text("かけらにした").font(Theme.mono(9.5)).lineLimit(1).fixedSize()
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 1)).foregroundStyle(.white)
                                .padding(3)
                        }
                    }
                    .overlay(alignment: .bottomLeading) {
                        if let d = a.creationDate {
                            Text(JST.time(d)).font(Theme.mono(10)).lineLimit(1).fixedSize()
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 1)).foregroundStyle(.white)
                                .padding(3)
                        }
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.radius)
                            .strokeBorder(isSelected ? Theme.accent : Theme.line, lineWidth: isSelected ? 2 : Theme.hairline)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("photo-\(photos.assets.firstIndex(of: a) ?? 0)")
            }
        }
    }
}
