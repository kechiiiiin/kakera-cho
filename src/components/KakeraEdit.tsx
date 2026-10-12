import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Kakera } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import { Editor } from './Editor';
import { WhenPicker, sameMinute } from './WhenPicker';

/**
 * かけらをその場で開いて直す（保存・取消・削除）。
 * かけらたち（トップ）からも、かたちの読む画面からも使う——原本を直す場所が無いと、
 * 日記を組み直しても直せないため（設計 §8「かたちに入ったかけらを直す」）。
 * 書いた日時も保存ボタンの左で直せる（案A・かけら時刻の指定と修正設計 2026-10-12）。本文と一緒に保存する。
 */
export function KakeraEdit({
  kakera,
  onSave,
  onCancel,
  onDelete,
  onPutIntoKatachi,
  cards,
}: {
  kakera: Kakera;
  /** 既に取ってあるリンクカード（エディタの中の URL をカードで見せる） */
  cards?: LinkCards;
  /** writtenAt は日時を変えたときだけ渡る（+09:00・秒 00） */
  onSave: (body: string, writtenAt?: string) => Promise<void>;
  onCancel: () => void;
  onDelete: () => Promise<void>;
  /** かけらたちから開いたときだけ渡す（行き先のかたちを選ぶ一覧を出す） */
  onPutIntoKatachi?: () => void;
}): JSX.Element {
  const [body, setBody] = useState(kakera.body);
  const [writtenAt, setWrittenAt] = useState(kakera.written_at);
  const [busy, setBusy] = useState(false);
  const timeChanged = !sameMinute(writtenAt, kakera.written_at);

  return (
    <div class="frag-edit">
      <Editor
        value={body}
        onInput={setBody}
        kakeraId={kakera.id}
        // 写真の R2 キーは直す前の日時のまま（日時を直してもキーは変えない）
        writtenAt={kakera.written_at}
        cards={cards}
        inlineLeft={
          <WhenPicker
            value={writtenAt}
            changed={timeChanged}
            resetLabel="元に戻す"
            disabled={busy}
            onChange={setWrittenAt}
            onReset={() => setWrittenAt(kakera.written_at)}
          />
        }
        // 「保存」は書く欄（WriteScreen）と同じく道具の並びの右端に置く。場所を揃えて迷わせない（2026-09-14）
        inlineAction={
          <button
            type="button"
            class="btn-primary"
            disabled={busy || !body.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(body.trim(), timeChanged ? writtenAt : undefined);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </button>
        }
        belowAction={
          <div class="frag-edit-actions">
            <button type="button" class="btn-ghost" disabled={busy} onClick={onCancel}>
              取消
            </button>
            {onPutIntoKatachi ? (
              <button
                type="button"
                class="btn-ghost"
                disabled={busy}
                onClick={() => {
                  // 行き先を選んで入れると、この編集欄は閉じる。直した本文・日時が捨てられることを先に断る
                  if ((body.trim() !== kakera.body || timeChanged) && !confirm('直した本文・日時はまだ保存していません。保存せずに進みますか？')) return;
                  onPutIntoKatachi();
                }}
              >
                かたちに入れる
              </button>
            ) : null}
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
