import { Fragment } from 'preact';
import type { JSX } from 'preact';
import type { InlineNode } from '../lib/markdown';
import { parseInline, parsePhotoTokens } from '../lib/markdown';

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

/**
 * かけらの本文を読めるように描く。
 * 画像記法を実際の写真に開き、**行内書式**（太字・斜体・リンク・コード・打ち消し）も開く。
 * 見出し・区切り線・引用・リスト・表は開かない（改行はそのまま見せる: white-space: pre-wrap）。
 */
export function RichText({ text, imgClass }: { text: string; imgClass: string }): JSX.Element | null {
  const tokens = parsePhotoTokens(text);
  if (!tokens.length) {
    const t = text.trim();
    return t ? <Block text={t} keyPrefix="b" /> : null;
  }

  const parts: JSX.Element[] = [];
  let pos = 0;
  tokens.forEach((tok, i) => {
    const chunk = text.slice(pos, tok.start).trim();
    if (chunk) parts.push(<Block text={chunk} keyPrefix={`t${i}-`} key={`t${i}`} />);
    parts.push(
      <div class={imgClass} key={`p${i}`}>
        <img src={tok.url} alt="" loading="lazy" />
      </div>
    );
    pos = tok.end;
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
