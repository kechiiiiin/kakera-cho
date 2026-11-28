import type { APIRoute } from 'astro';
import { handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { parseDateParam, parsePlaceCreate } from '../../../lib/kakera/day-input';
import { insertPlace, listPlacesOn } from '../../../lib/kakera/day-db';
import { syncDays } from '../../../lib/backup/day';

export const prerender = false;

/** GET /api/place?date=YYYY-MM-DD — その日（JST）の場所（時刻順）→ {places}（かけら帳1日のページ設計・段階1） */
export const GET: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const date = parseDateParam(url.searchParams.get('date'));
    return json({ places: await listPlacesOn(env.DB, date) });
  });

/**
 * POST /api/place — {id(ULID・端末採番), at(+09:00 付き), name, lat?, lng?, source?: manual|visit} → 201 {place}
 * 座標は端末でジオコーディングしたもの。取れなければ送らない（両方 null）。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const place = await insertPlace(env.DB, parsePlaceCreate(await readJson(request)));
    waitUntil(syncDays(env, [place.at.slice(0, 10)]));
    return json({ place }, 201);
  });
