// 名前の文書の D1（migrations/0009_name_doc.sql・公開名変換設計・記号方式）。
// ⚠️ 記号の行（置き換え元＝実名）と日記用の文は D1 にだけ置く。控え（kakera-data）にもリポジトリにも書かない。
// ⚠️ ここから kakera の行（body / updated_at）・katachi の行を書き換えない。原本は触らない。
//
// 同期（サーバが読むたびに文書を「今」に合わせる）には二つの読み方がある:
//  - write: 変わっていれば書き直す（変換ページを開く・日記用の文を読む）
//  - check: 書き込まず、保存してある形と今が違うかだけを返す（書き出し・日記用の保存・選択の保存）。
//    違えば「内容が変わりました。開き直してください」で止める＝画面に見えていない文を出さない（§12 の 24）

import type { Kakera } from '../kakera/types';
import { ApiError } from '../http';
import { nowJst } from '../time';
import { ulid } from '../ulid';
import {
  applyPublishEdit,
  copyShape,
  dictMap,
  normalizeChoice,
  normalizePublishShape,
  parseSegments,
  realTextOf,
  resolveShape,
  sameAsOriginal,
  sameShape,
  serializeSegments,
  shapeFrom,
  syncRealShape,
  type ChoiceAction,
  type DocKind,
  type LostChoice,
  type NameDocShape,
  type NameRef,
  type Segment,
} from './doc';
import { sortDictionary, type NameEntry } from './replace';
import { cleanPublishBody, isPublishBodyStale, type PublishBodyView } from '../publish/publish-body';

const IN_CHUNK = 90;

export const CHANGED_MESSAGE = '内容が変わりました。開き直してください。';
const RACE_MESSAGE = '同時に書き換えられました。開き直してください。';

export interface DocRow {
  id: string;
  kind: DocKind;
  kakera_id: string | null;
  katachi_id: string | null;
  segments: string;
  dict_sig: string;
  rev: string;
  basis: string | null;
  updated_at: string;
}

interface RefRow {
  id: string;
  doc_id: string;
  source: string;
  action: ChoiceAction;
  text: string | null;
  updated_at: string;
}

interface Loaded {
  row: DocRow;
  refs: RefRow[];
}

export interface DocState {
  kind: DocKind;
  /** 保存してある行（write で書き直したら新しい行）。無ければ null */
  row: DocRow | null;
  /** 今に合わせた形。崩れている・無いなら null */
  shape: NameDocShape | null;
  /** 形が崩れている（JSON・記号の行が無い・別の文書の記号・同じ記号が二度） */
  broken: boolean;
  /** 直した場所にあって外れた選択 */
  lost: LostChoice[];
  /** check で読んだとき、保存してある形と今が違う（まだ無いも含む） */
  changed: boolean;
}

export interface SyncOpts {
  write: boolean;
  /** 実名の文書の形が崩れていたら作り直す（変換ページを開くときだけ。書き出しでは直さずに止める） */
  repair?: boolean;
}

/* ---------------- 辞書の印 ---------------- */

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 辞書の置き換え元の印（置き換え先は含めない＝置き換え先の変更で作り直さない）。 */
export function dictSig(dict: NameEntry[]): Promise<string> {
  return sha256Hex(JSON.stringify(sortDictionary(dict).map((d) => d.source).sort()));
}

/** 辞書の中身全体の印（置き換え先も含む）。開いた後に辞書が変わったら書き出しを止めるのに使う。 */
export function dictRev(dict: NameEntry[]): Promise<string> {
  const pairs = sortDictionary(dict)
    .map((d) => [d.source, d.target])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return sha256Hex(JSON.stringify(pairs));
}

/* ---------------- 読む ---------------- */

async function selectIn<T>(db: D1Database, sql: (ph: string) => string, fixed: unknown[], ids: string[]): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += IN_CHUNK) {
    const part = uniq.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(sql(part.map(() => '?').join(',')))
      .bind(...fixed, ...part)
      .all<T>();
    out.push(...(results ?? []));
  }
  return out;
}

async function refsOf(db: D1Database, docIds: string[]): Promise<Map<string, RefRow[]>> {
  const rows = await selectIn<RefRow>(
    db,
    (ph) => `SELECT id, doc_id, source, action, text, updated_at FROM name_ref WHERE doc_id IN (${ph})`,
    [],
    docIds
  );
  const out = new Map<string, RefRow[]>();
  for (const r of rows) {
    const list = out.get(r.doc_id) ?? [];
    list.push(r);
    out.set(r.doc_id, list);
  }
  return out;
}

/** そのかたちのタイトル・説明・日記用の文書と、渡したかけらの原本の文書。 */
async function loadRows(db: D1Database, katachiId: string, kakeraIds: string[]): Promise<Loaded[]> {
  const { results } = await db
    .prepare("SELECT * FROM name_doc WHERE katachi_id = ? AND kind IN ('title', 'description', 'publish')")
    .bind(katachiId)
    .all<DocRow>();
  const docs = [...(results ?? [])];
  docs.push(...(await selectIn<DocRow>(db, (ph) => `SELECT * FROM name_doc WHERE kind = 'kakera' AND kakera_id IN (${ph})`, [], kakeraIds)));
  const refs = await refsOf(
    db,
    docs.map((d) => d.id)
  );
  return docs.map((row) => ({ row, refs: refs.get(row.id) ?? [] }));
}

async function loadOne(
  db: D1Database,
  kind: DocKind,
  owner: { kakera_id: string | null; katachi_id: string | null }
): Promise<Loaded | null> {
  const row =
    kind === 'kakera'
      ? await db.prepare("SELECT * FROM name_doc WHERE kind = 'kakera' AND kakera_id = ?").bind(owner.kakera_id).first<DocRow>()
      : kind === 'publish'
        ? await db
            .prepare("SELECT * FROM name_doc WHERE kind = 'publish' AND katachi_id = ? AND kakera_id = ?")
            .bind(owner.katachi_id, owner.kakera_id)
            .first<DocRow>()
        : await db.prepare('SELECT * FROM name_doc WHERE kind = ? AND katachi_id = ?').bind(kind, owner.katachi_id).first<DocRow>();
  if (!row) return null;
  return { row, refs: (await refsOf(db, [row.id])).get(row.id) ?? [] };
}

function toRef(r: RefRow): NameRef {
  return { id: r.id, source: r.source, action: r.action, text: r.action === 'edit' ? r.text : null };
}

function shapeOfLoaded(l: Loaded): NameDocShape | null {
  return shapeFrom(parseSegments(l.row.segments), l.refs.map(toRef));
}

/* ---------------- 書く ---------------- */

interface Target {
  kind: DocKind;
  kakera_id: string | null;
  katachi_id: string | null;
  basis: string | null;
}

/**
 * 文書を書く（無ければ作る）。rev で守り、記号の行の入れ替えは「新しい rev の文書がある」ことを条件にする。
 * 負けたら null（呼ぶ側が読み直して一度だけやり直す）。
 */
async function writeDoc(
  db: D1Database,
  existing: DocRow | null,
  target: Target,
  shape: NameDocShape,
  sig: string,
  refTimes: Map<string, string>
): Promise<DocRow | null> {
  const now = nowJst();
  const rev = ulid();
  const id = existing?.id ?? ulid();
  const segJson = serializeSegments(shape.segments);
  const stmts: D1PreparedStatement[] = [];
  if (existing) {
    stmts.push(
      db
        .prepare('UPDATE name_doc SET segments = ?, dict_sig = ?, rev = ?, basis = ?, updated_at = ? WHERE id = ? AND rev = ?')
        .bind(segJson, sig, rev, target.basis, now, id, existing.rev)
    );
  } else {
    stmts.push(
      db
        .prepare(
          `INSERT INTO name_doc (id, kind, kakera_id, katachi_id, segments, dict_sig, rev, basis, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
        )
        .bind(id, target.kind, target.kakera_id, target.katachi_id, segJson, sig, rev, target.basis, now)
    );
  }
  const guard = 'EXISTS (SELECT 1 FROM name_doc WHERE id = ? AND rev = ?)';
  if (existing) stmts.push(db.prepare(`DELETE FROM name_ref WHERE doc_id = ? AND ${guard}`).bind(id, id, rev));
  for (const ref of shape.refs) {
    stmts.push(
      db
        .prepare(`INSERT INTO name_ref (id, doc_id, source, action, text, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`)
        .bind(ref.id, id, ref.source, ref.action, ref.action === 'edit' ? ref.text : null, refTimes.get(ref.id) ?? now, id, rev)
    );
  }
  const res = await db.batch(stmts);
  if (!(res[0]?.meta?.changes ?? 0)) return null;
  return {
    id,
    kind: target.kind,
    kakera_id: target.kakera_id,
    katachi_id: target.katachi_id,
    segments: segJson,
    dict_sig: sig,
    rev,
    basis: target.basis,
    updated_at: now,
  };
}

function refTimesOf(l: Loaded | null): Map<string, string> {
  return new Map((l?.refs ?? []).map((r) => [r.id, r.updated_at]));
}

async function touchSig(db: D1Database, row: DocRow, sig: string): Promise<DocRow | null> {
  if (row.dict_sig === sig) return row;
  const r = await db.prepare('UPDATE name_doc SET dict_sig = ? WHERE id = ? AND rev = ?').bind(sig, row.id, row.rev).run();
  return (r.meta?.changes ?? 0) ? { ...row, dict_sig: sig } : null;
}

/* ---------------- 同期 ---------------- */

type Attempt = DocState | 'conflict';

async function retrying(
  db: D1Database,
  kind: DocKind,
  owner: { kakera_id: string | null; katachi_id: string | null },
  loaded: Loaded | null,
  run: (l: Loaded | null) => Promise<Attempt>
): Promise<DocState> {
  let l = loaded;
  for (let attempt = 0; ; attempt++) {
    const r = await run(l);
    if (r !== 'conflict') return r;
    if (attempt >= 1) throw new ApiError(409, RACE_MESSAGE);
    l = await loadOne(db, kind, owner);
  }
}

/** 実名の文書（kakera／title／description）を今の文に合わせる（§1.1）。 */
export async function syncRealDoc(
  db: D1Database,
  kind: 'kakera' | 'title' | 'description',
  owner: { kakera_id: string | null; katachi_id: string | null },
  text: string,
  dict: NameEntry[],
  sig: string,
  loaded: Loaded | null,
  opts: SyncOpts
): Promise<DocState> {
  return retrying(db, kind, owner, loaded, async (l): Promise<Attempt> => {
    const row = l?.row ?? null;
    if (kind === 'description' && !text) {
      if (row && opts.write) await db.prepare('DELETE FROM name_doc WHERE id = ?').bind(row.id).run();
      return { kind, row: opts.write ? null : row, shape: null, broken: false, lost: [], changed: false };
    }
    let prev: NameDocShape | null = null;
    const repairedLost: LostChoice[] = [];
    if (l) {
      prev = shapeOfLoaded(l);
      if (!prev) {
        if (!opts.repair) return { kind, row, shape: null, broken: true, lost: [], changed: false };
        for (const r of l.refs) {
          if (r.action !== 'approve') repairedLost.push({ source: r.source, action: r.action, text: r.text, now: null });
        }
      }
    }
    if (row && prev && row.dict_sig === sig && realTextOf(prev).text === text) {
      return { kind, row, shape: prev, broken: false, lost: [], changed: false };
    }
    const res = syncRealShape(prev, text, dict, ulid);
    const lost = [...repairedLost, ...res.lost];
    if (!opts.write) return { kind, row, shape: res.shape, broken: false, lost, changed: !row || res.changed };
    if (row && prev && !res.changed) {
      const touchedRow = await touchSig(db, row, sig);
      if (!touchedRow) return 'conflict';
      return { kind, row: touchedRow, shape: prev, broken: false, lost, changed: false };
    }
    const written = await writeDoc(db, row, { kind, ...owner, basis: null }, res.shape, sig, refTimesOf(l));
    if (!written) return 'conflict';
    return { kind, row: written, shape: res.shape, broken: false, lost, changed: false };
  });
}

/** 日記用の文書を今の辞書に合わせる（§1.3。文字の変化では作り直さない）。 */
export async function syncPublishDoc(
  db: D1Database,
  loaded: Loaded,
  dict: NameEntry[],
  sig: string,
  opts: SyncOpts
): Promise<DocState> {
  const owner = { kakera_id: loaded.row.kakera_id, katachi_id: loaded.row.katachi_id };
  return retrying(db, 'publish', owner, loaded, async (l): Promise<Attempt> => {
    if (!l) return { kind: 'publish', row: null, shape: null, broken: false, lost: [], changed: true };
    const row = l.row;
    const shape = shapeOfLoaded(l);
    if (!shape) return { kind: 'publish', row, shape: null, broken: true, lost: [], changed: false };
    if (row.dict_sig === sig) return { kind: 'publish', row, shape, broken: false, lost: [], changed: false };
    let res: { shape: NameDocShape; lost: LostChoice[] };
    try {
      res = normalizePublishShape(shape, dict, ulid);
    } catch {
      return { kind: 'publish', row, shape: null, broken: true, lost: [], changed: false };
    }
    const changed = !sameShape(shape, res.shape);
    if (!opts.write) return { kind: 'publish', row, shape: res.shape, broken: false, lost: res.lost, changed };
    if (!changed) {
      const touchedRow = await touchSig(db, row, sig);
      if (!touchedRow) return 'conflict';
      return { kind: 'publish', row: touchedRow, shape, broken: false, lost: res.lost, changed: false };
    }
    const written = await writeDoc(
      db,
      row,
      { kind: 'publish', kakera_id: row.kakera_id, katachi_id: row.katachi_id, basis: row.basis },
      res.shape,
      sig,
      refTimesOf(l)
    );
    if (!written) return 'conflict';
    return { kind: 'publish', row: written, shape: res.shape, broken: false, lost: res.lost, changed: false };
  });
}

export interface DiaryDocs {
  title: DocState;
  description: DocState;
  /** かけらの id → 原本の文書 */
  kakera: Map<string, DocState>;
  /** かけらの id → 日記用の文書（書き換えがあるかけらだけ） */
  publish: Map<string, DocState>;
}

/** 日記に出すかけら・タイトル・説明の文書を読み、今に合わせる。 */
export async function syncDiaryDocs(
  db: D1Database,
  katachiId: string,
  chosen: Kakera[],
  title: string,
  description: string,
  dict: NameEntry[],
  opts: SyncOpts
): Promise<DiaryDocs> {
  const sig = await dictSig(dict);
  const all = await loadRows(
    db,
    katachiId,
    chosen.map((k) => k.id)
  );
  const find = (pred: (r: DocRow) => boolean): Loaded | null => all.find((l) => pred(l.row)) ?? null;
  const head = { kakera_id: null, katachi_id: katachiId };
  const out: DiaryDocs = {
    title: await syncRealDoc(db, 'title', head, title, dict, sig, find((r) => r.kind === 'title'), opts),
    description: await syncRealDoc(db, 'description', head, description, dict, sig, find((r) => r.kind === 'description'), opts),
    kakera: new Map(),
    publish: new Map(),
  };
  for (const k of chosen) {
    out.kakera.set(
      k.id,
      await syncRealDoc(
        db,
        'kakera',
        { kakera_id: k.id, katachi_id: null },
        k.body,
        dict,
        sig,
        find((r) => r.kind === 'kakera' && r.kakera_id === k.id),
        opts
      )
    );
    const p = find((r) => r.kind === 'publish' && r.kakera_id === k.id);
    if (p) out.publish.set(k.id, await syncPublishDoc(db, p, dict, sig, opts));
  }
  return out;
}

/** 書き出しに使う文書（かけらは日記用の文書があればそれ、無ければ原本の文書）。 */
export function usedDocs(
  docs: DiaryDocs,
  chosen: Kakera[],
  description: string
): { seg: string; label: string; state: DocState; expected?: string }[] {
  const out: { seg: string; label: string; state: DocState; expected?: string }[] = [
    { seg: 'title', label: 'タイトル', state: docs.title },
  ];
  if (description) out.push({ seg: 'description', label: '説明', state: docs.description, expected: description });
  chosen.forEach((k, i) => {
    const pub = docs.publish.get(k.id);
    out.push(
      pub
        ? { seg: k.id, label: `かけら ${i + 1}`, state: pub }
        : { seg: k.id, label: `かけら ${i + 1}`, state: docs.kakera.get(k.id)!, expected: k.body }
    );
  });
  return out;
}

/* ---------------- 画面に渡す形 ---------------- */

export interface DocView {
  /** 'title'・'description' か、かけらの id */
  seg: string;
  kind: DocKind;
  doc_id: string;
  rev: string;
  /** null = 形が崩れている */
  segments: Segment[] | null;
  refs: NameRef[];
  lost_choices: LostChoice[];
  /** publish だけ */
  basis: string | null;
  stale: boolean;
  updated_at: string;
}

export function docViewOf(seg: string, st: DocState, kakeraUpdatedAt?: string): DocView | null {
  if (!st.row) return null;
  return {
    seg,
    kind: st.kind,
    doc_id: st.row.id,
    rev: st.row.rev,
    segments: st.broken ? null : (st.shape?.segments ?? null),
    refs: st.broken ? [] : (st.shape?.refs ?? []),
    lost_choices: st.lost,
    basis: st.row.basis,
    stale: st.kind === 'publish' && kakeraUpdatedAt !== undefined && st.row.basis !== null && isPublishBodyStale(kakeraUpdatedAt, st.row.basis),
    updated_at: st.row.updated_at,
  };
}

export function diaryDocViews(docs: DiaryDocs, chosen: Kakera[]): DocView[] {
  const out: DocView[] = [];
  const push = (v: DocView | null) => {
    if (v) out.push(v);
  };
  push(docViewOf('title', docs.title));
  push(docViewOf('description', docs.description));
  for (const k of chosen) {
    push(docViewOf(k.id, docs.kakera.get(k.id)!));
    const p = docs.publish.get(k.id);
    if (p) push(docViewOf(k.id, p, k.updated_at));
  }
  return out;
}

/* ---------------- 選択 ---------------- */

interface RefWithDoc extends RefRow {
  kind: DocKind;
  kakera_id: string | null;
  katachi_id: string | null;
}

/** その記号がこの日記の文書のものか（原本の文書は、日記用の文書が無いかけらのときだけ）。 */
async function refBelongs(db: D1Database, katachiId: string, r: RefWithDoc): Promise<boolean> {
  if (r.kind === 'title' || r.kind === 'description') return r.katachi_id === katachiId;
  const inKatachi = await db
    .prepare('SELECT 1 AS x FROM katachi_kakera WHERE katachi_id = ? AND kakera_id = ?')
    .bind(katachiId, r.kakera_id)
    .first<{ x: number }>();
  if (!inKatachi) return false;
  if (r.kind === 'publish') return r.katachi_id === katachiId;
  const pub = await db
    .prepare("SELECT 1 AS x FROM name_doc WHERE kind = 'publish' AND katachi_id = ? AND kakera_id = ?")
    .bind(katachiId, r.kakera_id)
    .first<{ x: number }>();
  return !pub;
}

function parseAction(raw: unknown): ChoiceAction | null {
  return raw === 'approve' || raw === 'edit' || raw === 'reject' ? raw : null;
}

/** 記号一つの選択を保存する（PUT …/name-choice）。この日記の文書に無い記号は 409、例外・中身の無い言葉は 400。 */
export async function chooseRef(
  db: D1Database,
  katachiId: string,
  dict: NameEntry[],
  input: Record<string, unknown>
): Promise<NameRef> {
  if (typeof input.ref_id !== 'string' || !input.ref_id) throw new ApiError(400, 'ref_id がありません');
  const action = parseAction(input.action);
  if (!action) throw new ApiError(400, 'action は approve / edit / reject のどれかにしてください');
  const r = await db
    .prepare(
      `SELECT r.id, r.doc_id, r.source, r.action, r.text, r.updated_at, d.kind, d.kakera_id, d.katachi_id
         FROM name_ref r JOIN name_doc d ON d.id = r.doc_id WHERE r.id = ?`
    )
    .bind(input.ref_id)
    .first<RefWithDoc>();
  if (!r || !(await refBelongs(db, katachiId, r))) throw new ApiError(409, CHANGED_MESSAGE);
  const next = normalizeChoice(r, action, input.text, dictMap(dict));
  if ('error' in next) throw new ApiError(400, next.error);
  await db
    .prepare('UPDATE name_ref SET action = ?, text = ?, updated_at = ? WHERE id = ?')
    .bind(next.action, next.text, nowJst(), r.id)
    .run();
  return { id: r.id, source: r.source, action: next.action, text: next.text };
}

/**
 * 書き出しで届いた選択（全記号ぶん）を保存し、読んである形にも当てる。
 * この日記の文書に無い記号は 409、例外に選ぶ・中身の無い言葉は 400。変わらないものは書かない。
 */
export async function applyExportChoices(
  db: D1Database,
  used: { state: DocState }[],
  dict: NameEntry[],
  raw: unknown
): Promise<void> {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) throw new ApiError(400, 'choices は配列で送ってください');
  const idx = dictMap(dict);
  const byId = new Map<string, { shape: NameDocShape; i: number }>();
  for (const u of used) {
    const shape = u.state.shape;
    if (!shape) continue;
    shape.refs.forEach((ref, i) => byId.set(ref.id, { shape, i }));
  }
  const now = nowJst();
  const stmts: D1PreparedStatement[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') throw new ApiError(400, 'choices の形が違います');
    const o = c as Record<string, unknown>;
    const action = parseAction(o.action);
    if (typeof o.ref_id !== 'string' || !action) throw new ApiError(400, 'choices の形が違います');
    const hit = byId.get(o.ref_id);
    if (!hit) throw new ApiError(409, CHANGED_MESSAGE);
    const ref = hit.shape.refs[hit.i]!;
    const next = normalizeChoice(ref, action, o.text, idx);
    if ('error' in next) throw new ApiError(400, next.error);
    if (next.action === ref.action && next.text === (ref.text ?? null)) continue;
    hit.shape.refs[hit.i] = { ...ref, action: next.action, text: next.text };
    stmts.push(db.prepare('UPDATE name_ref SET action = ?, text = ?, updated_at = ? WHERE id = ?').bind(next.action, next.text, now, ref.id));
  }
  if (stmts.length) await db.batch(stmts);
}

/* ---------------- 日記用に直した文 ---------------- */

/**
 * 日記用の文を保存する（PUT …/publish-body/:kid・§1.2）。
 * base = 画面が欄を開いたときの文（置き換え済み）。サーバが D1 から作り直して一致しなければ 409。
 * 原本の文書と同じになったら書き換えを持たない（文書を消す）。basis は今の kakera.updated_at。
 */
export async function savePublishText(
  db: D1Database,
  katachiId: string,
  k: Kakera,
  dict: NameEntry[],
  base: unknown,
  text: unknown
): Promise<{ publish: DocState | null; kakera: DocState }> {
  const sig = await dictSig(dict);
  const all = await loadRows(db, katachiId, [k.id]);
  const kl = all.find((l) => l.row.kind === 'kakera' && l.row.kakera_id === k.id) ?? null;
  const pl = all.find((l) => l.row.kind === 'publish' && l.row.kakera_id === k.id) ?? null;
  const check = { write: false };
  const kst = await syncRealDoc(db, 'kakera', { kakera_id: k.id, katachi_id: null }, k.body, dict, sig, kl, check);
  const pst = pl ? await syncPublishDoc(db, pl, dict, sig, check) : null;
  if (pst?.broken) throw new ApiError(409, '日記用の文が読めません。原本に戻してください。');
  if (kst.broken || !kst.shape || kst.changed || (pst && (pst.changed || !pst.shape))) {
    throw new ApiError(409, CHANGED_MESSAGE);
  }
  const baseShape = pst?.shape ?? kst.shape;
  let d0: string;
  try {
    d0 = resolveShape(baseShape, dict).text;
  } catch {
    throw new ApiError(409, CHANGED_MESSAGE);
  }
  if (typeof base !== 'string' || base !== d0) throw new ApiError(409, CHANGED_MESSAGE);
  const clean = cleanPublishBody(text);
  if (clean === null) throw new ApiError(400, '本文が空です（日記に出さないなら「日記にする」画面で外してください）');
  if (clean === d0) return { publish: pst, kakera: kst };

  // 書き換えがまだ無ければ、原本の文書を写した文書（新しい id・欄を開いた時点の選択）から始める（§12 の 23）
  const from = pst?.shape ?? copyShape(kst.shape, ulid);
  const res = applyPublishEdit(from, dict, d0, clean, ulid);
  if (sameAsOriginal(res.shape, kst.shape)) {
    if (pl) await db.prepare('DELETE FROM name_doc WHERE id = ?').bind(pl.row.id).run();
    return { publish: null, kakera: kst };
  }
  const written = await writeDoc(
    db,
    pl?.row ?? null,
    { kind: 'publish', kakera_id: k.id, katachi_id: katachiId, basis: k.updated_at },
    res.shape,
    sig,
    refTimesOf(pl)
  );
  if (!written) throw new ApiError(409, RACE_MESSAGE);
  return { publish: { kind: 'publish', row: written, shape: res.shape, broken: false, lost: res.lost, changed: false }, kakera: kst };
}

/** 「書き換えを使う」＝basis を今の kakera.updated_at に進める（文と選択は変えない）。 */
export async function acceptPublishDoc(db: D1Database, katachiId: string, k: Kakera): Promise<PublishBodyView> {
  const r = await db
    .prepare("UPDATE name_doc SET basis = ? WHERE kind = 'publish' AND katachi_id = ? AND kakera_id = ?")
    .bind(k.updated_at, katachiId, k.id)
    .run();
  if (!(r.meta?.changes ?? 0)) throw new ApiError(404, 'このかけらに日記用の書き換えはありません');
  const row = await db
    .prepare("SELECT basis, updated_at FROM name_doc WHERE kind = 'publish' AND katachi_id = ? AND kakera_id = ?")
    .bind(katachiId, k.id)
    .first<{ basis: string; updated_at: string }>();
  if (!row) throw new ApiError(404, 'このかけらに日記用の書き換えはありません');
  return { kakera_id: k.id, basis: row.basis, updated_at: row.updated_at, stale: isPublishBodyStale(k.updated_at, row.basis) };
}

/** 書き換えを捨てて原本に戻す（記号の行は CASCADE で消える）。消したかどうかを返す。 */
export async function deletePublishDoc(db: D1Database, katachiId: string, kakeraId: string): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM name_doc WHERE kind = 'publish' AND katachi_id = ? AND kakera_id = ?")
    .bind(katachiId, kakeraId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

/** そのかたちの、渡したかけらの日記用の文書を今の辞書に合わせて読む（GET …/publish-body）。 */
export async function syncPublishDocsOf(
  db: D1Database,
  katachiId: string,
  kakera: Kakera[],
  dict: NameEntry[]
): Promise<{ kakera: Kakera; state: DocState }[]> {
  const sig = await dictSig(dict);
  const byId = new Map(kakera.map((k) => [k.id, k]));
  const out: { kakera: Kakera; state: DocState }[] = [];
  for (const l of await loadRows(db, katachiId, [])) {
    const k = l.row.kind === 'publish' && l.row.kakera_id ? byId.get(l.row.kakera_id) : undefined;
    if (!k) continue;
    out.push({ kakera: k, state: await syncPublishDoc(db, l, dict, sig, { write: true }) });
  }
  return out;
}

/**
 * 日記用の文を実名で解いた文（写真の選択の突き合わせ用。辞書に依存しないので同期しない）。
 * 形が崩れている文書は飛ばす（書き出しは別に 409 で止まる）。
 */
export async function publishRealTexts(
  db: D1Database,
  katachiId: string,
  kakeraIds: string[]
): Promise<{ kakera_id: string; body: string }[]> {
  const all = await loadRows(db, katachiId, []);
  const ids = new Set(kakeraIds);
  const out: { kakera_id: string; body: string }[] = [];
  for (const l of all) {
    if (l.row.kind !== 'publish' || !l.row.kakera_id || !ids.has(l.row.kakera_id)) continue;
    const shape = shapeOfLoaded(l);
    if (shape) out.push({ kakera_id: l.row.kakera_id, body: realTextOf(shape).text });
  }
  return out;
}
