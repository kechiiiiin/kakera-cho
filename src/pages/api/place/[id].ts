import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { parsePlacePatch } from '../../../lib/kakera/day-input';
import { deletePlace, updatePlace } from '../../../lib/kakera/day-db';
import { syncDays } from '../../../lib/backup/day';

export const prerender = false;

/** PATCH /api/place/:id — {at?, name?, lat?+lng?}（座標は組で・null で外す）→ {place}。日が変わったら前後の日の控えを書き直す */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const { place, before } = await updatePlace(env.DB, id, parsePlacePatch(await readJson(request)));
    waitUntil(syncDays(env, [before.at.slice(0, 10), place.at.slice(0, 10)]));
    return json({ place });
  });

/** DELETE /api/place/:id — 物理削除 → {ok: true} */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const place = await deletePlace(env.DB, id);
    waitUntil(syncDays(env, [place.at.slice(0, 10)]));
    return json({ ok: true });
  });
