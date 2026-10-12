import type { APIRoute } from 'astro';
import { ApiError, handle, json } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { hasExif, isFacePhotoKey, isFingerprint, isJpeg, maskedKeyFor } from '../../../lib/publish/photo-face';
import { faceStates } from '../../../lib/publish/photo-face-db';

export const prerender = false;

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * POST /api/photo-face/masked — 変換ページで作ったモザイク済みの JPEG を非公開バケットへ置く（顔モザイク設計 §3.3）
 * multipart/form-data: key（原本の key）/ fp（作ったときの枠の指紋）/ file（JPEG）
 * 置き方: kakera/masked/2026/10/12_1432_<ULID>_1.<指紋>.jpg
 *
 * ⚠️ 指紋が D1 のいまの枠と合わなければ 409（画面と D1 の枠が食い違ったまま作った版を置かない）。
 * ⚠️ JPEG でない・EXIF が載っているものは受け取らない（作り直した JPEG に EXIF を載せない）。
 * ⚠️ 公開ドメインに繋がない（/api/photo からも読めない key にする）。公開バケットへは書き出しのときにだけコピーする。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!env.PHOTOS) throw new ApiError(501, 'R2 のバインディング PHOTOS がありません');

    const form = await request.formData().catch(() => null);
    if (!form) throw new ApiError(400, 'multipart/form-data で送ってください');
    const key = form.get('key');
    const fp = form.get('fp');
    const file = form.get('file');
    if (typeof key !== 'string' || !isFacePhotoKey(key)) throw new ApiError(400, '写真の key が不正です');
    if (!isFingerprint(fp)) throw new ApiError(400, 'fp が不正です');
    if (!(file instanceof File)) throw new ApiError(400, 'file がありません');
    if (file.size > MAX_BYTES) throw new ApiError(413, '写真が大きすぎます（20MB まで）');

    const [state] = await faceStates(env.DB, env.PHOTOS, [key]);
    // 検出していない写真でも、手で囲んだ枠のモザイクは置ける（2026-10-12 §2.1 で変更）
    if (!state || state.fp !== fp) throw new ApiError(409, '顔の枠が変わりました。開き直してください。');

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isJpeg(bytes)) throw new ApiError(400, 'JPEG で送ってください');
    if (hasExif(bytes)) throw new ApiError(400, 'EXIF が載っています。モザイク済みの版には載せません');

    const maskedKey = maskedKeyFor(key, fp);
    await env.PHOTOS.put(maskedKey, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
    return json({ ok: true, masked_key: maskedKey }, 201);
  });
