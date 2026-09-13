import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../../lib/http';
import { ctxOf } from '../../../../../lib/ctx';
import { cardsForBodies } from '../../../../../lib/kakera/db';
import { ensureCards } from '../../../../../lib/card/ensure';
import { cleanPublishBody } from '../../../../../lib/publish/publish-body';
import {
  acceptPublishBody,
  deletePublishBody,
  kakeraOfKatachiFor,
  savePublishBody,
  viewOf,
} from '../../../../../lib/publish/publish-body-db';

export const prerender = false;

// 日記にだけ効く文章の微修正（公開名変換設計）。どれも原本（kakera の行・控え）は触らない。
// かたちが無い・かけらが無い → 404／そのかたちに入っていないかけら → 409。

/**
 * PUT /api/katachi/:id/publish-body/:kid — {body} 日記用に直した本文を保存する
 * → {publish_body: {…, stale} | null, cards}
 * 原本と一字一句同じなら書き換えを持たない（null＝原本のまま出す）。空は 400。
 * basis は今の kakera.updated_at。文章が変わると、そのかけらの名前の選択は白紙に戻る（publish-body.ts の注記）。
 */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const { id, kid } = params;
    if (!id || !kid) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const body = cleanPublishBody(input.body);
    if (body === null) throw new ApiError(400, '本文が空です（日記に出さないなら「日記にする」画面で外してください）');
    const k = await kakeraOfKatachiFor(env.DB, id, kid);
    const saved = await savePublishBody(env.DB, id, k, body);
    if (saved) {
      // 書き換えで足した URL のカードを裏で取る（かけらの保存と同じ）。日記に載せるカードは書き換えた本文から拾うため
      waitUntil(ensureCards(env, [saved.body]));
    }
    return json({
      publish_body: saved ? viewOf(k, saved) : null,
      cards: saved ? await cardsForBodies(env.DB, [saved.body]) : {},
    });
  });

/**
 * PATCH /api/katachi/:id/publish-body/:kid — 「書き換えを使う」（原本が変わった後も書き換えで出す）
 * basis を今の kakera.updated_at に進める。文章は変えない（名前の選択も残る）。書き換えが無ければ 404。
 */
export const PATCH: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const { id, kid } = params;
    if (!id || !kid) throw new ApiError(400, 'id がありません');
    const k = await kakeraOfKatachiFor(env.DB, id, kid);
    const row = await acceptPublishBody(env.DB, id, k);
    return json({ publish_body: viewOf(k, row) });
  });

/**
 * DELETE /api/katachi/:id/publish-body/:kid — 書き換えを捨てて原本に戻す
 * → {ok, removed}（書き換えが無くてもエラーにしない）
 */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const { id, kid } = params;
    if (!id || !kid) throw new ApiError(400, 'id がありません');
    await kakeraOfKatachiFor(env.DB, id, kid);
    const removed = await deletePublishBody(env.DB, id, kid);
    return json({ ok: true, removed });
  });
