import type { APIRoute } from 'astro';
import { ApiError, handle, fail } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { isSafePhotoKey } from '../../../lib/publish/photos';

export const prerender = false;

/**
 * GET /api/photo/:key — 非公開バケットの写真を認証の裏からプロキシする。
 * かけらの本文にはこの相対 URL が書いてある。
 */
export const GET: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const key = params.key;
    if (!key || !isSafePhotoKey(key)) throw new ApiError(400, '写真の key が不正です');
    if (!env.PHOTOS) throw new ApiError(501, 'R2 のバインディング PHOTOS がありません');

    const obj = await env.PHOTOS.get(key);
    if (!obj) return fail(404, 'その写真はありません');

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    // 認証の裏なので共有キャッシュには載せない
    headers.set('cache-control', 'private, max-age=31536000, immutable');
    return new Response(obj.body, { headers });
  });
