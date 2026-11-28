// 1日のページの D1（migrations/0013・かけら帳1日のページ設計・段階1）。気分（day）・場所（place）・一覧から外した印（timeline_hidden）。
// ★既存の表（kakera など）には触らない。かけらは今までどおり listKakeraOn（db.ts）で引き、画面が場所と時刻順に混ぜる。
//
// その日（JST）の決め方はかけらと同じ: at は必ず +09:00 で保存するので、先頭10文字がそのまま JST の日付になる。

import { ApiError } from '../http';
import { nowJst } from '../time';
import type { HiddenKey, HiddenKind, Mood, PlaceCreate, PlacePatch, PlaceSource } from './day-input';

export interface Day {
  date: string;
  /** 外した・まだ押していない日は null */
  mood: Mood | null;
  /** 行が無い（一度も押していない）日は null */
  updated_at: string | null;
}

export interface Place {
  id: string;
  /** ISO8601（+09:00 付き） */
  at: string;
  name: string;
  lat: number | null;
  lng: number | null;
  source: PlaceSource;
  created_at: string;
  updated_at: string;
}

export interface TimelineHidden {
  kind: HiddenKind;
  ref: string;
  date: string;
  created_at: string;
}

/** at の範囲でその日（JST の 0:00〜23:59:59）を引く。listKakeraOn と同じ境目 */
function dayBounds(date: string): [string, string] {
  return [`${date}T00:00`, `${date}T24:00`];
}

/* ---------------- 気分 ---------------- */

export async function getDay(db: D1Database, date: string): Promise<Day> {
  const row = await db.prepare('SELECT date, mood, updated_at FROM day WHERE date = ?').bind(date).first<Day>();
  return row ?? { date, mood: null, updated_at: null };
}

/** 気分を付ける・外す（null）。行は残す（外した日も updated_at を持つ） */
export async function putDayMood(db: D1Database, date: string, mood: Mood | null): Promise<Day> {
  const now = nowJst();
  await db
    .prepare(
      `INSERT INTO day (date, mood, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET mood = excluded.mood, updated_at = excluded.updated_at`
    )
    .bind(date, mood, now)
    .run();
  return { date, mood, updated_at: now };
}

/* ---------------- 場所 ---------------- */

const PLACE_COLUMNS = 'id, at, name, lat, lng, source, created_at, updated_at';

/** その日（JST）の場所（時刻順・同時刻は id 順） */
export async function listPlacesOn(db: D1Database, date: string): Promise<Place[]> {
  const [from, to] = dayBounds(date);
  const { results } = await db
    .prepare(`SELECT ${PLACE_COLUMNS} FROM place WHERE at >= ? AND at < ? ORDER BY at, id`)
    .bind(from, to)
    .all<Place>();
  return results ?? [];
}

export async function getPlace(db: D1Database, id: string): Promise<Place | null> {
  return await db.prepare(`SELECT ${PLACE_COLUMNS} FROM place WHERE id = ?`).bind(id).first<Place>();
}

export async function insertPlace(db: D1Database, p: PlaceCreate): Promise<Place> {
  if (await getPlace(db, p.id)) throw new ApiError(409, 'その id の場所はもうあります');
  const now = nowJst();
  await db
    .prepare(`INSERT INTO place (${PLACE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.id, p.at, p.name, p.lat, p.lng, p.source, now, now)
    .run();
  return { ...p, created_at: now, updated_at: now };
}

/** 直す。控えの日が変わるかもしれないので、直す前の場所も返す */
export async function updatePlace(db: D1Database, id: string, patch: PlacePatch): Promise<{ place: Place; before: Place }> {
  const before = await getPlace(db, id);
  if (!before) throw new ApiError(404, 'その場所はありません');
  const next: Place = {
    ...before,
    at: patch.at ?? before.at,
    name: patch.name ?? before.name,
    lat: patch.lat !== undefined ? patch.lat : before.lat,
    lng: patch.lat !== undefined ? (patch.lng ?? null) : before.lng,
    updated_at: nowJst(),
  };
  await db
    .prepare('UPDATE place SET at = ?, name = ?, lat = ?, lng = ?, updated_at = ? WHERE id = ?')
    .bind(next.at, next.name, next.lat, next.lng, next.updated_at, id)
    .run();
  return { place: next, before };
}

export async function deletePlace(db: D1Database, id: string): Promise<Place> {
  const p = await getPlace(db, id);
  if (!p) throw new ApiError(404, 'その場所はありません');
  await db.prepare('DELETE FROM place WHERE id = ?').bind(id).run();
  return p;
}

/* ---------------- 一覧から外した予定・写真 ---------------- */

export async function listHiddenOn(db: D1Database, date: string): Promise<TimelineHidden[]> {
  const { results } = await db
    .prepare('SELECT kind, ref, date, created_at FROM timeline_hidden WHERE date = ? ORDER BY created_at, kind, ref')
    .bind(date)
    .all<TimelineHidden>();
  return results ?? [];
}

/** 外す。同じものをもう一度外しても1行のまま（日付は新しいほうに寄せる） */
export async function addHidden(db: D1Database, h: HiddenKey & { date: string }): Promise<TimelineHidden> {
  const now = nowJst();
  await db
    .prepare(
      `INSERT INTO timeline_hidden (kind, ref, date, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, ref) DO UPDATE SET date = excluded.date`
    )
    .bind(h.kind, h.ref, h.date, now)
    .run();
  const row = await db
    .prepare('SELECT kind, ref, date, created_at FROM timeline_hidden WHERE kind = ? AND ref = ?')
    .bind(h.kind, h.ref)
    .first<TimelineHidden>();
  return row ?? { ...h, created_at: now };
}

/** 外した印を戻す（一覧に戻る）。もう無ければ removed: false（失敗にしない） */
export async function removeHidden(db: D1Database, h: HiddenKey): Promise<{ removed: boolean }> {
  const res = await db.prepare('DELETE FROM timeline_hidden WHERE kind = ? AND ref = ?').bind(h.kind, h.ref).run();
  return { removed: (res.meta.changes ?? 0) > 0 };
}
