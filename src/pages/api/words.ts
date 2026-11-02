import type { APIRoute } from 'astro';
import { ApiError, handle, json, readJson } from '../../lib/http';
import { ctxOf } from '../../lib/ctx';
import { getWordDetail, listWords } from '../../lib/kakera/db';

export const prerender = false;

/**
 * GET /api/words — ことばの索引 {words: [{word, count, last_written_at}]}（新しく書いた順）
 * 表は持たず、問い合わせのたびに本文から抜き出す（かけら言葉リンク設計 §2.1）。
 */
export const GET: APIRoute = ({ locals }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    return json({ words: await listWords(env.DB) });
  });

/**
 * POST /api/words {word} — 言葉のページ {word, kakera: [かけら＋katachi_date], cards}（新しい順）
 * ⚠️ 言葉（実名を含みうる）を URL のクエリに載せないため、読むのも POST にしている（name-choice と同じ）。
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { env } = ctxOf(locals);
    const { word } = await readJson(request);
    if (typeof word !== 'string' || !word.trim()) throw new ApiError(400, '言葉が空です');
    return json(await getWordDetail(env.DB, word));
  });
