import CoreGraphics
import ImageIO
import UIKit
import UniformTypeIdentifiers
import Vision

/// 写真の顔の検出とモザイク（Web の src/components/faces.ts の代わり・顔モザイク設計 §3.1・§3.3）。
///   - 検出は端末の中で Vision（VNDetectFaceRectanglesRequest）。写真を外へ送らない
///   - 写真は Web と同じく面積 16MP・長辺 4096px（細長い画像は 16384px）以下に縮めて描き、検出にもモザイクにも同じ大きさを使う
///   - 写真全体の 1 回に加えて、1024px と 384px の区画を 2 割重ねて検出し、重なった枠は IoU でまとめる（FaceRules.tiles・merge）
///   - 結果の形（0〜1 の比率・a1… の id・全部「隠す」）は Web と同じで、そのまま PUT /api/photo-face に渡す
///   - 作り直した JPEG には EXIF を載せない（サーバも EXIF 入りは受け取らない）
enum Faces {
    struct Canvas {
        let image: CGImage
        let width: Int
        let height: Int
    }

    /// 原本を読み、向きを直し、上限の内側に縮めて白の下地に描く
    static func loadCanvas(key: String) async throws -> Canvas {
        let data = try await API.shared.photoData(path: "/api/photo/\(key)")
        guard let ui = UIImage(data: data) else { throw APIError.transport("写真を読めませんでした") }
        let w = ui.size.width * ui.scale, h = ui.size.height * ui.scale
        let size = FaceRules.canvasSize(w, h)
        guard size.width > 0, size.height > 0 else { throw APIError.transport("写真の大きさが読めません") }
        guard let ctx = rgbaContext(size.width, size.height) else { throw APIError.transport("写真を描けませんでした") }
        ctx.setFillColor(UIColor.white.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: size.width, height: size.height))
        // UIImage は EXIF の向きを当てて描く（画面に見えている向きと枠の位置を揃える）
        UIGraphicsPushContext(ctx)
        ctx.translateBy(x: 0, y: CGFloat(size.height))
        ctx.scaleBy(x: 1, y: -1)
        ui.draw(in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
        UIGraphicsPopContext()
        guard let img = ctx.makeImage() else { throw APIError.transport("写真を描けませんでした") }
        return Canvas(image: img, width: size.width, height: size.height)
    }

    private static func rgbaContext(_ w: Int, _ h: Int) -> CGContext? {
        CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
    }

    /// 写真の顔を探す。見つけた枠は全部「隠す」で返す（0 件もありうる）。区画ごとに進み具合を知らせる
    static func detect(key: String, progress: @escaping @MainActor (Int, Int) -> Void) async throws -> [PhotoFace] {
        let canvas = try await loadCanvas(key: key)
        return try await Task.detached(priority: .userInitiated) {
            let W = Double(canvas.width), H = Double(canvas.height)
            var found: [FaceRules.Found] = []
            func run(_ img: CGImage, ox: Int, oy: Int, tw: Int, th: Int) throws {
                let req = VNDetectFaceRectanglesRequest()
                try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
                for o in req.results ?? [] {
                    let b = o.boundingBox // 0〜1・左下が原点
                    found.append(FaceRules.Found(
                        x: (Double(ox) + b.minX * Double(tw)) / W,
                        y: (Double(oy) + (1 - b.maxY) * Double(th)) / H,
                        w: b.width * Double(tw) / W,
                        h: b.height * Double(th) / H,
                        score: Double(o.confidence)))
                }
            }
            let tiles = FaceRules.tiles(canvas.width, canvas.height)
            let total = tiles.count + 1
            await progress(0, total)
            try run(canvas.image, ox: 0, oy: 0, tw: canvas.width, th: canvas.height)
            await progress(1, total)
            for (i, t) in tiles.enumerated() {
                try Task.checkCancellation()
                guard let crop = canvas.image.cropping(to: CGRect(x: t.x, y: t.y, width: t.w, height: t.h)) else { continue }
                try run(crop, ox: t.x, oy: t.y, tw: t.w, th: t.h)
                if i % 4 == 3 || i == tiles.count - 1 { await progress(i + 2, total) }
            }
            return FaceRules.merge(found)
        }.value
    }

    /// 隠す枠にモザイクをかけた JPEG（検出と同じ大きさ・EXIF なし）。隠す枠が無ければ nil
    static func maskedJPEG(key: String, faces: [PhotoFace]) async throws -> Data? {
        let hidden = FaceRules.hidden(faces)
        guard !hidden.isEmpty else { return nil }
        let canvas = try await loadCanvas(key: key)
        return try mask(canvas, hidden)
    }

    static func mask(_ canvas: Canvas, _ hidden: [PhotoFace]) throws -> Data {
        let w = canvas.width, h = canvas.height
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        let ok: Bool = pixels.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            ctx.draw(canvas.image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { throw APIError.transport("モザイクをかけた写真を作れませんでした") }
        for f in hidden {
            let r = FaceRules.mosaicRect(x: f.x, y: f.y, w: f.w, h: f.h, width: w, height: h)
            if r.w == 0 || r.h == 0 { continue }
            FaceRules.pixelate(&pixels, width: w, x: r.x, y: r.y, w: r.w, h: r.h, block: r.block)
        }
        let data = NSMutableData()
        let made: Bool = pixels.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                  let img = ctx.makeImage(),
                  let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
            CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
            return CGImageDestinationFinalize(dest)
        }
        guard made else { throw APIError.transport("モザイクをかけた写真を作れませんでした") }
        // ImageIO は EXIF（色空間・大きさ）の区画を足すので、SOS より前の APP1 Exif を落とす
        let out = FaceRules.strippingExif(data as Data)
        if FaceRules.hasExif(out) { throw APIError.transport("作り直した写真に EXIF が残りました") }
        return out
    }
}

extension FaceRules {
    /// JPEG か（先頭が SOI）
    static func isJpeg(_ b: Data) -> Bool { b.count > 4 && b[b.startIndex] == 0xFF && b[b.startIndex + 1] == 0xD8 && b[b.startIndex + 2] == 0xFF }

    /// SOS より前の APP1 Exif の区画を落とした JPEG（画素はそのまま）
    static func strippingExif(_ data: Data) -> Data {
        let b = [UInt8](data)
        guard b.count > 4, b[0] == 0xFF, b[1] == 0xD8 else { return data }
        var out: [UInt8] = [0xFF, 0xD8]
        var i = 2
        while i + 4 <= b.count {
            guard b[i] == 0xFF else { break }
            let marker = b[i + 1]
            if marker == 0xDA || marker == 0xD9 { break } // SOS 以降は丸ごと残す
            if marker == 0xFF { out.append(0xFF); i += 1; continue }
            if marker >= 0xD0 && marker <= 0xD7 { out += b[i..<(i + 2)]; i += 2; continue }
            let len = Int(b[i + 2]) << 8 | Int(b[i + 3])
            let end = min(b.count, i + 2 + len)
            let isExif = marker == 0xE1 && len >= 8 && i + 10 <= b.count && Array(b[(i + 4)..<(i + 10)]) == Array("Exif\0\0".utf8)
            if !isExif { out += b[i..<end] }
            i = end
        }
        if i < b.count { out += b[i...] }
        return Data(out)
    }

    /// JPEG に EXIF（APP1 の "Exif\0\0"）が載っているか。SOS までの区画だけ見る（photo-face.ts の hasExif の写し）
    static func hasExif(_ data: Data) -> Bool {
        let b = [UInt8](data)
        guard b.count > 4, b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF else { return false }
        var i = 2
        while i + 4 <= b.count {
            if b[i] != 0xFF { return false }
            let marker = b[i + 1]
            if marker == 0xD9 || marker == 0xDA { return false }
            if marker == 0xFF { i += 1; continue }
            if marker >= 0xD0 && marker <= 0xD7 { i += 2; continue }
            let len = Int(b[i + 2]) << 8 | Int(b[i + 3])
            if marker == 0xE1 && len >= 8 && i + 10 <= b.count && Array(b[(i + 4)..<(i + 10)]) == Array("Exif\0\0".utf8) { return true }
            i += 2 + len
        }
        return false
    }
}
