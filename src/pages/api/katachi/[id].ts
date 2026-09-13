import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import {
  dissolveKatachi,
  getKatachiDetail,
  kakeraOfKatachi,
  updateKatachi,
  withCards,
} from '../../../lib/kakera/db';
import { isDateKey } from '../../../lib/time';
import { syncKatachiDissolved, syncKatachiRenamed } from '../../../lib/backup/sync';

export const prerender = false;

/** GET /api/katachi/:id — かたち1つ＋中のかけら */
export const GET: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    return json(await withCards(env.DB, await getKatachiDetail(env.DB, params.id)));
  });

/**
 * PATCH /api/katachi/:id — {date?, title?} ※date 変更は控えの改名も行う
 * ★order は受け付けない（400）。かたちの中の並びは常に書いた順（migrations/0005）。
 *   黙って無視すると、古い呼び手が「並べ替えた」と思い込むので断る。
 */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);

    if (input.date !== undefined && !isDateKey(input.date)) {
      throw new ApiError(400, 'date は YYYY-MM-DD で送ってください');
    }
    if (input.title !== undefined && typeof input.title !== 'string') {
      throw new ApiError(400, 'title は文字列で送ってください');
    }
    if (input.order !== undefined) {
      throw new ApiError(400, 'かたちの並びは書いた順で決まるので、order は受け付けません（並びを組むのは日記にするときです）');
    }

    const { detail, oldDate } = await updateKatachi(env.DB, id, {
      date: input.date as string | undefined,
      title: input.title === undefined ? undefined : (input.title as string).trim(),
    });

    // 日付が変わったら控えのファイルを改名する（旧ファイルを消す）
    waitUntil(syncKatachiRenamed(env, id, oldDate));
    return json(await withCards(env.DB, detail));
  });

/**
 * DELETE /api/katachi/:id — 解く（中のかけらはかけらたちへ戻る）
 * ★nikki に行があれば 409（db 側で弾く）。
 */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');

    const inside = await kakeraOfKatachi(env.DB, id);
    const katachi = await dissolveKatachi(env.DB, id);
    waitUntil(
      syncKatachiDissolved(
        env,
        katachi.date,
        inside.map((k) => ({ ...k, katachi_id: null }))
      )
    );
    return json({ ok: true });
  });
