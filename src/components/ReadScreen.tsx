import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { KatachiDetail } from '../lib/kakera/types';
import { dateHeading, dateLiterary } from './format';
import { RichText } from './RichText';
import { KakeraEdit } from './KakeraEdit';

/**
 * かたちを読む。
 *  明朝の組版。⚠️ 時刻は出さない。かけらの間は手書き風の罫（CSS の ::after）。
 *  ⚠️ 公開済みの印は出さない（読む場所は読むことに徹する）。
 *
 * 原本を直す場所はここしかないので編集の導線は要る（設計 §8「かたちに入ったかけらを直す」。
 * ここは設計が正で、モックが不足）。ただし**既定は読むだけ**にして、
 * ナビ行の「直す」で編集モードに入ったときだけ、かけらごとの操作を出す。
 * 導線を出しっぱなしにすると明朝で組んだ意味が無くなるため。
 */
export function ReadScreen({
  detail,
  onBack,
  onGoAssemble,
  onEdit,
  onDelete,
  onDetach,
  onDissolve,
}: {
  detail: KatachiDetail;
  onBack: () => void;
  onGoAssemble: () => void;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDetach: (id: string) => Promise<void>;
  onDissolve: () => Promise<void>;
}): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const { katachi, kakera, nikki } = detail;

  return (
    <section>
      <div class="back-row">
        <button type="button" class="back-btn" onClick={onBack}>
          ‹ 一覧へ戻る
        </button>
        <button
          type="button"
          class={'mode-btn' + (editing ? ' on' : '')}
          onClick={() => {
            setOpenId(null);
            setEditing(!editing);
          }}
        >
          {editing ? '読む' : '直す'}
        </button>
      </div>

      {katachi.title ? (
        <>
          <p class="read-date-small">{dateHeading(katachi.date)}</p>
          <p class="page-date">{katachi.title}</p>
        </>
      ) : (
        <p class="page-date">{dateLiterary(katachi.date)}</p>
      )}

      <div>
        {kakera.map((k) => (
          <div class="read-frag" key={k.id}>
            {editing && openId === k.id ? (
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
            ) : (
              <>
                <RichText text={k.body} imgClass="read-photo" />
                {editing ? (
                <div class="read-frag-tools">
                  <button type="button" class="btn-ghost" onClick={() => setOpenId(k.id)}>
                    直す
                  </button>
                  <button
                    type="button"
                    class="btn-ghost"
                    onClick={async () => {
                      if (!confirm('このかけらをかたちから外して、流れへ戻します。よろしいですか？')) return;
                      await onDetach(k.id);
                    }}
                  >
                    流れへ戻す
                  </button>
                </div>
                ) : null}
              </>
            )}
          </div>
        ))}
      </div>

      <div style="margin-top:26px;">
        <button type="button" class="btn-cta" style="width:100%;" onClick={onGoAssemble}>
          {nikki ? '日記に書き足す' : '日記にする'}
        </button>
      </div>

      {/* 日記になったかたちは解けない（astro-blog に記事だけ残るため・設計 §3） */}
      {editing && !nikki ? (
        <div style="margin-top:14px;">
          <button
            type="button"
            class="btn-ghost"
            style="width:100%;"
            onClick={async () => {
              if (!confirm('このかたちを解きます。中のかけらは流れへ戻ります。よろしいですか？')) return;
              await onDissolve();
            }}
          >
            かたちを解く
          </button>
        </div>
      ) : null}
    </section>
  );
}
