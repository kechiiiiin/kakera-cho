// リンクカードの URL まわり（正規化・どの URL をカードにするか）。
// 画面とサーバの両方から使うので、DOM にも Workers の API にも依存しない。

import { isSafeHref, matchEmbed, parseStandaloneUrls } from '../markdown';

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
 * ⚠️ X / YouTube の埋め込み対象はカードにしない（二重変換しない）。
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
