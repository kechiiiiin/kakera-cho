import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Kakera, KatachiDetail } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import { KakeraPickSheet } from './PickSheets';
import { dateHeading, dateLiterary } from './format';
import { RichText } from './RichText';
import { KakeraEdit } from './KakeraEdit';
import { TimeBulkBar, TimeToggle } from './TimeToggle';
import { kakeraTimeLabel } from '../lib/kakera/time-label';

/**
 * かたちを読む。
 *  明朝の組版。⚠️ 時刻は出さない——ただし「時刻を出す」にしたかけらだけ、本文の上に灰色・等幅で出す
 *  （かけら時刻表示設計・2026-10-12。かたちの日付と違う日だけ日付を添える）。かけらの間は手書き風の罫（CSS の ::after）。
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
  onChangeTitle,
  onSetShowTime,
  nagare,
  nagareCards,
  nagareLoaded,
  onOpenPicker,
  onAdd,
}: {
  detail: KatachiDetail;
  onBack: () => void;
  onGoAssemble: () => void;
  onEdit: (id: string, body: string, writtenAt?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDetach: (id: string) => Promise<void>;
  onDissolve: () => Promise<void>;
  /**
   * かたちの日付を変える。moveNikki = 日記になったかたち（公開中の日記も移す・確認済み）。
   * 失敗（1日にひとつ・公開側との食い違い等）は呼び手が知らせる
   */
  onChangeDate: (date: string, moveNikki: boolean) => Promise<void>;
  /** かたちの題を変える（空なら題なし＝日付表示に戻る）。公開中の日記には触れない */
  onChangeTitle: (title: string) => Promise<void>;
  /** 「時刻を出す」を付ける／外す（1枚でも全部でも）。失敗は呼び手が知らせる */
  onSetShowTime: (ids: string[], show: boolean) => Promise<void>;
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
  const [titleDraft, setTitleDraft] = useState(detail.katachi.title ?? '');
  const [titleBusy, setTitleBusy] = useState(false);
  const [timeBusy, setTimeBusy] = useState(false);
  const { katachi, kakera, nikki } = detail;
  // 題は1行。改行は空白にして前後を落とす
  const titleNorm = titleDraft.replace(/\s*[\r\n]+\s*/g, ' ').trim();

  async function setTime(ids: string[], show: boolean): Promise<void> {
    if (timeBusy) return;
    setTimeBusy(true);
    try {
      await onSetShowTime(ids, show);
    } finally {
      setTimeBusy(false);
    }
  }

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
            setTitleDraft(katachi.title ?? '');
            setEditing(!editing);
          }}
        >
          {editing ? '読む' : '直す'}
        </button>
      </div>

      {editing ? (
        <div class="field read-title-edit">
          <p class="read-date-small">{dateHeading(katachi.date)}</p>
          <label for="read-title">かたちの題</label>
          <textarea
            id="read-title"
            class="read-title-input"
            rows={1}
            value={titleDraft}
            placeholder={dateLiterary(katachi.date)}
            onInput={(e) => setTitleDraft(e.currentTarget.value)}
          />
          <button
            type="button"
            class="btn-primary"
            disabled={titleBusy || titleNorm === (katachi.title ?? '')}
            onClick={async () => {
              setTitleBusy(true);
              try {
                await onChangeTitle(titleNorm);
                setTitleDraft(titleNorm);
              } finally {
                setTitleBusy(false);
              }
            }}
          >
            題を変える
          </button>
          {nikki ? <p class="read-date-note">公開中の日記の題は、次に日記へ書き足すときに変わります</p> : null}
        </div>
      ) : katachi.title ? (
        <>
          <p class="read-date-small">{dateHeading(katachi.date)}</p>
          <p class="page-date">{katachi.title}</p>
        </>
      ) : (
        <p class="page-date">{dateLiterary(katachi.date)}</p>
      )}

      {/* 日付を変えるのも編集モードのときだけ。日記になったかたちは、公開中の日記の日付と URL も一緒に移る（設計 §3） */}
      {editing ? (
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
                if (
                  nikki &&
                  !confirm(
                    `このかたちは日記になっています。日付を ${dateDraft} に変えると、公開中の日記の日付と URL も変わります（旧 URL は新しい方へ転送します。X には投稿しません）。よろしいですか？`
                  )
                ) {
                  return;
                }
                setDateBusy(true);
                try {
                  await onChangeDate(dateDraft, !!nikki);
                } finally {
                  setDateBusy(false);
                }
              }}
            >
              日付を変える
            </button>
          </div>
          {nikki ? <p class="read-date-note">日記になっています。変えると公開中の日記の日付と URL も変わります</p> : null}
        </div>
      ) : null}

      {/* 時刻を出すかけらの「全部に付ける／全部外す」も編集モードのときだけ */}
      {editing && kakera.length ? (
        <>
          <TimeBulkBar
            shown={kakera.filter((k) => k.show_time).length}
            total={kakera.length}
            disabled={timeBusy}
            onAll={(show) => void setTime(kakera.map((k) => k.id), show)}
          />
          {nikki ? <p class="read-date-note time-note">公開中の日記の時刻は、次に日記へ書き足すときに変わります</p> : null}
        </>
      ) : null}

      <div>
        {kakera.map((k) => (
          <div class="read-frag" key={k.id}>
            {editing && openId === k.id ? (
              <KakeraEdit
                kakera={k}
                cards={detail.cards}
                onSave={async (body, writtenAt) => {
                  await onEdit(k.id, body, writtenAt);
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
                {k.show_time ? (
                  <time class="read-time" dateTime={k.written_at}>
                    {kakeraTimeLabel(k.written_at, katachi.date)}
                  </time>
                ) : null}
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
                  <TimeToggle
                    checked={!!k.show_time}
                    disabled={timeBusy}
                    onChange={(on) => void setTime([k.id], on)}
                  />
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
