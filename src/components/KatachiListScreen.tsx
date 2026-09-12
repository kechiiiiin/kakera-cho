import type { JSX } from 'preact';
import type { KatachiSummary, SearchResult } from '../lib/kakera/types';
import { monthHeading, weekdayOf } from './format';

/**
 * 検索語を含む抜粋を、朱一色でハイライトして返す（見た目は設計 §9 の差し色ひとつだけ）。
 * trigram も LIKE も「部分文字列を含む」判定なので、クエリの文字列そのままで見つかる。
 */
function highlight(text: string, query: string): (string | JSX.Element)[] {
  const q = query.trim();
  if (!q) return [text];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: (string | JSX.Element)[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark class="search-hit" key={key++}>
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
  }
  return out;
}

/**
 * かたち（一覧）。
 *  タイトルが主役。題が無い日は1枚目の冒頭を薄く出す（「無題」とは書かない）。
 *  枚数は出さない。月ごとの見出しでまとめ、日記になったものには `日記あり` の小さなバッジ（朱）。
 *
 *  検索（第二段）: 打つたびに引く（呼び出し元 App.tsx が250msデバウンスして /api/search を叩く）。
 *  空にしたら検索結果を捨てて元の月ごとの一覧に戻る。ヒットしたかけらの抜粋を添える。
 */
export function KatachiListScreen({
  list,
  loaded,
  onOpen,
  query,
  onQueryChange,
  searchResults,
}: {
  list: KatachiSummary[];
  loaded: boolean;
  onOpen: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  searchResults: SearchResult[] | null;
}): JSX.Element {
  const inSearch = query.trim().length > 0;

  const months = new Map<string, KatachiSummary[]>();
  for (const k of list) {
    const m = k.date.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m)!.push(k);
  }

  return (
    <section>
      <p class="page-date">かたち</p>
      <input
        class="search-box"
        placeholder="検索"
        value={query}
        onInput={(e) => onQueryChange((e.target as HTMLInputElement).value)}
      />

      {inSearch ? (
        searchResults === null ? (
          <p class="empty-note">調べています</p>
        ) : !searchResults.length ? (
          <p class="empty-note">見つかりませんでした</p>
        ) : (
          searchResults.map((r) => (
            <div class="day-row" key={r.id} onClick={() => onOpen(r.id)}>
              <div class="day-left">
                <div class={'day-title' + (r.title ? '' : ' day-title-untitled')}>
                  {r.title || r.date}
                </div>
                <div class="day-meta">
                  <span class="day-date-small">
                    {r.date.slice(5)} ({weekdayOf(r.date)})
                  </span>
                </div>
                {r.matches.map((m) => (
                  <div class="search-excerpt" key={m.kakera_id}>
                    {highlight(m.excerpt, query)}
                  </div>
                ))}
              </div>
              {r.has_nikki ? <span class="badge-published">日記あり</span> : null}
            </div>
          ))
        )
      ) : !loaded ? (
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
