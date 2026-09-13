// リンクカードの URL まわり（正規化・どの URL をカードにするか）。
// 画面とサーバの両方から使うので、DOM にも Workers の API にも依存しない。

import { isSafeHref, matchBareUrl, matchEmbed, parseStandaloneUrls } from '../markdown';

/** 落とすトラッキングのクエリ（設計 §3.2）。それ以外のクエリは残す（YouTube 等で意味を持つ）。 */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref_src',
];

/**
 * キャッシュのキーにする正規化（設計 §3.2）。
 *  前後の空白を落とす／フラグメントを落とす／トラッキングのクエリを落とす／
 *  ホストは小文字（URL が勝手にそうする）／パスは触らない／http・https 以外は扱わない。
 * ⚠️ 第二段の astro-blog の remark でも**同じ規則**にしないと JSON を引けない。
 */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!isSafeHref(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  // 触ったときだけ書き直す（searchParams を触るとクエリ全体が再エンコードされるため）
  if (TRACKING_PARAMS.some((p) => u.searchParams.has(p))) {
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
  }
  return u.toString();
}

/** カードの一段目に出すドメイン。先頭の www. だけ落とす。 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 自分の画像・画像や PDF や動画そのものへのリンクはカードにしない（設計 §7.1 と揃える）。 */
const NOT_CARD_EXT = /\.(?:jpe?g|png|gif|webp|avif|svg|pdf|mp4|mov)$/i;

/**
 * カードにしてよい URL か。
 * ⚠️ X / YouTube / Spotify の埋め込み対象はカードにしない（二重変換しない）。
 *    Spotify は置き方で埋め込みにならない行もあるが、それでもカードにはしない（astro-blog の remark-link-card と同じ）。
 */
export function isCardCandidate(url: string): boolean {
  if (!isSafeHref(url)) return false;
  if (matchEmbed(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname === 'images.kechiiiiin.com') return false;
  // かけら帳自身は Access の裏なので、取りに行ってもログイン画面の OGP しか取れない
  if (u.hostname === 'kakera.kechiiiiin.com') return false;
  if (NOT_CARD_EXT.test(u.pathname)) return false;
  return true;
}

export interface CardUrlToken {
  start: number;
  end: number;
  /** 本文に書かれたとおりの URL（リンク先にはこちらを使う） */
  url: string;
  /** キャッシュのキー（正規化済み） */
  key: string;
}

/**
 * 本文から「カードにしうる URL」を拾う＝行として独立した URL のうち、埋め込み対象でないもの。
 * 保存時の取得（サーバ）と描画（画面）の両方がこの1本を通る。
 */
export function parseCardUrls(text: string): CardUrlToken[] {
  const out: CardUrlToken[] = [];
  for (const t of parseStandaloneUrls(text)) {
    if (!isCardCandidate(t.url)) continue;
    const key = normalizeUrl(t.url);
    if (key) out.push({ start: t.start, end: t.end, url: t.url, key });
  }
  return out;
}

/** 行頭の Markdown の入れ物の記号（字下げ・引用 `>`・箇条書き `-` `*` `+` `1.` `1)`）。 */
const CONTAINER_PREFIX = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/;
/** astro-blog の remark-link-card と同じ「ASCII の印字可能文字だけの URL」。 */
const ASCII_URL = /^https?:\/\/[\x21-\x7E]+$/i;

/**
 * 日記に書き出す本文（公開版・composeBody 後）から、astro-blog の link-cards.json に載せるキーを拾う。
 *
 * astro-blog（remark-link-card）でカードになる URL は「GFM の裸の URL が段落の中で行として独立」している
 * もので、Markdown として読むので**行頭の字下げ・引用 `>`・箇条書きの記号の後ろ**の URL もカードになりうる。
 * かけら帳の parseCardUrls（行が URL と一字一句同じ）より広いので、ここでは入れ物の記号と前後の空白を
 * 剥がしてから判定する＝**ブログでカードになる URL を取りこぼさない側に倒す**（ブログでカードにならない URL が
 * 混じっても、誰も引かない行が残るだけで害は無い）。行の途中の URL は拾わない。
 * 埋め込み対象（X / YouTube / Spotify）・自分の画像・画像や PDF への直リンクは除く（isCardCandidate）。
 */
export function blogCardKeysOf(markdown: string): string[] {
  const keys = new Set<string>();
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(CONTAINER_PREFIX, '').trim();
    if (!line || !ASCII_URL.test(line)) continue;
    // 裸の URL として読んだときに行と一字一句同じか（文末の句読点付き等は、ブログでも行として独立しない）
    if (matchBareUrl(line, 0)?.url !== line) continue;
    if (!isCardCandidate(line)) continue;
    const key = normalizeUrl(line);
    if (key) keys.add(key);
  }
  return [...keys];
}
