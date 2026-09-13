import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Kakera, KatachiDetail } from '../lib/kakera/types';
import type { SegChoice } from '../lib/names/db';
import { composeBody } from '../lib/markdown';
import { renderDiaryFile } from '../lib/publish/diary-file';
import {
  choiceMap,
  cleanEditText,
  convertText,
  effectiveChoice,
  findHits,
  shownWord,
  tokenizeForNames,
  type NameEntry,
  type NameHit,
  type NameToken,
} from '../lib/names/replace';
import {
  convertForPublish,
  hiddenKeysOf,
  hiddenPhotoSpans,
  overlapsAny,
  photoKeysIn,
  type PhotoChoice,
} from '../lib/publish/photo-choice';
import { api, type PublishNikkiInput } from './api';
import { timeOf } from './format';
import { RichText } from './RichText';
import { MarkedBody, renderSpan, type MarkRender, type MarkStatus, type PhotoToggle } from './NameMarks';

/**
 * 変換（公開名変換設計・モックが正）。
 *  組み上がった日記のタイトルと本文を出し、辞書に当たった箇所に印。開いた時点で全箇所が辞書どおり。
 *  印を押すと下からシート: 承認（辞書どおり）／手で直す（その箇所だけ）／拒否（実名のまま）。
 *  選択はかけらごとに D1 へ覚える（押すたびに保存）。拒否が残ったまま書き出すときは念押しを出す。
 *  写真: 写真ごとに「日記に出す／出さない」。開いた時点では全部出す。出さない写真は「公開される姿」
 *  「Markdown」から画像記法ごと消える。選択は写真の key に紐づけて D1 へ覚える（本文を直しても残る）。
 *
 * ⚠️ ここで作る本文は見せるためだけ。書き出すときはサーバが原本から置き換え直す。
 */

interface Seg {
  /** 'title' か、かけらの id */
  seg: string;
  text: string;
  tokens: NameToken[];
  hits: NameHit[];
  kakera: Kakera | null;
  num: number;
}

type Sheet =
  | { type: 'hit'; seg: string; pos: number; editing: boolean; draft: string }
  | { type: 'confirm' };

type ViewMode = 'marks' | 'plain' | 'md';

function keyOf(seg: string, pos: number): string {
  return `${seg}:${pos}`;
}

function Snippet({ text, pos, len, bold }: { text: string; pos: number; len: number; bold: boolean }): JSX.Element {
  const a = Math.max(0, pos - 14);
  const b = Math.min(text.length, pos + len + 14);
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const word = text.slice(pos, pos + len);
  return (
    <>
      {a > 0 ? '…' : ''}
      {flat(text.slice(a, pos))}
      {bold ? <b>{word}</b> : word}
      {flat(text.slice(pos + len, b))}
      {b < text.length ? '…' : ''}
    </>
  );
}

export function ConvertScreen({
  detail,
  order,
  titleInput,
  onBack,
  onPublish,
  say,
}: {
  detail: KatachiDetail;
  order: string[];
  titleInput: string;
  onBack: () => void;
  onPublish: (input: PublishNikkiInput) => Promise<void>;
  say: (msg: string) => void;
}): JSX.Element {
  const katachiId = detail.katachi.id;
  const [entries, setEntries] = useState<NameEntry[] | null>(null);
  const [title, setTitle] = useState('');
  const [choices, setChoices] = useState<SegChoice[]>([]);
  const [carried, setCarried] = useState(false);
  /** 日記に出さない写真（出す写真は持たない） */
  const [photos, setPhotos] = useState<PhotoChoice[]>([]);
  const [carriedPhotos, setCarriedPhotos] = useState(0);
  const [resetKakera, setResetKakera] = useState<string[]>([]);
  const [resetTitle, setResetTitle] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('marks');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.loadNameChoices(katachiId, { kakera_ids: order, title: titleInput }),
      api.loadPhotoChoices(katachiId, { kakera_ids: order }),
    ])
      .then(([r, hiddenPhotos]) => {
        if (!alive) return;
        setPhotos(hiddenPhotos);
        setCarriedPhotos(hiddenPhotos.length);
        setEntries(r.entries);
        setTitle(r.title);
        setChoices(r.choices);
        setCarried(r.choices.length > 0);
        setResetKakera(r.reset_kakera_ids);
        setResetTitle(r.reset_title);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setFailed(msg);
        say(msg);
      });
    return () => {
      alive = false;
    };
    // 開いたときに一度だけ読む（並びとタイトルは「組み直す」で戻らないと変わらない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // シートを閉じたあと、選び直した箇所へ寄せて一瞬光らせる
  useEffect(() => {
    if (!flash) return;
    const el = document.querySelector<HTMLElement>(`[data-mark="${CSS.escape(flash.key)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }, [flash]);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  useEffect(() => {
    if (sheet?.type === 'hit' && sheet.editing) editRef.current?.focus();
    // 「手で直す」を開いた瞬間だけ入力欄に寄せる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet?.type === 'hit' && sheet.editing]);

  const back = (
    <div class="back-row">
      <button type="button" class="back-btn" onClick={onBack}>
        ‹ 組み直す
      </button>
    </div>
  );
  const head = (
    <>
      {back}
      <p class="page-date" style="font-size:17px;">
        変換
      </p>
      <p class="page-sub">名前を公開用に置き換えました。印を押すと、その箇所だけ選び直せます。</p>
    </>
  );

  if (failed) {
    return (
      <section>
        {head}
        <p class="warn-note">読み込めませんでした: {failed}</p>
      </section>
    );
  }
  if (!entries) {
    return (
      <section>
        {head}
        <p class="empty-note">読み込んでいます</p>
      </section>
    );
  }
  const dict = entries;

  const byId = new Map(detail.kakera.map((k) => [k.id, k]));
  const chosen = order.map((id) => byId.get(id)).filter((k): k is Kakera => !!k);
  const makeSeg = (seg: string, text: string, kakera: Kakera | null, num: number): Seg => {
    const tokens = tokenizeForNames(text);
    return { seg, text, tokens, hits: findHits(text, dict, tokens), kakera, num };
  };
  const titleSeg = makeSeg('title', title, null, 0);
  const bodySegs = chosen.map((k, i) => makeSeg(k.id, k.body, k, i + 1));
  const segs = [titleSeg, ...bodySegs];
  const segOf = (seg: string) => segs.find((s) => s.seg === seg) ?? null;

  const choiceOf = (seg: string, hit: NameHit) => choices.find((c) => c.seg === seg && c.pos === hit.pos);
  const statusOf = (seg: string, hit: NameHit): MarkStatus => {
    const a = effectiveChoice(hit, choiceOf(seg, hit)).action;
    return a === 'approve' ? 'dict' : a;
  };
  // 公開版の本文。書き出し（nikki.ts）と同じ convertForPublish を通す（名前の置き換え＋出さない写真を除く）
  const converted = (s: Seg) => {
    const ch = choiceMap(choices.filter((c) => c.seg === s.seg));
    return s.seg === 'title'
      ? convertText(s.text, dict, ch).text
      : convertForPublish(s.text, dict, ch, hiddenKeysOf(photos, s.seg)).text;
  };
  // 出さない写真ぶん切り落とす範囲。そこに掛かる当たり箇所（代替文字の名前）は公開されないので数えない
  const dropsOf = (s: Seg) => (s.seg === 'title' ? [] : hiddenPhotoSpans(s.text, hiddenKeysOf(photos, s.seg), s.tokens));

  const photoCount = { shown: 0, hidden: 0 };
  for (const s of bodySegs) {
    const hidden = hiddenKeysOf(photos, s.seg);
    for (const key of photoKeysIn(s.text, s.tokens)) photoCount[hidden.has(key) ? 'hidden' : 'shown']++;
  }

  const counts = { dict: 0, edit: 0, reject: 0, exc: 0 };
  const rejects: { s: Seg; hit: NameHit }[] = [];
  for (const s of segs) {
    const drops = dropsOf(s);
    for (const h of s.hits) {
      if (overlapsAny(h.pos, h.pos + h.source.length, drops)) continue;
      if (h.exception) {
        counts.exc++;
        continue;
      }
      const st = statusOf(s.seg, h);
      counts[st]++;
      if (st === 'reject') rejects.push({ s, hit: h });
    }
  }

  function persist(next: SegChoice[]): void {
    saveChain.current = saveChain.current
      .then(() => api.saveNameChoices(katachiId, { kakera_ids: order, title: titleInput, choices: next }))
      .then(() => undefined)
      .catch((e: unknown) => say('選択を保存できませんでした: ' + (e instanceof Error ? e.message : String(e))));
  }

  function persistPhotos(next: PhotoChoice[]): void {
    saveChain.current = saveChain.current
      .then(() => api.savePhotoChoices(katachiId, { kakera_ids: order, photos: next }))
      .then(() => undefined)
      .catch((e: unknown) => say('写真の選択を保存できませんでした: ' + (e instanceof Error ? e.message : String(e))));
  }

  const photoToggleOf = (s: Seg): PhotoToggle => ({
    hidden: (key) => photos.some((p) => p.kakera_id === s.seg && p.key === key),
    onToggle: (key) => {
      const on = photos.some((p) => p.kakera_id === s.seg && p.key === key);
      const next = on
        ? photos.filter((p) => !(p.kakera_id === s.seg && p.key === key))
        : [...photos, { kakera_id: s.seg, key }];
      setPhotos(next);
      persistPhotos(next);
    },
  });

  function choose(seg: string, hit: NameHit, action: 'approve' | 'edit' | 'reject', text?: string): void {
    const rest = choices.filter((c) => !(c.seg === seg && c.pos === hit.pos));
    const next: SegChoice[] =
      action === 'approve'
        ? rest
        : [...rest, { seg, pos: hit.pos, source: hit.source, action, ...(text ? { text } : {}) }];
    setChoices(next);
    persist(next);
    setSheet(null);
    setFlash({ key: keyOf(seg, hit.pos), n: Date.now() });
  }

  const renderOf = (s: Seg): MarkRender => ({
    text: s.text,
    hits: s.hits,
    word: (h) => shownWord(h, choiceOf(s.seg, h)),
    status: (h) => statusOf(s.seg, h),
    keyOf: (h) => keyOf(s.seg, h.pos),
    onPress: (h) => setSheet({ type: 'hit', seg: s.seg, pos: h.pos, editing: false, draft: '' }),
  });

  const segLabel = (s: Seg) =>
    s.seg === 'title' ? 'タイトル' : `かけら ${s.num}` + (s.kakera ? `・${timeOf(s.kakera.written_at)}` : '');

  async function publish(confirmRealNames: boolean): Promise<void> {
    setBusy(true);
    try {
      await saveChain.current;
      await onPublish({ kakera_ids: order, title: titleInput, choices, photos, confirm_real_names: confirmRealNames });
    } finally {
      setBusy(false);
    }
  }

  const titleOut = converted(titleSeg);
  const resetNums = bodySegs.filter((s) => resetKakera.includes(s.seg)).map((s) => s.num);
  // 空になるかけら（写真をすべて出さないにした等）と、全体が空かどうか。
  // composeBody は空のかけらを飛ばして連結するので、trim が空＝1枚も中身が残らなかったとき
  const bodyOuts = bodySegs.map((s) => ({ s, out: converted(s) }));
  const emptySegs = new Set(bodyOuts.filter((x) => !x.out.trim().length).map((x) => x.s.seg));
  const composedEmpty = !composeBody(bodyOuts.map((x) => x.out)).trim().length;

  return (
    <section>
      {head}

      {carried || carriedPhotos ? (
        <p class="carry">
          前回の選択を引き継いでいます。
          {carriedPhotos ? (
            <>
              写真 <b>{carriedPhotos}</b> 枚は日記に出さないままです。
            </>
          ) : null}
        </p>
      ) : null}
      {resetNums.length ? (
        <p class="carry">
          <b>かけら {resetNums.join('・')}</b> は本文が直されたので、そのかけらだけ辞書どおりに戻しました。
        </p>
      ) : null}
      {resetTitle ? <p class="carry">タイトルの文字が変わったので、タイトルの選択は辞書どおりに戻しました。</p> : null}
      {!dict.length ? (
        <p class="warn-note">名前の辞書が空です。このまま書き出すと、名前は置き換わりません（日記タブの「名前の辞書」から足せます）。</p>
      ) : null}

      <div class="seg" role="tablist">
        {(
          [
            ['marks', '印つき'],
            ['plain', '公開される姿'],
            ['md', 'Markdown'],
          ] as [ViewMode, string][]
        ).map(([v, label]) => (
          <button
            type="button"
            key={v}
            role="tab"
            aria-selected={view === v}
            class={view === v ? 'on' : undefined}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'marks' ? (
        <div class="tally">
          <span class={counts.dict ? undefined : 't-zero'}>
            <span class="mk mk-dict nopress">辞書どおり</span>
            <b>{counts.dict}</b>
          </span>
          <span class={counts.edit ? undefined : 't-zero'}>
            <span class="mk mk-edit nopress">手で直した</span>
            <b>{counts.edit}</b>
          </span>
          <span class={'t-rej' + (counts.reject ? '' : ' t-zero')}>
            <span class="mk mk-reject nopress">実名のまま</span>
            <b>{counts.reject}</b>
          </span>
          <span class={counts.exc ? undefined : 't-zero'}>
            <span class="m-exc">例外</span>
            <b>{counts.exc}</b>
          </span>
          {photoCount.shown + photoCount.hidden ? (
            <span class="t-photo">
              写真 出す<b>{photoCount.shown}</b>
              <span class="t-slash">／</span>
              <span class="ph-tag">出さない</span>
              <b>{photoCount.hidden}</b>
            </span>
          ) : null}
        </div>
      ) : null}

      {view === 'md' ? (
        <>
          <p class="plain-note">
            astro-blog に書き出す中身です。リンク先・裸の URL・写真の URL は元のまま（写真の URL だけ、書き出すときに公開用へ差し替わります）。日記に出さない写真は入りません。
          </p>
          <pre class="conv-md">
            {renderDiaryFile(titleOut, detail.katachi.date, composeBody(bodySegs.map(converted)))}
          </pre>
        </>
      ) : view === 'plain' ? (
        <>
          <p class="plain-note">公開されたら、こう読めます（印なし）。</p>
          <p class="title-out">{titleOut || detail.katachi.date}</p>
          {bodySegs
            .map((s) => ({ s, out: converted(s) }))
            // 写真だけのかけらで写真を出さないと中身が空になる。書き出し（composeBody）と同じく飛ばす
            .filter((x) => x.out.trim().length > 0)
            .map(({ s, out }) => (
              <div class="conv-block" key={s.seg}>
                <hr class="conv-sep" />
                <RichText text={out} imgClass="assembled-photo" cards={detail.cards} />
              </div>
            ))}
        </>
      ) : (
        <>
          <div class="blk-label">タイトル</div>
          <p class="title-out">
            {title ? renderSpan(renderOf(titleSeg), 0, title.length) : <span class="title-empty">{detail.katachi.date}</span>}
          </p>
          <p class="title-note">タイトルは X にも投稿されます</p>
          {bodySegs.map((s) => (
            <div class="conv-block" key={s.seg}>
              <hr class="conv-sep" />
              <div class="blk-label">
                {segLabel(s)}
                {resetKakera.includes(s.seg) ? <span class="tag-reset">本文を直したので白紙</span> : null}
              </div>
              {emptySegs.has(s.seg) ? (
                <p class="seg-empty-note">このかけらは日記に出る内容がないので外れます</p>
              ) : null}
              <MarkedBody r={renderOf(s)} tokens={s.tokens} imgClass="assembled-photo" photo={photoToggleOf(s)} />
            </div>
          ))}
        </>
      )}

      {counts.reject ? <p class="warn-line">実名のまま出る箇所 {counts.reject}</p> : null}
      {composedEmpty ? (
        <p class="warn-line">日記に出す内容がありません。写真をすべて出さないにしたかけらは日記から外れます。</p>
      ) : null}
      <div class={counts.reject || composedEmpty ? 'export-wrap tight' : 'export-wrap'}>
        <button
          type="button"
          class="btn-cta"
          style="width:100%;"
          disabled={busy || !chosen.length || composedEmpty}
          onClick={() => (rejects.length ? setSheet({ type: 'confirm' }) : void publish(false))}
        >
          {busy ? '書き出しています' : '書き出す'}
        </button>
        <p class="form-note export-note">ここで選んだことは日記にだけ効きます。かけらの原本は実名のまま残ります。</p>
      </div>

      {sheet ? (
        <div class="sheet-layer">
          <div class="sheet-scrim" onClick={() => setSheet(null)} />
          <div class="sheet" role="dialog" aria-modal="true">
            <div class="grip" />
            {sheet.type === 'hit'
              ? (() => {
                  const s = segOf(sheet.seg);
                  const hit = s?.hits.find((h) => h.pos === sheet.pos && !h.exception);
                  if (!s || !hit) return <p class="empty-note">その箇所はもうありません</p>;
                  const st = statusOf(s.seg, hit);
                  const cur = effectiveChoice(hit, choiceOf(s.seg, hit));
                  const editing = sheet.editing || st === 'edit';
                  const decide = () => {
                    const w = cleanEditText(sheet.draft);
                    if (!w) {
                      say('言葉を入れてください');
                      return;
                    }
                    if (w === hit.target) {
                      say('辞書どおりと同じなので、承認にしました');
                      choose(s.seg, hit, 'approve');
                      return;
                    }
                    choose(s.seg, hit, 'edit', w);
                  };
                  return (
                    <>
                      <p class="sh-ctx">{segLabel(s)}</p>
                      <p class="sh-head">
                        {hit.source}
                        <span class="arr">→</span>
                        {shownWord(hit, choiceOf(s.seg, hit))}
                      </p>
                      <p class="sh-snip">
                        <Snippet text={s.text} pos={hit.pos} len={hit.source.length} bold />
                      </p>

                      <button
                        type="button"
                        class={'opt' + (st === 'dict' ? ' on' : '')}
                        onClick={() => choose(s.seg, hit, 'approve')}
                      >
                        <span class="opt-box">{st === 'dict' ? '✓' : ''}</span>
                        <span class="opt-main">承認</span>
                        <span class="opt-sub">
                          辞書どおり <q>{hit.target}</q>
                        </span>
                      </button>
                      <button
                        type="button"
                        class={'opt' + (st === 'edit' ? ' on' : '')}
                        onClick={() =>
                          setSheet({ ...sheet, editing: true, draft: sheet.draft || (cur.action === 'edit' ? cur.text ?? '' : '') })
                        }
                      >
                        <span class="opt-box">{st === 'edit' ? '✓' : ''}</span>
                        <span class="opt-main">手で直す</span>
                        <span class="opt-sub">
                          {st === 'edit' ? (
                            <>
                              <q>{cur.text}</q>（この箇所だけ）
                            </>
                          ) : (
                            'この箇所だけ別の言葉に'
                          )}
                        </span>
                      </button>
                      {editing ? (
                        <div class="opt-edit">
                          <input
                            ref={editRef}
                            type="text"
                            value={sheet.draft || (!sheet.editing && cur.action === 'edit' ? cur.text ?? '' : '')}
                            placeholder="この箇所だけの言葉"
                            enterKeyHint="done"
                            onInput={(e) => setSheet({ ...sheet, editing: true, draft: e.currentTarget.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                decide();
                              }
                            }}
                          />
                          <button type="button" class="btn-primary" onClick={decide}>
                            決める
                          </button>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        class={'opt opt-rej' + (st === 'reject' ? ' on' : '')}
                        onClick={() => choose(s.seg, hit, 'reject')}
                      >
                        <span class="opt-box">{st === 'reject' ? '✓' : ''}</span>
                        <span class="opt-main">拒否</span>
                        <span class="opt-sub">
                          実名のまま <q>{hit.source}</q> を出す
                        </span>
                      </button>
                      <p class="sh-foot">
                        どれを選んでも、かけらの原本は変わりません。
                        {s.seg === 'title' ? 'タイトルは X にも投稿されます。' : ''}
                      </p>
                      <div class="sh-actions">
                        <button type="button" class="btn-ghost" onClick={() => setSheet(null)}>
                          閉じる
                        </button>
                      </div>
                    </>
                  );
                })()
              : (
                  <>
                    <p class="sh-title">
                      実名のまま出る箇所が <em>{rejects.length}</em> つあります
                    </p>
                    <ul class="rej-list">
                      {rejects.map(({ s, hit }) => (
                        <li key={keyOf(s.seg, hit.pos)}>
                          <button
                            type="button"
                            onClick={() => {
                              setSheet(null);
                              setView('marks');
                              setFlash({ key: keyOf(s.seg, hit.pos), n: Date.now() });
                            }}
                          >
                            <span class="rej-name">{hit.source}</span>
                            <span class="rej-where">
                              {segLabel(s)}
                              <Snippet text={s.text} pos={hit.pos} len={hit.source.length} bold={false} />
                            </span>
                            <span class="rej-go">›</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p class="sh-foot sh-foot-plain">
                      このまま書き出すと、公開される日記に実名が出ます。
                      {rejects.some((x) => x.s.seg === 'title') ? (
                        <b class="sh-warn">タイトルに入っているので X にも出ます。</b>
                      ) : null}
                      行を押すとその箇所へ戻ります。
                    </p>
                    <div class="sh-actions">
                      <button type="button" class="btn-ghost" onClick={() => setSheet(null)}>
                        戻って見直す
                      </button>
                      <button
                        type="button"
                        class="btn-danger"
                        disabled={busy}
                        onClick={() => {
                          setSheet(null);
                          void publish(true);
                        }}
                      >
                        実名のまま書き出す
                      </button>
                    </div>
                  </>
                )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
