import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import {
  dissolveKatachi,
  getKatachiDetail,
  kakeraOfKatachi,
  saveKatachiDescription,
  updateKatachi,
  withCards,
} from '../../../lib/kakera/db';
import { DESCRIPTION_MAX, descriptionLength, flattenDescription } from '../../../lib/publish/diary-file';
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
 * PATCH /api/katachi/:id — {date?, title?, description?} ※date 変更は控えの改名も行う
 * description（日記の説明文・原本は実名のまま）は改行を空白に畳んで保存する。DESCRIPTION_MAX 字を超えたら 400。
 * ★description を変えても katachi.updated_at は進めない（日付か題が変わったときだけ進む）。
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
    let description: string | undefined;
    if (input.description !== undefined) {
      if (typeof input.description !== 'string') throw new ApiError(400, 'description は文字列で送ってください');
      description = flattenDescription(input.description);
      if (descriptionLength(description) > DESCRIPTION_MAX) {
        throw new ApiError(400, `説明は${DESCRIPTION_MAX}文字までにしてください`);
      }
    }
    if (input.order !== undefined) {
      throw new ApiError(400, 'かたちの並びは書いた順で決まるので、order は受け付けません（並びを組むのは日記にするときです）');
    }

    if (description !== undefined) await saveKatachiDescription(env.DB, id, description);
    const { detail, oldDate } = await updateKatachi(env.DB, id, {
      date: input.date as string | undefined,
      title: input.title === undefined ? undefined : (input.title as string).trim(),
    });

    // 日付が変わったら控えのファイルを改名する（旧ファイルを消す）。説明が変わったときも控えを書き直す（同じ関数で足りる）
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
