import type { APIRoute } from 'astro';
import { handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { insertNameEntry, listNameMap, parseNameEntryInput } from '../../../lib/names/db';

export const prerender = false;

/** GET /api/name-map — 名前の辞書（公開名変換）。例外は target = source の項目。 */
export const GET: APIRoute = ({ locals }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    return json({ entries: await listNameMap(env.DB) });
  });

/** POST /api/name-map — {source, target, exception?} 辞書に足す。同じ置き換え元があれば 409 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const entry = await insertNameEntry(env.DB, parseNameEntryInput(await readJson(request)));
    return json({ entry }, 201);
  });
