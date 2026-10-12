// 日記に出すかけらの時刻の小見出し（かけら時刻表示設計・2026-10-12「表記2」）。
// 画面（変換ページの Markdown 表示）と書き出しの両方から使うので、DOM にも Workers にも依存しない。
//
// 形（1行の HTML。前後は本物の空行）:
//   <p class="kakera-time"><time datetime="2026-10-11T03:20:00+09:00">10-11 03:20</time></p>
//
// なぜ見出し記法（`###`）にしないか:
//  - 日記の見出しとして目次・見出しの扱い（h3 の余白・アンカー）に混ざる。時刻は文書の構造ではなく、かけらの添え書き
//  - astro-blog は Markdown の生 HTML を通す（Astro の既定・RSS の markdown-it も html: true）。
//    クラス付きの段落なら astro-blog の DiaryPost.astro の `.diary-content p.kakera-time` だけで見た目を決められ、
//    他の段落・空行段落（p.blank-line）・リンクカード・埋め込みの判定に触れない
// ⚠️ この行の直後には本物の空行を置く（CommonMark の HTML ブロックは空行で閉じる。空行が無いと、
//    続く本文が HTML の中身として生のまま出て、Markdown として読まれない）。
// ⚠️ 名前の置き換え・写真の除去・空行の U+00A0 化の**後**に足す（時刻の行に名前は無く、空行の規約の対象でもない）。

import type { KakeraTimeHead } from '../kakera/time-label';

/** 段落のクラス名（astro-blog の DiaryPost.astro と揃える）。 */
export const TIME_HEAD_CLASS = 'kakera-time';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 時刻の小見出しの1行。 */
export function timeHeadLine(head: KakeraTimeHead): string {
  return `<p class="${TIME_HEAD_CLASS}"><time datetime="${escapeHtml(head.datetime)}">${escapeHtml(head.label)}</time></p>`;
}

/**
 * かけら1枚（公開版・空行の変換を済ませたもの）の頭に時刻の小見出しを足す。
 * 中身が空のかけら（写真をすべて出さない等）は空のまま返す＝時刻だけが日記に残らない（composeBody が飛ばす）。
 */
export function withTimeHead(body: string, head: KakeraTimeHead | null | undefined): string {
  const b = body.trim();
  if (!head || !b) return b;
  return `${timeHeadLine(head)}\n\n${b}`;
}
