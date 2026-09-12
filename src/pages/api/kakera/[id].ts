import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { deleteKakera, updateKakeraBody } from '../../../lib/kakera/db';
import { syncKakera, syncKakeraDeleted } from '../../../lib/backup/sync';

export const prerender = false;

/** PATCH /api/kakera/:id — {body} ※written_at は不変なので受け取らない */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    if (typeof input.body !== 'string' || !input.body.trim()) throw new ApiError(400, '本文が空です');

    const kakera = await updateKakeraBody(env.DB, id, input.body.trim());
    waitUntil(syncKakera(env, kakera));
    return json({ kakera });
  });

/** DELETE /api/kakera/:id — 物理削除＋控えのファイルも削除 */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');

    const kakera = await deleteKakera(env.DB, id);
    waitUntil(syncKakeraDeleted(env, kakera));
    return json({ ok: true });
  });
