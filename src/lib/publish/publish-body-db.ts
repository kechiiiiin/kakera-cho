// 日記にだけ効く文章の微修正の D1（migrations/0008_publish_body.sql）。
// ⚠️ 書き換えた文章は実名を含みうるので D1 にだけ置く。控え（kakera-data）にもリポジトリにも書かない。
// ⚠️ ここから kakera の行（body / updated_at）を書き換えない。原本は触らない。

import type { Kakera } from '../kakera/types';
import { ApiError } from '../http';
import { getKakera, getKatachiRow } from '../kakera/db';
import { nowJst } from '../time';
import {
  applyPublishBodies,
  isPublishBodyStale,
  photoBasisOf,
  type PublishBody,
  type PublishBodyView,
} from './publish-body';

const IN_CHUNK = 90;

/** そのかたちの、渡したかけらの書き換え。 */
export async function loadPublishBodies(db: D1Database, katachiId: string, kakeraIds: string[]): Promise<PublishBody[]> {
  const ids = [...new Set(kakeraIds)];
  const out: PublishBody[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const part = ids.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(
        `SELECT kakera_id, body, basis, updated_at FROM publish_body
          WHERE katachi_id = ? AND kakera_id IN (${part.map(() => '?').join(',')})`
      )
      .bind(katachiId, ...part)
      .all<PublishBody>();
    out.push(...(results ?? []));
  }
  return out;
}

export interface PublishSet {
  /** 書き換えを当てたかけら（名前の置き換え・選択・公開版の本文に使う） */
  kakera: Kakera[];
  /** 写真の選択の突き合わせに使う本文（原本＋書き換え） */
  photoBasis: Kakera[];
  bodies: PublishBody[];
}

/** 日記に出すかけら（原本・並び順どおり）に、D1 に保存した書き換えを当てる。 */
export async function loadPublishSet(db: D1Database, katachiId: string, original: Kakera[]): Promise<PublishSet> {
  const bodies = await loadPublishBodies(
    db,
    katachiId,
    original.map((k) => k.id)
  );
  return { kakera: applyPublishBodies(original, bodies), photoBasis: photoBasisOf(original, bodies), bodies };
}

export function viewOf(k: Pick<Kakera, 'updated_at'>, pb: PublishBody): PublishBodyView {
  return { ...pb, stale: isPublishBodyStale(k.updated_at, pb) };
}

/** 書き換えの口で扱うかけら。かたちが無ければ 404、かけらが無ければ 404、そのかたちに入っていなければ 409。 */
export async function kakeraOfKatachiFor(db: D1Database, katachiId: string, kakeraId: string): Promise<Kakera> {
  const katachi = await getKatachiRow(db, katachiId);
  if (!katachi) throw new ApiError(404, 'そのかたちはありません');
  const k = await getKakera(db, kakeraId);
  if (!k) throw new ApiError(404, 'そのかけらはありません');
  if (k.katachi_id !== katachiId) throw new ApiError(409, 'そのかけらはこのかたちに入っていません');
  return k;
}

async function getPublishBody(db: D1Database, katachiId: string, kakeraId: string): Promise<PublishBody | null> {
  return await db
    .prepare('SELECT kakera_id, body, basis, updated_at FROM publish_body WHERE katachi_id = ? AND kakera_id = ?')
    .bind(katachiId, kakeraId)
    .first<PublishBody>();
}

/**
 * 書き換えを保存する（basis は今の kakera.updated_at）。
 * 原本と一字一句同じなら書き換えを持たない（行を消して null を返す＝原本のまま出す）。
 */
export async function savePublishBody(
  db: D1Database,
  katachiId: string,
  k: Kakera,
  body: string
): Promise<PublishBody | null> {
  if (body === k.body) {
    await deletePublishBody(db, katachiId, k.id);
    return null;
  }
  const now = nowJst();
  await db
    .prepare(
      `INSERT INTO publish_body (katachi_id, kakera_id, body, basis, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(katachi_id, kakera_id) DO UPDATE SET
         body = excluded.body, basis = excluded.basis,
         updated_at = CASE WHEN publish_body.body = excluded.body THEN publish_body.updated_at ELSE excluded.updated_at END`
    )
    .bind(katachiId, k.id, body, k.updated_at, now)
    .run();
  const row = await getPublishBody(db, katachiId, k.id);
  if (!row) throw new ApiError(500, '日記用の文を保存できませんでした');
  return row;
}

/** 「書き換えを使う」＝basis を今の kakera.updated_at に進める（文章と updated_at は変えない）。 */
export async function acceptPublishBody(db: D1Database, katachiId: string, k: Kakera): Promise<PublishBody> {
  const r = await db
    .prepare('UPDATE publish_body SET basis = ? WHERE katachi_id = ? AND kakera_id = ?')
    .bind(k.updated_at, katachiId, k.id)
    .run();
  if (!(r.meta?.changes ?? 0)) throw new ApiError(404, 'このかけらに日記用の書き換えはありません');
  const row = await getPublishBody(db, katachiId, k.id);
  if (!row) throw new ApiError(404, 'このかけらに日記用の書き換えはありません');
  return row;
}

/** 書き換えを捨てて原本に戻す。消したかどうかを返す（無くてもエラーにしない）。 */
export async function deletePublishBody(db: D1Database, katachiId: string, kakeraId: string): Promise<boolean> {
  const r = await db
    .prepare('DELETE FROM publish_body WHERE katachi_id = ? AND kakera_id = ?')
    .bind(katachiId, kakeraId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}
