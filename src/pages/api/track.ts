import type { APIRoute } from 'astro';
import { handle, json, readJson } from '../../lib/http';
import { ctxOf } from '../../lib/ctx';
import { parseDateParam } from '../../lib/kakera/day-input';
import { insertTrackPoints, listTrackOn, parseTrackPost } from '../../lib/kakera/track';

export const prerender = false;

/** GET /api/track?date=YYYY-MM-DD — その日（JST）の軌跡の点（時刻順）→ {points}（かけら帳1日のページ設計「追加: 移動の軌跡」） */
export const GET: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const date = parseDateParam(url.searchParams.get('date'));
    return json({ points: await listTrackOn(env.DB, date) });
  });

/**
 * POST /api/track — {points: [{id(ULID・端末採番), at(+09:00 付き), lat, lng, accuracy?, source: slc|visit}]} → {added, skipped}
 * 1回に TRACK_BATCH_MAX 点まで。同じ id は黙って飛ばす（端末が送り直しても二重にならない）。控えには書かない。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    return json(await insertTrackPoints(env.DB, parseTrackPost(await readJson(request))));
  });
