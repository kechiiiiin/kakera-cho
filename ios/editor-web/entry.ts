// iOS アプリの書く欄（WKWebView の中）で k-editor を動かす入口。
// Web 版の src/components/Editor.tsx と**同じ設定**（道具の並び・下置き・言葉のリンク・isBlockUrl・カードの出し方）にする。
// ⚠️ Editor.tsx の設定を変えたら、ここも同じように変えること。
//
// 束ね方: `npm run build:ios-editor`（esbuild で ios/App/EditorWeb/kedit.js・kedit.css に1本ずつ）。アプリに同梱し、ネットから読まない。
//
// 橋渡し（window.webkit.messageHandlers.kakera・返事つき）:
//   JS → Swift  {type:'ready'}                 読み込みが済んだ。Swift は window.kakeraInit(init) を呼ぶ
//               {type:'change', markdown}      本文が変わるたび（serialize した Markdown）
//               {type:'pick'}                  写真を選ばせる → 返事は選んだ写真の札（文字列）の並び
//               {type:'upload', token, n}      札の写真を上げる → 返事は本文に入れる写真の URL
//               {type:'roundtrip', same, ...}  （検査）読み込んだまま書き戻して元と同じか
//   ⚠️ サービストークンなどの秘密は WebView に渡さない。写真を上げるのも、写真・カードの画像を取るのも Swift 側
//      （画像は kakera-editor://app/api/photo/... を Swift の WKURLSchemeHandler が認証つきで中継する）

import { createEditor, type KEditor, type LinkCardData, type ToolbarItem } from 'k-editor';
import 'k-editor/style.css';
import './editor.css';
import { isSafeHref, matchBareUrl, parsePhotoTokens } from '../../src/lib/markdown';
import { isCardCandidate, normalizeUrl } from '../../src/lib/card/url';
import type { LinkCards } from '../../src/lib/card/types';

/** Editor.tsx の TOOLBAR と同じ並び */
const TOOLBAR: ToolbarItem[] = [
  'photo',
  'embed',
  '|',
  'wikilink',
  'h2',
  'h3',
  'bold',
  'strike',
  'link',
  '|',
  'bulletList',
  'orderedList',
  'blockquote',
  'hr',
  '|',
  'undo',
  'redo',
];

/** RichText.tsx の CARD_IMAGE_SRC と同じ（画像は自分の /api/photo/kakera/cards/* だけ） */
const CARD_IMAGE_SRC = /^\/api\/photo\/kakera\/cards\/[A-Za-z0-9_.-]+$/;

interface InitOptions {
  markdown: string;
  cards: LinkCards;
  placeholder?: string;
  focus?: boolean;
  /** 検査: 読み込んだまま書き戻して元と比べ、結果を Swift に知らせる */
  checkRoundTrip?: boolean;
}

interface Bridge {
  postMessage(message: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { kakera?: Bridge } };
    kakeraInit?: (init: InitOptions) => void;
    kakeraGetMarkdown?: () => string;
    kakeraFocus?: () => void;
  }
}

function bridge(): Bridge | null {
  return window.webkit?.messageHandlers?.kakera ?? null;
}

function send(message: Record<string, unknown>): Promise<unknown> {
  const b = bridge();
  return b ? b.postMessage(message) : Promise.resolve(null);
}

let editor: KEditor | null = null;
let latest = '';

window.kakeraInit = (init: InitOptions) => {
  if (editor) editor.destroy();
  const root = document.getElementById('editor')!;
  latest = init.markdown;
  const cards = init.cards ?? {};

  function fetchCard(url: string): LinkCardData | null {
    if (!isCardCandidate(url)) return null;
    const key = normalizeUrl(url);
    const card = key ? cards[key] : undefined;
    if (!card) return null;
    return {
      title: card.title,
      description: card.description,
      domain: card.domain,
      image: card.image && CARD_IMAGE_SRC.test(card.image) ? card.image : null,
    };
  }

  // 写真: 選ぶのも上げるのも Swift。選んだ写真は「札」だけを File の名前に入れて k-editor に渡し、
  // k-editor が1枚ずつ uploadImage を呼ぶ（進み具合の表示は k-editor のまま）
  async function pickImages(): Promise<File[]> {
    const tokens = (await send({ type: 'pick' })) as string[] | null;
    return (tokens ?? []).map((t) => new File([], t, { type: 'image/jpeg' }));
  }

  async function uploadImage(file: File): Promise<string> {
    const n = parsePhotoTokens(latest).length + 1;
    const url = (await send({ type: 'upload', token: file.name, n })) as string | null;
    if (!url) throw new Error('写真を上げられませんでした');
    return url;
  }

  editor = createEditor(root, {
    markdown: init.markdown,
    placeholder: init.placeholder,
    onChange: (md) => {
      latest = md;
      void send({ type: 'change', markdown: md });
    },
    toolbar: TOOLBAR,
    toolbarPosition: 'bottom',
    uploadImage,
    pickImages,
    // 埋め込み（X / YouTube / Spotify）は iOS では開かない。URL の枠のまま見せる
    renderEmbed: () => null,
    fetchCard,
    // 行まるごとが URL の行（parseStandaloneUrls と同じ条件）を埋め込み・カードの枠にする
    isBlockUrl: (line) => isSafeHref(line) && matchBareUrl(line, 0)?.url === line,
  });

  if (init.checkRoundTrip) {
    const out = editor.getMarkdown();
    void send({ type: 'roundtrip', same: out === init.markdown, inLength: init.markdown.length, outLength: out.length });
  }
  if (init.focus) editor.focus();
};

window.kakeraGetMarkdown = () => (editor ? editor.getMarkdown() : latest);
window.kakeraFocus = () => editor?.focus();

void send({ type: 'ready' });
