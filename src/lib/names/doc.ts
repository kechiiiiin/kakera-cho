// 名前の場所を記号で持つ文（公開名変換設計・記号方式）。純関数だけ（画面とサーバの両方から使う）。
//
// 文書 = 「普通の文字の部分」と「名前の部分（記号＝name_ref の id だけ）」の並び。
//  - 記号に実名を入れない。置き換え元（実名）と選択は記号の行（NameRef）が持つ
//  - 実名の文（原本の本文・タイトル・説明）は普通の文のまま保存し、文書はその影。
//    「実名で解いた文 ＝ 今の文」でなければ差分で名前の範囲を追って作り直す（syncRealShape）
//  - 日記用に直した文（publish）は文書そのものが正。欄は置き換え済みの文で開き、保存時の差分で記号に戻す（applyPublishEdit）
//  - 追跡に失敗したら必ず辞書どおり（置き換える側）に倒れる。実名が出る側には倒れない

import { z } from 'zod';
import { diffEdits, mapEnd, mapPos, mapStart, touched, type Edit } from './diff';
import {
  findHits,
  replaceableSpans,
  sortDictionary,
  tokenizeForNames,
  type NameEntry,
  type NameHit,
  type Span,
} from './replace';

export type ChoiceAction = 'approve' | 'edit' | 'reject';
export type DocKind = 'kakera' | 'title' | 'description' | 'publish';

/** 画面の段の名前（かけらはかけらの id）。ULID の大文字英数字とは衝突しない。 */
export const TITLE_SEG = 'title';
export const DESCRIPTION_SEG = 'description';

export type Segment = { t: string } | { r: string };

export interface NameRef {
  id: string;
  /** 置き換え元（その場所に書かれていた実名＝辞書の語） */
  source: string;
  action: ChoiceAction;
  /** action が edit のときの言葉（それ以外は null） */
  text: string | null;
}

/** 文書の形。refs はセグメントに出てくる順。 */
export interface NameDocShape {
  segments: Segment[];
  refs: NameRef[];
}

/** 直した場所にあって外れた選択（手で直した・拒否だけ。§12 の 22）。 */
export interface LostChoice {
  source: string;
  action: 'edit' | 'reject';
  text: string | null;
  /** その場所が今どう出るか（辞書どおりの言葉）。名前でなくなったなら null */
  now: string | null;
}

/** 記号が解けない・形が崩れている（書き出しは 409 で止める）。 */
export class NameDocError extends Error {}

/* ---------------- JSON ---------------- */

export const SEGMENTS_VERSION = 1;

const segmentsSchema = z
  .object({
    v: z.literal(SEGMENTS_VERSION),
    s: z.array(
      z.union([z.object({ t: z.string().min(1) }).strict(), z.object({ r: z.string().min(1).max(64) }).strict()])
    ),
  })
  .strict();

export function isRefSeg(s: Segment): s is { r: string } {
  return 'r' in s;
}

/** 保存してある segments を読む。形が崩れていれば null。 */
export function parseSegments(json: string): Segment[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const r = segmentsSchema.safeParse(data);
  return r.success ? (r.data.s as Segment[]) : null;
}

/** 空の文字を落とし、隣り合う文字をつなぐ。 */
export function normalizeSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    if (isRefSeg(s)) {
      out.push({ r: s.r });
      continue;
    }
    if (!s.t) continue;
    const last = out[out.length - 1];
    if (last && !isRefSeg(last)) last.t += s.t;
    else out.push({ t: s.t });
  }
  return out;
}

export function serializeSegments(segments: Segment[]): string {
  return JSON.stringify({ v: SEGMENTS_VERSION, s: normalizeSegments(segments) });
}

/**
 * セグメントと記号の行を突き合わせて文書の形にする。
 * 記号の行が無い（別の文書の行を含む）・同じ記号が二度出る → null（崩れている）。
 */
export function shapeFrom(segments: Segment[] | null, refRows: NameRef[]): NameDocShape | null {
  if (!segments) return null;
  const byId = new Map(refRows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const refs: NameRef[] = [];
  for (const s of segments) {
    if (!isRefSeg(s)) continue;
    const ref = byId.get(s.r);
    if (!ref || seen.has(s.r)) return null;
    seen.add(s.r);
    refs.push(ref);
  }
  return { segments, refs };
}

/** 形の中で崩れているところ（無ければ null）。 */
export function shapeProblem(shape: NameDocShape): string | null {
  const byId = new Map(shape.refs.map((r) => [r.id, r]));
  const seen = new Set<string>();
  for (const s of shape.segments) {
    if (!isRefSeg(s)) {
      if (typeof s.t !== 'string' || !s.t) return '文字の部分が空です';
      continue;
    }
    if (!byId.has(s.r)) return '記号の行がありません';
    if (seen.has(s.r)) return '同じ記号が二度出ています';
    seen.add(s.r);
  }
  return null;
}

/* ---------------- 実名で解く・今の辞書で解く ---------------- */

/** 実名で解いた文と、記号ごとの範囲。 */
export function realTextOf(shape: NameDocShape): { text: string; ranges: Map<string, Span> } {
  const byId = new Map(shape.refs.map((r) => [r.id, r]));
  const ranges = new Map<string, Span>();
  let text = '';
  for (const s of shape.segments) {
    if (!isRefSeg(s)) {
      text += s.t;
      continue;
    }
    const ref = byId.get(s.r);
    if (!ref) throw new NameDocError('記号の行がありません');
    ranges.set(ref.id, { start: text.length, end: text.length + ref.source.length });
    text += ref.source;
  }
  return { text, ranges };
}

export type SpanStatus = 'dict' | 'edit' | 'reject' | 'exception';

/** 解いた文の中の記号の出力範囲。 */
export interface ResolvedSpan {
  id: string;
  start: number;
  end: number;
  source: string;
  status: SpanStatus;
  /** 出した言葉（escape したときは escape 後） */
  word: string;
  /** 辞書どおりの言葉（例外・辞書に無いなら null） */
  target: string | null;
}

/** 公開する Markdown で、置き換えた言葉が記法を壊さないように打ち消す（§12 の 21）。 */
export function escapeMarkdownWord(s: string): string {
  return s.replace(/[\\`*_~[\]()!#<>&|]/g, (c) => '\\' + c);
}

export function dictMap(dict: NameEntry[]): Map<string, NameEntry> {
  return new Map(sortDictionary(dict).map((d) => [d.source, d]));
}

/**
 * 記号を解く。例外は置き換え元／approve は辞書の置き換え先／edit は言葉／reject は置き換え元。
 * @param escape 本文を公開する Markdown にするとき true（置き換え先・手で直した言葉を打ち消す）
 * 解けなければ NameDocError（approve の置き換え元が辞書に無い・edit の言葉が空・記号の行が無い）。
 */
export function resolveShape(
  shape: NameDocShape,
  dict: NameEntry[] | Map<string, NameEntry>,
  opts: { escape?: boolean } = {}
): { text: string; spans: ResolvedSpan[] } {
  const byId = new Map(shape.refs.map((r) => [r.id, r]));
  const idx = dict instanceof Map ? dict : dictMap(dict);
  const esc = opts.escape ? escapeMarkdownWord : (s: string) => s;
  const spans: ResolvedSpan[] = [];
  let text = '';
  for (const s of shape.segments) {
    if (!isRefSeg(s)) {
      text += s.t;
      continue;
    }
    const ref = byId.get(s.r);
    if (!ref) throw new NameDocError('記号の行がありません');
    const entry = idx.get(ref.source);
    let status: SpanStatus;
    let word: string;
    if (entry && entry.target === entry.source) {
      status = 'exception';
      word = ref.source;
    } else if (ref.action === 'reject') {
      status = 'reject';
      word = ref.source;
    } else if (ref.action === 'edit') {
      if (!ref.text) throw new NameDocError('手で直した言葉が空です');
      status = 'edit';
      word = esc(ref.text);
    } else {
      if (!entry) throw new NameDocError('辞書に無い名前が辞書どおりのままです');
      status = 'dict';
      word = esc(entry.target);
    }
    spans.push({
      id: ref.id,
      start: text.length,
      end: text.length + word.length,
      source: ref.source,
      status,
      word,
      target: entry && entry.target !== entry.source ? entry.target : null,
    });
    text += word;
  }
  return { text, spans };
}

/* ---------------- 当たり箇所から組む ---------------- */

interface Item {
  pos: number;
  ref: NameRef;
}

function buildSegments(text: string, items: Item[]): Segment[] {
  const out: Segment[] = [];
  let cur = 0;
  for (const it of items) {
    if (it.pos > cur) out.push({ t: text.slice(cur, it.pos) });
    out.push({ r: it.ref.id });
    cur = it.pos + it.ref.source.length;
  }
  if (cur < text.length) out.push({ t: text.slice(cur) });
  return normalizeSegments(out);
}

function freshRef(source: string, newId: () => string): NameRef {
  return { id: newId(), source, action: 'approve', text: null };
}

function inherit(c: NameRef, exception: boolean): NameRef {
  return exception ? { ...c, action: 'approve', text: null } : c;
}

/** 形が同じか（セグメントと記号の id・選択まで）。 */
export function sameShape(a: NameDocShape, b: NameDocShape): boolean {
  if (serializeSegments(a.segments) !== serializeSegments(b.segments)) return false;
  if (a.refs.length !== b.refs.length) return false;
  return a.refs.every((r, i) => {
    const o = b.refs[i]!;
    return r.id === o.id && r.source === o.source && r.action === o.action && (r.text ?? null) === (o.text ?? null);
  });
}

/** 今の辞書で全部辞書どおりに作る。 */
export function buildRealShape(text: string, dict: NameEntry[], newId: () => string): NameDocShape {
  return syncRealShape(null, text, dict, newId).shape;
}

function lostOf(ref: NameRef, now: string | null): LostChoice | null {
  if (ref.action === 'approve') return null;
  return { source: ref.source, action: ref.action, text: ref.action === 'edit' ? ref.text : null, now };
}

/** 外れた記号の場所が今どう出るか（重なる新しい記号の辞書どおりの言葉）。 */
function nowWordAt(items: Item[], span: Span, idx: Map<string, NameEntry>): string | null {
  const it = items.find((x) => x.pos < span.end && span.start < x.pos + x.ref.source.length);
  if (!it) return null;
  const e = idx.get(it.ref.source);
  return e && e.target !== e.source ? e.target : null;
}

function countUpTo2(s: string, sub: string): number {
  const i = s.indexOf(sub);
  if (i < 0) return 0;
  return s.indexOf(sub, i + 1) < 0 ? 1 : 2;
}

/**
 * 名前を含む行が、前の文にも今の文にも一つだけ一字一句そのまま出てくるなら、今の文での名前の位置。
 * 行が名前だけ（前後に文字が無い）なら追わない（取り違えを避ける）。追えなければ null。
 * ここで追った位置も、今の規則の当たり箇所と「範囲と置き換え元がまったく同じ」でなければ引き継がない。
 */
function lineMoveOf(a: string, b: string): (start: number, end: number) => number | null {
  return (start, end) => {
    const ls = start === 0 ? 0 : a.lastIndexOf('\n', start - 1) + 1;
    let le = a.indexOf('\n', start);
    if (le < 0) le = a.length;
    if (end > le) return null;
    const line = a.slice(ls, le);
    if (line.trim().length <= end - start) return null;
    if (countUpTo2(a, line) !== 1 || countUpTo2(b, line) !== 1) return null;
    return b.indexOf(line) + (start - ls);
  };
}

/**
 * 実名の文（原本・タイトル・説明）の文書を、今の文と今の辞書に合わせる（§1.1）。
 * 1. 前の文書を実名で解いた文 → 今の文の差分を取る
 * 2. 範囲の内側に手が入っていない記号を今の位置へ写す（引き継ぎの候補）
 * 3. 今の文全体に今の規則で当たり箇所を探し直し（findHits そのまま）、範囲と置き換え元がまったく同じ候補の id と選択を引き継ぐ
 * 4. 引き継がれなかった候補は捨てる。ただし辞書から語が消えた「手で直す」は、手が入っていなければ残す（§12 の 20）
 */
export function syncRealShape(
  prev: NameDocShape | null,
  text: string,
  dict: NameEntry[],
  newId: () => string
): { shape: NameDocShape; lost: LostChoice[]; changed: boolean } {
  const idx = dictMap(dict);
  const tokens = tokenizeForNames(text);
  const hits = findHits(text, dict, tokens);

  const cands = new Map<string, NameRef>();
  const dropped: { ref: NameRef; span: Span }[] = [];
  if (prev) {
    const real = realTextOf(prev);
    const edits: Edit[] = real.text === text ? [] : diffEdits(real.text, text);
    const moved = lineMoveOf(real.text, text);
    for (const ref of prev.refs) {
      const r = real.ranges.get(ref.id)!;
      if (!touched(edits, r.start, r.end)) {
        cands.set(`${mapPos(edits, r.start)}\n${ref.source}`, ref);
        continue;
      }
      // 段落の入れ替えは文字の差分では「消して足した」に見える。行ごと一字一句そのまま動いたなら追う
      const m = moved(r.start, r.end);
      if (m !== null && !cands.has(`${m}\n${ref.source}`)) {
        cands.set(`${m}\n${ref.source}`, ref);
        continue;
      }
      const ns = mapStart(edits, r.start);
      const ne = mapEnd(edits, r.end);
      // 名前ごと消えた（写し先が空）なら、戻る場所が無いので知らせない
      if (ne > ns) dropped.push({ ref, span: { start: ns, end: ne } });
    }
  }

  const items: Item[] = [];
  for (const h of hits) {
    const key = `${h.pos}\n${h.source}`;
    const c = cands.get(key);
    if (c) {
      cands.delete(key);
      items.push({ pos: h.pos, ref: inherit(c, h.exception) });
    } else {
      items.push({ pos: h.pos, ref: freshRef(h.source, newId) });
    }
  }

  const spans = replaceableSpans(tokens);
  for (const [key, c] of cands) {
    const pos = Number(key.slice(0, key.indexOf('\n')));
    const end = pos + c.source.length;
    const keep =
      c.action === 'edit' &&
      !!c.text &&
      !idx.has(c.source) &&
      text.startsWith(c.source, pos) &&
      spans.some((s) => s.start <= pos && end <= s.end) &&
      !items.some((it) => it.pos < end && pos < it.pos + it.ref.source.length);
    if (keep) items.push({ pos, ref: c });
    else dropped.push({ ref: c, span: { start: pos, end } });
  }
  items.sort((a, b) => a.pos - b.pos);

  const shape: NameDocShape = { segments: buildSegments(text, items), refs: items.map((i) => i.ref) };
  const lost: LostChoice[] = [];
  for (const d of dropped) {
    // 辞書から語を消した「拒否」は、出る文字が実名のまま変わらないので知らせない
    if (d.ref.action === 'reject' && !idx.has(d.ref.source)) continue;
    const l = lostOf(d.ref, nowWordAt(items, d.span, idx));
    if (l) lost.push(l);
  }
  return { shape, lost, changed: !prev || !sameShape(prev, shape) };
}

/* ---------------- 日記用に直した文 ---------------- */

/** 原本の文書を写す（新しい id で・選択も写す。§2.4）。 */
export function copyShape(shape: NameDocShape, newId: () => string): NameDocShape {
  const idMap = new Map(shape.refs.map((r) => [r.id, newId()]));
  return {
    segments: shape.segments.map((s) => (isRefSeg(s) ? { r: idMap.get(s.r)! } : { t: s.t })),
    refs: shape.refs.map((r) => ({ ...r, id: idMap.get(r.id)! })),
  };
}

/**
 * 当たり箇所を探す。ただし protect の範囲は必ず「置き換えてよい範囲」とみなし、分割しない
 * （範囲をまたぐ当たりは範囲を丸ごと含むときだけ有効。§1.3）。protect が空なら findHits と同じ。
 */
export function findHitsProtected(text: string, dict: NameEntry[], protect: Span[]): NameHit[] {
  if (!protect.length) return findHits(text, dict);
  const sorted = sortDictionary(dict);
  if (!sorted.length) return [];
  const allowed = new Uint8Array(text.length);
  const protOf = new Int32Array(text.length).fill(-1);
  for (const s of replaceableSpans(tokenizeForNames(text))) allowed.fill(1, s.start, s.end);
  for (const p of protect) {
    allowed.fill(1, p.start, p.end);
    protOf.fill(p.start, p.start, p.end);
  }
  const out: NameHit[] = [];
  let i = 0;
  const step = (at: number): number => {
    const cp = text.codePointAt(at)!;
    return cp > 0xffff ? 2 : 1;
  };
  while (i < text.length) {
    if (!allowed[i] || (protOf[i]! >= 0 && protOf[i] !== i)) {
      i += step(i);
      continue;
    }
    let hit: NameEntry | null = null;
    for (const d of sorted) {
      const end = i + d.source.length;
      if (end > text.length || !text.startsWith(d.source, i)) continue;
      let ok = true;
      for (let j = i; j < end; j++) {
        if (!allowed[j]) {
          ok = false;
          break;
        }
      }
      // 終わりが保護した範囲の途中に落ちる（範囲を割る）当たりは取らない
      if (ok && end < text.length && protOf[end]! >= 0 && protOf[end] !== end) ok = false;
      if (ok) {
        hit = d;
        break;
      }
    }
    if (hit) {
      out.push({ pos: i, source: hit.source, target: hit.target, exception: hit.source === hit.target });
      i += hit.source.length;
    } else {
      i += step(i);
    }
  }
  return out;
}

/**
 * 日記用の文を整える（保存時・辞書が変わったとき。§1.3）。
 * 1. 置き換え元が辞書に無くなった記号 → 普通の文字（置き換え元）に戻す。ただし「手で直す」は記号のまま残す（§12 の 20）
 * 2. 実名で解いた文の当たり箇所を探す（残っている記号の範囲は保護・分割しない）
 * 3. 範囲と置き換え元がまったく同じ記号は引き継ぎ、無ければ新しい記号。もっと長い語に呑まれた記号は捨てる
 */
export function normalizePublishShape(
  shape: NameDocShape,
  dict: NameEntry[],
  newId: () => string
): { shape: NameDocShape; lost: LostChoice[] } {
  const idx = dictMap(dict);
  const byId = new Map(shape.refs.map((r) => [r.id, r]));
  const segs1: Segment[] = [];
  const refs1: NameRef[] = [];
  for (const s of shape.segments) {
    if (!isRefSeg(s)) {
      segs1.push({ t: s.t });
      continue;
    }
    const ref = byId.get(s.r);
    if (!ref) throw new NameDocError('記号の行がありません');
    if (!idx.has(ref.source) && !(ref.action === 'edit' && ref.text)) {
      segs1.push({ t: ref.source });
      continue;
    }
    segs1.push({ r: ref.id });
    refs1.push(ref);
  }
  const mid: NameDocShape = { segments: normalizeSegments(segs1), refs: refs1 };
  const real = realTextOf(mid);
  const prot = refs1.map((ref) => ({ ref, ...real.ranges.get(ref.id)! }));
  const hits = findHitsProtected(
    real.text,
    dict,
    prot.map((p) => ({ start: p.start, end: p.end }))
  );

  const items: Item[] = [];
  const used = new Set<string>();
  for (const h of hits) {
    const p = prot.find((x) => x.start === h.pos && x.end === h.pos + h.source.length && x.ref.source === h.source);
    if (p) {
      used.add(p.ref.id);
      items.push({ pos: h.pos, ref: inherit(p.ref, h.exception) });
    } else {
      items.push({ pos: h.pos, ref: freshRef(h.source, newId) });
    }
  }
  const lost: LostChoice[] = [];
  for (const p of prot) {
    if (used.has(p.ref.id)) continue;
    const overlapped = items.some((it) => it.pos < p.end && p.start < it.pos + it.ref.source.length);
    if (overlapped) {
      const l = lostOf(p.ref, nowWordAt(items, p, idx));
      if (l) lost.push(l);
    } else {
      items.push({ pos: p.start, ref: p.ref });
    }
  }
  items.sort((a, b) => a.pos - b.pos);
  return { shape: { segments: buildSegments(real.text, items), refs: items.map((i) => i.ref) }, lost };
}

/**
 * 日記用の文を保存する（§1.2）。base を今の辞書で解いた文が d0（開いた時の欄）であること。
 * d0 → d1 の差分で、記号の表示範囲の内側に手が入っていなければ記号を残し、入っていれば d1 の文字をそのまま普通の文字にする（選択は捨てる）。
 * そのあと normalizePublishShape で、新しく打った実名を記号にする。
 */
export function applyPublishEdit(
  base: NameDocShape,
  dict: NameEntry[],
  d0: string,
  d1: string,
  newId: () => string
): { shape: NameDocShape; lost: LostChoice[] } {
  const res = resolveShape(base, dict);
  if (res.text !== d0) throw new NameDocError('開いたときの文と合いません');
  const edits = d0 === d1 ? [] : diffEdits(d0, d1);
  const byId = new Map(base.refs.map((r) => [r.id, r]));
  const segs: Segment[] = [];
  const refs: NameRef[] = [];
  let cur = 0;
  for (const sp of res.spans) {
    if (touched(edits, sp.start, sp.end)) continue;
    const ns = mapPos(edits, sp.start);
    const ne = ns + (sp.end - sp.start);
    if (ns < cur || d1.slice(ns, ne) !== sp.word) continue;
    if (ns > cur) segs.push({ t: d1.slice(cur, ns) });
    segs.push({ r: sp.id });
    refs.push(byId.get(sp.id)!);
    cur = ne;
  }
  if (cur < d1.length) segs.push({ t: d1.slice(cur) });
  return normalizePublishShape({ segments: normalizeSegments(segs), refs }, dict, newId);
}

/**
 * 日記用の文書が原本の文書と同じか（実名で解いた文が同じで、記号の置き換え元・選択が並びどおり同じ）。
 * 同じなら書き換えを持たない（§1.2 の 6）。
 */
export function sameAsOriginal(pub: NameDocShape, orig: NameDocShape): boolean {
  if (realTextOf(pub).text !== realTextOf(orig).text) return false;
  const a = realTextOf(pub).ranges;
  const b = realTextOf(orig).ranges;
  if (pub.refs.length !== orig.refs.length) return false;
  return pub.refs.every((r, i) => {
    const o = orig.refs[i]!;
    const ra = a.get(r.id)!;
    const rb = b.get(o.id)!;
    return (
      ra.start === rb.start &&
      r.source === o.source &&
      r.action === o.action &&
      (r.text ?? null) === (o.text ?? null)
    );
  });
}

/** 名前の選択を整える（手で直した言葉は改行を落として 60 字まで。辞書どおりと同じなら承認）。 */
export function normalizeChoice(
  ref: Pick<NameRef, 'source'>,
  action: ChoiceAction,
  rawText: unknown,
  idx: Map<string, NameEntry>
): { action: ChoiceAction; text: string | null } | { error: string } {
  const entry = idx.get(ref.source);
  if (entry && entry.target === entry.source) {
    return action === 'approve' ? { action: 'approve', text: null } : { error: '例外の名前は選べません' };
  }
  if (action === 'edit') {
    const t = cleanWord(rawText);
    if (!t) return { error: '言葉を入れてください' };
    if (entry && t === entry.target) return { action: 'approve', text: null };
    return { action: 'edit', text: t };
  }
  if (action === 'approve' && !entry) return { error: '辞書に無い名前は辞書どおりにできません' };
  return { action, text: null };
}

/** 手で直した言葉を整える（改行を落とし、前後の空白を落とし、長さを抑える）。空なら null。 */
export function cleanWord(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\r\n\t\u0085\u2028\u2029]+/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, 60).join('');
}
