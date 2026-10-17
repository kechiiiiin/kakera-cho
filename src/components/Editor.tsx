import { h, render } from 'preact';
import type { JSX, RefObject } from 'preact';
import { useRef } from 'preact/hooks';
import { KEditor, type KEditorInstance } from 'k-editor/preact';
import type { LinkCardData } from 'k-editor';
import 'k-editor/style.css';
import { isSafeHref, matchBareUrl, matchEmbed, parsePhotoTokens } from '../lib/markdown';
import { isCardCandidate, normalizeUrl } from '../lib/card/url';
import type { LinkCards } from '../lib/card/types';
import { pickPhotos, uploadOnePhoto } from './photo';
import { CARD_IMAGE_SRC, EmbedBlock } from './RichText';

/**
 * かけらの本文を書くところ。composer（新規）と、流れ／かたちのその場編集で共用する。
 *
 * 中身は k-editor（github.com/kechiiiiin/k-editor・Tiptap の上の WYSIWYG）。保存の形は今までどおり Markdown:
 *  - 単独の改行・空行の数・写真の行・行として独立した URL・`---` は、読み込んで何も触らなければ 1 文字も変わらない
 *  - ツールバー: 写真／埋め込み／見出し／太字／取り消し線／リンク／箇条書き／番号付き／引用／区切り線／戻す・やり直す
 *    画面の下端に固定（キーボードが開いていればその直上）。長く書いても写真をすぐ上げられるように（2026-10-17 啓輔さん）。
 *    k-editor v0.3.0 の toolbarPosition: 'bottom'。v0.2.1 では無視され、従来どおり上に貼り付く
 *    ⚠️ 斜体は入れない（2026-10-03）。⚠️ リンクの URL は prompt() で尋ねない（小さな欄で）
 *  - 写真はボタン・ドラッグ＆ドロップ・貼り付け（画像だけのとき）の3経路。写真は本文の中に見え、× で外せる
 *  - 他所からの貼り付けは文字だけ（書式は持ち込まない）。文字入りのコピーは文字として
 *  - 失敗は alert ではなくその場の文字で（iOS の alert はスクロール位置が飛ぶ）
 *
 * ⚠️ 埋め込みの判別（matchEmbed）とカードの判別はかけら帳の側にあり、k-editor へは関数で渡す
 *    （判別の写しを三か所目に増やさない。astro-blog との二か所の約束はそのまま）。
 * ⚠️ エディタの中では Spotify を置き方に関係なく埋め込みで見せる（行の前後の空行は見ない）。
 *    公開される姿は読む画面（RichText）が正。
 *
 * 並びは 本文 → 知らせ → inlineAction の行 → belowAction（ツールバーは画面の下端）。
 */
export function Editor({
  value,
  onInput,
  kakeraId,
  writtenAt,
  placeholder,
  editorRef,
  cards,
  inlineAction,
  inlineLeft,
  belowAction,
}: {
  value: string;
  onInput: (v: string) => void;
  kakeraId: string;
  /** 写真の R2 キーに使う日時。★書き始めた時刻（直す前の written_at）のまま。日時を直してもキーは変えない */
  writtenAt: string;
  placeholder?: string;
  /** フォーカスを戻す等のための操作口 */
  editorRef?: RefObject<KEditorInstance | null>;
  /** 既に取ってあるリンクカード（正規化 URL → カード）。無い URL は URL のまま見せる */
  cards?: LinkCards;
  /** 本文の下の行の右に置くもの（「保存」） */
  inlineAction?: JSX.Element;
  /** その行の左に置くもの（書いた日時・WhenPicker） */
  inlineLeft?: JSX.Element;
  /** その下に置くもの（その場編集の 取消／削除） */
  belowAction?: JSX.Element;
}): JSX.Element {
  // 写真の連番（n）を数えるための、いちばん新しい本文（再描画を待たずに読む）
  const latest = useRef(value);
  latest.current = value;

  async function uploadImage(file: File): Promise<string> {
    const n = parsePhotoTokens(latest.current).length + 1;
    return await uploadOnePhoto(file, { kakeraId, writtenAt, n });
  }

  function renderEmbed(url: string): { dom: HTMLElement; destroy: () => void } | null {
    const embed = matchEmbed(url);
    if (!embed) return null;
    const dom = document.createElement('div');
    dom.className = 'editor-embed';
    render(h(EmbedBlock, { embed }), dom);
    return { dom, destroy: () => render(null, dom) };
  }

  function fetchCard(url: string): LinkCardData | null {
    if (!cards || !isCardCandidate(url)) return null;
    const key = normalizeUrl(url);
    const card = key ? cards[key] : undefined;
    if (!card) return null;
    return {
      title: card.title,
      description: card.description,
      domain: card.domain,
      // 画像は自分の /api/photo/kakera/cards/* だけ（相手の URL を src に入れない）
      image: card.image && CARD_IMAGE_SRC.test(card.image) ? card.image : null,
    };
  }

  return (
    <>
      <KEditor
        class="editor"
        value={value}
        onChange={(md) => {
          latest.current = md;
          onInput(md);
        }}
        placeholder={placeholder}
        editorRef={editorRef}
        toolbarPosition="bottom"
        uploadImage={uploadImage}
        pickImages={pickPhotos}
        renderEmbed={renderEmbed}
        fetchCard={fetchCard}
        // 行まるごとが URL の行（parseStandaloneUrls と同じ条件）を埋め込み・カードの枠にする
        isBlockUrl={(line) => isSafeHref(line) && matchBareUrl(line, 0)?.url === line}
      />
      {inlineAction ? (
        <div class="composer-actions">
          {inlineLeft ?? <span />}
          {inlineAction}
        </div>
      ) : null}
      {belowAction}
    </>
  );
}
