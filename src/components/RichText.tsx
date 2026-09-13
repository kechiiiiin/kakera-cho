import { Fragment } from 'preact';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Embed, InlineNode } from '../lib/markdown';
import { YOUTUBE_ID_RE, isSafeHref, parseEmbedTokens, parseInline, parsePhotoTokens } from '../lib/markdown';
import type { LinkCard, LinkCards } from '../lib/card/types';
import { parseCardUrls } from '../lib/card/url';

/**
 * 行内書式の木を Preact の要素に組み立てる。
 *
 * ⚠️ `dangerouslySetInnerHTML` は使わない。文字列連結で HTML を作らないので、
 * 本文に `<script>` や `<img onerror=…>` と書かれても Preact が文字として逃がす。
 * リンクは http / https だけ（パーサ側でホワイトリスト済み）・別タブ・rel 付きで開く。
 */
function renderInline(nodes: InlineNode[], prefix = ''): JSX.Element[] {
  return nodes.map((n, i) => {
    const key = `${prefix}${i}`;
    switch (n.type) {
      case 'code':
        return <code key={key}>{n.value}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(n.children, key + '-')}</strong>;
      case 'em':
        return <em key={key}>{renderInline(n.children, key + '-')}</em>;
      case 'del':
        return <del key={key}>{renderInline(n.children, key + '-')}</del>;
      case 'link':
        return (
          <a key={key} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.children, key + '-')}
          </a>
        );
      default:
        return <Fragment key={key}>{n.value}</Fragment>;
    }
  });
}

/** 本文のひとかたまりを、行内書式を開いて段落として描く。 */
function Block({ text, keyPrefix }: { text: string; keyPrefix: string }): JSX.Element {
  return <p class="rich-text-block">{renderInline(parseInline(text), keyPrefix)}</p>;
}

// ───────────────────────────────────────────────────────────────
// 埋め込み（X / YouTube）
//
// ⚠️ ここも**要素を組むだけ**で HTML 文字列は作らない（`dangerouslySetInnerHTML` は使わない）。
// iframe の src は、パーサ側で検証済みの**動画 ID だけ**から組み立てる。
// 利用者が書いた URL やクエリは src に一切入らない。
// ───────────────────────────────────────────────────────────────

interface TwitterWidgets {
  widgets?: { load?: (el?: Element) => void };
}

/** X の widgets.js。**埋め込みが画面にあるときだけ**読み込む・読み込みは一度きり。 */
let twitterScriptRequested = false;

function loadTwitterWidgets(scope: Element | null): void {
  if (typeof document === 'undefined') return;
  const twttr = (window as unknown as { twttr?: TwitterWidgets }).twttr;
  if (twttr?.widgets?.load) {
    twttr.widgets.load(scope ?? undefined);
    return;
  }
  if (twitterScriptRequested) return; // 読み込み中。script 側が読み終わりに全体を走査する
  twitterScriptRequested = true;
  const s = document.createElement('script');
  s.src = 'https://platform.twitter.com/widgets.js';
  s.async = true; // ⚠️ 画面の描画を待たせない（設計 §8「トップは常時即表示」）
  document.head.appendChild(s);
}

/**
 * X のポスト。widgets.js が hydrate して本物の埋め込みになる。
 * ⚠️ hydrate に失敗しても（ブロック・オフライン・ポスト削除）、URL のリンクとして読める形を保つ。
 */
function Tweet({ url }: { url: string }): JSX.Element {
  const ref = useRef<HTMLQuoteElement>(null);
  useEffect(() => {
    loadTwitterWidgets(ref.current);
  }, [url]);
  return (
    <blockquote class="twitter-tweet embed-tweet" ref={ref}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
    </blockquote>
  );
}

/** YouTube。nocookie ドメイン・16:9・遅延読み込み。パラメータは astro-blog 側と同じ。 */
function YouTube({ id }: { id: string }): JSX.Element | null {
  if (!YOUTUBE_ID_RE.test(id)) return null; // src に入る値なので描く直前にもう一度確かめる
  return (
    <div class="embed-youtube">
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${id}?rel=0&hl=en`}
        title="YouTube"
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
  );
}

function EmbedBlock({ embed }: { embed: Embed }): JSX.Element | null {
  return embed.kind === 'youtube' ? <YouTube id={embed.id} /> : <Tweet url={embed.url} />;
}

// ───────────────────────────────────────────────────────────────
// リンクカード（リンクカード設計 §8.5・2026-09-13 に決まった形）
//
//  左に正方形の画像、右に ドメイン（灰）→ タイトル（黒）→ 説明（灰）。細い枠の角丸の箱。
//  画像が無い・取り込めなかった・読めなかったときは、「画像が無い」と分かる空白の画像を置く。
//
// ⚠️ 他人のサイトから来たタイトル・説明・ドメインは**必ずテキストノードとして**出す（HTML にしない）。
// ⚠️ href は isSafeHref を通した本文の URL だけ。img の src は自分の /api/photo/kakera/cards/* だけ
//    （相手の URL を直接 src に入れない＝閲覧が相手に伝わらない）。
// ───────────────────────────────────────────────────────────────

const CARD_IMAGE_SRC = /^\/api\/photo\/kakera\/cards\/[A-Za-z0-9_.-]+$/;

/** 画像が無いことを示す空白の画像。外部の画像は読まず、SVG を要素として組む（文字・絵文字なし）。 */
function BlankThumb(): JSX.Element {
  return (
    <svg class="link-card-blank" viewBox="0 0 80 80" aria-hidden="true" focusable="false">
      <rect x="24.5" y="27.5" width="31" height="25" rx="1.5" fill="none" stroke="currentColor" stroke-width="1" />
      <circle cx="47" cy="35" r="2.5" fill="none" stroke="currentColor" stroke-width="1" />
      <path
        d="M27 50 L36 40.5 L42 46.5 L46 42.5 L53 50"
        fill="none"
        stroke="currentColor"
        stroke-width="1"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
  );
}

function CardView({ href, card }: { href: string; card: LinkCard }): JSX.Element | null {
  const [broken, setBroken] = useState(false);
  if (!isSafeHref(href)) return null;
  const src = card.image && CARD_IMAGE_SRC.test(card.image) ? card.image : null;
  return (
    <a class="link-card" href={href} target="_blank" rel="noopener noreferrer">
      <span class="link-card-thumb">
        {src && !broken ? (
          <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <BlankThumb />
        )}
      </span>
      <span class="link-card-text">
        {card.domain ? <span class="link-card-site">{card.domain}</span> : null}
        <span class="link-card-title">{card.title}</span>
        {card.description ? <span class="link-card-desc">{card.description}</span> : null}
      </span>
    </a>
  );
}

/** 本文を割る位置（写真・埋め込み・カード）。本文に書いてある順にそのまま並べる。 */
type Slot =
  | { start: number; end: number; kind: 'photo'; url: string }
  | { start: number; end: number; kind: 'embed'; embed: Embed }
  | { start: number; end: number; kind: 'card'; url: string; card: LinkCard };

/**
 * 行として独立した URL の振り分け（リンクカード設計 §8.4）:
 *   X / YouTube → 埋め込み ／ キャッシュにカードがある → カード ／ それ以外 → 素のリンク（Block の中で開く）
 * キャッシュに無い URL は取得を待たない・後から差し替えもしない。
 */
function slotsOf(text: string, cards: LinkCards | undefined): Slot[] {
  const slots: Slot[] = [
    ...parsePhotoTokens(text).map((t): Slot => ({ start: t.start, end: t.end, kind: 'photo', url: t.url })),
    ...parseEmbedTokens(text).map((t): Slot => ({ start: t.start, end: t.end, kind: 'embed', embed: t.embed })),
  ];
  if (cards) {
    for (const t of parseCardUrls(text)) {
      const card = cards[t.key];
      if (card) slots.push({ start: t.start, end: t.end, kind: 'card', url: t.url, card });
    }
  }
  return slots.sort((a, b) => a.start - b.start);
}

/**
 * かけらの本文を読めるように描く。
 * 画像記法を実際の写真に開き、**行として独立した X / YouTube の URL**を埋め込みに、
 * **キャッシュのある行として独立した URL**をリンクカードに開き、
 * **行内書式**（太字・斜体・リンク・コード・打ち消し）も開く。
 * 見出し・区切り線・引用・リスト・表は開かない（改行はそのまま見せる: white-space: pre-wrap）。
 */
export function RichText({
  text,
  imgClass,
  cards,
}: {
  text: string;
  imgClass: string;
  /** 正規化 URL → カード。無ければ全部素のリンク */
  cards?: LinkCards;
}): JSX.Element | null {
  const slots = slotsOf(text, cards);
  if (!slots.length) {
    const t = text.trim();
    return t ? <Block text={t} keyPrefix="b" /> : null;
  }

  const parts: JSX.Element[] = [];
  let pos = 0;
  slots.forEach((slot, i) => {
    const chunk = text.slice(pos, slot.start).trim();
    if (chunk) parts.push(<Block text={chunk} keyPrefix={`t${i}-`} key={`t${i}`} />);
    if (slot.kind === 'photo') {
      parts.push(
        <div class={imgClass} key={`p${i}`}>
          <img src={slot.url} alt="" loading="lazy" />
        </div>
      );
    } else if (slot.kind === 'embed') {
      parts.push(<EmbedBlock embed={slot.embed} key={`e${i}`} />);
    } else {
      parts.push(<CardView href={slot.url} card={slot.card} key={`c${i}`} />);
    }
    pos = slot.end;
  });
  const rest = text.slice(pos).trim();
  if (rest) parts.push(<Block text={rest} keyPrefix="tail-" key="tail" />);
  return <>{parts}</>;
}

/** 一覧の行に添える、1枚目の小さなサムネ（2枚以上なら枚数も）。 */
export function RowThumb({ text }: { text: string }): JSX.Element | null {
  const tokens = parsePhotoTokens(text);
  if (!tokens.length) return null;
  return (
    <span class="row-thumb-wrap">
      <img src={tokens[0]!.url} alt="" loading="lazy" />
      {tokens.length > 1 ? <span class="row-thumb-count">{tokens.length}</span> : null}
    </span>
  );
}
