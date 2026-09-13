import type { APIRoute } from 'astro';
import { ApiError, handle, json } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { cardsForBodies, getKatachiDetail } from '../../../../lib/kakera/db';
import { loadPublishBodies, viewOf } from '../../../../lib/publish/publish-body-db';

export const prerender = false;

/**
 * GET /api/katachi/:id/publish-body — 変換ページを開くときに読む
 * → {bodies: [{kakera_id, body, basis, updated_at, stale}], cards}
 *   今このかたちに入っているかけらの「日記用に直した本文」だけ（かたちから外したかけらの行は返さない）。
 *   stale = 書き換えた後に原本（kakera.updated_at）が直された。cards は書き換えた本文に出てくる URL のカード。
 *
 * 保存・使う・消すは /api/katachi/:id/publish-body/:kid（name-choice / photo-choice と同じく口を分ける）。
 * 書き出し（nikki.ts）は画面から本文を受け取らず、ここと同じ D1 の行から当て直す。
 * 読むのに送るものが無い（実名を URL に載せない）ので GET にしている。
 */
export const GET: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const detail = await getKatachiDetail(env.DB, params.id);
    const byId = new Map(detail.kakera.map((k) => [k.id, k]));
    const rows = await loadPublishBodies(env.DB, params.id, detail.kakera.map((k) => k.id));
    const bodies = rows.filter((r) => byId.has(r.kakera_id)).map((r) => viewOf(byId.get(r.kakera_id)!, r));
    // 日記にする直前に、まだ無いカードを裏で取りに行く（応答は待たせない）。
    // 保存時の取得に漏れた URL（前に書いたかけら・失敗の7日を過ぎたもの）も、書き出しまでに揃いやすくする。
    waitUntil(ensureCards(env, [...detail.kakera.map((k) => k.body), ...bodies.map((b) => b.body)]));
    return json({ bodies, cards: await cardsForBodies(env.DB, bodies.map((b) => b.body)) });
  });
