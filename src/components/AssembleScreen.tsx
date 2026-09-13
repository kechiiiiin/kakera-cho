import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Kakera, KatachiDetail } from '../lib/kakera/types';
import { composeBody } from '../lib/markdown';
import { textForPick } from '../lib/card/pick';
import { dateHeading } from './format';
import { RichText, RowThumb } from './RichText';
import { OrderList } from './OrderList';
import { isClickSuppressed } from './drag';

/**
 * 日記にする。
 *  出すかけらを選ぶ＋公開版だけの並びをドラッグで組む。区切り線込みのプレビューを見せてから書き出す。
 *  既に日記になっているときは、出したかけらが最初から選択済みで並んでいる（`日記に出した` の印つき）。
 *  ここで組み直した内容で全体が上書きされる。
 */
export function AssembleScreen({
  detail,
  onBack,
  onPublish,
}: {
  detail: KatachiDetail;
  onBack: () => void;
  onPublish: (input: { kakera_ids: string[]; title: string }) => Promise<void>;
}): JSX.Element {
  const { katachi, kakera, nikki, published_ids } = detail;
  const [order, setOrder] = useState<string[]>(published_ids.filter((id) => kakera.some((k) => k.id === id)));
  const [step, setStep] = useState<'pick' | 'form'>('pick');
  // 初期値は katachi.title。組み直し方式なので、変えた題も次の書き出しで初期値に戻る
  const [title, setTitle] = useState(katachi.title);
  const [busy, setBusy] = useState(false);

  const byId = new Map(kakera.map((k) => [k.id, k]));
  const chosen = order.map((id) => byId.get(id)).filter((k): k is Kakera => !!k);

  function toggle(id: string): void {
    if (isClickSuppressed()) return;
    setOrder(order.includes(id) ? order.filter((x) => x !== id) : [...order, id]);
  }

  if (step === 'form') {
    return (
      <section>
        <div class="back-row">
          <button type="button" class="back-btn" onClick={() => setStep('pick')}>
            ‹ 組み直す
          </button>
        </div>
        <p class="page-date" style="font-size:17px;">日記を書き出す</p>
        <p class="form-note">タイトルと日付を確認して、書き出してください。</p>

        <div class="field">
          <label for="pub-title">タイトル</label>
          <input
            type="text"
            id="pub-title"
            value={title}
            placeholder={katachi.date}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="pub-date">公開日（かたちの日付）</label>
          <input type="text" id="pub-date" value={katachi.date} readOnly />
        </div>
        <div class="field">
          <label for="pub-body">本文（区切り線つき）</label>
          <textarea id="pub-body" class="preview" readOnly value={composeBody(chosen.map((k) => k.body))} />
        </div>

        {nikki ? (
          <p class="form-note">
            既にある日記を、この内容で丸ごと上書きします（差分の追記ではありません）。X には再投稿されません。
          </p>
        ) : null}

        <button
          type="button"
          class="btn-cta"
          style="width:100%;"
          disabled={busy || !chosen.length}
          onClick={async () => {
            setBusy(true);
            try {
              await onPublish({ kakera_ids: order, title: title.trim() });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '書き出しています' : '書き出す'}
        </button>
      </section>
    );
  }

  return (
    <section>
      <div class="back-row">
        <button type="button" class="back-btn" onClick={onBack}>
          ‹ かたちに戻る
        </button>
      </div>
      <p class="page-date" style="font-size:17px;">{nikki ? '日記に書き足す' : '日記にする'}</p>
      <p class="page-sub">{dateHeading(katachi.date)} のかたちから組みます</p>

      <div class="section-head" style="margin-top:8px;">
        <h2>日記に出すかけらを選ぶ</h2>
      </div>
      <div class="assembled">
        {kakera.map((k) => {
          const checked = order.includes(k.id);
          return (
            <div class="pick-row" key={k.id} onClick={() => toggle(k.id)}>
              <div class={'checkbox' + (checked ? ' checked' : '')}>{checked ? '✓' : ''}</div>
              <div class="pick-text">
                <span class="pick-excerpt">{textForPick(k.body, detail.cards)}</span>
                {published_ids.includes(k.id) ? <div class="tag-published">日記に出した</div> : null}
              </div>
              <RowThumb text={k.body} />
            </div>
          );
        })}
      </div>

      <div class="section-head">
        <h2>日記はこう並びます（{order.length}枚）</h2>
      </div>
      {!order.length ? (
        <p class="empty-note">まだ選ばれていません</p>
      ) : (
        <OrderList
          items={chosen.map((k) => ({
            id: k.id,
            // 「日記はこう並びます」は公開後の見え方のプレビューなので、カードも埋め込みも出す
            content: <RichText text={k.body} imgClass="assembled-photo" cards={detail.cards} />,
          }))}
          onReorder={setOrder}
        />
      )}

      <div style="margin-top:22px;">
        <button
          type="button"
          class="btn-cta"
          style="width:100%;"
          disabled={!order.length}
          onClick={() => setStep('form')}
        >
          フォームへ
        </button>
      </div>
    </section>
  );
}
