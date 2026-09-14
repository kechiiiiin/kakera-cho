import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../../lib/http';
import { ctxOf } from '../../../lib/ctx';
import { deleteNameEntry, parseNameEntryInput, updateNameEntry } from '../../../lib/names/db';

export const prerender = false;

/**
 * PATCH /api/name-map/:id — {source, target, exception?}
 * 選択の行は消さない（記号方式。次に文書を読んだとき同期が整える）。置き換え先の変更は保存済みの日記用の文にも効く。
 */
export const PATCH: APIRoute = ({ locals, params, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    const entry = await updateNameEntry(env.DB, params.id, parseNameEntryInput(await readJson(request)));
    return json({ entry });
  });

/**
 * DELETE /api/name-map/:id — 項目を消す。
 * 選択の行は消さない（辞書どおりだった箇所は実名に戻り、手で直した言葉は残る。§12 の 20）。
 */
export const DELETE: APIRoute = ({ locals, params }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    if (!params.id) throw new ApiError(400, 'id がありません');
    await deleteNameEntry(env.DB, params.id);
    return json({ ok: true });
  });
