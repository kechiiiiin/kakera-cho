import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Kakera, KatachiDetail } from '../lib/kakera/types';
import type { LinkCards } from '../lib/card/types';
import type { DocView } from '../lib/names/doc-db';
import { composeBody } from '../lib/markdown';
import { renderDiaryFile } from '../lib/publish/diary-file';
import { composePublishBody } from '../lib/publish/blank-lines';
import { tokenizeForNames, type NameEntry, type NameToken } from '../lib/names/replace';
import {
  DESCRIPTION_SEG,
  TITLE_SEG,
  dictMap,
  normalizeChoice,
  resolveShape,
  type ChoiceAction,
  type LostChoice,
  type NameDocShape,
  type ResolvedSpan,
} from '../lib/names/doc';
import { assembleNikki, type Assembled } from '../lib/names/assemble';
import { hiddenKeysOf, hiddenPhotoSpans, overlapsAny, photoKeysIn, type PhotoChoice } from '../lib/publish/photo-choice';
import { api, type PublishNikkiInput, type RefChoiceInput } from './api';
import { timeOf } from './format';
import { RichText } from './RichText';
import { MarkedBody, renderSpan, type MarkRender, type PhotoToggle } from './NameMarks';

/**
 * 変換（公開名変換設計・記号方式）。
 *  組み上がった日記のタイトル・説明・本文を出し、名前の記号の箇所に印。開いた時点で全箇所が辞書どおり。
 *  印を押すと下からシート: 承認（辞書どおり）／手で直す（その箇所だけ）／拒否（実名のまま）。
 *  選択は記号ごとに D1 へ覚える（押すたびにその記号だけ保存）。拒否が残ったまま書き出すときは念押しを出す。
 *  原本・タイトル・説明を直しても白紙に戻らない。直した場所の名前だけ辞書どおりに戻り、どの名前かを知らせる。
 *  写真: 写真ごとに「日記に出す／出さない」。選択は写真の key に紐づけて D1 へ覚える。
 *  日記用に直す: かけらごとに、日記に出す文だけを書き換えられる（原本は触らない）。欄は置き換え済みの文で開き、
 *  保存すると差分で名前を記号に戻す（触らなかった名前の選択は残る）。原本が変わったら「原本が変わっています」。
 *
 * ⚠️ ここで作る本文は見せるためだけ。書き出すときはサーバが D1 の文書から解き直す（同じ assembleNikki を通す）。
 * ⚠️ 開いた後に中身が変わると、書き出し・日記用の保存はサーバが 409「内容が変わりました。開き直してください」で止める。
 */

interface Seg {
  /** 'title'・'description' か、かけらの id */
  seg: string;
  label: string;
  num: number;
  kakera: Kakera | null;
  /** 書き出しに使う文書（かけらは日記用の文書があればそれ） */
  doc: DocView | null;
  /** 日記用の文書（かけらだけ） */
  pub: DocView | null;
  shape: NameDocShape | null;
  /** 解いた文（打ち消しなし） */
  text: string;
  spans: ResolvedSpan[];
  tokens: NameToken[];
  /** 読めない・解けない */
  error: string | null;
}

type Sheet = { type: 'mark'; seg: string; id: string; editing: boolean; draft: string } | { type: 'confirm' };

type ViewMode = 'marks' | 'plain' | 'md';

function markKey(seg: string, id: string): string {
  return `${seg}:${id}`;
}

function Snippet({ text, start, end, bold }: { text: string; start: number; end: number; bold: boolean }): JSX.Element {
  const a = Math.max(0, start - 14);
  const b = Math.min(text.length, end + 14);
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const word = text.slice(start, end);
  return (
    <>
      {a > 0 ? '…' : ''}
      {flat(text.slice(a, start))}
      {bold ? <b>{word}</b> : word}
      {flat(text.slice(end, b))}
      {b < text.length ? '…' : ''}
    </>
  );
}

function shapeOfView(d: DocView | null): NameDocShape | null {
  return d && d.segments ? { segments: d.segments, refs: d.refs } : null;
}

function lostLine(l: LostChoice): string {
  const detail = l.action === 'edit' ? (l.text ?? '') : '実名のまま';
  return `${l.source}（${detail}）の選択が外れ、${l.now ? `辞書どおり${l.now}に戻りました` : '名前ではなくなりました'}`;
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
  const [description, setDescription] = useState('');
  const [dictRevAtOpen, setDictRevAtOpen] = useState('');
  const [docs, setDocs] = useState<DocView[]>([]);
  const [carried, setCarried] = useState(false);
  /** 日記に出さない写真（出す写真は持たない） */
  const [photos, setPhotos] = useState<PhotoChoice[]>([]);
  const [carriedPhotos, setCarriedPhotos] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('marks');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const editRef = useRef<HTMLInputElement>(null);
  /** 日記用に直した文に出てくる URL のカード（かたちの詳細に同梱されたカードに足して使う） */
  const [pbCards, setPbCards] = useState<LinkCards>({});
  /** 「日記用に直す」を開いているかけら（initial = 開いたときの文。保存でサーバに base として送る） */
  const [pbEdit, setPbEdit] = useState<{ seg: string; draft: string; initial: string } | null>(null);
  const [pbBusy, setPbBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 文書の同期は name-choice で走る。日記用の文の読み込みはその後に（同期を二重に走らせない）
      const r = await api.loadNameChoices(katachiId, { kakera_ids: order, title: titleInput });
      const [hiddenPhotos, pb] = await Promise.all([
        api.loadPhotoChoices(katachiId, { kakera_ids: order }),
        api.loadPublishBodies(katachiId),
      ]);
      if (!alive) return;
      setPbCards(pb.cards);
      setPhotos(hiddenPhotos);
      setCarriedPhotos(hiddenPhotos.length);
      setEntries(r.entries);
      setTitle(r.title);
      setDescription(r.description ?? '');
      setDictRevAtOpen(r.dict_rev);
      setDocs(r.docs);
      setCarried(r.docs.some((d) => d.refs.some((x) => x.action !== 'approve')));
    })().catch((e: unknown) => {
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
    if (sheet?.type === 'mark' && sheet.editing) editRef.current?.focus();
    // 「手で直す」を開いた瞬間だけ入力欄に寄せる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet?.type === 'mark' && sheet.editing]);

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
  const idx = dictMap(dict);

  const byId = new Map(detail.kakera.map((k) => [k.id, k]));
  const chosen = order.map((id) => byId.get(id)).filter((k): k is Kakera => !!k);
  const docOf = (seg: string, kind: DocView['kind']) => docs.find((d) => d.seg === seg && d.kind === kind) ?? null;

  const makeSeg = (seg: string, label: string, num: number, kakera: Kakera | null, doc: DocView | null, pub: DocView | null): Seg => {
    const shape = shapeOfView(doc);
    let error: string | null = null;
    let text = '';
    let spans: ResolvedSpan[] = [];
    if (!doc) error = '名前の記号がまだありません。開き直してください。';
    else if (!shape) error = doc.kind === 'publish' ? '日記用の文が読めません。原本に戻してください。' : '名前の記号が読めません。開き直してください。';
    else {
      try {
        const r = resolveShape(shape, idx);
        text = r.text;
        spans = r.spans;
      } catch (e) {
        error = `名前の記号が解けません（${e instanceof Error ? e.message : String(e)}）。開き直してください。`;
      }
    }
    return { seg, label, num, kakera, doc, pub, shape, text, spans, tokens: tokenizeForNames(text), error };
  };
  const titleSeg = makeSeg(TITLE_SEG, 'タイトル', 0, null, docOf(TITLE_SEG, 'title'), null);
  // 説明が空なら段を作らない（frontmatter にも書かない）
  const descSeg = description
    ? makeSeg(DESCRIPTION_SEG, '説明', 0, null, docOf(DESCRIPTION_SEG, 'description'), null)
    : null;
  const bodySegs = chosen.map((k, i) => {
    const pub = docOf(k.id, 'publish');
    return makeSeg(k.id, `かけら ${i + 1}`, i + 1, k, pub ?? docOf(k.id, 'kakera'), pub);
  });
  const segs = [titleSeg, ...(descSeg ? [descSeg] : []), ...bodySegs];
  const isHead = (seg: string) => seg === TITLE_SEG || seg === DESCRIPTION_SEG;
  const segOf = (seg: string) => segs.find((s) => s.seg === seg) ?? null;
  const cards: LinkCards = { ...(detail.cards ?? {}), ...pbCards };

  // 書き出しと同じ組み立て（サーバの nikki-export.ts と同じ assembleNikki）。止まる理由があればここでも見せる
  let assembled: Assembled | null = null;
  let assembleError: string | null = null;
  try {
    assembled = assembleNikki(
      {
        title: { seg: titleSeg.seg, label: titleSeg.label, shape: titleSeg.shape, expected: title, body: false },
        description: descSeg
          ? { seg: descSeg.seg, label: descSeg.label, shape: descSeg.shape, expected: description, body: false }
          : null,
        bodies: bodySegs.map((s) => ({
          seg: s.seg,
          label: s.label,
          shape: s.shape,
          ...(s.pub ? {} : { expected: s.kakera!.body }),
          body: true,
          hidden: hiddenKeysOf(photos, s.seg),
        })),
      },
      dict
    );
  } catch (e) {
    assembleError = e instanceof Error ? e.message : String(e);
  }

  // 出さない写真ぶん切り落とす範囲。そこに掛かる記号（代替文字の名前）は公開されないので数えない
  const dropsOf = (s: Seg) => (isHead(s.seg) ? [] : hiddenPhotoSpans(s.text, hiddenKeysOf(photos, s.seg), s.tokens));

  const photoCount = { shown: 0, hidden: 0 };
  for (const s of bodySegs) {
    const hidden = hiddenKeysOf(photos, s.seg);
    for (const key of photoKeysIn(s.text, s.tokens)) photoCount[hidden.has(key) ? 'hidden' : 'shown']++;
  }

  const counts = { dict: 0, edit: 0, reject: 0, exc: 0 };
  const rejects: { s: Seg; m: ResolvedSpan }[] = [];
  for (const s of segs) {
    const drops = dropsOf(s);
    for (const m of s.spans) {
      if (overlapsAny(m.start, m.end, drops)) continue;
      if (m.status === 'exception') counts.exc++;
      else counts[m.status]++;
      if (m.status === 'reject') rejects.push({ s, m });
    }
  }

  const lostNotes: { key: string; label: string; line: string }[] = [];
  for (const s of segs) {
    const views = s.kakera ? [docOf(s.seg, 'kakera'), s.pub] : [s.doc];
    for (const d of views) {
      if (!d) continue;
      d.lost_choices.forEach((l, i) =>
        lostNotes.push({
          key: `${d.doc_id}:${i}`,
          label: s.label + (d.kind === 'publish' ? '（日記用の文）' : s.pub && d.kind === 'kakera' ? '（原本）' : ''),
          line: lostLine(l),
        })
      );
    }
  }

  const sayError = (prefix: string) => (e: unknown) => say(prefix + (e instanceof Error ? e.message : String(e)));

  function persistPhotos(next: PhotoChoice[]): void {
    saveChain.current = saveChain.current
      .then(() => api.savePhotoChoices(katachiId, { kakera_ids: order, photos: next }))
      .then(() => undefined)
      .catch(sayError('写真の選択を保存できませんでした: '));
  }

  /** 画面の文書の記号一つを差し替える（その記号だけサーバへ保存する）。 */
  function choose(s: Seg, m: ResolvedSpan, action: ChoiceAction, text?: string): void {
    const ref = s.shape?.refs.find((r) => r.id === m.id);
    if (!ref) return;
    const next = normalizeChoice(ref, action, text, idx);
    if ('error' in next) {
      say(next.error);
      return;
    }
    if (action === 'edit' && next.action === 'approve') say('辞書どおりと同じなので、承認にしました');
    setDocs((list) =>
      list.map((d) =>
        d.refs.some((r) => r.id === m.id)
          ? { ...d, refs: d.refs.map((r) => (r.id === m.id ? { ...r, action: next.action, text: next.text } : r)) }
          : d
      )
    );
    const input: RefChoiceInput = { ref_id: m.id, action: next.action, ...(next.text ? { text: next.text } : {}) };
    saveChain.current = saveChain.current
      .then(() => api.saveNameChoice(katachiId, input))
      .then(() => undefined)
      .catch(sayError('選択を保存できませんでした: '));
    setSheet(null);
    setFlash({ key: markKey(s.seg, m.id), n: Date.now() });
  }

  function replaceDocs(seg: string, publish: DocView | null, kakera: DocView | null): void {
    setDocs((list) => [
      ...list.filter((d) => !(d.seg === seg && (d.kind === 'publish' || (kakera && d.kind === 'kakera')))),
      ...(kakera ? [kakera] : []),
      ...(publish ? [publish] : []),
    ]);
  }

  async function savePb(k: Kakera): Promise<void> {
    if (!pbEdit || pbEdit.seg !== k.id) return;
    if (!pbEdit.draft.trim()) {
      say('本文が空です。日記に出さないなら「組み直す」で外してください');
      return;
    }
    // 開いたときの文から何も変えていないなら、書き換えを作らない・既にある書き換えも変えない
    if (pbEdit.draft === pbEdit.initial) {
      setPbEdit(null);
      return;
    }
    const hadPub = !!docOf(k.id, 'publish');
    setPbBusy(true);
    try {
      await saveChain.current;
      const r = await api.savePublishBody(katachiId, k.id, { base: pbEdit.initial, text: pbEdit.draft });
      replaceDocs(k.id, r.publish, r.kakera);
      setPbCards((c) => ({ ...c, ...r.cards }));
      setPbEdit(null);
      if (!r.publish) say(hadPub ? '原本と同じ文になったので、原本のまま出します' : '原本と同じ文なので、原本のまま出します');
    } catch (e) {
      sayError('日記用の文を保存できませんでした: ')(e);
    } finally {
      setPbBusy(false);
    }
  }

  async function acceptPb(k: Kakera): Promise<void> {
    setPbBusy(true);
    try {
      const row = await api.acceptPublishBody(katachiId, k.id);
      setDocs((list) =>
        list.map((d) => (d.seg === k.id && d.kind === 'publish' ? { ...d, basis: row.basis, stale: row.stale } : d))
      );
    } catch (e) {
      sayError('選べませんでした: ')(e);
    } finally {
      setPbBusy(false);
    }
  }

  async function discardPb(k: Kakera): Promise<void> {
    if (!confirm('日記用に直した文を捨てて、原本に戻します。よろしいですか？')) return;
    setPbBusy(true);
    try {
      await saveChain.current;
      await api.deletePublishBody(katachiId, k.id);
      replaceDocs(k.id, null, null);
      setPbEdit(null);
    } catch (e) {
      sayError('原本に戻せませんでした: ')(e);
    } finally {
      setPbBusy(false);
    }
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

  const renderOf = (s: Seg): MarkRender => ({
    text: s.text,
    marks: s.spans,
    keyOf: (m) => markKey(s.seg, m.id),
    onPress: (m) => setSheet({ type: 'mark', seg: s.seg, id: m.id, editing: false, draft: '' }),
  });

  const segLabel = (s: Seg) => s.label + (s.kakera ? `・${timeOf(s.kakera.written_at)}` : '');

  async function publish(confirmRealNames: boolean): Promise<void> {
    const used = segs.map((s) => s.doc).filter((d): d is DocView => !!d);
    const choices: RefChoiceInput[] = used.flatMap((d) =>
      d.refs.map((r) => {
        const e = idx.get(r.source);
        // 例外は選べない（辞書が例外に変わった後の古い選択は承認として送る）
        if (e && e.target === e.source) return { ref_id: r.id, action: 'approve' as const };
        return { ref_id: r.id, action: r.action, ...(r.action === 'edit' && r.text ? { text: r.text } : {}) };
      })
    );
    setBusy(true);
    try {
      await saveChain.current;
      await onPublish({
        kakera_ids: order,
        title: titleInput,
        choices,
        photos,
        confirm_real_names: confirmRealNames,
        doc_revs: used.map((d) => ({ doc_id: d.doc_id, rev: d.rev })),
        dict_rev: dictRevAtOpen,
      });
    } finally {
      setBusy(false);
    }
  }

  const titleOut = assembled?.title.text ?? '';
  const descOut = assembled?.description?.text ?? '';
  const staleNums = bodySegs.filter((s) => s.pub?.stale).map((s) => s.num);
  const segErrors = segs.filter((s) => s.error);
  // 空になるかけら（写真をすべて出さないにした等）と、全体が空かどうか
  const emptySegs = new Set((assembled?.bodies ?? []).filter((b) => !b.text.trim().length).map((b) => b.seg));
  const composedEmpty = !!assembled && !composeBody(assembled.bodies.map((b) => b.text)).trim().length;
  const cannotExport = !!assembleError || segErrors.length > 0;

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
      {lostNotes.map((n) => (
        <p class="carry" key={n.key}>
          <b>{n.label}</b> {n.line}
        </p>
      ))}
      {staleNums.length ? (
        <p class="carry">
          <b>かけら {staleNums.join('・')}</b> は日記用に直したあとで原本が変わっています。選ぶまでは直した文で出ます。
        </p>
      ) : null}
      {!dict.length ? (
        <p class="warn-note">名前の辞書が空です。このまま書き出すと、名前は置き換わりません（日記タブの「名前の辞書」から足せます）。</p>
      ) : null}
      {assembleError && !segErrors.length ? <p class="warn-note">{assembleError}</p> : null}

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
          {assembled ? (
            <pre class="conv-md">
              {renderDiaryFile(
                titleOut,
                detail.katachi.date,
                // 書き出し（astro-blog.ts）と同じ組み方（空行を U+00A0 の行に変える）
                composePublishBody(
                  assembled.bodies.map((b) => b.text),
                  (key) => !!cards[key]
                ),
                descOut
              )}
            </pre>
          ) : (
            <p class="warn-note">{assembleError ?? segErrors[0]?.error}</p>
          )}
        </>
      ) : view === 'plain' ? (
        <>
          <p class="plain-note">公開されたら、こう読めます（印なし）。</p>
          {assembled ? (
            <>
              <p class="title-out">{titleOut || detail.katachi.date}</p>
              {descOut ? <p class="desc-out">{descOut}</p> : null}
              {assembled.bodies
                // 写真だけのかけらで写真を出さないと中身が空になる。書き出し（composeBody）と同じく飛ばす
                .filter((b) => b.text.trim().length > 0)
                .map((b) => (
                  <div class="conv-block" key={b.seg}>
                    <hr class="conv-sep" />
                    <RichText text={b.text} imgClass="assembled-photo" cards={cards} />
                  </div>
                ))}
            </>
          ) : (
            <p class="warn-note">{assembleError ?? segErrors[0]?.error}</p>
          )}
        </>
      ) : (
        <>
          <div class="blk-label">タイトル</div>
          {titleSeg.error ? <p class="warn-note">{titleSeg.error}</p> : null}
          <p class="title-out">
            {titleSeg.text ? (
              renderSpan(renderOf(titleSeg), 0, titleSeg.text.length)
            ) : (
              <span class="title-empty">{detail.katachi.date}</span>
            )}
          </p>
          <div class="blk-label" style="margin-top:14px;">
            説明
          </div>
          {descSeg ? (
            <>
              {descSeg.error ? <p class="warn-note">{descSeg.error}</p> : null}
              <p class="desc-out" style="margin-top:0;">
                {renderSpan(renderOf(descSeg), 0, descSeg.text.length)}
              </p>
            </>
          ) : (
            <p class="desc-out desc-empty" style="margin-top:0;">
              なし（ブログの紹介文が出ます）
            </p>
          )}
          {bodySegs.map((s) => {
            const k = s.kakera!;
            const pb = s.pub;
            const editing = pbEdit?.seg === s.seg ? pbEdit : null;
            return (
              <div class="conv-block" key={s.seg}>
                <hr class="conv-sep" />
                <div class="blk-label">
                  {segLabel(s)}
                  {pb ? <span class="tag-pb">日記用に直しています</span> : null}
                </div>
                {s.error ? (
                  <div class="pb-stale">
                    <p class="pb-stale-head">{s.error}</p>
                    {pb ? (
                      <div class="pb-actions">
                        <button type="button" class="btn-danger" disabled={pbBusy} onClick={() => void discardPb(k)}>
                          原本に戻す
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {pb?.stale && !editing && !s.error ? (
                  <div class="pb-stale">
                    <p class="pb-stale-head">原本が変わっています</p>
                    <p class="pb-stale-sub">日記用に直したあとで、かけらの原本が直されました。選ぶまでは直した文で出ます。</p>
                    <details class="pb-orig">
                      <summary>今の原本を見る</summary>
                      <p class="pb-orig-text">{k.body}</p>
                    </details>
                    <div class="pb-actions">
                      <button type="button" class="btn-ghost" disabled={pbBusy} onClick={() => void acceptPb(k)}>
                        書き換えを使う
                      </button>
                      <button type="button" class="btn-danger" disabled={pbBusy} onClick={() => void discardPb(k)}>
                        原本に戻す
                      </button>
                    </div>
                  </div>
                ) : null}
                {editing ? (
                  <div class="pb-edit">
                    <textarea
                      aria-label={`${segLabel(s)} の日記用の文`}
                      value={editing.draft}
                      rows={Math.min(16, Math.max(5, editing.draft.split('\n').length + 1))}
                      onInput={(e) => setPbEdit({ ...editing, draft: e.currentTarget.value })}
                    />
                    <p class="pb-note">
                      日記にだけ効きます。かけらの原本は変わりません。触らなかった名前の選択は残ります。新しく打った名前は、保存すると印で置き換わります。
                    </p>
                    <div class="pb-actions">
                      <button type="button" class="btn-primary" disabled={pbBusy} onClick={() => void savePb(k)}>
                        {pbBusy ? '保存しています' : '保存'}
                      </button>
                      <button
                        type="button"
                        class="btn-ghost"
                        disabled={pbBusy}
                        onClick={() => {
                          if (editing.draft !== editing.initial && !confirm('直した文はまだ保存していません。取り消しますか？')) return;
                          setPbEdit(null);
                        }}
                      >
                        取消
                      </button>
                      {pb ? (
                        <button type="button" class="btn-danger" disabled={pbBusy} onClick={() => void discardPb(k)}>
                          原本に戻す
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : !s.error ? (
                  <>
                    {emptySegs.has(s.seg) ? (
                      <p class="seg-empty-note">このかけらは日記に出る内容がないので外れます</p>
                    ) : null}
                    <MarkedBody r={renderOf(s)} tokens={s.tokens} imgClass="assembled-photo" photo={photoToggleOf(s)} />
                    <div class="pb-open-row">
                      <button
                        type="button"
                        class="pb-open"
                        disabled={pbBusy || !!pbEdit}
                        onClick={() => {
                          // 開くときは置き換え済みの文で見せる: 名前はいまの選択どおり（拒否は実名）、写真の記法は残す。
                          // composePublishBody の空行の U+00A0 化・写真 URL の差し替え等、書き出し専用の変換は入れない。
                          setPbEdit({ seg: s.seg, draft: s.text, initial: s.text });
                        }}
                      >
                        {pb ? '日記用の文を直す' : '日記用に直す'}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
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
          disabled={busy || !chosen.length || composedEmpty || cannotExport || !!pbEdit || pbBusy}
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
            {sheet.type === 'mark'
              ? (() => {
                  const s = segOf(sheet.seg);
                  const m = s?.spans.find((x) => x.id === sheet.id && x.status !== 'exception');
                  const ref = s?.shape?.refs.find((x) => x.id === sheet.id);
                  if (!s || !m || !ref) return <p class="empty-note">その箇所はもうありません</p>;
                  const st = m.status;
                  const editing = sheet.editing || st === 'edit';
                  const draftValue = sheet.editing ? sheet.draft : st === 'edit' ? (ref.text ?? '') : '';
                  const decide = () => choose(s, m, 'edit', draftValue);
                  return (
                    <>
                      <p class="sh-ctx">{segLabel(s)}</p>
                      <p class="sh-head">
                        {m.source}
                        <span class="arr">→</span>
                        {m.word}
                      </p>
                      <p class="sh-snip">
                        <Snippet text={s.text} start={m.start} end={m.end} bold />
                      </p>

                      <button
                        type="button"
                        class={'opt' + (st === 'dict' ? ' on' : '')}
                        disabled={!m.target}
                        onClick={() => choose(s, m, 'approve')}
                      >
                        <span class="opt-box">{st === 'dict' ? '✓' : ''}</span>
                        <span class="opt-main">承認</span>
                        <span class="opt-sub">{m.target ? <>辞書どおり <q>{m.target}</q></> : '辞書にない名前です'}</span>
                      </button>
                      <button
                        type="button"
                        class={'opt' + (st === 'edit' ? ' on' : '')}
                        onClick={() => setSheet({ ...sheet, editing: true, draft: draftValue })}
                      >
                        <span class="opt-box">{st === 'edit' ? '✓' : ''}</span>
                        <span class="opt-main">手で直す</span>
                        <span class="opt-sub">
                          {st === 'edit' ? (
                            <>
                              <q>{ref.text}</q>（この箇所だけ）
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
                            value={draftValue}
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
                        onClick={() => choose(s, m, 'reject')}
                      >
                        <span class="opt-box">{st === 'reject' ? '✓' : ''}</span>
                        <span class="opt-main">拒否</span>
                        <span class="opt-sub">
                          実名のまま <q>{m.source}</q> を出す
                        </span>
                      </button>
                      <p class="sh-foot">
                        どれを選んでも、かけらの原本は変わりません。
                        {s.seg === TITLE_SEG ? 'タイトルは X にも投稿されます。' : ''}
                        {s.seg === DESCRIPTION_SEG ? '説明は X のカードにも出ます。' : ''}
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
                      {rejects.map(({ s, m }) => (
                        <li key={markKey(s.seg, m.id)}>
                          <button
                            type="button"
                            onClick={() => {
                              setSheet(null);
                              setView('marks');
                              setFlash({ key: markKey(s.seg, m.id), n: Date.now() });
                            }}
                          >
                            <span class="rej-name">{m.source}</span>
                            <span class="rej-where">
                              {segLabel(s)}
                              <Snippet text={s.text} start={m.start} end={m.end} bold={false} />
                            </span>
                            <span class="rej-go">›</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <p class="sh-foot sh-foot-plain">
                      このまま書き出すと、公開される日記に実名が出ます。
                      {rejects.some((x) => x.s.seg === TITLE_SEG) ? (
                        <b class="sh-warn">タイトルに入っているので X にも出ます。</b>
                      ) : null}
                      {rejects.some((x) => x.s.seg === DESCRIPTION_SEG) ? (
                        <b class="sh-warn">説明に入っているので X のカードにも出ます。</b>
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
