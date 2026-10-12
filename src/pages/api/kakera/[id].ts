import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { deleteKakera, updateKakera } from '../../../lib/kakera/db';
import { parseKakeraPatch } from '../../../lib/kakera/patch';
import { syncKakera, syncKakeraDeleted } from '../../../lib/backup/sync';
import { ensureCards } from '../../../lib/card/ensure';

export const prerender = false;

/**
 * PATCH /api/kakera/:id — {body?, written_at?}（どちらか一方でも両方でもよい）
 * written_at は POST と同じ検査（オフセット付き）・+09:00 に正規化・秒は 00・未来は拒否（数分のずれは許す）。
 * ★id（ULID）と写真の R2 キーは変えない。控えは流れなら新しいパスへ移し、かたちの中ならかたちを書き直す。
 */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');
    const input = await readJson(request);
    const patch = parseKakeraPatch(input);

    const { kakera, before } = await updateKakera(env.DB, id, patch);
    waitUntil(syncKakera(env, kakera, before));
    // 足した URL のカードを裏で取る。⚠️ 消えた URL の行は消さない（他のかけらが貼っているかもしれない）
    waitUntil(ensureCards(env, [kakera.body]));
    return json({ kakera });
  });

/** DELETE /api/kakera/:id — 物理削除＋控えのファイルも削除 */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const id = params.id;
    if (!id) throw new ApiError(400, 'id がありません');

    const kakera = await deleteKakera(env.DB, id);
    waitUntil(syncKakeraDeleted(env, kakera));
    return json({ ok: true });
  });
