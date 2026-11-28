// Swift に移した決まりの「期待値」を、Web 版の関数そのもの（src/lib/*.ts）から書き出す（かけら帳ネイティブ化設計「共有データ」）。
// 出力は ios/Tests/Fixtures/rules.json（Tests/RulesTests.swift が同じ入力を Swift の写しに通して突き合わせる）。
// 書き直し: make fixtures（esbuild で束ねて node で走らせる・ネットは使わない）
// ⚠️ 仮名だけで書く（このリポジトリは public）。

import { matchEmbed, parseEmbedTokens, wordCandidates, wordsOf, wrapWordCandidates } from '../../src/lib/markdown';
import { descriptionLength, flattenDescription } from '../../src/lib/publish/diary-file';
import { kakeraTimeLabel, timeHeadOf } from '../../src/lib/kakera/time-label';
import { fitUploadSize } from '../../src/lib/image/fit-size';
import {
  faceFingerprint,
  faceTiles,
  fitCanvasSize,
  hasExif,
  isFacePhotoKey,
  mergeDetections,
  mosaicRect,
  normalizeBox,
  pixelate,
  type PhotoFace,
} from '../../src/lib/publish/photo-face';

const embedUrls = [
  'https://youtu.be/dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
  'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
  'https://youtube.com/shorts/dQw4w9WgXcQ?si=abc',
  'https://www.youtube.com/live/dQw4w9WgXcQ',
  'https://www.youtube.com/embed/dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=short',
  'http://youtu.be/dQw4w9WgXcQ',
  'https://x.com/someone/status/1234567890',
  'https://twitter.com/some_one/status/1',
  'https://mobile.twitter.com/a/status/99?s=20',
  'https://x.com/someone',
  'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
  'https://open.spotify.com/episode/abcDEF123?si=x',
  'https://open.spotify.com/user/abc',
  'https://example.com/',
  'javascript:alert(1)',
  'https://youtu.be/dQw4w9WgXcQ 後ろ',
];

const embedTexts = [
  'https://youtu.be/dQw4w9WgXcQ',
  '前の文\nhttps://youtu.be/dQw4w9WgXcQ\n後の文',
  '前の文\nhttps://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC\n後の文',
  '前の文\n\nhttps://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC\n\n後の文',
  'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
  '文の中 https://youtu.be/dQw4w9WgXcQ は埋め込みにしない',
  ' \t\nhttps://open.spotify.com/album/abc\n\t',
  'https://x.com/a/status/1\nhttps://x.com/b/status/2',
];

const descriptions = [
  '',
  '  一行  ',
  '一行目\n二行目',
  '一行目 \r\n  二行目\t三',
  'a b c\u0085d',
  '　全角で始まる　中の全角は残す　',
  '\t\tタブ\tだけ\t',
  '絵文字😀と合字👨‍👩‍👧',
  '末尾の BOM\ufeff',
  '中の\ufeffBOM は残る',
];

const times: [string, string][] = [
  ['2026-10-10T06:00:00+09:00', '2026-10-10'],
  ['2026-10-11T03:20:00+09:00', '2026-10-10'],
  ['2026-10-09T22:15:00+09:00', '2026-10-10'],
  ['2026-12-31T23:30:00+09:00', '2027-01-01'],
  ['2026-10-11T00:30:00+09:00', '2026-10-11'],
];

const wordBodies: [string, string[]][] = [
  ['読書のあと猫。読書と猫', ['猫', '読書']],
  ['カフェオレとカフェ', ['カフェ', 'カフェオレ']],
  ['**猫**と~~犬~~', ['猫', '犬']],
  ['絵文字😀のあと猫', ['猫']],
  ['[[猫]]と猫と犬', ['猫', '犬']],
  ['朝マックのあと、筋トレ。 猫に邪魔された', ['筋トレ', '猫']],
];

const wordsOfBodies = [
  '[[京都]]と[[ 奈良 ]]、[[京都]]',
  '[[**あ**い]] [[~~う~~え]]',
  '**[[a]]** *[[b]]* ~~[[c]]~~\n## [[d]]\n- [[e]]\n> [[f]]',
  '`[[x]]`',
  '```\n[[x]]\n```',
  '~~~\n[[x]]\n~~~',
  '~~~\na~~b\n[[x]]\n~~c\n~~~',
  '[[ ]] [[]] [[****]]',
  '[[a]](https://example.com)',
  '[[a',
  '[[あ\nい]]',
  '[[a`b`c]]',
  '[[a]](javascript:alert)',
  '\\[[x]]',
  '![[x]](https://example.com/a.jpg)',
  '前\n```js\nconst a = "[[x]]";\n```\n後ろの[[y]]',
];

const uploadSizes: [number, number][] = [
  [4032, 3024], [3024, 4032], [4000, 4000], [4032, 2268], [2896, 1448], [6000, 2000], [12000, 3000],
  [1290, 19350], [1290, 9000], [800, 600], [400, 30000], [4096, 4096], [4097, 4095], [1366, 12288],
  [1024, 16384], [30000, 30000], [0, 100],
];

const canvasSizes: [number, number][] = [
  [6000, 4000], [3000, 5000], [3000, 9000], [1290, 19350], [400, 30000], [4096, 4096], [2048, 1536], [0, 100],
];

const tileSizes: [number, number][] = [
  [384, 300], [1024, 768], [4096, 2731], [4032, 3024], [1032, 15491], [1042, 15351], [3000, 600],
];

const mosaicInputs: [{ x: number; y: number; w: number; h: number }, number, number][] = [
  [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1000, 800],
  [{ x: 0, y: 0.9, w: 0.02, h: 0.2 }, 1000, 800],
  [{ x: 0.1234, y: 0.5678, w: 0.0912, h: 0.1033 }, 4032, 3024],
  [{ x: 0.95, y: 0.95, w: 0.2, h: 0.2 }, 640, 480],
];

const face = (id: string, x: number, shown = false, source: 'auto' | 'manual' = 'auto', y = 0.1, w = 0.2, h = 0.25): PhotoFace => ({
  id, x, y, w, h, source, shown,
});

const fingerprintSets: PhotoFace[][] = [
  [face('a1', 0.1), face('a2', 0.5), face('a3', 0.7, true)],
  [face('m9', 0.5, false, 'manual'), face('a1', 0.1)],
  [face('a1', 0.1), face('a2', 0.51)],
  [face('a1', 0.1, true)],
  [],
  [face('a1', 0.12345, false, 'auto', 0.33335, 0.1, 0.10005)],
];

const mergeInputs = [
  [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.6 },
    { x: 0.11, y: 0.1, w: 0.2, h: 0.2, score: 0.9 },
    { x: 0.12, y: 0.12, w: 0.05, h: 0.05, score: 0.5 },
    { x: 0.6, y: 0.5, w: 0.1, h: 0.1, score: 0.45 },
  ],
  [
    { x: 900 / 4096, y: 500 / 2731, w: 120 / 4096, h: 140 / 2731, score: 0.7 },
    { x: 902 / 4096, y: 503 / 2731, w: 118 / 4096, h: 138 / 2731, score: 0.9 },
    { x: 898 / 4096, y: 498 / 2731, w: 121 / 4096, h: 141 / 2731, score: 0.5 },
    { x: 200 / 4096, y: 2000 / 2731, w: 40 / 4096, h: 48 / 2731, score: 0.45 },
    { x: 2500 / 4096, y: 300 / 2731, w: 36 / 4096, h: 42 / 2731, score: 0.42 },
    { x: 3900 / 4096, y: 2600 / 2731, w: 30 / 4096, h: 36 / 2731, score: 0.41 },
  ],
  [
    { x: -0.1, y: 0.5, w: 0.3, h: 0.2, score: 0.5 },
    { x: 0.5, y: 0.5, w: 0.001, h: 0.2, score: 0.9 },
    { x: 0.5, y: 0.2, w: 0.1, h: 0.1, score: 0.5 },
    { x: 0.2, y: 0.2, w: 0.1, h: 0.1, score: 0.5 },
  ],
];

const boxes = [
  { x: -0.1, y: 0.123456, w: 0.5, h: 2 },
  { x: 0, y: 0, w: 0.001, h: 0.1 },
  { x: 0.99995, y: 0.5, w: 0.1, h: 0.1 },
  { x: 0.3, y: 0.3, w: 0.33333, h: 0.66666 },
];

const faceKeys = [
  'kakera/2026/10/12_1432_01JXXXXXXXXXXXXXXXXXXXXXXX_1.jpg',
  'kakera/cards/abc.png',
  'kakera/masked/2026/10/a.12345678.jpg',
  'kakera/2026/10/../x.jpg',
  'kakera/2026/1/a.jpg',
];

const exifBytes = [
  [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...'JFIF\0'.split('').map((c) => c.charCodeAt(0)), ...new Array(9).fill(0), 0xff, 0xda, 0, 2, 0xff, 0xd9],
  [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0e, ...'Exif\0\0'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0, 0, 0, 0xff, 0xda, 0, 2],
  [0x89, 0x50, 0x4e, 0x47, 0, 0],
];

function pixelateCase(): { input: number[]; width: number; rect: { x: number; y: number; w: number; h: number; block: number }; output: number[] } {
  const W = 20;
  const H = 14;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([i % 256, (i * 7) % 256, (i * 13) % 256, 200 + (i % 56)], i * 4);
  const input = [...data];
  const rect = { x: 3, y: 2, w: 13, h: 11, block: 4 };
  pixelate(data, W, rect);
  return { input, width: W, rect, output: [...data] };
}

const out = {
  embeds: embedUrls.map((url) => ({ url, embed: matchEmbed(url) })),
  embedLines: embedTexts.map((text) => {
    const tokens = parseEmbedTokens(text);
    // 行の番号にして渡す（Swift は行ごとに返す）
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return { text, lines: tokens.map((t) => ({ line: starts.indexOf(t.start), embed: t.embed })) };
  }),
  descriptions: descriptions.map((s) => ({ input: s, flat: flattenDescription(s), length: descriptionLength(flattenDescription(s)), rawLength: descriptionLength(s) })),
  times: times.map(([w, d]) => ({ written_at: w, date: d, label: kakeraTimeLabel(w, d), head: timeHeadOf({ written_at: w, show_time: true }, d) })),
  wraps: wordBodies.map(([body, pages]) => {
    const cands = wordCandidates(body, pages);
    return { body, candidates: cands, wrapped: wrapWordCandidates(body, cands) };
  }),
  wordsOf: wordsOfBodies.map((body) => ({ body, words: wordsOf(body) })),
  upload: uploadSizes.map(([w, h]) => ({ w, h, out: fitUploadSize(w, h) })),
  canvas: canvasSizes.map(([w, h]) => ({ w, h, out: fitCanvasSize(w, h) })),
  tiles: tileSizes.map(([w, h]) => ({ w, h, out: faceTiles(w, h) })),
  mosaic: mosaicInputs.map(([f, w, h]) => ({ face: f, w, h, out: mosaicRect(f, w, h) })),
  fingerprints: await Promise.all(fingerprintSets.map(async (faces) => ({ faces, fp: await faceFingerprint(faces) }))),
  merges: mergeInputs.map((found) => ({ found, out: mergeDetections(found) })),
  boxes: boxes.map((b) => ({ box: b, out: normalizeBox(b) })),
  faceKeys: faceKeys.map((key) => ({ key, ok: isFacePhotoKey(key) })),
  exif: exifBytes.map((bytes) => ({ bytes, exif: hasExif(Uint8Array.from(bytes)) })),
  pixelate: pixelateCase(),
};

process.stdout.write(JSON.stringify(out, null, 1) + '\n');
