import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { cardsForBodies, insertKakera, listKakeraOn, listNagare } from '../../../lib/kakera/db';
import { isUlid } from '../../../lib/ulid';
import { isDateKey, isWrittenAt, normalizeToJst } from '../../../lib/time';
import { backupKakera, dataRepo } from '../../../lib/backup/kakera-data';
import { ensureCards } from '../../../lib/card/ensure';

export const prerender = false;

/**
 * GET /api/kakera?unassigned=1 — 流れ（未かたちのみ・新しい順）＋リンクカード
 * GET /api/kakera?date=YYYY-MM-DD — その日（JST）に書いたかけら全部（かたちの中も含む・書いた順）＋リンクカード（iOS の日ごとの画面）
 * ⚠️ カードは同じ戻りに同梱する（往復を足さない＝トップの即表示を崩さない）。増えるのは D1 の1クエリだけ。
 */
export const GET: APIRoute = ({ locals, url }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const date = url.searchParams.get('date');
    if (date !== null && !isDateKey(date)) throw new ApiError(400, 'date は YYYY-MM-DD で送ってください');
    const kakera = date !== null ? await listKakeraOn(env.DB, date) : await listNagare(env.DB);
    const cards = await cardsForBodies(env.DB, kakera.map((k) => k.body));
    return json({ kakera, cards });
  });

/** POST /api/kakera — {id, body, written_at} ※id は端末採番の ULID */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const input = await readJson(request);

    if (!isUlid(input.id)) throw new ApiError(400, 'id は ULID で送ってください');
    if (typeof input.body !== 'string' || !input.body.trim()) throw new ApiError(400, '本文が空です');
    // ★written_at は必ず +09:00 付き。オフセットが揺れると控えのファイル名がずれる
    if (!isWrittenAt(input.written_at)) {
      throw new ApiError(400, 'written_at はオフセット付きの ISO8601 で送ってください');
    }

    const kakera = await insertKakera(env.DB, {
      id: input.id,
      body: input.body.trim(),
      written_at: normalizeToJst(input.written_at),
    });

    // 控えは保存を押した都度。裏に回してレスポンスを待たせない
    const ref = dataRepo(env);
    if (ref) waitUntil(backupKakera(ref, kakera, 'create'));
    // 行として独立した URL のカードも裏で取る（レスポンスを待たせない）
    waitUntil(ensureCards(env, [kakera.body]));

    return json({ kakera }, 201);
  });
