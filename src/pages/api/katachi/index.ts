import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { createKatachi, listKatachi } from '../../../lib/kakera/db';
import { isUlid } from '../../../lib/ulid';
import { isDateKey } from '../../../lib/time';
import { syncKatachiCreated } from '../../../lib/backup/sync';

export const prerender = false;

/** GET /api/katachi — かたちの一覧（date DESC） */
export const GET: APIRoute = ({ locals }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    return json({ katachi: await listKatachi(env.DB) });
  });

/** POST /api/katachi — {id, date, title, kakera_ids[]} */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env, waitUntil } = ctxOf(locals);
    const input = await readJson(request);

    if (!isUlid(input.id)) throw new ApiError(400, 'id は ULID で送ってください');
    if (!isDateKey(input.date)) throw new ApiError(400, 'date は YYYY-MM-DD で送ってください');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const ids = input.kakera_ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) {
      throw new ApiError(400, 'kakera_ids が空です');
    }

    const detail = await createKatachi(env.DB, {
      id: input.id,
      date: input.date,
      title,
      kakera_ids: ids as string[],
    });
    waitUntil(syncKatachiCreated(env, detail.katachi.id));
    return json(detail, 201);
  });
