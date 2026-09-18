import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Kakera, KatachiDetail } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import { KakeraPickSheet } from './PickSheets';
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
  onChangeDate,
  nagare,
  nagareCards,
  nagareLoaded,
  onOpenPicker,
  onAdd,
}: {
  detail: KatachiDetail;
  onBack: () => void;
  onGoAssemble: () => void;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDetach: (id: string) => Promise<void>;
  onDissolve: () => Promise<void>;
  /** かたちの日付を変える。失敗（1日にひとつ・日記済み）は呼び手が知らせる */
  onChangeDate: (date: string) => Promise<void>;
  /** 「かけらを足す」で選ぶ、まだかたちになっていないかけら */
  nagare: Kakera[];
  nagareCards: LinkCards;
  nagareLoaded: boolean;
  /** 選ぶ一覧を開いたとき（かけらたちを取り直す） */
  onOpenPicker: () => void;
  /** 失敗したら投げる（一覧は開いたまま） */
  onAdd: (ids: string[]) => Promise<void>;
}): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [dateDraft, setDateDraft] = useState(detail.katachi.date);
  const [dateBusy, setDateBusy] = useState(false);
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
            setDateDraft(katachi.date);
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

      {/* 日付を変えるのも編集モードのときだけ。日記になったかたちは変えられない（サーバも 409・設計 §3） */}
      {editing ? (
        nikki ? (
          <p class="read-date-note">日記になったかたちは日付を変えられません</p>
        ) : (
          <div class="field read-date-edit">
            <label for="read-date">かたちの日付</label>
            <div class="read-date-row">
              <input
                type="date"
                id="read-date"
                value={dateDraft}
                onInput={(e) => setDateDraft(e.currentTarget.value)}
              />
              <button
                type="button"
                class="btn-primary"
                disabled={dateBusy || !dateDraft || dateDraft === katachi.date}
                onClick={async () => {
                  setDateBusy(true);
                  try {
                    await onChangeDate(dateDraft);
                  } finally {
                    setDateBusy(false);
                  }
                }}
              >
                日付を変える
              </button>
            </div>
          </div>
        )
      ) : null}

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
                <RichText text={k.body} imgClass="read-photo" cards={detail.cards} />
                {editing ? (
                <div class="read-frag-tools">
                  <button type="button" class="btn-ghost" onClick={() => setOpenId(k.id)}>
                    直す
                  </button>
                  <button
                    type="button"
                    class="btn-ghost"
                    onClick={async () => {
                      if (!confirm('このかけらをかたちから外して、かけらたちへ戻します。よろしいですか？')) return;
                      await onDetach(k.id);
                    }}
                  >
                    かけらたちへ戻す
                  </button>
                </div>
                ) : null}
              </>
            )}
          </div>
        ))}
      </div>

      {/* 足す導線は編集モードのときだけ（読む場所は読むことに徹する） */}
      {editing ? (
        <div style="margin-top:26px;">
          <button
            type="button"
            class="btn-ghost"
            style="width:100%;"
            onClick={() => {
              setOpenId(null);
              setPicking(true);
              onOpenPicker();
            }}
          >
            かけらを足す
          </button>
        </div>
      ) : null}

      {editing && picking ? (
        <KakeraPickSheet
          nagare={nagare}
          cards={nagareCards}
          loaded={nagareLoaded}
          onClose={() => setPicking(false)}
          onAdd={async (ids) => {
            await onAdd(ids);
            setPicking(false);
          }}
        />
      ) : null}

      <div style={editing ? 'margin-top:14px;' : 'margin-top:26px;'}>
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
              if (!confirm('このかたちを解きます。中のかけらはかけらたちへ戻ります。よろしいですか？')) return;
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
