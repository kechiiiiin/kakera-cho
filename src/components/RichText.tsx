import { Fragment } from 'preact';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Embed, InlineNode } from '../lib/markdown';
import {
  FENCE_LINE,
  HR_LINE,
  SPOTIFY_ID_RE,
  SPOTIFY_TYPE_RE,
  YOUTUBE_ID_RE,
  isSafeHref,
  parseEmbedTokens,
  parseInline,
  parsePhotoTokens,
} from '../lib/markdown';
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

/** 本文のひとかたまり（写真・埋め込み・カードの間の文字）を描く。 */
function Block({ text, keyPrefix }: { text: string; keyPrefix: string }): JSX.Element {
  const segs = splitBlocks(text);
  // 見出し・リスト等が無ければ今までどおり段落ひとつ（改行は pre-wrap で見せる）
  if (segs.length === 1 && segs[0]!.kind === 'text') {
    return <p class="rich-text-block">{renderInline(parseInline(text), keyPrefix)}</p>;
  }
  return <>{segs.map((seg, i) => renderSeg(seg, `${keyPrefix}${i}-`))}</>;
}

// ───────────────────────────────────────────────────────────────
// 行のまとまり（k-editor で書ける 見出し・箇条書き・番号付き・引用・区切り線）
//
// ⚠️ ここも**データを組むだけ**で HTML 文字列は作らない。
// 段落の中の改行・空行は今までどおり pre-wrap の段落の中で見せる。見出し等に接する空行だけは
// 段落の外の「空き」（rich-text-blank）にする（段落の端の改行は pre-wrap でも高さにならないため）。
// コードフェンスの中は割らない（今までどおり文字のまま）。
// ───────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6}) (.*)$/;
const BULLET_RE = /^([-*+]) (.*)$/;
const ORDERED_RE = /^(\d{1,9})([.)]) (.*)$/;
const QUOTE_RE = /^> ?(.*)$/;
/** リストの続きの行（字下げ） */
const CONT_RE = /^ {2,}(\S.*)$/;

type Seg =
  | { kind: 'text'; text: string }
  | { kind: 'blank'; count: number }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; start: number; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' };

function splitBlocks(text: string): Seg[] {
  const lines = text.split('\n');
  const segs: Seg[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (!buf.length) return;
    // 端の空行は段落の外の空きにする
    let a = 0;
    let b = buf.length;
    while (a < b && buf[a] === '') a++;
    while (b > a && buf[b - 1] === '') b--;
    if (a > 0) segs.push({ kind: 'blank', count: a });
    if (b > a) segs.push({ kind: 'text', text: buf.slice(a, b).join('\n') });
    if (buf.length - b > 0 && b > a) segs.push({ kind: 'blank', count: buf.length - b });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      buf.push(line);
      const f = line.match(FENCE_LINE);
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    const f = line.match(FENCE_LINE);
    if (f) {
      fence = f[1]!;
      buf.push(line);
      continue;
    }
    if (HR_LINE.test(line)) {
      flush();
      segs.push({ kind: 'hr' });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h && h[2]!.trim()) {
      flush();
      segs.push({ kind: 'heading', level: h[1]!.length, text: h[2]! });
      continue;
    }
    const bm = BULLET_RE.exec(line);
    const om = bm ? null : ORDERED_RE.exec(line);
    if (bm || om) {
      flush();
      const items: string[] = [];
      const re = bm ? BULLET_RE : ORDERED_RE;
      while (i < lines.length) {
        const l = lines[i]!;
        const m = HR_LINE.test(l) ? null : re.exec(l);
        if (m && (bm ? m[1] === bm[1] : m[2] === om![2])) {
          items.push(bm ? m[2]! : m[3]!);
          i++;
          continue;
        }
        const c = CONT_RE.exec(l);
        if (c && items.length) {
          items[items.length - 1] += '\n' + c[1]!;
          i++;
          continue;
        }
        break;
      }
      i--;
      segs.push(bm ? { kind: 'ul', items } : { kind: 'ol', start: parseInt(om![1]!, 10), items });
      continue;
    }
    if (line.startsWith('>')) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        inner.push(QUOTE_RE.exec(lines[i]!)![1]!);
        i++;
      }
      i--;
      segs.push({ kind: 'quote', text: inner.join('\n') });
      continue;
    }
    buf.push(line);
  }
  flush();
  // 空きの数を、見出し等の間の空行の数にそろえる（連続する blank はまとめる）
  return segs;
}

function renderSeg(seg: Seg, key: string): JSX.Element {
  switch (seg.kind) {
    case 'text':
      return (
        <p class="rich-text-block" key={key}>
          {renderInline(parseInline(seg.text), key)}
        </p>
      );
    case 'blank':
      return <div class="rich-text-blank" key={key} style={{ height: `${seg.count * 1.6}em` }} aria-hidden="true" />;
    case 'heading': {
      const Tag = (`h${Math.min(6, seg.level + 1)}` as unknown) as 'h3';
      return (
        <Tag class={`rich-text-heading rich-text-h${seg.level}`} key={key}>
          {renderInline(parseInline(seg.text), key)}
        </Tag>
      );
    }
    case 'ul':
      return (
        <ul class="rich-text-list" key={key}>
          {seg.items.map((it, i) => (
            <li key={`${key}${i}`}>{renderInline(parseInline(it), `${key}${i}-`)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol class="rich-text-list" start={seg.start} key={key}>
          {seg.items.map((it, i) => (
            <li key={`${key}${i}`}>{renderInline(parseInline(it), `${key}${i}-`)}</li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote class="rich-text-quote" key={key}>
          <Block text={seg.text} keyPrefix={key} />
        </blockquote>
      );
    case 'hr':
      return <hr class="rich-text-hr" key={key} />;
  }
}

// ───────────────────────────────────────────────────────────────
// 埋め込み（X / YouTube / Spotify）
//
// ⚠️ ここも**要素を組むだけ**で HTML 文字列は作らない（`dangerouslySetInnerHTML` は使わない）。
// iframe の src は、パーサ側で検証済みの**動画 ID・種別と ID だけ**から組み立てる。
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

/**
 * Spotify。高さ 152px・幅いっぱい・角丸 12px・遅延読み込みは astro-blog（remark-spotify-embed.ts）と同じ。
 * ⚠️ src は検証済みの種別と ID だけから組む（書かれた URL のクエリ等は入れない）。
 */
function Spotify({ type, id }: { type: string; id: string }): JSX.Element | null {
  if (!SPOTIFY_TYPE_RE.test(type) || !SPOTIFY_ID_RE.test(id)) return null;
  return (
    <div class="embed-spotify">
      <iframe
        src={`https://open.spotify.com/embed/${type}/${id}`}
        title="Spotify"
        width="100%"
        height="152"
        loading="lazy"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      />
    </div>
  );
}

export function EmbedBlock({ embed }: { embed: Embed }): JSX.Element | null {
  switch (embed.kind) {
    case 'youtube':
      return <YouTube id={embed.id} />;
    case 'spotify':
      return <Spotify type={embed.type} id={embed.id} />;
    default:
      return <Tweet url={embed.url} />;
  }
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

export const CARD_IMAGE_SRC = /^\/api\/photo\/kakera\/cards\/[A-Za-z0-9_.-]+$/;

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
 *   X / YouTube / Spotify → 埋め込み ／ キャッシュにカードがある → カード ／ それ以外 → 素のリンク（Block の中で開く）
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
 * 画像記法を実際の写真に開き、**行として独立した X / YouTube の URL**と**段落がそれだけの Spotify の URL**を埋め込みに、
 * **キャッシュのある行として独立した URL**をリンクカードに開き、
 * **行内書式**（太字・斜体・リンク・コード・打ち消し）も開く。
 * k-editor で書ける**見出し・箇条書き・番号付き・引用・区切り線**も開く（2026-10-03）。表は開かない。
 * 段落の中の改行・空行はそのまま見せる（white-space: pre-wrap）。
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
