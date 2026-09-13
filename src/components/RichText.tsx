import { Fragment } from 'preact';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { Embed, InlineNode } from '../lib/markdown';
import { YOUTUBE_ID_RE, parseEmbedTokens, parseInline, parsePhotoTokens } from '../lib/markdown';

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

/** 本文を割る位置（写真・埋め込み）。本文に書いてある順にそのまま並べる。 */
type Slot =
  | { start: number; end: number; kind: 'photo'; url: string }
  | { start: number; end: number; kind: 'embed'; embed: Embed };

function slotsOf(text: string): Slot[] {
  const slots: Slot[] = [
    ...parsePhotoTokens(text).map((t): Slot => ({ start: t.start, end: t.end, kind: 'photo', url: t.url })),
    ...parseEmbedTokens(text).map((t): Slot => ({ start: t.start, end: t.end, kind: 'embed', embed: t.embed })),
  ];
  return slots.sort((a, b) => a.start - b.start);
}

/**
 * かけらの本文を読めるように描く。
 * 画像記法を実際の写真に開き、**行として独立した X / YouTube の URL**を埋め込みに開き、
 * **行内書式**（太字・斜体・リンク・コード・打ち消し）も開く。
 * 見出し・区切り線・引用・リスト・表は開かない（改行はそのまま見せる: white-space: pre-wrap）。
 */
export function RichText({ text, imgClass }: { text: string; imgClass: string }): JSX.Element | null {
  const slots = slotsOf(text);
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
    } else {
      parts.push(<EmbedBlock embed={slot.embed} key={`e${i}`} />);
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
