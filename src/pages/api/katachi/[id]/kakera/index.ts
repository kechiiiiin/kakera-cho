import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../../lib/http';
import { ctxOf } from '../../../../../lib/ctx';
import { addKakeraToKatachi, getKatachiDetail, withCards } from '../../../../../lib/kakera/db';
import { syncKakeraAdded } from '../../../../../lib/backup/sync';

export const prerender = false;

/**
 * POST /api/katachi/:id/kakera — {kakera_ids[]} 既にあるかたちへ、かけらを足す。
 * 並びは書いた順（既存の並びは崩さず中間値で差し込む）。日記済みのかたちにも足せる。
 * ★足せるのはどのかたちにも入っていないかけらだけ（無い id は 404・入っているものは 409）。
 * ★kakera・katachi の行（updated_at）と nikki_kakera には触らない。
 * 戻りは GET /api/katachi/:id と同じ形。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const ids = input.kakera_ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string' && x)) {
      throw new ApiError(400, 'kakera_ids は id の配列で送ってください');
    }

    const added = await addKakeraToKatachi(env.DB, id, ids as string[]);
    // 控え: kakera/ から katachi/ へ移す（裏で）
    waitUntil(syncKakeraAdded(env, id, added));
    return json(await withCards(env.DB, await getKatachiDetail(env.DB, id)));
  });
