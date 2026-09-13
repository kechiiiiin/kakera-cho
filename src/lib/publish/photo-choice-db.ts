// 写真の「日記に出さない」選択の D1（migrations/0006_photo_choice.sql）。
// 実名を含まない（かけらの id と写真の key だけ）。

import type { Kakera } from '../kakera/types';
import { nowJst } from '../time';
import { validatePhotoChoices, type PhotoChoice } from './photo-choice';

interface PhotoChoiceRow {
  kakera_id: string;
  photo_key: string;
}

/**
 * 渡したかけらの「出さない」写真を読む。
 * 原本に今も実在する写真の key だけ返す（本文から消えた写真の行は、残っていても効かない）。
 */
export async function loadPhotoChoices(db: D1Database, kakera: Kakera[]): Promise<PhotoChoice[]> {
  const ids = kakera.map((k) => k.id);
  const rows: PhotoChoiceRow[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    if (!part.length) continue;
    const { results } = await db
      .prepare(
        `SELECT kakera_id, photo_key FROM photo_choice WHERE hidden = 1 AND kakera_id IN (${part.map(() => '?').join(',')})`
      )
      .bind(...part)
      .all<PhotoChoiceRow>();
    rows.push(...(results ?? []));
  }
  return validatePhotoChoices(
    kakera,
    rows.map((r) => ({ kakera_id: r.kakera_id, key: r.photo_key }))
  );
}

/**
 * 選択を保存する（validatePhotoChoices を通したものを渡す）。
 * 渡したかけらの「出さない」を丸ごと入れ替える（選んでいないかけらの選択は残す）。
 */
export async function savePhotoChoices(db: D1Database, kakera: Kakera[], valid: PhotoChoice[]): Promise<void> {
  const now = nowJst();
  const ids = new Set(kakera.map((k) => k.id));
  const stmts: D1PreparedStatement[] = kakera.map((k) =>
    db.prepare('DELETE FROM photo_choice WHERE kakera_id = ?').bind(k.id)
  );
  for (const c of valid) {
    if (!ids.has(c.kakera_id)) continue;
    stmts.push(
      db
        .prepare('INSERT OR REPLACE INTO photo_choice (kakera_id, photo_key, hidden, updated_at) VALUES (?, ?, 1, ?)')
        .bind(c.kakera_id, c.key, now)
    );
  }
  if (stmts.length) await db.batch(stmts);
}
