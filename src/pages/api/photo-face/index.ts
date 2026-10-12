import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { FACE_MODEL, isFacePhotoKey, parseFaces } from '../../../lib/publish/photo-face';
import { faceStates, saveFaces } from '../../../lib/publish/photo-face-db';

export const prerender = false;

/**
 * POST /api/photo-face — 変換ページを開くときに読む（顔モザイク設計 §3.2）。検出はしない（画面で「顔を探す」を押したときだけ）
 * {keys[]} → {photos: [{key, scanned, faces[], fp, masked}]}
 * 写真の key だけで引く（かけら・かたちに依らない。同じ写真なら決めた隠し方を引き継ぐ）。
 * 読むのも POST なのは photo-choice と同じ（並びを本文で送る）。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const input = await readJson(request);
    if (!Array.isArray(input.keys) || input.keys.length > 500) throw new ApiError(400, 'keys は配列で送ってください');
    const keys = input.keys.filter((k): k is string => typeof k === 'string' && isFacePhotoKey(k));
    return json({ photos: await faceStates(env.DB, env.PHOTOS, keys) });
  });

/**
 * PUT /api/photo-face — 写真 1 枚の枠を丸ごと入れ替える
 * {key, faces[], model?} model（検出に使ったモデル）を付けると「検出が済んだ」印も付ける。
 * 検出が済んでいない写真の枠も直せる（「囲む」は検出しなくても使える・2026-10-12 §2.1 で変更）。
 * → {photo: {key, scanned, faces[], fp, masked}}
 */
export const PUT: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const input = await readJson(request);
    const key = input.key;
    if (typeof key !== 'string' || !isFacePhotoKey(key)) throw new ApiError(400, '写真の key が不正です');
    const faces = parseFaces(input.faces);
    if (!faces) throw new ApiError(400, 'faces の形が違います');
    let model: string | undefined;
    if (input.model !== undefined) {
      if (input.model !== FACE_MODEL) throw new ApiError(400, `検出のモデルが違います（${FACE_MODEL} で検出してください）`);
      model = input.model;
    }
    await saveFaces(env.DB, key, faces, model);
    const [photo] = await faceStates(env.DB, env.PHOTOS, [key]);
    return json({ photo });
  });
