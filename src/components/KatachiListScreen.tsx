import type { JSX } from 'preact';
import type { KatachiSummary } from '../lib/kakera/types';
import { monthHeading, weekdayOf } from './format';

/**
 * かたち（一覧）。
 *  タイトルが主役。題が無い日は1枚目の冒頭を薄く出す（「無題」とは書かない）。
 *  枚数は出さない。月ごとの見出しでまとめ、日記になったものには `日記あり` の小さなバッジ（朱）。
 */
export function KatachiListScreen({
  list,
  loaded,
  onOpen,
}: {
  list: KatachiSummary[];
  loaded: boolean;
  onOpen: (id: string) => void;
}): JSX.Element {
  const months = new Map<string, KatachiSummary[]>();
  for (const k of list) {
    const m = k.date.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m)!.push(k);
  }

  return (
    <section>
      <p class="page-date">かたち</p>
      <input class="search-box" placeholder="検索（第二段で実装）" disabled />
      {!loaded ? (
        <p class="empty-note">読み込んでいます</p>
      ) : !list.length ? (
        <p class="empty-note">まだかたちがありません</p>
      ) : (
        [...months.entries()].map(([m, rows]) => (
          <div key={m}>
            <div class="month-head">{monthHeading(m)}</div>
            {rows.map((k) => (
              <div class="day-row" key={k.id} onClick={() => onOpen(k.id)}>
                <div class="day-left">
                  <div class={'day-title' + (k.title ? '' : ' day-title-untitled')}>
                    {k.title || k.lead}
                  </div>
                  <div class="day-meta">
                    <span class="day-date-small">
                      {k.date.slice(8)} ({weekdayOf(k.date)})
                    </span>
                  </div>
                </div>
                {k.has_nikki ? <span class="badge-published">日記あり</span> : null}
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  );
}
