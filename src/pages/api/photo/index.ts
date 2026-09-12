import type { APIRoute } from 'astro';
import { ApiError, handle, json } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { isUlid } from '../../../lib/ulid';
import { isWrittenAt, normalizeToJst, partsOfWrittenAt } from '../../../lib/time';
import { photoUrlFor } from '../../../lib/publish/photos';

export const prerender = false;

const MAX_BYTES = 20 * 1024 * 1024;
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * POST /api/photo — かけらに貼る写真を非公開バケットへ置く。
 * multipart/form-data: file / kakera_id（ULID）/ written_at（+09:00 付き）/ n（何枚目か）
 * 置き方: kakera/2026/09/12_1432_<ULID>_1.jpg（設計 §10）
 *
 * ⚠️ 公開ドメインに繋がない。閲覧は GET /api/photo/:key が認証の裏からプロキシする。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!env.PHOTOS) throw new ApiError(501, 'R2 のバインディング PHOTOS がありません');

    const form = await request.formData().catch(() => null);
    if (!form) throw new ApiError(400, 'multipart/form-data で送ってください');

    const file = form.get('file');
    if (!(file instanceof File)) throw new ApiError(400, 'file がありません');
    if (file.size > MAX_BYTES) throw new ApiError(413, '写真が大きすぎます（20MB まで）');

    const type = file.type.toLowerCase();
    if (type === 'image/heic' || type === 'image/heif') {
      throw new ApiError(400, 'HEIC 形式です。写真アプリから直接選ぶと自動で JPEG になります');
    }
    const ext = EXT[type];
    if (!ext) throw new ApiError(400, `扱えない形式です（${file.type || '不明'}）`);

    const kakeraId = form.get('kakera_id');
    if (!isUlid(kakeraId)) throw new ApiError(400, 'kakera_id は ULID で送ってください');
    const writtenAt = form.get('written_at');
    if (!isWrittenAt(writtenAt)) throw new ApiError(400, 'written_at が要ります');
    const nRaw = Number(form.get('n') ?? 1);
    const n = Number.isFinite(nRaw) && nRaw >= 1 ? Math.floor(nRaw) : 1;

    const p = partsOfWrittenAt(normalizeToJst(writtenAt));
    const base = `kakera/${p.year}/${p.month}/${p.day}_${p.hhmm}_${kakeraId}`;

    // 同じ番号が既にあれば後ろにずらす（取り直しで上書きしない）
    let key = `${base}_${n}.${ext}`;
    for (let i = n; (await env.PHOTOS.head(key)) && i < n + 50; i++) {
      key = `${base}_${i + 1}.${ext}`;
    }

    await env.PHOTOS.put(key, file.stream(), {
      httpMetadata: { contentType: type },
    });

    return json({ key, url: photoUrlFor(key) }, 201);
  });
