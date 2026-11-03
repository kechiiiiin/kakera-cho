import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Kakera } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import { candidateContext, textForPick } from '../lib/card/pick';
import { planWordLinks, wordLinkEdits, type WordLinkEdit, type WordLinkRow } from '../lib/kakera/word-links';
import { api } from './api';
import { dateHeading, dateOf, timeOf } from './format';
import { RowThumb } from './RichText';
import { TimeBulkBar, TimeToggle } from './TimeToggle';

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
 *  「かたちにする」を押すと、かたちを作る前に、既にページがある言葉の確認を1枚挟む（かけら言葉リンク設計 §3.5）。
 *  候補が無ければ挟まない。索引を取れないときも挟まない（かたちにするのを止めない）。入力中は何も出さない。
 */
export function ComposeScreen({
  nagare,
  cards,
  onBack,
  onCreate,
  onLinkWords,
}: {
  nagare: Kakera[];
  /** URL をタイトルに畳むためだけに使う（ここのために取りに行かない） */
  cards: LinkCards;
  onBack: () => void;
  onCreate: (input: { date: string; title: string; kakera_ids: string[]; show_time_ids: string[] }) => Promise<void>;
  /** 本文の直しを当てる。失敗したら知らせて投げる（かたちは作らない） */
  onLinkWords: (edits: WordLinkEdit[]) => Promise<void>;
}): JSX.Element {
  const [picked, setPicked] = useState<string[]>([]);
  // 時刻を出すかけら（かけら時刻表示設計・2026-10-12）。既定はオフ。選びから外したら一緒に外す
  const [showTime, setShowTime] = useState<string[]>([]);
  const [date, setDate] = useState('');
  const [dateAuto, setDateAuto] = useState(true);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  // 確認の行（null = 確認を開いていない）と、外した行
  const [rows, setRows] = useState<WordLinkRow[] | null>(null);
  const [off, setOff] = useState<string[]>([]);
  const confirming = !!rows;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [confirming]);

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
    if (!next.includes(id)) setShowTime((s) => s.filter((x) => x !== id));
    if (dateAuto) setDate(recomputeDate(next));
  }

  async function finish(edits: WordLinkEdit[]): Promise<void> {
    if (edits.length) {
      try {
        await onLinkWords(edits);
      } catch {
        // 知らせは onLinkWords が出している。かたちは作らず、選ぶ画面へ戻る（直し終えたかけらは囲まれたまま）
        setRows(null);
        return;
      }
    }
    await onCreate({
      date: date || recomputeDate(picked),
      title: title.trim(),
      kakera_ids: chosen.map((k) => k.id),
      show_time_ids: chosen.filter((k) => showTime.includes(k.id)).map((k) => k.id),
    });
    // かたちを作れなかったとき（同じ日付がある等）は選ぶ画面へ戻る
    setRows(null);
  }

  async function create(): Promise<void> {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      const pages = await api.words().then(
        (words) => words.map((w) => w.word),
        () => [] as string[] // 索引を取れなければ確認を挟まず進む
      );
      const found = planWordLinks(chosen, pages);
      if (found.length) {
        setOff([]);
        setRows(found);
        return;
      }
      await finish([]);
    } finally {
      setBusy(false);
    }
  }

  async function confirmLinks(list: WordLinkRow[]): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await finish(wordLinkEdits(list.filter((r) => !off.includes(r.key))));
    } finally {
      setBusy(false);
    }
  }

  if (rows) {
    const count = rows.filter((r) => !off.includes(r.key)).length;
    return (
      <section>
        <div class="back-row">
          <button type="button" class="back-btn" disabled={busy} onClick={() => setRows(null)}>
            ‹ かけらを選び直す
          </button>
        </div>
        <p class="page-date" style="font-size:17px;">この言葉もリンクにしますか</p>
        <p class="page-sub">すでにページがある言葉です。いらないものは外してください。</p>
        <div class="assembled">
          {rows.map((r) => {
            const checked = !off.includes(r.key);
            const c = candidateContext(r.body, r, cards);
            return (
              <div
                class="pick-row"
                key={r.key}
                onClick={() => {
                  if (!busy) setOff((o) => (checked ? [...o, r.key] : o.filter((x) => x !== r.key)));
                }}
              >
                <div class={'checkbox' + (checked ? ' checked' : '')}>{checked ? '✓' : ''}</div>
                <div class="pick-text">
                  {c.before}
                  <span class="word-hit">{c.word}</span>
                  {c.after}
                </div>
              </div>
            );
          })}
        </div>
        <div style="margin-top:22px;">
          <button type="button" class="btn-cta" style="width:100%;" disabled={busy} onClick={() => void confirmLinks(rows)}>
            {count ? `${count}か所をリンクにして、かたちにする` : 'そのまま、かたちにする'}
          </button>
        </div>
      </section>
    );
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
        <>
          <TimeBulkBar
            shown={chosen.filter((k) => showTime.includes(k.id)).length}
            total={chosen.length}
            onAll={(show) => setShowTime(show ? chosen.map((k) => k.id) : [])}
          />
          <div class="assembled">
            {chosen.map((k) => (
              <div class="assembled-item" key={k.id}>
                <span class="assembled-num assembled-time">{timeOf(k.written_at)}</span>
                <div class="assembled-text">
                  <span class="pick-excerpt">{textForPick(k.body, cards)}</span>
                </div>
                <TimeToggle
                  checked={showTime.includes(k.id)}
                  onChange={(on) =>
                    setShowTime((s) => (on ? [...s.filter((x) => x !== k.id), k.id] : s.filter((x) => x !== k.id)))
                  }
                />
              </div>
            ))}
          </div>
        </>
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
