import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { deleteNameEntry, parseNameEntryInput, updateNameEntry } from '../../../lib/names/db';

export const prerender = false;

/** PATCH /api/name-map/:id — {source, target, exception?} 置き換え元が変わったら元の語の選択は捨てる */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const entry = await updateNameEntry(env.DB, params.id, parseNameEntryInput(await readJson(request)));
    return json({ entry });
  });

/** DELETE /api/name-map/:id — 項目を消す。その語の選択も捨てる */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    await deleteNameEntry(env.DB, params.id);
    return json({ ok: true });
  });
