// 相手のページの OGP を取る（リンクカード設計 §4）。ライブラリは使わず HTMLRewriter を直に書く。
//
// 礼儀と防御:
//  - http / https だけ。localhost・IP アドレス直指定・.local 等の内向きのホストは取りに行かない（SSRF）
//  - リダイレクトは自分で追い、行き先ごとに同じ検査をやり直す（外向きの URL から内向きへ飛ばされないため）
//  - kakera-cho/1.0 と名乗る（ブラウザを騙らない）。403 / 429 は断りとして素直に諦める
//  - タイムアウト 8 秒（リダイレクトと本文の読み込みを含めて全体で）。先頭 256KB だけ読む
//  - text/html 以外は諦める。文字コードは content-type → <meta charset> の順に見てデコードする

export const UA = 'kakera-cho/1.0 (+https://www.kechiiiiin.com/)';
export const TIMEOUT_MS = 8000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;
const TITLE_MAX = 300;
const DESCRIPTION_MAX = 500;

// ───────────────────────────────────────────────────────────────
// SSRF よけ
// ───────────────────────────────────────────────────────────────

/** 内向きの名前。DNS を引かずに名前だけで弾けるもの。 */
const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
  '.arpa', // home.arpa・逆引き
];

/**
 * 取りに行ってよい URL か。だめなら null。
 * ⚠️ IP アドレスの直指定は**帯を問わず全部**弾く（プライベート帯・リンクローカル・ループバックの
 * 抜け道を1つずつ塞ぐより確実。人が貼る普通のリンクは名前で書かれている）。
 * `http://2130706433/` や `http://0x7f.1/` のような数値表記は URL の解析で 127.0.0.1 に正規化されるので、
 * 解析後のホスト名を見れば同じ検査で弾ける。
 * ⚠️ 既定以外のポートも弾く（内向きの管理画面の多くが 8080 などに居る）。
 */
export function checkFetchable(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port !== '') return null;

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (host.startsWith('[') || host.includes(':')) return null; // IPv6 直指定
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null; // IPv4 直指定（数値表記も正規化済み）
  if (/^[\d.]+$/.test(host)) return null; // 念のため、数字だけのホストは全部
  if (!host.includes('.')) return null; // localhost・社内の短い名前
  if (host === 'localhost') return null;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return u;
}

export type SafeFetchResult = { ok: true; res: Response; finalUrl: string } | { ok: false; error: string };

/**
 * リダイレクトを自分で追う fetch。行き先ごとに checkFetchable を通す。
 * 呼ぶ側は `res.body` を読み切るか cancel すること。
 */
export async function safeFetch(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
): Promise<SafeFetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = checkFetchable(current);
    if (!u) return { ok: false, error: hop === 0 ? 'blocked host' : 'blocked redirect' };
    const res = await fetch(u.toString(), { headers: init.headers, signal: init.signal, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      try {
        current = new URL(location, u).toString();
      } catch {
        return { ok: false, error: 'bad redirect' };
      }
      continue;
    }
    return { ok: true, res, finalUrl: u.toString() };
  }
  return { ok: false, error: 'too many redirects' };
}

/** 本文を先頭 max バイトまでだけ読む。超えたら切って読むのをやめる。 */
export async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > max) {
      chunks.push(value.subarray(0, max - total));
      total = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, truncated };
}

// ───────────────────────────────────────────────────────────────
// 文字コード
// ───────────────────────────────────────────────────────────────

function charsetFromContentType(ct: string): string | null {
  const m = /charset\s*=\s*"?([^;"\s]+)/i.exec(ct);
  return m ? m[1]!.toLowerCase() : null;
}

/** 先頭の数KBから <meta charset> / <meta http-equiv content="…charset=…"> を探す（ASCII として読む）。 */
function charsetFromMeta(bytes: Uint8Array): string | null {
  const n = Math.min(bytes.byteLength, 4096);
  let head = '';
  for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i]!);
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)/i.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}

function decodeHtml(bytes: Uint8Array, contentType: string): { html: string } | { error: string } {
  const label = charsetFromContentType(contentType) ?? charsetFromMeta(bytes) ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    return { error: `charset ${label}` };
  }
  return { html: decoder.decode(bytes) };
}

// ───────────────────────────────────────────────────────────────
// パース
// ───────────────────────────────────────────────────────────────

interface HeadMeta {
  /** property / name（小文字）→ content。最初に出た値だけ */
  meta: Map<string, string>;
  title: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** 文字参照を戻す。⚠️ 結果は Preact のテキストノードとして出すので、戻しても危険は無い。 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

async function parseWithHtmlRewriter(html: string): Promise<HeadMeta> {
  const meta = new Map<string, string>();
  let title = '';
  let titleCount = 0;
  let bodySeen = false;
  const put = (key: string | null, content: string | null): void => {
    const k = key?.trim().toLowerCase();
    if (k && content != null && !meta.has(k)) meta.set(k, content);
  };
  const rewriter = new HTMLRewriter()
    .on('meta', {
      element(el) {
        const content = el.getAttribute('content');
        put(el.getAttribute('property'), content);
        put(el.getAttribute('name'), content);
      },
    })
    .on('body', {
      element() {
        bodySeen = true;
      },
    })
    .on('title', {
      element() {
        if (!bodySeen) titleCount++;
      },
      text(t) {
        // <body> より前の1つ目の <title> だけ（本文の SVG の中の title を拾わない）。
        // HTMLRewriter は文書の順に呼ぶので、body を見た後の title は数えない
        if (titleCount === 1 && !bodySeen) title += t.text;
      },
    });
  await rewriter
    .transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    .arrayBuffer();
  return { meta, title };
}

/**
 * HTMLRewriter が無い環境（`astro dev` は Node で動く）のための控え。本番の Workers では通らない。
 * 属性の読み方は素朴だが、拾う項目と優先順位は同じ。
 */
function parseWithScanner(html: string): HeadMeta {
  const meta = new Map<string, string>();
  const head = html.split(/<\/head\s*>/i)[0] ?? html;
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag))) attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
    const content = attrs.get('content');
    if (content == null) continue;
    for (const k of [attrs.get('property'), attrs.get('name')]) {
      const key = k?.trim().toLowerCase();
      if (key && !meta.has(key)) meta.set(key, content);
    }
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  return { meta, title: t ? t[1]! : '' };
}

function clean(s: string | undefined, max: number): string {
  if (!s) return '';
  // 制御文字を落とし、連続する空白を半角1つに潰す
  // eslint-disable-next-line no-control-regex
  const v = decodeEntities(s).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(v);
  return chars.length > max ? chars.slice(0, max).join('') : v;
}

function first(meta: Map<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = meta.get(k);
    if (v && v.trim()) return v;
  }
  return undefined;
}

// ───────────────────────────────────────────────────────────────
// 入口
// ───────────────────────────────────────────────────────────────

export type PageResult =
  | {
      status: 'ok';
      finalUrl: string;
      title: string;
      description: string;
      siteName: string | null;
      /** 解決済みの絶対 URL。無ければ null */
      imageUrl: string | null;
    }
  | { status: 'failed'; finalUrl: string | null; error: string };

export async function fetchPage(url: string): Promise<PageResult> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let fetched: SafeFetchResult;
  try {
    fetched = await safeFetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal,
    });
  } catch (e) {
    return { status: 'failed', finalUrl: null, error: errorLabel(e) };
  }
  if (!fetched.ok) return { status: 'failed', finalUrl: null, error: fetched.error };
  const { res, finalUrl } = fetched;

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: 'failed', finalUrl, error: `http ${res.status}` };
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!/^\s*(?:text\/html|application\/xhtml\+xml)/i.test(ct)) {
    await res.body?.cancel().catch(() => undefined);
    return { status: 'failed', finalUrl, error: 'not html' };
  }

  let bytes: Uint8Array;
  try {
    bytes = (await readCapped(res, MAX_BYTES)).bytes;
  } catch (e) {
    return { status: 'failed', finalUrl, error: errorLabel(e) };
  }
  const decoded = decodeHtml(bytes, ct);
  if ('error' in decoded) return { status: 'failed', finalUrl, error: decoded.error };

  const { meta, title: docTitle } =
    typeof HTMLRewriter === 'undefined' ? parseWithScanner(decoded.html) : await parseWithHtmlRewriter(decoded.html);

  const host = new URL(finalUrl).hostname;
  const title = clean(first(meta, ['og:title', 'twitter:title']) ?? docTitle, TITLE_MAX) || host;
  const description = clean(
    first(meta, ['og:description', 'twitter:description', 'description']),
    DESCRIPTION_MAX
  );
  const siteName = clean(first(meta, ['og:site_name']), TITLE_MAX) || null;

  // 化けたカードは出さない（<meta charset> の読み違い等）
  if ((title + description + (siteName ?? '')).includes('�')) {
    return { status: 'failed', finalUrl, error: 'garbled' };
  }

  // 相対の og:image は最終 URL を基準に解決する。解決できなければ画像なし（カードは作る）
  let imageUrl: string | null = null;
  const rawImage = first(meta, ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
  if (rawImage) {
    try {
      const abs = new URL(decodeEntities(rawImage.trim()), finalUrl);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') imageUrl = abs.toString();
    } catch {
      imageUrl = null;
    }
  }

  return { status: 'ok', finalUrl, title, description, siteName, imageUrl };
}

export function errorLabel(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
    return e.message.slice(0, 200) || e.name;
  }
  return String(e).slice(0, 200);
}
