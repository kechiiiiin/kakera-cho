import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { getKatachiDetail } from '../../../../lib/kakera/db';
import type { Kakera } from '../../../../lib/kakera/types';
import { pickKakera } from '../../../../lib/names/db';
import { publishRealTexts } from '../../../../lib/names/doc-db';
import { parsePhotoChoices, validatePhotoChoices } from '../../../../lib/publish/photo-choice';
import { loadPhotoChoices, savePhotoChoices } from '../../../../lib/publish/photo-choice-db';
import { photoBasisOf } from '../../../../lib/publish/publish-body';

export const prerender = false;

/** 原本か日記用に直した文のどちらかに実在する写真の key まで残すための本文（publish-body.ts の photoBasisOf）。 */
async function photoBasis(db: D1Database, katachiId: string, chosen: Kakera[]): Promise<Kakera[]> {
  return photoBasisOf(
    chosen,
    await publishRealTexts(
      db,
      katachiId,
      chosen.map((k) => k.id)
    )
  );
}

/**
 * POST /api/katachi/:id/photo-choice — 変換ページを開くときに読む
 * {kakera_ids[]} → {photos: [{kakera_id, key}]}（日記に出さない写真だけ。原本か日記用の文に今も実在するものだけ）
 *
 * name-choice と同じく読むのも POST（並びを本文で送る）。
 * name-choice に同梱しないのは、紐づけ方が違うため（名前＝文書の記号・辞書に依存／写真＝写真の key だけ）。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    const kakera = await photoBasis(env.DB, params.id, pickKakera(detail, input.kakera_ids));
    return json({ photos: await loadPhotoChoices(env.DB, kakera) });
  });

/**
 * PUT /api/katachi/:id/photo-choice — 選択を覚える
 * {kakera_ids[], photos[]} 渡したかけらの「出さない」を丸ごと入れ替える。
 * 届いた選択は原本か日記用の文と突き合わせ、そのかけらに実在する写真の key だけ残す。
 */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    const kakera = await photoBasis(env.DB, params.id, pickKakera(detail, input.kakera_ids));
    const parsed = parsePhotoChoices(input.photos);
    if (!parsed) throw new ApiError(400, 'photos は配列で送ってください');
    const valid = validatePhotoChoices(kakera, parsed);
    await savePhotoChoices(env.DB, kakera, valid);
    return json({ ok: true, photos: valid });
  });
