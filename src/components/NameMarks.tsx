import { Fragment } from 'preact';
import type { JSX } from 'preact';
import type { NameHit, NameToken } from '../lib/names/replace';
import { isSafeHref } from '../lib/markdown';

/**
 * 公開名変換の印つき本文。
 *
 * ⚠️ `dangerouslySetInnerHTML` は使わない。原本も、手で直した言葉も、利用者の入力なので
 * すべて Preact の要素とテキストノードで組む。
 * ⚠️ 変換ページではリンクを朱の下線で描かない（印と重なって見分けられないため）。
 *    リンクは普通の文字色＋淡い点線（.conv-link）だけ。押す必要もないので a 要素にしない。
 */

export type MarkStatus = 'dict' | 'edit' | 'reject';

export interface MarkRender {
  text: string;
  hits: NameHit[];
  /** その箇所に出る言葉 */
  word: (hit: NameHit) => string;
  status: (hit: NameHit) => MarkStatus;
  keyOf: (hit: NameHit) => string;
  /** 無ければ押せない印（試し書き） */
  onPress?: (hit: NameHit) => void;
}

function Mark({ r, hit }: { r: MarkRender; hit: NameHit }): JSX.Element {
  // 例外: 押せない・ごく薄い点線だけ（置き換わらなかったことが見える）
  if (hit.exception) return <span class="m-exc">{hit.source}</span>;
  const cls = `mk mk-${r.status(hit)}`;
  const press = r.onPress;
  if (!press) return <span class={cls + ' nopress'}>{r.word(hit)}</span>;
  return (
    <span
      class={cls}
      role="button"
      tabIndex={0}
      data-mark={r.keyOf(hit)}
      onClick={(e) => {
        e.stopPropagation();
        press(hit);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          press(hit);
        }
      }}
    >
      {r.word(hit)}
    </span>
  );
}

/** [start, end) の素の文字を、印を挟みながら描く。 */
export function renderSpan(r: MarkRender, start: number, end: number): JSX.Element[] {
  const out: JSX.Element[] = [];
  let cur = start;
  for (const h of r.hits) {
    if (h.pos < start || h.pos >= end) continue;
    if (h.pos > cur) out.push(<Fragment key={`t${cur}`}>{r.text.slice(cur, h.pos)}</Fragment>);
    out.push(<Mark key={`h${h.pos}`} r={r} hit={h} />);
    cur = h.pos + h.source.length;
  }
  if (cur < end) out.push(<Fragment key={`t${cur}`}>{r.text.slice(cur, end)}</Fragment>);
  return out;
}

/** 行内の切れ（text / url / link / 表示文字の中の画像）を描く。[a, b) の外の素の文字は落とす。 */
function renderInline(r: MarkRender, tokens: NameToken[], a: number, b: number): JSX.Element[] {
  const out: JSX.Element[] = [];
  for (const t of tokens) {
    const s = Math.max(t.start, a);
    const e = Math.min(t.end, b);
    if (e <= s) continue;
    const key = `${t.kind}${t.start}`;
    switch (t.kind) {
      case 'text':
        out.push(<Fragment key={key}>{renderSpan(r, s, e)}</Fragment>);
        break;
      case 'url':
        out.push(
          <span class="conv-link" key={key}>
            {r.text.slice(t.start, t.end)}
          </span>
        );
        break;
      case 'raw':
        out.push(<Fragment key={key}>{r.text.slice(t.start, t.end)}</Fragment>);
        break;
      case 'link':
        out.push(
          <Fragment key={key}>
            <span class="conv-link">{renderInline(r, t.label, t.start, t.end)}</span>
            {t.title ? <span class="conv-aside">（{renderSpan(r, t.title.start, t.title.end)}）</span> : null}
          </Fragment>
        );
        break;
      case 'image':
        // リンクの表示文字の中の画像。代替文字だけを小さく出す
        out.push(
          <span class="conv-aside" key={key}>
            ［画像{t.alt.length ? '　' : ''}
            {renderInline(r, t.alt, t.start, t.end)}］
          </span>
        );
        break;
    }
  }
  return out;
}

function isWs(c: string): boolean {
  return /\s/.test(c);
}

/**
 * 本文を段落と写真に分けて描く（RichText の見た目に寄せた、変換ページ専用の描き方）。
 * 写真の代替文字に当たり箇所があれば、写真の下に「代替文字」として出して押せるようにする
 * （公開 HTML の alt に出るので、見えないままにしない）。
 */
export function MarkedBody({
  r,
  tokens,
  imgClass,
}: {
  r: MarkRender;
  tokens: NameToken[];
  imgClass: string;
}): JSX.Element {
  const parts: JSX.Element[] = [];
  let para: NameToken[] = [];
  const text = r.text;

  const flush = (key: string): void => {
    if (!para.length) return;
    let a = para[0]!.start;
    let b = para[para.length - 1]!.end;
    while (a < b && isWs(text.charAt(a))) a++;
    while (b > a && isWs(text.charAt(b - 1))) b--;
    if (a < b) {
      parts.push(
        <p class="rich-text-block conv-text" key={key}>
          {renderInline(r, para, a, b)}
        </p>
      );
    }
    para = [];
  };

  tokens.forEach((t, i) => {
    if (t.kind !== 'image') {
      para.push(t);
      return;
    }
    flush(`p${i}`);
    const src = t.url.startsWith('/api/photo/') || isSafeHref(t.url) ? t.url : null;
    const altHasText = t.alt.some((x) => text.slice(x.start, x.end).trim().length > 0);
    parts.push(
      <Fragment key={`i${i}`}>
        {src ? (
          <div class={imgClass}>
            <img src={src} alt="" loading="lazy" />
          </div>
        ) : null}
        {altHasText || t.title ? (
          <p class="conv-alt">
            <span class="conv-alt-label">代替文字</span>
            {renderInline(r, t.alt, t.start, t.end)}
            {t.title ? <span class="conv-aside">（{renderSpan(r, t.title.start, t.title.end)}）</span> : null}
          </p>
        ) : null}
      </Fragment>
    );
  });
  flush('tail');
  return <>{parts}</>;
}
