import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { Kakera } from '../lib/kakera/types';
import { textForExcerpt } from '../lib/markdown';
import { dateOf, dayGroupHeading, timeOf } from './format';
import { RowThumb } from './RichText';
import { Editor } from './Editor';
import { KakeraEdit } from './KakeraEdit';

/**
 * かけら（トップ）。
 *  - 常に空のテキストエリアが一番上。保存すると下に積まれて欄が空に戻る（連投しやすく）
 *  - 下はまだかたちになっていないかけらだけの流れ。日ごとの小見出しで区切り、各行に時刻
 *  - 行をタップするとその場で開いて編集。他を開くと前は閉じる
 *  - ⚠️ トップは「常時即表示」。入力欄を先に描き、流れは遅れて出す
 */
export function WriteScreen({
  nagare,
  loaded,
  draftId,
  draftWrittenAt,
  draft,
  onDraftInput,
  onSave,
  onEdit,
  onDelete,
  onGoCompose,
}: {
  nagare: Kakera[];
  loaded: boolean;
  draftId: string;
  draftWrittenAt: string;
  draft: string;
  onDraftInput: (v: string) => void;
  onSave: () => Promise<void>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onGoCompose: () => void;
}): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function save(): Promise<void> {
    if (!draft.trim() || saving) return;
    setSaving(true);
    try {
      await onSave();
      // 保存したら入力欄にフォーカスを戻す（連投しやすさの要）
      taRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  let lastDay: string | null = null;

  return (
    <section>
      <div class="composer">
        <Editor
          value={draft}
          onInput={onDraftInput}
          kakeraId={draftId}
          writtenAt={draftWrittenAt}
          placeholder="いま、何が浮かびましたか"
          taRef={taRef}
          inlineAction={
            <button type="button" class="btn-primary" disabled={!draft.trim() || saving} onClick={save}>
              保存
            </button>
          }
        />
      </div>

      <div class="section-head">
        <h2>かけら</h2>
        <button type="button" class="link-btn" disabled={!nagare.length} onClick={onGoCompose}>
          かたちにする
          <span class="link-btn-count">{nagare.length}</span>
        </button>
      </div>

      {!loaded ? (
        <p class="empty-note">読み込んでいます</p>
      ) : !nagare.length ? (
        <p class="empty-note">かけらはまだありません</p>
      ) : (
        <ul class="frag-list">
          {nagare.map((k) => {
            const day = dateOf(k.written_at);
            const head = day !== lastDay ? day : null;
            lastDay = day;
            return (
              <>
                {head ? (
                  <li class="flow-day-head" key={'h' + head}>
                    {dayGroupHeading(head)}
                  </li>
                ) : null}
                <li class="frag" key={k.id}>
                  <div
                    class="frag-row"
                    onClick={() => setOpenId(openId === k.id ? null : k.id)}
                  >
                    <span class="frag-text">{textForExcerpt(k.body)}</span>
                    <RowThumb text={k.body} />
                    <span class="frag-time">{timeOf(k.written_at)}</span>
                  </div>
                  {openId === k.id ? (
                    <KakeraEdit
                      kakera={k}
                      onSave={async (body) => {
                        await onEdit(k.id, body);
                        setOpenId(null);
                      }}
                      onCancel={() => setOpenId(null)}
                      onDelete={async () => {
                        await onDelete(k.id);
                        setOpenId(null);
                      }}
                    />
                  ) : null}
                </li>
              </>
            );
          })}
        </ul>
      )}
    </section>
  );
}
