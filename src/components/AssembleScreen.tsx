import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Kakera, KatachiDetail } from '../lib/kakera/types';
import { textForPick } from '../lib/card/pick';
import { dateHeading } from './format';
import { RichText, RowThumb } from './RichText';
import { OrderList } from './OrderList';
import { isClickSuppressed } from './drag';
import { ConvertScreen } from './ConvertScreen';
import type { PublishNikkiInput } from './api';

/**
 * 日記にする → 変換 → 書き出し（公開名変換設計）。
 *  日記にする: 出すかけらを選ぶ＋公開版だけの並びをドラッグで組む＋タイトル（変換ページにタイトルを出すため、ここへ移した）。
 *  既に日記になっているときは、出したかけらが最初から選択済みで並んでいる（`日記に出した` の印つき）。
 *  ここで組み直した内容で全体が上書きされる。
 *  変換: 名前を公開用に置き換えた姿を見せて、箇所ごとに選び直す（ConvertScreen）。
 */
export function AssembleScreen({
  detail,
  onBack,
  onPublish,
  say,
}: {
  detail: KatachiDetail;
  onBack: () => void;
  onPublish: (input: PublishNikkiInput) => Promise<void>;
  say: (msg: string) => void;
}): JSX.Element {
  const { katachi, kakera, nikki, published_ids } = detail;
  const [order, setOrder] = useState<string[]>(published_ids.filter((id) => kakera.some((k) => k.id === id)));
  const [step, setStep] = useState<'pick' | 'convert'>('pick');
  // 初期値は katachi.title。組み直し方式なので、変えた題も次の書き出しで初期値に戻る
  const [title, setTitle] = useState(katachi.title);

  const byId = new Map(kakera.map((k) => [k.id, k]));
  const chosen = order.map((id) => byId.get(id)).filter((k): k is Kakera => !!k);

  /**
   * 新しくチェックしたかけらの差し込み位置（Keisuke 決定・設計 §3「日記の並び」）。
   * 現在の日記の並び（手で並べ替えた後かもしれない）の中で、written_at がそれ以下の
   * 最後のかけらの直後に入れる。そういうかけらが無ければ先頭。同じなら既存の後ろ（<= で判定）。
   */
  function insertPosition(current: string[], id: string): number {
    const target = byId.get(id);
    if (!target) return current.length;
    let lastIdx = -1;
    for (let i = 0; i < current.length; i++) {
      const k = byId.get(current[i]!);
      if (k && k.written_at <= target.written_at) lastIdx = i;
    }
    return lastIdx + 1;
  }

  function toggle(id: string): void {
    if (isClickSuppressed()) return;
    if (order.includes(id)) {
      setOrder(order.filter((x) => x !== id));
      return;
    }
    const pos = insertPosition(order, id);
    setOrder([...order.slice(0, pos), id, ...order.slice(pos)]);
  }

  if (step === 'convert') {
    return (
      <ConvertScreen
        detail={detail}
        order={chosen.map((k) => k.id)}
        titleInput={title.trim()}
        onBack={() => setStep('pick')}
        onPublish={onPublish}
        say={say}
      />
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

      <div class="section-head">
        <h2>書き出す内容</h2>
      </div>
      <div class="field">
        <label for="pub-title">タイトル</label>
        <input
          type="text"
          id="pub-title"
          value={title}
          placeholder={katachi.title || katachi.date}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </div>
      <div class="field">
        <label for="pub-date">公開日（かたちの日付）</label>
        <input type="text" id="pub-date" value={katachi.date} readOnly />
      </div>

      <button
        type="button"
        class="btn-cta"
        style="width:100%;"
        disabled={!order.length}
        onClick={() => setStep('convert')}
      >
        変換へ進む
      </button>
      <p class="form-note export-note">次の画面で、名前を公開用に置き換えます。かけらは実名のまま残ります。</p>
      {nikki ? (
        <p class="form-note export-note">
          既にある日記を、この内容で丸ごと上書きします（差分の追記ではありません）。X には再投稿されません。
        </p>
      ) : null}
    </section>
  );
}
