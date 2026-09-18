import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Kakera, KatachiDetail, KatachiSummary, SearchResult } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import { nowJst } from '../lib/time';
import { ulid } from '../lib/ulid';
import { api } from './api';
import { WriteScreen } from './WriteScreen';
import { ComposeScreen } from './ComposeScreen';
import { KatachiListScreen } from './KatachiListScreen';
import { NikkiListScreen } from './NikkiListScreen';
import { ReadScreen } from './ReadScreen';
import { AssembleScreen } from './AssembleScreen';
import { NameMapScreen } from './NameMapScreen';

type View =
  | { t: 'write' }
  | { t: 'compose' }
  | { t: 'katachi' }
  | { t: 'nikki' }
  | { t: 'namemap' }
  | { t: 'read'; id: string }
  | { t: 'assemble'; id: string };

type Tab = 'write' | 'katachi' | 'nikki';

function tabOf(view: View): Tab {
  if (view.t === 'katachi' || view.t === 'read') return 'katachi';
  if (view.t === 'nikki' || view.t === 'namemap') return 'nikki';
  return 'write';
}

/** 読む側（かたち）だけ紙の世界にする。純粋に見た目の話で、操作には影響しない。 */
function isReadWorld(view: View): boolean {
  return view.t === 'katachi' || view.t === 'read';
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>({ t: 'write' });
  const [nagare, setNagare] = useState<Kakera[]>([]);
  const [nagareCards, setNagareCards] = useState<LinkCards>({});
  const [nagareLoaded, setNagareLoaded] = useState(false);
  const [katachiList, setKatachiList] = useState<KatachiSummary[]>([]);
  const [katachiLoaded, setKatachiLoaded] = useState(false);
  const [detail, setDetail] = useState<KatachiDetail | null>(null);

  // かたちの検索（第二段）。query が空なら検索せず、元の月ごとの一覧に戻る。
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const searchSeq = useRef(0);

  // 新しいかけらの下書き。id と written_at は「書き始めた瞬間」に決める——
  // 写真の置き場所（kakera/YYYY/MM/DD_hhmm_<ULID>_n）がこの二つから決まるため。
  const [draft, setDraft] = useState('');
  const draftMeta = useRef<{ id: string; writtenAt: string }>({ id: ulid(), writtenAt: nowJst() });

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const say = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  /** 失敗しても画面は壊さず、理由を出して止まる。 */
  const guard = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        say(e instanceof Error ? e.message : String(e));
      }
    },
    [say]
  );

  /** かたちに足した後の知らせ。日記済みのかたちのときだけ、公開中の日記は変わらないことを添える。 */
  const sayAdded = useCallback(
    (next: KatachiDetail) => {
      const where = `${next.katachi.date} のかたち`;
      if (next.nikki) {
        say(`${where}に入れました。公開中の日記は、「日記に書き足す」で選び直すまで変わりません`);
      } else {
        say(`${where}に入れました`);
      }
    },
    [say]
  );

  const loadNagare = useCallback(async () => {
    const { kakera, cards } = await api.nagare();
    setNagare(kakera);
    setNagareCards(cards);
    setNagareLoaded(true);
  }, []);

  const loadKatachiList = useCallback(async () => {
    setKatachiList(await api.katachiList());
    setKatachiLoaded(true);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(await api.katachi(id));
  }, []);

  // 入力欄を先に描いてから かけらたち を取りに行く（トップは常時即表示）
  useEffect(() => {
    void guard(loadNagare);
  }, [guard, loadNagare]);

  useEffect(() => {
    if (tabOf(view) !== 'write' && !katachiLoaded) void guard(loadKatachiList);
  }, [view, katachiLoaded, guard, loadKatachiList]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  // 打つたびに引く（デバウンス250ms）。空にしたら検索結果を捨てて元の一覧に戻る。
  useEffect(() => {
    const q = query.trim();
    setSearchResults(null); // 次の結果が来るまで「調べています」を出す
    if (!q) return;
    const seq = ++searchSeq.current;
    const timer = window.setTimeout(() => {
      void guard(async () => {
        const results = await api.search(q);
        if (searchSeq.current === seq) setSearchResults(results);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, guard]);

  function goTab(t: Tab): void {
    setView(t === 'write' ? { t: 'write' } : t === 'katachi' ? { t: 'katachi' } : { t: 'nikki' });
  }

  async function openKatachi(id: string): Promise<void> {
    await guard(async () => {
      await loadDetail(id);
      setView({ t: 'read', id });
    });
  }

  return (
    <div id="app" class={isReadWorld(view) ? 'mode-read' : undefined}>
      <header class="topbar">
        <div class="topbar-row">
          <span class="brand">かけら帳</span>
        </div>
        <nav class="tabs">
          {(
            [
              ['write', 'かけら'],
              ['katachi', 'かたち'],
              ['nikki', '日記'],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              type="button"
              key={key}
              class={tabOf(view) === key ? 'active' : undefined}
              onClick={() => goTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main>
        {view.t === 'write' ? (
          <WriteScreen
            nagare={nagare}
            cards={nagareCards}
            loaded={nagareLoaded}
            draft={draft}
            draftId={draftMeta.current.id}
            draftWrittenAt={draftMeta.current.writtenAt}
            onDraftInput={setDraft}
            onSave={() =>
              guard(async () => {
                await api.createKakera({
                  id: draftMeta.current.id,
                  body: draft.trim(),
                  written_at: draftMeta.current.writtenAt,
                });
                setDraft('');
                draftMeta.current = { id: ulid(), writtenAt: nowJst() };
                await loadNagare();
              })
            }
            onEdit={(id, body) =>
              guard(async () => {
                await api.updateKakera(id, body);
                await loadNagare();
                say('直しました');
              })
            }
            onDelete={(id) =>
              guard(async () => {
                await api.deleteKakera(id);
                await loadNagare();
                say('消しました');
              })
            }
            onGoCompose={() => setView({ t: 'compose' })}
            katachiList={katachiList}
            katachiLoaded={katachiLoaded}
            onOpenKatachiPicker={() => void guard(loadKatachiList)}
            onPutIntoKatachi={async (katachiId, kakeraId) => {
              try {
                const next = await api.addKakeraToKatachi(katachiId, [kakeraId]);
                if (detail?.katachi.id === katachiId) setDetail(next);
                await Promise.all([loadNagare(), loadKatachiList()]);
                sayAdded(next);
              } catch (e) {
                say(e instanceof Error ? e.message : String(e));
                throw e;
              }
            }}
          />
        ) : null}

        {view.t === 'compose' ? (
          <ComposeScreen
            nagare={nagare}
            cards={nagareCards}
            onBack={() => setView({ t: 'write' })}
            onCreate={(input) =>
              guard(async () => {
                const created = await api.createKatachi({
                  id: ulid(),
                  date: input.date,
                  title: input.title,
                  kakera_ids: input.kakera_ids,
                });
                await Promise.all([loadNagare(), loadKatachiList()]);
                setDetail(created);
                setView({ t: 'read', id: created.katachi.id });
                say('かたちにしました');
              })
            }
          />
        ) : null}

        {view.t === 'katachi' ? (
          <KatachiListScreen
            list={katachiList}
            loaded={katachiLoaded}
            onOpen={openKatachi}
            query={query}
            onQueryChange={setQuery}
            searchResults={searchResults}
          />
        ) : null}

        {view.t === 'nikki' ? (
          <NikkiListScreen
            list={katachiList.filter((k) => k.has_nikki)}
            loaded={katachiLoaded}
            onOpen={openKatachi}
            onOpenNameMap={() => setView({ t: 'namemap' })}
          />
        ) : null}

        {view.t === 'namemap' ? <NameMapScreen onBack={() => setView({ t: 'nikki' })} say={say} /> : null}

        {view.t === 'read' && detail && detail.katachi.id === view.id ? (
          <ReadScreen
            detail={detail}
            onBack={() => setView({ t: 'katachi' })}
            onGoAssemble={() => setView({ t: 'assemble', id: view.id })}
            onEdit={(id, body) =>
              guard(async () => {
                await api.updateKakera(id, body);
                await loadDetail(view.id);
                say('直しました');
              })
            }
            onDelete={(id) =>
              guard(async () => {
                await api.deleteKakera(id);
                await Promise.all([loadDetail(view.id), loadKatachiList()]);
                say('消しました');
              })
            }
            onDetach={(id) =>
              guard(async () => {
                await api.detachKakera(view.id, id);
                await Promise.all([loadDetail(view.id), loadNagare(), loadKatachiList()]);
                say('かけらたちへ戻しました');
              })
            }
            nagare={nagare}
            nagareCards={nagareCards}
            nagareLoaded={nagareLoaded}
            onOpenPicker={() => void guard(loadNagare)}
            onAdd={async (ids) => {
              // 失敗したら知らせて投げ直す（選ぶ一覧は開いたままにして、選び直せるように）
              try {
                const next = await api.addKakeraToKatachi(view.id, ids);
                setDetail(next);
                await Promise.all([loadNagare(), loadKatachiList()]);
                sayAdded(next);
              } catch (e) {
                say(e instanceof Error ? e.message : String(e));
                throw e;
              }
            }}
            onChangeDate={(date, moveNikki) =>
              guard(async () => {
                setDetail(await api.updateKatachi(view.id, moveNikki ? { date, move_nikki: true } : { date }));
                await loadKatachiList();
                say(moveNikki ? '日付を変えました。公開中の日記も新しい日付・URL に移しました' : '日付を変えました');
              })
            }
            onDissolve={() =>
              guard(async () => {
                await api.dissolveKatachi(view.id);
                await Promise.all([loadNagare(), loadKatachiList()]);
                setDetail(null);
                setView({ t: 'katachi' });
                say('かたちを解きました');
              })
            }
          />
        ) : null}

        {view.t === 'assemble' && detail && detail.katachi.id === view.id ? (
          <AssembleScreen
            detail={detail}
            onDetail={setDetail}
            onBack={() => setView({ t: 'read', id: view.id })}
            onPublish={(input) =>
              guard(async () => {
                await api.publishNikki(view.id, input);
                await Promise.all([loadDetail(view.id), loadKatachiList()]);
                setView({ t: 'nikki' });
                say('日記にしました');
              })
            }
            say={say}
          />
        ) : null}

        {(view.t === 'read' || view.t === 'assemble') && (!detail || detail.katachi.id !== view.id) ? (
          <p class="empty-note">読み込んでいます</p>
        ) : null}
      </main>

      <div id="toast" class={toast ? 'show' : undefined}>
        {toast}
      </div>
    </div>
  );
}
