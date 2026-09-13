import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../../lib/http';
import { ctxOf } from '../../../../lib/ctx';
import { getKatachiDetail } from '../../../../lib/kakera/db';
import { pickKakera } from '../../../../lib/names/db';
import { parsePhotoChoices, validatePhotoChoices } from '../../../../lib/publish/photo-choice';
import { loadPhotoChoices, savePhotoChoices } from '../../../../lib/publish/photo-choice-db';
import { loadPublishSet } from '../../../../lib/publish/publish-body-db';

export const prerender = false;

/**
 * POST /api/katachi/:id/photo-choice — 変換ページを開くときに読む
 * {kakera_ids[]} → {photos: [{kakera_id, key}]}（日記に出さない写真だけ。原本に今も実在するものだけ）
 *
 * name-choice と同じく読むのも POST（並びを本文で送る）。
 * name-choice に同梱しないのは、紐づけ方が違うため（名前＝原本の位置と本文の更新時刻・辞書に依存／
 * 写真＝写真の key だけ・辞書にも本文の更新時刻にも依存しない）。画面は二つを並行して読む。
 */
export const POST: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    // 原本か日記用に直した本文のどちらかに実在する写真の key まで残す（publish-body.ts の photoBasisOf）
    const { photoBasis: kakera } = await loadPublishSet(env.DB, params.id, pickKakera(detail, input.kakera_ids));
    return json({ photos: await loadPhotoChoices(env.DB, kakera) });
  });

/**
 * PUT /api/katachi/:id/photo-choice — 選択を覚える
 * {kakera_ids[], photos[]} 渡したかけらの「出さない」を丸ごと入れ替える。
 * 届いた選択は原本と突き合わせ、そのかけらに実在する写真の key だけ残す。
 */
export const PUT: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const detail = await getKatachiDetail(env.DB, params.id);
    // 原本か日記用に直した本文のどちらかに実在する写真の key まで残す（publish-body.ts の photoBasisOf）
    const { photoBasis: kakera } = await loadPublishSet(env.DB, params.id, pickKakera(detail, input.kakera_ids));
    const parsed = parsePhotoChoices(input.photos);
    if (!parsed) throw new ApiError(400, 'photos は配列で送ってください');
    const valid = validatePhotoChoices(kakera, parsed);
    await savePhotoChoices(env.DB, kakera, valid);
    return json({ ok: true, photos: valid });
  });
