import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../../lib/http';
import { ctxOf } from '../../../../../lib/ctx';
import { cardsForBodies, getKakera, getKatachiRow } from '../../../../../lib/kakera/db';
import { ensureCards } from '../../../../../lib/card/ensure';
import type { Kakera } from '../../../../../lib/kakera/types';
import { listNameMap } from '../../../../../lib/names/db';
import { resolveShape } from '../../../../../lib/names/doc';
import {
  acceptPublishDoc,
  deletePublishDoc,
  docViewOf,
  savePublishText,
} from '../../../../../lib/names/doc-db';

export const prerender = false;

// 日記用に直した文（公開名変換設計・記号方式）。どれも原本（kakera の行・控え）は触らない。
// かたちが無い・かけらが無い → 404／そのかたちに入っていないかけら → 409。

async function kakeraOfKatachiFor(db: D1Database, katachiId: string, kakeraId: string): Promise<Kakera> {
  const katachi = await getKatachiRow(db, katachiId);
  if (!katachi) throw new ApiError(404, 'そのかたちはありません');
  const k = await getKakera(db, kakeraId);
  if (!k) throw new ApiError(404, 'そのかけらはありません');
  if (k.katachi_id !== katachiId) throw new ApiError(409, 'そのかけらはこのかたちに入っていません');
  return k;
}

/**
 * PUT /api/katachi/:id/publish-body/:kid — {base, text} 日記用に直した文を保存する
 * base = 欄を開いたときの文（置き換え済み）。サーバが D1 から作り直して一致しなければ 409（開いた後に選択・辞書・原本が変わった）。
 * 保存時の差分で名前の範囲を追って記号に戻す（触らなかった名前の選択は残る・名前の言葉を書き換えた場所は普通の文字・新しく打った実名は記号）。
 * → {publish: DocView | null（原本と同じになったら書き換えを持たない）, kakera: DocView, cards}
 */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const { id, kid } = params;
    if (!id || !kid) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const k = await kakeraOfKatachiFor(env.DB, id, kid);
    const dict = await listNameMap(env.DB);
    const saved = await savePublishText(env.DB, id, k, dict, input.base, input.text);
    let text: string | null = null;
    if (saved.publish?.shape) {
      text = resolveShape(saved.publish.shape, dict).text;
      // 書き換えで足した URL のカードを裏で取る（かけらの保存と同じ）
      waitUntil(ensureCards(env, [text]));
    }
    return json({
      publish: saved.publish ? docViewOf(k.id, saved.publish, k.updated_at) : null,
      kakera: docViewOf(k.id, saved.kakera),
      cards: text ? await cardsForBodies(env.DB, [text]) : {},
    });
  });

/**
 * PATCH /api/katachi/:id/publish-body/:kid — 「書き換えを使う」（原本が変わった後も書き換えで出す）
 * basis を今の kakera.updated_at に進める。文と選択は変えない。書き換えが無ければ 404。
 */
export const PATCH: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const { id, kid } = params;
    if (!id || !kid) throw new ApiError(400, 'id がありません');
    const k = await kakeraOfKatachiFor(env.DB, id, kid);
    return json({ publish_body: await acceptPublishDoc(env.DB, id, k) });
  });

/**
 * DELETE /api/katachi/:id/publish-body/:kid — 書き換えを捨てて原本に戻す（原本側の選択がそのまま戻る）
 * → {ok, removed}（書き換えが無くてもエラーにしない）
 */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const { id, kid } = params;
    if (!id || !kid) throw new ApiError(400, 'id がありません');
    await kakeraOfKatachiFor(env.DB, id, kid);
    const removed = await deletePublishDoc(env.DB, id, kid);
    return json({ ok: true, removed });
  });
