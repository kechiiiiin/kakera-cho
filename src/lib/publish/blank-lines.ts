// 空行の保持（書き出すときだけ）。blog-cms と同じ「U+00A0 だけの行」の規約に揃える。
// 画面とサーバの両方から使うので、DOM にも Workers の API にも依存しない。データを返すだけ。
//
// なぜ:
//  astro-blog の日記は段落間のマージンが 0（note 風に改行で書く運用のため）。Markdown の空行＝段落の区切りは
//  届くが、隙間にならない。かけら帳の読む画面（white-space: pre-wrap）では空行が隙間として見えるので、
//  公開すると詰まって見えた（2026-09-13）。astro-blog の remark-blank-lines は「U+00A0 だけの行」を
//  高さのある空行段落（<p>&nbsp;</p>）に展開するので、書き出す本文の空行をその行に変える。
//
// 形: 空行 n 行 → 「本物の空行・U+00A0 の行」を n 回くり返し、最後に本物の空行（U+00A0 の行が独立した段落になる）。
//   `a\n\nb` → `a\n\n \n\nb`（<p>a</p><p>&nbsp;</p><p>b</p>）
//  ⚠️ 段落の中に `a\n \nb` と挟む形にしない。remark-blank-lines が段落を割るとき、行として独立した URL の
//  前後に空の text が残り、X / YouTube / Spotify の埋め込みとリンクカードの判定（isLineStandalone・
//  「段落がその URL だけ」）が外れて素のリンクになる（astro-blog の実物のプラグインで確かめた）。
//
// 変えない空行（本物の空行のまま）:
//  - コードフェンスの中
//  - 区切り線（`---` 等）の直前・直後。U+00A0 の行が `---` の直前に来ると setext 見出しに化けうる。
//    かけら同士の区切り `\n\n---\n\n` はこの関数の外（composeBody）で足すので触らない
//  - 写真・埋め込み・カードに接する空行。かけら帳の読む画面（RichText）はそれらの前後の空行を trim して
//    隙間として見せないので、ブログでも隙間にしない（見える隙間の数を揃える）
//  - 字下げ（4つの空白かタブ）の行に挟まれた空行（字下げのコードブロックを二つに割らない）
//  - 本文の先頭・末尾の空行は、呼ぶ側（composeBody）の trim で落ちる
//
// ⚠️ 名前の置き換え・出さない写真の除去（convertForPublish）は原本の位置で計算する。これは**その後の本文**に当てる。

import { FENCE_LINE, HR_LINE, composeBody, parseEmbedTokens, parsePhotoTokens } from '../markdown';
import { parseCardUrls } from '../card/url';

/** 空行段落の印（astro-blog の remark-blank-lines の NBSP_LINE_RE に当たる行）。 */
export const NBSP = ' ';

const BLANK_LINE = /^[ \t]*$/;
const INDENTED = /^(?: {4}|\t)/;

/**
 * 1枚のかけらの本文（公開版・trim 済み）の空行を、U+00A0 の行に変える。
 * @param hasCard 正規化 URL にカードがあるか（かけら帳の画面でカードになる行を「写真・埋め込みと同じ塊」とみなすため）。
 *   渡さなければ、行として独立した URL はカードにならない（＝素のリンクの行）とみなす
 */
export function markBlankLinesForBlog(body: string, hasCard?: (key: string) => boolean): string {
  const lines = body.split('\n');
  const n = lines.length;
  const starts: number[] = [];
  let p = 0;
  for (const line of lines) {
    starts.push(p);
    p += line.length + 1;
  }

  // 写真・埋め込み・カードの位置（かけら帳の RichText が本文を割る位置と同じ拾い方）
  const slots: { start: number; end: number }[] = [
    ...parsePhotoTokens(body),
    ...parseEmbedTokens(body),
    ...(hasCard ? parseCardUrls(body).filter((t) => hasCard(t.key)) : []),
  ];
  const slotStarts = new Set(slots.map((s) => s.start));
  const slotEnds = new Set(slots.map((s) => s.end));
  // その行が塊で始まる（行頭の空白の直後）／塊で終わる（行末の空白の直前）
  const startsWithSlot = (i: number): boolean => slotStarts.has(starts[i]! + (lines[i]!.length - lines[i]!.trimStart().length));
  const endsWithSlot = (i: number): boolean => slotEnds.has(starts[i]! + lines[i]!.trimEnd().length);

  // コードフェンスの中（開き・閉じの行も含む）。閉じが無ければ最後までフェンスの中（CommonMark と同じ）
  const inFence: boolean[] = new Array(n).fill(false);
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    const fence = line.match(FENCE_LINE);
    if (fenceChar) {
      inFence[i] = true;
      if (fence && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLen && line.trim() === fence[1]) fenceChar = null;
      continue;
    }
    if (fence) {
      inFence[i] = true;
      fenceChar = fence[1]![0]!;
      fenceLen = fence[1]!.length;
    }
  }

  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    if (inFence[i] || !BLANK_LINE.test(line)) {
      out.push(line);
      continue;
    }
    // 空行の並び [i, j]
    let j = i;
    while (j + 1 < n && !inFence[j + 1] && BLANK_LINE.test(lines[j + 1]!)) j++;
    const count = j - i + 1;
    const prev = i - 1;
    const next = j + 1;
    const edge = prev < 0 || next >= n;
    const keep =
      edge ||
      HR_LINE.test(lines[prev]!) ||
      HR_LINE.test(lines[next]!) ||
      endsWithSlot(prev) ||
      startsWithSlot(next) ||
      (INDENTED.test(lines[prev]!) && INDENTED.test(lines[next]!));
    if (keep) {
      for (let k = i; k <= j; k++) out.push(lines[k]!);
    } else {
      out.push('');
      for (let k = 0; k < count; k++) out.push(NBSP, '');
    }
    i = j;
  }
  return out.join('\n');
}

/**
 * 書き出す本文（公開版）を組む＝各かけらの空行を U+00A0 の行に変えてから、区切り線で連結する。
 * ⚠️ 書き出し（astro-blog.ts）と変換ページの「Markdown」表示で、必ず同じこれを通す。
 *    「公開される姿」は変える前の本文を RichText で描く（空行がそのまま隙間に見える＝ブログの見え方と同じ）。
 * 空かどうかの判定には composeBody を使ってよい（空行の変換は中身の有無を変えない）。
 */
export function composePublishBody(bodies: string[], hasCard?: (key: string) => boolean): string {
  return composeBody(bodies.map((b) => markBlankLinesForBlog(b.trim(), hasCard)));
}
