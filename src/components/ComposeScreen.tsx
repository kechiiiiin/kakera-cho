import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Kakera } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import { textForPick } from '../lib/card/pick';
import { dateHeading, dateOf, timeOf } from './format';
import { RowThumb } from './RichText';

/** 書いた順（古い順・同時刻は id 順）。サーバの並び（db.ts の WRITTEN_ORDER）と揃える。 */
function byWrittenOrder(a: Kakera, b: Kakera): number {
  if (a.written_at !== b.written_at) return a.written_at < b.written_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * かたちにする。
 *  入れるかけらを選ぶ（未かたちのみ）→ 日付 → 題。
 *  ★かたちの中の並びは常に書いた順（2026-09-13 決定）。選んだ順では並べず、並べ替えもしない。
 *    並びを調整したくなるのは日記のほう（日記にする画面で組む）。
 *  日付の既定値は、選んだかけらのうち最も古いものの日付。
 *  選び直すたびに更新するが、⚠️ 手で変えた後は上書きしない。
 */
export function ComposeScreen({
  nagare,
  cards,
  onBack,
  onCreate,
}: {
  nagare: Kakera[];
  /** URL をタイトルに畳むためだけに使う（ここのために取りに行かない） */
  cards: LinkCards;
  onBack: () => void;
  onCreate: (input: { date: string; title: string; kakera_ids: string[] }) => Promise<void>;
}): JSX.Element {
  const [picked, setPicked] = useState<string[]>([]);
  const [date, setDate] = useState('');
  const [dateAuto, setDateAuto] = useState(true);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const byId = new Map(nagare.map((k) => [k.id, k]));
  const chosen = picked
    .map((id) => byId.get(id))
    .filter((k): k is Kakera => !!k)
    .sort(byWrittenOrder);

  function recomputeDate(next: string[]): string {
    if (!next.length) return '';
    let min: string | null = null;
    for (const id of next) {
      const k = byId.get(id);
      if (k && (min === null || k.written_at < min)) min = k.written_at;
    }
    return min ? dateOf(min) : '';
  }

  function toggle(id: string): void {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    setPicked(next);
    if (dateAuto) setDate(recomputeDate(next));
  }

  async function create(): Promise<void> {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      await onCreate({
        date: date || recomputeDate(picked),
        title: title.trim(),
        kakera_ids: chosen.map((k) => k.id),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div class="back-row">
        <button type="button" class="back-btn" onClick={onBack}>
          ‹ かけらへ戻る
        </button>
      </div>
      <p class="page-date" style="font-size:17px;">かたちにする</p>
      <p class="page-sub">かけらたちから、ひとつのかたちを作ります。</p>

      <div class="section-head">
        <h2>入れるかけらを選ぶ</h2>
      </div>
      <div class="assembled">
        {!nagare.length ? (
          <p class="empty-note">まだかたちになっていないかけらがありません</p>
        ) : (
          nagare.map((k) => {
            const checked = picked.includes(k.id);
            return (
              <div class="pick-row" key={k.id} onClick={() => toggle(k.id)}>
                <div class={'checkbox' + (checked ? ' checked' : '')}>{checked ? '✓' : ''}</div>
                <div class="pick-text">
                  <span class="pick-excerpt">{textForPick(k.body, cards)}</span>
                  <div class="pick-time">
                    {dateHeading(dateOf(k.written_at))} {timeOf(k.written_at)}
                  </div>
                </div>
                <RowThumb text={k.body} />
              </div>
            );
          })
        )}
      </div>

      <div class="field" style="margin-top:22px;">
        <label for="compose-date">かたちの日付</label>
        <input
          type="date"
          id="compose-date"
          value={date}
          onInput={(e) => {
            setDateAuto(false);
            setDate(e.currentTarget.value);
          }}
        />
      </div>
      <div class="field">
        <label for="compose-title">タイトル</label>
        <input
          type="text"
          id="compose-title"
          placeholder="タイトル（任意）"
          value={title}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </div>

      <div class="section-head">
        <h2>書いた順にかたちになります（{chosen.length}）</h2>
      </div>
      {!chosen.length ? (
        <p class="empty-note">まだ選ばれていません</p>
      ) : (
        <div class="assembled">
          {chosen.map((k) => (
            <div class="assembled-item" key={k.id}>
              <span class="assembled-num assembled-time">{timeOf(k.written_at)}</span>
              <div class="assembled-text">
                <span class="pick-excerpt">{textForPick(k.body, cards)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style="margin-top:22px;">
        <button
          type="button"
          class="btn-cta"
          style="width:100%;"
          disabled={!chosen.length || !date || busy}
          onClick={create}
        >
          かたちにする
        </button>
      </div>
    </section>
  );
}
