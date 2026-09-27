// かけら帳の印（favicon）を作る。2026-09-27: 朱 #b03a2e の角丸四角に白抜きの明朝「か」（琥珀の印と同じ作り）。
// SVG の <text> は閲覧端末のフォント頼みになるので、Shippori Mincho SemiBold の「か」をパスにして埋め込む。
// 使い方（リポジトリ外の作業ディレクトリで）:
//   npm i opentype.js
//   curl -LO https://github.com/google/fonts/raw/main/ofl/shipporimincho/ShipporiMincho-SemiBold.ttf   # SIL OFL 1.1
//   node make-favicon.mjs   → favicon.svg
//   for s in 16 32 48; do magick -background none -density 600 favicon.svg -resize ${s}x${s} f$s.png; done
//   magick f16.png f32.png f48.png favicon.ico
// できたもの（favicon.svg・favicon.ico）を public/ へ。
// apple-touch-icon（ホーム画面）は4字の「かけ／ら帳」にしたので make-touch-icon.mjs で作る。
import opentype from "opentype.js";
import { readFileSync, writeFileSync } from "node:fs";
const buf = readFileSync("ShipporiMincho-SemiBold.ttf");
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const g = font.charToGlyph("か");
const size = 24, cx = 16;
const adv = g.advanceWidth * size / font.unitsPerEm;
// 仮名は字面が下に寄るので、ベースラインではなく字面の上下中心を 16 に合わせる
const bb = g.getPath(0, 0, size).getBoundingBox();
const base = 16 - (bb.y1 + bb.y2) / 2;
const d = g.getPath(cx - adv / 2, base, size).toPathData(2);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="3" fill="#b03a2e"/><path fill="#fdfdfc" d="${d}"/></svg>\n`;
writeFileSync("favicon.svg", svg);
