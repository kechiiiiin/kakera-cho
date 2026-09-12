// D1 への問い合わせ。ここがドメインの処理の入口で、API ルートは薄い殻にする（iOS から同じ API を使うため）。

import type { Kakera, Katachi, KatachiDetail, KatachiSummary, Nikki } from './types';
import { textForExcerpt } from '../markdown';
import { nowJst } from '../time';
import { ApiError } from '../http';

/** かけらの流れ（まだかたちになっていないものだけ・新しい順）。 */
export async function listNagare(db: D1Database): Promise<Kakera[]> {
  const { results } = await db
    .prepare('SELECT * FROM kakera WHERE katachi_id IS NULL ORDER BY written_at DESC')
    .all<Kakera>();
  return results ?? [];
}

export async function getKakera(db: D1Database, id: string): Promise<Kakera | null> {
  return await db.prepare('SELECT * FROM kakera WHERE id = ?').bind(id).first<Kakera>();
}

export async function insertKakera(
  db: D1Database,
  k: { id: string; body: string; written_at: string }
): Promise<Kakera> {
  const now = nowJst();
  const existing = await getKakera(db, k.id);
  if (existing) throw new ApiError(409, 'その id のかけらはもうあります');
  await db
    .prepare(
      'INSERT INTO kakera (id, body, written_at, katachi_id, sort_order, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)'
    )
    .bind(k.id, k.body, k.written_at, now)
    .run();
  return { ...k, katachi_id: null, sort_order: null, updated_at: now };
}

/** 本文だけを直す。written_at は不変なので絶対に触らない。 */
export async function updateKakeraBody(db: D1Database, id: string, body: string): Promise<Kakera> {
  const now = nowJst();
  const res = await db
    .prepare('UPDATE kakera SET body = ?, updated_at = ? WHERE id = ?')
    .bind(body, now, id)
    .run();
  if (!res.meta.changes) throw new ApiError(404, 'そのかけらはありません');
  const k = await getKakera(db, id);
  if (!k) throw new ApiError(404, 'そのかけらはありません');
  return k;
}

/**
 * かけらを物理削除する。
 * ⚠️ DDL に外部キーを張っていないので、nikki_kakera の行はアプリ側で必ず消す（設計 §3）。
 */
export async function deleteKakera(db: D1Database, id: string): Promise<Kakera> {
  const k = await getKakera(db, id);
  if (!k) throw new ApiError(404, 'そのかけらはありません');
  await db.batch([
    db.prepare('DELETE FROM nikki_kakera WHERE kakera_id = ?').bind(id),
    db.prepare('DELETE FROM kakera WHERE id = ?').bind(id),
  ]);
  return k;
}

/* ---------------- かたち ---------------- */

export async function listKatachi(db: D1Database): Promise<KatachiSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT k.*,
              (SELECT 1 FROM nikki n WHERE n.katachi_id = k.id) AS has_nikki,
              (SELECT f.body FROM kakera f WHERE f.katachi_id = k.id
                 ORDER BY f.sort_order LIMIT 1) AS lead_body
         FROM katachi k
        ORDER BY k.date DESC`
    )
    .all<Katachi & { has_nikki: number | null; lead_body: string | null }>();
  return (results ?? []).map((r) => ({
    id: r.id,
    date: r.date,
    title: r.title,
    updated_at: r.updated_at,
    has_nikki: !!r.has_nikki,
    lead: textForExcerpt(r.lead_body ?? ''),
  }));
}

// 三つ目のタブ（日記）は has_nikki で絞れるので、専用の取得は作らない。

export async function getKatachiRow(db: D1Database, id: string): Promise<Katachi | null> {
  return await db.prepare('SELECT * FROM katachi WHERE id = ?').bind(id).first<Katachi>();
}

export async function getNikkiRow(db: D1Database, katachiId: string): Promise<Nikki | null> {
  return await db.prepare('SELECT * FROM nikki WHERE katachi_id = ?').bind(katachiId).first<Nikki>();
}

/** かたちの中のかけら（並び順）。 */
export async function kakeraOfKatachi(db: D1Database, katachiId: string): Promise<Kakera[]> {
  const { results } = await db
    .prepare('SELECT * FROM kakera WHERE katachi_id = ? ORDER BY sort_order')
    .bind(katachiId)
    .all<Kakera>();
  return results ?? [];
}

export async function getKatachiDetail(db: D1Database, id: string): Promise<KatachiDetail> {
  const katachi = await getKatachiRow(db, id);
  if (!katachi) throw new ApiError(404, 'そのかたちはありません');
  const [kakera, nikki, published] = await Promise.all([
    kakeraOfKatachi(db, id),
    getNikkiRow(db, id),
    db
      .prepare('SELECT kakera_id FROM nikki_kakera WHERE katachi_id = ? ORDER BY position')
      .bind(id)
      .all<{ kakera_id: string }>(),
  ]);
  return {
    katachi,
    kakera,
    nikki,
    published_ids: (published.results ?? []).map((r) => r.kakera_id),
  };
}

/** かたちを作る。1日1かたちなので、同じ日付が既にあれば 409。 */
export async function createKatachi(
  db: D1Database,
  input: { id: string; date: string; title: string; kakera_ids: string[] }
): Promise<KatachiDetail> {
  const now = nowJst();
  const dup = await db.prepare('SELECT id FROM katachi WHERE date = ?').bind(input.date).first<{ id: string }>();
  if (dup) throw new ApiError(409, `${input.date} のかたちはもうあります（1日にひとつです）`);

  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO katachi (id, date, title, updated_at) VALUES (?, ?, ?, ?)')
      .bind(input.id, input.date, input.title, now),
  ];
  input.kakera_ids.forEach((kid, i) => {
    // 未かたちのものだけを取り込む（二重取り込みの防止）
    stmts.push(
      db
        .prepare(
          'UPDATE kakera SET katachi_id = ?, sort_order = ?, updated_at = ? WHERE id = ? AND katachi_id IS NULL'
        )
        .bind(input.id, (i + 1) * 100, now, kid)
    );
  });
  await db.batch(stmts);
  return await getKatachiDetail(db, input.id);
}

export async function updateKatachi(
  db: D1Database,
  id: string,
  patch: { date?: string; title?: string; order?: string[] }
): Promise<{ detail: KatachiDetail; oldDate: string }> {
  const before = await getKatachiRow(db, id);
  if (!before) throw new ApiError(404, 'そのかたちはありません');
  const now = nowJst();

  if (patch.date !== undefined && patch.date !== before.date) {
    const dup = await db
      .prepare('SELECT id FROM katachi WHERE date = ? AND id != ?')
      .bind(patch.date, id)
      .first<{ id: string }>();
    if (dup) throw new ApiError(409, `${patch.date} のかたちはもうあります（1日にひとつです）`);
  }

  const stmts: D1PreparedStatement[] = [
    db
      .prepare('UPDATE katachi SET date = ?, title = ?, updated_at = ? WHERE id = ?')
      .bind(patch.date ?? before.date, patch.title ?? before.title, now, id),
  ];
  if (patch.order) {
    patch.order.forEach((kid, i) => {
      stmts.push(
        db
          .prepare('UPDATE kakera SET sort_order = ?, updated_at = ? WHERE id = ? AND katachi_id = ?')
          .bind((i + 1) * 100, now, kid, id)
      );
    });
  }
  await db.batch(stmts);
  return { detail: await getKatachiDetail(db, id), oldDate: before.date };
}

/**
 * かたちを解く。中のかけらは流れに戻る。
 * ★日記になったかたちは解けない（astro-blog に記事だけ残って管理から外れるため・設計 §3）。
 */
export async function dissolveKatachi(db: D1Database, id: string): Promise<Katachi> {
  const katachi = await getKatachiRow(db, id);
  if (!katachi) throw new ApiError(404, 'そのかたちはありません');
  const nikki = await getNikkiRow(db, id);
  if (nikki) throw new ApiError(409, '日記になったかたちは解けません');

  const now = nowJst();
  await db.batch([
    db
      .prepare('UPDATE kakera SET katachi_id = NULL, sort_order = NULL, updated_at = ? WHERE katachi_id = ?')
      .bind(now, id),
    db.prepare('DELETE FROM nikki_kakera WHERE katachi_id = ?').bind(id),
    db.prepare('DELETE FROM katachi WHERE id = ?').bind(id),
  ]);
  return katachi;
}

/** かけら1枚をかたちから外して流れへ戻す（日記の有無にかかわらず可）。 */
export async function detachKakera(db: D1Database, katachiId: string, kakeraId: string): Promise<Kakera> {
  const k = await getKakera(db, kakeraId);
  if (!k || k.katachi_id !== katachiId) throw new ApiError(404, 'そのかたちにそのかけらはありません');
  const now = nowJst();
  await db.batch([
    db
      .prepare('UPDATE kakera SET katachi_id = NULL, sort_order = NULL, updated_at = ? WHERE id = ?')
      .bind(now, kakeraId),
    db
      .prepare('DELETE FROM nikki_kakera WHERE katachi_id = ? AND kakera_id = ?')
      .bind(katachiId, kakeraId),
  ]);
  return { ...k, katachi_id: null, sort_order: null, updated_at: now };
}

/** 日記にした記録を書く（毎回組み直すので、出したかけらは丸ごと入れ替える）。 */
export async function recordNikki(
  db: D1Database,
  katachiId: string,
  slug: string,
  kakeraIds: string[]
): Promise<void> {
  const now = nowJst();
  const existing = await getNikkiRow(db, katachiId);
  const stmts: D1PreparedStatement[] = [
    existing
      ? db
          .prepare('UPDATE nikki SET slug = ?, updated_at = ? WHERE katachi_id = ?')
          .bind(slug, now, katachiId)
      : db
          .prepare('INSERT INTO nikki (katachi_id, slug, published_at, updated_at) VALUES (?, ?, ?, ?)')
          .bind(katachiId, slug, now, now),
    db.prepare('DELETE FROM nikki_kakera WHERE katachi_id = ?').bind(katachiId),
  ];
  kakeraIds.forEach((kid, i) => {
    stmts.push(
      db
        .prepare('INSERT INTO nikki_kakera (katachi_id, kakera_id, position) VALUES (?, ?, ?)')
        .bind(katachiId, kid, i + 1)
    );
  });
  await db.batch(stmts);
}
