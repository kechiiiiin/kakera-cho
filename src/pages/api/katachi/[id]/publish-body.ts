import type { APIRoute } from 'astro';
import { ApiError, handle, json } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { cardsForBodies, getKatachiDetail } from '../../../../lib/kakera/db';
import { ensureCards } from '../../../../lib/card/ensure';
import { listNameMap } from '../../../../lib/names/db';
import { resolveShape } from '../../../../lib/names/doc';
import { syncPublishDocsOf } from '../../../../lib/names/doc-db';
import { isPublishBodyStale, type PublishBodyView } from '../../../../lib/publish/publish-body';

export const prerender = false;

/**
 * GET /api/katachi/:id/publish-body — 変換ページを開くときに読む
 * → {bodies: [{kakera_id, basis, updated_at, stale}], cards}
 *   今このかたちに入っているかけらの「日記用に直した文」の印だけ（文そのものは name-choice の docs に載る）。
 *   stale = 書き換えた後に原本（kakera.updated_at）が直された。cards は日記用の文を解いた文に出てくる URL のカード。
 *
 * 保存・使う・消すは /api/katachi/:id/publish-body/:kid。
 * 書き出し（nikki.ts）は画面から本文を受け取らず、D1 の文書から解き直す。
 */
export const GET: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const detail = await getKatachiDetail(env.DB, params.id);
    const dict = await listNameMap(env.DB);
    const synced = await syncPublishDocsOf(env.DB, params.id, detail.kakera, dict);
    const bodies: PublishBodyView[] = [];
    const texts: string[] = [];
    for (const { kakera, state } of synced) {
      if (!state.row || state.row.basis === null) continue;
      bodies.push({
        kakera_id: kakera.id,
        basis: state.row.basis,
        updated_at: state.row.updated_at,
        stale: isPublishBodyStale(kakera.updated_at, state.row.basis),
      });
      if (state.shape) {
        try {
          texts.push(resolveShape(state.shape, dict).text);
        } catch {
          // 解けない文書は書き出しで 409 になる。カードは拾わない
        }
      }
    }
    // 日記にする直前に、まだ無いカードを裏で取りに行く（応答は待たせない）
    waitUntil(ensureCards(env, [...detail.kakera.map((k) => k.body), ...texts]));
    return json({ bodies, cards: await cardsForBodies(env.DB, texts) });
  });
