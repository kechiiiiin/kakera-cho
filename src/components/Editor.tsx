import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TextEdit } from '../lib/markdown';
import {
  buildPhotoInsertion,
  insertLink,
  parsePhotoTokens,
  removePhotoTokenAt,
  toggleBold,
} from '../lib/markdown';
import { autoGrow } from './format';
import { pickPhotos, uploadPhotos } from './photo';

/**
 * かけらの本文を書くところ。composer（新規）と、流れ／かたちのその場編集で共用する。
 *
 *  - 「写真」ボタンはカーソル位置に画像記法を挿入する（本文の途中なら前後に改行を足して独立した行に）
 *  - 「太字」「リンク」は Markdown の記法を差し込むだけ（リッチエディタにはしない。素の textarea のまま）。
 *    ⚠️ リンクの URL は prompt() で尋ねない（iOS で辛い）。記法を入れてカーソルを置くだけ
 *  - Cmd/Ctrl+B で太字をトグルできる（増やすのはこれ一つだけ）
 *  - 本文へ画像ファイルを**ドラッグ＆ドロップ**しても同じ経路で貼れる（ボタンと処理を共有する）
 *  - **クリップボードから貼り付け**（スクリーンショットのコピー等）ても同じ経路で貼れる。
 *    ⚠️ 文字も一緒に入っているとき（ウェブページや文書からのコピー）は、写真にせず文字として貼る
 *  - テキストエリアの下に貼った写真のサムネを並べ、× でその1枚だけ本文から外す
 *  - 失敗は alert ではなくその場のテキストで知らせる（iOS の alert はスクロール位置が飛ぶ）
 *
 * 並びは 本文 → サムネ → 知らせ → 「写真」と inlineAction の行 → belowAction。
 */
export function Editor({
  value,
  onInput,
  kakeraId,
  writtenAt,
  placeholder,
  taRef,
  inlineAction,
  belowAction,
}: {
  value: string;
  onInput: (v: string) => void;
  kakeraId: string;
  writtenAt: string;
  placeholder?: string;
  taRef?: RefObject<HTMLTextAreaElement>;
  /** 「写真」と同じ行の右に置くもの（composer の「保存」） */
  inlineAction?: JSX.Element;
  /** その下に置くもの（その場編集の 保存／取消／削除） */
  belowAction?: JSX.Element;
}): JSX.Element {
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const ref = taRef ?? fallbackRef;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const tokens = parsePhotoTokens(value);

  // 開いた瞬間と、写真の差し込みなど外から本文が変わったときも、本文の高さまで伸ばす。
  // ⚠️ 入力のときだけ伸ばしていたので、長いかけらを開くと狭い箱の中でスクロールしていた（2026-09-13）。
  useEffect(() => {
    autoGrow(ref.current);
  }, [value]);

  /** 選ばれた／落とされた写真を上げて、カーソル位置に画像記法を差し込む。 */
  async function insertFiles(files: File[]): Promise<void> {
    if (!files.length || busy) return;
    setError(null);
    setBusy(`0 / ${files.length}`);
    const { urls, error: err } = await uploadPhotos(
      files,
      { kakeraId, writtenAt, startIndex: tokens.length },
      (done, total) => setBusy(`${done} / ${total}`)
    );
    setBusy(null);
    if (err) setError(err);
    if (!urls.length) return;

    const ta = ref.current;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    let inserted = '';
    for (const url of urls) inserted += buildPhotoInsertion(before + inserted, after, url);
    onInput(before + inserted + after);

    // 差し込んだ直後の位置にカーソルを戻す
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const caret = before.length + inserted.length;
      el.focus();
      el.setSelectionRange(caret, caret);
      autoGrow(el);
    });
  }

  async function onPickPhotos(): Promise<void> {
    setError(null);
    await insertFiles(await pickPhotos());
  }

  /**
   * ドロップされたものから画像だけを拾う。
   * 画像以外（テキスト・リンク・PDF）は素通しして、ブラウザの既定の挙動に任せる。
   */
  function imagesFrom(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    return Array.from(dt.files).filter((f) => f.type.startsWith('image/'));
  }

  function onDragOver(e: DragEvent): void {
    if (!imagesFrom(e.dataTransfer).length) return;
    e.preventDefault(); // これを止めないと drop が発火しない
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  }

  function onDrop(e: DragEvent): void {
    const files = imagesFrom(e.dataTransfer);
    setDropping(false);
    if (!files.length) return; // 画像でなければブラウザに任せる
    e.preventDefault();
    void insertFiles(files);
  }

  /**
   * クリップボードから貼り付けた画像を拾う。
   * スクリーンショットは dt.files に無く dt.items だけに入るブラウザがあるので、items からも拾う。
   */
  function pastedImages(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    const fromFiles = imagesFrom(dt);
    if (fromFiles.length) return fromFiles;
    return Array.from(dt.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
  }

  function onPaste(e: ClipboardEvent): void {
    const dt = e.clipboardData;
    const files = pastedImages(dt);
    if (!files.length) return; // 画像が無ければブラウザに任せる（ふつうの文字の貼り付け）
    // 文字も一緒に入っているコピーは、文字として貼る（写真だけ差し込むと文章が消える）
    if (dt && dt.getData('text/plain').trim()) return;
    e.preventDefault();
    void insertFiles(files);
  }

  /**
   * 書式ボタンの共通処理。
   * 本文を差し替えたあと、必ず textarea にフォーカスを戻して選択範囲を置き直す
   * （insertFiles と同じく requestAnimationFrame で、Preact が値を描き直した後に当てる）。
   */
  function applyEdit(make: (text: string, start: number, end: number) => TextEdit): void {
    const ta = ref.current;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    const next = make(value, start, end);
    onInput(next.text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.selectionStart, next.selectionEnd);
      autoGrow(el);
    });
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key !== 'b' && e.key !== 'B') return;
    e.preventDefault();
    applyEdit(toggleBold);
  }

  function removePhoto(i: number): void {
    const fresh = parsePhotoTokens(value);
    const target = fresh[i];
    if (!target) return;
    onInput(removePhotoTokenAt(value, target.start, target.end));
  }

  return (
    <>
      <textarea
        ref={ref}
        class={dropping ? 'dropping' : undefined}
        value={value}
        placeholder={placeholder}
        rows={3}
        onDragOver={onDragOver}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        onInput={(e) => {
          const el = e.currentTarget;
          autoGrow(el);
          onInput(el.value);
        }}
      />
      {tokens.length ? (
        <div class="photo-strip">
          {tokens.map((t, i) => (
            <div class="photo-thumb" key={t.url + i}>
              <img src={t.url} alt="" />
              <button type="button" class="photo-thumb-x" aria-label="この写真を外す" onClick={() => removePhoto(i)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <p class="warn-note">{error}</p> : null}
      <div class="composer-actions">
        <div class="composer-tools">
          <button type="button" class="icon-btn" disabled={!!busy} onClick={onPickPhotos}>
            {busy ? `送っています ${busy}` : '写真'}
          </button>
          <button type="button" class="icon-btn" onClick={() => applyEdit(toggleBold)}>
            太字
          </button>
          <button type="button" class="icon-btn" onClick={() => applyEdit(insertLink)}>
            リンク
          </button>
        </div>
        {inlineAction ?? <span />}
      </div>
      {belowAction}
    </>
  );
}
