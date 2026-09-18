import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import {
  dissolveKatachi,
  getKatachiDetail,
  getKatachiRow,
  getNikkiRow,
  kakeraOfKatachi,
  saveKatachiDescription,
  updateKatachi,
  withCards,
} from '../../../lib/kakera/db';
import { DESCRIPTION_MAX, descriptionLength, flattenDescription } from '../../../lib/publish/diary-file';
import { isDateKey } from '../../../lib/time';
import { syncKatachiDissolved, syncKatachiRenamed } from '../../../lib/backup/sync';
import { ensureCards } from '../../../lib/card/ensure';
import { moveNikkiDate } from '../../../lib/publish/nikki-move';

export const prerender = false;

/** GET /api/katachi/:id — かたち1つ＋中のかけら */
export const GET: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const detail = await getKatachiDetail(env.DB, params.id);
    // かたちを開いたときも、まだ無いカードを裏で取りに行く（応答は待たせない）。
    // 保存時の取得に漏れた URL が、次に開き直したとき自然にカードになるように。
    waitUntil(ensureCards(env, detail.kakera.map((k) => k.body)));
    return json(await withCards(env.DB, detail));
  });

/**
 * PATCH /api/katachi/:id — {date?, title?, description?, move_nikki?} ※date 変更は控えの改名も行う
 * ★日記になったかたちの date 変更は、公開中の日記の日付と URL も移す（lib/publish/nikki-move.ts）。
 *   move_nikki: true（画面で「公開中の日記も変わる」を確かめた印）が無ければ 409。
 *   astro-blog に書けなければ D1 も元に戻して止まる（日付は変わらない）。
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

    // 日記になったかたちの日付を変えるときは、先に公開中の日記ごと移す（失敗したら何も変えずに止まる）
    let movedFrom: string | null = null;
    if (input.date !== undefined) {
      const row = await getKatachiRow(env.DB, id);
      if (!row) throw new ApiError(404, 'そのかたちはありません');
      if (row.date !== input.date && (await getNikkiRow(env.DB, id))) {
        if (input.move_nikki !== true) {
          throw new ApiError(409, '日記になったかたちの日付を変えると、公開中の日記の日付と URL も変わります。確かめてからもう一度どうぞ。');
        }
        movedFrom = (await moveNikkiDate(env, id, input.date as string)).oldDate;
      }
    }

    if (description !== undefined) await saveKatachiDescription(env.DB, id, description);
    const { detail, oldDate: patchedFrom } = await updateKatachi(env.DB, id, {
      date: input.date as string | undefined,
      title: input.title === undefined ? undefined : (input.title as string).trim(),
    });

    const oldDate = movedFrom ?? patchedFrom;
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
