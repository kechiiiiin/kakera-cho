// 日記ファイルの形（画面の Markdown 表示と書き出しで同じものを使うため、依存の無いここに置く）。

function yamlString(s: string): string {
  return JSON.stringify(s);
}

/**
 * astro-blog の zod（src/content/config.ts）に合わせた frontmatter。
 * description / heroImage / format は書かない（format の既定は md）。
 * ⚠️ pubDate は JST の日付のみ。時刻を入れると UTC 由来のズレを踏む（設計 §11）。
 */
export function renderDiaryFile(title: string, date: string, body: string): string {
  return [
    '---',
    `title: ${yamlString(title || date)}`,
    `pubDate: ${date}`,
    'tags: []',
    'draft: false',
    '---',
    '',
    body,
    '',
  ].join('\n');
}
