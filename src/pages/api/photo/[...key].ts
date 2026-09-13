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

    // ⚠️ R2 のストリームをそのまま Response に載せない（開発サーバが噛み砕けず 500 になる）。
    //    写真は 20MB までなので、読み切ってから返す。
    const bytes = await obj.arrayBuffer();
    return new Response(bytes, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        etag: obj.httpEtag,
        // リンクカードの画像は他人のサーバーから来たもの。宣言した形式以外として解釈させない
        'x-content-type-options': 'nosniff',
        // 認証の裏なので共有キャッシュには載せない
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  });
