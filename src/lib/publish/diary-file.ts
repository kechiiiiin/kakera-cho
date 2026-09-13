// 日記ファイルの形（画面の Markdown 表示と書き出しで同じものを使うため、依存の無いここに置く）。

function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** 説明文の上限（文字数・コードポイント単位）。画面の目安とサーバの 400 で同じ値を使う。 */
export const DESCRIPTION_MAX = 200;

/**
 * 説明文を一行に畳む。改行（CR/LF・U+0085・U+2028・U+2029）とタブは前後の半角空白ごと一つの空白に、前後の空白は落とす。
 * 全角空白は文章の一部なので残す。
 */
export function flattenDescription(s: string): string {
  return s
    .replace(/[ \t]*[\r\n\u0085\u2028\u2029]+[ \t]*/g, ' ')
    .replace(/\t/g, ' ')
    .trim();
}

/** 説明文の文字数（画面の目安表示とサーバの上限で同じ数え方にする）。 */
export function descriptionLength(s: string): number {
  return Array.from(s).length;
}

/**
 * astro-blog の zod（src/content/config.ts）に合わせた frontmatter。
 * description は空でなければ書く（空なら書かない＝サイト既定の紹介文）。heroImage / format は書かない（format の既定は md）。
 * ⚠️ pubDate は JST の日付のみ。時刻を入れると UTC 由来のズレを踏む（設計 §11）。
 */
export function renderDiaryFile(title: string, date: string, body: string, description = ''): string {
  const desc = flattenDescription(description);
  return [
    '---',
    `title: ${yamlString(title || date)}`,
    ...(desc ? [`description: ${yamlString(desc)}`] : []),
    `pubDate: ${date}`,
    'tags: []',
    'draft: false',
    '---',
    '',
    body,
    '',
  ].join('\n');
}
