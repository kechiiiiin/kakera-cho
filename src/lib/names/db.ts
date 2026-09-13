// 公開名変換の D1（migrations/0003_name_map.sql）。
// ⚠️ 辞書も選択も置き換え元（実名）を含むので、D1 にだけ置く。控え（kakera-data）にもリポジトリにも書かない。

import type { Kakera, KatachiDetail } from '../kakera/types';
import { ApiError } from '../http';
import { nowJst } from '../time';
import { ulid } from '../ulid';
import { choiceMap, cleanEditText, findHits, type NameChoice, type NameEntry } from './replace';

/* ---------------- 辞書 ---------------- */

export async function listNameMap(db: D1Database): Promise<NameEntry[]> {
  const { results } = await db
    .prepare('SELECT id, source, target, updated_at FROM name_map ORDER BY source')
    .all<NameEntry>();
  return results ?? [];
}

/** 語として受け取れる形に整える（改行・タブを落として前後の空白を落とす）。 */
function cleanWord(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw new ApiError(400, `${label}を入れてください`);
  const s = raw.replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) throw new ApiError(400, `${label}を入れてください`);
  if (Array.from(s).length > 40) throw new ApiError(400, `${label}は40文字までにしてください`);
  return s;
}

/** 画面・API から届いた項目を検める。例外なら target は source と同じにする。 */
export function parseNameEntryInput(input: Record<string, unknown>): { source: string; target: string } {
  const source = cleanWord(input.source, '置き換え元');
  if (input.exception === true) return { source, target: source };
  const target = cleanWord(input.target, '置き換え先（置き換えないなら例外に）');
  return { source, target };
}

async function assertSourceFree(db: D1Database, source: string, exceptId?: string): Promise<void> {
  const dup = await db
    .prepare('SELECT id FROM name_map WHERE source = ? AND id != ?')
    .bind(source, exceptId ?? '')
    .first<{ id: string }>();
  if (dup) throw new ApiError(409, `「${source}」はもう辞書にあります`);
}

export async function insertNameEntry(db: D1Database, e: { source: string; target: string }): Promise<NameEntry> {
  await assertSourceFree(db, e.source);
  const row: NameEntry = { id: ulid(), source: e.source, target: e.target, updated_at: nowJst() };
  await db
    .prepare('INSERT INTO name_map (id, source, target, updated_at) VALUES (?, ?, ?, ?)')
    .bind(row.id, row.source, row.target, row.updated_at)
    .run();
  return row;
}

/**
 * 項目を直す。置き換え元が変わったら、元の語の選択は捨てる（辞書から消えた語の選択は捨てる）。
 */
export async function updateNameEntry(
  db: D1Database,
  id: string,
  e: { source: string; target: string }
): Promise<NameEntry> {
  const before = await db.prepare('SELECT * FROM name_map WHERE id = ?').bind(id).first<NameEntry>();
  if (!before) throw new ApiError(404, 'その項目はありません');
  await assertSourceFree(db, e.source, id);
  const now = nowJst();
  const stmts: D1PreparedStatement[] = [
    db.prepare('UPDATE name_map SET source = ?, target = ?, updated_at = ? WHERE id = ?').bind(e.source, e.target, now, id),
  ];
  if (before.source !== e.source) {
    stmts.push(db.prepare('DELETE FROM name_choice WHERE source = ?').bind(before.source));
  }
  await db.batch(stmts);
  return { id, source: e.source, target: e.target, updated_at: now };
}

/** 項目を消す。その語の選択も捨てる。 */
export async function deleteNameEntry(db: D1Database, id: string): Promise<void> {
  const before = await db.prepare('SELECT * FROM name_map WHERE id = ?').bind(id).first<NameEntry>();
  if (!before) throw new ApiError(404, 'その項目はありません');
  await db.batch([
    db.prepare('DELETE FROM name_map WHERE id = ?').bind(id),
    db.prepare('DELETE FROM name_choice WHERE source = ?').bind(before.source),
  ]);
}

/* ---------------- 選択 ---------------- */

/** 画面とやり取りする選択の形。seg は 'title' か、かけらの id。 */
export interface SegChoice extends NameChoice {
  seg: string;
}

interface ChoiceRow {
  scope: 'kakera' | 'title';
  ref_id: string;
  pos: number;
  source: string;
  action: 'approve' | 'edit' | 'reject';
  text: string | null;
  basis: string;
}

/** 日記に使うタイトル（入力が空ならかたちの題）。書き出しと画面で必ず同じこれを通す。 */
export function resolveNikkiTitle(input: unknown, katachiTitle: string): string {
  return typeof input === 'string' && input.trim() ? input.trim() : katachiTitle;
}

/** 日記に出すかけらを、そのかたちの中から並び順どおりに引く。 */
export function pickKakera(detail: KatachiDetail, ids: unknown): Kakera[] {
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) {
    throw new ApiError(400, '日記に出すかけらが選ばれていません');
  }
  const byId = new Map(detail.kakera.map((k) => [k.id, k]));
  return (ids as string[]).map((kid) => {
    const k = byId.get(kid);
    if (!k) throw new ApiError(400, `このかたちに無いかけらが選ばれています: ${kid}`);
    return k;
  });
}

/** 画面・API から届いた選択の列を形だけ検める（中身の突き合わせは validateChoices）。 */
export function parseSegChoices(raw: unknown): SegChoice[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, 'choices は配列で送ってください');
  const out: SegChoice[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.seg !== 'string' || typeof o.source !== 'string') continue;
    if (typeof o.pos !== 'number' || !Number.isInteger(o.pos) || o.pos < 0) continue;
    if (o.action !== 'approve' && o.action !== 'edit' && o.action !== 'reject') continue;
    out.push({
      seg: o.seg,
      pos: o.pos,
      source: o.source,
      action: o.action,
      ...(typeof o.text === 'string' ? { text: o.text } : {}),
    });
  }
  return out;
}

/**
 * 選択を、**原本から計算し直した当たり箇所**と突き合わせる。
 * 位置と置き換え元が一致し、例外でなく、辞書どおりと違う（edit の言葉が空でも辞書どおりと同じでもない）ものだけ残す。
 * 一致しないものは捨てる＝辞書どおりに倒れる。
 */
export function validateChoices(
  dict: NameEntry[],
  title: string,
  kakera: Kakera[],
  choices: SegChoice[]
): SegChoice[] {
  const texts = new Map<string, string>([['title', title], ...kakera.map((k): [string, string] => [k.id, k.body])]);
  const bySeg = new Map<string, SegChoice[]>();
  for (const c of choices) {
    if (!texts.has(c.seg)) continue;
    const list = bySeg.get(c.seg) ?? [];
    list.push(c);
    bySeg.set(c.seg, list);
  }
  const out: SegChoice[] = [];
  for (const [seg, list] of bySeg) {
    const hits = findHits(texts.get(seg)!, dict);
    const byPos = choiceMap(list);
    for (const h of hits) {
      const c = byPos.get(h.pos);
      if (!c || h.exception || c.source !== h.source) continue;
      if (c.action === 'reject') out.push({ seg, pos: h.pos, source: h.source, action: 'reject' });
      else if (c.action === 'edit') {
        const t = cleanEditText(c.text);
        if (t && t !== h.target) out.push({ seg, pos: h.pos, source: h.source, action: 'edit', text: t });
      }
    }
  }
  return out;
}

export interface LoadedChoices {
  choices: SegChoice[];
  /** 選択があったのに、本文が直されていて白紙に戻したかけら */
  reset_kakera_ids: string[];
  /** 選択があったのに、タイトルの文字列が変わっていて白紙に戻したか */
  reset_title: boolean;
}

/**
 * 保存してある選択を読む。
 *  かけら: 保存したときの kakera.updated_at と今が違えば、そのかけらの選択は白紙
 *  タイトル: 保存したときのタイトルの文字列と今が違えば白紙
 *  辞書から消えた語・位置のずれた選択は validateChoices で落ちる
 */
export async function loadChoices(
  db: D1Database,
  dict: NameEntry[],
  katachiId: string,
  title: string,
  kakera: Kakera[]
): Promise<LoadedChoices> {
  const ids = kakera.map((k) => k.id);
  const rows: ChoiceRow[] = [];
  const titleRows = await db
    .prepare("SELECT * FROM name_choice WHERE scope = 'title' AND ref_id = ?")
    .bind(katachiId)
    .all<ChoiceRow>();
  rows.push(...(titleRows.results ?? []));
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT * FROM name_choice WHERE scope = 'kakera' AND ref_id IN (${part.map(() => '?').join(',')})`)
      .bind(...part)
      .all<ChoiceRow>();
    rows.push(...(results ?? []));
  }

  const updatedAt = new Map(kakera.map((k) => [k.id, k.updated_at]));
  const resetKakera = new Set<string>();
  let resetTitle = false;
  const fresh: SegChoice[] = [];
  for (const r of rows) {
    if (r.scope === 'title') {
      if (r.basis !== title) {
        resetTitle = true;
        continue;
      }
      fresh.push({ seg: 'title', pos: r.pos, source: r.source, action: r.action, ...(r.text ? { text: r.text } : {}) });
    } else {
      if (r.basis !== updatedAt.get(r.ref_id)) {
        resetKakera.add(r.ref_id);
        continue;
      }
      fresh.push({ seg: r.ref_id, pos: r.pos, source: r.source, action: r.action, ...(r.text ? { text: r.text } : {}) });
    }
  }
  return {
    choices: validateChoices(dict, title, kakera, fresh),
    reset_kakera_ids: ids.filter((id) => resetKakera.has(id)),
    reset_title: resetTitle,
  };
}

/**
 * 選択を保存する（検め済みのものを渡す）。
 * このかたちのタイトルと、渡したかけらの選択を丸ごと入れ替える（選んでいないかけらの選択は残す）。
 */
export async function saveChoices(
  db: D1Database,
  katachiId: string,
  title: string,
  kakera: Kakera[],
  valid: SegChoice[]
): Promise<void> {
  const now = nowJst();
  const updatedAt = new Map(kakera.map((k) => [k.id, k.updated_at]));
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM name_choice WHERE scope = 'title' AND ref_id = ?").bind(katachiId),
    ...kakera.map((k) => db.prepare("DELETE FROM name_choice WHERE scope = 'kakera' AND ref_id = ?").bind(k.id)),
  ];
  for (const c of valid) {
    const isTitle = c.seg === 'title';
    const basis = isTitle ? title : updatedAt.get(c.seg);
    if (basis === undefined) continue;
    stmts.push(
      db
        .prepare(
          'INSERT INTO name_choice (scope, ref_id, pos, source, action, text, basis, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(isTitle ? 'title' : 'kakera', isTitle ? katachiId : c.seg, c.pos, c.source, c.action, c.text ?? null, basis, now)
    );
  }
  await db.batch(stmts);
}
