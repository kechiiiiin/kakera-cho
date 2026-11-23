// アプリアイコン（1024px）を描く: `swift scripts/gen-icon.swift App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`
// 仮のアイコン（アイコンは未決・かけら帳iOS構想 §4）。Web 版のアクセント色（#b03a2e）の地に、白い紙片を三枚ずらして重ねる
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-1024.png"
let size = 1024
// アルファ無し（App Store のアイコンは透過を受けない）の CGContext に描く
let cg = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                   space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: false)
let rect = NSRect(x: 0, y: 0, width: size, height: size)
NSGradient(starting: NSColor(red: 0.78, green: 0.29, blue: 0.22, alpha: 1), ending: NSColor(red: 0.62, green: 0.20, blue: 0.16, alpha: 1))!
    .draw(in: rect, angle: -90)
let pieces: [(NSRect, CGFloat, CGFloat)] = [
    (NSRect(x: 250, y: 560, width: 460, height: 220), -8, 0.80),
    (NSRect(x: 300, y: 400, width: 470, height: 220), 5, 0.90),
    (NSRect(x: 230, y: 230, width: 480, height: 220), -3, 0.98),
]
for (r, deg, alpha) in pieces {
    let t = NSAffineTransform()
    t.translateX(by: r.midX, yBy: r.midY)
    t.rotate(byDegrees: deg)
    t.translateX(by: -r.midX, yBy: -r.midY)
    let p = NSBezierPath(roundedRect: r, xRadius: 28, yRadius: 28)
    p.transform(using: t as AffineTransform)
    NSColor(white: 1, alpha: alpha).setFill()
    p.fill()
}
NSGraphicsContext.restoreGraphicsState()
let rep = NSBitmapImageRep(cgImage: cg.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
