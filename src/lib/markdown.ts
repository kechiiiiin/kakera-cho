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

// ───────────────────────────────────────────────────────────────
// 埋め込み（X / YouTube / Spotify）
//
// ⚠️⚠️ 以下の判別（正規表現と「どういう置き方の URL だけを埋め込みにするか」という条件）は、
//   X / YouTube: `~/work/astro-blog/src/plugins/remark-media-embed.ts`
//   Spotify:     `~/work/astro-blog/src/plugins/remark-spotify-embed.ts`
// の **写し** です。**どちらかを直したら、必ずもう一方も同じように直してください。**
//
// 理由: かけら帳のこの画面は「astro-blog で公開したらこう見える」の**プレビュー**です。
// 判別が食い違うと、かけら帳で埋め込みに見えたものが公開後は素のリンク（またはその逆）になり、
// **プレビューである意味が無くなります**。
//
// npm パッケージにして共有はしません。50行ほどのために publish →2リポジトリ更新 →それぞれデプロイ、
// では規模に釣り合わないためです（Keisuke と相談のうえ決定）。**3つ目のアプリが出てきたら見直す。**
//
// ⚠️ 置き方の条件は X / YouTube と Spotify で違います（ブログ側の二つのプラグインがそうなっているため）:
//   X / YouTube … **行として独立**していればよい（段落の途中の行でも埋め込みになる）
//   Spotify     … **段落がその URL だけ**のとき（前後が空行か本文の端）。空行を挟まず前後に文が続く行は素のリンク
// 日記は かけらを `---` と空行で区切って連結する（composeBody）ので、かけらの本文の端は段落の端になる。
//
// ここも**データを返すだけ**で HTML 文字列は作らない。描くのは RichText 側で Preact の要素を組む。
// ───────────────────────────────────────────────────────────────

/** youtu.be/ID, watch?v=ID, shorts/ID, live/ID, embed/ID（si= 等のクエリは無視） */
const YOUTUBE_PATTERN =
  /^https:\/\/(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/))([A-Za-z0-9_-]{11})/;
const TWEET_PATTERN =
  /^https:\/\/(?:x\.com|(?:mobile\.)?twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+/;

/** YouTube の動画 ID として src に入れてよい形か（11文字の英数字・`_`・`-` だけ）。 */
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Spotify（remark-spotify-embed.ts の SPOTIFY_PATTERN の写し。先頭一致・後ろのクエリ等は見ない）。 */
const SPOTIFY_PATTERN =
  /^https:\/\/open\.spotify\.com\/(track|album|artist|playlist|episode|show)\/([a-zA-Z0-9]+)/;

export type SpotifyType = 'track' | 'album' | 'artist' | 'playlist' | 'episode' | 'show';
/** Spotify の種別・ID として src に入れてよい形か。 */
export const SPOTIFY_TYPE_RE = /^(?:track|album|artist|playlist|episode|show)$/;
export const SPOTIFY_ID_RE = /^[A-Za-z0-9]+$/;

export type Embed =
  | { kind: 'youtube'; id: string }
  | { kind: 'tweet'; url: string }
  | { kind: 'spotify'; type: SpotifyType; id: string };

export interface EmbedToken {
  start: number;
  end: number;
  embed: Embed;
}

/** URL ひとつを埋め込みの種別に振り分ける。対象外なら null。 */
export function matchEmbed(url: string): Embed | null {
  if (!isSafeHref(url)) return null;
  const yt = YOUTUBE_PATTERN.exec(url);
  if (yt) {
    const id = yt[1]!;
    // 正規表現で既に 11 文字に絞っているが、src に入れる値なので念のためもう一度通す
    return YOUTUBE_ID_RE.test(id) ? { kind: 'youtube', id } : null;
  }
  if (TWEET_PATTERN.test(url)) return { kind: 'tweet', url };
  const sp = SPOTIFY_PATTERN.exec(url);
  if (sp) {
    const type = sp[1]!;
    const id = sp[2]!;
    return SPOTIFY_TYPE_RE.test(type) && SPOTIFY_ID_RE.test(id)
      ? { kind: 'spotify', type: type as SpotifyType, id }
      : null;
  }
  return null;
}

const BLANK_LINE = /^[ \t]*$/;

/**
 * 「行として独立した URL」だけを埋め込みとして拾う（astro-blog の `isLineStandalone` と同じ考え方）。
 * ⚠️ 行の途中に書かれた URL は拾わない＝今までどおり素のリンクになる。
 * 行そのものが URL と一字一句同じときだけ対象（前後に文字や空白が付いていたら対象外）。
 * ⚠️ Spotify だけは、さらに**前後の行が空行か本文の端**のときだけ（remark-spotify-embed の
 *    「段落に link が1つだけ」の写し）。満たさない Spotify の行は、埋め込みにもカードにもならず素のリンク。
 */
export function parseEmbedTokens(text: string): EmbedToken[] {
  const tokens: EmbedToken[] = [];
  const lines = text.split('\n');
  let pos = 0;
  lines.forEach((line, i) => {
    const embed = line ? matchEmbed(line) : null;
    if (embed) {
      const alone =
        embed.kind !== 'spotify' ||
        ((i === 0 || BLANK_LINE.test(lines[i - 1]!)) && (i === lines.length - 1 || BLANK_LINE.test(lines[i + 1]!)));
      if (alone) tokens.push({ start: pos, end: pos + line.length, embed });
    }
    pos += line.length + 1; // +1 は '\n'
  });
  return tokens;
}

export interface StandaloneUrl {
  start: number;
  end: number;
  url: string;
}

/**
 * 本文から「その行がまるごと URL だけ」の行を拾う（リンクカード設計 §8.3）。行の途中の URL は拾わない。
 * 行そのものが、裸の URL として読んだときの URL と一字一句同じときだけ対象
 * （前後に文字や空白、文末の句読点が付いていたら対象外）。
 * ⚠️ 埋め込み（X / YouTube / Spotify）かどうかはここでは見ない。振り分けは呼ぶ側（card/url.ts・RichText）。
 */
export function parseStandaloneUrls(text: string): StandaloneUrl[] {
  const out: StandaloneUrl[] = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    if (line && isSafeHref(line)) {
      const m = matchBareUrl(line, 0);
      if (m && m.url === line) out.push({ start: pos, end: pos + line.length, url: line });
    }
    pos += line.length + 1; // +1 は '\n'
  }
  return out;
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

/**
 * 検索結果に添える抜粋（設計 §7「どのかけらがヒットしたか」）。
 * 画像記法を除いた本文から、ヒットした位置の前後を切り出す。見つからなければ冒頭を切り出す。
 */
export function buildExcerpt(body: string, query: string, radius = 24): string {
  const plain = textForExcerpt(body);
  const q = query.trim();
  const idx = q ? plain.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) {
    return plain.length > radius * 2 ? plain.slice(0, radius * 2).trim() + '…' : plain;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(plain.length, idx + q.length + radius);
  let excerpt = plain.slice(start, end).trim();
  if (start > 0) excerpt = '…' + excerpt;
  if (end < plain.length) excerpt = excerpt + '…';
  return excerpt;
}

/** 本文の URL を差し替える（日記に出すときだけ公開バケットの URL にする）。 */
export function replacePhotoUrls(text: string, map: Map<string, string>): string {
  return text.replace(IMAGE_TOKEN_RE, (whole, url: string) => {
    const to = map.get(url);
    return to ? whole.replace(url, to) : whole;
  });
}

// ───────────────────────────────────────────────────────────────
// 行内書式（読む画面で開くぶん）
//
// 解釈するのは**行内だけ**: **太字** / *斜体* / [リンク](url) / `コード` / ~~打ち消し~~。
// 見出し `#`・区切り線 `---`・引用 `>`・リスト・表は**解釈しない**（一言メモに行を組み替える
// 記法は大げさで、`---` は日記を組むときの区切りと衝突する）。
//
// ⚠️ ここは**データ（木）を返すだけ**で、HTML 文字列は一切作らない。描くのは RichText 側で
// Preact の要素を組み立てる。文字列連結で HTML を作らない限り、本文に script タグや
// onerror 付きの img と書かれても、ただの文字として出る。
// ⚠️ ライブラリは足さない（依存ゼロが今の流儀）。小さな手書きのパーサで足りる。
// ───────────────────────────────────────────────────────────────

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: InlineNode[] }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'del'; children: InlineNode[] };

/** バックスラッシュで打ち消せる記号。 */
const ESCAPABLE = '\\`*_~[]()!#-';

/**
 * リンクにしてよい URL か。**ホワイトリスト方式で http / https だけ**通す。
 * `javascript:` `data:` `vbscript:` はもちろん、スキームの無い相対 URL もリンクにしない。
 * 通らなかったものは記法のまま素の文字として出す（黙って消さない）。
 */
export function isSafeHref(url: string): boolean {
  const u = url.trim();
  // 空白・制御文字・山括弧・引用符を含むものは弾く（`java&#9;script:` のような小細工よけ）
  if (!u || /[\s<>"']/.test(u)) return false;
  for (let i = 0; i < u.length; i++) {
    const code = u.charCodeAt(i);
    if (code < 0x21 || code === 0x7f) return false;
  }
  return /^https?:\/\/./i.test(u);
}

/**
 * 裸の URL（`https://…` とそのまま書いたもの）の終わりを探す。
 *
 * URL は ASCII の印字可能文字だけで出来ているものとして切る。直後に空白を挟まず
 * 日本語が続くとき（`https://example.com見た`）に、日本語まで URL に飲み込まないため。
 * 文末の句読点や閉じ括弧は URL から外す（`https://example.com。` の `。` は文の一部）。
 * 括弧は釣り合っているぶんだけ残す（`https://ja.wikipedia.org/wiki/x_(y)` を壊さない）。
 */
export function matchBareUrl(text: string, i: number): { url: string; end: number } | null {
  const m = /^https?:\/\/[\x21-\x7E]+/.exec(text.slice(i));
  if (!m) return null;
  let url = m[0];

  // 釣り合わない閉じ括弧を落とす（`(https://example.com)` の `)` は文の側）
  while (url.endsWith(')')) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (opens >= closes) break;
    url = url.slice(0, -1);
  }
  // 文末に付きがちな記号を落とす
  url = url.replace(/[.,!?:;'"`\]\}>]+$/, '');

  if (!isSafeHref(url)) return null;
  return { url, end: i + url.length };
}

/** 強調の記号は段落（空行）をまたがない。暴走した書式が後ろ全部を飲み込まないため。 */
function blankLineAt(text: string, i: number): boolean {
  return text.charAt(i) === '\n' && text.charAt(i + 1) === '\n';
}

/** 閉じ記号の位置。見つからなければ -1。 */
function findClosing(text: string, from: number, mark: string): number {
  let i = from;
  while (i < text.length) {
    if (text.charAt(i) === '\\') {
      i += 2;
      continue;
    }
    if (blankLineAt(text, i)) return -1;
    if (text.startsWith(mark, i)) {
      // 単独の * を探しているとき、** の片割れを閉じ記号にしない
      if (mark === '*' && text.charAt(i + 1) === '*') {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

interface LinkMatch {
  label: string;
  href: string;
  /** 元の記法そのまま（安全でない URL のとき、この文字列をそのまま出す） */
  raw: string;
  end: number;
}

/** `[ラベル](URL)` を i の位置から読む。読めなければ null。 */
function matchLink(text: string, i: number): LinkMatch | null {
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const c = text.charAt(j);
    if (c === '\\') {
      j++;
      continue;
    }
    if (blankLineAt(text, j)) return null;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= text.length || text.charAt(j) !== ']' || text.charAt(j + 1) !== '(') return null;
  let close = -1;
  for (let k = j + 2; k < text.length; k++) {
    const c = text.charAt(k);
    if (c === '\\') {
      k++;
      continue;
    }
    if (c === '\n') return null; // URL は行をまたがない
    if (c === ')') {
      close = k;
      break;
    }
  }
  if (close < 0) return null;
  const dest = text.slice(j + 2, close).trim();
  const href = dest.split(/\s+/)[0] ?? ''; // `url "title"` の title は捨てる
  return { label: text.slice(i + 1, j), href, raw: text.slice(i, close + 1), end: close + 1 };
}

const DELIMS: ReadonlyArray<{ mark: string; type: 'strong' | 'del' | 'em' }> = [
  { mark: '**', type: 'strong' },
  { mark: '~~', type: 'del' },
  { mark: '*', type: 'em' },
];

/** 行内書式を木に開く。解釈できなかった記号はそのまま文字として残る。 */
export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = '';
  let i = 0;

  const flush = (): void => {
    if (buf) {
      out.push({ type: 'text', value: buf });
      buf = '';
    }
  };

  while (i < text.length) {
    const c = text.charAt(i);

    // 打ち消し（\* など）
    if (c === '\\' && i + 1 < text.length && ESCAPABLE.includes(text.charAt(i + 1))) {
      buf += text.charAt(i + 1);
      i += 2;
      continue;
    }

    // 画像記法はここでは開かない（写真として別に扱う）。リンクに化けないよう丸ごと文字にする。
    if (c === '!' && text.charAt(i + 1) === '[') {
      const img = matchLink(text, i + 1);
      if (img) {
        buf += text.slice(i, img.end);
        i = img.end;
        continue;
      }
    }

    // `コード`
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        out.push({ type: 'code', value: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    // [リンク](url)
    if (c === '[') {
      const m = matchLink(text, i);
      if (m) {
        flush();
        if (isSafeHref(m.href)) {
          out.push({ type: 'link', href: m.href.trim(), children: parseInline(m.label) });
        } else {
          out.push({ type: 'text', value: m.raw }); // 安全でない URL は素の文字として出す
        }
        i = m.end;
        continue;
      }
    }

    // 裸の URL をそのままリンクにする。
    // ⚠️ `[文字](url)` と `![](url)` は上で処理済みなので、ここへは来ない。
    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(text.slice(i, i + 8))) {
      const u = matchBareUrl(text, i);
      if (u) {
        flush();
        out.push({ type: 'link', href: u.url, children: [{ type: 'text', value: u.url }] });
        i = u.end;
        continue;
      }
    }

    // **太字** / ~~打ち消し~~ / *斜体*
    let matched = false;
    for (const d of DELIMS) {
      if (!text.startsWith(d.mark, i)) continue;
      const from = i + d.mark.length;
      const close = findClosing(text, from, d.mark);
      if (close <= from) continue;
      // 中身が空白で始まる／終わるものは書式にしない（`5 * 3 * 2 = 30` を斜体にしないため）
      const inner = text.slice(from, close);
      if (/^\s/.test(inner) || /\s$/.test(inner)) continue;
      flush();
      out.push({ type: d.type, children: parseInline(inner) });
      i = close + d.mark.length;
      matched = true;
      break;
    }
    if (matched) continue;

    buf += c;
    i++;
  }

  flush();
  return out;
}

// ───────────────────────────────────────────────────────────────
// 書く欄の書式ボタン（textarea のまま扱う。DOM には触らない）
// ───────────────────────────────────────────────────────────────

export interface TextEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * 選択範囲を `**` で囲む／既に囲まれていれば外す。
 * 選択が無ければ `****` を入れてカーソルを真ん中へ。
 */
export function toggleBold(text: string, start: number, end: number): TextEdit {
  if (start === end) {
    return {
      text: text.slice(0, start) + '****' + text.slice(start),
      selectionStart: start + 2,
      selectionEnd: start + 2,
    };
  }
  const selected = text.slice(start, end);

  // 選択そのものが **…** のとき
  if (selected.length >= 4 && selected.startsWith('**') && selected.endsWith('**')) {
    const inner = selected.slice(2, -2);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }
  // 選択の外側が **…** のとき
  if (start >= 2 && text.slice(start - 2, start) === '**' && text.slice(end, end + 2) === '**') {
    return {
      text: text.slice(0, start - 2) + selected + text.slice(end + 2),
      selectionStart: start - 2,
      selectionEnd: start - 2 + selected.length,
    };
  }
  return {
    text: text.slice(0, start) + '**' + selected + '**' + text.slice(end),
    selectionStart: start + 2,
    selectionEnd: start + 2 + selected.length,
  };
}

/**
 * 選択範囲を `[選んだ文字]()` にしてカーソルを `()` の中へ。
 * 選択が無ければ `[]()` を入れてカーソルを `[]` の中へ。
 * ⚠️ URL は prompt() で尋ねない（iOS で辛い）。記法を入れてカーソルを置くだけ。
 */
export function insertLink(text: string, start: number, end: number): TextEdit {
  const selected = text.slice(start, end);
  const next = text.slice(0, start) + '[' + selected + ']()' + text.slice(end);
  const caret = selected ? start + selected.length + 3 : start + 1;
  return { text: next, selectionStart: caret, selectionEnd: caret };
}
