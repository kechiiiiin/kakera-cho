import type { APIRoute } from 'astro';
import { ApiError, handle, json } from '../../../../../lib/http';
import { ctxOf } from '../../../../../lib/ctx';
import { detachKakera } from '../../../../../lib/kakera/db';
import { syncKakeraDetached } from '../../../../../lib/backup/sync';

export const prerender = false;

/**
 * DELETE /api/katachi/:id/kakera/:kid — かけら1枚をかたちから外して流れへ戻す。
 * 日記の有無にかかわらず可。次に日記にしたときに反映される（組み直し方式なので公開版から消える）。
 */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const { id, kid } = params;
    if (!id || !kid) throw new ApiError(400, 'id がありません');

    const kakera = await detachKakera(env.DB, id, kid);
    waitUntil(syncKakeraDetached(env, id, kakera));
    return json({ kakera });
  });
