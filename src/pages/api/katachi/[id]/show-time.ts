import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { getKatachiDetail, setShowTime, withCards } from '../../../../lib/kakera/db';

export const prerender = false;

/**
 * PUT /api/katachi/:id/show-time — {kakera_ids[], show: boolean}
 * かたちの中のかけらに「時刻を出す」を付ける／外す（かけら時刻表示設計・2026-10-12）。
 * 1枚でも「全部に付ける／全部外す」でも同じ口を使う。
 * ★katachi_kakera.show_time だけを書く。kakera・katachi の updated_at、nikki_kakera、控えには触らない。
 * ★公開中の日記は即座に書き直さない（次に書き出したときに反映する）。
 * このかたちに無いかけらの id が混ざっていたら 404。戻りは GET /api/katachi/:id と同じ形。
 */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const ids = input.kakera_ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string' && x)) {
      throw new ApiError(400, 'kakera_ids は id の配列で送ってください');
    }
    if (typeof input.show !== 'boolean') throw new ApiError(400, 'show は true か false で送ってください');

    await setShowTime(env.DB, id, ids as string[], input.show);
    return json(await withCards(env.DB, await getKatachiDetail(env.DB, id)));
  });
