// 公開名変換の辞書の D1（migrations/0003_name_map.sql）と、日記の組み立てに共通の小道具。
// ⚠️ 辞書は置き換え元（実名）を含むので、D1 にだけ置く。控え（kakera-data）にもリポジトリにも書かない。
// 名前の選択と文書は names/doc-db.ts（0009 の name_doc・name_ref）。

import type { Kakera, KatachiDetail } from '../kakera/types';
import { ApiError } from '../http';
import { nowJst } from '../time';
import { ulid } from '../ulid';
import type { NameEntry } from './replace';

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
 * 項目を直す。記号方式では選択の行を消さない（次に文書を読んだとき、辞書の印の違いで同期が整える）。
 * 置き換え先を変えただけなら文書は作り直さず、解くたびに今の置き換え先を引く（保存済みの日記用の文にも効く）。
 */
export async function updateNameEntry(
  db: D1Database,
  id: string,
  e: { source: string; target: string }
): Promise<NameEntry> {
  const before = await db.prepare('SELECT id FROM name_map WHERE id = ?').bind(id).first<{ id: string }>();
  if (!before) throw new ApiError(404, 'その項目はありません');
  await assertSourceFree(db, e.source, id);
  const now = nowJst();
  await db.prepare('UPDATE name_map SET source = ?, target = ?, updated_at = ? WHERE id = ?').bind(e.source, e.target, now, id).run();
  return { id, source: e.source, target: e.target, updated_at: now };
}

/** 項目を消す。選択の行は消さない（同期で、辞書どおりだった箇所は実名に戻り、手で直した言葉は残る）。 */
export async function deleteNameEntry(db: D1Database, id: string): Promise<void> {
  const r = await db.prepare('DELETE FROM name_map WHERE id = ?').bind(id).run();
  if (!(r.meta?.changes ?? 0)) throw new ApiError(404, 'その項目はありません');
}

/* ---------------- 日記の組み立て ---------------- */

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
