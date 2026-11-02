import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { WordDetail, WordKakera, WordSummary } from '../lib/kakera/types';
import { api } from './api';
import { dateOf, dayGroupHeading, timeOf } from './format';
import { RichText, WordLinkContext } from './RichText';

/**
 * ことば（四つ目のタブ）。かけら言葉リンク設計 §2.3。
 * 本文の `[[言葉]]` の索引。新しく書いた順に 言葉・最後に書いた日・個数。
 * 表は持たないので、開くたびに本文から数え直す（かけらを消す・括弧を外すと減り、0 個で消える）。
 */
export function WordsScreen({
  onOpen,
  say,
}: {
  onOpen: (word: string) => void;
  say: (msg: string) => void;
}): JSX.Element {
  const [list, setList] = useState<WordSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .words()
      .then((words) => {
        if (alive) setList(words);
      })
      .catch((e: unknown) => say(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!list) return <p class="empty-note">読み込んでいます</p>;
  if (!list.length) return <p class="empty-note">まだ言葉がありません。書く欄で言葉を選んで [[ ]] を押すと、ここに溜まります</p>;
  return (
    <section>
      <p class="page-sub">{list.length}個の言葉。新しく書いた順。</p>
      <ul class="word-index">
        {list.map((w) => (
          <li key={w.word}>
            <button type="button" onClick={() => onOpen(w.word)}>
              <span class="word-index-name">{w.word}</span>
              <span class="word-index-last">{dateOf(w.last_written_at).slice(5).replace('-', '/')}</span>
              <span class="word-index-count">{w.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** かけらの居場所（`かけらたち`・`かたち 11/1`）。 */
function placeOf(k: WordKakera): string {
  if (!k.katachi_date) return 'かけらたち';
  return `かたち ${Number(k.katachi_date.slice(5, 7))}/${Number(k.katachi_date.slice(8, 10))}`;
}

/**
 * 言葉のページ。中身は集まったかけらの一覧だけ。かけらたちとかたちの両方から、新しい順に居場所つきで。
 * ページの言葉自身は太字で、他の言葉はリンク。
 * かけらの居場所の表示から先へは飛ばない（モックに無い）。
 */
export function WordPageScreen({
  word,
  backLabel,
  onBack,
  onOpen,
  say,
}: {
  word: string;
  /** 戻るに添える、来た画面の名前 */
  backLabel: string;
  onBack: () => void;
  onOpen: (word: string) => void;
  say: (msg: string) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<WordDetail | null>(null);
  const link = useMemo(() => ({ open: onOpen, here: word }), [onOpen, word]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    api
      .word(word)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((e: unknown) => say(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word]);

  let lastDay: string | null = null;

  return (
    <section>
      <div class="back-row">
        <button type="button" class="back-btn" onClick={onBack}>
          ‹ {backLabel}
        </button>
      </div>
      <h1 class="word-title">{word}</h1>
      {!detail ? (
        <p class="empty-note">読み込んでいます</p>
      ) : (
        <WordLinkContext.Provider value={link}>
          <p class="page-sub word-sub">{detail.kakera.length}個のかけら</p>
          <ul class="frag-list">
            {detail.kakera.map((k) => {
              const day = dateOf(k.written_at);
              const head = day !== lastDay ? day : null;
              lastDay = day;
              return (
                <>
                  {head ? (
                    <li class="flow-day-head" key={'h' + head}>
                      {dayGroupHeading(head)}
                    </li>
                  ) : null}
                  <li class="frag word-frag" key={k.id}>
                    <div class="frag-text frag-rich">
                      <RichText text={k.body} imgClass="assembled-photo" clipTall cards={detail.cards} />
                    </div>
                    <span class="word-frag-meta">
                      {timeOf(k.written_at)} ・ {placeOf(k)}
                    </span>
                  </li>
                </>
              );
            })}
          </ul>
        </WordLinkContext.Provider>
      )}
    </section>
  );
}
