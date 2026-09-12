import type { JSX } from 'preact';
import { parsePhotoTokens } from '../lib/markdown';

/**
 * かけらの本文を読めるように描く。
 * 本文中の画像記法を実際の写真に開き、それ以外は改行をそのまま見せる（white-space: pre-wrap）。
 */
export function RichText({ text, imgClass }: { text: string; imgClass: string }): JSX.Element | null {
  const tokens = parsePhotoTokens(text);
  if (!tokens.length) {
    const t = text.trim();
    return t ? <p class="rich-text-block">{t}</p> : null;
  }

  const parts: JSX.Element[] = [];
  let pos = 0;
  tokens.forEach((tok, i) => {
    const chunk = text.slice(pos, tok.start).trim();
    if (chunk) parts.push(<p class="rich-text-block" key={`t${i}`}>{chunk}</p>);
    parts.push(
      <div class={imgClass} key={`p${i}`}>
        <img src={tok.url} alt="" loading="lazy" />
      </div>
    );
    pos = tok.end;
  });
  const rest = text.slice(pos).trim();
  if (rest) parts.push(<p class="rich-text-block" key="tail">{rest}</p>);
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
