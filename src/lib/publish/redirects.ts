// astro-blog の public/_redirects（日記の日付を変えたときの旧 URL → 新 URL の転送）。
// ⚠️ Workers Static Assets は、同じパスに実ファイルがあっても _redirects を優先する
//   （Redirects are always followed, regardless of whether or not an asset matches）。
//   だから、ある日付の日記を書き出すときは、その日付を転送元にしている行を必ず落とす（dropRedirectsFrom）。

export const REDIRECTS_PATH = 'public/_redirects';

/** 日記の公開 URL のパス（astro-blog の getDiaryPath と同じ形・末尾スラッシュ付き）。 */
export function diaryUrlPath(date: string): string {
  const [y, m, d] = date.split('-');
  return `/diary/${y}/${m}/${d}/`;
}

const REDIRECTS_HEADER = [
  '# 日記の日付を変えたときの転送（旧 URL → 新 URL）。かけら帳が日付を変えるたびに書き足す。',
  '# Workers Static Assets の _redirects。https://developers.cloudflare.com/workers/static-assets/redirects/',
];

function stripSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * _redirects に「from の日記 → to の日記」を足す。
 * - 移す先（to）から出ていく転送は消す（移し戻したときに新しい URL が転送で潰れないように）
 * - 今まで from を指していた転送は to へ付け替える（転送を連ねない）
 * - 転送元と転送先が同じになった行は消す
 * - 末尾スラッシュの有無の両方を載せる
 * 他の行（日記と関係ない転送・コメント）はそのまま残す。
 */
export function updateRedirects(text: string | null, fromDate: string, toDate: string): string {
  const from = diaryUrlPath(fromDate);
  const to = diaryUrlPath(toDate);
  const lines = text === null ? [...REDIRECTS_HEADER] : text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      out.push(line);
      continue;
    }
    const [src, dst, ...rest] = t.split(/\s+/);
    if (!src || !dst) {
      out.push(line);
      continue;
    }
    if (stripSlash(src) === stripSlash(to) || stripSlash(src) === stripSlash(from)) continue;
    const nextDst = stripSlash(dst) === stripSlash(from) ? to : dst;
    if (stripSlash(src) === stripSlash(nextDst)) continue;
    out.push(nextDst === dst ? line : [src, nextDst, ...rest].join(' '));
  }
  out.push(`${stripSlash(from)} ${to} 301`, `${from} ${to} 301`);
  return out.join('\n') + '\n';
}


/**
 * その日付の日記の URL を転送元にしている行を落とす（新しく書き出す／書き足す日記が転送で読めなくならないように）。
 * 変わらなければ null。
 */
export function dropRedirectsFrom(text: string, date: string): string | null {
  const url = stripSlash(diaryUrlPath(date));
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return true;
    const [src] = t.split(/\s+/);
    return !src || stripSlash(src) !== url;
  });
  if (kept.length === lines.length) return null;
  return kept.join('\n') + '\n';
}
