import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Kakera } from '../lib/kakera/types';
import { Editor } from './Editor';

/**
 * かけらをその場で開いて直す（保存・取消・削除）。
 * 流れからも、かたちの読む画面からも使う——原本を直す場所が無いと、
 * 日記を組み直しても直せないため（設計 §8「かたちに入ったかけらを直す」）。
 */
export function KakeraEdit({
  kakera,
  onSave,
  onCancel,
  onDelete,
}: {
  kakera: Kakera;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}): JSX.Element {
  const [body, setBody] = useState(kakera.body);
  const [busy, setBusy] = useState(false);

  return (
    <div class="frag-edit">
      <Editor
        value={body}
        onInput={setBody}
        kakeraId={kakera.id}
        writtenAt={kakera.written_at}
        belowAction={
          <div class="frag-edit-actions">
            <button
              type="button"
              class="btn-primary"
              disabled={busy || !body.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await onSave(body.trim());
                } finally {
                  setBusy(false);
                }
              }}
            >
              保存
            </button>
            <button type="button" class="btn-ghost" disabled={busy} onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              class="btn-danger"
              disabled={busy}
              onClick={async () => {
                if (!confirm('このかけらを消します。取り消せません。よろしいですか？')) return;
                setBusy(true);
                try {
                  await onDelete();
                } finally {
                  setBusy(false);
                }
              }}
            >
              削除
            </button>
          </div>
        }
      />
    </div>
  );
}
