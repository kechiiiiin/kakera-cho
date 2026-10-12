// 写真の顔の枠の D1（migrations/0011_photo_face.sql）。
// 実名を含まない（写真の key と枠の位置だけ）。

import { nowJst } from '../time';
import {
  FACE_MODEL,
  faceFingerprint,
  isFacePhotoKey,
  maskedKeyFor,
  type PhotoFace,
  type PhotoFaceState,
} from './photo-face';

interface FaceRow {
  photo_key: string;
  face_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  source: 'auto' | 'manual';
  shown: number;
}

/**
 * 写真の key → {検出が済んだか, 枠}（並びは face_id 順）。顔モザイクの対象でない key は入れない。
 * 「済んだ」は**今の FACE_MODEL で**調べた印があるときだけ（2026-10-12 再レビューで変更）。版違いは未検出として扱う。
 * 検出は画面で「顔を探す」を押したときだけ（2026-10-12 §2.1 で変更。自動の枠は見つけ直した顔で入れ替わり、手で足した枠は残す）。
 * 「済んだ」は記録として持つだけで、書き出しの条件には使わない（版違いで残っている枠も、隠す枠ならそのまま効く）。
 */
export async function loadFaces(db: D1Database, keys: string[]): Promise<Map<string, { scanned: boolean; faces: PhotoFace[] }>> {
  const list = [...new Set(keys.filter(isFacePhotoKey))];
  const out = new Map<string, { scanned: boolean; faces: PhotoFace[] }>();
  for (const k of list) out.set(k, { scanned: false, faces: [] });
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const marks = part.map(() => '?').join(',');
    const [scans, faces] = await db.batch([
      // 版の違うモデルで調べた写真は未検出として扱う
      db.prepare(`SELECT photo_key FROM photo_face_scan WHERE model = ? AND photo_key IN (${marks})`).bind(FACE_MODEL, ...part),
      db
        .prepare(
          `SELECT photo_key, face_id, x, y, w, h, source, shown FROM photo_face WHERE photo_key IN (${marks}) ORDER BY photo_key, face_id`
        )
        .bind(...part),
    ]);
    for (const r of (scans!.results ?? []) as { photo_key: string }[]) out.get(r.photo_key)!.scanned = true;
    for (const r of (faces!.results ?? []) as FaceRow[]) {
      out.get(r.photo_key)?.faces.push({
        id: r.face_id,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        source: r.source,
        shown: r.shown === 1,
      });
    }
  }
  return out;
}

/** 画面へ返す形（指紋と、いまの指紋に合うモザイク済みの版があるか）。 */
export async function faceStates(db: D1Database, photos: R2Bucket | undefined, keys: string[]): Promise<PhotoFaceState[]> {
  const rows = await loadFaces(db, keys);
  const out: PhotoFaceState[] = [];
  for (const [key, r] of rows) {
    const fp = await faceFingerprint(r.faces);
    const masked = !!(fp && photos && (await photos.head(maskedKeyFor(key, fp))));
    out.push({ key, scanned: r.scanned, faces: r.faces, fp, masked });
  }
  return out;
}

/**
 * 写真 1 枚の枠を丸ごと入れ替える（parseFaces を通したものを渡す）。
 * model を渡すと「検出が済んだ」印も付ける（顔が 0 件でも）。
 */
export async function saveFaces(db: D1Database, key: string, faces: PhotoFace[], model?: string): Promise<void> {
  const now = nowJst();
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM photo_face WHERE photo_key = ?').bind(key)];
  for (const f of faces) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO photo_face (photo_key, face_id, x, y, w, h, source, shown, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(key, f.id, f.x, f.y, f.w, f.h, f.source, f.shown ? 1 : 0, now)
    );
  }
  if (model) {
    stmts.push(
      db.prepare('INSERT OR REPLACE INTO photo_face_scan (photo_key, model, scanned_at) VALUES (?, ?, ?)').bind(key, model, now)
    );
  }
  await db.batch(stmts);
}

/** 今の FACE_MODEL で検出が済んでいるか（版違いは済んでいない）。 */
export async function isScanned(db: D1Database, key: string): Promise<boolean> {
  return !!(await db
    .prepare('SELECT 1 AS n FROM photo_face_scan WHERE photo_key = ? AND model = ?')
    .bind(key, FACE_MODEL)
    .first());
}
