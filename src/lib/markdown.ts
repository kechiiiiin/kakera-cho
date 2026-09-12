// Markdown の扱い。書く側（素の textarea）と読む側の両方から使うので、DOM に依存しない。

/**
 * 行全体が区切り線（thematic break）か。
 * CommonMark 準拠: 先頭空白3つまで・同じ記号3つ以上・間の空白可。
 */
const HR_LINE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** コードフェンス（``` / ~~~）の開始・終了行。 */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 区切り線の行の前後に本物の空行を確保する。
 *
 * 空行が無いと `---` は setext 見出し（直前の段落に下線を引いて見出しにする記法）として
 * 解釈され、上の段落まるごとが見出しに化ける。blog-cms では Toast UI の nbsp 規約が原因で
 * これが実際に起きた（2026-08-01 の日記）。かけら帳は素の textarea なので nbsp 行は生まれないが、
 * 利用者が自分で `---` と打てば同じことが起きるので、書き出す前に必ず通す。
 *
 * コードフェンスの中は一切触らない（コード中の `---` を区切り線にしない）。
 */
export function ensureHrBlankLines(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(FENCE_LINE);

    if (fenceChar) {
      out.push(line);
      // 閉じフェンス: 同じ記号で開始行以上の長さ、かつその行に他の文字がない
      if (fence && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLen && line.trim() === fence[1]) {
        fenceChar = null;
      }
      continue;
    }
    if (fence) {
      fenceChar = fence[1]![0]!;
      fenceLen = fence[1]!.length;
      out.push(line);
      continue;
    }
    if (!HR_LINE.test(line)) {
      out.push(line);
      continue;
    }

    // 前に本物の空行を確保
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(line);
    // 後にも確保
    const next = lines[i + 1];
    if (next !== undefined && next !== '') out.push('');
  }

  return out.join('\n');
}

/**
 * 選んだかけらを区切り線で連結して1本の Markdown にする。
 * 区切り線は `---`（モックの `───` は表示用の飾り）。
 * 前後に本物の空行を確保しないと setext 見出しに化ける。
 * ⚠️ 書き出す画面のプレビューと実際の書き出しで、必ず同じこの関数を通す。
 */
export function composeBody(bodies: string[]): string {
  const joined = bodies
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .join('\n\n---\n\n');
  return ensureHrBlankLines(joined);
}

/** 本文中の Markdown 画像記法。かけらの写真はこの形で本文に埋まっている。 */
const IMAGE_TOKEN_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export interface PhotoToken {
  start: number;
  end: number;
  url: string;
}

export function parsePhotoTokens(text: string): PhotoToken[] {
  const re = new RegExp(IMAGE_TOKEN_RE.source, 'g');
  const tokens: PhotoToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    tokens.push({ start: m.index, end: m.index + m[0].length, url: m[1]! });
  }
  return tokens;
}

/** 画像記法を取り除いた素の本文（一覧の抜粋・タイトル代わりに使う）。 */
export function textForExcerpt(text: string): string {
  return text.replace(IMAGE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
}

/** 1つの画像記法だけを本文から外す（周りの空行は整える）。 */
export function removePhotoTokenAt(text: string, start: number, end: number): string {
  let merged = text.slice(0, start) + text.slice(end);
  merged = merged.replace(/\n{3,}/g, '\n\n');
  return merged.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * 画像記法をカーソル位置に差し込む文字列を組む。
 * 本文の途中なら前後に改行を足して独立した行にする（設計 §10「写真の UI」）。
 */
export function buildPhotoInsertion(before: string, after: string, url: string): string {
  let ins = `![](${url})`;
  if (before.length && before.charAt(before.length - 1) !== '\n') ins = '\n' + ins;
  if (after.length && after.charAt(0) !== '\n') ins = ins + '\n';
  return ins;
}

/** 本文の URL を差し替える（日記に出すときだけ公開バケットの URL にする）。 */
export function replacePhotoUrls(text: string, map: Map<string, string>): string {
  return text.replace(IMAGE_TOKEN_RE, (whole, url: string) => {
    const to = map.get(url);
    return to ? whole.replace(url, to) : whole;
  });
}
