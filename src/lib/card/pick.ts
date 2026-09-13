// 「見分ける」場所（かたちにする・日記にするの選ぶ所）の抜粋（リンクカード設計 §8.2）。
// 要素は作らず**文字列だけ**を作る（-webkit-line-clamp が単一のテキストノードで効くように）。
// ⚠️ ここのために OGP を取りに行かない。渡されたキャッシュを見るだけ。

import { matchBareUrl, textForExcerpt } from '../markdown';
import type { LinkCards } from './types';
import { normalizeUrl } from './url';

const SHORT_MAX = 28;

/** キャッシュに無い URL の畳み方: www. を落とし、クエリとフラグメントを落として host + path。28文字で切る。 */
export function shortUrl(url: string): string {
  let s: string;
  try {
    const u = new URL(url);
    let path = u.pathname === '/' ? '' : u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* 壊れたエスケープはそのまま */
    }
    s = u.hostname.replace(/^www\./, '') + path;
  } catch {
    s = url;
  }
  const chars = Array.from(s);
  return chars.length > SHORT_MAX ? chars.slice(0, SHORT_MAX - 1).join('') + '…' : s;
}

/**
 * 「見分ける」ための抜粋。画像記法を落とし、本文中の URL を全部タイトルかドメインに畳む。
 * 対象は行として独立していなくてもよい（ここは見分けるための抜粋なので）。
 */
export function textForPick(body: string, cards?: LinkCards): string {
  // [文字](url) はラベルだけ残す（URL を括弧ごと出さない）
  const plain = textForExcerpt(body).replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (_w, label: string, url: string) =>
    label.trim() ? label : url
  );

  let out = '';
  let pos = 0;
  const re = /https?:\/\//gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain))) {
    const hit = matchBareUrl(plain, m.index);
    if (!hit) continue;
    const key = normalizeUrl(hit.url);
    const title = key ? cards?.[key]?.title : undefined;
    out += plain.slice(pos, m.index) + (title || shortUrl(hit.url));
    pos = hit.end;
    re.lastIndex = hit.end;
  }
  return out + plain.slice(pos);
}
