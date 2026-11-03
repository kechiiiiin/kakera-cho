// 「見分ける」場所（かたちにする・日記にするの選ぶ所）の抜粋（リンクカード設計 §8.2）。
// 要素は作らず**文字列だけ**を作る（-webkit-line-clamp が単一のテキストノードで効くように）。
// ⚠️ ここのために OGP を取りに行かない。渡されたキャッシュを見るだけ。

import { matchBareUrl, textForExcerpt, type WordCandidate } from '../markdown';
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
  // ラベルの中の括弧ひと組までは読む（`[[a]](url)` はリンクで、言葉の括弧を外した後にも残るため）
  const plain = textForExcerpt(body).replace(
    /\[((?:[^[\]]|\[[^\]]*\])*)\]\((https?:\/\/[^)\s]+)\)/gi,
    (_w, label: string, url: string) => (label.trim() ? label : url)
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

const CONTEXT_BEFORE = 30;
const CONTEXT_AFTER = 60;

/**
 * 確認の行に添える、候補の言葉の前後の文（かけら言葉リンク設計 §3.5）。括弧・書式の記号・写真は出さず、URL は畳む。
 * 長い本文は言葉のまわりだけにする。文字列を返すだけで、言葉の強調は画面が要素で組む。
 */
export function candidateContext(
  body: string,
  c: WordCandidate,
  cards?: LinkCards
): { before: string; word: string; after: string } {
  const clean = (raw: string): string => {
    const s = textForPick(raw, cards).replace(/\*\*|~~/g, '');
    return `${/^\s/.test(raw) && s ? ' ' : ''}${s}${/\s$/.test(raw) && s ? ' ' : ''}`;
  };
  const before = Array.from(clean(body.slice(0, c.start)));
  const after = Array.from(clean(body.slice(c.end)));
  return {
    before: (before.length > CONTEXT_BEFORE ? '…' : '') + before.slice(-CONTEXT_BEFORE).join(''),
    word: c.word,
    after: after.slice(0, CONTEXT_AFTER).join('') + (after.length > CONTEXT_AFTER ? '…' : ''),
  };
}
