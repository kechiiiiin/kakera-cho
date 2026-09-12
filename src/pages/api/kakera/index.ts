import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { insertKakera, listNagare } from '../../../lib/kakera/db';
import { isUlid } from '../../../lib/ulid';
import { isWrittenAt, normalizeToJst } from '../../../lib/time';
import { backupKakera, dataRepo } from '../../../lib/backup/kakera-data';

export const prerender = false;

/** GET /api/kakera?unassigned=1 — 流れ（未かたちのみ・新しい順） */
export const GET: APIRoute = ({ locals }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    return json({ kakera: await listNagare(env.DB) });
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

    return json({ kakera }, 201);
  });
