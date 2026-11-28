// 移動の軌跡（migrations/0014・かけら帳1日のページ設計「追加: 移動の軌跡」・2026-11-28）。
// iOS が大きな位置の変化（significant location change）と訪問（CLVisit）で採った点を、まとめて受けて D1 に置く。
// ★既存の表には触らない。控え（kakera-data）と書き出し（/api/export）には載せない（自宅の座標が大量に乗るため）。

import { z } from 'zod';
import { ApiError } from '../http';
import { FUTURE_TOLERANCE_MS, isWrittenAt, normalizeToJst, nowJst } from '../time';
import { isUlid } from '../ulid';

export const TRACK_SOURCES = ['slc', 'visit'] as const;
export type TrackSource = (typeof TRACK_SOURCES)[number];

/** 1回の POST で受ける点の上限。端末は溜めた点をこの数ずつ区切って送る（iOS の Kiseki.swift と同じ値） */
export const TRACK_BATCH_MAX = 500;

export interface TrackPointIn {
  id: string;
  /** ISO8601（+09:00 付き・秒まで） */
  at: string;
  lat: number;
  lng: number;
  /** 水平の精度（メートル）。取れなければ null */
  accuracy: number | null;
  source: TrackSource;
}

export interface TrackPoint extends TrackPointIn {
  created_at: string;
}

function pointSchema(nowMs: number) {
  return z
    .object({
      id: z.string().refine(isUlid, 'id は ULID で送ってください'),
      at: z
        .string()
        .refine(isWrittenAt, 'at はオフセット付きの ISO8601 で送ってください')
        .refine((s) => !Number.isNaN(new Date(s).getTime()), 'at が日時として読めません')
        .refine((s) => new Date(s).getTime() <= nowMs + FUTURE_TOLERANCE_MS, '未来の日時にはできません')
        .transform((s) => normalizeToJst(s)),
      lat: z.number().finite().min(-90).max(90),
      lng: z.number().finite().min(-180).max(180),
      accuracy: z.number().finite().min(0).nullable().optional(),
      source: z.enum(TRACK_SOURCES),
    })
    .transform((p): TrackPointIn => ({ ...p, accuracy: p.accuracy ?? null }));
}

/** POST /api/track — {points: [{id, at, lat, lng, accuracy?, source}]}（1〜TRACK_BATCH_MAX 点）。1点でも形が違えば 400 */
export function parseTrackPost(input: unknown, nowMs: number = Date.now()): TrackPointIn[] {
  const schema = z.object({
    points: z
      .array(pointSchema(nowMs))
      .min(1, '点が空です')
      .max(TRACK_BATCH_MAX, `点は1回に${TRACK_BATCH_MAX}までです`),
  });
  const r = schema.safeParse(input);
  if (r.success) return r.data.points;
  const issue = r.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new ApiError(400, `${where}${issue?.message ?? '形が違います'}`);
}

/** 点をまとめて入れる。同じ id（もうあるもの・同じ送りの中の重複）は黙って飛ばす → 入った数と飛ばした数 */
export async function insertTrackPoints(db: D1Database, points: TrackPointIn[]): Promise<{ added: number; skipped: number }> {
  const now = nowJst();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO track_point (id, at, lat, lng, accuracy, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const results = await db.batch(points.map((p) => stmt.bind(p.id, p.at, p.lat, p.lng, p.accuracy, p.source, now)));
  const added = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  return { added, skipped: points.length - added };
}

/** その日（JST の 0:00〜23:59:59）の点を時刻順（同時刻は id 順）。place・かけらと同じ境目 */
export async function listTrackOn(db: D1Database, date: string): Promise<TrackPoint[]> {
  const { results } = await db
    .prepare(
      'SELECT id, at, lat, lng, accuracy, source, created_at FROM track_point WHERE at >= ? AND at < ? ORDER BY at, id'
    )
    .bind(`${date}T00:00`, `${date}T24:00`)
    .all<TrackPoint>();
  return results;
}
