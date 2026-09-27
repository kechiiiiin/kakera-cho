// ホーム画面のアイコン（apple-touch-icon）を作る。2026-09-27: 朱の四角に明朝で「かけ／ら帳」の2字×2行。
// タブの favicon は 16px で4字が潰れるので「か」1字のまま（make-favicon.mjs）。180px のこちらだけ4字にする。
// 使い方は make-favicon.mjs と同じ作業ディレクトリで:
//   node make-touch-icon.mjs   → touch.svg（角丸なし。iOS が自前で角を丸める）
//   magick -background none -density 1200 touch.svg -resize 180x180 apple-touch-icon.png
import opentype from "opentype.js";
import { readFileSync, writeFileSync } from "node:fs";
const buf = readFileSync("ShipporiMincho-SemiBold.ttf");
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const size = 13.5;
// 1字の枠を 13.5 四方として、4つを中央に寄せて置く
const cells = [["か", 0, 0], ["け", 1, 0], ["ら", 0, 1], ["帳", 1, 1]];
const x0 = 16 - size, y0 = 16 - size;
let d = "";
for (const [ch, c, r] of cells) {
  const g = font.charToGlyph(ch);
  const adv = g.advanceWidth * size / font.unitsPerEm;
  const cx = x0 + size * c + size / 2;
  const cy = y0 + size * r + size / 2;
  // 仮名は字面が下に寄るので、字面の上下中心を枠の中心に合わせる
  const bb = g.getPath(0, 0, size).getBoundingBox();
  const base = cy - (bb.y1 + bb.y2) / 2;
  d += g.getPath(cx - adv / 2, base, size).toPathData(2);
}
writeFileSync("touch.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#b03a2e"/><path fill="#fdfdfc" d="${d}"/></svg>\n`);
