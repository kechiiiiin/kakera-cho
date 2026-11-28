// iPhone 版（ios/・SwiftUI）の変換ページに渡す「画面に出すもの」を組む純関数（かけら帳ネイティブ化設計）。
//
// Web 版の ConvertScreen.tsx が描くたびに画面の中で組んでいるもの（解いた文・印・切れ・組み上げた日記・
// Markdown・集計・知らせ・書き出しに送る選択）を、同じ関数（resolveShape・stripResolvedWikilinks・
// tokenizeForNames・assembleNikki・composePublishBody …）でサーバが組んで返す。
// 名前の決まりを Swift に写さない（写しを二か所目に増やさない）ため。
//
// ⚠️ ConvertScreen.tsx の組み方を直したら、ここも同じように直すこと（Web 版の画面はこれを使っていない）。
// ⚠️ 状態は持たない・D1 も読まない。画面が持っている状態（辞書・文書・写真の選択）をそのまま受け取って組むだけ。
//    選択の保存は今までどおり name-choice・photo-choice・publish-body の口で行う。

import type { LinkCards } from '../card/types';
import { composeBody, isSafeHref, stripWikilinks } from '../markdown';
import { renderDiaryFile } from '../publish/diary-file';
import { composePublishBody } from '../publish/blank-lines';
import { tokenizeForNames, type NameEntry, type NameToken, type Span } from '../names/replace';
import {
  DESCRIPTION_SEG,
  TITLE_SEG,
  dictMap,
  resolveShape,
  type LostChoice,
  type NameDocShape,
  type ResolvedSpan,
} from '../names/doc';
import { assembleNikki, stripResolvedWikilinks, type Assembled } from '../names/assemble';
import type { DocView } from '../names/doc-db';
import { hiddenKeysOf, hiddenPhotoSpans, overlapsAny, photoKeysIn, type PhotoChoice } from '../publish/photo-choice';
import { isFacePhotoKey } from '../publish/photo-face';
import { keyFromPhotoUrl } from '../publish/photos';
import { timeHeadOf, type KakeraTimeHead } from '../kakera/time-label';

export interface ConvertKakera {
  id: string;
  body: string;
  written_at: string;
  show_time?: boolean;
}

export interface ConvertViewInput {
  /** かたちの日付（'YYYY-MM-DD'） */
  katachi_date: string;
  /** かたちの中のかけら（KatachiDetail.kakera） */
  kakera: ConvertKakera[];
  /** 日記に出すかけらの並び */
  order: string[];
  /** name-choice が返した、日記に使うタイトル */
  title: string;
  /** name-choice が返した説明（空なら段を作らない） */
  description: string;
  entries: NameEntry[];
  docs: DocView[];
  /** 日記に出さない写真 */
  photos: PhotoChoice[];
  /** かたちの詳細のカードと、日記用の文のカードを合わせたもの */
  cards: LinkCards;
}

/** 画面で描く切れ。画像には写真の key（かけら帳の写真のときだけ）と、src に入れてよいかを添える。 */
export type ViewToken =
  | { kind: 'text' | 'url' | 'raw'; start: number; end: number }
  | { kind: 'link'; start: number; end: number; label: ViewToken[]; href: string; title: Span | null }
  | {
      kind: 'image';
      start: number;
      end: number;
      alt: ViewToken[];
      url: string;
      title: Span | null;
      photo_key: string | null;
      src_ok: boolean;
    };

export interface ConvertSeg {
  /** 'title'・'description' か、かけらの id */
  seg: string;
  label: string;
  num: number;
  kakera_id: string | null;
  /** 段の見出しに添える時刻（かけらだけ・'HH:MM'） */
  time: string | null;
  /** 日記用の文書があるか（かけらだけ） */
  has_pub: boolean;
  /** 日記用に直した後で原本が変わったか */
  stale: boolean;
  /** 解いた文（括弧を外した・画面に見せる文）。位置は UTF-16 の単位 */
  text: string;
  /** 解いたままの文（括弧つき）。「日記用に直す」の保存で base として送る */
  raw_text: string;
  spans: ResolvedSpan[];
  tokens: ViewToken[];
  error: string | null;
  /** この段の写真の key（本文の順・重複あり） */
  photo_keys: string[];
  /** 組み上げると中身が空になる（写真を全部出さない等） */
  empty: boolean;
  /** 時刻の小見出し（出さないなら null） */
  time_head: KakeraTimeHead | null;
  /** 原本が変わった日記用の文のときだけ、今の原本（括弧を外した文） */
  original: string | null;
}

export interface ConvertView {
  segs: ConvertSeg[];
  assembled: {
    title: string;
    description: string;
    bodies: { seg: string; text: string; time_head: KakeraTimeHead | null }[];
  } | null;
  /** 組み上げで止まった理由（段の読めなさは各段の error） */
  assemble_error: string | null;
  /** astro-blog に書き出す中身（組めなければ null） */
  markdown: string | null;
  counts: { dict: number; edit: number; reject: number; exc: number };
  photo_count: { shown: number; hidden: number };
  /** 日記に出す、顔の枠を持てる写真 */
  want_faces: string[];
  /** 書き出す文に残る「拒否」（集計と同じ数え方） */
  rejects: { seg: string; id: string }[];
  lost_notes: { key: string; label: string; line: string }[];
  stale_nums: number[];
  composed_empty: boolean;
  cannot_export: boolean;
  dict_empty: boolean;
  /** 書き出しに送る選択（ConvertScreen の publish と同じ組み方） */
  choices: { ref_id: string; action: 'approve' | 'edit' | 'reject'; text?: string }[];
  doc_revs: { doc_id: string; rev: string }[];
}

function shapeOfView(d: DocView | null): NameDocShape | null {
  return d && d.segments ? { segments: d.segments, refs: d.refs } : null;
}

function lostLine(l: LostChoice): string {
  const detail = l.action === 'edit' ? (l.text ?? '') : '実名のまま';
  return `${l.source}（${detail}）の選択が外れ、${l.now ? `辞書どおり${l.now}に戻りました` : '名前ではなくなりました'}`;
}

function viewTokens(tokens: NameToken[]): ViewToken[] {
  return tokens.map((t): ViewToken => {
    if (t.kind === 'link') return { ...t, label: viewTokens(t.label) };
    if (t.kind === 'image') {
      return {
        ...t,
        alt: viewTokens(t.alt),
        photo_key: keyFromPhotoUrl(t.url.trim()),
        src_ok: t.url.startsWith('/api/photo/') || isSafeHref(t.url),
      };
    }
    return { kind: t.kind, start: t.start, end: t.end };
  });
}

/** 'HH:MM'（format.ts の timeOf と同じ切り方） */
const timeOf = (iso: string): string => iso.slice(11, 16);

export function convertView(input: ConvertViewInput): ConvertView {
  const { entries: dict, docs, photos, cards } = input;
  const idx = dictMap(dict);
  const byId = new Map(input.kakera.map((k) => [k.id, k]));
  const chosen = input.order.map((id) => byId.get(id)).filter((k): k is ConvertKakera => !!k);
  const docOf = (seg: string, kind: DocView['kind']) => docs.find((d) => d.seg === seg && d.kind === kind) ?? null;

  interface Seg {
    seg: string;
    label: string;
    num: number;
    kakera: ConvertKakera | null;
    doc: DocView | null;
    pub: DocView | null;
    shape: NameDocShape | null;
    text: string;
    rawText: string;
    spans: ResolvedSpan[];
    tokens: NameToken[];
    error: string | null;
  }

  const makeSeg = (
    seg: string,
    label: string,
    num: number,
    kakera: ConvertKakera | null,
    doc: DocView | null,
    pub: DocView | null
  ): Seg => {
    const shape = shapeOfView(doc);
    let error: string | null = null;
    let text = '';
    let rawText = '';
    let spans: ResolvedSpan[] = [];
    if (!doc) error = '名前の記号がまだありません。開き直してください。';
    else if (!shape) error = doc.kind === 'publish' ? '日記用の文が読めません。原本に戻してください。' : '名前の記号が読めません。開き直してください。';
    else {
      try {
        const r = resolveShape(shape, idx);
        rawText = r.text;
        const shown = stripResolvedWikilinks(r.text, r.spans, !kakera);
        text = shown.text;
        spans = shown.spans;
      } catch (e) {
        error = `名前の記号が解けません（${e instanceof Error ? e.message : String(e)}）。開き直してください。`;
      }
    }
    return { seg, label, num, kakera, doc, pub, shape, text, rawText, spans, tokens: tokenizeForNames(text), error };
  };

  const titleSeg = makeSeg(TITLE_SEG, 'タイトル', 0, null, docOf(TITLE_SEG, 'title'), null);
  const descSeg = input.description
    ? makeSeg(DESCRIPTION_SEG, '説明', 0, null, docOf(DESCRIPTION_SEG, 'description'), null)
    : null;
  const bodySegs = chosen.map((k, i) => {
    const pub = docOf(k.id, 'publish');
    return makeSeg(k.id, `かけら ${i + 1}`, i + 1, k, pub ?? docOf(k.id, 'kakera'), pub);
  });
  const segs = [titleSeg, ...(descSeg ? [descSeg] : []), ...bodySegs];
  const isHead = (seg: string) => seg === TITLE_SEG || seg === DESCRIPTION_SEG;
  const timeHeadOfSeg = (seg: string): KakeraTimeHead | null => {
    const k = byId.get(seg);
    return k ? timeHeadOf(k, input.katachi_date) : null;
  };

  let assembled: Assembled | null = null;
  let assembleError: string | null = null;
  try {
    assembled = assembleNikki(
      {
        title: { seg: titleSeg.seg, label: titleSeg.label, shape: titleSeg.shape, expected: input.title, body: false },
        description: descSeg
          ? { seg: descSeg.seg, label: descSeg.label, shape: descSeg.shape, expected: input.description, body: false }
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

  const dropsOf = (s: Seg) => (isHead(s.seg) ? [] : hiddenPhotoSpans(s.text, hiddenKeysOf(photos, s.seg), s.tokens));

  const photoCount = { shown: 0, hidden: 0 };
  const wantFaces = new Set<string>();
  for (const s of bodySegs) {
    const hidden = hiddenKeysOf(photos, s.seg);
    for (const key of photoKeysIn(s.text, s.tokens)) {
      photoCount[hidden.has(key) ? 'hidden' : 'shown']++;
      if (!hidden.has(key) && isFacePhotoKey(key)) wantFaces.add(key);
    }
  }

  const counts = { dict: 0, edit: 0, reject: 0, exc: 0 };
  const rejects: { seg: string; id: string }[] = [];
  for (const s of segs) {
    const drops = dropsOf(s);
    for (const m of s.spans) {
      if (overlapsAny(m.start, m.end, drops)) continue;
      if (m.status === 'exception') counts.exc++;
      else counts[m.status]++;
      if (m.status === 'reject') rejects.push({ seg: s.seg, id: m.id });
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

  const used = segs.map((s) => s.doc).filter((d): d is DocView => !!d);
  const choices = used.flatMap((d) =>
    d.refs.map((r) => {
      const e = idx.get(r.source);
      if (e && e.target === e.source) return { ref_id: r.id, action: 'approve' as const };
      return { ref_id: r.id, action: r.action, ...(r.action === 'edit' && r.text ? { text: r.text } : {}) };
    })
  );

  const emptySegs = new Set((assembled?.bodies ?? []).filter((b) => !b.text.trim().length).map((b) => b.seg));
  const composedEmpty = !!assembled && !composeBody(assembled.bodies.map((b) => b.text)).trim().length;
  const segErrors = segs.filter((s) => s.error);

  const markdown = assembled
    ? renderDiaryFile(
        assembled.title.text,
        input.katachi_date,
        composePublishBody(
          assembled.bodies.map((b) => b.text),
          (key) => !!cards[key],
          assembled.bodies.map((b) => timeHeadOfSeg(b.seg))
        ),
        assembled.description?.text ?? ''
      )
    : null;

  return {
    segs: segs.map((s) => ({
      seg: s.seg,
      label: s.label,
      num: s.num,
      kakera_id: s.kakera?.id ?? null,
      time: s.kakera ? timeOf(s.kakera.written_at) : null,
      has_pub: !!s.pub,
      stale: !!s.pub?.stale,
      text: s.text,
      raw_text: s.rawText,
      spans: s.spans,
      tokens: viewTokens(s.tokens),
      error: s.error,
      photo_keys: isHead(s.seg) ? [] : photoKeysIn(s.text, s.tokens),
      empty: emptySegs.has(s.seg),
      time_head: s.kakera ? timeHeadOfSeg(s.seg) : null,
      original: s.kakera && s.pub?.stale ? stripWikilinks(s.kakera.body) : null,
    })),
    assembled: assembled
      ? {
          title: assembled.title.text,
          description: assembled.description?.text ?? '',
          bodies: assembled.bodies.map((b) => ({ seg: b.seg, text: b.text, time_head: timeHeadOfSeg(b.seg) })),
        }
      : null,
    assemble_error: assembleError,
    markdown,
    counts,
    photo_count: photoCount,
    want_faces: [...wantFaces],
    rejects,
    lost_notes: lostNotes,
    stale_nums: bodySegs.filter((s) => s.pub?.stale).map((s) => s.num),
    composed_empty: composedEmpty,
    cannot_export: !!assembleError || segErrors.length > 0,
    dict_empty: !dict.length,
    choices,
    doc_revs: used.map((d) => ({ doc_id: d.doc_id, rev: d.rev })),
  };
}
